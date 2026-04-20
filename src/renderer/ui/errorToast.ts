// src/renderer/ui/errorToast.ts
//
// Minimal singleton error-toast surface. A lazy-mounted `<div>` at the
// bottom-centre of the window that shows a single user-visible error line
// and fades out after a short timeout.
//
// Why build this instead of reusing the generate-button's `setError`? The
// generate-block is sidebar-scoped and conveys "generate failed" semantics;
// dropping a non-STL file has nothing to do with mold generation. The Open
// STL flow has logged errors to `console.error` up to now (see the comment
// on `handleOpenStl` in main.ts referencing issue #16 "user-visible toast
// is later work"). Issue #27 now requires drag-drop to surface errors
// user-visibly, so this is the consolidation the issue asks for: "Surface
// errors ... via the same user-visible error channel the Open STL dialog
// uses today — consolidate if there isn't one."
//
// Scope kept tight on purpose:
//   - Single active message (new call replaces the current text; no queue).
//   - Auto-dismisses after `TIMEOUT_MS`. Callers can force-clear via `clear()`.
//   - No animation library; opacity transition via CSS in index.html.
//   - No ARIA live-region politeness beyond role=alert — good enough for the
//     brief, discrete failures this module currently handles.
//
// The overlay element is appended to `document.body` on first use and kept
// across invocations (DOM-light; the fade-out transition relies on it
// staying in the tree).

const OVERLAY_ID = 'app-error-toast';
const TIMEOUT_MS = 5000;

let overlay: HTMLDivElement | null = null;
let hideTimer: number | null = null;

/**
 * Ensure the overlay `<div>` is in the DOM and return it. Lazy-mount so
 * this module has no side effects at import time — important for Vitest
 * specs that import-and-discard without triggering a render.
 */
function ensureOverlay(): HTMLDivElement {
  if (overlay && overlay.isConnected) return overlay;
  const existing = document.getElementById(OVERLAY_ID);
  if (existing instanceof HTMLDivElement) {
    overlay = existing;
    return overlay;
  }
  const el = document.createElement('div');
  el.id = OVERLAY_ID;
  el.setAttribute('role', 'alert');
  el.setAttribute('aria-live', 'assertive');
  el.dataset['testid'] = 'error-toast';
  // Hidden by default; `.is-visible` flips display + opacity.
  el.hidden = true;
  document.body.appendChild(el);
  overlay = el;
  return el;
}

/**
 * Show `message` in the overlay. Replaces any prior message and resets the
 * auto-dismiss timer. Passing an empty string is treated as `clear()`.
 */
export function showError(message: string): void {
  if (!message) {
    clear();
    return;
  }
  const el = ensureOverlay();
  el.textContent = message;
  el.hidden = false;
  // Force reflow so the transition reruns when two errors land back-to-back.
  el.classList.remove('is-visible');
  void el.offsetWidth;
  el.classList.add('is-visible');

  if (hideTimer !== null) {
    window.clearTimeout(hideTimer);
  }
  hideTimer = window.setTimeout(() => {
    clear();
  }, TIMEOUT_MS);
}

/**
 * Force-clear the overlay immediately. Safe to call when nothing is showing.
 * Used by callers that want to wipe stale state before triggering a new
 * action (e.g. a successful load should clear any lingering error banner).
 */
export function clear(): void {
  if (hideTimer !== null) {
    window.clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (!overlay) return;
  overlay.classList.remove('is-visible');
  overlay.hidden = true;
  overlay.textContent = '';
}

/**
 * Read the current error text (empty string when hidden). Intended for
 * tests — the DOM is the source of truth, but this keeps specs from
 * reaching into the internal module state.
 */
export function currentMessage(): string {
  if (!overlay || overlay.hidden) return '';
  return overlay.textContent ?? '';
}

/**
 * Test-only reset: detaches the overlay and wipes internal state. The
 * lazy-mount path will re-create it on the next `showError`. Not exported
 * from the public barrel; imported directly by unit tests.
 */
export function __resetForTests(): void {
  if (hideTimer !== null) {
    window.clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (overlay && overlay.parentElement) {
    overlay.parentElement.removeChild(overlay);
  }
  overlay = null;
}
