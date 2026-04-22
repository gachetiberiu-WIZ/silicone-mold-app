// src/geometry/brim.ts
//
// Wave F (issue #84). Build a flat brim flange on each cut face of a
// sliced shell piece. The brim is a box-extruded flange sitting FLUSH
// against the cut plane on the piece's side, extending radially outward
// from the shell's outer surface by `brimWidth_mm`, with a small
// `bondOverlap` inward into the shell wall for mechanical bonding.
// Vertically it spans the shell's Y range minus a 2 mm margin top +
// bottom so it never pokes out the open pour edge or the base-slab
// interlock.
//
// Issue #89 fix (post-dogfood on main 2026-04-22)
// -----------------------------------------------
//
// Pre-#89 the brim box spanned the FULL radial extent from `xzCenter`
// to `outerRadius + brimWidth + slop`, i.e. it extended all the way
// through the silicone cavity to the Y-axis. Two consequences were
// visible in the viewer:
//
//   1. Adjacent brims OVERLAPPED at the Y-axis centerline (all N cut
//      planes meet there) — brim-on-brim intersection in a thin column.
//   2. Brim's inner portion sat INSIDE the shell's outer surface →
//      intruded into the silicone cavity.
//
// The fix, applied in two complementary changes:
//
//   (A) NARROW the brim box radially. Its radial span is now
//       `bondOverlap + brimWidth` — typically 8+10 = 18 mm (vs ~50 mm
//       pre-fix on a mini-figurine). Its inner edge sits at
//       `outerRadius − bondOverlap`, outer edge at
//       `outerRadius + brimWidth`. Far enough from the Y-axis that
//       adjacent brims never touch.
//   (B) SUBTRACT `siliconeOuter` from the brim box before unioning.
//       `siliconeOuter` is the outset of the master by
//       `siliconeThickness` — a SOLID Manifold filling everything from
//       the master's surface outward by the silicone layer, i.e. the
//       shell's inner cavity volume. Subtracting it carves away any
//       brim material that would poke into the silicone cavity, even
//       on non-convex masters where the radial narrowing alone isn't
//       enough to clear the cavity.
//
// After (A) + (B), the brim:
//   - Starts at the shell's outer surface (with a `bondOverlap ≡
//     printShellThickness` inward overlap for mechanical bonding).
//   - Extends outward by `brimWidth`.
//   - Never crosses into the silicone cavity.
//   - Never reaches the Y-axis (so adjacent brims never intersect).
//
// Construction sequence (post-#89):
//
//   1. Build an axis-aligned box of size
//        `(bondOverlap + brimWidth) × ySize × brimThickness`
//      centered at origin.
//   2. Pre-translate the box in its LOCAL frame so its center sits at
//        `( (outerRadius + brimWidth/2 − bondOverlap/2), yCenter,
//          ±brimThickness/2 )`
//      — the local-X offset places the inner edge at radial distance
//      `outerRadius − bondOverlap` and the outer edge at
//      `outerRadius + brimWidth`; `±brimThickness/2` along local ±Z
//      keeps the brim FLUSH against the cut plane on the piece's side.
//   3. Rotate `.rotate([0, -θ_deg, 0])` about +Y where θ is the cut-
//      plane's outward-radial angle. Maps local +X → `radial(θ) =
//      (cos θ, 0, sin θ)` and local +Z → `n_CCW(θ) = (-sin θ, 0, cos θ)`
//      (derivation below).
//   4. Translate by `(xzCenter.x, 0, xzCenter.z)` to plant the box's
//      inner pivot at the master's XZ center.
//   5. `Manifold.difference([brimBox, siliconeOuter])` — carves away
//      any material inside the silicone cavity (belt-and-braces for
//      non-convex masters; a no-op on convex ones where step 2's
//      narrow box is already clear of the cavity).
//   6. `Manifold.union(piece, brimCarved)` — the union absorbs the
//      bond-overlap portion with the shell piece and contributes only
//      the radially outward portion as a new flange.
//
// Why `±brimThickness/2`? For the CCW-side cut plane (piece i's LOWER-
// CCW bound at angle a0), the "into piece" direction is `n_CCW(a0)` —
// exactly the local +Z after rotation, so `+brimThickness/2`. For the
// CW-side cut plane (upper-CCW bound at a1), "into piece" is
// `-n_CCW(a1)` — exactly the local -Z after rotation, so
// `-brimThickness/2`. Flipping the local Z offset sign keeps the
// rotation angle consistent with the outward-radial direction on BOTH
// cut planes.
//
// Why `bondOverlap`? Mechanical bond between the brim flange and the
// shell wall: the brim overlaps INWARD by `bondOverlap` mm past the
// shell's outer surface, so after union the two are a single fused
// body rather than two surfaces touching. `bondOverlap` is set to
// `printShellThickness_mm` by the caller (default 8 mm) — the full
// shell thickness. Can't exceed the shell thickness or the brim pokes
// through into the silicone (which is why step 5 then subtracts
// `siliconeOuter`).
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
//   - Input `siliconeOuter` is CALLER-OWNED; addBrim does NOT delete
//     it. Caller retains responsibility for the full lifetime —
//     defer the `siliconeOuter.delete()` in `generateMold.ts` until
//     AFTER every `addBrim` call for every piece completes.
//   - Every intermediate Manifold is `.delete()`-ed in a `finally`
//     block so no leak happens on any failure path.

