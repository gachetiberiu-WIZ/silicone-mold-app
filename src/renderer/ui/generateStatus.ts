// src/renderer/ui/generateStatus.ts
//
// Issue #87 Fix 1 (dogfood 2026-04-21): non-modal progress banner that
// appears during Generate and updates as the pipeline walks through
// its phases. Pre-fix: the user clicked Generate and the app froze
// visually for 10-60 s (no progress feedback, master freezes, no
// spinner) — "I thought it hung" quote from the dogfood session.
//
// Shape:
//
//   const api = mountGenerateStatus(container);
//   api.setPhase('Building silicone…');  // show or update banner
//   api.setPhase(null);                   // hide + auto-fade
//   api.destroy();                        // remove + detach
//
// DOM:
//
//   <div class="generate-status" role="status" aria-live="polite"
//        data-testid="generate-status">
//     <span class="generate-status__spinner" aria-hidden="true"></span>
//     <span class="generate-status__label"></span>
//   </div>
//
// Visual: top-center of the viewport, pinned via position:absolute;
// fixed-width horizontal pill, subtle accent-tinted background, spinner
// that animates via pure CSS (no RAF needed — the banner exists only
// for a few seconds and Playwright's `animations: 'disabled'` won't
// flatten the in-flight tween in visual-regression tests because the
// generate-status isn't in any committed golden).
//
// Test-hook surface:
//
//   - `data-testid="generate-status"` on the wrapper
//   - `data-testid="generate-status-label"` on the inner label span
//
// Mounted element lifecycle:
//
//   - Starts hidden (display:none via `.is-hidden`).
//   - `setPhase(label)` renders `label`, removes `.is-hidden`,
//     cancels any pending auto-clear timer.
//   - `setPhase(null)` starts a 250 ms fade-out (via the existing
//     transition) then hides the element. Calling setPhase(label)
//     again before the timer fires cancels the clear and shows the
//     new label immediately.
//   - `destroy()` removes the element + detaches from DOM.

/**
 * Imperative API returned by `mountGenerateStatus`.
 */
export interface GenerateStatusApi {
  /**
   * Show the banner with `label`, or hide it when `label` is `null`.
   * Called from the orchestrator at each phase boundary via the
   * `generateSiliconeShell::onPhase` callback. Safe to call
   * rapidly — every call cancels any in-flight hide timer.
   */
  setPhase(label: string | null): void;
  /** True when the banner is currently visible. */
  isVisible(): boolean;
  /** Read the current label text (empty string when hidden). */
  getLabel(): string;
  /** Remove from DOM + detach. Idempotent. */
  destroy(): void;
}

/** How long to wait after setPhase(null) before hiding the element. */
const HIDE_DELAY_MS = 250;

/**
 * Mount the progress-banner element into `container`. Returns an
 * imperative API the orchestrator drives.
 */
export function mountGenerateStatus(container: HTMLElement): GenerateStatusApi {
  const wrap = document.createElement('div');
  wrap.className = 'generate-status is-hidden';
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-live', 'polite');
  wrap.dataset['testid'] = 'generate-status';

  const spinner = document.createElement('span');
  spinner.className = 'generate-status__spinner';
  spinner.setAttribute('aria-hidden', 'true');
  wrap.appendChild(spinner);

  const label = document.createElement('span');
  label.className = 'generate-status__label';
  label.dataset['testid'] = 'generate-status-label';
  wrap.appendChild(label);

  container.appendChild(wrap);

  let hideTimer: number | null = null;
  let destroyed = false;

  function cancelHideTimer(): void {
    if (hideTimer !== null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function setPhaseImpl(next: string | null): void {
    if (destroyed) return;
    if (next === null) {
      // Fade out, then fully hide. Keep the label text during the
      // fade so the transition doesn't visually glitch.
      cancelHideTimer();
      wrap.classList.remove('is-visible');
      hideTimer = window.setTimeout(() => {
        hideTimer = null;
        wrap.classList.add('is-hidden');
        label.textContent = '';
      }, HIDE_DELAY_MS);
      return;
    }
    cancelHideTimer();
    label.textContent = next;
    wrap.classList.remove('is-hidden');
    // Force a reflow so the .is-visible transition re-runs when the
    // element was just un-hidden in the same tick.
    void wrap.offsetWidth;
    wrap.classList.add('is-visible');
  }

  return {
    setPhase: setPhaseImpl,
    isVisible(): boolean {
      return !wrap.classList.contains('is-hidden');
    },
    getLabel(): string {
      return label.textContent ?? '';
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      cancelHideTimer();
      if (wrap.parentElement) wrap.parentElement.removeChild(wrap);
    },
  };
}
