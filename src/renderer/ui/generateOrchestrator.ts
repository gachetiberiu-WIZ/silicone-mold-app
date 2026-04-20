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
//
// Manifold ownership (issue #47)
// ------------------------------
//
// The half-Manifolds in `SiliconeShellResult` are generator-owned until
// the orchestrator decides what to do with them:
//
//   - Happy path + `scene` supplied:  ownership HANDS OFF to the scene
//     sink via `scene.setSilicone({upper, lower})`. The orchestrator must
//     NOT `.delete()` them afterwards — the sink does so on its next
//     replacement / clear cycle.
//   - Happy path + no `scene`:  fall back to the original behaviour of
//     `.delete()`-ing here. Kept so the pre-#47 orchestrator tests (and
//     any callers that only want volumes) still work.
//   - Stale-drop path:  halves NEVER reached the scene → orchestrator is
//     still the owner → `.delete()` both before returning.
//   - Error path (generate rejected):  halves never existed (the Promise
//     rejected before producing them) → nothing to delete.
//   - scene.setSilicone rejects:  the scene sink is contracted to have
//     disposed both halves on its error branch before re-throwing.

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

/**
 * Minimal scene-sink surface the orchestrator hands the half-Manifolds
 * to on the happy path. Kept as a shaped interface (rather than a direct
 * import of the scene module) so tests can inject a lightweight mock and
 * assert the hand-off without needing a real WebGL context.
 *
 * Contract: from the moment `setSilicone` resolves, the sink owns the
 * Manifolds' lifetimes. The orchestrator MUST NOT `.delete()` them on
 * the happy path. The stale-drop / error paths predate this ownership
 * transfer — they still `.delete()`.
 */
export interface OrchestratorSceneSink {
  setSilicone(halves: { upper: Manifold; lower: Manifold }): Promise<unknown>;
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
   * Optional scene sink (issue #47). When provided, the orchestrator
   * hands the freshly-generated half-Manifolds to `scene.setSilicone`
   * on the happy path INSTEAD of `.delete()`-ing them. Ownership
   * transfers to the sink; the orchestrator's finally-block does NOT
   * double-free. Legacy call sites (and the orchestrator's existing
   * unit tests that predate the preview scene) can omit this — the
   * halves fall back to being disposed here, which preserves the
   * original "volume compute only" behaviour.
   */
  scene?: OrchestratorSceneSink;
  /**
   * Optional post-setSilicone hook for camera re-framing (issue #47).
   * Called with the result of `scene.setSilicone` when both scene + hook
   * are supplied and the run is still current. Only invoked on the
   * happy, non-stale path so a superseded run can't jerk the camera.
   */
  onSiliconeInstalled?: (result: unknown) => void;
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
    scene,
    onSiliconeInstalled,
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
          // Staleness drop: an invalidation (commit, reset, new STL) or a
          // later click bumped the epoch while we were awaiting. The halves
          // NEVER reached the scene, so the orchestrator is still the
          // owner — release them here. (Issue #47 kept this branch's
          // `.delete()` unchanged; only the happy-path hand-off moved.)
          result.siliconeUpperHalf.delete();
          result.siliconeLowerHalf.delete();
          return;
        }

        topbar.setSiliconeVolume(result.siliconeVolume_mm3);
        topbar.setResinVolume(result.resinVolume_mm3);

        if (scene) {
          // Happy path (issue #47): hand ownership of BOTH half-Manifolds
          // to the scene sink. `scene.setSilicone` is responsible for
          // `.delete()`-ing them on its next replacement / clear cycle —
          // the orchestrator must NOT touch them again or we'd double-
          // free. If `setSilicone` throws (geometry adapter failure),
          // its implementation is responsible for disposing both
          // Manifolds before re-throwing so the lifetime contract holds.
          try {
            const installed = await scene.setSilicone({
              upper: result.siliconeUpperHalf,
              lower: result.siliconeLowerHalf,
            });
            // Re-check staleness after the async setSilicone resolved —
            // an invalidation that fires between the volume push and the
            // scene install will have cleared the silicone group in its
            // own tick, but `setSilicone` is idempotent and the next
            // `clearSilicone` from the listener will catch it. The
            // camera re-frame, however, must NOT fire on a stale run:
            // guard with the epoch.
            if (epoch === getEpoch() && onSiliconeInstalled) {
              onSiliconeInstalled(installed);
            }
          } catch (err) {
            // setSilicone is contracted to dispose the Manifolds on
            // failure. We still have to surface the error — route
            // through the button's error channel so the user sees it.
            const message =
              err instanceof Error ? err.message : String(err);
            logger.error('[generate] setSilicone failed:', err);
            button.setError(message);
          }
        } else {
          // No scene sink wired (legacy call sites, some tests) — fall
          // back to the pre-#47 behaviour of disposing the halves here
          // for volume-compute-only mode.
          result.siliconeUpperHalf.delete();
          result.siliconeLowerHalf.delete();
        }
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
