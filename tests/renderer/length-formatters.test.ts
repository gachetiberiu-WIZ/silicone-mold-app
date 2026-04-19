// tests/renderer/length-formatters.test.ts
//
// Unit tests for `formatLength` / `parseLength`. Complementary to
// `tests/renderer/formatters.test.ts`, which covers `formatVolume`.
//
// These functions sit on the mm ↔ inches display boundary for parameter
// form inputs. Internal values are always mm; the formatters only exist
// to present mm in inches without losing round-trip precision.

import { describe, expect, test } from 'vitest';

import {
  LENGTH_ROUND_TRIP_ABS_TOL_MM,
  formatLength,
  parseLength,
} from '@/renderer/ui/formatters';

describe('formatLength', () => {
  test('mm → 1 decimal, no grouping', () => {
    expect(formatLength(10, 'mm')).toBe('10.0');
    expect(formatLength(1.5, 'mm')).toBe('1.5');
    expect(formatLength(1234.5, 'mm')).toBe('1234.5');
  });

  test('inches → 3 decimals', () => {
    // 25.4 mm is exactly 1 inch.
    expect(formatLength(25.4, 'in')).toBe('1.000');
    // 12.7 mm is exactly 0.5 inch.
    expect(formatLength(12.7, 'in')).toBe('0.500');
    // 0 mm → 0 inches → "0.000"
    expect(formatLength(0, 'in')).toBe('0.000');
  });

  test('non-finite values → empty string (defensive)', () => {
    expect(formatLength(Number.NaN, 'mm')).toBe('');
    expect(formatLength(Number.POSITIVE_INFINITY, 'in')).toBe('');
  });

  test('negative values are preserved (no sign normalisation here)', () => {
    expect(formatLength(-3, 'mm')).toBe('-3.0');
    expect(formatLength(-25.4, 'in')).toBe('-1.000');
  });
});

describe('parseLength', () => {
  test('empty / whitespace / junk → NaN', () => {
    expect(parseLength('', 'mm')).toBeNaN();
    expect(parseLength('   ', 'mm')).toBeNaN();
    expect(parseLength('abc', 'mm')).toBeNaN();
  });

  test('mm pass-through', () => {
    expect(parseLength('10', 'mm')).toBe(10);
    expect(parseLength('10.5', 'mm')).toBe(10.5);
  });

  test('inches → mm', () => {
    // 1 inch → 25.4 mm exactly.
    expect(parseLength('1', 'in')).toBeCloseTo(25.4, 6);
    expect(parseLength('0.5', 'in')).toBeCloseTo(12.7, 6);
  });

  test('comma → dot normalisation (accepts European decimal)', () => {
    expect(parseLength('10,5', 'mm')).toBe(10.5);
    expect(parseLength('0,5', 'in')).toBeCloseTo(12.7, 6);
  });

  test('leading / trailing whitespace is trimmed', () => {
    expect(parseLength('  10.0  ', 'mm')).toBe(10);
  });
});

describe('formatLength / parseLength round-trip', () => {
  test('mm → mm round-trip is exact within 1 decimal of precision', () => {
    const values = [0, 0.5, 1, 6, 10, 15, 25, 100, 1234.5];
    for (const v of values) {
      const s = formatLength(v, 'mm');
      const parsed = parseLength(s, 'mm');
      expect(parsed).toBeCloseTo(v, 1);
    }
  });

  test('mm → in → mm round-trip preserves value within 3-decimal-inch precision', () => {
    // 3-decimal inches resolves 0.001" = 0.0254 mm. Round-tripping an mm
    // value through formatLength(in) → parseLength(in) can therefore drift
    // by up to ±0.0127 mm (half the inch ULP). We assert inside that bound.
    const INCH_ULP_MM = 25.4 / 1000;
    const MAX_DRIFT_MM = INCH_ULP_MM / 2 + 1e-9;
    const values = [6, 10, 15, 25, 1, 1.5, 5];
    for (const mm of values) {
      const displayed = formatLength(mm, 'in');
      const roundTripped = parseLength(displayed, 'in');
      expect(Math.abs(roundTripped - mm)).toBeLessThanOrEqual(MAX_DRIFT_MM);
    }
  });

  test('1 in round-trip is exactly 25.4 mm within tolerance', () => {
    // The assertion the issue spec calls out by name:
    //   formatLength(25.4, 'in') === "1.000"
    //   parseLength("1", 'in') === 25.4 (1e-4 tolerance)
    expect(formatLength(25.4, 'in')).toBe('1.000');
    expect(Math.abs(parseLength('1', 'in') - 25.4)).toBeLessThan(
      LENGTH_ROUND_TRIP_ABS_TOL_MM,
    );
  });
});
