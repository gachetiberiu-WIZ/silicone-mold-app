// src/geometry/brim.ts
//
// Wave F (issue #84). Build a tapered brim flange on each cut face of
// a sliced shell piece. The brim is a TRAPEZOIDAL prism sitting FLUSH
// against the cut plane on the piece's side, extending radially outward
// from the shell's outer surface by `brimWidth_mm`, with a small
// `bondOverlap` inward into the shell wall for mechanical bonding.
// Vertically it spans the shell's Y range minus a 2 mm margin top +
// bottom at the INNER (shell-junction) edge, tapering DOWN to
// `BRIM_TAPER_FACTOR × ySize` (default 0.5×) at the OUTER edge so the
// flange reads as a real printed buttress blending into the shell
// rather than a tacked-on rectangle with a hard perimeter crease.
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
//   (A) NARROW the brim radially. Its radial span is now
//       `bondOverlap + brimWidth` — typically 8+10 = 18 mm (vs ~50 mm
//       pre-fix on a mini-figurine). Its inner edge sits at
//       `outerRadius − bondOverlap`, outer edge at
//       `outerRadius + brimWidth`. Far enough from the Y-axis that
//       adjacent brims never touch.
//   (B) SUBTRACT `siliconeOuter` from the brim solid before unioning.
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
//     BOND_OVERLAP_MULTIPLIER × printShellThickness` inward overlap
//     for mechanical bonding).
//   - Extends outward by `brimWidth`.
//   - Never crosses into the silicone cavity.
//   - Never reaches the Y-axis (so adjacent brims never intersect).
//
// Issue #96 fix — tapered (trapezoidal) brim
// ------------------------------------------
//
// Up to PR #98 (issue #94 Fix 2 + issue #97 Fix 4) the brim was a
// rectangular box. Even with `BOND_OVERLAP_MULTIPLIER` doubled to 2×
// the shell thickness, the outer perimeter still read as a sharp fin
// from the side — flat top, flat bottom, square corners where the
// brim's vertical faces met the curved shell surface.
//
// The fix builds the brim as a trapezoidal prism that is FULL height
// (`ySize`) at the inner/shell-junction edge and tapers DOWN to
// `BRIM_TAPER_FACTOR × ySize` at the outer radial edge. In side view
// the brim is a trapezoid (wider against the shell, narrower at the
// free edge), which blends into the shell's outer surface without a
// hard top/bottom corner at the union boundary.
//
// Implementation uses `CrossSection.extrude` with `scaleTop = [1,
// BRIM_TAPER_FACTOR]`:
//
//   - CrossSection: centred rectangle in the (X, Y) plane sized
//     `brimThickness × ySize`. Local X here is the PERPENDICULAR-TO-
//     CUT direction (flange thickness); local Y is the world-vertical
//     direction.
//   - `extrude(width, 0, 0, [1, BRIM_TAPER_FACTOR])` extrudes along
//     local Z by `width = bondOverlap + brimWidth`. The top of the
//     extrusion (Z = width, outer radial edge) scales the Y dimension
//     to `ySize × BRIM_TAPER_FACTOR`; X (thickness) stays 1×.
//   - The resulting trapezoidal prism's local frame is:
//       +X = flange thickness (perpendicular to cut plane)
//       +Y = world vertical
//       +Z = radial outward (extrusion axis)
//
// The rotation into world is `.rotate([0, 90 − θ_deg, 0])` — derivation
// below. This sends local +Z → `radial(θ) = (cos θ, 0, sin θ)` and
// local +X → `−n_CCW(θ)`. The sign of the thickness offset is chosen
// per cut so the brim sits on the piece's side of each cut plane.
//
// Volume: a trapezoidal prism with end heights `ySize` and
// `ySize × k` has volume `brimThickness × width × ySize × (1 + k) / 2`.
// For `k = 0.5` that is 75 % of the former rectangular-box volume —
// ~25 % less print material per flange.
//
// Construction sequence (post-#96):
//
//   1. Build `CrossSection.square([brimThickness, ySize], center=true)`
//      — a centred 2D rectangle in the (X, Y) plane.
//   2. Shift the CrossSection along X by `−sign × brimThickness / 2`
//      so the thickness range is `[−brimThickness, 0]` for sign = +1
//      (CCW-side cut) or `[0, brimThickness]` for sign = −1 (CW-side
//      cut). After the Y rotation (which maps local +X → −n_CCW(θ)),
//      world-space thickness lands on `[0, brimThickness]` along
//      `+n_CCW(θ)` (sign +1) or `−n_CCW(θ)` (sign −1) — i.e. ON the
//      piece's side of the cut plane.
//   3. `extrude(width, 0, 0, [1, BRIM_TAPER_FACTOR])` — trapezoidal
//      prism along local +Z.
//   4. `.rotate([0, 90 − θ_deg, 0])` about +Y to align local +Z with
//      world `radial(θ)`.
//   5. `.translate([xzCenter.x + (outerRadius − bondOverlap) × cos θ,
//       yCenter, xzCenter.z + (outerRadius − bondOverlap) × sin θ])`
//      — shifts the base of the prism (local Z = 0 plane) to sit at
//      world radial distance `outerRadius − bondOverlap` on the cut
//      line and centres it vertically on the shell.
//   6. `Manifold.difference([brim, siliconeOuter])` — carves any
//      portion that dips into the silicone cavity (belt-and-braces
//      for non-convex masters where the narrow radial slab alone
//      doesn't clear the cavity).
//   7. `Manifold.union(piece, brimCarved)` — absorbs the bondOverlap
//      portion into the shell wall and keeps the tapered flange as a
//      new unified surface.
//
// Why `±brimThickness/2` on local X? For the CCW-side cut plane (piece
// i's lower-CCW bound at angle a0), the "into piece" direction is
// `+n_CCW(a0)`. Our rotation maps local +X → `−n_CCW(a0)`, so we need
// the CrossSection's thickness range to be on the LOCAL-NEGATIVE X
// side of the origin: translate by `−brimThickness/2` along local X.
// For the CW-side cut plane at a1, "into piece" is `−n_CCW(a1)` —
// matches our rotation's local +X → `−n_CCW(a1)` — so thickness range
// sits on LOCAL-POSITIVE X: translate by `+brimThickness/2` along
// local X. The `localXSign` field on each cut entry is `−1 / +1`
// respectively so the pre-translate is just `localXSign ×
// brimThickness / 2`.
//
// Why `bondOverlap`? Mechanical bond between the brim flange and the
// shell wall: the brim overlaps INWARD by `bondOverlap` mm past the
// shell's outer surface, so after union the two are a single fused
// body rather than two surfaces touching. `bondOverlap` is
// `BOND_OVERLAP_MULTIPLIER × printShellThickness` (default 2× → 16 mm
// at an 8 mm shell). Can legitimately exceed the shell thickness —
// step 6 (silicone-cavity subtract) carves any intrusion past the
// shell's inner cavity, so `bondOverlap` is strictly a visual/mechan-
// ical-bonding knob independent of the hard "no poking the silicone"
// invariant.
//
// sideCount === 2 special case: only ONE cut plane total (angles 90°
// and 270° define the same vertical plane). The caller (via
// `generateMold.ts`) passes a single cut angle for each piece; the
// brim builder treats it as a single-brim piece.
//
// Rotation-angle derivation
// -------------------------
//
// Manifold's `.rotate([0, φ_deg, 0])` applies the standard right-handed
// Y rotation:
//
//     (x, z) → (x cos φ + z sin φ, −x sin φ + z cos φ)
//
// We want local +Z = (0, 0, 1) to map to `radial(θ) = (cos θ, 0,
// sin θ)`. Applying the formula to (0, 1): → (sin φ, cos φ). Setting
// equal to (cos θ, sin θ) gives sin φ = cos θ and cos φ = sin θ, i.e.
// φ = 90° − θ. Applying the same φ to local +X = (1, 0): → (cos φ,
// −sin φ) = (sin θ, −cos θ) = `−n_CCW(θ)` (since n_CCW(θ) = (−sin θ,
// cos θ) in the (x, z) plane). ✓
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
//   - Every intermediate Manifold / CrossSection is `.delete()`-ed in
//     a `finally` / catch block so no leak happens on any failure
//     path.

