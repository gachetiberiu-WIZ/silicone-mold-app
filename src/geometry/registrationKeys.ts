// src/geometry/registrationKeys.ts
//
// Registration-key stamping — Phase 3c Wave 3 (issue #55, step 3).
//
// Places three hemispherical "keys" along the parting plane (horizontal at
// `shellBbox` mid-Y from Waves 1-2) that protrude from the lower silicone
// half and recess into the upper silicone half. Two symmetric keys sit on
// ±X in the XZ plane; a third asymmetric key sits on +Z alone. The
// asymmetry enforces assembly orientation — rotating the upper half 180°
// about Y moves the +Z key to −Z, where the lower half has no matching
// protrusion, so the halves will not mate.
//
// Locked design decisions (from issue #55, do NOT re-litigate):
//   - Only `asymmetric-hemi` style this wave; `cone` + `keyhole` throw
//     `InvalidParametersError` upstream at the generator entry.
//   - 3 keys: (-0.35·ringWidth_X, 0), (+0.35·ringWidth_X, 0), (0, +0.35·ringWidth_Z).
//   - Hemisphere diameter = min(4.0, 0.3·wallThickness_mm).
//   - Inside-ring constraint: `|coord| < ringWidth/2 − radius − 1.0 mm`
//     with 1 mm clearance to the silicone outer face.
//   - Clamp inward if the default 0.35 multiplier overshoots the safe zone;
//     throw `GeometryError` if no valid placement exists.
//
// Clamping formula (agent-chosen, documented here and in the PR body):
//
//   For each axis we compute the maximum multiplier `m_max` such that the
//   key stays inside the safe zone:
//
//     |m · ringWidth/2| <= ringWidth/2 − radius − 1.0
//     → m_max = (ringWidth/2 − radius − 1.0) / (ringWidth/2)
//
//   If `m_max <= 0` the ring is narrower than `2·radius + 2.0 mm` on that
//   axis — we throw `GeometryError("silicone ring too thin...")`. Otherwise
//   the actual key offset is `min(0.35, m_max) · ringWidth/2`. The default
//   0.35 multiplier wins when the ring is wide enough; the clamp kicks in
//   on narrow masters (e.g. the issue's 20×10×10 tall-skinny test case).
//
// Manifold ownership
// ------------------
//
// Every intermediate Manifold created by this module (hemisphere tools,
// unions, per-key stamps) is `.delete()`-d inside a `try/finally` before
// returning. The caller receives exactly TWO fresh Manifolds:
//   - `updatedUpper` — the upper silicone half minus the key recesses
//   - `updatedLower` — the lower silicone half plus the key protrusions
// The ORIGINAL `upperHalf` + `lowerHalf` Manifolds passed in are NOT
// consumed — the caller still owns them and must `.delete()` them
// separately. This lets the orchestrator choose whether to replace its
// half-references or keep the un-keyed versions for debugging.

import type { Manifold, ManifoldToplevel } from 'manifold-3d';

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
 * Result of `stampRegistrationKeys`. Contains the two fresh silicone
 * half-Manifolds with keys applied. Caller owns both — `.delete()` each
 * when done.
 */
export interface RegistrationKeysResult {
  /** Upper silicone half with three hemispherical recesses. */
  readonly updatedUpper: Manifold;
  /** Lower silicone half with three hemispherical protrusions. */
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
 * Stamp three registration keys onto the silicone halves along the parting
 * plane at `partingY`. Returns fresh upper + lower Manifolds with the
 * recesses + protrusions applied.
 *
 * Ownership contract:
 *  - Input `upperHalf` + `lowerHalf` are NOT consumed — caller still owns
 *    them and must `.delete()` them when done.
 *  - Output `updatedUpper` + `updatedLower` are FRESH — caller owns them.
 *  - Every intermediate Manifold (hemispheres, unions) is `.delete()`-d
 *    before returning via `try/finally` blocks.
 *
 * @param toplevel Initialised Manifold toplevel handle.
 * @param upperHalf Upper silicone half from the Wave-1 split. Kept alive by
 *   the caller.
 * @param lowerHalf Lower silicone half from the Wave-1 split. Kept alive
 *   by the caller.
 * @param shellBbox AABB of the silicone body (both halves combined) in
 *   the oriented frame. Used to compute ring widths for key positioning.
 * @param partingY Y coordinate of the parting plane — the hemispheres
 *   are positioned so their flat-side sits exactly on this plane.
 * @param wallThickness_mm Silicone wall thickness, for key sizing.
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
): RegistrationKeysResult {
  assertValid(upperHalf, 'input upper half');
  assertValid(lowerHalf, 'input lower half');

  const layout = computeKeyLayout(shellBbox, wallThickness_mm);

  // Resource-tracking discipline: every Manifold we allocate goes into
  // one of these holders and gets `.delete()`-d by the outer finally.
  // The two OUTPUT Manifolds (updatedUpper / updatedLower) are nulled
  // out of `outputs[]` once we're ready to hand them to the caller — a
  // null is a no-op in the cleanup loop.
  const tools: Manifold[] = [];
  let updatedUpper: Manifold | undefined;
  let updatedLower: Manifold | undefined;
  try {
    // Build one origin-centred sphere "stamp", translate it to each key's
    // XZ + partingY. Each translate produces a fresh Manifold; we delete
    // the origin-centred source after all three translations land. The
    // same tool geometry is used on both halves — the upper half's
    // subtract carves the protrusion hemisphere, the lower half's union
    // fills only the above-parting-plane hemisphere (the below-plane
    // hemisphere is already inside lower-half material). See
    // `buildKeySphere` JSDoc for why full spheres are preferable to
    // two-tool hemispheres.
    const keyOrigin = buildKeySphere(toplevel, layout.radius);
    tools.push(keyOrigin);

    const translated: Manifold[] = [];
    for (const pos of layout.positions) {
      const t = keyOrigin.translate([pos.x, partingY, pos.z]);
      tools.push(t);
      translated.push(t);
    }

    // Union the per-key stamps into a single tool so each half only sees
    // one boolean op. Single-op avoids per-key kernel noise accumulation
    // on the mating surfaces.
    const keyUnion = toplevel.Manifold.union(translated);
    tools.push(keyUnion);
    assertValid(keyUnion, 'registration-key sphere union');

    // Stamp: upper half -= key union (carves three recesses above the
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