import type { Manifold, ManifoldToplevel } from 'manifold-3d';

import { pieceMidAngleRad } from './shellSlicer';
import { SIDE_CUT_ANGLES } from './sideAngles';

/** Margin (mm) the brim recedes from the shell's Y-min and Y-max. */
const BRIM_Y_MARGIN_MM = 2;

/**
 * Multiplier applied to `printShellThickness_mm` to compute `bondOverlap`
 * — how far the brim extends INWARD past the shell's outer surface so
 * it fuses mechanically with the shell wall after the union.
 *
 * Issue #94 Fix 2 (polish dogfood 2026-04-22) — user reported the brim
 * "looks tacked on" with a visible seam where it meets the shell.
 * Investigation confirmed the brim IS `Manifold.union`-ed with each
 * piece (single Manifold per piece, single mesh downstream; scene module
 * mounts `sideCount` meshes, not `sideCount * 2`). This is case B from
 * the issue: a real watertight surface with a sharp material-change
 * angle, not a topological disjoint.
 *
 * First mitigation (#94): bump 1× → 1.5× the shell thickness.
 *
 * Issue #97 Fix 4 (polish dogfood 2026-04-21 round 3): the 1.5× bump
 * still looked like a floating fin in the re-dogfood session. Going
 * further to 2× — the brim's inner face now sits a full `shellThickness`
 * DEEPER inside the shell material than its outer surface, so the
 * fused profile transitions over twice the original bond depth. The
 * siliconeOuter carve-out (step 5 of addBrim) still removes any inward
 * intrusion past the shell's inner cavity — going past the shell
 * thickness is harmless because the cavity subtract clips any material
 * that would have poked through.
 *
 * A true fillet at the brim/shell junction is the right long-term fix
 * (#96 tracks the fillet work). This dimensional tweak takes the visual
 * sharpness further toward "integrated flange" with zero new boolean
 * ops on the common path.
 */
