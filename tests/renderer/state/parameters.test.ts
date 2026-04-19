// tests/renderer/state/parameters.test.ts
//
// Unit tests for the parameter store. Covers:
//
//   1. Defaults match the research doc (docs/research/molding-techniques.md §6,
//      APPROVED 2026-04-18) — guards against a drift where the table in
//      issue #31 is silently re-applied.
//   2. `update()` emits the new snapshot to subscribers; repeated updates
//      with unchanged values are no-ops.
//   3. `reset()` restores every field to the default and emits.
//   4. `subscribe()` returns an unsubscribe function that actually detaches.
//   5. `isAtDefaults()` tracks the edit state used by the "Reset" button.
//   6. The snapshot is frozen — mutating it does not change the store.

import { describe, expect, test, vi } from 'vitest';

import {
  DEFAULT_PARAMETERS,
  KEY_STYLE_OPTIONS,
  NUMERIC_CONSTRAINTS,
  SIDE_COUNT_OPTIONS,
  createParametersStore,
  type MoldParameters,
} from '@/renderer/state/parameters';

describe('DEFAULT_PARAMETERS', () => {
  test('matches molding-techniques.md §6 recommendation', () => {
    expect(DEFAULT_PARAMETERS).toEqual({
      wallThickness_mm: 10,
      baseThickness_mm: 5,
      sideCount: 4,
      sprueDiameter_mm: 5,
      ventDiameter_mm: 1.5,
      ventCount: 2,
      registrationKeyStyle: 'asymmetric-hemi',
      draftAngle_deg: 0,
    });
  });

  test('is frozen (mutations rejected)', () => {
    expect(Object.isFrozen(DEFAULT_PARAMETERS)).toBe(true);
  });
});

describe('NUMERIC_CONSTRAINTS', () => {
  test('wallThickness range 6–25 mm per research doc', () => {
    expect(NUMERIC_CONSTRAINTS.wallThickness_mm).toMatchObject({
      min: 6,
      max: 25,
      integer: false,
    });
  });

  test('baseThickness range 2–15 mm per research doc', () => {
    expect(NUMERIC_CONSTRAINTS.baseThickness_mm).toMatchObject({
      min: 2,
      max: 15,
      integer: false,
    });
  });

  test('sprueDiameter range 3–8 mm per research doc', () => {
    expect(NUMERIC_CONSTRAINTS.sprueDiameter_mm).toMatchObject({
      min: 3,
      max: 8,
      integer: false,
    });
  });

  test('ventDiameter range 1–3 mm per research doc', () => {
    expect(NUMERIC_CONSTRAINTS.ventDiameter_mm).toMatchObject({
      min: 1,
      max: 3,
      integer: false,
    });
  });

  test('ventCount is integer, range 0–8 (research doc silent; issue default)', () => {
    expect(NUMERIC_CONSTRAINTS.ventCount).toMatchObject({
      min: 0,
      max: 8,
      integer: true,
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

describe('SIDE_COUNT_OPTIONS / KEY_STYLE_OPTIONS', () => {
  test('side count options are exactly 2, 3, 4', () => {
    expect([...SIDE_COUNT_OPTIONS]).toEqual([2, 3, 4]);
  });

  test('key style options are the three locked enum values', () => {
    expect([...KEY_STYLE_OPTIONS]).toEqual([
      'asymmetric-hemi',
      'cone',
      'keyhole',
    ]);
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
      wallThickness_mm: 8,
      sideCount: 2,
    });
    expect(store.get().wallThickness_mm).toBe(8);
    expect(store.get().sideCount).toBe(2);
    expect(store.get().baseThickness_mm).toBe(
      DEFAULT_PARAMETERS.baseThickness_mm,
    );
    expect(store.isAtDefaults()).toBe(false);
  });

  test('update() triggers subscriber with new snapshot', () => {
    const store = createParametersStore();
    const spy = vi.fn((_p: Readonly<MoldParameters>) => undefined);
    store.subscribe(spy);

    store.update({ wallThickness_mm: 7 });

    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0];
    expect(call).toBeDefined();
    const snapshot = call![0]!;
    expect(snapshot.wallThickness_mm).toBe(7);
    expect(store.get().wallThickness_mm).toBe(7);
    expect(store.isAtDefaults()).toBe(false);
  });

  test('update() with unchanged values is a no-op (no listener fire)', () => {
    const store = createParametersStore();
    const spy = vi.fn();
    store.subscribe(spy);

    // wallThickness defaults to 10; setting it to 10 is a no-op.
    store.update({ wallThickness_mm: DEFAULT_PARAMETERS.wallThickness_mm });
    expect(spy).not.toHaveBeenCalled();
  });

  test('reset() restores every field to defaults and emits', () => {
    const store = createParametersStore({
      wallThickness_mm: 7,
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

    store.update({ wallThickness_mm: 12 });
    expect(spy).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.update({ wallThickness_mm: 14 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('the snapshot returned by get() is frozen', () => {
    const store = createParametersStore();
    const snap = store.get();
    expect(Object.isFrozen(snap)).toBe(true);
    // Attempting to mutate throws in strict mode (Vitest runs ESM strict).
    expect(() => {
      // @ts-expect-error — intentionally testing the freeze contract.
      snap.wallThickness_mm = 42;
    }).toThrow();
    // State itself is unchanged.
    expect(store.get().wallThickness_mm).toBe(
      DEFAULT_PARAMETERS.wallThickness_mm,
    );
  });

  test('a throwing subscriber does not break other subscribers', () => {
    const store = createParametersStore();
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    // Suppress the console.error surface while we exercise the bad listener.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* swallow */
    });
    store.subscribe(bad);
    store.subscribe(good);

    store.update({ wallThickness_mm: 11 });

    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});
