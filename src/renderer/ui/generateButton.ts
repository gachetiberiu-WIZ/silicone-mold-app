// src/renderer/ui/generateButton.ts
//
// The "Generate mold" button + hint block that sits at the TOP of the right
// sidebar, above the parameter form. Part of the UX gate from issue #36:
// mold generation is explicit (button-driven), not automatic, and must be
// locked until the user commits an orientation via Place-on-face.
//
// Shape:
//
//   <div class="generate-block">
//     <button class="generate-block__button" />
//     <p class="generate-block__hint" />
//   </div>
//
// State machine (driven externally by `setEnabled`):
//
//   disabled + no master       → button disabled, hint = "Load an STL to begin."
//   disabled + master loaded   → button disabled, hint = "Orient the part on its base..."
//   enabled  + master loaded   → button enabled (accent), hint = "Ready to generate"
//
// The caller (`main.ts`) decides which of the three states applies by
// calling `setEnabled(true/false)` and `setHasMaster(true/false)` — those
// are two orthogonal axes. We keep state internal so the component can
// re-render consistently on every change.
//
// This module is renderer-thin and framework-free: plain DOM, i18n keys,
// accent colour via the `--accent` CSS token (no new colour tokens).

import { t } from '../i18n';

/** Opaque handle returned by `mountGenerateButton`. */
export interface GenerateButtonApi {
  /** The outer `<div>` — caller inserts it wherever they need. */
  readonly element: HTMLElement;
  /**
   * Flip the enabled state. When enabled, the button is clickable and the
   * hint shows "Ready to generate"; when disabled and a master is loaded,
   * the hint shows the orient-first instruction.
   *
   * Idempotent: calling with the same value twice is a no-op.
   */
  setEnabled(enabled: boolean): void;
  /**
   * Report whether an STL is currently loaded. Affects the hint text only
   * when the button is in the disabled state (see the state machine above).
   */
  setHasMaster(hasMaster: boolean): void;
  /** Read the current enabled flag (useful for tests). */
  isEnabled(): boolean;
  /** Detach from the DOM + release listeners. */
  destroy(): void;
}

export interface GenerateButtonOptions {
  /**
   * Fires when the user clicks the button in the enabled state. The caller
   * is responsible for the actual generation work (console.log stub per
   * issue #36 scope; Phase 3c wave-1-geometry replaces with the real call).
   *
   * Clicks on a disabled button are swallowed here — no need for the
   * handler to re-check. `aria-disabled` + native `disabled` are also set.
   */
  onGenerate: () => void;
}

/**
 * Mount the Generate-mold block into `container` (typically the
 * `<aside id="sidebar">`). The caller is responsible for placing the
 * returned `element` above the parameter form — we return the node
 * rather than auto-appending so `main.ts` controls DOM order.
 *
 * Initial state: disabled, no master — hint reads "Load an STL to begin."
 */
export function mountGenerateButton(
  container: HTMLElement,
  options: GenerateButtonOptions,
): GenerateButtonApi {
  const { onGenerate } = options;

  const root = document.createElement('div');
  root.className = 'generate-block';
  root.dataset['testid'] = 'generate-block';

  // --- Button -----------------------------------------------------------------
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'generate-block__button';
  button.dataset['testid'] = 'generate-btn';
  button.textContent = t('generate.button');
  // Start disabled: no master loaded → user has to Open STL + commit a
  // face first. Both the native `disabled` attribute and `aria-disabled`
  // are set so assistive-tech users get the same cue as sighted ones.
  button.disabled = true;
  button.setAttribute('aria-disabled', 'true');

  // --- Hint -----------------------------------------------------------------
  const hint = document.createElement('p');
  hint.className = 'generate-block__hint';
  hint.dataset['testid'] = 'generate-hint';
  // Hint content is re-rendered by `renderHint()` below so the initial
  // assignment is just the default starting state.

  root.appendChild(button);
  root.appendChild(hint);

  // --- State + render -------------------------------------------------------
  let enabled = false;
  let hasMaster = false;

  function renderButton(): void {
    button.disabled = !enabled;
    button.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    // We don't toggle any extra class — CSS handles the accent-vs-muted
    // swap purely off the `:disabled` pseudo-class.
  }

  function renderHint(): void {
    // Three-state selector per the spec:
    //   enabled              → "Ready to generate" (accent colour)
    //   disabled + master    → "Orient the part on its base..."
    //   disabled + no master → "Load an STL to begin."
    if (enabled) {
      hint.textContent = t('generate.ready');
      hint.classList.add('generate-block__hint--ready');
    } else {
      hint.classList.remove('generate-block__hint--ready');
      hint.textContent = hasMaster ? t('generate.hint') : t('generate.noMaster');
    }
  }

  function render(): void {
    renderButton();
    renderHint();
  }

  // --- Click wiring ---------------------------------------------------------
  // Native `disabled` buttons don't fire click events in Chromium, so the
  // `if (!enabled)` guard is belt-and-braces — it also covers the
  // synthetic-click path some tests use to dispatch through `dispatchEvent`
  // (which bypasses the native disabled check).
  const onClick = (): void => {
    if (!enabled) return;
    try {
      onGenerate();
    } catch (err) {
      // Swallow + log. The onGenerate stub logs a message today; any future
      // real generator will have its own error-handling UI, so we just make
      // sure a thrown error here doesn't break the click loop. No unhandled
      // promise rejection either — `onGenerate` is void, not Promise.
      console.error('[generate] onGenerate threw:', err);
    }
  };
  button.addEventListener('click', onClick);

  // Initial render.
  render();

  container.appendChild(root);

  return {
    element: root,
    setEnabled(next: boolean): void {
      if (enabled === next) return;
      enabled = next;
      render();
    },
    setHasMaster(next: boolean): void {
      if (hasMaster === next) return;
      hasMaster = next;
      render();
    },
    isEnabled(): boolean {
      return enabled;
    },
    destroy(): void {
      button.removeEventListener('click', onClick);
      root.remove();
    },
  };
}
