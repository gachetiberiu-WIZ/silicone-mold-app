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

/** Minimal surface required of the topbar by the invalidation wire. */
export type InvalidationTopbar = Pick<
  TopbarApi,
  'setSiliconeVolume' | 'setResinVolume'
>;

/** Minimal surface required of the Generate button by the invalidation wire. */
export type InvalidationGenerateButton = Pick<
  GenerateButtonApi,
  'setEnabled' | 'setError'
>;

/**
 * Options for `attachGenerateInvalidation`. The `bumpEpoch` hook is
 * injectable so tests can observe the bump directly; in production it
 * defaults to the shared module-level counter in `generateEpoch.ts`.
 */
export interface GenerateInvalidationOptions {
  /**
   * Increment the shared generate-epoch counter and return the new value.
   * Defaults to `bumpGenerateEpoch` — override only in tests.
   */
  bumpEpoch?: () => number;
}

/**
 * Attach a `LAY_FLAT_COMMITTED_EVENT` listener to `document` that:
 *   - drives the Generate button's enabled flag off the event detail,
 *   - clears any silicone / resin readouts on the topbar (orientation
 *     change → numbers are no longer valid for the current frame),
 *   - clears any pending error on the button,
 *   - bumps the shared generate-epoch counter so any in-flight
 *     `generateSiliconeShell` promise resolves into a stale-branch and
 *     drops its result (see `generateEpoch.ts` for the full rationale).
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
    generateButton.setError(null);
  };
  document.addEventListener(LAY_FLAT_COMMITTED_EVENT, handler);
  return () => {
    document.removeEventListener(LAY_FLAT_COMMITTED_EVENT, handler);
  };
}
