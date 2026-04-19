// tests/setup.ts
//
// Vitest global setup — registers project-wide custom matchers.
//
// `toEqualWithTolerance(expected, { abs?, rel? })` is the primary
// geometry/numeric comparator. It recurses into:
//   - numbers (direct abs/rel comparison)
//   - plain objects (key-by-key)
//   - arrays / typed arrays (element-by-element, same length)
//   - Vector-like shapes `{x, y, z, [w]}`
//   - Box3-like shapes `{ min: [..], max: [..] }`
//
// Non-numeric primitives fall back to strict equality. Missing/extra keys
// are reported with a path-qualified message so geometry diffs are readable.
//
// Defaults: `abs = 1e-6 mm` per ADR-003 §"Units, tolerances, conventions".
//           `rel` defaults to 0 (pure absolute comparison) unless supplied.

import { expect } from 'vitest';

export interface ToleranceOptions {
  /** Absolute tolerance. Default 1e-6. */
  abs?: number;
  /** Relative tolerance (fraction of |expected|). Default 0. */
  rel?: number;
}

type Path = (string | number)[];

const DEFAULT_ABS = 1e-6;
const DEFAULT_REL = 0;

/** Human-readable path like `.min[0]` or `.bbox.max.x`. */
function fmtPath(path: Path): string {
  if (path.length === 0) return '<root>';
  return path
    .map((seg) => (typeof seg === 'number' ? `[${seg}]` : `.${seg}`))
    .join('');
}

function isTypedArray(v: unknown): v is ArrayLike<number> {
  return (
    ArrayBuffer.isView(v) &&
    !(v instanceof DataView) &&
    typeof (v as { length?: number }).length === 'number'
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === null || proto === Object.prototype;
}

interface CompareResult {
  ok: boolean;
  /** First mismatch; undefined when ok === true. */
  failure?: {
    path: Path;
    actual: unknown;
    expected: unknown;
    reason: string;
  };
}

function numbersClose(
  actual: number,
  expected: number,
  abs: number,
  rel: number,
): boolean {
  if (Number.isNaN(actual) && Number.isNaN(expected)) return true;
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) {
    return actual === expected;
  }
  const diff = Math.abs(actual - expected);
  const tol = Math.max(abs, rel * Math.abs(expected));
  return diff <= tol;
}

function compare(
  actual: unknown,
  expected: unknown,
  abs: number,
  rel: number,
  path: Path = [],
): CompareResult {
  // Number-vs-number: numeric tolerance.
  if (typeof expected === 'number' && typeof actual === 'number') {
    if (numbersClose(actual, expected, abs, rel)) return { ok: true };
    return {
      ok: false,
      failure: {
        path,
        actual,
        expected,
        reason: `expected ${expected} ± (abs ${abs} | rel ${rel}), got ${actual}`,
      },
    };
  }

  // Typed arrays + regular arrays.
  const expectedIsArrayLike = Array.isArray(expected) || isTypedArray(expected);
  const actualIsArrayLike = Array.isArray(actual) || isTypedArray(actual);
  if (expectedIsArrayLike && actualIsArrayLike) {
    const e = expected as ArrayLike<unknown>;
    const a = actual as ArrayLike<unknown>;
    if (a.length !== e.length) {
      return {
        ok: false,
        failure: {
          path,
          actual: a.length,
          expected: e.length,
          reason: `array length mismatch: expected ${e.length}, got ${a.length}`,
        },
      };
    }
    for (let i = 0; i < e.length; i++) {
      const sub = compare(a[i], e[i], abs, rel, [...path, i]);
      if (!sub.ok) return sub;
    }
    return { ok: true };
  }

  // Plain objects (incl. Vector-like, Box3-like). Key-by-key.
  if (isPlainObject(expected) && isPlainObject(actual)) {
    const eKeys = Object.keys(expected).sort();
    const aKeys = Object.keys(actual).sort();
    // Surface extra/missing keys as a clear failure before recursing.
    for (const k of eKeys) {
      if (!(k in actual)) {
        return {
          ok: false,
          failure: {
            path: [...path, k],
            actual: undefined,
            expected: expected[k],
            reason: `missing key \`${k}\``,
          },
        };
      }
    }
    for (const k of aKeys) {
      if (!(k in expected)) {
        return {
          ok: false,
          failure: {
            path: [...path, k],
            actual: actual[k],
            expected: undefined,
            reason: `unexpected extra key \`${k}\``,
          },
        };
      }
    }
    for (const k of eKeys) {
      const sub = compare(actual[k], expected[k], abs, rel, [...path, k]);
      if (!sub.ok) return sub;
    }
    return { ok: true };
  }

  // Fallback: strict equality (covers strings, booleans, null, undefined,
  // mismatched shapes like number-vs-array, class instances, etc.).
  if (Object.is(actual, expected)) return { ok: true };
  return {
    ok: false,
    failure: {
      path,
      actual,
      expected,
      reason: `strict-equality mismatch (${typeof actual} vs ${typeof expected})`,
    },
  };
}

expect.extend({
  toEqualWithTolerance(
    received: unknown,
    expected: unknown,
    options: ToleranceOptions = {},
  ) {
    const abs = options.abs ?? DEFAULT_ABS;
    const rel = options.rel ?? DEFAULT_REL;
    const result = compare(received, expected, abs, rel);

    if (result.ok) {
      return {
        pass: true,
        message: () =>
          `expected values to differ beyond tolerance (abs=${abs}, rel=${rel})`,
      };
    }

    const f = result.failure!;
    const where = fmtPath(f.path);
    return {
      pass: false,
      message: () =>
        [
          `toEqualWithTolerance failed at \`${where}\` (abs=${abs}, rel=${rel}):`,
          `  ${f.reason}`,
          `  expected: ${JSON.stringify(f.expected)}`,
          `  received: ${JSON.stringify(f.actual)}`,
        ].join('\n'),
    };
  },
});

// Ambient augmentation so tests get typed access.
interface ToleranceMatchers<R = unknown> {
  toEqualWithTolerance(expected: unknown, options?: ToleranceOptions): R;
}

declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Assertion<T = any> extends ToleranceMatchers<T> {}
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface AsymmetricMatchersContaining extends ToleranceMatchers {}
}
