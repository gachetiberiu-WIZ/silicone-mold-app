// tests/renderer/state/cutOverrides.test.ts
//
// Unit tests for the cut-overrides store (dogfood round 7, cut-planes
// preview gizmo). Covers:
//
//   1. Defaults — rotation_deg=0, centerOffset_mm={x:0, z:0}.
//   2. `setRotation` normalises degree inputs into [0, 360), handles
//      negative + super-360 values, NaN → 0.
//   3. `setCenterOffset` stores x / z; NaN collapses to 0.
//   4. `reset` restores both fields and fires exactly once when at least
//      one field was non-default.
//   5. `subscribe` returns an unsubscribe that actually detaches.
//   6. `isAtDefaults` tracks the edit state.
//   7. The snapshot and its nested centerOffset_mm are frozen.
//   8. A throwing subscriber doesn't break the store for others.

import { describe, expect, test, vi } from 'vitest';

import {
  DEFAULT_CUT_OVERRIDES,
  createCutOverridesStore,
} from '@/renderer/state/cutOverrides';

describe('DEFAULT_CUT_OVERRIDES', () => {
  test('both fields default to zero', () => {
    expect(DEFAULT_CUT_OVERRIDES.rotation_deg).toBe(0);
    expect(DEFAULT_CUT_OVERRIDES.centerOffset_mm.x).toBe(0);
    expect(DEFAULT_CUT_OVERRIDES.centerOffset_mm.z).toBe(0);
  });

  test('default snapshot is frozen (including nested centerOffset_mm)', () => {
    expect(Object.isFrozen(DEFAULT_CUT_OVERRIDES)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CUT_OVERRIDES.centerOffset_mm)).toBe(true);
  });
});

describe('createCutOverridesStore — defaults', () => {
  test('get() returns defaults for a fresh store', () => {
    const store = createCutOverridesStore();
    expect(store.get()).toEqual(DEFAULT_CUT_OVERRIDES);
    expect(store.isAtDefaults()).toBe(true);
  });
});

describe('createCutOverridesStore — setRotation', () => {
  test('stores the value when within [0, 360)', () => {
    const store = createCutOverridesStore();
    store.setRotation(45);
    expect(store.get().rotation_deg).toBe(45);
    expect(store.isAtDefaults()).toBe(false);
  });

  test('normalises values > 360', () => {
    const store = createCutOverridesStore();
    store.setRotation(370);
    expect(store.get().rotation_deg).toBe(10);
  });

  test('normalises negative values', () => {
    const store = createCutOverridesStore();
    store.setRotation(-45);
    expect(store.get().rotation_deg).toBe(315);
  });

  test('normalises exactly 360 to 0', () => {
    const store = createCutOverridesStore();
    store.setRotation(360);
    expect(store.get().rotation_deg).toBe(0);
    expect(store.isAtDefaults()).toBe(true);
  });

  test('NaN / non-finite collapses to 0', () => {
    const store = createCutOverridesStore();
    store.setRotation(NaN);
    expect(store.get().rotation_deg).toBe(0);
    store.setRotation(Number.POSITIVE_INFINITY);
    expect(store.get().rotation_deg).toBe(0);
  });

  test('does not notify when the normalised value is unchanged', () => {
    const store = createCutOverridesStore();
    const spy = vi.fn();
    store.subscribe(spy);

    store.setRotation(30);
    expect(spy).toHaveBeenCalledTimes(1);

    // 390 normalises to 30 — no transition.
    store.setRotation(390);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('createCutOverridesStore — setCenterOffset', () => {
  test('stores x and z', () => {
    const store = createCutOverridesStore();
    store.setCenterOffset(5, -3);
    const snap = store.get();
    expect(snap.centerOffset_mm.x).toBe(5);
    expect(snap.centerOffset_mm.z).toBe(-3);
    expect(store.isAtDefaults()).toBe(false);
  });

  test('NaN x or z collapses to 0', () => {
    const store = createCutOverridesStore();
    store.setCenterOffset(NaN, 5);
    expect(store.get().centerOffset_mm.x).toBe(0);
    expect(store.get().centerOffset_mm.z).toBe(5);
  });

  test('does not notify when the value is unchanged', () => {
    const store = createCutOverridesStore();
    const spy = vi.fn();
    store.subscribe(spy);

    store.setCenterOffset(2, 4);
    expect(spy).toHaveBeenCalledTimes(1);
    store.setCenterOffset(2, 4);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('createCutOverridesStore — reset', () => {
  test('restores both fields to defaults and fires once', () => {
    const store = createCutOverridesStore();
    store.setRotation(90);
    store.setCenterOffset(5, 5);

    const spy = vi.fn();
    store.subscribe(spy);

    store.reset();

    expect(store.get()).toEqual(DEFAULT_CUT_OVERRIDES);
    expect(store.isAtDefaults()).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('reset() on a store already at defaults is a no-op', () => {
    const store = createCutOverridesStore();
    const spy = vi.fn();
    store.subscribe(spy);

    store.reset();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('createCutOverridesStore — subscribe', () => {
  test('listener receives the new snapshot', () => {
    const store = createCutOverridesStore();
    const received: number[] = [];
    store.subscribe((v) => {
      received.push(v.rotation_deg);
    });

    store.setRotation(45);
    store.setRotation(90);
    expect(received).toEqual([45, 90]);
  });

  test('unsubscribe actually detaches', () => {
    const store = createCutOverridesStore();
    const spy = vi.fn();
    const unsub = store.subscribe(spy);

    store.setRotation(10);
    expect(spy).toHaveBeenCalledTimes(1);

    unsub();
    store.setRotation(20);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('a throwing subscriber does not break other subscribers', () => {
    const store = createCutOverridesStore();
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* swallow */
    });

    store.subscribe(bad);
    store.subscribe(good);
    store.setRotation(45);

    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});

describe('createCutOverridesStore — snapshot is frozen', () => {
  test('get() snapshot and its nested centerOffset_mm are frozen', () => {
    const store = createCutOverridesStore();
    store.setRotation(30);
    const snap = store.get();
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.centerOffset_mm)).toBe(true);
  });
});
