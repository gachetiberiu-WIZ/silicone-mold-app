// src/renderer/ui/generateOrchestrator.ts
//
// Injectable orchestrator for the Generate-mold flow. Extracted from
// `main.ts`'s inline `handleGenerate` so the race-condition unit test can
// drive the full `setBusy → await → staleness-check → topbar-push` cycle
// without booting the renderer entrypoint.
//
// Shape:
//
//   const orchestrator = createGenerateOrchestrator({
//     getMaster,       // read master Manifold from the scene cache
//     getParameters,   // read the current mold parameters
//     getViewTransform,// capture the Master group's matrixWorld
//     generate,        // the geometry kernel's `generateSiliconeShell`
//     topbar,          // setSiliconeVolume / setResinVolume / setPrintShellVolume
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
//   - dispose the silicone + print-shell Manifolds on the dropped
//     result (no WASM leak),
//   - return WITHOUT touching the topbar (the invalidation listener already
//     nulled the readouts; re-pushing our stale numbers would be wrong),
//   - skip `setBusy(false)` (a later run is still current and owns busy).
//
// Manifold ownership (issues #47, #62, #72, #82, #84)
// ---------------------------------------------------
//
// The Manifolds in `MoldGenerationResult` (silicone, N shellPieces,
// basePart) are generator-owned until the orchestrator decides what to
// do with them:
//
//   - Happy path + `scene` supplied:  ownership HANDS OFF to the scene
//     sinks via `scene.setSilicone({silicone})` +
//     `scene.setPrintableParts({shellPieces, basePart})`. The
//     orchestrator must NOT `.delete()` them afterwards — the sinks do
//     so on their next replacement / clear cycle.
//   - Happy path + no `scene`:  fall back to the original behaviour of
//     `.delete()`-ing here. Kept so pre-scene orchestrator tests (and
//     any callers that only want volumes) still work.
//   - Stale-drop path:  no Manifold reached the scene → orchestrator
//     is still the owner → `.delete()` every one (silicone, every shell
//     piece, basePart) before returning.
//   - Error path (generate rejected):  Manifolds never existed (the
//     Promise rejected before producing them) → nothing to delete.
//   - sink rejects:  the sink is contracted to have disposed every input
//     Manifold on its error branch before re-throwing.

import type { Manifold } from 'manifold-3d';
import type { Matrix4 } from 'three';

import type { MoldParameters } from '../state/parameters';
import type { MoldGenerationResult } from '@/geometry/generateMold';
import { bumpGenerateEpoch, getGenerateEpoch } from './generateEpoch';

/** Minimal topbar surface the orchestrator writes to. */
export interface OrchestratorTopbar {
  setSiliconeVolume(mm3: number | null): void;
  setResinVolume(mm3: number | null): void;
  /**
   * Set the print-shell volume in mm³. Optional on the interface so
   * legacy callers / tests that don't wire the 4th readout still work;
   * production wires a real implementation.
   */
  setPrintShellVolume?(mm3: number | null): void;
  /**
   * Set the base-slab volume in mm³ (Wave D, issue #82). Optional so
   * legacy tests that don't wire the 5th readout still work; production
   * wires a real implementation.
   */
  setBaseSlabVolume?(mm3: number | null): void;
}

/** Minimal Generate-button surface the orchestrator drives. */
export interface OrchestratorButton {
  setBusy(busy: boolean): void;
  setError(reason: string | null): void;
}

/**
 * Minimal scene-sink surface the orchestrator hands the Manifolds to on
 * the happy path. Kept as a shaped interface (rather than a direct import
 * of the scene module) so tests can inject a lightweight mock and assert
 * the hand-off without needing a real WebGL context.
 *
 * Contract: from the moment `setSilicone` resolves, the sink owns the
 * silicone Manifold's lifetime. From the moment `setPrintableParts`
 * resolves (if supplied), the sink owns the print-shell Manifold too.
 * The orchestrator MUST NOT `.delete()` them on the happy path. The
 * stale-drop / error paths predate this ownership transfer — they still
 * `.delete()` everything.
 */
export interface OrchestratorSceneSink {
  setSilicone(payload: { silicone: Manifold }): Promise<unknown>;
  /**
   * Hand the sliced shell pieces + base slab to the scene (Wave E + F,
   * issue #84). Optional so legacy call sites can wire only
   * `setSilicone` and fall back to disposing the shell pieces + base
   * slab immediately.
   *
   * Contract: same as `setSilicone` — from the moment this resolves,
   * the sink owns EVERY Manifold (N shell pieces + the base slab). The
   * orchestrator MUST NOT `.delete()` them. On rejection the sink is
   * responsible for having disposed every input Manifold before
   * throwing.
   */
  setPrintableParts?(parts: {
    shellPieces: readonly Manifold[];
    basePart: Manifold;
    xzCenter?: { x: number; z: number };
  }): Promise<unknown>;
}

/**
 * Callback fired on the happy path, after the topbar volumes have been
 * pushed and the scene sinks (if present) have accepted the silicone +
 * print shell. Used to flip the Generate button's `generated` flag
 * so the hint reads `generate.done`. Not called on stale / error paths.
 */
