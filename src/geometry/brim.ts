// src/geometry/brim.ts
//
// Wave F (issue #84). Build a CONFORMAL brim flange on each cut face of
// a sliced shell piece. The brim's INNER edge hugs the shell's outer
// surface at every Y (via a 2D cross-section of the full shell taken at
// the cut plane), and its OUTER edge sits `brimWidth_mm` further out,
// radially, at every Y. After extrusion along the cut-plane normal the
// result is a flange whose silhouette follows the shell's taper —
// wider at the base of a pyramidal / conical master, narrower at the
// top — rather than a uniform-radial-extent trapezoidal slab.
//
// Issue #conformal-brim fix (this file, 2026-04-22 PM dogfood)
// -----------------------------------------------------------
//
// PRIOR STATE: the brim was built as a trapezoidal PRISM with uniform
// radial extent over its full height. On a tapered master (cone, cup,
// mini figurine) the shell is wider at the base and narrower at the
// top, so the uniform-radial-extent brim:
//   - gapped above the shell at the top (flange outer edge floats
//     several mm away from the narrower shell rim), or
//   - poked wildly past the shell at the base (flange inner edge
//     dipped below the shell's widest horizontal extent).
// The taper factor helped a little on visual reading but didn't solve
// the root cause — the inner edge wasn't tracking the shell's profile.
//
// FIX: slice the FULL print shell at each cut plane, fill holes in the
// 2D cross-section, then inflate outward by `brimWidth_mm` and inward
// by `bondOverlap` via Clipper2's `CrossSection.offset` (round joins).
// Subtract the inward profile from the outward profile to get a ring
// whose inner loop follows the shell's exact silhouette at every Y.
// Extrude the ring by `brimThickness_mm` along the cut-plane normal.
//
// Trade-offs vs. the pre-fix trapezoidal-prism approach:
//
//   - Prism is uniform-radial-extent but the inner edge is straight
//     — bad on tapered masters; good for unit-testing against analytic
//     bounds.
//   - Conformal profile follows the shell exactly — always visually
//     correct on any master shape; but the analytic volume bound is
//     looser (depends on the shell's 2D area at the cut plane).
//
// The issue #96 taper is DROPPED — the conformal profile already gives
// the "buttress blending into the shell" reading at the inner edge
// (because the inner curve hugs the shell). The outer edge is a
// uniform radial-offset of the inner curve, so the brim reads as a
// uniform-width flange that tracks the shell's taper. No vertical
// scaleTop is applied; the brim is a straight extrusion.
//
// Construction sequence (new):
//
//   1. For each cut plane at angle θ through `xzCenter`:
//      a. Translate the full shell Manifold by `(-xzCenter.x, 0,
//         -xzCenter.z)` so the cut axis passes through the world
//         origin.
//      b. Rotate about +Y by `+θ_deg`. Manifold's right-handed Y
//         rotation sends radial(θ) = (cos θ, 0, sin θ) → (+1, 0, 0),
//         and sends the plane normal `n_CCW(θ) = (-sin θ, 0, cos θ)`
//         → (0, 0, +1). After this rotation the cut plane coincides
//         with the world XY plane (Z = 0).
//      c. `.slice(0)` → `csRaw`, a 2D CrossSection in the (X, Y)
//         plane of the rotated shell's Z = 0 slice. `+X_cs` corresponds
//         to radial-outward in the cut plane, `+Y_cs` corresponds to
//         world-vertical.
//   2. Fill holes in `csRaw`. The shell's cross-section at a cut plane
//      is annular (there's a gap between shell's inner and outer
//      surfaces where the silicone cavity + master would sit). For
//      brim construction we want the FILLED profile of the shell's
//      outer boundary — inflate outward from THAT, not the annular
//      ring's mid-curves. Approach: `toPolygons()` → filter to
//      CCW-wound polygons (outer loops; Clipper2 convention is
//      CCW = outer) → rebuild via `ofPolygons(..., 'Positive')`.
//   3. `csOutward = csFilled.offset(+brimWidth_mm, 'Round')`: inflate
//      outward.
//   4. `csInward = csFilled.offset(-bondOverlap, 'Round')`: shrink
//      inward (into the shell wall) by `bondOverlap ≡
//      BOND_OVERLAP_MULTIPLIER × printShellThickness_mm`.
//   5. `brim2d = csOutward.subtract(csInward)`: the ring between.
//   6. `prism = brim2d.extrude(brimThickness_mm)`: base at local Z=0,
//      top at local Z=brimThickness.
//   7. Translate `prism` along local Z by either 0 (localXSign = -1,
//      piece on +n side → brim on +Z side) or `-brimThickness`
//      (localXSign = +1, piece on -n side → brim on -Z side).
//   8. Rotate back: `.rotate([0, -θ_deg, 0])` — reverses step 1.b.
//   9. Translate back: `.translate([xzCenter.x, 0, xzCenter.z])` —
//      reverses step 1.a.
//  10. Push to `brimPrisms`.
//
// After the loop (same batching as before):
//
//  11. Merge brim prisms via `Manifold.union([...])` (one-element list
//      is fed to the diff directly, skipping the degenerate union).
//  12. `carved = Manifold.difference([merged, siliconeOuter])`. Still
//      needed as belt-and-braces for non-convex masters where an
//      inward offset can overshoot the silicone cavity.
//  13. `result = Manifold.union(piece, carved)` — integrate into the
//      shell piece.
//
// Caller-side contract change
// ---------------------------
//
// `addBrim` now requires `shellManifold: Manifold` in `AddBrimArgs`,
// the CALLER-OWNED full (pre-slice) print shell. The caller must
// DEFER `shellManifold.delete()` until after every `addBrim` call
// completes (the brim builder re-slices the shell on every call to
// recompute the conformal profile at each cut's angle + xzCenter). See
// `src/geometry/generateMold.ts` line ~1043 — the eager delete there
// is moved to run AFTER the brim loop completes. `shellBboxWorld` is
// still used for the Y-span and (fallback) AABB-derived outer radius.
//
// Ownership / lifetime:
//
//   - `piece`: CONSUMED by `addBrim` on BOTH success AND failure.
//     Returned Manifold is fresh — caller owns and must `.delete()`.
//   - `shellManifold`: CALLER-OWNED. Never `.delete()`-ed by `addBrim`.
//     Caller must hold this handle alive for the duration of every
//     `addBrim` call (across all pieces) and release it afterwards.
//   - `siliconeOuter`: CALLER-OWNED — same contract as shellManifold.
//   - Every intermediate Manifold / CrossSection is disposed in both
//     success and failure paths.
//
// sideCount === 2 special case: only ONE cut plane total (angles 90°
// and 270° define the same vertical plane). The caller passes a single
// cut angle for each piece; the brim builder treats it as a single-
// brim piece.
//
// Rotation-angle derivation (new)
// -------------------------------
//
// Manifold's `.rotate([0, φ_deg, 0])` applies a right-handed rotation
// about +Y:
//
//     (x, z) → (x cos φ + z sin φ, -x sin φ + z cos φ)
//     (y stays the same)
//
// We want radial(θ) = (cos θ, 0, sin θ) to map to (+1, 0, 0).
// Setting (cos θ · cos φ + sin θ · sin φ) = 1 and
// (-cos θ · sin φ + sin θ · cos φ) = 0:
//   second eq ⇒ tan φ = tan θ ⇒ φ = θ (mod 180°).
//   first eq at φ = θ: cos²θ + sin²θ = 1. ✓
// So rotation by `+θ_deg` about +Y sends radial(θ) → +X.
//
// Check the plane normal: n_CCW(θ) = (-sin θ, 0, cos θ).
// Under φ = θ: (-sin θ · cos θ + cos θ · sin θ, 0, sin²θ + cos²θ)
// = (0, 0, 1) = +Z. ✓
//
// The CrossSection from `slice(0)` is in the (X, Y) plane — X = radial-
// outward, Y = world-vertical.
//
// Inverse: to transform the built brim back to world, apply rotation
// by `-θ_deg` about +Y.
//
// localXSign handling (new)
// -------------------------
//
// The brim must sit on the PIECE'S side of the cut plane.
//
//   - For CCW-bound (lower) cut at angle a0, piece is on +n_CCW(a0) side.
//     After our rotation, +n_CCW(a0) → +Z_rot. Extruding the 2D brim
//     along +Z (default `.extrude()` direction) puts the brim on the
//     +Z_rot side → +n_CCW side after inverse rotation → piece side.
//     ⇒ `localXSign = -1` here, and we apply ZERO Z-translation.
//   - For CW-bound (upper) cut at angle a1, piece is on -n_CCW(a1) side.
//     After rotation, -n_CCW(a1) → -Z_rot. Extrusion is in +Z_rot by
//     default, so we TRANSLATE the prism by -brimThickness along Z so
//     it spans [-brimThickness, 0] in the rotated frame.
//     ⇒ `localXSign = +1` here, and `zOffset = -brimThickness_mm`.
//
// The `localXSign` values match the pre-fix names (same sign convention
// as the pre-#conformal code used for its local-X thickness offset);
// the meaning "this cut belongs to the piece's CCW-lower or CW-upper
// side" is preserved.

