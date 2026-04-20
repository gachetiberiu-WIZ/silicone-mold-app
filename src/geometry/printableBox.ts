// src/geometry/printableBox.ts
//
// Printable-box part generator — Phase 3c Wave 2 (issue #50).
//
// Given a "silicone bbox" (the AABB of the silicone body's upper+lower
// halves, in the oriented/post-transform frame) and the current mold
// parameters, this module produces three printable Manifold parts:
//
//   - `basePart`      — rectangular slab below the silicone bbox
//   - `sideParts`     — `sideCount` ring-frame wedges around the bbox
//   - `topCapPart`    — rectangular slab above the silicone bbox
//
// The box's INNER cavity is exactly `shellBbox` (no air gap in v1 — the
// silicone hugs the printed walls). The OUTER envelope is `shellBbox`
// expanded by `baseThickness_mm` on all 6 sides. The one
// `baseThickness_mm` parameter therefore governs base-plate thickness,
// top-cap thickness, AND printed-side wall thickness — see issue #50
// "Containment-box geometry" and `mold-generator` SKILL §"Input contract"
// (where `basePlateThickness_mm` is the only box-wall thickness parameter
// at v1).
//
// NO registration keys, NO sprue/vent channels, NO viewport preview,
// NO STL export. Those are Wave 3 / Wave 4 / Phase 3f respectively —
// deliberately out of scope per the issue.
//
// Side split algorithm
// --------------------
//
// The ring frame in plan view is a rectangular annulus. We split it into
// `sideCount` pieces by RADIAL cuts passing through the XZ centre of
// `shellBbox`. The cut angles are hard-coded in `SIDE_CUT_ANGLES` so the
// mapping is single-sourced and self-documenting:
//
//   - sideCount=4: [45°, 135°, 225°, 315°] (diagonals through bbox corners)
//     → four pieces, each one full box face + two half-corners. Symmetric
//     on a square, mirror-pair-identical on a rectangle.
//
//   - sideCount=2: [90°, 270°] (along +X / −X axis through centre)
//     → two L-shaped pieces. Pull-direction is ±X.
//
//   - sideCount=3: [30°, 150°, 270°] (120° apart, orientable).
//     → three pieces of UNEQUAL size. Documented as the compromise
//     option per the issue — the user who picks sideCount=3 knows 2 and
//     4 are the symmetric options.
//
// Angles are measured in degrees, counter-clockwise from the +X axis
// (looking down the +Y axis — standard Three.js Y-up convention).
//
// Each wedge is produced by taking the whole ring frame and clipping it
// with two half-space planes whose normals point INTO the desired sector:
//
//   plane_i:   normal = (−sin(θ_i),      0, cos(θ_i))       → keeps CCW side
//   plane_j:   normal = ( sin(θ_{j mod n}), 0, −cos(θ_{j mod n}))   → keeps CW side
//
// Both planes contain the XZ centre of `shellBbox`, so their
// `originOffset` is `normal · shellBboxCentreXZ`.
//
// The result is a cleanly watertight wedge of the ring frame. By
// construction pairs of adjacent wedges share only a zero-area planar
// boundary, so `intersect(wedge_a, wedge_b).volume() == 0` within the
// kernel's tolerance — that's the invariant the tests pin.
//
// Watertightness
// --------------
//
// Every Manifold returned here is guaranteed watertight (genus 0) by
// construction:
//
//   - Base / top-cap slabs are `Manifold.cube` outputs — guaranteed
//     watertight by manifold-3d.
//   - Sides start from `outerRing.subtract(innerCavity)` — two cube
//     subtractions yield a topological torus-like shape (genus 1, with
//     the hole running along Y). That's still a valid watertight
//     Manifold.
//   - Wait: the ring frame is genus 1, not genus 0. `trimByPlane` of a
//     genus-1 shape by a radial plane passing through the hole yields
//     two genus-0 wedges (the plane seals the inner-wall exposure).
//     `assertWatertightSolid` enforces genus === 0 on every final wedge.

import type { Box, Manifold, ManifoldToplevel, Vec3 } from 'manifold-3d';

import type { MoldParameters } from '@/renderer/state/parameters';
import { isManifold } from './adapters';

