// src/renderer/ui/cutOverridesReadout.ts
//
// Small DOM block that reads the current cut-overrides and exposes a
// reset button. Sits in the right sidebar near the Generate button.
//
// Shape:
//
//   <div class="cut-overrides-readout" data-testid="cut-overrides-readout">
//     <span class="cut-overrides-readout__text" data-testid="cut-overrides-readout-text">
//       Cut: 0°, (0, 0) mm
//     </span>
//     <button
//       class="cut-overrides-readout__reset"
//       data-testid="cut-overrides-reset"
//       title="Reset cut planes"
//     >⟳</button>
//   </div>
//
// Updates via a subscribe on the passed store; the reset button calls
// `store.reset()`. No styling dependencies — caller can style via the
// class names above.

import { t } from '../i18n';
import type { CutOverridesStore } from '../state/cutOverrides';

export interface CutOverridesReadoutApi {
  /** The outer element; caller inserts wherever. */
  readonly element: HTMLElement;
  /** Detach the store subscription. */
  destroy(): void;
}

/**
 * Format a number as an integer-or-1-decimal string. Rotation is
 * displayed as a whole number (rounded), offsets as 1 decimal.
 */
function fmtInt(n: number): string {
  return String(Math.round(n));
}
function fmt1(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1);
}

/**
 * Mount the cut-overrides readout into the given parent. The readout
 * subscribes to the store and re-renders on every change.
 */
export function mountCutOverridesReadout(
  parent: HTMLElement,
  store: CutOverridesStore,
): CutOverridesReadoutApi {
  const root = document.createElement('div');
  root.className = 'cut-overrides-readout';
  root.setAttribute('data-testid', 'cut-overrides-readout');

  const text = document.createElement('span');
  text.className = 'cut-overrides-readout__text';
  text.setAttribute('data-testid', 'cut-overrides-readout-text');

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'cut-overrides-readout__reset';
  reset.setAttribute('data-testid', 'cut-overrides-reset');
  reset.title = t('cutPlanes.resetTitle');
  reset.textContent = '\u27F3'; // ⟳ circular arrow
  reset.addEventListener('click', () => {
    store.reset();
  });

  root.appendChild(text);
  root.appendChild(reset);
  parent.appendChild(root);

  const render = (): void => {
    const snap = store.get();
    const rotLabel = t('cutPlanes.readoutRotation', {
      deg: fmtInt(snap.rotation_deg),
    });
    const offLabel = t('cutPlanes.readoutOffset', {
      x: fmt1(snap.centerOffset_mm.x),
      z: fmt1(snap.centerOffset_mm.z),
    });
    text.textContent = `${rotLabel}, ${offLabel}`;
  };
  render();
  const unsubscribe = store.subscribe(render);

  return {
    element: root,
    destroy(): void {
      unsubscribe();
      if (root.parentElement) root.parentElement.removeChild(root);
    },
  };
}
