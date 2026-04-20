// tests/renderer/ui/printablePartsToggle.test.ts
//
// @vitest-environment happy-dom
//
// Unit tests for the "Show printable parts" toolbar toggle (`src/renderer/
// ui/printablePartsToggle.ts`, issue #62). Mirrors the
// `explodedViewToggle.test.ts` shape so toolbar-toggle conventions stay
// in sync. Pins:
//
//   1. Starts disabled + not-pressed.
//   2. setEnabled(true) → button clickable; click fires onToggle(true)
//      and flips aria-pressed to true.
//   3. Second click fires onToggle(false) and flips aria-pressed back.
//   4. setEnabled(false) while pressed must force pressed=false (AC:
//      "parts cleared → toggle goes back to disabled + off").
//   5. Clicks while disabled are swallowed (no callback).
//   6. setActive is a programmatic flip — does NOT fire onToggle.

import { beforeEach, describe, expect, test, vi } from 'vitest';

import { initI18n } from '@/renderer/i18n';
import { mountPrintablePartsToggle } from '@/renderer/ui/printablePartsToggle';

beforeEach(() => {
  document.body.innerHTML = '';
  initI18n();
});

function mount(): {
  host: HTMLElement;
  toggle: ReturnType<typeof mountPrintablePartsToggle>;
  onToggle: ReturnType<typeof vi.fn<(active: boolean) => void>>;
} {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const onToggle = vi.fn<(active: boolean) => void>();
  const toggle = mountPrintablePartsToggle(host, { onToggle });
  return { host, toggle, onToggle };
}

function getBtn(): HTMLButtonElement {
  const btn = document.querySelector<HTMLButtonElement>(
    '[data-testid="printable-parts-toggle"]',
  );
  if (!btn) throw new Error('printable-parts-toggle button missing');
  return btn;
}

describe('mountPrintablePartsToggle — initial state', () => {
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
    expect(btn.textContent).toBe('Show printable parts');
    expect(btn.title).toBe(
      'Show the printable 3D-print parts (base, sides, top cap) around the silicone',
    );
  });
});

describe('mountPrintablePartsToggle — click flow', () => {
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
    const btn = getBtn();
    btn.click();
    expect(onToggle).not.toHaveBeenCalled();
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('mountPrintablePartsToggle — state propagation', () => {
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

describe('mountPrintablePartsToggle — destroy', () => {
  test('removes the button from the DOM', () => {
    const { toggle } = mount();
    expect(
      document.querySelector('[data-testid="printable-parts-toggle"]'),
    ).not.toBeNull();
    toggle.destroy();
    expect(
      document.querySelector('[data-testid="printable-parts-toggle"]'),
    ).toBeNull();
  });
});
