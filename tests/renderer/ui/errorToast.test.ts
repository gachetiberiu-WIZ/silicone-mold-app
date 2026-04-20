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
