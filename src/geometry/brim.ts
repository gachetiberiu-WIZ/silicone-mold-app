// src/geometry/brim.ts
//
// Wave F (issue #84). Build a flat brim flange on each cut face of a
// sliced shell piece. The brim is a box-extruded flange sitting FLUSH
// against the cut plane on the piece's side, extending radially outward
// from the master's XZ center by `brimWidth_mm` beyond the shell's outer
// surface. Vertically it spans the shell's Y range minus a 2 mm margin
// top + bottom so it never pokes out the open pour edge or the base-
// slab interlock.
//
// Construction choice (Option A, per issue #84):
//
//   1. Build an axis-aligned box of size
//        `(shellOuterRadius + brimWidth + slop) × ySize × brimThickness`
//      centered at origin.
//   2. Pre-translate the box in its LOCAL frame so its center sits at
//        `( (W - slop)/2, yCenter, ±T/2 )`
//      — `W/2 - slop/2` along local +X so the radial inner edge sits at
//      local x = `-slop` (inside the shell, for a clean boolean-union
//      with the piece's outer surface); `±T/2` along local ±Z so the
//      brim is FLUSH against the cut plane on the piece's side.
//   3. Rotate `.rotate([0, -θ_deg, 0])` about +Y where θ is the cut-
//      plane's outward-radial angle. This maps local +X → `radial(θ) =
//      (cos θ, 0, sin θ)` and local +Z → `n_CCW(θ) = (-sin θ, 0, cos θ)`
//      (derivation below).
//   4. Translate by `(xzCenter.x, 0, xzCenter.z)` to plant the box's
//      inner pivot at the master's XZ center.
//   5. `Manifold.union(piece, brim)` — the union absorbs the inner
//      overlap with the shell piece and contributes only the radially
//      outward portion as a new flange. Watertight by construction
//      (both inputs are watertight manifolds and manifold-3d's union is
//      watertight on such inputs per ADR-002).
//
// Why `±T/2` instead of just `+T/2`? For the CCW-side cut plane (piece
// i's LOWER-CCW bound at angle a0), the "into piece" direction is
// `n_CCW(a0)` — exactly the local +Z after rotation, so `+T/2`. For the
// CW-side cut plane (upper-CCW bound at a1), "into piece" is
// `-n_CCW(a1)` — exactly the local -Z after rotation, so `-T/2`.
// Flipping the local Z offset sign keeps the rotation angle consistent
// with the outward-radial direction on BOTH cut planes.
//
// Why `slop`? Small (5 mm) radial overlap between the brim box and the
// shell piece so the boolean union closes cleanly on the inner-corner
// curvature of the shell. Without this, a degenerate just-touching
// interface can surface as a zero-area seam in `manifold.union` —
// silently producing a non-manifold output. 5 mm is well inside the
// shell thickness (>= 2 mm per parameter constraints) and inside the
// silicone (>= 1 mm) for any realistic parameter combination, so the
// overlap is always interior to the piece's volume and can never leak
// through the shell.
//
// sideCount === 2 special case: only ONE cut plane total (angles 90°
// and 270° define the same vertical plane). The caller (via
// `generateMold.ts`) passes a single cut angle for each piece; the brim
// builder treats it as a single-brim piece.
//
// Rotation-angle derivation
// -------------------------
//
// Manifold's `.rotate([0, φ_deg, 0])` applies the standard right-handed
// Y rotation:
//
//     (x, z) → (x cos φ + z sin φ, -x sin φ + z cos φ)
//
// Applied to local +X = (1, 0, 0): → (cos φ, 0, -sin φ). We want this
// to equal `radial(θ) = (cos θ, 0, sin θ)`, so φ = -θ. Applied to local
// +Z = (0, 0, 1) with φ = -θ: → (sin(-θ), 0, cos(-θ)) = (-sin θ,
// 0, cos θ) = `n_CCW(θ)`. ✓
//
// Ownership contract:
//
//   - Input `piece` Manifold is consumed by the union → the caller
//     receives a FRESH Manifold and must `.delete()` it. The input
//     `piece` is `.delete()`-ed internally.
//   - Every intermediate Manifold is `.delete()`-ed in a `finally`
//     block so no leak happens on any failure path.

import type { Manifold, ManifoldToplevel } from 'manifold-3d';

import { pieceMidAngleRad } from './shellSlicer';
import { SIDE_CUT_ANGLES } from './sideAngles';

