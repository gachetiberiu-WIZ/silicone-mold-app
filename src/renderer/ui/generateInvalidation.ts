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
// Extracted to its own module so the wiring can be unit-tested without
// booting the full `main.ts` stack — see `tests/renderer/ui/
// generateInvalidation.test.ts`.

import { LAY_FLAT_COMMITTED_EVENT } from '../scene/layFlatController';
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
 * Attach a `LAY_FLAT_COMMITTED_EVENT` listener to `document` that:
 *   - drives the Generate button's enabled flag off the event detail,
 *   - clears any silicone / resin readouts on the topbar (orientation
 *     change → numbers are no longer valid for the current frame),
 *   - clears any pending error on the button.
 *
 * Returns an unsubscribe function so tests (and future app teardown) can
 * detach the listener cleanly.
 */
export function attachGenerateInvalidation(
  topbar: InvalidationTopbar,
  generateButton: InvalidationGenerateButton,
): () => void {
  const handler = (ev: Event): void => {
    const detail = (ev as CustomEvent<boolean>).detail;
    if (typeof detail !== 'boolean') return;
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
