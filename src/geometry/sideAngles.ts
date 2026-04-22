// src/geometry/sideAngles.ts
//
// Radial cut-angle table for the N-sided radial split of the print shell.
//
// Extracted from the (now-deleted) `src/geometry/printableBox.ts` as part of
// Wave C (issue #72) so Wave E's radial slicer can reuse the load-bearing
// angle values without resurrecting the rectangular-box module. The
// rectangular print-box pipeline is gone in Wave C; the surface-conforming
// shell in `generateMold.ts` does NOT consume this table (yet). Keep this
// file small and side-effect free — it's a pure-data module.
//
// The mapping is load-bearing for reproducibility of part layout:
//
//   - 4 sides: 45/135/225/315 — diagonals through corners; symmetric on a
//     square, mirror-pair-identical on a rectangle.
//   - 2 sides: 90/270 — cuts along +X/−X axis; long-axis pull-direction.
//   - 3 sides: 30/150/270 — 120° apart, asymmetric sizing acceptable for
//     v1 with a single-strategy rigid-shell + silicone-glove mold.
//
// Angles are measured in degrees, counter-clockwise from the +X axis
// (looking down the +Y axis — standard Three.js Y-up convention). The
// angles define the BOUNDARIES between sectors — side[i] occupies the
// arc between SIDE_CUT_ANGLES[sideCount][i] and
// SIDE_CUT_ANGLES[sideCount][(i+1) % sideCount], walking CCW.

/**
 * Radial cut angles (degrees, CCW from +X axis, looking down −Y) for each
 * supported `sideCount`. Consumed by the Wave-E radial slicer that will
 * split the surface-conforming print shell into N printable pieces.
 */
export const SIDE_CUT_ANGLES: Readonly<Record<2 | 3 | 4, readonly number[]>> =
  Object.freeze({
    2: Object.freeze([90, 270]),
    3: Object.freeze([30, 150, 270]),
    4: Object.freeze([45, 135, 225, 315]),
  });

/**
 * Return `SIDE_CUT_ANGLES[sideCount]` with every angle offset by
 * `rotationDeg`, modulo 360. Used by the cut-planes preview feature
 * (dogfood 2026-04-22 round 7) to let the user spin the whole cut-
 * plane set around the vertical axis before generate.
 *
 * Keeps the base table immutable; returns a fresh array so callers
 * can safely iterate / sort without touching the frozen source.
 *
 * `rotationDeg` defaults to 0 so existing call-sites that don't
 * care about user rotation work unchanged.
 */
export function effectiveCutAngles(
  sideCount: 2 | 3 | 4,
  rotationDeg = 0,
): readonly number[] {
  const base = SIDE_CUT_ANGLES[sideCount];
  if (rotationDeg === 0) return base;
  return base.map((a) => ((a + rotationDeg) % 360 + 360) % 360);
}