/** Small radial overlap between brim and shell so the union seam closes. */
const BRIM_RADIAL_SLOP_MM = 5;
/** Margin (mm) the brim recedes from the shell's Y-min and Y-max. */
const BRIM_Y_MARGIN_MM = 2;

/**
 * Axis-aligned bbox in world mm. Uses the same `{min, max}` of 3-tuples
 * shape as `manifold.boundingBox()` for easy passthrough.
 */
export interface WorldBbox {
  readonly min: { readonly x: number; readonly y: number; readonly z: number };
  readonly max: { readonly x: number; readonly y: number; readonly z: number };
}

export interface AddBrimArgs {
  /** Initialised manifold-3d handle — used for primitive + boolean construction. */
  toplevel: ManifoldToplevel;
  /**
   * Shell piece Manifold. CONSUMED — the caller must NOT use this
   * handle after `addBrim` returns. A fresh Manifold with the brim
   * unioned in is returned.
   */
  piece: Manifold;
  /** 0 .. sideCount-1 — which piece of the radial partition we're brimming. */
  pieceIndex: number;
  /** 2, 3, or 4. */
  sideCount: 2 | 3 | 4;
  /**
   * World-space AABB of the FULL (pre-slice) print shell. Used to
   * derive the shell's outer radius (radial extent from xzCenter) and
   * its Y span.
   */
  shellBboxWorld: WorldBbox;
  /** Master bbox XZ center (world mm). Both cut planes pass through this. */
  xzCenter: { x: number; z: number };
  /** Brim radial width (mm), default 10 from parameters. */
  brimWidth_mm: number;
  /** Brim thickness perpendicular to the cut plane (mm). */
  brimThickness_mm: number;
}

/**
 * Attach `1` brim (sideCount === 2) or `2` brims (sideCount 3 / 4) to a
 * single shell piece, union them with the piece, and return the fresh
 * result. The input `piece` is `.delete()`-ed internally.
 *
 * On any failure, every allocated Manifold (brim boxes, transformed
 * copies, intermediate unions) is disposed before re-throwing. The
 * input `piece` is also disposed on failure so the caller's contract
 * — "never call `.delete()` on `piece` after `addBrim` returns" —
 * holds uniformly on the success AND failure paths.
 */
