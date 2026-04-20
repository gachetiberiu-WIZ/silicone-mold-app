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
// State machine (driven externally by `setEnabled`, `setHasMaster`,
// `setBusy`, `setError`, `setGenerated`, `setStale`):
//
//   disabled + no master       → button disabled, hint = "Load an STL to begin."
//   disabled + master loaded   → button disabled, hint = "Orient the part on its base..."
//   enabled  + master loaded   → button enabled (accent), hint = "Ready to generate"
//   busy                       → button disabled, label = "Generating…"
//   generated (after success)  → button enabled, hint = "Generated — click to re-run..."
//   stale (params changed)     → button enabled, hint = "Parameters changed. Click Generate..."
//   error                      → button re-enabled, hint = red error message
//
// Issue #64 adds the `generated` + `stale` hints so the user can tell the
// pre- and post-generate enabled states apart, and so a parameter tweak
// after a successful generate visibly flags that the preview is out of
// date. Priority inside `renderHint`: error > stale > generated > ready >
// orient-hint > no-master. Errors always win; stale beats generated (user
// changed params, that's the signal that matters); generated beats ready
// (most recent event wins — we know Generate ran).
//
// The caller (`main.ts`) decides which state applies. We keep state internal
// so the component can re-render consistently on every change.
//
// This module is renderer-thin and framework-free: plain DOM, i18n keys,
// accent colour via the `--accent` CSS token (no new colour tokens — we
// reuse the existing `#e06c75` error colour that the parameter form already
// uses for invalid-range errors, kept inline on the style rule).

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
   *
   * No-op while the button is in the `busy` state — the busy path owns
   * the disabled flag end-to-end and must not be undermined by a stale
   * enabled-transition arriving mid-generation.
   */
  setEnabled(enabled: boolean): void;
  /**
   * Report whether an STL is currently loaded. Affects the hint text only
   * when the button is in the disabled state (see the state machine above).
   */
  setHasMaster(hasMaster: boolean): void;
  /**
   * Toggle the "Generating…" busy state. While busy, the button is forced
   * disabled and the label reads the i18n key `generate.buttonBusy`. The
   * hint is untouched so the user still sees "Ready to generate". Clearing
   * busy restores the label and the disabled flag to whatever `enabled`
   * says. A pending `error` (set via `setError`) is cleared on any
   * transition INTO busy so the user sees "trying again".
   */
  setBusy(busy: boolean): void;
  /**
   * Show / clear an error beneath the button. Non-null replaces the hint
   * with a red error message; null restores the normal hint sequence. The
   * caller supplies the human-readable reason string (already i18n'd or
   * plain `error.message`) — the component wraps it in the
   * `generate.error` template.
   *
   * Setting an error does NOT re-disable the button; the caller usually
   * pairs `setBusy(false)` + `setError(msg)` so the user can retry.
   */
  setError(reason: string | null): void;
  /**
   * Flip the "generate has succeeded" flag (issue #64). When true, the
   * hint reads `generate.done` ("Generated — click to re-run...") so the
   * post-success state is distinguishable from the pre-click "Ready to
   * generate" state. Any staleness signal or a new master load resets this
   * to false. Cleared automatically when the user picks up Generate again
   * (on the `setBusy(true)` transition).
   */
  setGenerated(generated: boolean): void;
  /**
   * Flip the "parameters changed since last generate" flag (issue #64).
   * When true (AND a prior generate succeeded), the hint reads
   * `generate.staleParams` so the user sees that the preview is out of
   * date relative to the current parameters. Cleared on the next
   * `setGenerated(true)` or `setHasMaster(true)`.
   */
  setStale(stale: boolean): void;
  /** Read the current enabled flag (useful for tests). */
  isEnabled(): boolean;
  /** Read the current busy flag (useful for tests). */
  isBusy(): boolean;
  /** Read the current "generated" flag (useful for tests). */
  isGenerated(): boolean;
  /** Read the current "stale params" flag (useful for tests). */
  isStale(): boolean;
  /** Detach from the DOM + release listeners. */
  destroy(): void;
}

