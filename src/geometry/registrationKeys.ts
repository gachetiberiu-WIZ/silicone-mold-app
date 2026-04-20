// src/geometry/registrationKeys.ts
//
// Registration-key stamping — Phase 3c Wave 3 (issue #55) + issue #57
// (cone + keyhole key styles).
//
// Places three registration "keys" along the parting plane (horizontal at
// `shellBbox` mid-Y from Waves 1-2) that protrude from the lower silicone
// half and recess into the upper silicone half. Two symmetric keys sit on
// ±X in the XZ plane; a third asymmetric key sits on +Z alone. The
// asymmetry enforces assembly orientation — rotating the upper half 180°
// about Y moves the +Z key to −Z, where the lower half has no matching
// protrusion, so the halves will not mate.
//
// Locked design decisions (layout + sizing, from issue #55):
//   - 3 keys: (-0.35·ringWidth_X, 0), (+0.35·ringWidth_X, 0), (0, +0.35·ringWidth_Z).
//   - Key diameter = min(4.0, 0.3·wallThickness_mm).
//   - Inside-ring constraint: `|coord| < ringWidth/2 − radius − 1.0 mm`
//     with 1 mm clearance to the silicone outer face.
//   - Clamp inward if the default 0.35 multiplier overshoots the safe zone;
//     throw `GeometryError` if no valid placement exists.
//
// Key styles (issue #55 + #57):
//
//   - `asymmetric-hemi` (#55): a full sphere centred on the parting plane.
//     Upper half subtracts the upper hemisphere (recess); lower half unions
//     the upper hemisphere (protrusion). Mating surfaces are exactly the
//     two hemispheres sharing the parting-plane great circle.
//
//   - `cone` (#57): a "double cone" (two cones base-to-base at the
//     parting plane), centred on the parting plane. Same
//     symmetric-about-parting invariant as the sphere → single shared tool
//     for both halves. Upper half gets a conical recess (tip pointing
//     UP, into the silicone); lower half gets a conical protrusion
//     (tip pointing UP, out of the silicone). Cone height = diameter
//     (rule of thumb — a cone of height < diameter keys too softly, a
//     cone of height > diameter is harder to demould). Since the tool is
//     diameter-tall (= radius each side of the parting plane), the below-
//     parting-plane cone of the "double cone" is already inside the lower
//     half's material — its union is a no-op on volume, exactly like the
//     sphere case.
//
//   - `keyhole` (#57): a radially-oriented keyhole cross-section —
//     circle + rectangular slot extending outward — extruded
//     symmetrically across the parting plane. Resists lateral shear
//     (the rectangular slot locks the halves together against any
//     sliding pull in the XZ plane). Height = diameter (half above /
//     half below parting plane). Each of the 3 key positions gets its
//     own radially-oriented tool: the ±X keys' slots extend outward
//     along ±X; the +Z key's slot extends outward along +Z. This makes
//     the keyhole inherently "radial-out" from the master centre, so
//     the slot bodies of different keys never overlap each other in the
//     silicone ring.
//
// Style tradeoffs summary (documented here + in the PR body):
//
//   hemi     : simplest CSG (1 sphere union per key); curves smooth; keys
//              lightly — halves will slide sideways a bit before the
//              hemispheres seat. Lowest demould risk.
//   cone     : 2 cones per key (double-cone). Sharp tip means high
//              contact pressure on mating → keys positively (hard to
//              mis-align even by a fraction of a millimetre). Higher
//              demould risk on a stiff silicone — the sharp tip can
//              pull a slug on release. Best for users who want tight
//              repeat alignment.
//   keyhole  : most complex CSG (1 extrude of a polygon union per key,
//              3 orientations). Slot geometry resists lateral shear as
//              well as axial separation. Curved lobe + flat slot walls
//              → demould comparable to hemi. Best for large masters
//              where lateral registration is the failure mode.
//
// Manifold ownership
// ------------------
//
// Every intermediate Manifold created by this module (key tools, unions,
// per-key stamps) is `.delete()`-d inside a `try/finally` before
// returning. The caller receives exactly TWO fresh Manifolds:
//   - `updatedUpper` — the upper silicone half minus the key recesses
//   - `updatedLower` — the lower silicone half plus the key protrusions
// The ORIGINAL `upperHalf` + `lowerHalf` Manifolds passed in are NOT
// consumed — the caller still owns them and must `.delete()` them
// separately.

