// tests/renderer/ui/cutOverridesReadout.test.ts
//
// @vitest-environment happy-dom
//
// Unit tests for the cut-overrides readout (PR B). Covers:
//
//   1. Renders current values from the store on mount.
//   2. Updates when the store changes.
//   3. Reset button calls store.reset().
//   4. data-testid attrs are present for e2e selectors.
//   5. `destroy()` detaches and removes the node.

import { beforeEach, describe, expect, test } from 'vitest';

import { initI18n } from '@/renderer/i18n';
import { createCutOverridesStore } from '@/renderer/state/cutOverrides';
import { mountCutOverridesReadout } from '@/renderer/ui/cutOverridesReadout';

beforeEach(() => {
  document.body.innerHTML = '';
  initI18n();
});

describe('mountCutOverridesReadout', () => {
  test('mounts into the parent with data-testid wrappers', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const store = createCutOverridesStore();
    mountCutOverridesReadout(parent, store);

    expect(
      parent.querySelector('[data-testid="cut-overrides-readout"]'),
    ).toBeTruthy();
    expect(
      parent.querySelector('[data-testid="cut-overrides-readout-text"]'),
    ).toBeTruthy();
    expect(
      parent.querySelector('[data-testid="cut-overrides-reset"]'),
    ).toBeTruthy();
  });

  test('renders the current values from the store', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const store = createCutOverridesStore();
    store.setRotation(45);
    store.setCenterOffset(3, -2);
    mountCutOverridesReadout(parent, store);

    const text = parent.querySelector(
      '[data-testid="cut-overrides-readout-text"]',
    )!;
    // Text contains the rotation and the offset values.
    expect(text.textContent).toContain('45');
    expect(text.textContent).toContain('3.0');
    expect(text.textContent).toContain('-2.0');
  });

  test('updates the text when the store changes', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const store = createCutOverridesStore();
    mountCutOverridesReadout(parent, store);

    store.setRotation(90);
    const text = parent.querySelector(
      '[data-testid="cut-overrides-readout-text"]',
    )!;
    expect(text.textContent).toContain('90');
  });

  test('reset button calls store.reset()', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const store = createCutOverridesStore();
    store.setRotation(45);
    store.setCenterOffset(3, -2);
    expect(store.isAtDefaults()).toBe(false);

    mountCutOverridesReadout(parent, store);
    const reset = parent.querySelector<HTMLButtonElement>(
      '[data-testid="cut-overrides-reset"]',
    )!;
    reset.click();

    expect(store.isAtDefaults()).toBe(true);
  });

  test('destroy() removes the element and detaches', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const store = createCutOverridesStore();
    const handle = mountCutOverridesReadout(parent, store);

    handle.destroy();
    expect(
      parent.querySelector('[data-testid="cut-overrides-readout"]'),
    ).toBeNull();

    // After destroy, store updates shouldn't throw (subscription is detached).
    expect(() => store.setRotation(30)).not.toThrow();
  });
});
