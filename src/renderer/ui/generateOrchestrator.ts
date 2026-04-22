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
import type {
  MoldGenerationResult,
  OnGeneratePhase,
} from '@/geometry/generateMold';
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
    /**
     * Issue #87 dogfood fix (Fix 2): how far to lift the entire mold
     * assembly (master + silicone + printable parts) on Y so the base
     * slab's underside sits on the print bed (Y=0). Passed through
     * from the current parameters' `baseSlabThickness_mm`. When
     * omitted the scene sink falls back to no offset (legacy
     * tests / call-sites that don't care about slab positioning).
     */
    baseSlabThickness_mm?: number;
  }): Promise<unknown>;
}

/**
 * Callback fired on the happy path, after the topbar volumes have been
 * pushed and the scene sinks (if present) have accepted the silicone +
 * print shell. Used to flip the Generate button's `generated` flag
 * so the hint reads `generate.done`. Not called on stale / error paths.
 */
export type OrchestratorOnGenerateSuccess = () => void;

/**
 * Minimal progress-banner surface the orchestrator drives (issue #87
 * Fix 1). The orchestrator feeds phase labels through this sink as
 * `generateSiliconeShell` walks through silicone → shell → slicing →
 * brims → slab. Optional on the interface so existing tests and any
 * call-site that doesn't care about progress still work.
 */
export interface OrchestratorStatus {
  /** Update / show the progress banner. `null` hides. */
  setPhase(label: string | null): void;
}

/** Dependencies injected into the orchestrator factory. */
export interface GenerateOrchestratorDeps {
  getMaster: () => Manifold | null;
  getParameters: () => MoldParameters;
  getViewTransform: () => Matrix4 | null;
  generate: (
    master: Manifold,
    parameters: MoldParameters,
    viewTransform: Matrix4,
    onPhase?: OnGeneratePhase,
  ) => Promise<MoldGenerationResult>;
  topbar: OrchestratorTopbar;
  button: OrchestratorButton;
  scene?: OrchestratorSceneSink;
  /**
   * Progress-banner sink (issue #87 Fix 1). Optional so legacy tests
   * and any other callers that don't care about progress can omit it.
   * When provided, the orchestrator:
   *   1. Forwards `onPhase(key)` from the generator into
   *      `status.setPhase(translatedLabel)` before each heavy step.
   *   2. Awaits a RAF tick so the DOM paints the updated label
   *      before the next synchronous manifold op blocks the UI
   *      thread.
   *   3. Calls `setPhase(null)` on success, stale-drop, and error
   *      paths so the banner never strands on the scene.
   */
  status?: OrchestratorStatus;
  /**
   * Translate a `GeneratePhase` key (`'silicone'` / `'shell'` / …)
   * into a user-facing label. The default implementation returns
   * the raw key; production wires `(key) => t('status.phase.' + key)`
   * so the translated strings flow through i18n.
   */
  translatePhase?: (key: string) => string;
  onSiliconeInstalled?: (result: unknown) => void;
  onGenerateSuccess?: OrchestratorOnGenerateSuccess;
  /**
   * Issue #93: fire a user-visible NOTICE (not an error) when the
   * post-generate base slab came out degenerate — `basePart.isEmpty()`
   * is true OR `baseSlabVolume_mm3 <= 0`. Intended wiring:
   * `(msg) => showNotice(msg)` from `errorToast.ts`, with `msg` the
   * translated `warnings.degenerateSlab` string.
   *
   * The orchestrator fires this at most ONCE per successful `run()` —
   * on the happy-path terminal branch only, AFTER the topbar + scene
   * hand-off. Stale-drop and error paths skip the notice (the user
   * will see the later run's outcome, whatever it is). Omit to
   * disable the hook entirely (legacy tests, any call site that
   * doesn't want UI side effects).
   */
  showNotice?: (message: string) => void;
  /**
   * Issue #93: translate a warning key (`'warnings.degenerateSlab'`)
   * into a user-facing label. Production wires
   * `(key) => t(key)` so the string flows through i18n. If omitted,
   * the key is passed through verbatim (suitable for tests that want
   * to assert on the raw key).
   */
  translateWarning?: (key: string) => string;
  bumpEpoch?: () => number;
  getEpoch?: () => number;
  logger?: {
    error: (...args: unknown[]) => void;
  };
}

