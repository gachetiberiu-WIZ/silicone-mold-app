// src/renderer/ui/formatters.ts
//
// Pure, side-effect-free formatters for user-visible numeric values.
//
// IMPORTANT: everything here is deterministic against the `en-US` locale.
// Per CLAUDE.md, internal units are mm throughout and inches is a *display*
// conversion — so both inputs to `formatVolume` are mm³, and we convert to
// in³ only for the inch output branch.
//
// Locale / grouping notes (pinned for tests and PR review):
//   - `Intl.NumberFormat('en-US')` groups thousands with a comma (U+002C),
//     e.g. 127 451.6 → "127,452" (rounded, maximumFractionDigits=0).
//   - The issue body spelled sample outputs with spaces ("12 345 mm³"),
//     which is how some locales (fr, fi, etc.) group. We use en-US comma
//     grouping because that is the locale ADR-003 pins for tests, and the
//     issue explicitly says "locale-appropriate US grouping — document if
//     different". The unit-tests under `tests/renderer/formatters.test.ts`
//     assert the comma form.
//
//   Conversion constant: 1 in = 25.4 mm → 1 in³ = 25.4^3 mm³ = 16 387.064 mm³.

import { t } from '../i18n';

export type UnitSystem = 'mm' | 'in';

/** mm³ per in³. Pinned so the conversion is trivially auditable. */
const MM3_PER_IN3 = 25.4 ** 3; // 16387.064

/** mm per in. The single source of truth for length conversion. */
const MM_PER_IN = 25.4;

/**
 * en-US integer formatter for mm³. Thousands grouped with comma, no decimals.
 * Rounds half-away-from-zero per `Intl.NumberFormat`'s default rounding mode
 * in V8 (which implements the ECMA-402 `"halfExpand"` default).
 */
const MM3_FORMATTER = new Intl.NumberFormat('en-US', {
  useGrouping: true,
  maximumFractionDigits: 0,
  minimumFractionDigits: 0,
});

/**
 * en-US decimal formatter for in³. 3 decimal places, no grouping (values
 * below 10 000 in³ never need grouping; above that the user has bigger
 * issues than a comma).
 */
const IN3_FORMATTER = new Intl.NumberFormat('en-US', {
  useGrouping: true,
  maximumFractionDigits: 3,
  minimumFractionDigits: 3,
});

/**
 * Format a volume for display in the topbar.
 *
 * @param mm3      Volume in mm³, or `null` for the empty state.
 * @param unit     The unit system to render — 'mm' → "X mm³", 'in' → "Y in³".
 * @param emptyKey i18n key to use for the empty-state placeholder. Defaults
 *                 to `'volume.none'` ("No master loaded"). Pass
 *                 `'volume.notGenerated'` for silicone / resin slots, where
 *                 a null value means "master loaded but not generated yet",
 *                 NOT "master missing".
 *
 * @returns    Human-readable, locale-formatted string. Never throws.
 */
export function formatVolume(
  mm3: number | null,
  unit: UnitSystem,
  emptyKey: string = 'volume.none',
): string {
  if (mm3 === null || !Number.isFinite(mm3)) {
    return t(emptyKey);
  }

  if (unit === 'in') {
    const in3 = mm3 / MM3_PER_IN3;
    return `${IN3_FORMATTER.format(in3)} in\u00B3`;
  }

  // Default / mm branch.
  return `${MM3_FORMATTER.format(mm3)} mm\u00B3`;
}

// ----------------------------------------------------------------------------
// Length formatters (parameter form).
//
// Unlike `formatVolume` (which is locale-grouped + unit-suffixed for a readout
// display), lengths are displayed inside <input type="number"> fields. Number
// inputs parse with `.` as the decimal separator and ignore grouping
// separators. So these functions deliberately produce:
//
//   - NO thousands separators (e.g. 1234.5 → "1234.5", NOT "1,234.5")
//   - NO unit suffix (the field renders the unit in a sibling label)
//   - Fixed decimal places per unit system: 1 for mm, 3 for inches
//     (0.05" ≈ 1.27 mm, so 3 decimal places covers the whole 2–25 mm range
//     without loss when a user flips mm→in→mm)
//
// Parsing is permissive: trims whitespace, accepts `,` or `.` as decimal
// separator (common in en-GB / de-DE locales even though we pin en-US for
// display). Returns NaN on anything unparseable — callers clamp NaN to the
// default, per issue #31 UX contract.
// ----------------------------------------------------------------------------

/** Tolerance for the `parseLength(formatLength(x, u), u) === x` round-trip in tests. */
export const LENGTH_ROUND_TRIP_ABS_TOL_MM = 1e-4;

/**
 * Format a length in mm for display in a number input.
 *
 * @param mm   Length in mm. Internal storage unit.
 * @param unit Active unit system. In `'mm'` returns the mm value with 1
 *             decimal; in `'in'` converts to inches and returns with 3
 *             decimals. No grouping separators. No unit suffix.
 *
 * @returns    Plain numeric string suitable for an `<input type="number">`
 *             `.value`, or empty string if `mm` is non-finite.
 */
export function formatLength(mm: number, unit: UnitSystem): string {
  if (!Number.isFinite(mm)) return '';
  if (unit === 'in') {
    const inches = mm / MM_PER_IN;
    return inches.toFixed(3);
  }
  return mm.toFixed(1);
}

/**
 * Parse a user-entered length string and return the value in mm.
 *
 * @param text Raw input text. Trimmed; accepts '.' or ',' as decimal.
 * @param unit Active unit system that the text is expressed in. If 'in',
 *             the numeric part is multiplied by 25.4 to reach mm.
 *
 * @returns    Length in mm, or NaN if the text cannot be parsed as a
 *             finite number. Negative values are permitted by the
 *             formatter (they round-trip cleanly) and left to range-
 *             checking at the field level — we don't clamp sign here.
 */
export function parseLength(text: string, unit: UnitSystem): number {
  if (typeof text !== 'string') return Number.NaN;
  const trimmed = text.trim();
  if (trimmed === '') return Number.NaN;
  // Normalise locale comma to dot before parsing. Avoids surprising the
  // German / French / Finnish / etc. users who reflexively type `6,35`.
  const normalised = trimmed.replace(',', '.');
  const n = Number(normalised);
  if (!Number.isFinite(n)) return Number.NaN;
  if (unit === 'in') return n * MM_PER_IN;
  return n;
}
