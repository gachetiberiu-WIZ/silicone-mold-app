// src/renderer/ui/generateInvalidation.ts
//
// Thin glue that binds the Generate-mold button + topbar silicone/resin
// readouts to the lay-flat controller's `LAY_FLAT_COMMITTED_EVENT` stream.
//
// Issue #40 (Phase 3c wave 2) semantics:
//
//   - A Place-on-face commit changes the oriented frame the parting plane
//     operates in → any previously computed silicone/resin numbers are
//     stale.
//   - Reset orientation also changes the frame → same staleness.
//   - A fresh STL load: the lay-flat controller's `notifyMasterReset`
//     fires `LAY_FLAT_COMMITTED_EVENT` with `detail:false` if a commit was
//     previously live; the topbar+button subscription here drops the
//     numbers to `null`. (The open-STL handler also nulls them directly
//     as belt-and-braces for the first-load case where no prior commit
//     existed.)
//
// In addition to clearing the topbar, the listener bumps the shared
// `generateEpoch` counter. That closes the race where a mid-flight
// `generateSiliconeShell` promise resolves AFTER the user commits a new
// face: without the bump, the resolve still sees `epoch === currentEpoch`
// and overwrites the freshly-nulled topbar with stale numbers. See QA's
// writeup on PR #41 hard-check 2.
//
// Extracted to its own module so the wiring can be unit-tested without
// booting the full `main.ts` stack — see `tests/renderer/ui/
// generateInvalidation.test.ts`.

import { LAY_FLAT_COMMITTED_EVENT } from '../scene/layFlatController';
import { bumpGenerateEpoch } from './generateEpoch';
import type { GenerateButtonApi } from './generateButton';
import type { TopbarApi } from './topbar';

/**
 * Minimal surface required of the topbar by the invalidation wire.
 * `setPrintShellVolume` is optional so legacy test mocks that predate the
 * Wave-C fourth readout keep compiling; production always wires it.
 */
export type InvalidationTopbar = Pick<
  TopbarApi,
  'setSiliconeVolume' | 'setResinVolume'
> & {
  setPrintShellVolume?(mm3: number | null): void;
};

/**
 * Minimal surface required of the Generate button by the invalidation wire.
 * Issue #64 adds `setGenerated` and `setStale` so staleness signals
 * (orientation commit, reset, new STL load) reset the post-success hint
 * ("Generated — click to re-run...") back to the pre-generate states.
 *
 * Both are typed as optional `Pick` fields via an intersection so that
 * pre-#64 test mocks (which didn't stub these methods) keep compiling —
 * the production `GenerateButtonApi` has both so `main.ts`'s real call
 * site is fully typed.
 */
export type InvalidationGenerateButton = Pick<
  GenerateButtonApi,
  'setEnabled' | 'setError'
> & {
  setGenerated?(generated: boolean): void;
  setStale?(stale: boolean): void;
};

/**
 * Options for `attachGenerateInvalidation`. The `bumpEpoch` +
 * `clearSilicone` + `clearPrintableParts` hooks are injectable so tests
 * can observe them directly; in production `bumpEpoch` defaults to the
 * shared module-level counter and the `clear*` hooks are supplied by
 * `main.ts` from the corresponding scene modules.
 */
export interface GenerateInvalidationOptions {
  /**
   * Increment the shared generate-epoch counter and return the new value.
   * Defaults to `bumpGenerateEpoch` — override only in tests.
   */
  bumpEpoch?: () => number;
  /**
   * Tear down any silicone meshes currently in the scene and `.delete()`
   * their paired Manifolds. Optional because pre-#47 call sites (and most
   * unit tests) don't need it — in production `main.ts` passes the real
   * `clearSilicone(scene)` binding from `scene/silicone.ts`.
   *
   * Called AFTER the epoch bump + volume-null so the silicone group is
   * torn down in the same synchronous tick as the topbar reset. A
   * resolving in-flight generation's `setSilicone` call sees the stale
   * epoch and drops its halves via the orchestrator's staleness guard,
   * so we never race the stale-drop against this clear.
   */
  clearSilicone?: () => void;
  /**
   * Tear down any printable-parts meshes currently in the scene and
   * `.delete()` their cached Manifolds (issue #62). Optional for the
   * same reason `clearSilicone` is — legacy unit tests that don't care
   * about the preview scene don't have to stub it.
   *
   * Called in the same tick as `clearSilicone`, right after the epoch
   * bump + volume-null. The orchestrator's staleness guard drops any
   * in-flight `setPrintableParts` result on resolve, so the clear-vs-
   * stale-drop race is closed the same way silicone's is.
   */
  clearPrintableParts?: () => void;
}

/**
 * Attach a `LAY_FLAT_COMMITTED_EVENT` listener to `document` that:
 *   - drives the Generate button's enabled flag off the event detail,
 *   - clears any silicone / resin readouts on the topbar (orientation
 *     change → numbers are no longer valid for the current frame),
 *   - clears any pending error on the button,
 *   - bumps the shared generate-epoch counter so any in-flight
 *     `generateSiliconeShell` promise resolves into a stale-branch and
 *     drops its result (see `generateEpoch.ts` for the full rationale),
 *   - if `options.clearSilicone` is supplied, tears down any silicone
 *     meshes currently in the scene (issue #47 — silicone preview
 *     lifetime must match the topbar volumes' lifetime).
 *
 * Returns an unsubscribe function so tests (and future app teardown) can
 * detach the listener cleanly.
 */
export function attachGenerateInvalidation(
  topbar: InvalidationTopbar,
  generateButton: InvalidationGenerateButton,
  options: GenerateInvalidationOptions = {},
): () => void {
  const bump = options.bumpEpoch ?? bumpGenerateEpoch;
  const clearSilicone = options.clearSilicone;
  const clearPrintableParts = options.clearPrintableParts;
  const handler = (ev: Event): void => {
    const detail = (ev as CustomEvent<boolean>).detail;
    if (typeof detail !== 'boolean') return;
    // Bump FIRST so a concurrently-resolving `generateSiliconeShell` sees the
    // new epoch on its staleness check and drops its result. Clearing the
    // topbar afterwards is safe: even if the promise resolves between the
    // null-writes below and the orchestrator's `if (epoch !== currentEpoch)`
    // check, the resolve branch will still take the stale path.
    bump();
    generateButton.setEnabled(detail);
    topbar.setSiliconeVolume(null);
    topbar.setResinVolume(null);
    topbar.setPrintShellVolume?.(null);
    generateButton.setError(null);
    // Issue #64 — clear the post-generate hint states. A staleness signal
    // (orientation commit, reset, new STL) invalidates any previous
    // success, and the next render should fall through to the base
    // "Ready to generate" / "Orient first" / "Load STL" selector.
    if (generateButton.setGenerated) generateButton.setGenerated(false);
    if (generateButton.setStale) generateButton.setStale(false);
    if (clearSilicone) clearSilicone();
    if (clearPrintableParts) clearPrintableParts();
  };
  document.addEventListener(LAY_FLAT_COMMITTED_EVENT, handler);
  return () => {
    document.removeEventListener(LAY_FLAT_COMMITTED_EVENT, handler);
  };
}
