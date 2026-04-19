// tests/renderer/formatters.test.ts
//
// Unit tests for the topbar volume formatter. These pin the exact output
// strings so any change in rounding or locale grouping is caught in CI.
//
// Locale policy (mirrors the comment block at the top of
// `src/renderer/ui/formatters.ts`):
//
//   - `Intl.NumberFormat('en-US')` is the single locale used for this
//     formatter. Thousands separator is the comma (U+002C).
//   - The issue #17 body suggested "12 345 mm³" with a space as a sample;
//     we use comma grouping per the issue's "locale-appropriate US
//     grouping — document if different" escape hatch. Documented here and
//     in the PR body.
//   - mm: integer (maximumFractionDigits = 0).
//   - in: three decimals (minimum = maximum = 3 fraction digits).
//   - Conversion: 1 in³ = 25.4^3 mm³ = 16 387.064 mm³.

import { describe, expect, test } from 'vitest';

import { formatVolume } from '@/renderer/ui/formatters';

describe('formatVolume', () => {
  test('null → localised "No master loaded"', () => {
    expect(formatVolume(null, 'mm')).toBe('No master loaded');
    expect(formatVolume(null, 'in')).toBe('No master loaded');
  });

  test('NaN / Infinity → localised "No master loaded"', () => {
    expect(formatVolume(Number.NaN, 'mm')).toBe('No master loaded');
    expect(formatVolume(Number.POSITIVE_INFINITY, 'mm')).toBe('No master loaded');
  });

  test('1 mm³ → "1 mm³"', () => {
    expect(formatVolume(1, 'mm')).toBe('1 mm\u00B3');
  });

  test('12345 mm³ → "12,345 mm³" (en-US grouping)', () => {
    // en-US uses U+002C (comma). See header comment for the rationale.
    expect(formatVolume(12345, 'mm')).toBe('12,345 mm\u00B3');
  });

  test('127451.6 mm³ → "127,452 mm³" (rounded to nearest int)', () => {
    expect(formatVolume(127451.6, 'mm')).toBe('127,452 mm\u00B3');
  });

  test('1 mm³ → inches is ≈ 6.1e-5 in³ → "0.000 in³"', () => {
    expect(formatVolume(1, 'in')).toBe('0.000 in\u00B3');
  });

  test('16387 mm³ → inches is ≈ 1 in³ → "1.000 in³"', () => {
    // 16 387 mm³ / 16 387.064 mm³/in³ ≈ 0.99999609… → rounds to "1.000"
    expect(formatVolume(16387, 'in')).toBe('1.000 in\u00B3');
  });

  test('exact 16387.064 mm³ → "1.000 in³"', () => {
    expect(formatVolume(16387.064, 'in')).toBe('1.000 in\u00B3');
  });

  test('negative volume renders without crashing (defensive)', () => {
    // Volumes should never be negative in practice, but we don't want a
    // runtime crash in the UI if a caller passes a signed value.
    expect(formatVolume(-1, 'mm')).toBe('-1 mm\u00B3');
  });
});