import type { Manifold, ManifoldToplevel, Polygons, Vec2 } from 'manifold-3d';

import { isManifold } from './adapters';
import { CIRCULAR_SEGMENTS } from './primitives';

/**
 * Error raised when the silicone ring is too thin to accept the configured
 * registration keys. Separate class from `InvalidParametersError` (which
 * covers bad inputs like unsupported key styles) so callers can
 * distinguish "the user asked for something impossible" from "the user's
 * mesh geometry is incompatible with the chosen parameters".
 */
export class GeometryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeometryError';
  }
}

/**
 * Registration key styles. Mirrors `RegistrationKeyStyle` in
 * `src/renderer/state/parameters.ts` — kept local to the geometry module
 * so `stampRegistrationKeys` does not need to import UI state types.
 */
export type RegistrationKeyStyle = 'asymmetric-hemi' | 'cone' | 'keyhole';

/**
 * The default multiplier for key offsets along each ring axis. The key
 * center sits at `OFFSET_MULTIPLIER · (ringWidth / 2)` from the ring
 * centre (`= 0.35 · ringWidth / 2`). Clamped inward by
 * `resolveKeyOffsets()` if the safe zone is too narrow for this default.
 */
export const DEFAULT_OFFSET_MULTIPLIER = 0.35;

/**
 * Minimum clearance in mm between the key's outer surface and the silicone
 * body's outer face. Keeps the key safely inside the ring material so a
 * user who prints the silicone halves doesn't end up with a key poking
 * through the outside of the silicone wall.
 */
export const KEY_CLEARANCE_MM = 1.0;

/**
 * Hard cap on key diameter. Prevents monster keys on very thick walls —
 * above 4 mm the key is harder to demould than the master itself.
 */
export const MAX_KEY_DIAMETER_MM = 4.0;

/**
 * Multiplier on `wallThickness_mm` used to size the keys on normal walls.
 * Combined with `MAX_KEY_DIAMETER_MM` as `min(MAX, mult · wall)`.
 */
export const KEY_DIAMETER_WALL_RATIO = 0.3;

/**
 * Keyhole rectangular-slot width as a fraction of the circular lobe's
 * diameter. `0.5` per issue #57 ("slot width = diameter / 2"). Exposed as
 * a constant so tests can pin the ratio and callers can read it for
 * documentation.
 */
export const KEYHOLE_SLOT_WIDTH_RATIO = 0.5;

/**
 * Keyhole rectangular-slot length — how far the slot extends radially
 * outward from the circle centre, as a fraction of the circular lobe's
 * diameter. `1.0` per issue #57 ("slot length = diameter"). Measured
 * FROM the circle centre so the slot's outer tip is `diameter` away
 * from the circle centre; the slot's inner edge lives at `+radius` (it
 * "docks" onto the circle's far side).
 */
export const KEYHOLE_SLOT_LENGTH_RATIO = 1.0;

/**
 * Result of `stampRegistrationKeys`. Contains the two fresh silicone
 * half-Manifolds with keys applied. Caller owns both — `.delete()` each
 * when done.
 */
export interface RegistrationKeysResult {
  /** Upper silicone half with three key recesses. */
  readonly updatedUpper: Manifold;
  /** Lower silicone half with three key protrusions. */
  readonly updatedLower: Manifold;
}

/**
 * Compute the key diameter in mm per the issue's locked formula:
 *   `diameter = min(MAX_KEY_DIAMETER_MM, KEY_DIAMETER_WALL_RATIO · wallThickness_mm)`.
 *
 * Exported so tests can pin the formula without duplicating it.
 */
export function computeKeyDiameter(wallThickness_mm: number): number {
  return Math.min(MAX_KEY_DIAMETER_MM, KEY_DIAMETER_WALL_RATIO * wallThickness_mm);
}

/**
 * Resolve the offset multipliers for each axis given the silicone ring
 * bbox's X and Z widths and the key radius. Returns one multiplier per
 * axis (X, Z), each in (0, DEFAULT_OFFSET_MULTIPLIER]. The multiplier is
 * clamped inward when the default would place the key outside the safe
 * zone `|offset| < ringWidth/2 − radius − KEY_CLEARANCE_MM`.
 *
 * Throws `GeometryError` when no positive multiplier exists on either
 * axis — i.e. the ring is narrower than `2·radius + 2·clearance` on that
 * axis, leaving no room for a key.
 *
 * Exported for unit testing the pure-math clamp logic without instantiating
 * any Manifold.
 */