export type OrchestratorOnGenerateSuccess = () => void;

/** Dependencies injected into the orchestrator factory. */
export interface GenerateOrchestratorDeps {
  getMaster: () => Manifold | null;
  getParameters: () => MoldParameters;
  getViewTransform: () => Matrix4 | null;
  generate: (
    master: Manifold,
    parameters: MoldParameters,
    viewTransform: Matrix4,
  ) => Promise<MoldGenerationResult>;
  topbar: OrchestratorTopbar;
  button: OrchestratorButton;
  scene?: OrchestratorSceneSink;
  onSiliconeInstalled?: (result: unknown) => void;
  onGenerateSuccess?: OrchestratorOnGenerateSuccess;
  bumpEpoch?: () => number;
  getEpoch?: () => number;
  logger?: {
    error: (...args: unknown[]) => void;
  };
}

/** Handle returned by `createGenerateOrchestrator`. */
export interface GenerateOrchestratorApi {
  run(): Promise<void>;
}

/**
 * Safely `.delete()` a Manifold if it exposes the method. Resilient to
 * partial mocks in tests.
 */
function safeDelete(m: Manifold | undefined | null): void {
  if (m && typeof m.delete === 'function') {
    m.delete();
  }
}

/**
 * Build an orchestrator bound to the given deps. Each returned `.run()`
 * call is independent: there's no internal mutex, only the shared epoch.
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
    onGenerateSuccess,
    bumpEpoch = bumpGenerateEpoch,
    getEpoch = getGenerateEpoch,
    logger = console,
  } = deps;

  return {
    async run(): Promise<void> {
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
      const epoch = bumpEpoch();

      button.setError(null);
      button.setBusy(true);
      topbar.setSiliconeVolume(null);
      topbar.setResinVolume(null);
      topbar.setPrintShellVolume?.(null);
      topbar.setBaseSlabVolume?.(null);

      try {
        const result = await generate(master, parameters, viewTransform);

        if (epoch !== getEpoch()) {
          // Staleness drop: an invalidation (commit, reset, new STL) or a
          // later click bumped the epoch while we were awaiting. None of
          // the Manifolds reached the scene, so the orchestrator is still
          // the owner — release every one here.
          safeDelete(result.silicone);
          for (const p of result.shellPieces) safeDelete(p);
          safeDelete(result.basePart);
          return;
        }

        topbar.setSiliconeVolume(result.siliconeVolume_mm3);
        topbar.setResinVolume(result.resinVolume_mm3);
        topbar.setPrintShellVolume?.(result.totalShellVolume_mm3);
        topbar.setBaseSlabVolume?.(result.baseSlabVolume_mm3);

        // Track sink failures so the post-run success hook (below) can
        // skip firing when any downstream sink surfaced an error.
        let siliconeSinkFailed = false;
        if (scene) {
          // Happy path: hand ownership of the silicone Manifold to the
          // scene sink. `scene.setSilicone` is responsible for
          // `.delete()`-ing it on its next replacement / clear cycle —
          // the orchestrator must NOT touch it again or we'd double-
          // free. If `setSilicone` throws (geometry adapter failure),
          // its implementation is responsible for disposing the
          // silicone Manifold before re-throwing so the lifetime
          // contract holds.
          try {
            const installed = await scene.setSilicone({
              silicone: result.silicone,
            });
            if (epoch === getEpoch() && onSiliconeInstalled) {
              onSiliconeInstalled(installed);
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error('[generate] setSilicone failed:', err);
            button.setError(message);
            siliconeSinkFailed = true;
          }
        } else {
          // No scene sink wired (legacy call sites, some tests) — fall
          // back to disposing the silicone here for volume-compute-only
          // mode.
          safeDelete(result.silicone);
        }

        // Shell-pieces + base-slab hand-off (Wave E + F, issue #84).
        // Mirror of the silicone hand-off above: if the scene sink
        // supplies `setPrintableParts`, ownership of EVERY Manifold (N
        // shell pieces + base slab) transfers; the orchestrator must
        // NOT `.delete()` them. If the sink is absent, fall back to
        // disposing every one immediately.
        let printShellFailed = false;
        if (scene?.setPrintableParts) {
          try {
            await scene.setPrintableParts({
              shellPieces: result.shellPieces,
              basePart: result.basePart,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error('[generate] setPrintableParts failed:', err);
            button.setError(message);
            printShellFailed = true;
          }
        } else {
          for (const p of result.shellPieces) safeDelete(p);
          safeDelete(result.basePart);
        }

        if (
          epoch === getEpoch() &&
          !siliconeSinkFailed &&
          !printShellFailed &&
          onGenerateSuccess
        ) {
          onGenerateSuccess();
        }
      } catch (err) {
        if (epoch !== getEpoch()) return;
        const message = err instanceof Error ? err.message : String(err);
        logger.error('[generate] failed:', err);
        button.setError(message);
      } finally {
        if (epoch === getEpoch()) {
          button.setBusy(false);
        }
      }
    },
  };
}