/**
 * Hard whitelist of `sideCount` values we support at v1. Mirrors the
 * `SIDE_COUNT_OPTIONS` constant in `src/renderer/state/parameters.ts`;
 * kept here (rather than imported) as a defence-in-depth guard so the
 * geometry kernel validates its own inputs even if called from outside
 * the renderer (tests, future CLI, etc).
 */
const SUPPORTED_SIDE_COUNTS: ReadonlyArray<2 | 3 | 4> = Object.freeze([2, 3, 4]);

/**
 * Radial cut angles (degrees, CCW from +X axis, looking down −Y) for each
 * supported `sideCount`. The mapping is load-bearing for reproducibility
 * of part layout and is exported so tests can pin exact values without
 * hard-coding them inline.
 *
 * The angles define the BOUNDARIES between sectors — side[i] occupies
 * the arc between SIDE_CUT_ANGLES[sideCount][i] and
 * SIDE_CUT_ANGLES[sideCount][(i+1) % sideCount], walking CCW.
 *
 * Decisions (from issue #50):
 *   - 4 sides: 45/135/225/315 — diagonals through corners; symmetric on a
 *     square, mirror-pair-identical on a rectangle.
 *   - 2 sides: 90/270 — cuts along +X/−X axis; long-axis pull-direction.
 *   - 3 sides: 30/150/270 — 120° apart, asymmetric sizing acceptable for
 *     v1 with a single-strategy two-halves-in-box mold.
 */
export const SIDE_CUT_ANGLES: Readonly<Record<2 | 3 | 4, readonly number[]>> = Object.freeze({
  2: Object.freeze([90, 270]),
  3: Object.freeze([30, 150, 270]),
  4: Object.freeze([45, 135, 225, 315]),
});

/**
 * Bundle of printable-box Manifolds produced for one generation pass.
 *
 * Ownership: every Manifold here is a FRESH handle owned by the caller.
 * Call `.delete()` on each of `basePart`, every element of `sideParts`,
 * and `topCapPart` to release WASM heap memory when done.
 */
export interface PrintableBoxParts {
  /** Rectangular slab below the silicone bbox. Watertight (genus 0). */
  readonly basePart: Manifold;
  /**
   * Ring-frame wedges around the silicone bbox, one per `sideCount`.
   * `length === sideCount`. Each wedge is watertight (genus 0). Adjacent
   * wedges share only a zero-area planar boundary — pairwise
   * `intersect(a, b).volume()` is zero within kernel tolerance.
   */
  readonly sideParts: readonly Manifold[];
  /** Rectangular slab above the silicone bbox. Watertight (genus 0). */
  readonly topCapPart: Manifold;
  /**
   * `basePart.volume() + Σ sideParts[i].volume() + topCapPart.volume()`.
   * Pre-computed once so the caller (orchestrator / future topbar) does
   * not need to re-walk the parts to read it.
   */
  readonly printableVolume_mm3: number;
}

/**
 * Thin wrapper around `isManifold` + genus check. Every printable part
 * must be (a) a valid non-empty manifold AND (b) topologically a solid
 * ball (genus 0). A non-zero genus on the final output means a through-
 * hole we didn't intend — a bug in the wedge-split logic or a
 * degenerate bbox.
 */
function assertWatertightSolid(m: Manifold, label: string): void {
  if (!isManifold(m)) {
    const status = m.status();
    const empty = m.isEmpty();
    throw new Error(
      `printableBox: ${label} is not a valid manifold ` + `(status=${status}, isEmpty=${empty})`,
    );
  }
  const genus = m.genus();
  if (genus !== 0) {
    throw new Error(
      `printableBox: ${label} has genus=${genus}, expected 0 ` +
        `(through-hole or non-solid topology)`,
    );
  }
}

/**
 * Build a rectangular slab Manifold spanning the given ranges on each
 * axis. Helper over `Manifold.cube` that accepts an explicit AABB
 * instead of (size, center) — more readable when the caller has exact
 * min/max bounds already computed.
 */
