// tests/smoke.test.ts
//
// Minimal smoke test — proves the Vitest pipeline is wired and the
// `toEqualWithTolerance` custom matcher is registered via `tests/setup.ts`.
// A second, intentionally-failing-then-skipped block demonstrates the
// matcher's error output without actually failing CI.

import { describe, expect, test } from 'vitest';

describe('smoke — vitest + custom matcher wiring', () => {
  test('toEqualWithTolerance passes on nearly-equal arrays', () => {
    expect([1.0 + 1e-8, 2.0, 3.0]).toEqualWithTolerance([1, 2, 3], { abs: 1e-6 });
  });

  test('toEqualWithTolerance passes on nested Box3-like objects', () => {
    const actual = {
      min: [-0.5 + 1e-7, -0.5, -0.5],
      max: [0.5, 0.5, 0.5 - 1e-7],
    };
    expect(actual).toEqualWithTolerance(
      { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { abs: 1e-6 },
    );
  });

  // Skipped intentionally — kept so a reader can see the matcher's failure
  // output by un-skipping locally. Never un-skip in committed code.
  test.skip('toEqualWithTolerance fails loudly on out-of-tolerance mismatch', () => {
    expect([1, 2, 3.5]).toEqualWithTolerance([1, 2, 3], { abs: 1e-6 });
  });
});