export function resolveKeyOffsets(
  ringWidth_X: number,
  ringWidth_Z: number,
  keyRadius: number,
): { multX: number; multZ: number } {
  const computeMult = (ringWidth: number, axisLabel: string): number => {
    const half = ringWidth / 2;
    if (!(half > 0)) {
      throw new GeometryError(
        `silicone ring ${axisLabel} width is non-positive (${ringWidth}) — master bbox is degenerate`,
      );
    }
    const safeHalf = half - keyRadius - KEY_CLEARANCE_MM;
    if (!(safeHalf > 0)) {
      throw new GeometryError(
        `silicone ring too thin for registration keys: ${axisLabel} half-width=${half.toFixed(2)} mm ` +
          `< keyRadius=${keyRadius.toFixed(2)} mm + clearance=${KEY_CLEARANCE_MM} mm. ` +
          `Reduce wall thickness or use a smaller key style.`,
      );
    }
    const maxMult = safeHalf / half;
    return Math.min(DEFAULT_OFFSET_MULTIPLIER, maxMult);
  };

  return {
    multX: computeMult(ringWidth_X, 'X'),
    multZ: computeMult(ringWidth_Z, 'Z'),
  };
}

/**
 * Build a full sphere Manifold of the given radius, centred at the origin.
 * Used as the base shape for BOTH the key protrusion (union'd into the
 * lower silicone half) AND the key recess (subtracted from the upper
 * silicone half) — the two operations share the same tool geometry so the
 * mating surfaces are identical.
 *
 * Design note on "why a full sphere instead of a hemisphere":
 *
 *   A protrusion of radius `r` above the parting plane is, from the lower
 *   half's point of view, a sphere of radius `r` centred exactly ON the
 *   parting plane. The half of the sphere that falls BELOW the parting
 *   plane is already inside the lower half's material — unioning it is a
 *   no-op on volume, and the resulting boundary is clean because the
 *   sphere's equator seam lands exactly on the cut plane that produced
 *   the lower half.
 *
 *   Symmetrically, subtracting the same full sphere from the upper half
 *   carves out only the hemisphere that lies ABOVE the parting plane (the
 *   part below is outside the upper half's material — subtraction is a
 *   no-op there). Both halves therefore see the same tool and get
 *   perfectly-mated protrusions + recesses.
 *
 *   Using a half-hemisphere instead would require TWO differently-oriented
 *   tools (one for protrusion, one for recess) and would expose a
 *   zero-thickness triangle on the flat face at the parting plane — which
 *   manifold-3d must weld at union time, introducing avoidable numerical
 *   work. A full sphere side-steps both problems.
 *
 * Caller owns the returned Manifold — `.delete()` when done.
 */
function buildKeySphere(toplevel: ManifoldToplevel, radius: number): Manifold {
  return toplevel.Manifold.sphere(radius, CIRCULAR_SEGMENTS);
}

/**
 * Build a "double cone" Manifold — two cones joined base-to-base at the
 * origin (bases on the XZ plane at Y=0, tips at Y=±radius). Axis is +Y.
 *
 * Uses the same full-shape-symmetric-about-parting-plane invariant that
 * `buildKeySphere` relies on: the tool's upper-half cone carves the
 * upper-silicone-half recess (subtract), and the same tool's upper-half
 * cone is the lower-silicone-half protrusion (union). The lower-half
 * cone of the tool lives inside the lower-silicone-half material
 * (volume no-op on union) and outside the upper-silicone-half material
 * (volume no-op on subtract) — exactly as the sphere case.
 *
 * Cone height — per issue #57 "rule of thumb", height equals diameter
 * of the base. For a double-cone, each individual cone has
 * height = diameter / 2 = radius, giving tip-to-tip = diameter = 2·radius.
 *
 * Implementation: manifold-3d's `Manifold.cylinder(h, rLow, rHigh, ...)`
 * with `rHigh = 0` is a cone along +Z, apex UP at `z = h`. We build one
 * upward cone (apex at +Z), rotate -90° about X so apex becomes +Y, then
 * union with a mirrored copy (scale Y by −1) to produce a cone pointing
 * down. The two share the parting-plane disc at Y=0.
 *
 * Caller owns the returned Manifold — `.delete()` when done.
 */
