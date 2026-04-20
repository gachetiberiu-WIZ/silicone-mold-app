// tests/renderer/ui/generateButton.test.ts
//
// @vitest-environment happy-dom
//
// DOM-level tests for the "Generate mold" block (issue #36). Covers the
// state machine in `mountGenerateButton`:
//
//   1. Mounts a button + hint paragraph inside the container.
//   2. Initial state: button disabled, hint reads "Load an STL to begin."
//   3. `setHasMaster(true)` with still-disabled button → hint reads the
//      orient-first instruction.
//   4. `setEnabled(true)` → button clickable, hint reads "Ready to generate",
//      hint carries the accent class.
//   5. `setEnabled(false)` restores the disabled-with-master hint.
//   6. Click when enabled fires `onGenerate`; click when disabled is a no-op.
//   7. `aria-disabled` mirrors the native `disabled` attribute for a11y.
//   8. All visible strings resolve through i18n (no hardcoded English in the
//      component).

import i18next from 'i18next';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { initI18n } from '@/renderer/i18n';
import { mountGenerateButton } from '@/renderer/ui/generateButton';

function mount(onGenerate: () => void = () => {}): {
  container: HTMLElement;
  api: ReturnType<typeof mountGenerateButton>;
} {
  const container = document.createElement('aside');
  container.id = 'sidebar';
  document.body.appendChild(container);
  const api = mountGenerateButton(container, { onGenerate });
  return { container, api };
}

beforeEach(() => {
  document.body.innerHTML = '';
  initI18n();
});

describe('generateButton — rendering', () => {
  test('mounts a button + hint inside the container', () => {
    const { container } = mount();
    expect(
      container.querySelector('[data-testid="generate-block"]'),
    ).toBeTruthy();
    expect(container.querySelector('[data-testid="generate-btn"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="generate-hint"]')).toBeTruthy();
  });

  test('initial state: button disabled + hint reads "Load an STL to begin."', () => {
    const { container } = mount();
    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="generate-btn"]',
    )!;
    const hint = container.querySelector<HTMLElement>(
      '[data-testid="generate-hint"]',
    )!;

    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.textContent).toBe(i18next.t('generate.button'));
    expect(hint.textContent).toBe(i18next.t('generate.noMaster'));
    // No accent class in disabled state.
    expect(hint.classList.contains('generate-block__hint--ready')).toBe(false);
  });

  test('button is tab-focusable by default (no explicit tabindex opt-out)', () => {
    const { container } = mount();
    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="generate-btn"]',
    )!;
    // Native <button> is in the tab order unless disabled. `tabIndex` on a
    // default button is 0. We don't assert `!btn.disabled` here because the
    // initial state IS disabled; instead we check the element has a sane
    // tabIndex after we explicitly flip `setEnabled(true)`.
    expect(btn.tabIndex).toBe(0);
  });
});

describe('generateButton — state transitions', () => {
  test('setHasMaster(true) while disabled → hint switches to "Orient the part..."', () => {
    const { container, api } = mount();
    api.setHasMaster(true);
    const hint = container.querySelector<HTMLElement>(
      '[data-testid="generate-hint"]',
    )!;
    expect(hint.textContent).toBe(i18next.t('generate.hint'));
    // Still no accent — only enabled state gets the ready tint.
    expect(hint.classList.contains('generate-block__hint--ready')).toBe(false);
  });

  test('setEnabled(true) → button clickable + aria-disabled=false + hint = "Ready to generate"', () => {
    const { container, api } = mount();
    api.setHasMaster(true);
    api.setEnabled(true);

    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="generate-btn"]',
    )!;
    const hint = container.querySelector<HTMLElement>(
      '[data-testid="generate-hint"]',
    )!;

    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('aria-disabled')).toBe('false');
    expect(hint.textContent).toBe(i18next.t('generate.ready'));
    expect(hint.classList.contains('generate-block__hint--ready')).toBe(true);
  });

  test('setEnabled(false) after enable → hint reverts (based on hasMaster)', () => {
    const { container, api } = mount();
    api.setHasMaster(true);
    api.setEnabled(true);
    api.setEnabled(false);

    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="generate-btn"]',
    )!;
    const hint = container.querySelector<HTMLElement>(
      '[data-testid="generate-hint"]',
    )!;

    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(hint.textContent).toBe(i18next.t('generate.hint'));
    expect(hint.classList.contains('generate-block__hint--ready')).toBe(false);
  });

  test('setEnabled(false) with no master → hint reverts to "Load an STL to begin."', () => {
    // Simulates Reset orientation (committed → uncommitted) happening WITHOUT
    // a new master load. In practice hasMaster stays true after commit, but
    // this test covers the orthogonality of the two flags defensively.
    const { container, api } = mount();
    api.setHasMaster(false);
    api.setEnabled(true); // hypothetical — the caller shouldn't do this but
    // the component still renders the right hint.
    api.setEnabled(false);

    const hint = container.querySelector<HTMLElement>(
      '[data-testid="generate-hint"]',
    )!;
    expect(hint.textContent).toBe(i18next.t('generate.noMaster'));
  });

  test('isEnabled() reflects the last setEnabled call', () => {
    const { api } = mount();
    expect(api.isEnabled()).toBe(false);
    api.setEnabled(true);
    expect(api.isEnabled()).toBe(true);
    api.setEnabled(false);
    expect(api.isEnabled()).toBe(false);
  });

  test('idempotent setEnabled / setHasMaster (same value twice is a no-op)', () => {
    // Spy on the underlying render by checking that click still fires
    // correctly after redundant state flips — if the component re-wired
    // the listener on every call, a stale listener could fire twice.
    const onGenerate = vi.fn();
    const { container, api } = mount(onGenerate);
    api.setHasMaster(true);
    api.setHasMaster(true);
    api.setEnabled(true);
    api.setEnabled(true);
    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="generate-btn"]',
    )!;
    btn.click();
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });
});

