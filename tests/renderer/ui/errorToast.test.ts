// tests/renderer/ui/errorToast.test.ts
//
// @vitest-environment happy-dom
//
// Coverage for the consolidated user-visible error channel introduced in
// issue #27. Primary scope: idempotent show/clear, auto-dismiss timer,
// text replacement on rapid successive calls.
//
// Not covered here: CSS transitions (Vitest + happy-dom don't run them),
// or the route-through from drop-zone / Open-STL — those live in the
// E2E spec.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  __resetForTests,
  clear,
  currentMessage,
  showError,
  showNotice,
} from '@/renderer/ui/errorToast';

beforeEach(() => {
  __resetForTests();
  document.body.innerHTML = '';
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('errorToast', () => {
  test('showError mounts the overlay and sets the message', () => {
    showError('Something broke');
    const el = document.getElementById('app-error-toast');
    expect(el).not.toBeNull();
    expect(el?.textContent).toBe('Something broke');
    expect(el?.hidden).toBe(false);
    expect(el?.classList.contains('is-visible')).toBe(true);
    expect(el?.getAttribute('role')).toBe('alert');
  });

  test('currentMessage reflects the active text, empty when hidden', () => {
    expect(currentMessage()).toBe('');
    showError('foo');
    expect(currentMessage()).toBe('foo');
    clear();
    expect(currentMessage()).toBe('');
  });

  test('successive calls replace the message (no queue)', () => {
    showError('first');
    showError('second');
    expect(currentMessage()).toBe('second');
  });

  test('auto-dismiss after 5 s', () => {
    showError('gone in 5s');
    expect(currentMessage()).toBe('gone in 5s');
    vi.advanceTimersByTime(4999);
    expect(currentMessage()).toBe('gone in 5s');
    vi.advanceTimersByTime(2);
    expect(currentMessage()).toBe('');
  });

  test('clear() cancels the pending auto-dismiss', () => {
    showError('x');
    clear();
    // Advance past the would-be timeout — no throw, state still empty.
    vi.advanceTimersByTime(10_000);
    expect(currentMessage()).toBe('');
  });

  test('showError("") is treated as clear()', () => {
    showError('x');
    showError('');
    expect(currentMessage()).toBe('');
  });
});

describe('errorToast — notice level (issue #64)', () => {
  // showNotice surfaces non-error advisories ("we repaired your STL")
  // through the same single-slot overlay but with the `is-notice`
  // marker class swapped in and role=status/aria-live=polite so
  // assistive-tech users don't hear an alert interrupt.

  test('showNotice mounts the overlay with the notice class + polite aria', () => {
    showNotice('Repaired non-manifold STL on load');
    const el = document.getElementById('app-error-toast');
    expect(el).not.toBeNull();
    expect(el?.textContent).toBe('Repaired non-manifold STL on load');
    expect(el?.hidden).toBe(false);
    expect(el?.classList.contains('is-visible')).toBe(true);
    expect(el?.classList.contains('is-notice')).toBe(true);
    expect(el?.getAttribute('role')).toBe('status');
    expect(el?.getAttribute('aria-live')).toBe('polite');
  });

  test('showNotice after showError swaps the level class + aria role', () => {
    showError('broke');
    const el = document.getElementById('app-error-toast');
    expect(el?.classList.contains('is-notice')).toBe(false);
    expect(el?.getAttribute('role')).toBe('alert');

    showNotice('repaired');
    expect(el?.classList.contains('is-notice')).toBe(true);
    expect(el?.getAttribute('role')).toBe('status');
    expect(el?.textContent).toBe('repaired');
  });

  test('showError after showNotice swaps back to error level', () => {
    showNotice('repaired');
    const el = document.getElementById('app-error-toast');
    expect(el?.classList.contains('is-notice')).toBe(true);

    showError('broke');
    expect(el?.classList.contains('is-notice')).toBe(false);
    expect(el?.getAttribute('role')).toBe('alert');
    expect(el?.getAttribute('aria-live')).toBe('assertive');
  });

  test('showNotice auto-dismisses on the same timer as showError', () => {
    showNotice('gone in 5s');
    expect(currentMessage()).toBe('gone in 5s');
    vi.advanceTimersByTime(4999);
    expect(currentMessage()).toBe('gone in 5s');
    vi.advanceTimersByTime(2);
    expect(currentMessage()).toBe('');
  });

  test('clear() after showNotice strips the notice class (so the next show re-sets it cleanly)', () => {
    showNotice('repaired');
    const el = document.getElementById('app-error-toast');
    expect(el?.classList.contains('is-notice')).toBe(true);
    clear();
    expect(el?.classList.contains('is-notice')).toBe(false);
  });
});