function buildConeTool(
  toplevel: ManifoldToplevel,
  radius: number,
  segments: number = CIRCULAR_SEGMENTS,
): Manifold {
  // Each half of the double cone has height = radius (so the full
  // double cone is 2·radius = diameter tall).
  const halfHeight = radius;

  // Build a Z-axis cone, base radius = radius, top radius = 0,
  // from z=0 (base) up to z=halfHeight (apex). Then rotate -90° about X
  // so the apex points in +Y and the base sits at Y=0.
  const upZ = toplevel.Manifold.cylinder(halfHeight, radius, 0, segments, false);
  let upperCone: Manifold | undefined;
  let lowerCone: Manifold | undefined;
  let doubled: Manifold | undefined;
  try {
    upperCone = upZ.rotate([-90, 0, 0]);
    // Mirror through the XZ plane (y = 0) to get the downward-pointing
    // cone. `scale([1, -1, 1])` inverts Y and flips winding, which
    // manifold-3d handles correctly (it re-derives winding at output
    // construction time).
    lowerCone = upperCone.scale([1, -1, 1]);
    doubled = toplevel.Manifold.union([upperCone, lowerCone]);
    // Hand ownership of `doubled` to the caller; local holders drop
    // theirs.
    const out = doubled;
    doubled = undefined;
    return out;
  } finally {
    upZ.delete();
    if (upperCone) upperCone.delete();
    if (lowerCone) lowerCone.delete();
    if (doubled) doubled.delete();
  }
}

/**
 * Radial direction for a keyhole tool's rectangular slot. The slot always
 * points OUTWARD — away from the master centre — so three keys placed at
 * (-0.35·ringWidth_X, 0), (+0.35·ringWidth_X, 0), (0, +0.35·ringWidth_Z)
 * have their slots extending along −X, +X, +Z respectively.
 */
export type KeyholeRadialDirection = 'x-pos' | 'x-neg' | 'z-pos';

/**
 * Build a keyhole-shape Manifold — a circle + a rectangular slot extending
 * radially outward — extruded symmetrically about the parting plane (Y=0).
 *
 * The 2D cross-section looks like a lollipop with the stick extending
 * outward from one side of the circle:
 *
 *     ○────   (for 'x-pos': stick extends along +X from the circle's
 *              +X side; the circle's centre is at the key's XZ position)
 *
 * Circle radius  = `radius` (half the key diameter).
 * Slot width     = `KEYHOLE_SLOT_WIDTH_RATIO  · diameter = 0.5 · 2·radius = radius`.
 * Slot length    = `KEYHOLE_SLOT_LENGTH_RATIO · diameter = 1.0 · 2·radius = 2·radius`,
 *                  measured from the circle centre → the slot's outer
 *                  tip is at `diameter` (= 2·radius) from the centre.
 *                  The slot's inner end overlaps the circle's interior
 *                  (starting at `−radius` from the centre along the
 *                  radial axis), so the union is genuinely one connected
 *                  keyhole polygon.
 * Extrude height = `diameter = 2·radius`, centred on the parting plane
 *                  → upper half gets radius depth of recess, lower half
 *                  gets radius of protrusion.
 *
 * Implementation:
 *
 *   1. Build a 2D polygon with circle approximated by `segments`-gon,
 *      plus a rectangle. We union them at the `Polygons` level (manifold
 *      accepts overlapping input polygons and extrudes their union).
 *   2. `Manifold.extrude(polygons, height, 0, 0, [1, 1], true)` produces
 *      a Z-axis extrusion centred on Z=0.
 *   3. Rotate -90° about X: +Z (extrude axis) → +Y, 2D XY plane → XZ plane.
 *      After this rotation: the polygon originally in XY is now in XZ
 *      (X unchanged; original +Y → +Z; original -Y → -Z) and extrudes
 *      along ±Y by half-height. But wait — the sign depends on which
 *      way we rotate. See code comments below for the working-out.
 *   4. Rotate about Y to orient the radial slot along the requested axis:
 *      'x-pos' → no rotation; 'x-neg' → 180° about Y; 'z-pos' → -90°
 *      about Y.
 *
 * Caller owns the returned Manifold — `.delete()` when done.
 */