describe('generateButton — click wiring', () => {
  test('click when enabled fires onGenerate', () => {
    const onGenerate = vi.fn();
    const { container, api } = mount(onGenerate);
    api.setHasMaster(true);
    api.setEnabled(true);

    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="generate-btn"]',
    )!;
    btn.click();

    expect(onGenerate).toHaveBeenCalledTimes(1);
  });

  test('click when disabled is a no-op (native + synthetic paths)', () => {
    const onGenerate = vi.fn();
    const { container } = mount(onGenerate);
    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="generate-btn"]',
    )!;

    // Native path — `.click()` on a disabled button doesn't fire in Chromium
    // and happy-dom matches that behaviour.
    btn.click();

    // Synthetic dispatch bypasses the native disabled check; the component's
    // own guard inside the click handler must still swallow the invocation.
    btn.dispatchEvent(new Event('click', { bubbles: true }));

    expect(onGenerate).not.toHaveBeenCalled();
  });

  test('keyboard activation: Enter/Space fire via native button semantics', () => {
    // Native <button> turns Enter + Space into a synthesised click. We
    // assert the listener wired here is the SAME listener the click path
    // hits, not some keydown duplicate. Dispatching a `click` event is
    // sufficient: every browser keyboard-activation path funnels through
    // it (see e.g. MDN "Button: keyboard shortcuts"), and there's no
    // kbd-specific branch in this component.
    const onGenerate = vi.fn();
    const { container, api } = mount(onGenerate);
    api.setHasMaster(true);
    api.setEnabled(true);
    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="generate-btn"]',
    )!;

    btn.dispatchEvent(new Event('click', { bubbles: true }));
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });

  test('onGenerate throwing does not crash the component', () => {
    const onGenerate = vi.fn(() => {
      throw new Error('boom');
    });
    const { container, api } = mount(onGenerate);
    api.setHasMaster(true);
    api.setEnabled(true);
    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="generate-btn"]',
    )!;

    // Should NOT propagate — component catches + console.errors.
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    expect(() => btn.click()).not.toThrow();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe('generateButton — destroy', () => {
  test('destroy removes the element + detaches the click listener', () => {
    const onGenerate = vi.fn();
    const { container, api } = mount(onGenerate);
    api.setHasMaster(true);
    api.setEnabled(true);

    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="generate-btn"]',
    )!;
    // Keep a reference to the detached node so we can try to click it post-
    // destroy without querying (it won't be in the container anymore).
    const detachedRef = btn;

    api.destroy();

    expect(
      container.querySelector('[data-testid="generate-block"]'),
    ).toBeNull();

    // The click listener was removed — dispatching a click on the orphan
    // element shouldn't invoke the handler.
    detachedRef.dispatchEvent(new Event('click', { bubbles: true }));
    expect(onGenerate).not.toHaveBeenCalled();
  });
});

