// tests/renderer/state/dimensions.test.ts
//
// Unit tests for the Dimensions state slice (issue #79). Covers:
//
//   1. Defaults + frozen snapshot shape.
//   2. `createDimensionsStore` API parity with `createParametersStore`
//      (get / update / reset / subscribe / isAtDefaults).
//   3. `applyAxisEdit` reducer — constrain ON propagates ratio to all
//      three axes; constrain OFF edits only the target; edge cases
//      (zero old value, non-finite new value).
//   4. `applyUniformScale` reducer — writes the same value to all three
//      axes, independent of the constrain flag.
//   5. `derivePercentScale` — geometric mean when non-uniform; trivial
//      scaleX×100 when uniform; degenerate 0 → 100 fallback.

import { describe, expect, test, vi } from 'vitest';

import {
  applyAxisEdit,
  applyUniformScale,
  AXIS_SCALE_MAX,
  AXIS_SCALE_MIN,
  createDimensionsStore,
  DEFAULT_DIMENSIONS,
  derivePercentScale,
  SCALE_PERCENT_MAX,
  SCALE_PERCENT_MIN,
  type Dimensions,
} from '@/renderer/state/dimensions';

describe('DEFAULT_DIMENSIONS', () => {
  test('matches the issue #79 spec: (1, 1, 1, constrain=true)', () => {
    expect(DEFAULT_DIMENSIONS).toEqual({
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
      constrainProportions: true,
    });
  });

  test('is frozen (mutations rejected)', () => {
    expect(Object.isFrozen(DEFAULT_DIMENSIONS)).toBe(true);
  });
});

describe('scale bounds', () => {
  test('percent range 10–1000 per issue spec', () => {
    expect(SCALE_PERCENT_MIN).toBe(10);
    expect(SCALE_PERCENT_MAX).toBe(1000);
  });

  test('axis scale = percent / 100', () => {
    expect(AXIS_SCALE_MIN).toBeCloseTo(0.1, 10);
    expect(AXIS_SCALE_MAX).toBeCloseTo(10, 10);
  });
});