function buildSlab(toplevel: ManifoldToplevel, aabb: Box): Manifold {
  const sx = aabb.max[0] - aabb.min[0];
  const sy = aabb.max[1] - aabb.min[1];
  const sz = aabb.max[2] - aabb.min[2];
  if (sx <= 0 || sy <= 0 || sz <= 0) {
    throw new Error(
      `printableBox.buildSlab: degenerate AABB ${JSON.stringify(aabb)} ` +
        `(sx=${sx}, sy=${sy}, sz=${sz})`,
    );
  }
  // `Manifold.cube` built in the first octant, then translated to
  // `aabb.min`. We explicitly avoid the `center=true` form because we
  // want control over both min and max.
  return toplevel.Manifold.cube([sx, sy, sz], false).translate([
    aabb.min[0],
    aabb.min[1],
    aabb.min[2],
  ]);
}

/**
 * Trim a ring-frame Manifold down to the angular sector
 * `[angleStart_deg, angleEnd_deg]` (CCW from +X around +Y) using two
 * `trimByPlane` calls. Both cut planes pass through `centreXZ` — the XZ
 * centre of the silicone bbox.
 *
 * Trimming discipline: `trimByPlane(n, o)` keeps the half where
 * `n · P >= o`. To keep the CCW side of a radial line at angle θ the
 * plane normal is (−sin θ, 0, cos θ); to keep the CW side it's
 * (sin θ, 0, −cos θ). The origin offset in each case is `normal · centre`.
 *
 * Note: when the sector spans more than 180° the "intersection of two
 * half-spaces" shape alone can't represent it. v1 never exercises that —
 * the 2-side split at 90°/270° produces two 180° sectors (exactly), and
 * `trimByPlane` handles the boundary cleanly by keeping the closed side.
 * sideCount=3's widest sector is 240° (from 150° to 30° going through
 * 270°) — that IS >180°, so we have to handle the reflex case by
 * complement: trim the OPPOSITE sector off and keep everything else.
 * Implementation detail: we detect reflex sectors and split them into
 * two sub-sectors of <=180° each, trim each, and union.
 */
function trimToSector(
  ring: Manifold,
  angleStart_deg: number,
  angleEnd_deg: number,
  centreXZ: { x: number; z: number },
): Manifold {
  // Normalise so the CCW arc goes from start → end as a positive sweep
  // in [0, 360). `span` is the sweep magnitude.
  const span = (((angleEnd_deg - angleStart_deg) % 360) + 360) % 360;
  if (span === 0) {
    throw new Error(
      `printableBox.trimToSector: zero-span sector [${angleStart_deg}, ${angleEnd_deg}]`,
    );
  }

  if (span <= 180) {
    return trimToConvexSector(ring, angleStart_deg, angleEnd_deg, centreXZ);
  }

  // Reflex sector (>180°): the intersection of two half-spaces can't
  // capture it. Split into two sub-sectors at the midpoint, trim each,
  // and union. Splitting at the midpoint guarantees both halves are
  // <=180° (actually exactly `span / 2`, which is <=180° since
  // span < 360).
  const mid = angleStart_deg + span / 2;
  const half1 = trimToConvexSector(ring, angleStart_deg, mid, centreXZ);
  let half2: Manifold | undefined;
  try {
    half2 = trimToConvexSector(ring, mid, angleEnd_deg, centreXZ);
    // union of two adjacent sectors that share one radial boundary is
    // watertight (the planar boundary gets merged by manifold-3d's
    // tolerance-based vertex welding).
    return half1.add(half2);
  } finally {
    // The sub-sectors themselves are no longer needed — their union
    // is a fresh Manifold.
    half1.delete();
    if (half2) half2.delete();
  }
}

/**
 * Trim a ring to a convex (<=180°) sector using two `trimByPlane` calls.
 * Exported for debuggability; callers should use `trimToSector` which
 * handles the reflex case transparently.
 */