const BOND_OVERLAP_MULTIPLIER = 2.0;

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
  /**
   * Silicone-outer Manifold — the solid blob equal to the master offset
   * outward by `siliconeThickness_mm`, i.e. the shell's INNER cavity
   * volume. Used as a carve-out to ensure the brim box never intrudes
   * into the silicone cavity (issue #89).
   *
   * CALLER-OWNED: `addBrim` does NOT `.delete()` this Manifold. The
   * caller retains the handle for the full lifetime (multiple
   * `addBrim` calls may share the same `siliconeOuter`).
   */
  siliconeOuter: Manifold;
  /**
   * Print shell thickness (mm) — used as the `bondOverlap` distance
   * the brim extends INWARD past the shell's outer surface. Creates a
   * shell-thick mechanical bond between brim and shell wall after the
   * final union (issue #89).
   */
  printShellThickness_mm: number;
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
    siliconeOuter,
    printShellThickness_mm,
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

  // Issue #89 fix (A): NARROW radial box.
  //
  // `bondOverlap` = `BOND_OVERLAP_MULTIPLIER × printShellThickness_mm`
  // — how far the brim extends INWARD past the shell's outer surface,
  // to fuse mechanically with the shell wall after the union. The
  // multiplier was bumped from 1× to 1.5× in issue #94 (polish
  // dogfood 2026-04-22) so the brim/shell junction transitions more
  // organically and the brim no longer looks "tacked on". The total
  // radial width of the box is therefore `bondOverlap + brimWidth`.
  // Its local +X frame:
  //   - inner edge at local x = 0            → world radial
  //                                             `outerRadius - bondOverlap`
  //   - outer edge at local x = width        → world radial
  //                                             `outerRadius + brimWidth`
  // so the box's LOCAL center sits at x = width/2 and the world-space
  // offset applied in step 4 plants that center at world radial
  // `outerRadius + brimWidth/2 - bondOverlap/2` from xzCenter.
  //
  // Can legitimately exceed the shell thickness — step 5 (silicone-
  // cavity subtract) carves any intrusion past the shell's inner
  // cavity. The carve-out makes `bondOverlap` strictly a visual/
  // mechanical-bonding knob independent of the hard "no poking the
  // silicone" invariant.
  const bondOverlap = Math.max(
    0,
    BOND_OVERLAP_MULTIPLIER * printShellThickness_mm,
  );
  const width = bondOverlap + brimWidth_mm;

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

      // Step 1: centered box. Dimensions:
      //   x: `width = bondOverlap + brimWidth`
      //   y: `ySize` (shell Y range minus 2 × margin)
      //   z: `brimThickness`
      const box = toplevel.Manifold.cube(
        [width, ySize, brimThickness_mm],
        /* center */ true,
      );
      tempHandles.push(box);

      // Step 2: translate in local frame so:
      //   local-x center at `outerRadius + brimWidth/2 - bondOverlap/2`:
      //     inner edge at `outerRadius - bondOverlap`,
      //     outer edge at `outerRadius + brimWidth`.
      //   local-y center at 0 — Y translation lands in step 4.
      //   local-z center at `localZSign * brimThickness/2` — box sits
      //     FLUSH against the cut plane on the piece's side
      //     (thickness spans [0, brimThickness] in local +Z direction
      //     when localZSign = +1, or [-brimThickness, 0] when -1).
      const localX = shellOuterRadius + brimWidth_mm / 2 - bondOverlap / 2;
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

      // Step 5 (issue #89 fix B): carve the silicone cavity out of the
      // brim box. On convex masters this is effectively a no-op since
      // (A)'s narrow radial slab already clears the shell's outer
      // surface; on non-convex masters (e.g. a figurine with concave
      // pockets) the brim's inner face can dip INTO the silicone
      // cavity, and this subtract removes that intrusion.
      //
      // `siliconeOuter` is the master offset outward by
      // `siliconeThickness_mm` — a SOLID Manifold equal to the shell's
      // inner-cavity volume. `difference([brimBox, siliconeOuter])`
      // carves the cavity's volume out of the brim box. CALLER-OWNED:
      // `siliconeOuter` is NOT disposed here.
      const carved = toplevel.Manifold.difference([placed, siliconeOuter]);
      tempHandles.push(carved);

      // Step 6: union with the running piece.
      const unioned = toplevel.Manifold.union(current, carved);

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