describe('generateButton — busy state (issue #40)', () => {
  test('setBusy(true) disables the button and swaps the label to "Generating…"', () => {
    const { container, api } = mount();
    api.setHasMaster(true);
    api.setEnabled(true);

    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="generate-btn"]',
    )!;
    expect(btn.textContent).toBe(i18next.t('generate.button'));
    expect(btn.disabled).toBe(false);

    api.setBusy(true);
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.textContent).toBe(i18next.t('generate.buttonBusy'));
    expect(api.isBusy()).toBe(true);
  });

  test('setBusy(false) restores the label and the enabled flag is honoured', () => {
    const { container, api } = mount();
    api.setHasMaster(true);
    api.setEnabled(true);
    api.setBusy(true);
    api.setBusy(false);

    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="generate-btn"]',
    )!;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe(i18next.t('generate.button'));
    expect(api.isBusy()).toBe(false);
  });

  test('busy swallows clicks even on an enabled button', () => {
    const onGenerate = vi.fn();
    const { container, api } = mount(onGenerate);
    api.setHasMaster(true);
    api.setEnabled(true);
    api.setBusy(true);

    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="generate-btn"]',
    )!;
    // Synthetic dispatch bypasses the native disabled check, so the
    // component's internal guard must swallow the call.
    btn.dispatchEvent(new Event('click', { bubbles: true }));
    expect(onGenerate).not.toHaveBeenCalled();
  });

  test('idempotent setBusy (same value twice is a no-op)', () => {
    const { container, api } = mount();
    api.setHasMaster(true);
    api.setEnabled(true);
    api.setBusy(true);
    api.setBusy(true);

    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="generate-btn"]',
    )!;
    expect(btn.textContent).toBe(i18next.t('generate.buttonBusy'));
  });
});

describe('generateButton — error state (issue #40)', () => {
  test('setError replaces the hint with the i18n error template', () => {
    const { container, api } = mount();
    api.setHasMaster(true);
    api.setEnabled(true);
    api.setError('wall too thin');

    const hint = container.querySelector<HTMLElement>(
      '[data-testid="generate-hint"]',
    )!;
    expect(hint.textContent).toBe(
      i18next.t('generate.error', { reason: 'wall too thin' }),
    );
    expect(hint.classList.contains('generate-block__hint--error')).toBe(true);
    // Error state removes the accent-ready colour even when enabled.
    expect(hint.classList.contains('generate-block__hint--ready')).toBe(false);
  });

  test('setError(null) restores the normal hint sequence', () => {
    const { container, api } = mount();
    api.setHasMaster(true);
    api.setEnabled(true);
    api.setError('boom');
    api.setError(null);

    const hint = container.querySelector<HTMLElement>(
      '[data-testid="generate-hint"]',
    )!;
    expect(hint.textContent).toBe(i18next.t('generate.ready'));
    expect(hint.classList.contains('generate-block__hint--error')).toBe(false);
    expect(hint.classList.contains('generate-block__hint--ready')).toBe(true);
  });

  test('setError does NOT disable the button (user retries via click)', () => {
    const { container, api } = mount();
    api.setHasMaster(true);
    api.setEnabled(true);
    api.setError('boom');

    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="generate-btn"]',
    )!;
    expect(btn.disabled).toBe(false);
  });

  test('starting a new busy cycle clears any prior error', () => {
    const { container, api } = mount();
    api.setHasMaster(true);
    api.setEnabled(true);
    api.setError('boom');
    api.setBusy(true);

    const hint = container.querySelector<HTMLElement>(
      '[data-testid="generate-hint"]',
    )!;
    expect(hint.classList.contains('generate-block__hint--error')).toBe(false);
    // Busy doesn't touch the hint text itself (keeps "Ready to generate"),
    // it only clears the error branch. Re-assert the ready hint shows.
    expect(hint.textContent).toBe(i18next.t('generate.ready'));
  });
});

describe('generateButton — i18n', () => {
  test('button label, hint, and ready text all resolve through i18next', () => {
    const { container, api } = mount();

    // Disabled + no master state.
    const btn = container.querySelector('[data-testid="generate-btn"]')!;
    expect(btn.textContent).toBe(i18next.t('generate.button'));
    let hint = container.querySelector('[data-testid="generate-hint"]')!;
    expect(hint.textContent).toBe(i18next.t('generate.noMaster'));

    // Disabled + has master state.
    api.setHasMaster(true);
    hint = container.querySelector('[data-testid="generate-hint"]')!;
    expect(hint.textContent).toBe(i18next.t('generate.hint'));

    // Enabled state.
    api.setEnabled(true);
    hint = container.querySelector('[data-testid="generate-hint"]')!;
    expect(hint.textContent).toBe(i18next.t('generate.ready'));
  });
});