function trimToConvexSector(
  ring: Manifold,
  angleStart_deg: number,
  angleEnd_deg: number,
  centreXZ: { x: number; z: number },
): Manifold {
  const a1 = (angleStart_deg * Math.PI) / 180;
  const a2 = (angleEnd_deg * Math.PI) / 180;

  // Plane 1: radial line at angleStart; keep the CCW side (in the
  // direction of increasing angle). Normal rotates the line's tangent
  // 90° CCW → (−sin a1, 0, cos a1).
  const n1: Vec3 = [-Math.sin(a1), 0, Math.cos(a1)];
  const o1 = n1[0] * centreXZ.x + n1[2] * centreXZ.z;

  // Plane 2: radial line at angleEnd; keep the CW side (opposite
  // direction from plane 1's keep-normal at the same angle).
  const n2: Vec3 = [Math.sin(a2), 0, -Math.cos(a2)];
  const o2 = n2[0] * centreXZ.x + n2[2] * centreXZ.z;

  // trimByPlane returns a FRESH Manifold; chain them.
  const step1 = ring.trimByPlane(n1, o1);
  let step2: Manifold | undefined;
  try {
    step2 = step1.trimByPlane(n2, o2);
    return step2;
  } finally {
    step1.delete();
    // step2 is returned — do NOT delete here.
  }
}

/**
 * Build the printable base + sides + top cap from the silicone bbox and
 * the current mold parameters. Pure geometry — no viewport interaction,
 * no i18n, no DOM.
 *
 * Layout in the oriented frame (the same frame the silicone halves are
 * in — the caller already applied `viewTransform` to the master before
 * passing `shellBbox`):
 *
 *   Y:  outer.max.y = shellBbox.max.y + baseThickness_mm
 *       shellBbox.max.y        ──── (top of silicone, bottom of top cap)
 *       shellBbox.min.y        ──── (bottom of silicone, top of base)
 *       outer.min.y = shellBbox.min.y − baseThickness_mm
 *
 *   XZ: outer.min.x = shellBbox.min.x − baseThickness_mm
 *       outer.max.x = shellBbox.max.x + baseThickness_mm
 *       outer.min.z = shellBbox.min.z − baseThickness_mm
 *       outer.max.z = shellBbox.max.z + baseThickness_mm
 *
 * - `basePart`    occupies Y in [outer.min.y, shellBbox.min.y], full
 *                 outer XZ footprint.
 * - `topCapPart`  occupies Y in [shellBbox.max.y, outer.max.y], full
 *                 outer XZ footprint.
 * - `sideParts`   occupy Y in [shellBbox.min.y, shellBbox.max.y]. In plan
 *                 view they form the ring outer.XZ − shellBbox.XZ, split
 *                 radially into `sideCount` wedges.
 *
 * @param toplevel The initialised Manifold toplevel handle (from
 *   `initManifold()`).
 * @param shellBbox AABB of the silicone body (union of upper + lower
 *   halves) in the oriented frame, in mm.
 * @param parameters Current mold parameters. Reads `baseThickness_mm` and
 *   `sideCount` only.
 * @returns Fresh owned Manifolds. See `PrintableBoxParts` for the
 *   ownership contract.
 * @throws If `sideCount` isn't in `{2, 3, 4}`, if `shellBbox` is
 *   degenerate, or if any part fails the watertightness check.
 */
