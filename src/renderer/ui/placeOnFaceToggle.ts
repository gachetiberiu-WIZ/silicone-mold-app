// src/renderer/ui/placeOnFaceToggle.ts
//
// Two buttons:
//
//   [ Place on face ]    toggles lay-flat picking mode
//   [ Reset orientation ] reverts to identity + recenters
//
// Issue #32 lets us place these in the sidebar OR the toolbar — the app
// has no sidebar yet, so we mount alongside the Open STL button in the
// topbar center slot. Coordinate with the parameter-form PR #31 if that
// lands first; the two toolbars compose cleanly because both live under
// `header.topbar__center`.
//
// The toggle is pressed-state-driven: `aria-pressed` + an `.is-active`
// class mirror the internal boolean. i18n keys are namespaced under
// `layFlat.*` so they are easy to locate in en.json.

import { t } from '../i18n';

/** Imperative API for the mounted toggle. */
export interface PlaceOnFaceToggleApi {
  /** Programmatically flip picking state. Mirrors a user click. */
  setActive(active: boolean): void;
  /** Enable or disable the two buttons (e.g. when no master is loaded). */
  setEnabled(enabled: boolean): void;
  /** Read the visible active state. */
  isActive(): boolean;
  /** Remove from DOM + detach listeners. Unused today, tidy. */
  destroy(): void;
}

/** Callbacks supplied by the caller (wired in main.ts to the viewport). */
export interface PlaceOnFaceToggleHandlers {
  /** User flipped the main toggle. Implementation calls viewport.enable/disable. */
  onToggle(active: boolean): void;
  /** User clicked Reset orientation. Implementation calls viewport.resetOrientation. */
  onReset(): void;
}

/**
 * Mount the toggle + reset buttons into `host`. Both buttons render disabled
 * until the caller calls `setEnabled(true)` — typically after the first
 * master mesh is loaded.
 */
export function mountPlaceOnFaceToggle(
  host: HTMLElement,
  handlers: PlaceOnFaceToggleHandlers,
): PlaceOnFaceToggleApi {
  const root = document.createElement('div');
  root.className = 'place-on-face';
  root.dataset['testid'] = 'place-on-face';

  // --- Primary toggle ---
  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'place-on-face__toggle';
  toggleBtn.dataset['testid'] = 'place-on-face-toggle';
  toggleBtn.textContent = t('layFlat.toggle');
  toggleBtn.title = t('layFlat.toggleHint');
  toggleBtn.setAttribute('aria-pressed', 'false');
  toggleBtn.disabled = true;

  // --- Reset button ---
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'place-on-face__reset';
  resetBtn.dataset['testid'] = 'place-on-face-reset';
  resetBtn.textContent = t('layFlat.reset');
  resetBtn.title = t('layFlat.resetHint');
  resetBtn.disabled = true;

  root.appendChild(toggleBtn);
  root.appendChild(resetBtn);
  host.appendChild(root);

  let active = false;
  let enabled = false;

  function renderActive(): void {
    toggleBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
    toggleBtn.classList.toggle('is-active', active);
  }

  function renderEnabled(): void {
    toggleBtn.disabled = !enabled;
    resetBtn.disabled = !enabled;
  }

  function choose(newActive: boolean): void {
    if (active === newActive) return;
    active = newActive;
    renderActive();
    handlers.onToggle(active);
  }

  toggleBtn.addEventListener('click', () => {
    if (!enabled) return;
    choose(!active);
  });
  resetBtn.addEventListener('click', () => {
    if (!enabled) return;
    handlers.onReset();
  });

  renderActive();
  renderEnabled();

  return {
    setActive(next: boolean): void {
      if (active === next) return;
      active = next;
      renderActive();
      // `setActive` is a programmatic reflection of viewport state — do NOT
      // call `handlers.onToggle` here or we'd loop (viewport → toggle →
      // viewport). The caller only uses this to surface the auto-exit-
      // on-commit transition back into the UI.
    },
    setEnabled(next: boolean): void {
      if (enabled === next) return;
      enabled = next;
      renderEnabled();
    },
    isActive(): boolean {
      return active;
    },
    destroy(): void {
      root.remove();
    },
  };
}