/**
 * Snapshot of the Manifolds that a caller is allowed to ship out as
 * printable STL files (issue #91). The orchestrator captures these
 * references on the happy path AFTER the scene sink has accepted
 * ownership — so the scene module is the lifetime owner; the
 * orchestrator merely keeps a pointer so the Export STL button can read
 * them back.
 *
 * `shellPieces` is `readonly` because the consumer (exportStl.ts) only
 * iterates + hands each Manifold to the geometry adapter. The array
 * ordering mirrors the generator's output: `shell-piece-0` is index 0,
 * etc. — exportStl.ts depends on that order for deterministic
 * filenames.
 */
export interface OrchestratorExportables {
  basePart: Manifold;
  shellPieces: readonly Manifold[];
}

/** Handle returned by `createGenerateOrchestrator`. */
export interface GenerateOrchestratorApi {
  run(): Promise<void>;
  /**
   * Read the Manifolds currently eligible for STL export (issue #91).
   * Returns `null` when:
   *   - no generate has completed,
   *   - the last successful generate was invalidated (epoch bumped, i.e.
   *     orientation commit / reset / new STL load / parameter change after
   *     the run stored the exportables),
   *   - a generate is in flight (we clear exportables on every run() entry).
   *
   * Callers MUST NOT `.delete()` the returned Manifolds — lifetime belongs
   * to the scene sink (`scene/printableParts.ts`).
   */
  getCurrentExportables(): OrchestratorExportables | null;
  /**
   * Subscribe to transitions in `getCurrentExportables()`'s null / non-null
   * state and the orchestrator's busy flag. The callback fires on every
   * change (busy start / end, exportables appear / clear). Returns an
   * unsubscribe function. Used by the Export STL button to flip its
   * enabled state without polling.
   */
  onStateChange(listener: (state: OrchestratorExportState) => void): () => void;
}

/**
 * Public state slice the Export STL button cares about (issue #91). The
 * button is enabled iff `hasExportables && !isBusy`. Staleness is encoded
 * by `hasExportables` going `false` — the orchestrator clears the refs on
 * every new `run()` start and whenever `invalidateExportables()` is called
 * by the staleness-plumbing in main.ts (orientation commit, new STL,
 * parameter change, dimension change).
 */
export interface OrchestratorExportState {
  hasExportables: boolean;
  isBusy: boolean;
}

/**
 * Extended handle — adds the invalidation hook used by main.ts to clear
 * exportables on external staleness signals. Kept separate so test files
 * that mock `GenerateOrchestratorApi` don't accidentally pick up the
 * method in legacy test shapes. Production `createGenerateOrchestrator`
 * returns this shape.
 */
