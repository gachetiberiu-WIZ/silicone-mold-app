// src/renderer/ui/generateOrchestrator.ts
//
// Injectable orchestrator for the Generate-mold flow (issue #40 + QA
// follow-up on PR #41). Extracted from `main.ts`'s inline `handleGenerate`
// so the race-condition unit test QA asked for can drive the full
// `setBusy → await → staleness-check → topbar-push` cycle without booting
// the renderer entrypoint.
//
// Shape:
//
//   const orchestrator = createGenerateOrchestrator({
//     getMaster,       // read master Manifold from the scene cache
//     getParameters,   // read the current mold parameters
//     getViewTransform,// capture the Master group's matrixWorld
//     generate,        // the geometry kernel's `generateSiliconeShell`
//     topbar,          // `setSiliconeVolume` / `setResinVolume`
//     button,          // `setBusy` / `setError`
//   });
//
//   generateButton.onGenerate = () => void orchestrator.run();
//
// Staleness discipline
// --------------------
//
// Every `run()` captures `epoch = bumpGenerateEpoch()` at the top. When
// `generate(...)` resolves, we compare that captured epoch against the
// current shared epoch. If they differ, SOMETHING invalidated this run
// mid-flight — either a later `run()` (double-click), a lay-flat commit
// event (via `attachGenerateInvalidation`), a new STL load, or an explicit
// test-driven bump. In that case we:
//
//   - dispose both half-Manifolds on the dropped result (no WASM leak),
//   - return WITHOUT touching the topbar (the invalidation listener already
//     nulled the readouts; re-pushing our stale numbers would be wrong),
//   - skip `setBusy(false)` (a later run is still current and owns busy).
//
// Symmetrically on the error branch: a stale error is swallowed rather
// than shown to the user, since an invalidation means they've already moved
// on.

import type { Manifold } from 'manifold-3d';
import type { Matrix4 } from 'three';

import type { MoldParameters } from '../state/parameters';
import type { SiliconeShellResult } from '@/geometry/generateMold';
import { bumpGenerateEpoch, getGenerateEpoch } from './generateEpoch';

/** Minimal topbar surface the orchestrator writes to. */
export interface OrchestratorTopbar {
  setSiliconeVolume(mm3: number | null): void;
  setResinVolume(mm3: number | null): void;
}

/** Minimal Generate-button surface the orchestrator drives. */
export interface OrchestratorButton {
  setBusy(busy: boolean): void;
  setError(reason: string | null): void;
}

/** Dependencies injected into the orchestrator factory. */
export interface GenerateOrchestratorDeps {
  /**
   * Resolve the master `Manifold` (the watertight input mesh). Returning
   * `null` triggers an error state with the `generate.noMaster` message —
   * the button is gated on orientation-committed, so this path is
   * defence-in-depth.
   */
  getMaster: () => Manifold | null;
  /** Snapshot the current mold parameters at click-time. */
  getParameters: () => MoldParameters;
  /**
   * Capture the Master group's world matrix at click-time. Returning
   * `null` triggers an error state with the `generate.noMasterGroup`
   * message — also defence-in-depth.
   */
  getViewTransform: () => Matrix4 | null;
  /**
   * The geometry kernel's generator. Extracted as a dep so tests can
   * inject a hand-resolvable deferred promise.
   */
  generate: (
    master: Manifold,
    parameters: MoldParameters,
    viewTransform: Matrix4,
  ) => Promise<SiliconeShellResult>;
  /** The topbar-readout surface. */
  topbar: OrchestratorTopbar;
  /** The Generate-mold button's busy/error surface. */
  button: OrchestratorButton;
  /**
   * Optional epoch hooks — default to the shared module-level counter.
   * Tests override to assert bump sequences or observe the stale-path.
   */
  bumpEpoch?: () => number;
  getEpoch?: () => number;
  /**
   * Optional logger override — defaults to `console`. Tests inject a
   * silent one to keep Vitest output clean.
   */
  logger?: {
    error: (...args: unknown[]) => void;
  };
}