import type { CrossSection, Manifold, ManifoldToplevel } from 'manifold-3d';

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
 * siliconeOuter carve-out (step 6 of addBrim) still removes any inward
 * intrusion past the shell's inner cavity — going past the shell
 * thickness is harmless because the cavity subtract clips any material
 * that would have poked through.
 *
 * Issue #96 replaced the rectangular box with a TAPERED (trapezoidal)
 * prism that reduces the outer perimeter's vertical extent. The bond
 * depth stays doubled because the union now takes a tapered flange
 * INTO a deep shell — both changes compose and the junction reads as
 * an integrated buttress.
 */
const BOND_OVERLAP_MULTIPLIER = 2.0;

/**
 * Issue #96 — tapered-brim scale factor. The brim's OUTER radial edge
 * has its vertical height scaled by this factor relative to the INNER
 * (shell-junction) edge. 1.0 is the pre-#96 rectangular box; 0.0
 * collapses the outer edge to a line (pure triangular prism). 0.5 was
 * selected as the sweet spot: enough taper to visibly blend into the
 * shell without so much that the outer edge becomes a knife edge the
 * user can't print reliably.
 *
 * Volume effect: brim volume is `brimThickness × radialWidth × ySize ×
 * (1 + BRIM_TAPER_FACTOR) / 2` — 25 % less than the former box at 0.5.
 *
 * Must be a positive finite value <= 1. Values > 1 would GROW the
 * outer edge (creating an inverted/overhang flange — not supported).
 */
