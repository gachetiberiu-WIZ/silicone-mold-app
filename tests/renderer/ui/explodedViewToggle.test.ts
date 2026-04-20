// tests/renderer/ui/explodedViewToggle.test.ts
//
// @vitest-environment happy-dom
//
// Unit tests for the Exploded-view toolbar toggle (`src/renderer/ui/
// explodedViewToggle.ts`, issue #47). The toggle is state-driven — its
// job is to reflect scene-side state back into an aria-pressed button
// and fire a callback on user flips. Pins:
//
//   1. Starts disabled + not-pressed.
//   2. setEnabled(true) → button clickable; click fires onToggle(true)
//      and flips aria-pressed to true.
//   3. Second click fires onToggle(false) and flips aria-pressed back.
//   4. setEnabled(false) while pressed must force pressed=false (AC:
//      "silicone cleared → toggle goes back to disabled + off").
//   5. Clicks while disabled are swallowed (no callback).
//   6. setActive is a programmatic flip — does NOT fire onToggle.
//
// Mirrors the `placeOnFaceToggle` test shape so conventions stay in sync.

import { beforeEach, describe, expect, test, vi } from 'vitest';

import { initI18n } from '@/renderer/i18n';
import { mountExplodedViewToggle } from '@/renderer/ui/explodedViewToggle';

beforeEach(() => {
  // Fresh DOM per test so data-testid queries don't collide.
  document.body.innerHTML = '';
  // i18n must be initialised so the button label resolves.
  initI18n();
});

function mount(): {
  host: HTMLElement;
  toggle: ReturnType<typeof mountExplodedViewToggle>;
  onToggle: ReturnType<typeof vi.fn<(active: boolean) => void>>;
} {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const onToggle = vi.fn<(active: boolean) => void>();
  const toggle = mountExplodedViewToggle(host, { onToggle });
  return { host, toggle, onToggle };
}

function getBtn(): HTMLButtonElement {
  const btn = document.querySelector<HTMLButtonElement>(
    '[data-testid="exploded-view-toggle"]',
  );
  if (!btn) throw new Error('exploded-view-toggle button missing');
  return btn;
}

describe('mountExplodedViewToggle — initial state', () => {
  test('starts disabled + not-pressed', () => {
    const { toggle } = mount();
    const btn = getBtn();
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.isActive()).toBe(false);
  });

  test('renders the localised label + title', () => {
    mount();
    const btn = getBtn();
    expect(btn.textContent).toBe('Exploded view');
    expect(btn.title).toBe(
      'Show the two silicone halves moved apart so the cavity is visible',
    );
  });
});

describe('mountExplodedViewToggle — click flow', () => {
  test('setEnabled(true) → click fires onToggle(true) and flips aria-pressed', () => {
    const { toggle, onToggle } = mount();
    toggle.setEnabled(true);
    const btn = getBtn();
    expect(btn.disabled).toBe(false);

    btn.click();
    expect(onToggle).toHaveBeenCalledWith(true);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.isActive()).toBe(true);
  });

  test('second click flips back to unpressed', () => {
    const { toggle, onToggle } = mount();
    toggle.setEnabled(true);
    const btn = getBtn();

    btn.click();
    btn.click();

    expect(onToggle).toHaveBeenNthCalledWith(1, true);
    expect(onToggle).toHaveBeenNthCalledWith(2, false);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.isActive()).toBe(false);
  });

  test('clicks while disabled are swallowed', () => {
    const { onToggle } = mount();
    // Toggle remains disabled — default state.
    const btn = getBtn();
    btn.click();
    expect(onToggle).not.toHaveBeenCalled();
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('mountExplodedViewToggle — state propagation', () => {
  test('setEnabled(false) while pressed forces pressed=false', () => {
    const { toggle } = mount();
    toggle.setEnabled(true);
    getBtn().click();
    expect(toggle.isActive()).toBe(true);

    toggle.setEnabled(false);
    const btn = getBtn();
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.isActive()).toBe(false);
  });

  test('setActive is a programmatic flip and does NOT fire onToggle', () => {
    const { toggle, onToggle } = mount();
    toggle.setEnabled(true);
    toggle.setActive(true);
    const btn = getBtn();
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.isActive()).toBe(true);
    expect(onToggle).not.toHaveBeenCalled();

    toggle.setActive(false);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe('mountExplodedViewToggle — destroy', () => {
  test('removes the button from the DOM', () => {
    const { toggle } = mount();
    expect(
      document.querySelector('[data-testid="exploded-view-toggle"]'),
    ).not.toBeNull();
    toggle.destroy();
    expect(
      document.querySelector('[data-testid="exploded-view-toggle"]'),
    ).toBeNull();
  });
});