export function buildPrintableBox(
  toplevel: ManifoldToplevel,
  shellBbox: Box,
  parameters: MoldParameters,
): PrintableBoxParts {
  // Defence-in-depth: the UI constrains sideCount already, but the
  // geometry kernel must still reject invalid input.
  if (!SUPPORTED_SIDE_COUNTS.includes(parameters.sideCount)) {
    throw new Error(
      `buildPrintableBox: sideCount=${String(parameters.sideCount)} ` +
        `is not supported (must be one of ${SUPPORTED_SIDE_COUNTS.join(', ')})`,
    );
  }
  const wall = parameters.baseThickness_mm;
  if (!(wall > 0) || !Number.isFinite(wall)) {
    throw new Error(`buildPrintableBox: baseThickness_mm=${wall} must be a positive finite number`);
  }

  // Validate shellBbox is a proper AABB — the silicone pipeline produces
  // this but we guard against degeneracies before consuming.
  const sx = shellBbox.max[0] - shellBbox.min[0];
  const sy = shellBbox.max[1] - shellBbox.min[1];
  const sz = shellBbox.max[2] - shellBbox.min[2];
  if (!(sx > 0 && sy > 0 && sz > 0)) {
    throw new Error(`buildPrintableBox: shellBbox is degenerate (sx=${sx}, sy=${sy}, sz=${sz})`);
  }

  // Outer envelope = shellBbox expanded by `wall` on all six sides.
  const outer: Box = {
    min: [shellBbox.min[0] - wall, shellBbox.min[1] - wall, shellBbox.min[2] - wall],
    max: [shellBbox.max[0] + wall, shellBbox.max[1] + wall, shellBbox.max[2] + wall],
  };

  // --- Base + top cap: pure rectangular slabs. ------------------------
  const baseAabb: Box = {
    min: [outer.min[0], outer.min[1], outer.min[2]],
    max: [outer.max[0], shellBbox.min[1], outer.max[2]],
  };
  const topCapAabb: Box = {
    min: [outer.min[0], shellBbox.max[1], outer.min[2]],
    max: [outer.max[0], outer.max[1], outer.max[2]],
  };

  const basePart = buildSlab(toplevel, baseAabb);
  let topCapPart: Manifold | undefined;
  const sideParts: Manifold[] = [];

  try {
    assertWatertightSolid(basePart, 'basePart');

    topCapPart = buildSlab(toplevel, topCapAabb);
    assertWatertightSolid(topCapPart, 'topCapPart');

    // --- Sides: ring frame split into wedges. -----------------------
    // The ring is at Y ∈ [shellBbox.min.y, shellBbox.max.y], and its XZ
    // cross-section is `outer.XZ − shellBbox.XZ`.
    const ringOuterAabb: Box = {
      min: [outer.min[0], shellBbox.min[1], outer.min[2]],
      max: [outer.max[0], shellBbox.max[1], outer.max[2]],
    };
    const ringInnerAabb: Box = {
      // Inner cavity is shellBbox exactly (no air gap in v1).
      min: [shellBbox.min[0], shellBbox.min[1], shellBbox.min[2]],
      max: [shellBbox.max[0], shellBbox.max[1], shellBbox.max[2]],
    };
    const ringOuter = buildSlab(toplevel, ringOuterAabb);
    let ringInner: Manifold | undefined;
    let ringFrame: Manifold | undefined;
    try {
      ringInner = buildSlab(toplevel, ringInnerAabb);
      ringFrame = ringOuter.subtract(ringInner);
      // ringFrame is genus 1 (the cavity punches through along Y). We
      // don't assert genus 0 here — that's the post-sector invariant.
      if (!isManifold(ringFrame)) {
        throw new Error(
          `printableBox: ringFrame is not a valid manifold ` + `(status=${ringFrame.status()})`,
        );
      }

      // XZ centre of the silicone bbox — load-bearing: every radial cut
      // plane passes through this point.
      const centreXZ = {
        x: (shellBbox.min[0] + shellBbox.max[0]) / 2,
        z: (shellBbox.min[2] + shellBbox.max[2]) / 2,
      };

      const angles = SIDE_CUT_ANGLES[parameters.sideCount];
      const n = angles.length;
      for (let i = 0; i < n; i++) {
        const a1 = angles[i]!;
        const a2 = angles[(i + 1) % n]!;
        const wedge = trimToSector(ringFrame, a1, a2, centreXZ);
        try {
          assertWatertightSolid(wedge, `sideParts[${i}]`);
          sideParts.push(wedge);
        } catch (err) {
          wedge.delete();
          throw err;
        }
      }
    } finally {
      if (ringFrame) ringFrame.delete();
      if (ringInner) ringInner.delete();
      ringOuter.delete();
    }

    const baseVol = basePart.volume();
    const topVol = topCapPart.volume();
    let sidesVol = 0;
    for (const s of sideParts) sidesVol += s.volume();
    const printableVolume_mm3 = baseVol + sidesVol + topVol;

    return {
      basePart,
      sideParts: Object.freeze(sideParts.slice()) as readonly Manifold[],
      topCapPart,
      printableVolume_mm3,
    };
  } catch (err) {
    // On failure BEFORE we return, the caller never gets a handle — so
    // we must clean up every Manifold we've successfully built to avoid
    // a WASM heap leak.
    basePart.delete();
    if (topCapPart) topCapPart.delete();
    for (const s of sideParts) s.delete();
    throw err;
  }
}