describe('createDimensionsStore', () => {
  test('get() returns defaults for a fresh store', () => {
    const store = createDimensionsStore();
    expect(store.get()).toEqual(DEFAULT_DIMENSIONS);
    expect(store.isAtDefaults()).toBe(true);
  });

  test('initial overrides merge shallowly over defaults', () => {
    const store = createDimensionsStore({
      scaleX: 2,
      constrainProportions: false,
    });
    expect(store.get().scaleX).toBe(2);
    expect(store.get().scaleY).toBe(1);
    expect(store.get().constrainProportions).toBe(false);
    expect(store.isAtDefaults()).toBe(false);
  });

  test('update() triggers subscriber with new snapshot', () => {
    const store = createDimensionsStore();
    const spy = vi.fn((_d: Readonly<Dimensions>) => undefined);
    store.subscribe(spy);

    store.update({ scaleX: 2 });

    expect(spy).toHaveBeenCalledTimes(1);
    const snapshot = spy.mock.calls[0]![0]!;
    expect(snapshot.scaleX).toBe(2);
    expect(store.get().scaleX).toBe(2);
    expect(store.isAtDefaults()).toBe(false);
  });

  test('update() with unchanged values is a no-op', () => {
    const store = createDimensionsStore();
    const spy = vi.fn();
    store.subscribe(spy);

    store.update({ scaleX: DEFAULT_DIMENSIONS.scaleX });
    expect(spy).not.toHaveBeenCalled();
  });

  test('reset() restores every field and emits', () => {
    const store = createDimensionsStore({ scaleX: 3, constrainProportions: false });
    const spy = vi.fn();
    store.subscribe(spy);

    store.reset();

    expect(store.get()).toEqual(DEFAULT_DIMENSIONS);
    expect(store.isAtDefaults()).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('reset() on an at-defaults store is a no-op', () => {
    const store = createDimensionsStore();
    const spy = vi.fn();
    store.subscribe(spy);
    store.reset();
    expect(spy).not.toHaveBeenCalled();
  });

  test('subscribe() returns an unsubscribe that actually detaches', () => {
    const store = createDimensionsStore();
    const spy = vi.fn();
    const unsub = store.subscribe(spy);

    store.update({ scaleX: 1.5 });
    expect(spy).toHaveBeenCalledTimes(1);

    unsub();
    store.update({ scaleX: 2 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('get() returns a frozen snapshot', () => {
    const store = createDimensionsStore();
    const snap = store.get();
    expect(Object.isFrozen(snap)).toBe(true);
    expect(() => {
      // @ts-expect-error intentional freeze-contract probe.
      snap.scaleX = 42;
    }).toThrow();
    expect(store.get().scaleX).toBe(DEFAULT_DIMENSIONS.scaleX);
  });

  test('a throwing subscriber does not break other subscribers', () => {
    const store = createDimensionsStore();
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* swallow */
    });
    store.subscribe(bad);
    store.subscribe(good);

    store.update({ scaleX: 1.25 });

    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});

describe('applyAxisEdit (constrain ON)', () => {
  const uniform: Readonly<Dimensions> = Object.freeze({
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    constrainProportions: true,
  });

  test('editing scaleX 1 → 2 scales all three axes by 2', () => {
    const next = applyAxisEdit(uniform, 'scaleX', 2);
    expect(next.scaleX).toBeCloseTo(2, 10);
    expect(next.scaleY).toBeCloseTo(2, 10);
    expect(next.scaleZ).toBeCloseTo(2, 10);
  });

  test('non-uniform base preserved by constrain propagation', () => {
    // Aspect ratio 2:1:4. Edit scaleY 1 → 3 → ratio 3 → new tuple (6, 3, 12).
    const base: Readonly<Dimensions> = Object.freeze({
      scaleX: 2,
      scaleY: 1,
      scaleZ: 4,
      constrainProportions: true,
    });
    const next = applyAxisEdit(base, 'scaleY', 3);
    expect(next.scaleX).toBeCloseTo(6, 10);
    expect(next.scaleY).toBeCloseTo(3, 10);
    expect(next.scaleZ).toBeCloseTo(12, 10);
  });

  test('preserves the constrainProportions flag', () => {
    const next = applyAxisEdit(uniform, 'scaleX', 0.5);
    expect(next.constrainProportions).toBe(true);
  });
});

describe('applyAxisEdit (constrain OFF)', () => {
  const base: Readonly<Dimensions> = Object.freeze({
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    constrainProportions: false,
  });

  test('editing scaleX leaves scaleY and scaleZ untouched', () => {
    const next = applyAxisEdit(base, 'scaleX', 3);
    expect(next.scaleX).toBe(3);
    expect(next.scaleY).toBe(1);
    expect(next.scaleZ).toBe(1);
  });

  test('editing scaleZ leaves scaleX and scaleY untouched', () => {
    const next = applyAxisEdit(base, 'scaleZ', 0.25);
    expect(next.scaleX).toBe(1);
    expect(next.scaleY).toBe(1);
    expect(next.scaleZ).toBe(0.25);
  });
});

describe('applyAxisEdit edge cases', () => {
  const uniform: Readonly<Dimensions> = Object.freeze({
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    constrainProportions: true,
  });

  test('non-finite newValue is a no-op', () => {
    const next = applyAxisEdit(uniform, 'scaleX', Number.NaN);
    expect(next).toEqual(uniform);
  });

  test('zero oldValue prevents ratio propagation (guards div-by-zero)', () => {
    const broken: Readonly<Dimensions> = Object.freeze({
      ...uniform,
      scaleX: 0,
    });
    const next = applyAxisEdit(broken, 'scaleX', 2);
    // Only scaleX changed; scaleY/Z untouched (constrain effectively OFF
    // for this one edit to avoid dividing by zero).
    expect(next.scaleX).toBe(2);
    expect(next.scaleY).toBe(1);
    expect(next.scaleZ).toBe(1);
  });
});

describe('applyUniformScale', () => {
  const nonUniform: Readonly<Dimensions> = Object.freeze({
    scaleX: 2,
    scaleY: 1,
    scaleZ: 3,
    constrainProportions: true,
  });

  test('writes the same scale to all three axes', () => {
    const next = applyUniformScale(nonUniform, 1.5);
    expect(next.scaleX).toBe(1.5);
    expect(next.scaleY).toBe(1.5);
    expect(next.scaleZ).toBe(1.5);
  });

  test('preserves the constrainProportions flag', () => {
    const next = applyUniformScale(nonUniform, 0.5);
    expect(next.constrainProportions).toBe(nonUniform.constrainProportions);
  });

  test('non-finite scale is a no-op', () => {
    const next = applyUniformScale(nonUniform, Number.NaN);
    expect(next).toEqual(nonUniform);
  });

  test('constrain-off tuple still writes uniform values', () => {
    const base: Readonly<Dimensions> = Object.freeze({
      scaleX: 2,
      scaleY: 1,
      scaleZ: 3,
      constrainProportions: false,
    });
    const next = applyUniformScale(base, 2);
    expect(next).toMatchObject({ scaleX: 2, scaleY: 2, scaleZ: 2, constrainProportions: false });
  });
});

describe('derivePercentScale', () => {
  test('uniform 1.0 tuple → 100 %', () => {
    expect(derivePercentScale(DEFAULT_DIMENSIONS)).toBeCloseTo(100, 6);
  });

  test('uniform 2.0 tuple → 200 %', () => {
    expect(
      derivePercentScale({
        scaleX: 2,
        scaleY: 2,
        scaleZ: 2,
        constrainProportions: true,
      }),
    ).toBeCloseTo(200, 6);
  });

  test('non-uniform tuple returns geometric mean × 100', () => {
    // cbrt(2 × 1 × 4) × 100 = cbrt(8) × 100 = 200.
    const p = derivePercentScale({
      scaleX: 2,
      scaleY: 1,
      scaleZ: 4,
      constrainProportions: true,
    });
    expect(p).toBeCloseTo(200, 6);
  });

  test('degenerate zero scale falls back to 100 (avoids NaN/0 in UI)', () => {
    const p = derivePercentScale({
      scaleX: 0,
      scaleY: 1,
      scaleZ: 1,
      constrainProportions: true,
    });
    expect(p).toBe(100);
  });
});