function buildKeyholeTool(
  toplevel: ManifoldToplevel,
  radius: number,
  direction: KeyholeRadialDirection,
  segments: number = CIRCULAR_SEGMENTS,
): Manifold {
  const diameter = 2 * radius;
  // Step 1: build the 2D keyhole polygon in the XY plane. We place the
  // circle at the 2D origin and the slot extending along +X. The slot
  // rectangle:
  //   - x from -radius (inside the circle) to +diameter (outer tip,
  //     which is `2·radius` along +X from the circle centre);
  //   - y from -slotHalfWidth to +slotHalfWidth.
  // Having the rectangle's inner edge at x = -radius ensures the
  // rectangle fully overlaps the circle's right half, so after
  // union the keyhole silhouette is a clean lollipop without any
  // zero-width seams.
  const slotWidth = KEYHOLE_SLOT_WIDTH_RATIO * diameter; // = radius
  const slotOuter = KEYHOLE_SLOT_LENGTH_RATIO * diameter; // = 2·radius
  const slotInner = -radius; // push inside the circle

  // Circle polygon (n-gon approximation). Wound CCW for manifold-3d's
  // Positive fill rule to count this as a filled region.
  const circlePts: Vec2[] = [];
  for (let i = 0; i < segments; i++) {
    const theta = (2 * Math.PI * i) / segments;
    circlePts.push([radius * Math.cos(theta), radius * Math.sin(theta)]);
  }

  // Rectangle polygon (CCW winding).
  const slotPts: Vec2[] = [
    [slotInner, -slotWidth / 2],
    [slotOuter, -slotWidth / 2],
    [slotOuter, slotWidth / 2],
    [slotInner, slotWidth / 2],
  ];

  // Polygons input: an array of SimplePolygons is interpreted with the
  // Positive fill rule, which unions overlapping positive contours into
  // a single filled region. This is exactly what we want for a
  // circle + rectangle silhouette.
  const polygons: Polygons = [circlePts, slotPts];

  // Step 2 + 3 + 4: extrude, orient along Y, rotate to target direction.
  const extruded = toplevel.Manifold.extrude(polygons, diameter, 0, 0, [1, 1], true);
  let yAligned: Manifold | undefined;
  let oriented: Manifold | undefined;
  try {
    // Extrude output: axis along +Z, cross-section in XY, centred on Z=0.
    // Rotate so the extrusion axis becomes +Y AND the slot's outward
    // direction (originally +X in the 2D polygon) remains +X in 3D.
    //
    // A +90° rotation about the X axis maps:
    //   (x, y, z) → (x, -z, y)
    // i.e. the cross-section's original +Y (tangent to the slot)
    // becomes −Z in 3D, and the extrusion's original +Z becomes +Y.
    // The slot's radial direction (originally +X) stays +X. Perfect —
    // the keyhole now extrudes along ±Y by diameter/2, and its slot
    // points along +X.
    yAligned = extruded.rotate([90, 0, 0]);

    // Step 4: rotate about Y to target the requested radial direction.
    // yAligned's slot currently points along +X. We need:
    //   'x-pos' → keep as-is (0°)
    //   'x-neg' → rotate 180° about Y   → +X becomes −X
    //   'z-pos' → rotate -90° about Y   → +X becomes +Z
    //     (using manifold-3d's right-hand convention for rotate([_, ay, _])
    //      which is an active rotation by `ay` degrees about +Y.
    //      Active rotation of +90° about +Y takes +Z → +X, so −90° takes
    //      +X → +Z, which is what we want.)
    let aboutY: number;
    switch (direction) {
      case 'x-pos':
        aboutY = 0;
        break;
      case 'x-neg':
        aboutY = 180;
        break;
      case 'z-pos':
        aboutY = -90;
        break;
      default: {
        // Defensive — TypeScript's exhaustive-switch check covers the
        // enum, but a caller passing a runtime string bypasses that.
        const exhaustive: never = direction;
        throw new Error(`buildKeyholeTool: unknown direction ${String(exhaustive)}`);
      }
    }
    oriented = aboutY === 0 ? yAligned : yAligned.rotate([0, aboutY, 0]);

    // If oriented === yAligned (the aboutY === 0 case), we didn't
    // allocate a fresh Manifold — clearing `yAligned` would double-free.
    const out = oriented;
    oriented = undefined;
    if (out === yAligned) {
      yAligned = undefined;
    }
    return out;
  } finally {
    extruded.delete();
    if (yAligned) yAligned.delete();
    if (oriented) oriented.delete();
  }
}

/**
 * Minimal validity check — we expect the silicone halves to be valid
 * manifolds on entry (they come straight from `splitByPlane`).
 */
