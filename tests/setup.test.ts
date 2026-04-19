// tests/setup.test.ts
//
// Dedicated unit tests for the `toEqualWithTolerance` custom matcher. Covers
// array, nested-object, typed-array, vector-like, and mixed-tolerance cases.
// This file is the safety net for the matcher itself — every geometry test in
// the suite depends on it behaving correctly.

import { describe, expect, test } from 'vitest';

describe('toEqualWithTolerance — numeric primitives', () => {
  test('accepts exact equality', () => {
    expect(1.0).toEqualWithTolerance(1.0);
  });

  test('accepts values inside absolute tolerance', () => {
    expect(1.0 + 5e-7).toEqualWithTolerance(1.0, { abs: 1e-6 });
  });

  test('rejects values outside absolute tolerance', () => {
    expect(() =>
      expect(1.0 + 2e-6).toEqualWithTolerance(1.0, { abs: 1e-6 }),
    ).toThrow(/toEqualWithTolerance/);
  });

  test('handles NaN vs NaN as equal', () => {
    expect(Number.NaN).toEqualWithTolerance(Number.NaN);
  });

  test('handles +Infinity vs +Infinity as equal', () => {
    expect(Infinity).toEqualWithTolerance(Infinity);
  });

  test('rejects +Infinity vs -Infinity', () => {
    expect(() => expect(Infinity).toEqualWithTolerance(-Infinity)).toThrow();
  });
});

describe('toEqualWithTolerance — arrays', () => {
  test('accepts element-wise near-equality', () => {
    expect([1, 2, 3]).toEqualWithTolerance([1 + 1e-8, 2, 3 - 1e-8], { abs: 1e-6 });
  });

  test('rejects length mismatches up front', () => {
    expect(() => expect([1, 2]).toEqualWithTolerance([1, 2, 3])).toThrow(
      /array length/,
    );
  });

  test('works on typed arrays like Float32Array', () => {
    const a = new Float32Array([0.1, 0.2, 0.3]);
    const b = [0.1, 0.2, 0.3];
    expect(a).toEqualWithTolerance(b, { abs: 1e-6 });
  });

  test('reports the first mismatching index with a path', () => {
    try {
      expect([1, 2, 3.5]).toEqualWithTolerance([1, 2, 3], { abs: 1e-6 });
      throw new Error('expected matcher to throw');
    } catch (err) {
      expect(String(err)).toMatch(/\[2\]/);
    }
  });
});

describe('toEqualWithTolerance — nested objects', () => {
  test('accepts nested numeric values within tolerance', () => {
    expect({ a: 1 + 1e-7, b: { c: 2 - 1e-7 } }).toEqualWithTolerance(
      { a: 1, b: { c: 2 } },
      { abs: 1e-6 },
    );
  });

  test('accepts Box3-like shape with array min/max', () => {
    expect({
      min: [-0.5 + 1e-8, -0.5, -0.5],
      max: [0.5, 0.5 - 1e-8, 0.5],
    }).toEqualWithTolerance(
      { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { abs: 1e-6 },
    );
  });

  test('accepts Vector3-like shape with x/y/z numeric keys', () => {
    expect({ x: 1 + 1e-8, y: 2, z: 3 - 1e-8 }).toEqualWithTolerance(
      { x: 1, y: 2, z: 3 },
      { abs: 1e-6 },
    );
  });

  test('rejects extra keys on the actual side', () => {
    expect(() =>
      expect({ x: 1, y: 2, z: 3, extra: 4 }).toEqualWithTolerance({
        x: 1,
        y: 2,
        z: 3,
      }),
    ).toThrow(/extra key/);
  });

  test('rejects missing keys on the actual side', () => {
    expect(() =>
      expect({ x: 1, y: 2 }).toEqualWithTolerance({ x: 1, y: 2, z: 3 }),
    ).toThrow(/missing key/);
  });
});

describe('toEqualWithTolerance — mixed tolerance', () => {
  test('relative tolerance kicks in for large values', () => {
    // Volume in mm³ spanning 10^4: absolute 1e-6 is useless; use rel=1e-4.
    expect(12345.0 + 0.5).toEqualWithTolerance(12345.0, { abs: 1e-6, rel: 1e-4 });
  });

  test('absolute tolerance wins for small values', () => {
    // For values near zero, rel * |expected| collapses — abs is the real floor.
    expect(1e-9).toEqualWithTolerance(0, { abs: 1e-6, rel: 1e-4 });
  });

  test('neither tolerance satisfied → fail', () => {
    expect(() =>
      expect(1.0 + 1e-3).toEqualWithTolerance(1.0, { abs: 1e-6, rel: 1e-6 }),
    ).toThrow();
  });

  test('default tolerance is abs=1e-6 when no options passed', () => {
    expect(1.0 + 5e-7).toEqualWithTolerance(1.0);
  });
});
