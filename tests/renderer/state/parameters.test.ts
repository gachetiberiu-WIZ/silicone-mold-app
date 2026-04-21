// tests/renderer/state/parameters.test.ts
//
// Unit tests for the parameter store. Post-#69 scope:
//
//   1. Defaults match the new Wave-B values: siliconeThickness_mm=5,
//      printShellThickness_mm=8, sideCount=4, draftAngle_deg=0.
//   2. Ranges match the new Wave-B values: silicone 1–15, shell 2–30.
//   3. `update()` emits the new snapshot to subscribers; repeated updates
//      with unchanged values are no-ops.
//   4. `reset()` restores every field to the default and emits.
//   5. `subscribe()` returns an unsubscribe function that actually detaches.
//   6. `isAtDefaults()` tracks the edit state used by the "Reset" button.
//   7. The snapshot is frozen — mutating it does not change the store.

import { describe, expect, test, vi } from 'vitest';

import {
  DEFAULT_PARAMETERS,
  NUMERIC_CONSTRAINTS,
  SIDE_COUNT_OPTIONS,
  createParametersStore,
  type MoldParameters,
} from '@/renderer/state/parameters';

describe('DEFAULT_PARAMETERS', () => {
  test('matches the post-#84 Wave-E+F defaults', () => {
    expect(DEFAULT_PARAMETERS).toEqual({
      siliconeThickness_mm: 5,
      printShellThickness_mm: 8,
      baseSlabThickness_mm: 8,
      baseSlabOverhang_mm: 5,
      brimWidth_mm: 10,
      brimThickness_mm: 3,
      sideCount: 4,
      draftAngle_deg: 0,
    });
  });

  test('is frozen (mutations rejected)', () => {
    expect(Object.isFrozen(DEFAULT_PARAMETERS)).toBe(true);
  });
});

describe('NUMERIC_CONSTRAINTS', () => {
  test('siliconeThickness range 1–15 mm (post-#69 widened)', () => {
    expect(NUMERIC_CONSTRAINTS.siliconeThickness_mm).toMatchObject({
      min: 1,
      max: 15,
      integer: false,
    });
  });

  test('printShellThickness range 2–30 mm (post-#69 widened)', () => {
    expect(NUMERIC_CONSTRAINTS.printShellThickness_mm).toMatchObject({
      min: 2,
      max: 30,
      integer: false,
    });
  });

  test('draftAngle range 0–3° per research doc', () => {
    expect(NUMERIC_CONSTRAINTS.draftAngle_deg).toMatchObject({
      min: 0,
      max: 3,
      integer: false,
    });
  });

  test('every default falls inside its own range', () => {
    // Guards against a future edit where the default drifts outside
    // the clamp range, which would make `reset()` look broken.
    (Object.keys(NUMERIC_CONSTRAINTS) as Array<keyof typeof NUMERIC_CONSTRAINTS>).forEach((k) => {
      const c = NUMERIC_CONSTRAINTS[k];
      const v = DEFAULT_PARAMETERS[k];
      expect(v).toBeGreaterThanOrEqual(c.min);
      expect(v).toBeLessThanOrEqual(c.max);
    });
  });
});

describe('SIDE_COUNT_OPTIONS', () => {
  test('side count options are exactly 2, 3, 4', () => {
    expect([...SIDE_COUNT_OPTIONS]).toEqual([2, 3, 4]);
  });
});

describe('createParametersStore', () => {
  test('get() returns defaults for a fresh store', () => {
    const store = createParametersStore();
    expect(store.get()).toEqual(DEFAULT_PARAMETERS);
    expect(store.isAtDefaults()).toBe(true);
  });

  test('initial overrides merge shallowly over defaults', () => {
    const store = createParametersStore({
      siliconeThickness_mm: 8,
      sideCount: 2,
    });
    expect(store.get().siliconeThickness_mm).toBe(8);
    expect(store.get().sideCount).toBe(2);
    expect(store.get().printShellThickness_mm).toBe(
      DEFAULT_PARAMETERS.printShellThickness_mm,
    );
    expect(store.isAtDefaults()).toBe(false);
  });

  test('update() triggers subscriber with new snapshot', () => {
    const store = createParametersStore();
    const spy = vi.fn((_p: Readonly<MoldParameters>) => undefined);
    store.subscribe(spy);

    store.update({ siliconeThickness_mm: 7 });

    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0];
    expect(call).toBeDefined();
    const snapshot = call![0]!;
    expect(snapshot.siliconeThickness_mm).toBe(7);
    expect(store.get().siliconeThickness_mm).toBe(7);
    expect(store.isAtDefaults()).toBe(false);
  });

  test('update() with unchanged values is a no-op (no listener fire)', () => {
    const store = createParametersStore();
    const spy = vi.fn();
    store.subscribe(spy);

    store.update({ siliconeThickness_mm: DEFAULT_PARAMETERS.siliconeThickness_mm });
    expect(spy).not.toHaveBeenCalled();
  });

  test('reset() restores every field to defaults and emits', () => {
    const store = createParametersStore({
      siliconeThickness_mm: 7,
      sideCount: 2,
      draftAngle_deg: 3,
    });
    expect(store.isAtDefaults()).toBe(false);

    const spy = vi.fn();
    store.subscribe(spy);

    store.reset();

    expect(store.get()).toEqual(DEFAULT_PARAMETERS);
    expect(store.isAtDefaults()).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('reset() on an at-defaults store is a no-op (no listener fire)', () => {
    const store = createParametersStore();
    const spy = vi.fn();
    store.subscribe(spy);
    store.reset();
    expect(spy).not.toHaveBeenCalled();
  });

  test('subscribe() returns an unsubscribe that actually detaches', () => {
    const store = createParametersStore();
    const spy = vi.fn();
    const unsubscribe = store.subscribe(spy);

    store.update({ siliconeThickness_mm: 12 });
    expect(spy).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.update({ siliconeThickness_mm: 14 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('the snapshot returned by get() is frozen', () => {
    const store = createParametersStore();
    const snap = store.get();
    expect(Object.isFrozen(snap)).toBe(true);
    expect(() => {
      // @ts-expect-error — intentionally testing the freeze contract.
      snap.siliconeThickness_mm = 42;
    }).toThrow();
    expect(store.get().siliconeThickness_mm).toBe(
      DEFAULT_PARAMETERS.siliconeThickness_mm,
    );
  });

  test('a throwing subscriber does not break other subscribers', () => {
    const store = createParametersStore();
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* swallow */
    });
    store.subscribe(bad);
    store.subscribe(good);

    store.update({ siliconeThickness_mm: 11 });

    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});