function assertValid(m: Manifold, label: string): void {
  if (!isManifold(m)) {
    throw new Error(
      `registrationKeys: ${label} is not a valid manifold ` +
        `(status=${m.status()}, isEmpty=${m.isEmpty()})`,
    );
  }
}

/**
 * Key positions + radius for a given silicone ring bbox and wall thickness.
 * Pure computation — no Manifold allocation. Exported so tests can pin the
 * layout without running the full CSG pipeline.
 */
export interface RegistrationKeyLayout {
  /** Radius of each key in mm. */
  readonly radius: number;
  /** Key XZ centres, in the oriented-frame coordinate system. */
  readonly positions: ReadonlyArray<{ x: number; z: number }>;
  /** Multiplier actually used on the X axis after clamping. */
  readonly multX: number;
  /** Multiplier actually used on the Z axis after clamping. */
  readonly multZ: number;
}

/**
 * Compute the three key positions (2 on ±X, 1 on +Z) given the silicone
 * bbox and wall thickness. All positions are in the same oriented frame
 * the bbox lives in (world-after-viewTransform at the caller).
 *
 * @throws `GeometryError` if the ring is too thin for any key.
 */
export function computeKeyLayout(
  shellBbox: { min: readonly number[]; max: readonly number[] },
  wallThickness_mm: number,
): RegistrationKeyLayout {
  const xMin = shellBbox.min[0] as number;
  const xMax = shellBbox.max[0] as number;
  const zMin = shellBbox.min[2] as number;
  const zMax = shellBbox.max[2] as number;
  const ringWidth_X = xMax - xMin;
  const ringWidth_Z = zMax - zMin;
  const centreX = (xMin + xMax) / 2;
  const centreZ = (zMin + zMax) / 2;

  const diameter = computeKeyDiameter(wallThickness_mm);
  const radius = diameter / 2;

  const { multX, multZ } = resolveKeyOffsets(ringWidth_X, ringWidth_Z, radius);

  const halfX = ringWidth_X / 2;
  const halfZ = ringWidth_Z / 2;
  const offsetX = multX * halfX;
  const offsetZ = multZ * halfZ;

  return {
    radius,
    positions: [
      { x: centreX - offsetX, z: centreZ }, // symmetric pair lhs (−X)
      { x: centreX + offsetX, z: centreZ }, // symmetric pair rhs (+X)
      { x: centreX, z: centreZ + offsetZ }, // asymmetric anchor (+Z)
    ],
    multX,
    multZ,
  };
}

/**
 * Radial direction for a keyhole key at the given position index in the
 * layout returned by `computeKeyLayout`. The positions array is ordered:
 *   [0] −X key → slot extends along −X
 *   [1] +X key → slot extends along +X
 *   [2] +Z key → slot extends along +Z
 *
 * Exported for tests that want to verify the per-key orientation logic
 * without instantiating any Manifold.
 */
export function keyholeDirectionForIndex(index: number): KeyholeRadialDirection {
  switch (index) {
    case 0:
      return 'x-neg';
    case 1:
      return 'x-pos';
    case 2:
      return 'z-pos';
    default:
      throw new Error(
        `keyholeDirectionForIndex: index ${index} is out of range; layout has exactly 3 positions`,
      );
  }
}

/**
 * Stamp three registration keys onto the silicone halves along the parting
 * plane at `partingY`. Returns fresh upper + lower Manifolds with the
 * recesses + protrusions applied.
 *
 * Ownership contract:
 *  - Input `upperHalf` + `lowerHalf` are NOT consumed — caller still owns
 *    them and must `.delete()` them when done.
 *  - Output `updatedUpper` + `updatedLower` are FRESH — caller owns them.
 *  - Every intermediate Manifold (tools, unions) is `.delete()`-d before
 *    returning via `try/finally` blocks.
 *
 * @param toplevel Initialised Manifold toplevel handle.
 * @param upperHalf Upper silicone half from the Wave-1 split. Kept alive by
 *   the caller.
 * @param lowerHalf Lower silicone half from the Wave-1 split. Kept alive
 *   by the caller.
 * @param shellBbox AABB of the silicone body (both halves combined) in
 *   the oriented frame. Used to compute ring widths for key positioning.
 * @param partingY Y coordinate of the parting plane — the tool is
 *   positioned so its mid-plane sits exactly on this Y.
 * @param wallThickness_mm Silicone wall thickness, for key sizing.
 * @param style Key shape. Defaults to `'asymmetric-hemi'`.
 * @returns Fresh Manifolds (upper with recesses, lower with protrusions).
 * @throws `GeometryError` if the ring is too thin for any key.
 * @throws `Error` if any CSG step produces a non-manifold result.
 */