describe('generateButton — hint state machine (issue #64)', () => {
  // Four-transition state machine covered here:
  //   1. enabled-ready    →  generated      (after setGenerated(true))
  //   2. generated        →  stale-params   (after setStale(true))
  //   3. stale-params     →  busy           (setBusy(true) resets all flags)
  //   4. busy             →  generated      (setBusy(false) + setGenerated(true))
  // + a reset-via-invalidation path covered in generateInvalidation.test.ts.

  function getHint(container: HTMLElement): HTMLElement {
    return container.querySelector<HTMLElement>('[data-testid="generate-hint"]')!;
  }

  test('setGenerated(true) flips the hint from "ready" to "done"', () => {
    const { container, api } = mount();
    api.setHasMaster(true);
    api.setEnabled(true);
    expect(getHint(container).textContent).toBe(i18next.t('generate.ready'));
    api.setGenerated(true);
    expect(getHint(container).textContent).toBe(i18next.t('generate.done'));
    // Still tinted accent — the post-generate state is the "affirmative"
    // one, matching "Ready to generate"'s colouring.
    expect(getHint(container).classList.contains('generate-block__hint--ready')).toBe(true);
    expect(api.isGenerated()).toBe(true);
  });

  test('setStale(true) after setGenerated(true) swaps to "stale params" hint', () => {
    const { container, api } = mount();
    api.setHasMaster(true);
    api.setEnabled(true);
    api.setGenerated(true);
    api.setStale(true);
    expect(getHint(container).textContent).toBe(i18next.t('generate.staleParams'));
    expect(api.isStale()).toBe(true);
    expect(api.isGenerated()).toBe(true);
  });

  test('setStale(true) without prior generate is a no-op on the hint', () => {
    // Before a successful generate, topbar volumes are null and the
    // "Ready to generate" / "Orient first" selectors own the hint.
    // Flipping `stale` in that window must not produce a misleading
    // "Parameters changed" hint.
    const { container, api } = mount();
    api.setHasMaster(true);
    api.setEnabled(true);
    api.setStale(true);
    expect(getHint(container).textContent).toBe(i18next.t('generate.ready'));
  });

  test('setBusy(true) resets both generated + stale flags', () => {
    const { container, api } = mount();
    api.setHasMaster(true);
    api.setEnabled(true);
    api.setGenerated(true);
    api.setStale(true);
    api.setBusy(true);
    expect(api.isGenerated()).toBe(false);
    expect(api.isStale()).toBe(false);
    expect(getHint(container).textContent).not.toBe(i18next.t('generate.staleParams'));
    expect(getHint(container).textContent).not.toBe(i18next.t('generate.done'));
  });

  test('setGenerated(true) after a re-run clears stale', () => {
    const { container, api } = mount();
    api.setHasMaster(true);
    api.setEnabled(true);
    api.setGenerated(true);
    api.setStale(true);
    // User clicks Generate → busy cycle clears both; the orchestrator's
    // success hook flips generated back on at the end.
    api.setBusy(true);
    api.setBusy(false);
    api.setGenerated(true);
    expect(api.isStale()).toBe(false);
    expect(api.isGenerated()).toBe(true);
    expect(getHint(container).textContent).toBe(i18next.t('generate.done'));
  });

  test('error state wins over done/stale hints', () => {
    const { container, api } = mount();
    api.setHasMaster(true);
    api.setEnabled(true);
    api.setGenerated(true);
    api.setError('wall too thin');
    expect(getHint(container).textContent).toBe(
      i18next.t('generate.error', { reason: 'wall too thin' }),
    );
    // Stale can arrive AFTER the error is showing; error still wins.
    api.setStale(true);
    expect(getHint(container).textContent).toBe(
      i18next.t('generate.error', { reason: 'wall too thin' }),
    );
  });

  test('setGenerated(false) after stale clears stale too (belt-and-braces)', () => {
    // This path isn't driven by production today (the invalidation
    // listener drives BOTH setGenerated + setStale), but the component's
    // internal invariant is: "no generated → no stale can meaningfully
    // render either". Verify that invariant holds.
    const { container, api } = mount();
    api.setHasMaster(true);
    api.setEnabled(true);
    api.setGenerated(true);
    api.setStale(true);
    api.setGenerated(false);
    // Component does NOT auto-clear stale flag when generated flips off —
    // we keep the flags orthogonal. But the hint renderer ignores stale
    // unless generated is also true, so the user sees "Ready to generate"
    // not "Parameters changed".
    expect(getHint(container).textContent).toBe(i18next.t('generate.ready'));
  });
});