import type { CrossSection, Manifold, ManifoldToplevel, SimplePolygon } from 'manifold-3d';

import { pieceMidAngleRad } from './shellSlicer';
import { SIDE_CUT_ANGLES } from './sideAngles';

/**
 * Multiplier applied to `printShellThickness_mm` to compute
 * `bondOverlap` — how far the brim extends INWARD past the shell's
 * outer surface so it fuses mechanically with the shell wall after the
 * union.
 *
 * Kept at 2.0 post-conformal fix (was 2.0 pre-fix too). The inward
 * offset is applied in 2D on the conformal cross-section, so the
 * inner boundary of the brim ring is a shrunken copy of the shell's
 * outer silhouette at each Y. The silicone-cavity subtract in step 12
 * still carves anything that dips past the shell's inner cavity,
 * making `bondOverlap` strictly a visual/mechanical-bonding knob.
 */
const BOND_OVERLAP_MULTIPLIER = 2.0;

/**
 * Clipper2 circular-segment count for round joins on the 2D offset.
 * 32 matches the value used elsewhere in the codebase (baseSlab.ts) —
 * plenty of smoothness for a ~10 mm offset without creating thousand-
 * vertex contours that inflate boolean cost.
 */
const OFFSET_CIRCULAR_SEGMENTS = 32;

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
   * World-space AABB of the FULL (pre-slice) print shell. Still used
   * for the Y-span (the conformal cross-section's Y range matches the
   * shell's Y range exactly, but we keep the bbox handy for empty-
   * shell guards). The conformal path does NOT use the AABB's radial
   * extent — the radial profile is derived from the shell slice.
   */
  shellBboxWorld: WorldBbox;
  /**
   * CALLER-OWNED full (pre-slice) print shell Manifold. Sliced at each
   * cut plane to build the conformal 2D brim profile. `addBrim` does
   * NOT `.delete()` this Manifold — the caller retains the handle for
   * the full lifetime of every brim iteration (typical: defer the
   * shell's delete in `generateMold.ts` until after every `addBrim`
   * completes).
   */
  shellManifold: Manifold;
  /** Master bbox XZ center (world mm). Both cut planes pass through this. */
  xzCenter: { x: number; z: number };
  /** Brim radial width (mm), default 10 from parameters. */
  brimWidth_mm: number;
  /** Brim thickness perpendicular to the cut plane (mm). */
  brimThickness_mm: number;
  /**
   * Silicone-outer Manifold — the solid blob equal to the master offset
   * outward by `siliconeThickness_mm`, i.e. the shell's INNER cavity
   * volume. Used as a carve-out to ensure the brim never intrudes
   * into the silicone cavity on non-convex masters where the inward
   * 2D offset may overshoot.
   *
   * CALLER-OWNED: `addBrim` does NOT `.delete()` this Manifold.
   */
  siliconeOuter: Manifold;
  /**
   * Print shell thickness (mm) — used as the `bondOverlap` distance
   * the brim extends INWARD past the shell's outer surface.
   * bondOverlap = BOND_OVERLAP_MULTIPLIER × printShellThickness_mm.
   */
  printShellThickness_mm: number;
  /**
   * Optional radial cut-angle override (degrees, CCW from +X axis).
   * Must be length `sideCount` and sorted CCW. Defaults to
   * `SIDE_CUT_ANGLES[sideCount]`.
   */
  angles?: readonly number[];
}