const BRIM_TAPER_FACTOR = 0.5;

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
  //   - CCW (lower) bound at angle a0: piece sits on +n_CCW(a0) side
  //     of the cut plane; our rotation maps local +X → −n_CCW(θ), so
  //     the thickness range needs to be on LOCAL-NEGATIVE X
  //     (`localXSign = −1`, pre-translate by `−brimThickness/2`).
  //   - CW  (upper) bound at angle a1: piece sits on −n_CCW(a1) side;
  //     thickness range on LOCAL-POSITIVE X (`localXSign = +1`,
  //     pre-translate by `+brimThickness/2`).
  // sideCount === 2 has only the first cut (the two angles collapse
  // to the same plane, so a second brim would overlap the first).
  const a0Deg = angles[pieceIndex] as number;
  const cuts: Array<{ angleDeg: number; localXSign: 1 | -1 }> = [
    { angleDeg: a0Deg, localXSign: -1 },
  ];
  if (sideCount !== 2) {
    const a1Deg = angles[(pieceIndex + 1) % sideCount] as number;
    cuts.push({ angleDeg: a1Deg, localXSign: 1 });
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

  // Issue #89 fix (A) + #96 taper: NARROW radial span, tapered
  // trapezoidal prism.
  //
  // `bondOverlap` = `BOND_OVERLAP_MULTIPLIER × printShellThickness_mm`
  // — how far the brim extends INWARD past the shell's outer surface,
  // to fuse mechanically with the shell wall after the union. The
  // multiplier was bumped from 1× to 1.5× in issue #94 (polish
  // dogfood 2026-04-22), then to 2× in issue #97 Fix 4.
  //
  // Total radial width of the brim is `bondOverlap + brimWidth`.
  // Radial layout (measured from `xzCenter` along the cut's outward
  // radial direction):
  //   - inner edge at `outerRadius - bondOverlap`,
  //   - outer edge at `outerRadius + brimWidth`.
  //
  // Can legitimately exceed the shell thickness — step 6 (silicone-
  // cavity subtract) carves any intrusion past the shell's inner
  // cavity. The carve-out makes `bondOverlap` strictly a visual/
  // mechanical-bonding knob independent of the hard "no poking the
  // silicone" invariant.
  const bondOverlap = Math.max(
    0,
    BOND_OVERLAP_MULTIPLIER * printShellThickness_mm,
  );
  const width = bondOverlap + brimWidth_mm;
  // Issue #96: distance from `xzCenter` to the brim's inner radial
  // edge. The extrusion starts at local Z = 0 (after rotation, at
  // world position `xzCenter + radialInner × radial(θ)`) and extends
  // outward by `width`.
  const radialInner = shellOuterRadius - bondOverlap;

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
  //   - `tempManifolds` holds every ephemeral brim-prism handle.
  //   - `tempSections` holds every ephemeral CrossSection handle
  //     (manifold-3d CrossSections are WASM-allocated and must be
  //     explicitly `.delete()`-ed).
  let current: Manifold = piece;
  let pieceConsumed = false;
  const tempManifolds: Manifold[] = [];
  const tempSections: CrossSection[] = [];

  const safeDeleteM = (m: Manifold): void => {
    try {
      m.delete();
    } catch {
      /* already dead */
    }
  };
  const safeDeleteCs = (cs: CrossSection): void => {
    try {
      cs.delete();
    } catch {
      /* already dead */
    }
  };

  try {
    for (const cut of cuts) {
      // Rotation angle — see header comment for derivation.
      // φ = 90° − θ about +Y maps local +Z → radial(θ) and local +X →
      // −n_CCW(θ). Manifold `.rotate` takes DEGREES.
      const rotY_deg = 90 - cut.angleDeg;

      // Step 1: centred CrossSection in the local (X, Y) plane.
      // Dimensions: X = brimThickness, Y = ySize. Both centred on the
      // origin.
      const baseCs = toplevel.CrossSection.square(
        [brimThickness_mm, ySize],
        /* center */ true,
      );
      tempSections.push(baseCs);

      // Step 2: shift the CrossSection along local X by
      // `localXSign × brimThickness / 2` so the thickness range sits
      // ON THE PIECE'S SIDE of the cut plane after rotation (see
      // header comment for the signing derivation).
      const shiftedCs = baseCs.translate([
        (cut.localXSign * brimThickness_mm) / 2,
        0,
      ]);
      tempSections.push(shiftedCs);

      // Step 3: extrude the CrossSection along local +Z by `width`,
      // tapering Y at the top (outer edge) to `BRIM_TAPER_FACTOR ×
      // ySize`. X (thickness) is unchanged along the extrusion. The
      // resulting prism has:
      //   - local Z range [0, width] (radial outward),
      //   - inner base (Z = 0): full rectangle
      //       `brimThickness × ySize`,
      //   - outer base (Z = width): scaled rectangle
      //       `brimThickness × (BRIM_TAPER_FACTOR × ySize)`,
      //   - side faces sloping inward in Y only.
      const prism = shiftedCs.extrude(
        width,
        /* nDivisions */ 0,
        /* twistDegrees */ 0,
        /* scaleTop */ [1, BRIM_TAPER_FACTOR],
        /* center */ false,
      );
      tempManifolds.push(prism);

      // Step 4: rotate about +Y so local +Z aligns with world
      // radial(θ) and local +X aligns with world −n_CCW(θ). Local +Y
      // is the rotation axis and stays world +Y.
      const rotated = prism.rotate([0, rotY_deg, 0]);
      tempManifolds.push(rotated);

      // Step 5: translate to world — plant the prism's inner base at
      // `xzCenter + radialInner × radial(θ)` on the cut line, centred
      // on the shell's vertical midpoint.
      const theta = (cut.angleDeg * Math.PI) / 180;
      const placed = rotated.translate([
        xzCenter.x + radialInner * Math.cos(theta),
        yCenter,
        xzCenter.z + radialInner * Math.sin(theta),
      ]);
      tempManifolds.push(placed);

      // Step 6 (issue #89 fix B): carve the silicone cavity out of
      // the brim prism. On convex masters this is effectively a
      // no-op since the narrow radial slab already clears the shell's
      // outer surface; on non-convex masters (e.g. a figurine with
      // concave pockets) the brim's inner face can dip INTO the
      // silicone cavity, and this subtract removes that intrusion.
      //
      // `siliconeOuter` is the master offset outward by
      // `siliconeThickness_mm` — a SOLID Manifold equal to the shell's
      // inner-cavity volume. `difference([brimPrism, siliconeOuter])`
      // carves the cavity's volume out of the brim prism. CALLER-
      // OWNED: `siliconeOuter` is NOT disposed here.
      const carved = toplevel.Manifold.difference([placed, siliconeOuter]);
      tempManifolds.push(carved);

      // Step 7: union with the running piece.
      const unioned = toplevel.Manifold.union(current, carved);

      // Swap running handle. `current` is either the original caller
      // `piece` (iteration 0) or a prior union result (iteration >= 1);
      // either way it's safe to release at this point — the new
      // `unioned` fully contains its volume.
      safeDeleteM(current);
      if (current === piece) pieceConsumed = true;
      current = unioned;
    }

    // Release every intermediate handle. The final `current` has
    // absorbed their volume via union.
    for (const m of tempManifolds) safeDeleteM(m);
    for (const cs of tempSections) safeDeleteCs(cs);
    return current;
  } catch (err) {
    for (const m of tempManifolds) safeDeleteM(m);
    for (const cs of tempSections) safeDeleteCs(cs);
    // Release the running `current` if it is NOT the original piece
    // (either a prior union result that hasn't been consumed by the
    // next iteration, or the piece itself on an iteration-0 throw).
    if (current !== piece) {
      safeDeleteM(current);
    }
    // Always release the original piece — caller's contract is it's
    // consumed regardless of success/failure.
    if (!pieceConsumed) safeDeleteM(piece);
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