export function addBrim(args: AddBrimArgs): Manifold {
  const {
    toplevel,
    piece,
    pieceIndex,
    sideCount,
    shellBboxWorld,
    xzCenter,
    brimWidth_mm,
    brimThickness_mm,
  } = args;

  const angles = SIDE_CUT_ANGLES[sideCount];

  // Cuts for this piece:
  //   - CCW (lower) bound at angle a0, brim on +Z local side (into piece).
  //   - CW  (upper) bound at angle a1, brim on -Z local side.
  // sideCount === 2 has only the first cut (the two angles collapse to
  // the same plane, so a second brim would overlap the first).
  const a0Deg = angles[pieceIndex] as number;
  const cuts: Array<{ angleDeg: number; localZSign: 1 | -1 }> = [
    { angleDeg: a0Deg, localZSign: 1 },
  ];
  if (sideCount !== 2) {
    const a1Deg = angles[(pieceIndex + 1) % sideCount] as number;
    cuts.push({ angleDeg: a1Deg, localZSign: -1 });
  }

  // Shell outer radius — maximum horizontal extent of the shell's world
  // AABB from `xzCenter` on any of the four face directions (±X / ±Z).
  // This is a bit loose (an actual surface-conforming shell is closer
  // to `max radial distance`), but the +brimWidth beyond still plants
  // the flange comfortably outside the shell wall on every cut angle
  // in the partition — the box is a radial slab, its outer edge is
  // always at `xzCenter + (outerRadius + brimWidth) * r` along the cut
  // direction, which on any sideCount lies outside the shell AABB.
  const dxPos = shellBboxWorld.max.x - xzCenter.x;
  const dxNeg = xzCenter.x - shellBboxWorld.min.x;
  const dzPos = shellBboxWorld.max.z - xzCenter.z;
  const dzNeg = xzCenter.z - shellBboxWorld.min.z;
  const shellOuterRadius = Math.max(dxPos, dxNeg, dzPos, dzNeg);

  const shellMinY = shellBboxWorld.min.y;
  const shellMaxY = shellBboxWorld.max.y;
  // Brim Y span: receded from the shell's Y range by `BRIM_Y_MARGIN_MM`
  // top + bottom, clamped to >= 0 (a pathological tiny shell could
  // otherwise produce a negative ySize).
  const ySize = Math.max(0, shellMaxY - shellMinY - 2 * BRIM_Y_MARGIN_MM);
  const yCenter = (shellMinY + shellMaxY) / 2;

  // Radial box width: shell outer radius + brim flange width + inner
  // overlap slop. Local +X runs from `-slop` (inside shell) to
  // `shellOuterRadius + brimWidth` (outer flange edge).
  const width = shellOuterRadius + brimWidth_mm + BRIM_RADIAL_SLOP_MM;

  if (ySize <= 0 || width <= 0 || brimThickness_mm <= 0) {
    // Nothing sensible to build — return the piece unchanged. The
    // caller owns the returned handle either way.
    return piece;
  }

  // `current` is the running Manifold: start with the piece, union each
  // brim in turn, release the previous handle after each union.
  //
  // Lifetime invariants tracked for the failure path:
  //   - `pieceConsumed` flips `true` the first time we release the
  //     caller's original `piece` (either via `.delete()` inside the
  //     loop, or — on throw before the first union completes — via
  //     the catch block below).
  //   - `tempHandles` holds every ephemeral box/transform handle so
  //     the catch can release them in bulk.
  let current: Manifold = piece;
  let pieceConsumed = false;
  const tempHandles: Manifold[] = [];

  const safeDelete = (m: Manifold): void => {
    try {
      m.delete();
    } catch {
      /* already dead */
    }
  };

  try {
    for (const cut of cuts) {
      // Rotation angle — see header comment for derivation.
      // φ = -θ about +Y maps local +X → radial(θ), local +Z →
      // n_CCW(θ). Manifold `.rotate` takes DEGREES.
      const rotY_deg = -cut.angleDeg;

      // Step 1: centered box.
      const box = toplevel.Manifold.cube(
        [width, ySize, brimThickness_mm],
        /* center */ true,
      );
      tempHandles.push(box);

      // Step 2: translate in local frame so:
      //   local-x center at (W - slop)/2 → inner edge at -slop, outer
      //     edge at W - slop = shellOuterRadius + brimWidth.
      //   local-y center at 0 — we'll translate Y in step 4.
      //   local-z center at `localZSign * brimThickness/2` — box sits
      //     FLUSH against the cut plane on the piece's side
      //     (thickness spans [0, brimThickness] in local +Z direction
      //     when localZSign = +1, or [-brimThickness, 0] when -1).
      const localX = (width - BRIM_RADIAL_SLOP_MM) / 2;
      const localZ = (cut.localZSign * brimThickness_mm) / 2;
      const localShifted = box.translate([localX, 0, localZ]);
      tempHandles.push(localShifted);

      // Step 3: rotate about +Y so local axes align with world cut
      // directions. See header comment for the φ = -θ derivation.
      const rotated = localShifted.rotate([0, rotY_deg, 0]);
      tempHandles.push(rotated);

      // Step 4: translate to world — plant the rotated box so its inner
      // pivot is at (xzCenter.x, yCenter, xzCenter.z).
      const placed = rotated.translate([xzCenter.x, yCenter, xzCenter.z]);
      tempHandles.push(placed);

      // Step 5: union with the running piece.
      const unioned = toplevel.Manifold.union(current, placed);

      // Swap running handle. `current` is either the original caller
      // `piece` (iteration 0) or a prior union result (iteration >= 1);
      // either way it's safe to release at this point — the new
      // `unioned` fully contains its volume.
      safeDelete(current);
      if (current === piece) pieceConsumed = true;
      current = unioned;
    }

    // Release every intermediate brim-box handle. The final `current`
    // has absorbed their volume via union.
    for (const h of tempHandles) safeDelete(h);
    return current;
  } catch (err) {
    for (const h of tempHandles) safeDelete(h);
    // Release the running `current` if it is NOT the original piece
    // (either a prior union result that hasn't been consumed by the
    // next iteration, or the piece itself on an iteration-0 throw).
    if (current !== piece) {
      safeDelete(current);
    }
    // Always release the original piece — caller's contract is it's
    // consumed regardless of success/failure.
    if (!pieceConsumed) safeDelete(piece);
    throw err;
  }
}

/** Outward mid-direction unit vector for piece `pieceIndex` in the partition. */
export function pieceOutwardDir(
  sideCount: 2 | 3 | 4,
  pieceIndex: number,
): { x: number; z: number } {
  const mid = pieceMidAngleRad(sideCount, pieceIndex);
  return { x: Math.cos(mid), z: Math.sin(mid) };
}