/**
 * Shoelace signed area of a simple polygon in CCW-positive convention.
 * Used to classify `toPolygons()` output into outer (CCW, signedArea
 * > 0) vs. hole (CW, signedArea < 0) contours.
 *
 * Mirrors the Clipper2 convention for `FillRule::Positive`.
 */
function signedArea(poly: SimplePolygon): number {
  if (poly.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i] as [number, number];
    const q = poly[(i + 1) % poly.length] as [number, number];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/**
 * Attach `1` brim (sideCount === 2) or `2` brims (sideCount 3 / 4) to a
 * single shell piece, union them with the piece, and return the fresh
 * result. The input `piece` is `.delete()`-ed internally on BOTH
 * success AND failure.
 *
 * Conformal profile: the brim's 2D profile at each cut is derived from
 * slicing the full shell at the cut plane, so the brim's inner edge
 * hugs the shell's outer surface at every Y (no gap / no overshoot on
 * tapered masters).
 */
export function addBrim(args: AddBrimArgs): Manifold {
  const {
    toplevel,
    piece,
    pieceIndex,
    sideCount,
    shellBboxWorld,
    shellManifold,
    xzCenter,
    brimWidth_mm,
    brimThickness_mm,
    siliconeOuter,
    printShellThickness_mm,
  } = args;

  const angles = args.angles ?? SIDE_CUT_ANGLES[sideCount];
  if (angles.length !== sideCount) {
    throw new Error(
      `addBrim: expected ${sideCount} angles, got ${angles.length}`,
    );
  }

  // Cuts for this piece:
  //   - CCW (lower) bound at angle a0: piece sits on +n_CCW(a0) side.
  //     After our rotation, +n_CCW(a0) → +Z_rot. Extruding along +Z
  //     (default) puts the brim on piece's side. `localXSign = -1`,
  //     `zOffset = 0`.
  //   - CW  (upper) bound at angle a1: piece sits on -n_CCW(a1) side.
  //     After our rotation, -n_CCW(a1) → -Z_rot. We extrude along
  //     +Z then translate by `-brimThickness` on Z to land on the
  //     piece's side. `localXSign = +1`, `zOffset = -brimThickness`.
  // sideCount === 2 has only the first cut (the two angles collapse
  // to the same plane, so a second brim would overlap the first).
  //
  // `clipX` (conformal-brim fix): whether to clip the outward 2D
  // profile at X_cs ≥ 0 so the brim does NOT extend past the piece's
  // OTHER cut plane (which in cut-plane-local 2D projects to the
  // line X_cs = 0 — both cut planes contain the Y axis so their
  // intersection is the Y axis, which under our Y-rotation becomes
  // the Y_cs axis, i.e. X_cs = 0). Without this clip, the outward
  // 2D offset on a non-thin shell silhouette (cube, cylinder, etc.)
  // extends in ALL 2D directions, including past the adjacent cut,
  // producing the brim overlap between adjacent pieces that
  // `tests/geometry/brim.test.ts — adjacent brimmed pieces have
  // disjoint volumes` caught.
  //
  // For sideCount === 2 there IS no adjacent cut on the piece (only
  // one brim per piece), so no X_cs clip is applied. The outward
  // profile is allowed to extend across the piece's opposite side
  // — harmless because only one brim per piece exists.
  const a0Deg = angles[pieceIndex] as number;
  const cuts: Array<{ angleDeg: number; localXSign: 1 | -1; clipX: boolean }> = [
    { angleDeg: a0Deg, localXSign: -1, clipX: sideCount !== 2 },
  ];
  if (sideCount !== 2) {
    const a1Deg = angles[(pieceIndex + 1) % sideCount] as number;
    cuts.push({ angleDeg: a1Deg, localXSign: 1, clipX: true });
  }

  const shellMinY = shellBboxWorld.min.y;
  const shellMaxY = shellBboxWorld.max.y;
  const shellYSpan = Math.max(0, shellMaxY - shellMinY);

  // bondOverlap (mm) = 2× shell thickness. Inward 2D offset distance
  // applied to the shell-slice CrossSection.
  const bondOverlap = Math.max(
    0,
    BOND_OVERLAP_MULTIPLIER * printShellThickness_mm,
  );

  if (shellYSpan <= 0 || brimWidth_mm <= 0 || brimThickness_mm <= 0) {
    // Nothing sensible to build — return the piece unchanged.
    return piece;
  }

  // Lifetime bookkeeping:
  //   - `brimPrisms` holds placed brim Manifolds (pre-merge).
  //   - `mergedBrims` is the post-merge Manifold (or brimPrisms[0] on
  //     sideCount=2).
  //   - `carved` is the mergedBrims - siliconeOuter result.
  //   - `tempManifolds` holds ephemeral Manifold handles from the
  //     per-cut construction steps (rotated shell copies, extruded
  //     prisms, rotations, translations).
  //   - `tempSections` holds ephemeral CrossSection handles (slice
  //     result, filled outer profile, inward/outward offsets, ring
  //     subtract).
  //   - `pieceConsumed` flips true once the final union completes;
  //     before that the catch path releases `piece` explicitly.
  const brimPrisms: Manifold[] = [];
  let mergedBrims: Manifold | undefined;
  let carved: Manifold | undefined;
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
      const theta_deg = cut.angleDeg;
      const zOffset = cut.localXSign === -1 ? 0 : -brimThickness_mm;

      // Step 1a: translate the shell so the cut axis passes through
      // the world origin (Y axis is the cut axis — the cut plane
      // always contains the world Y axis shifted by xzCenter in XZ).
      const shellShifted = shellManifold.translate([
        -xzCenter.x,
        0,
        -xzCenter.z,
      ]);
      tempManifolds.push(shellShifted);

      // Step 1b: rotate the shell by +θ_deg about +Y. After this
      // the plane normal n_CCW(θ) aligns with +Z and the radial
      // direction aligns with +X. The cut plane coincides with the
      // rotated-shell's Z = 0 plane.
      const shellRotated = shellShifted.rotate([0, theta_deg, 0]);
      tempManifolds.push(shellRotated);

      // Step 1c: slice at Z = 0. CrossSection in (X, Y) plane of the
      // rotated shell. X_cs = radial-outward, Y_cs = world-vertical.
      const csRaw = shellRotated.slice(0);
      tempSections.push(csRaw);

      if (csRaw.isEmpty() || csRaw.numContour() === 0) {
        // Pathological case: the shell has no cross-section at this
        // cut plane. Skip this cut's brim — no geometry to build.
        continue;
      }

      // Step 2: fill holes. The shell's cross-section is annular
      // (outer CCW contour + inner CW hole where the silicone cavity
      // lives). Keep only CCW contours and rebuild as a single
      // solid profile via `ofPolygons(..., 'Positive')`. Any CCW
      // contour from a non-convex master becomes its own outer
      // profile — multiple outer loops are fine, the offset + ring-
      // subtract operate on each component consistently.
      const rawPolys = csRaw.toPolygons();
      const outerPolys = rawPolys.filter((p) => signedArea(p) > 0);
      if (outerPolys.length === 0) {
        // No CCW outer contour — degenerate slice (e.g. single-
        // vertex intersection). Skip.
        continue;
      }
      const csFilled = toplevel.CrossSection.ofPolygons(
        outerPolys as unknown as SimplePolygon[],
        'Positive',
      );
      tempSections.push(csFilled);

      if (csFilled.isEmpty()) {
        continue;
      }

      // Step 3a: inflate outward by brimWidth (Round joins). The 2D
      // offset grows the profile in every 2D direction — including
      // vertically (Y_cs). That's not what the user wants: the brim's
      // outer edge should sit brimWidth further out RADIALLY at every
      // Y, but should NOT overshoot the shell's Y range (which would
      // read as the flange sticking up above the shell top / below
      // the shell bottom).
      const csOutwardRaw = csFilled.offset(
        brimWidth_mm,
        'Round',
        2,
        OFFSET_CIRCULAR_SEGMENTS,
      );
      tempSections.push(csOutwardRaw);

      // Step 3b: clip the outward profile to (i) the shell's Y range
      // (no vertical overshoot) and (ii) the X_cs ≥ 0 half-plane when
      // the piece has a neighbour cut (so the brim does NOT extend
      // past the piece's OTHER cut plane — which projects to the
      // Y_cs axis in 2D). For a vertical-walled shell (cube,
      // cylinder) this clip is a pure rectangle intersection; for a
      // tapered shell (cone, mini-figurine) the inner edge still
      // follows the shell silhouette exactly and the outer edge is
      // approximately `shell silhouette + brimWidth` along the
      // silhouette normal, clipped at X_cs=0 / Y_cs = shell range —
      // matching the user's "flange whose inner edge hugs the
      // shell" spec AND the "brim stays within the piece's arc"
      // invariant required by the adjacent-pieces-disjoint test.
      //
      // Build the clip rectangle: X_cs span covers the full outer
      // profile radial extent (shell bbox X span + brimWidth_mm +
      // slack). For `clipX = false` (sideCount=2) the rectangle
      // covers both +X_cs and -X_cs half-planes. For `clipX = true`
      // the rectangle covers only +X_cs.
      const filledBounds = csFilled.bounds();
      const clipHalfX =
        Math.max(
          Math.abs(filledBounds.min[0]),
          Math.abs(filledBounds.max[0]),
        ) + brimWidth_mm + 10;
      const clipMinX = cut.clipX ? 0 : -clipHalfX;
      const clipMaxX = clipHalfX;
      const clipWidthX = clipMaxX - clipMinX;
      const clipCenterX = (clipMinX + clipMaxX) / 2;
      const clipRect = toplevel.CrossSection.square(
        [clipWidthX, shellYSpan],
        /* center */ true,
      );
      tempSections.push(clipRect);
      // `CrossSection.square([w, h], true)` is centred on (0, 0). We
      // need it centred on (clipCenterX, shell Y midpoint).
      const clipRectPlaced = clipRect.translate([
        clipCenterX,
        (shellMinY + shellMaxY) / 2,
      ]);
      tempSections.push(clipRectPlaced);
      const csOutward = csOutwardRaw.intersect(clipRectPlaced);
      tempSections.push(csOutward);

      // Step 4: shrink inward by bondOverlap (Round joins). Negative
      // delta = contour retraction. On a non-convex master an inward
      // offset can produce disjoint components; Clipper2's fill-rule
      // handling keeps these consistent. No Y clipping needed — the
      // inward profile is always strictly inside the shell slice,
      // which is already bounded by the shell's Y range.
      const csInward = csFilled.offset(
        -bondOverlap,
        'Round',
        2,
        OFFSET_CIRCULAR_SEGMENTS,
      );
      tempSections.push(csInward);

      // Step 5: ring between outward and inward. If the inward offset
      // collapsed to empty (a very thin shell slice + large
      // bondOverlap), the subtract is a no-op and the ring defaults
      // to the full outward profile — still a valid brim (just no
      // mechanical-bond overlap into the shell wall on that slice,
      // which would be caught by the siliconeOuter subtract
      // downstream).
      const brim2d = csOutward.subtract(csInward);
      tempSections.push(brim2d);

      if (brim2d.isEmpty()) {
        continue;
      }

      // Step 6: extrude by brimThickness along +Z (local). Prism
      // spans local Z ∈ [0, brimThickness].
      const prism = brim2d.extrude(brimThickness_mm);
      tempManifolds.push(prism);

      // Step 7: translate along Z by zOffset so the prism lands on
      // the PIECE's side of the cut plane. For CCW-bound cuts
      // (localXSign=-1), zOffset=0 keeps the prism in +Z_rot (which
      // maps back to +n_CCW in world — the piece's side). For
      // CW-bound cuts (localXSign=+1), zOffset=-brimThickness puts
      // the prism in -Z_rot (→ -n_CCW in world — the piece's side).
      let prismPlaced: Manifold;
      if (zOffset !== 0) {
        prismPlaced = prism.translate([0, 0, zOffset]);
        tempManifolds.push(prismPlaced);
      } else {
        prismPlaced = prism;
      }

      // Step 8: rotate back by -θ_deg about +Y. Reverses step 1b.
      const prismUnrotated = prismPlaced.rotate([0, -theta_deg, 0]);
      tempManifolds.push(prismUnrotated);

      // Step 9: translate back by +xzCenter (x and z). Reverses
      // step 1a.
      const prismPlacedWorld = prismUnrotated.translate([
        xzCenter.x,
        0,
        xzCenter.z,
      ]);
      tempManifolds.push(prismPlacedWorld);

      brimPrisms.push(prismPlacedWorld);
    }

    if (brimPrisms.length === 0) {
      // Every cut degenerated (empty slice / empty ring). Return the
      // piece unchanged — nothing to union.
      for (const m of tempManifolds) safeDeleteM(m);
      for (const cs of tempSections) safeDeleteCs(cs);
      return piece;
    }

    // Step 11: merge brim prisms for this piece. For sideCount=2
    // there's a single prism — skip the degenerate Manifold.union()
    // call (it would be a no-op but we avoid the WASM round-trip).
    if (brimPrisms.length === 1) {
      mergedBrims = brimPrisms[0] as Manifold;
      // `mergedBrims` aliases brimPrisms[0]. Empty the array so the
      // catch/finally trail doesn't double-delete.
      brimPrisms.length = 0;
    } else {
      mergedBrims = toplevel.Manifold.union(brimPrisms);
      // brimPrisms entries are released in the success-path cleanup
      // below.
    }

    // Step 12: single silicone-cavity subtract on the merged brims.
    // Belt-and-braces for non-convex masters where the 2D inward
    // offset (step 4) may miss a pocket's inward dip. On convex
    // masters this is effectively a no-op.
    carved = toplevel.Manifold.difference([mergedBrims, siliconeOuter]);

    // Step 13: single piece integration.
    const result = toplevel.Manifold.union(piece, carved);
    pieceConsumed = true;

    // Release every intermediate handle. The final `result` owns the
    // volume of piece + every carved brim.
    safeDeleteM(piece);
    safeDeleteM(mergedBrims);
    safeDeleteM(carved);
    for (const bp of brimPrisms) safeDeleteM(bp);
    for (const m of tempManifolds) safeDeleteM(m);
    for (const cs of tempSections) safeDeleteCs(cs);
    return result;
  } catch (err) {
    for (const m of tempManifolds) safeDeleteM(m);
    for (const cs of tempSections) safeDeleteCs(cs);
    for (const bp of brimPrisms) safeDeleteM(bp);
    if (mergedBrims && !brimPrisms.includes(mergedBrims)) {
      safeDeleteM(mergedBrims);
    }
    if (carved) safeDeleteM(carved);
    if (!pieceConsumed) safeDeleteM(piece);
    throw err;
  }
}

/** Outward mid-direction unit vector for piece `pieceIndex` in the partition. */
export function pieceOutwardDir(
  sideCount: 2 | 3 | 4,
  pieceIndex: number,
  angles?: readonly number[],
): { x: number; z: number } {
  const mid = pieceMidAngleRad(sideCount, pieceIndex, angles);
  return { x: Math.cos(mid), z: Math.sin(mid) };
}
