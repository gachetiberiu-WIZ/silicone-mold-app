// src/renderer/ui/printablePartsToggle.ts
//
// Toolbar toggle that controls the printable-parts preview visibility
// (issue #62). Sits in the topbar center slot next to the exploded-view
// toggle — same aria-pressed convention, same disable-until-usable
// pattern.
//
// State transitions (issue #62):
//
//   no printable parts  → disabled, off.
//   parts installed     → enabled,  off  (user opts in to see).
//   user toggles on     → enabled,  on   (parts visible in scene).
//   user toggles off    → enabled,  off  (parts hidden; no tween cost).
//   parts cleared       → disabled, off  (regardless of prior state).
//
// The visibility flip lives inside `scene/printableParts.ts` — this
// module only drives the boolean. The exploded-view tween is the
// exploded-view toggle's job (next to this one); main.ts wires both
// toggles' state to their respective scene-side functions.
//
// i18n keys: `printableParts.toggle` + `printableParts.toggleHint`.

import { t } from '../i18n';

/** Imperative API for the mounted toggle. */
export interface PrintablePartsToggleApi {
  /** Programmatically flip state. Mirrors a user click (no callback). */
  setActive(active: boolean): void;
  /** Enable or disable the button (e.g. when parts are/aren't installed). */
  setEnabled(enabled: boolean): void;
  /** Read the visible active state. */
  isActive(): boolean;
  /** Remove from DOM + detach listeners. */
  destroy(): void;
}

/** Callback surface. `onToggle(active)` fires on every user flip. */
export interface PrintablePartsToggleHandlers {
  /** User flipped the toggle — wire to `setPrintablePartsVisible`. */
  onToggle(active: boolean): void;
}

/**
 * Mount the "Show printable parts" toggle into `host`. Starts disabled
 * (no parts yet); caller flips enabled via `setEnabled(true)` after a
 * successful Generate-then-hand-off, and back to false on every
 * staleness transition (commit, reset, new-STL).
 *
 * When flipping enabled=true → false the active flag is force-reset to
 * `false` so a stale "show" state doesn't carry over: if the parts are
 * gone, the toggle reads "hidden" regardless of the prior flip. Same
 * pattern the exploded-view toggle uses.
 */
export function mountPrintablePartsToggle(
  host: HTMLElement,
  handlers: PrintablePartsToggleHandlers,
): PrintablePartsToggleApi {
  const root = document.createElement('div');
  root.className = 'printable-parts';
  root.dataset['testid'] = 'printable-parts';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'printable-parts__toggle';
  btn.dataset['testid'] = 'printable-parts-toggle';
  btn.textContent = t('printableParts.toggle');
  btn.title = t('printableParts.toggleHint');
  btn.setAttribute('aria-pressed', 'false');
  btn.disabled = true;

  root.appendChild(btn);
  host.appendChild(root);

  let active = false;
  let enabled = false;

  function renderActive(): void {
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    btn.classList.toggle('is-active', active);
  }

  function renderEnabled(): void {
    btn.disabled = !enabled;
  }

  function onClick(): void {
    if (!enabled) return;
    active = !active;
    renderActive();
    handlers.onToggle(active);
  }
  btn.addEventListener('click', onClick);

  renderActive();
  renderEnabled();

  return {
    setActive(next: boolean): void {
      if (active === next) return;
      active = next;
      renderActive();
      // Programmatic flip — no callback. Symmetric with
      // explodedViewToggle.setActive.
    },
    setEnabled(next: boolean): void {
      if (enabled === next) return;
      enabled = next;
      renderEnabled();
      // Disable must also collapse the toggle back to off: parts are
      // gone, the visual state must reflect that. The scene-side
      // `clearPrintableParts` has already removed the group contents;
      // no callback fires (setActive is silent).
      if (!enabled && active) {
        active = false;
        renderActive();
      }
    },
    isActive(): boolean {
      return active;
    },
    destroy(): void {
      btn.removeEventListener('click', onClick);
      root.remove();
    },
  };
}