/** Handle returned by `createGenerateOrchestrator`. */
export interface GenerateOrchestratorApi {
  /**
   * Start one silicone-shell generation. Resolves after the topbar has
   * been updated (or the result has been dropped as stale, or an error
   * has been surfaced). Never throws — all failure modes route through
   * `button.setError`.
   */
  run(): Promise<void>;
}

/**
 * Build an orchestrator bound to the given deps. Each returned `.run()`
 * call is independent: there's no internal mutex, only the shared epoch.
 *
 * Contract:
 *   - On a normal successful run: pushes the result volumes to the topbar
 *     and disposes the half-Manifolds; clears busy; clears any prior
 *     error.
 *   - On a stale run (epoch changed mid-flight): disposes the halves and
 *     returns silently. Does NOT push volumes, does NOT clear busy (a
 *     newer run owns that flag), does NOT show an error.
 *   - On a sync pre-generate failure (no master / no group): calls
 *     `button.setError(i18n-neutral key)` and returns; busy is never
 *     raised so nothing to clear.
 *   - On an async generator rejection: routes through `button.setError`
 *     with the error's message and clears busy. A stale rejection is
 *     swallowed.
 */
export function createGenerateOrchestrator(
  deps: GenerateOrchestratorDeps,
): GenerateOrchestratorApi {
  const {
    getMaster,
    getParameters,
    getViewTransform,
    generate,
    topbar,
    button,
    bumpEpoch = bumpGenerateEpoch,
    getEpoch = getGenerateEpoch,
    logger = console,
  } = deps;

  return {
    async run(): Promise<void> {
      // Sync pre-flight: if the master or its view transform isn't
      // available, surface a friendly error and bail before we raise the
      // busy flag. These are defence-in-depth; the button is gated in
      // production so this path shouldn't fire.
      const master = getMaster();
      if (!master) {
        const msg = 'No master mesh loaded';
        logger.error(`[generate] ${msg}`);
        button.setError(msg);
        return;
      }
      const viewTransform = getViewTransform();
      if (!viewTransform) {
        const msg = 'Master group missing from scene';
        logger.error(`[generate] ${msg}`);
        button.setError(msg);
        return;
      }

      const parameters = getParameters();
      // Bump the epoch so any in-flight run is superseded. Capture the
      // new value locally — this is the epoch our resolution will be
      // compared against.
      const epoch = bumpEpoch();

      button.setError(null);
      button.setBusy(true);
      // Clear stale numbers immediately so the "Generating…" label isn't
      // shown alongside previous values.
      topbar.setSiliconeVolume(null);
      topbar.setResinVolume(null);

      try {
        const result = await generate(master, parameters, viewTransform);

        if (epoch !== getEpoch()) {
          // An invalidation (commit, reset, new STL) or a later click
          // bumped the epoch while we were awaiting — drop the result.
          result.siliconeUpperHalf.delete();
          result.siliconeLowerHalf.delete();
          return;
        }

        topbar.setSiliconeVolume(result.siliconeVolume_mm3);
        topbar.setResinVolume(result.resinVolume_mm3);

        // v1 doesn't render or export the halves here — they were for
        // volume compute only. Release the WASM memory now. Phase 3d
        // will keep them alive for the preview renderer.
        result.siliconeUpperHalf.delete();
        result.siliconeLowerHalf.delete();
      } catch (err) {
        // Stale rejection → user already moved on; no point alarming
        // them with an error from a superseded run.
        if (epoch !== getEpoch()) return;
        const message = err instanceof Error ? err.message : String(err);
        logger.error('[generate] failed:', err);
        button.setError(message);
      } finally {
        // Only release busy if this run is still current. An earlier,
        // superseded run must NOT un-busy a later, in-flight run.
        if (epoch === getEpoch()) {
          button.setBusy(false);
        }
      }
    },
  };
}