export interface GenerateOrchestratorApiWithExport
  extends GenerateOrchestratorApi {
  /**
   * Drop the currently-held exportables reference (if any) and fire a
   * state-change event. Called by main.ts from every staleness path
   * (lay-flat commit, reset, new STL load, parameter / dimension change
   * after a successful generate). Idempotent — a no-op when no
   * exportables are held.
   */
  invalidateExportables(): void;
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
): GenerateOrchestratorApiWithExport {
  const {
    getMaster,
    getParameters,
    getViewTransform,
    generate,
    topbar,
    button,
    scene,
    status,
    translatePhase,
    onSiliconeInstalled,
    onGenerateSuccess,
    showNotice,
    translateWarning,
    bumpEpoch = bumpGenerateEpoch,
    getEpoch = getGenerateEpoch,
    logger = console,
  } = deps;

  // Exportables + busy state slot — drives the Export STL button (issue
  // #91). `exportables` holds the Manifold refs captured post-success AFTER
  // the scene sink has accepted ownership; `busy` mirrors the button's
  // busy flag so subscribers can key on both.
  let exportables: OrchestratorExportables | null = null;
  let busy = false;
  const stateListeners = new Set<(s: OrchestratorExportState) => void>();
  function snapshot(): OrchestratorExportState {
    return { hasExportables: exportables !== null, isBusy: busy };
  }
  function fireState(): void {
    const snap = snapshot();
    for (const l of stateListeners) {
      try {
        l(snap);
      } catch (err) {
        logger.error('[generate] export-state listener threw:', err);
      }
    }
  }

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

      // Issue #91 — a fresh run supersedes any previously-held exportables
      // (either from a prior success, or orphaned if the epoch was bumped
      // externally and no one called `invalidateExportables()`). Clear +
      // flip busy=true so the Export STL button goes disabled the instant
      // the user clicks Generate. Single `fireState()` call covers both
      // transitions for subscribers.
      exportables = null;
      busy = true;
      fireState();

      // Issue #97 Fix 1 (dogfood 2026-04-21 round 3): Yield helper that
      // waits for TWO full animation frames. A single `requestAnimationFrame`
      // fires BEFORE the browser has actually painted — the resolve() lands
      // in the gap between "last frame ended" and "next paint", so the
      // following synchronous manifold op owns the thread before the
      // banner label update reaches the screen. Double-RAF forces at
      // least one full paint cycle between phases: the first RAF lands
      // after layout, the second lands after compositing + paint. happy-dom
      // / node test envs without requestAnimationFrame fall back to a
      // short timeout — still a yield, approximates "one frame" at 60Hz.
      const yieldForPaint = (): Promise<void> =>
        new Promise<void>((resolve) => {
          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          } else {
            setTimeout(resolve, 32);
          }
        });

      // Issue #87 Fix 1: build the onPhase callback that forwards
      // each GeneratePhase into the status sink + yields to RAF so
      // the DOM paints the label before the next synchronous
      // manifold op starts. Using a closure over `status` so the
      // happy / stale / error paths below can share the hide logic.
      //
      // Issue #97 Fix 1: the yield now awaits TWO RAF ticks via
      // `yieldForPaint` — single-RAF wasn't enough to guarantee a paint
      // before the next manifold op kicked in and held the UI thread.
      const onPhase = status
        ? async (key: string): Promise<void> => {
            const label = translatePhase ? translatePhase(key) : key;
            status.setPhase(label);
            await yieldForPaint();
          }
        : undefined;

      // Issue #97 Fix 1A: show the banner IMMEDIATELY on click, BEFORE
      // the pipeline enters its first sync block. `setTimeout(r, 32)`
      // (not `yieldForPaint`) is used here because this fires BEFORE
      // any onPhase await loop — a 32 ms sleep gives the browser a
      // guaranteed paint frame regardless of when the next RAF tick
      // lands. Under NODE_ENV=test or the orchestrator-with-no-status
      // path this costs 32 ms per `run()`; the happy-dom vitest bundle
      // tolerates it and no test asserts on precise timing.
      if (status) {
        const startingLabel = translatePhase
          ? translatePhase('starting')
          : 'starting';
        status.setPhase(startingLabel);
        await new Promise<void>((resolve) => {
          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          } else {
            setTimeout(resolve, 32);
          }
        });
      }

      try {
        const result = await generate(
          master,
          parameters,
          viewTransform,
          onPhase,
        );

        if (epoch !== getEpoch()) {
          // Staleness drop: an invalidation (commit, reset, new STL) or a
          // later click bumped the epoch while we were awaiting. None of
          // the Manifolds reached the scene, so the orchestrator is still
          // the owner — release every one here.
          safeDelete(result.silicone);
          for (const p of result.shellPieces) safeDelete(p);
          safeDelete(result.basePart);
          // Clear the progress banner — the stale run had a phase
          // label showing, and a later `run()` may or may not have
          // already set a new one. Safe to hide: if a later run is
          // in flight it'll re-show on its next `onPhase`.
          status?.setPhase(null);
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
              // Issue #87 Fix 2: forward the slab thickness so the
              // viewport can lift the master + silicone + parts
              // groups by that much and put the slab on the bed.
              baseSlabThickness_mm: parameters.baseSlabThickness_mm,
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
          !printShellFailed
        ) {
          // Issue #91 — capture the Manifolds for STL export. Lifetime
          // belongs to the scene sink (it accepted ownership above); we
          // only keep references so the Export STL button can hand them
          // to the geometry adapter. Staleness paths (invalidateExportables,
          // next `run()`) drop these refs without `.delete()`-ing — the
          // scene's `clearPrintableParts` handles disposal.
          exportables = {
            basePart: result.basePart,
            shellPieces: result.shellPieces,
          };
          fireState();
          if (onGenerateSuccess) onGenerateSuccess();

          // Issue #93 — degenerate-slab notice. When the user commits
          // the wrong orientation (e.g. figurine top-face instead of
          // bottom) the base slab footprint collapses to zero area and
          // `buildBaseSlab` returns a valid-but-empty Manifold. The
          // export still writes `base-slab.stl` as a 0-triangle binary
          // STL; the user prints nothing and doesn't know why. Surface
          // a NOTICE (not an error) post-generate so they can re-orient
          // and regenerate. Fires at most once per successful `run()`
          // and ONLY on the happy-path terminal branch — stale-drops
          // and error paths skip it since the user will see the
          // superseding run's outcome. Checks BOTH `isEmpty()` and
          // `<= 0` volume for defence in depth — a non-empty but
          // zero-volume slab is still a user-visible problem.
          if (showNotice) {
            const slabDegenerate =
              (typeof result.basePart.isEmpty === 'function' &&
                result.basePart.isEmpty()) ||
              !(result.baseSlabVolume_mm3 > 0);
            if (slabDegenerate) {
              const key = 'warnings.degenerateSlab';
              const msg = translateWarning ? translateWarning(key) : key;
              try {
                showNotice(msg);
              } catch (err) {
                logger.error('[generate] showNotice threw:', err);
              }
            }
          }
          // Issue #97 Fix 1C: keep the progress banner visible until
          // the scene has actually REPAINTED with the fresh silicone +
          // printable-parts meshes. `setSilicone` + `setPrintableParts`
          // resolved above but Three's next render still hasn't
          // happened — yanking the banner right away leaves the user
          // staring at the OLD scene for one more frame with no "still
          // working" cue. Waiting for two RAF ticks flushes the
          // rAF-driven render loop at least once, so the banner fades
          // only after the new geometry is on screen. The `finally`
          // block below is what calls `setPhase(null)`.
          if (status) await yieldForPaint();
        }
      } catch (err) {
        if (epoch !== getEpoch()) {
          // Late error from a stale run — hide any banner it left.
          status?.setPhase(null);
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        logger.error('[generate] failed:', err);
        button.setError(message);
      } finally {
        if (epoch === getEpoch()) {
          button.setBusy(false);
          // Issue #87 Fix 1: every terminal path (success, stale,
          // error) must hide the progress banner. Putting it in the
          // `epoch === getEpoch()` branch means a stale run that
          // resolves AFTER a newer run has taken over leaves the
          // newer run's banner intact.
          status?.setPhase(null);
          // Issue #91 — release the busy flag + re-notify subscribers
          // of the final state. On the error path `exportables` stayed
          // null (we never reached the capture point), so this fires a
          // `{hasExportables:false, isBusy:false}` notification — the
          // Export STL button stays disabled, correctly. On the success
          // path `exportables` was set above, so the notification is
          // `{true, false}` — the button goes enabled.
          busy = false;
          fireState();
        }
      }
    },
    getCurrentExportables(): OrchestratorExportables | null {
      return exportables;
    },
    onStateChange(
      listener: (state: OrchestratorExportState) => void,
    ): () => void {
      stateListeners.add(listener);
      // Fire the current state synchronously so subscribers don't have
      // to guess the initial snapshot. Mirrors the common "subscribe +
      // replay" pattern used elsewhere in the renderer (parametersStore,
      // dimensionsStore).
      try {
        listener(snapshot());
      } catch (err) {
        logger.error('[generate] export-state listener threw on attach:', err);
      }
      return () => {
        stateListeners.delete(listener);
      };
    },
    invalidateExportables(): void {
      if (exportables === null) return;
      exportables = null;
      fireState();
    },
  };
}