export function stampRegistrationKeys(
  toplevel: ManifoldToplevel,
  upperHalf: Manifold,
  lowerHalf: Manifold,
  shellBbox: { min: readonly number[]; max: readonly number[] },
  partingY: number,
  wallThickness_mm: number,
  style: RegistrationKeyStyle = 'asymmetric-hemi',
): RegistrationKeysResult {
  assertValid(upperHalf, 'input upper half');
  assertValid(lowerHalf, 'input lower half');

  const layout = computeKeyLayout(shellBbox, wallThickness_mm);

  // Resource-tracking discipline: every Manifold we allocate goes into
  // one of these holders and gets `.delete()`-d by the outer finally.
  // The two OUTPUT Manifolds (updatedUpper / updatedLower) are nulled
  // out once we're ready to hand them to the caller — a null is a
  // no-op in the cleanup loop.
  const tools: Manifold[] = [];
  let updatedUpper: Manifold | undefined;
  let updatedLower: Manifold | undefined;
  try {
    // Dispatch on key style. Each branch produces a single `keyUnion`
    // Manifold — the combined tool covering all 3 key positions — which
    // we then subtract from the upper half and add to the lower half.
    //
    // For 'asymmetric-hemi' and 'cone': all 3 keys share ONE rotation-
    // symmetric tool, which we translate to each position and union.
    // For 'keyhole': each of the 3 keys has its own radial orientation,
    // so we build 3 oriented tools and union them.
    let keyUnion: Manifold;

    if (style === 'asymmetric-hemi' || style === 'cone') {
      const origin: Manifold =
        style === 'asymmetric-hemi'
          ? buildKeySphere(toplevel, layout.radius)
          : buildConeTool(toplevel, layout.radius);
      tools.push(origin);

      const translated: Manifold[] = [];
      for (const pos of layout.positions) {
        const t = origin.translate([pos.x, partingY, pos.z]);
        tools.push(t);
        translated.push(t);
      }
      keyUnion = toplevel.Manifold.union(translated);
    } else if (style === 'keyhole') {
      // Each position gets its own oriented tool. Build each at origin,
      // translate to the layout XZ + partingY, push the translated
      // handle onto `translated` for the final union.
      const translated: Manifold[] = [];
      for (let i = 0; i < layout.positions.length; i++) {
        const pos = layout.positions[i]!;
        const direction = keyholeDirectionForIndex(i);
        const oriented = buildKeyholeTool(toplevel, layout.radius, direction);
        tools.push(oriented);
        const t = oriented.translate([pos.x, partingY, pos.z]);
        tools.push(t);
        translated.push(t);
      }
      keyUnion = toplevel.Manifold.union(translated);
    } else {
      // Exhaustiveness check — a runtime string bypasses the compile-
      // time union check, so fail loudly here rather than silently
      // producing empty keys.
      const exhaustive: never = style;
      throw new Error(
        `stampRegistrationKeys: unknown style ${String(exhaustive)}`,
      );
    }
    tools.push(keyUnion);
    assertValid(keyUnion, `registration-key ${style} union`);

    // Stamp: upper half −= key union (carves three recesses above the
    // parting plane); lower half += key union (adds three protrusions
    // above the parting plane; the below-plane halves are absorbed).
    updatedUpper = upperHalf.subtract(keyUnion);
    assertValid(updatedUpper, 'upper half after key recess subtraction');

    updatedLower = lowerHalf.add(keyUnion);
    assertValid(updatedLower, 'lower half after key protrusion union');

    // Output ownership transfers to the caller — nothing more to do.
    const out = { updatedUpper, updatedLower };
    updatedUpper = undefined;
    updatedLower = undefined;
    return out;
  } catch (err) {
    // If we got as far as creating output Manifolds but then threw, the
    // caller never sees them — release them here.
    if (updatedUpper) updatedUpper.delete();
    if (updatedLower) updatedLower.delete();
    throw err;
  } finally {
    // Release every intermediate tool. Unconditional — the successful
    // path and the throw path both pass through here, and the outputs
    // are not in `tools`.
    for (const t of tools) t.delete();
  }
}
