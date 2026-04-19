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
 * @param mm3  Volume in mm³, or `null` for the "no master loaded" state.
 * @param unit The unit system to render — 'mm' → "X mm³", 'in' → "Y in³".
 *
 * @returns    Human-readable, locale-formatted string. Never throws.
 */
export function formatVolume(mm3: number | null, unit: UnitSystem): string {
  if (mm3 === null || !Number.isFinite(mm3)) {
    return t('volume.none');
  }

  if (unit === 'in') {
    const in3 = mm3 / MM3_PER_IN3;
    return `${IN3_FORMATTER.format(in3)} in\u00B3`;
  }

  // Default / mm branch.
  return `${MM3_FORMATTER.format(mm3)} mm\u00B3`;
}