export interface GenerateButtonOptions {
  /**
   * Fires when the user clicks the button in the enabled (non-busy) state.
   * The caller is responsible for the actual generation work. Clicks on a
   * disabled or busy button are swallowed here — no need for the handler
   * to re-check. `aria-disabled` + native `disabled` are also set.
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
  let busy = false;
  let errorReason: string | null = null;
  // Issue #64: post-generate hint states. `generated` flips true on
  // success, `stale` flips true on parameter change after a success.
  // Both reset on new-master / staleness signals (orientation change, new
  // STL) via the existing reset paths in main.ts.
  let generated = false;
  let stale = false;

  function renderButton(): void {
    // Busy always wins: user cannot re-click mid-generation even if a
    // LAY_FLAT_COMMITTED_EVENT fires for some reason between start + end.
    const effectiveDisabled = busy || !enabled;
    button.disabled = effectiveDisabled;
    button.setAttribute('aria-disabled', effectiveDisabled ? 'true' : 'false');
    button.textContent = busy ? t('generate.buttonBusy') : t('generate.button');
  }

  function renderHint(): void {
    // Priority (highest → lowest):
    //   error > stale > generated > ready > orient > no-master
    //
    // Error overrides everything else until cleared. We keep the ready-tint
    // class off and apply an inline colour so we don't need a new CSS token.
    if (errorReason !== null) {
      hint.classList.remove('generate-block__hint--ready');
      hint.classList.add('generate-block__hint--error');
      hint.textContent = t('generate.error', { reason: errorReason });
      return;
    }
    hint.classList.remove('generate-block__hint--error');
    // Issue #64 — stale beats generated: a param tweak after success is
    // the most recent user signal and the one the user needs to see.
    if (stale && generated) {
      hint.classList.add('generate-block__hint--ready');
      hint.textContent = t('generate.staleParams');
      return;
    }
    // Issue #64 — generated beats ready: Generate has run at least once
    // since the last staleness signal; tell the user re-running is what
    // the button does now.
    if (generated) {
      hint.classList.add('generate-block__hint--ready');
      hint.textContent = t('generate.done');
      return;
    }
    // Base three-state selector (pre-generate):
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
  // guards below are belt-and-braces — they also cover the synthetic-click
  // path some tests use to dispatch through `dispatchEvent` (which bypasses
  // the native disabled check).
  const onClick = (): void => {
    if (!enabled) return;
    if (busy) return;
    try {
      onGenerate();
    } catch (err) {
      // Swallow + log. Async rejections inside onGenerate are the caller's
      // problem — but a sync throw here shouldn't break the click loop.
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
    setBusy(next: boolean): void {
      if (busy === next) return;
      busy = next;
      // Starting a new generation implicitly clears any previous error so
      // the user sees "Generating…" instead of a stale red message. Also
      // clear the post-success `generated` + `stale` flags — this run will
      // set `generated` back to true on completion via the orchestrator's
      // `onGenerateSuccess` hook.
      if (busy) {
        errorReason = null;
        generated = false;
        stale = false;
      }
      render();
    },
    setError(reason: string | null): void {
      if (errorReason === reason) return;
      errorReason = reason;
      render();
    },
    setGenerated(next: boolean): void {
      if (generated === next) return;
      generated = next;
      // A fresh successful generate supersedes the stale flag — the user's
      // most recent parameters are now what's on screen.
      if (generated) stale = false;
      render();
    },
    setStale(next: boolean): void {
      if (stale === next) return;
      stale = next;
      render();
    },
    isEnabled(): boolean {
      return enabled;
    },
    isBusy(): boolean {
      return busy;
    },
    isGenerated(): boolean {
      return generated;
    },
    isStale(): boolean {
      return stale;
    },
    destroy(): void {
      button.removeEventListener('click', onClick);
      root.remove();
    },
  };
}
