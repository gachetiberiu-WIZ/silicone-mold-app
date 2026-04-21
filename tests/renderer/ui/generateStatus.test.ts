// tests/renderer/ui/generateStatus.test.ts
//
// @vitest-environment happy-dom
//
// Unit tests for the Generate progress banner (issue #87 Fix 1).
// Pins:
//
//   1. Starts hidden (display:none via `.is-hidden`).
//   2. `setPhase(label)` shows the banner + writes the label into
//      the DOM element tagged `data-testid="generate-status-label"`.
//   3. `setPhase(null)` triggers a delayed hide — after the 250 ms
//      timer the element carries `.is-hidden` again and the label
//      is empty.
//   4. Rapid setPhase(label) → setPhase(null) → setPhase(label')
//      cancels the pending hide and shows the new label
//      immediately (no flicker).
//   5. `destroy()` removes the element from DOM + subsequent
//      `setPhase` calls are safe no-ops.
//   6. Reading hooks (`isVisible`, `getLabel`) match DOM state.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { mountGenerateStatus } from '@/renderer/ui/generateStatus';

beforeEach(() => {
  document.body.innerHTML = '';
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('generateStatus — mount', () => {
  test('appends a hidden banner to the container', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const api = mountGenerateStatus(host);

    const el = host.querySelector<HTMLElement>(
      '[data-testid="generate-status"]',
    );
    expect(el).not.toBeNull();
    expect(el?.classList.contains('is-hidden')).toBe(true);
    expect(el?.classList.contains('is-visible')).toBe(false);
    expect(api.isVisible()).toBe(false);
    expect(api.getLabel()).toBe('');
  });

  test('has a label span tagged for tests', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    mountGenerateStatus(host);
    const label = host.querySelector<HTMLElement>(
      '[data-testid="generate-status-label"]',
    );
    expect(label).not.toBeNull();
  });
});

describe('generateStatus — setPhase(label)', () => {
  test('shows the banner and writes the label', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const api = mountGenerateStatus(host);

    api.setPhase('Building silicone…');

    const el = host.querySelector<HTMLElement>(
      '[data-testid="generate-status"]',
    )!;
    expect(el.classList.contains('is-hidden')).toBe(false);
    expect(el.classList.contains('is-visible')).toBe(true);
    expect(api.isVisible()).toBe(true);
    expect(api.getLabel()).toBe('Building silicone…');
  });

  test('successive labels replace the prior text (no queue)', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const api = mountGenerateStatus(host);

    api.setPhase('Building silicone…');
    api.setPhase('Building print shell…');

    expect(api.getLabel()).toBe('Building print shell…');
    expect(api.isVisible()).toBe(true);
  });
});

describe('generateStatus — setPhase(null)', () => {
  test('fades out, then hides after the 250 ms delay', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const api = mountGenerateStatus(host);

    api.setPhase('Building silicone…');
    const el = host.querySelector<HTMLElement>(
      '[data-testid="generate-status"]',
    )!;
    expect(el.classList.contains('is-visible')).toBe(true);

    api.setPhase(null);
    // Immediately: the visible class drops so the CSS fade-out can
    // run. Still not hidden (label still in DOM for the fade).
    expect(el.classList.contains('is-visible')).toBe(false);
    expect(el.classList.contains('is-hidden')).toBe(false);

    vi.advanceTimersByTime(250);

    expect(el.classList.contains('is-hidden')).toBe(true);
    expect(api.isVisible()).toBe(false);
    expect(api.getLabel()).toBe('');
  });

  test('a new setPhase(label) before the hide timer fires cancels the hide', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const api = mountGenerateStatus(host);

    api.setPhase('first');
    api.setPhase(null);
    vi.advanceTimersByTime(100); // inside the 250 ms hide window
    api.setPhase('second');

    // Advance past the pre-cancel hide timer.
    vi.advanceTimersByTime(500);

    expect(api.isVisible()).toBe(true);
    expect(api.getLabel()).toBe('second');
  });
});

describe('generateStatus — destroy', () => {
  test('removes the element from DOM', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const api = mountGenerateStatus(host);
    expect(
      host.querySelector('[data-testid="generate-status"]'),
    ).not.toBeNull();

    api.destroy();

    expect(
      host.querySelector('[data-testid="generate-status"]'),
    ).toBeNull();
  });

  test('subsequent setPhase calls are safe no-ops', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const api = mountGenerateStatus(host);
    api.destroy();
    expect(() => api.setPhase('post-destroy')).not.toThrow();
    expect(() => api.setPhase(null)).not.toThrow();
  });

  test('is idempotent', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const api = mountGenerateStatus(host);
    api.destroy();
    expect(() => api.destroy()).not.toThrow();
  });
});
