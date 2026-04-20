// src/renderer/ui/explodedViewToggle.ts
//
// Toolbar toggle that animates the silicone halves apart along the
// parting-plane normal (always ±Y in v1). Sits in the topbar center slot
// next to the Place-on-face + Reset-orientation buttons — same aria-
// pressed convention, same disable-until-usable pattern.
//
// State transitions (issue #47):
//
//   silicone absent      → disabled, off.
//   silicone added       → enabled,  off  (collapsed).
//   user toggles on      → enabled,  on   (animate offset 0 → max).
//   user toggles off     → enabled,  off  (animate offset max → 0).
//   silicone cleared     → disabled, off  (regardless of prior state).
//
// The animation lives inside `scene/silicone.ts` — this module only
// drives the boolean. Aria-pressed and `.is-active` mirror the internal
// state; same style rule the place-on-face toggle uses (reused the
// existing `.place-on-face__toggle` CSS via a shared mold for the
// accent-on-pressed look; we namespace under `.exploded-view` below
// so the two toggles stay independently targetable).
//
// i18n keys: `explodedView.toggle` + `explodedView.toggleHint`.

import { t } from '../i18n';

/** Imperative API for the mounted toggle. */
export interface ExplodedViewToggleApi {
  /** Programmatically flip state. Mirrors a user click (fires callback). */
  setActive(active: boolean): void;
  /** Enable or disable the button (e.g. when silicone is/isn't in scene). */
  setEnabled(enabled: boolean): void;
  /** Read the visible active state. */
  isActive(): boolean;
  /** Remove from DOM + detach listeners. */
  destroy(): void;
}

/** Callback surface. `onToggle(active)` fires on every user flip. */
export interface ExplodedViewToggleHandlers {
  /** User flipped the toggle. Implementation wires to scene.setExplodedView. */
  onToggle(active: boolean): void;
}

/**
 * Mount the Exploded-view toggle button into `host`. Button starts
 * disabled (no silicone yet); caller flips enabled via `setEnabled(true)`
 * after a successful Generate, and back to false on every staleness
 * transition (commit, reset, new-STL).
 *
 * When flipping from enabled=true to enabled=false the active flag is
 * force-reset to `false`: "silicone cleared → toggle goes back to
 * disabled + off, regardless of prior state" (issue #47 AC). The
 * caller's wire to `scene.setExplodedView` doesn't need to fire — the
 * scene module's `clearSilicone` already tears down the halves.
 */
export function mountExplodedViewToggle(
  host: HTMLElement,
  handlers: ExplodedViewToggleHandlers,
): ExplodedViewToggleApi {
  const root = document.createElement('div');
  root.className = 'exploded-view';
  root.dataset['testid'] = 'exploded-view';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'exploded-view__toggle';
  btn.dataset['testid'] = 'exploded-view-toggle';
  btn.textContent = t('explodedView.toggle');
  btn.title = t('explodedView.toggleHint');
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
      // `setActive` is a programmatic reflection of scene state — no
      // callback. Symmetric with placeOnFaceToggle.setActive.
    },
    setEnabled(next: boolean): void {
      if (enabled === next) return;
      enabled = next;
      renderEnabled();
      // Disable must also collapse the toggle back to off — silicone is
      // gone, the visual state must reflect that. The scene-side
      // `clearSilicone` has already removed the halves, so no callback
      // is needed; we just update local state.
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
