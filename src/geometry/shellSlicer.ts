// src/geometry/shellSlicer.ts
//
// Wave E (issue #84). Radial slicing of the surface-conforming print
// shell into N printable pieces, bounded by vertical half-space planes
// through the master's XZ centerline at angles from `SIDE_CUT_ANGLES`.
//
// Convention (inherited from `./sideAngles.ts`, confirmed by issue #84):
//
//   - Angles are degrees CCW from the +X axis in the XZ plane, Y-up.
//   - The radial unit vector at angle θ is `(cos θ, 0, sin θ)`.
//     Sanity: θ=90° → +Z; θ=180° → -X; θ=270° → -Z.
//   - Piece `i` for sideCount N occupies the CCW arc from
//     `SIDE_CUT_ANGLES[N][i]` to `SIDE_CUT_ANGLES[N][(i+1) % N]`.
//
// Algorithm — for each piece `i` with bounding angles [a0, a1]:
//
//   Build TWO trim planes; each passes through the master's world-space
//   XZ center (`(cx, *, cz)`) and contains the Y axis (vertical). Each
//   trim plane's normal is chosen so `trimByPlane(normal, offset)` keeps
//   the piece-side half-space.
//
//   Note on `Manifold.trimByPlane` semantics — from
//   `node_modules/manifold-3d/manifold.d.ts`:
//
//     "Removes everything behind the given half-space plane. The result
//      is in the direction of this vector from the plane."
//
//   So `trimByPlane(n, d)` KEEPS the half where `dot(p, n) >= d`.
//
//   For the angle-`a` boundary plane (contains Y axis + radial(a)), the
//   normal perpendicular to radial(a) in the XZ plane rotated 90° CCW
//   about +Y is:  n_CCW(a) = (-sin a, 0, cos a).
//
//   This normal points toward the CCW half-space. For piece `i` bounded
//   at a0 (lower-CCW bound), the piece IS on the CCW side, so we use
//   `n_CCW(a0)` as-is. For piece `i` bounded at a1 (upper-CCW bound),
//   the piece is on the CW side of the a1 plane, so we flip the normal:
//   use `-n_CCW(a1) = (sin a1, 0, -cos a1)`.
//
//   Both offsets equal `dot(center_xz, normal)` so the plane passes
//   through the master's XZ center (the plane is vertical so its Y is
//   unconstrained — any Y works for a point on the plane, so
//   `center = (cx, 0, cz)` with Y=0 is the simplest representative).
//
// Special case — `sideCount === 2`:
//
//   Angles are [90°, 270°]. For piece 0 bounded at [90°, 270°] both
//   computed normals equal `(-1, 0, 0)` and both offsets equal `-cx`.
//   Applying `trimByPlane` twice with the same plane is a no-op of the
//   second call, but we skip the redundant work with an explicit
//   `sideCount === 2` branch that applies ONE trim per piece. Piece 1 at
//   [270°, 90°+360°] yields both normals equal to `(+1, 0, 0)` — again a
//   single trim suffices.
//
// Ownership contract:
//
//   - The input `shell` Manifold is OWNED BY THE CALLER — not consumed.
//   - Each output piece is a FRESH `Manifold` — caller takes ownership
//     and must `.delete()` each one.
//   - On any failure inside the loop, every allocated piece up to that
//     point is `.delete()`'d before re-throwing so callers never inherit
//     a partial array of leaked Manifolds.
//
// Verification trace (sideCount === 4, angles [45, 135, 225, 315]):
//
//   Piece 0 arc [45°, 135°] has mid direction radial(90°) = (0, 0, 1),
//   i.e. +Z — the "+Z half-quadrant" per the issue spec. ✓

import type { CrossSection, Manifold, ManifoldToplevel, SimplePolygon, Vec3 } from 'manifold-3d';

import { buildCutPlaneSlice, disposeCutPlaneSlice, type CutPlaneSlice } from './brim';
import { SIDE_CUT_ANGLES } from './sideAngles';

/**
 * XZ coordinates of the master's world-space bbox center. The slicer
 * places every cut plane through this point + the vertical (Y) axis so
 * the pieces share a clean centerline.
 */
export interface XzCenter {
  x: number;
  z: number;
}

/**
 * Slice a print shell radially into `sideCount` pieces, bounded by
 * vertical half-space planes through `(xzCenter, Y axis)` at the given
 * `angles` (or `SIDE_CUT_ANGLES[sideCount]` if omitted).
 *
 * @param toplevel Initialised manifold-3d handle (unused today — the
 *   slice is a pure `.trimByPlane` chain — but kept in the signature so
 *   a future offset/union fallback can construct new primitives without
 *   a second `initManifold()` round-trip).
 * @param shell Print-shell Manifold; caller retains ownership.
 * @param sideCount 2, 3, or 4.
 * @param xzCenter Cut-plane center, world-space mm. The caller must
 *   apply any user-facing offset (e.g. the cut-planes preview gizmo
 *   drag) before passing this in — the slicer treats it as the
 *   authoritative pivot.
 * @param angles Optional radial cut angles (degrees, CCW from +X).
 *   Defaults to `SIDE_CUT_ANGLES[sideCount]`. Must be length
 *   `sideCount` and sorted CCW so piece `i` occupies
 *   `[angles[i], angles[(i+1) % n]]` (the slicer allows wraparound
 *   via the `a1 <= a0` check in `pieceMidAngleRad`).
 * @returns Fresh `Manifold[]` of length `sideCount`; caller owns each
 *   handle and must `.delete()` them.
 */
export function sliceShellRadial(
  toplevel: ManifoldToplevel,
  shell: Manifold,
  sideCount: 2 | 3 | 4,
  xzCenter: XzCenter,
  angles: readonly number[] = SIDE_CUT_ANGLES[sideCount],
): Manifold[] {
  void toplevel; // reserved for future use (union fallback path)

  if (angles.length !== sideCount) {
    throw new Error(
      `sliceShellRadial: expected ${sideCount} angles, got ${angles.length}`,
    );
  }
  const pieces: Manifold[] = [];

  try {
    for (let i = 0; i < sideCount; i++) {
      const a0 = (angles[i] as number) * (Math.PI / 180);
      const a1 = (angles[(i + 1) % sideCount] as number) * (Math.PI / 180);

      // `n_CCW(a) = (-sin a, 0, cos a)` — points into the CCW half-space
      // of the plane through (Y axis, radial(a)).
      const n0_x = -Math.sin(a0);
      const n0_z = Math.cos(a0);
      // Flipped normal at the a1 bound so the trim keeps the CW side of
      // a1 (which is where piece i lives).
      const n1_x = Math.sin(a1);
      const n1_z = -Math.cos(a1);

      // Offsets: plane passes through (xzCenter.x, *, xzCenter.z). For
      // any point on the plane, dot(p, n) equals dot(xzCenter_point, n).
      // Y-component drops out because n_y = 0.
      const d0 = xzCenter.x * n0_x + xzCenter.z * n0_z;
      const d1 = xzCenter.x * n1_x + xzCenter.z * n1_z;

      const n0: Vec3 = [n0_x, 0, n0_z];
      const n1: Vec3 = [n1_x, 0, n1_z];

      // sideCount===2 degeneracy: both planes coincide (opposite normals
      // with the single-plane 90°/270° bounding set collapses to the
      // same cut). Avoid the redundant second trim for clarity + perf.
      const halfStep =
        shell.trimByPlane(n0, d0);
      let piece: Manifold;
      if (sideCount === 2) {
        piece = halfStep;
      } else {
        try {
          piece = halfStep.trimByPlane(n1, d1);
        } finally {
          halfStep.delete();
        }
      }
      pieces.push(piece);
    }
  } catch (err) {
    for (const p of pieces) {
      try {
        p.delete();
      } catch {
        /* already dead */
      }
    }
    throw err;
  }

  return pieces;
}

/**
 * Mid-angle (radians) of piece `i` in the sector partition given by
 * `SIDE_CUT_ANGLES[sideCount]`. Exported for downstream consumers (brim
 * builder, exploded-view direction) that need the piece's outward
 * direction without re-deriving it from the raw angle table.
 *
 * Handles the `angles[i+1] < angles[i]` wraparound (e.g. piece 1 of
 * sideCount=2 spans 270°→360°+90°=450°; mid = 360°) by adding 360° to
 * `a1` when needed before averaging.
 */
export function pieceMidAngleRad(
  sideCount: 2 | 3 | 4,
  pieceIndex: number,
  angles: readonly number[] = SIDE_CUT_ANGLES[sideCount],
): number {
  const a0 = angles[pieceIndex] as number;
  let a1 = angles[(pieceIndex + 1) % sideCount] as number;
  if (a1 <= a0) a1 += 360;
  const midDeg = (a0 + a1) / 2;
  return midDeg * (Math.PI / 180);
}

/**
 * Outward radial unit vector at a given angle (radians). The same
 * convention as the slicer: `(cos θ, 0, sin θ)` — θ measured CCW from
 * +X in the XZ plane (Y-up).
 */
export function radialUnit(angleRad: number): Vec3 {
  return [Math.cos(angleRad), 0, Math.sin(angleRad)];
}

// ============================================================================
// Inter-piece V-chevron seal (issue piece-seal round 2, 2026-04-22 dogfood).
// ============================================================================
//
// After `sliceShellRadial` (+ brim) each piece's cut face is a flat vertical
// plane. When the user pours silicone into the assembled mold, any
// microscopic gap along the seam between two pieces lets silicone flow out.
// The first fix (PR #115) put a half-height Y-step on the cut face — which
// was rejected in dogfood for being in the wrong orientation (a vertical
// step instead of the horizontal V-chevron the user wants running the FULL
// shell height).
//
// Geometry: at each cut plane between piece N (on +n_CCW side) and the
// mating piece (on −n_CCW side) we subtract/add a TRIANGULAR PRISM whose
// cross-section is a V-chevron viewed from above (in the horizontal plane),
// extruded along world-Y for the full shell height.
//
// Cut-local frame (post forward-rotate by +θ_deg about +Y):
//
//   X_cs = radial outward (world X after rotation)
//   Y_cs = world vertical (unchanged)
//   Z_cs = +n_CCW direction (world Z after rotation)
//
// Triangle cross-section in (X_cs, Z_cs), apex pointing into +Z_cs so it
// pokes into piece N's territory:
//
//   A = (X_apex − halfWidth, 0)     base-left on the cut plane
//   B = (X_apex + halfWidth, 0)     base-right on the cut plane
//   C = (X_apex, +apexDepth)        apex in piece N's territory (+Z_cs)
//
// With `halfWidth == apexDepth` the two tilted sides are at 45° — matches
// the 45° tongue-and-groove angle the user requested.
//
// Radial centering: `X_apex` sits on the SHELL OUTER silhouette (the
// shell-outer radius relative to `xzCenter`). The V then straddles the
// shell wall / brim junction, which is where the mechanical seam lives
// — the chevron locks the two pieces against lateral slide at the
// junction rather than at the silicone cavity's inner wall (bad — would
// intrude on the cavity) or the brim's outer edge (bad — would be a
// cantilevered key with nothing behind it on one side).
//
// Profile-follow fix (2026-04-22 PM dogfood, PR #116 follow-up)
// -------------------------------------------------------------
//
// PRIOR STATE: `X_apex` was set from `shellOuterHalfExtent` — the max
// radial distance of the full shell's world-space AABB from `xzCenter`.
// On a rotationally-symmetric shell this is approximately the brim's
// radial midline at every cut angle. But on a TAPERED master (mini
// figurine, cup, cone) the shell's outer radius AT THE CUT ANGLE is
// smaller than the AABB max at higher Y bands — so the V's apex landed
// OUTSIDE the actual brim at those Y levels, leaving a disconnected
// tongue floating in space beyond the brim's real edge.
//
// FIX: clip the V-prism to the ACTUAL cut-face 2D region at each cut
// plane. Per cut:
//
//   1. Re-use the pre-computed (or locally-computed) `CutPlaneSlice`
//      from `brim.ts` → `csFilled` is the 2D shell silhouette at that
//      cut plane.
//   2. Build `csOutward = csFilled.offset(brimWidth_mm, 'Round')` —
//      same expand as the brim builder does — and clip to the shell's
//      Y range (so the slab doesn't extend above/below the shell top/
//      bottom). This covers the union of the shell silhouette and the
//      brim flange at that cut.
//   3. Extrude `csOutward` symmetrically along local +Z_cs by
//      `2 × apexDepth`, translate to Z_cs ∈ [−apexDepth, +apexDepth].
//      Rotate/translate back to world → `cutFaceSlab`.
//   4. `vClipped = vPrism.intersect(cutFaceSlab)` — the V restricted
//      to wherever the cut face actually exists at every Y.
//
// The V follows the shell's taper: on a shell that narrows at the top,
// the V at high Y gets trimmed on the radial-outward side so it never
// pokes past the brim's edge profile. On a perfectly cylindrical
// shell the intersect is a no-op (the slab fully contains the V).
//
// Per-piece boolean assignment:
//
//   - piece N (`grooveIdx = c`, on +n_CCW side via its a_0 lower-CCW
//     bound): SUBTRACT a TRIANGULAR prism (Z_cs ∈ [0, +apexDepth]) →
//     the apex region carves a GROOVE into piece N's cut face.
//   - mating piece (`tongueIdx = (c − 1 + sideCount) % sideCount`, on
//     −n_CCW side): UNION a PENTAGONAL prism (Z_cs ∈ [−bondDepth,
//     +apexDepth]) — a rectangular BOND BASE embedded in piece (c−1)'s
//     body + the triangular apex bulging into +Z_cs as a TONGUE that
//     slides into the groove.
//
// Why the tongue is a pentagon, not a triangle (PR-117 follow-up,
// 2026-04-23 dogfood): a pure triangular tongue at Z_cs ∈ [0,
// +apexDepth] sits ENTIRELY on piece c's side of the cut plane, meeting
// piece (c−1) only along the 2D face at Z_cs = 0. Manifold's union on
// such face-sharing bodies left the tongue as a disconnected component
// of the same Manifold — floating in free air beyond the brim in the
// exploded view, no solid bond. The pentagon's rectangular back
// (Z_cs ∈ [−bondDepth, 0]) gives real VOLUME overlap with piece (c−1)
// so the union produces a single connected solid.
//
// Clearance: the tongue's triangular apex is shrunk by
// `SEAL_CLEARANCE_MM / 2` on both halfWidth and apexDepth (so the
// tongue is CLEARANCE mm thinner on each of the two sloped sides +
// CLEARANCE mm shorter at the apex). The groove prism is INFLATED by
// the same amount. That yields a CLEARANCE mm air gap on every
// tongue-groove contact surface when assembled — FDM parts slide
// together without binding. The pentagon's rectangular bond base does
// NOT need clearance (it stays inside piece (c−1)).
//
// sideCount=2: angles = [90°, 270°] define the same vertical cut plane
// (opposite normals). Apply ONE seal at a_0 = 90°: piece 0 = grooveIdx
// (on +n_CCW(90°) = −X side) gets the groove; piece 1 = tongueIdx (on
// +X side) gets the tongue. Consistent with the `cutCount = 1` branch
// in the existing slicer.
//
// Ownership: the returned array contains FRESH Manifold handles. Input
// pieces are CONSUMED on both success and failure paths. On partial
// failure every surviving slot is released before re-throw.

/**
 * Half-width of the V-chevron's base along the radial direction (mm).
 * The V spans `2 × SEAL_HALF_WIDTH_MM = 6 mm` radially at the cut plane.
 * Chosen to fit inside the default 10 mm `brimWidth_mm` plus a few mm of
 * shell wall thickness without spilling past either edge.
 */
export const SEAL_HALF_WIDTH_MM = 3.0;

/**
 * Depth of the V apex into piece N's territory (mm). At `apexDepth ==
 * halfWidth` the tilted sides are 45° — matches the user's requested
 * 45° tongue-and-groove interlock geometry.
 */
export const SEAL_APEX_DEPTH_MM = 3.0;

/**
 * Tongue/groove clearance (mm). `0.2 mm = 0.1 mm per sloped side` is a
 * comfortable FDM sliding fit; the tongue is shrunk by `CLEARANCE/2`
 * per half-extent and the groove is inflated by the same amount, so
 * every tongue-groove contact gap is CLEARANCE mm wide.
 */
export const SEAL_CLEARANCE_MM = 0.2;

/**
 * Depth (mm) that the tongue prism's RECTANGULAR BASE extends BACKWARDS
 * into the mating piece's body (−Z_cs territory) to guarantee a solid
 * volume-level bond between the tongue and piece (c-1).
 *
 * Why this exists (2026-04-23 dogfood, PR-117 follow-up): the previous
 * tongue was a pure triangular prism occupying Z_cs ∈ [0, +apexDepth].
 * That prism sat ENTIRELY on piece c's side of the cut plane (+Z_cs),
 * meeting piece (c-1) only along the 2D face at Z_cs = 0. Manifold's
 * boolean union on such face-sharing bodies can leave them as
 * DISCONNECTED components of the same Manifold — the tongue travels
 * with piece (c-1) in exploded-view tweens but renders floating in free
 * space next to the brim, with no solid bond. Dogfood 2026-04-23
 * screenshot showed exactly this artifact.
 *
 * Fix: make the tongue a PENTAGON with a rectangular base embedded in
 * piece (c-1)'s body (Z_cs ∈ [−TONGUE_BOND_DEPTH_MM, 0]) plus the
 * original triangular apex protruding into piece c's groove (Z_cs ∈
 * [0, +apexDepth]). The rectangular base provides real volume overlap
 * with piece (c-1), so the union produces a single connected solid.
 *
 * Value: 2 mm. Small enough that even on a narrow brim (default 10 mm)
 * the bond fits comfortably inside the brim's radial thickness, large
 * enough to avoid kernel-epsilon issues on the rectangle-base boolean.
 */
export const SEAL_TONGUE_BOND_DEPTH_MM = 2.0;

/**
 * Build one prism Manifold in world frame for the cut plane at
 * `angleDeg` through `xzCenter`. Cross-section lives in the (X_cs,
 * Z_cs) plane of the cut-local frame, extruded along Y from `shellMinY`
 * to `shellMaxY`.
 *
 * TRIANGLE (bondDepth === 0) — used by the GROOVE subtract:
 *
 *   A = (X_apex − halfWidth, 0)    base-left on cut plane
 *   B = (X_apex + halfWidth, 0)    base-right on cut plane
 *   C = (X_apex, +apexDepth)       apex toward +n_CCW
 *
 * PENTAGON (bondDepth > 0) — used by the TONGUE union:
 *
 *   P0 = (X_apex − halfWidth, −bondDepth)    back-bottom-left  (in piece c−1)
 *   P1 = (X_apex + halfWidth, −bondDepth)    back-bottom-right (in piece c−1)
 *   P2 = (X_apex + halfWidth, 0)             cut-plane right
 *   P3 = (X_apex, +apexDepth)                apex toward +n_CCW (in piece c)
 *   P4 = (X_apex − halfWidth, 0)             cut-plane left
 *
 * The rectangular base at Z_cs ∈ [−bondDepth, 0] sits INSIDE piece
 * (c−1)'s body, creating genuine volume overlap for the union. The
 * triangular apex at Z_cs ∈ [0, +apexDepth] protrudes into piece c's
 * groove cavity.
 *
 * Construction: build a 2D polygon in the Manifold cross-section plane
 * (2D-X = X_cs, 2D-Y = −Z_cs — note the sign flip — so that the
 * subsequent −90° rotation about +X maps 2D-Y → world +Z_cs and the
 * extrusion axis 2D-Z → world +Y). Extrude by `shellYSpan` so the
 * prism's base sits at local Y=0, then translate in +Y by `shellMinY`.
 * Rotate by `−angleDeg` about +Y (inverse of the forward cut rotation)
 * to align X_cs with world radial(angle) and Z_cs with world n_CCW.
 * Translate by `(xzCenter.x, 0, xzCenter.z)` to land on the cut plane.
 *
 * Returns a FRESH Manifold (caller `.delete()` when done).
 */
function buildVChevronAtCut(
  toplevel: ManifoldToplevel,
  angleDeg: number,
  xzCenter: XzCenter,
  xApex: number,
  halfWidth: number,
  apexDepth: number,
  shellMinY: number,
  shellMaxY: number,
  bondDepth: number = 0,
): Manifold {
  const shellYSpan = shellMaxY - shellMinY;
  if (!(shellYSpan > 0) || !(halfWidth > 0) || !(apexDepth > 0)) {
    throw new Error(
      `buildVChevronAtCut: degenerate prism (Yspan=${shellYSpan}, ` +
        `halfWidth=${halfWidth}, apexDepth=${apexDepth})`,
    );
  }
  if (!(bondDepth >= 0)) {
    throw new Error(
      `buildVChevronAtCut: bondDepth must be ≥ 0 (got ${bondDepth})`,
    );
  }

  // 2D polygon. The 2D-X axis corresponds to world X_cs (radial); the
  // 2D-Y axis is −Z_cs so that after extruding along +Z and rotating
  // −90° about +X, the 2D-Y → world +Z_cs (positive n_CCW) and the
  // extrusion axis → world +Y (vertical). Verification:
  //
  //   Rotation of −90° about +X applied to (a, b, c) in global-frame
  //   order (x-y-z) is (a, c, −b). So:
  //     (X_cs, −Z_cs, 0)      → (X_cs, 0, Z_cs)             ✓ base on cut plane
  //     (X_cs, −Z_cs, Yspan)  → (X_cs, Yspan, Z_cs)         ✓ vertical extrude
  //
  // Apex C at (X_apex, −apexDepth) in 2D → (X_apex, *, +apexDepth)
  // after extrude + rotation. Apex points in +Z_cs as required.
  //
  // For the pentagon (bondDepth > 0) the two extra vertices at 2D-Y =
  // +bondDepth correspond to Z_cs = −bondDepth, placing the rectangular
  // base in piece (c−1)'s territory for a solid union bond.
  const polygon: [number, number][] =
    bondDepth > 0
      ? [
          [xApex - halfWidth, bondDepth],
          [xApex + halfWidth, bondDepth],
          [xApex + halfWidth, 0],
          [xApex, -apexDepth],
          [xApex - halfWidth, 0],
        ]
      : [
          [xApex - halfWidth, 0],
          [xApex + halfWidth, 0],
          [xApex, -apexDepth],
        ];

  let cs: CrossSection | undefined;
  let prism0: Manifold | undefined;
  let prismOrientedPreTranslate: Manifold | undefined;
  let prismOriented: Manifold | undefined;
  let prismUnrotated: Manifold | undefined;
  let prismWorld: Manifold | undefined;
  try {
    // `ofPolygons` with 'NonZero' fill rule doesn't care about winding,
    // so we don't need to pre-sort vertices CCW — the triangle is
    // uniquely determined regardless.
    cs = toplevel.CrossSection.ofPolygons(
      [polygon] as SimplePolygon[],
      'NonZero',
    );
    // Extrude along +Z for the full shell Y span.
    prism0 = cs.extrude(shellYSpan);
    // After extrude (pentagon case bondDepth > 0):
    //     X ∈ [xApex−halfWidth, xApex+halfWidth],
    //     Y ∈ [−apexDepth, +bondDepth],      (2D-Y = −Z_cs)
    //     Z ∈ [0, shellYSpan].
    // Triangle case (bondDepth = 0): Y ∈ [−apexDepth, 0] as before.
    //
    // Rotate −90° about +X (in the global-x-y-z order that `Manifold
    // .rotate([rx,ry,rz])` uses), so (a,b,c) → (a, c, −b):
    //     X → X, Y → −Z, Z → +Y.
    // The prism becomes:
    //     X ∈ [xApex−halfWidth, xApex+halfWidth]  (radial)
    //     Y ∈ [0, shellYSpan]                      (vertical, local base)
    //     Z ∈ [−bondDepth, +apexDepth]             (n_CCW side; triangle: [0, +apexDepth])
    prismOrientedPreTranslate = prism0.rotate([-90, 0, 0]);
    // Lift to world Y so the prism's base sits at shellMinY.
    prismOriented = prismOrientedPreTranslate.translate([0, shellMinY, 0]);
    prismOrientedPreTranslate.delete();
    prismOrientedPreTranslate = undefined;
    // Inverse forward-rotation: rotate by −angleDeg about +Y so
    //   X (radial)      → radial(angleDeg)
    //   Z (+n_CCW_cs)   → +n_CCW(angleDeg)
    prismUnrotated = prismOriented.rotate([0, -angleDeg, 0]);
    // Translate back to the cut axis (Y unchanged — the rotation was
    // about a vertical axis through the world origin).
    prismWorld = prismUnrotated.translate([xzCenter.x, 0, xzCenter.z]);
    const out = prismWorld;
    prismWorld = undefined;
    return out;
  } finally {
    if (cs) {
      try { cs.delete(); } catch { /* already dead */ }
    }
    if (prism0) {
      try { prism0.delete(); } catch { /* already dead */ }
    }
    if (prismOrientedPreTranslate) {
      try { prismOrientedPreTranslate.delete(); } catch { /* already dead */ }
    }
    if (prismOriented) {
      try { prismOriented.delete(); } catch { /* already dead */ }
    }
    if (prismUnrotated) {
      try { prismUnrotated.delete(); } catch { /* already dead */ }
    }
    if (prismWorld) {
      try { prismWorld.delete(); } catch { /* already dead */ }
    }
  }
}

/**
 * Clipper2 circular-segment count for round joins on the 2D offset.
 * Matches `brim.ts` so the cut-face slab's outer silhouette is
 * bit-identical to the brim builder's — guarantees the seal clips to
 * exactly the brim's edge at every Y.
 */
const OFFSET_CIRCULAR_SEGMENTS = 32;

/**
 * Build a world-frame Manifold representing the "cut-face slab" at
 * `angleDeg` through `xzCenter`: the 2D cross-section of the shell-
 * with-brim at that cut plane, extruded by `± slabHalfDepth` along the
 * cut-plane normal. Used to clip the V-chevron prism so the seal
 * follows the shell's edge profile at every Y (see the "Profile-follow
 * fix" note at the top of the V-chevron section).
 *
 * Construction (mirrors the brim builder's slice pipeline):
 *
 *   1. `csFilled` — the 2D filled shell silhouette at the cut plane.
 *      Either read from `cachedSlice` or computed via `buildCutPlaneSlice`.
 *   2. `csOutward = csFilled.offset(brimWidth_mm, 'Round')` — inflates
 *      outward to cover the brim flange. Same offset the brim builder
 *      uses, so the slab's outer silhouette matches the brim's outer
 *      silhouette bit-for-bit.
 *   3. Clip `csOutward` to Y ∈ [shellMinY, shellMaxY] so the slab
 *      doesn't overshoot the shell's vertical extent (the 2D offset is
 *      isotropic, so it grows the profile by brimWidth in +Y and −Y
 *      too — clipped off here, same as `brim.ts` step 3b).
 *   4. Extrude the clipped cross-section along +Z_cs by `2 × slabHalfDepth`.
 *   5. Translate along Z_cs by `−slabHalfDepth` so the slab is
 *      symmetric around Z_cs = 0.
 *   6. Rotate by `−angleDeg` about +Y to map the cut-local frame to
 *      world (inverse of the forward cut rotation).
 *   7. Translate by `(xzCenter.x, 0, xzCenter.z)` to land on the cut
 *      axis.
 *
 * Returns a FRESH Manifold, or `null` when the cut-plane slice is
 * degenerate (empty shell slice, or the cache entry is `null`). When
 * `null` is returned, the caller should skip the seal at this cut
 * plane — the same behaviour `addBrim` exhibits for degenerate cache
 * entries.
 *
 * Ownership: the returned Manifold is caller-owned. When
 * `cachedSlice` is provided, the cached CrossSections are NOT
 * disposed. When the slice is computed locally (cachedSlice ===
 * undefined), the local slice is disposed before returning.
 */
function buildCutFaceSlabAtCut(
  toplevel: ManifoldToplevel,
  angleDeg: number,
  xzCenter: XzCenter,
  brimWidth_mm: number,
  shellMinY: number,
  shellMaxY: number,
  slabHalfDepth: number,
  cachedSlice: CutPlaneSlice | null | undefined,
  shellManifold: Manifold,
): Manifold | null {
  const shellYSpan = shellMaxY - shellMinY;
  if (!(shellYSpan > 0) || !(brimWidth_mm > 0) || !(slabHalfDepth > 0)) {
    return null;
  }

  if (cachedSlice === null) {
    // Caller told us this cut plane is degenerate.
    return null;
  }
  let localSlice: CutPlaneSlice | null = null;
  let slice: CutPlaneSlice;
  if (cachedSlice !== undefined) {
    slice = cachedSlice;
  } else {
    localSlice = buildCutPlaneSlice(toplevel, shellManifold, xzCenter, angleDeg);
    if (!localSlice) {
      return null;
    }
    slice = localSlice;
  }

  let csOutwardRaw: CrossSection | undefined;
  let clipRect: CrossSection | undefined;
  let clipRectPlaced: CrossSection | undefined;
  let csOutward: CrossSection | undefined;
  let prism0: Manifold | undefined;
  let prismCentred: Manifold | undefined;
  let prismUnrotated: Manifold | undefined;
  let prismWorld: Manifold | undefined;
  try {
    csOutwardRaw = slice.csFilled.offset(
      brimWidth_mm,
      'Round',
      2,
      OFFSET_CIRCULAR_SEGMENTS,
    );
    if (csOutwardRaw.isEmpty()) {
      return null;
    }
    // Clip to [shellMinY, shellMaxY] in Y_cs. X_cs span is unbounded
    // by the clip — the slab must cover the full radial extent of the
    // brim+shell so we keep the 2D X range generous.
    const filledBounds = slice.filledBounds;
    const clipHalfX =
      Math.max(
        Math.abs(filledBounds.min[0]!),
        Math.abs(filledBounds.max[0]!),
      ) +
      brimWidth_mm +
      10;
    const clipWidthX = 2 * clipHalfX;
    clipRect = toplevel.CrossSection.square(
      [clipWidthX, shellYSpan],
      /* center */ true,
    );
    clipRectPlaced = clipRect.translate([0, (shellMinY + shellMaxY) / 2]);
    csOutward = csOutwardRaw.intersect(clipRectPlaced);
    if (csOutward.isEmpty()) {
      return null;
    }
    // Extrude by 2×slabHalfDepth along local +Z, then translate
    // along Z by −slabHalfDepth so the slab is symmetric around
    // Z_cs = 0. The slab's 2D footprint is in (X_cs, Y_cs) — which
    // matches the brim builder's local frame.
    prism0 = csOutward.extrude(2 * slabHalfDepth);
    // After extrude: X ∈ outward-offset profile in X_cs,
    //               Y ∈ csOutward's Y range (clipped to shell Y),
    //               Z ∈ [0, 2 × slabHalfDepth].
    // We want the slab centred on Z = 0 in world AFTER rotation.
    // In cut-local, that means Z_cs ∈ [−slabHalfDepth, +slabHalfDepth].
    // But note: the CrossSection's (2D-X, 2D-Y) are (X_cs, Y_cs),
    // and extrude is along +Z (= Z_cs). So translate along +Z by
    // −slabHalfDepth to centre on Z_cs = 0.
    prismCentred = prism0.translate([0, 0, -slabHalfDepth]);
    // Inverse forward-rotation: rotate by −angleDeg about +Y so the
    // cut-local (X_cs, Y_cs, Z_cs) frame maps to world.
    prismUnrotated = prismCentred.rotate([0, -angleDeg, 0]);
    prismWorld = prismUnrotated.translate([xzCenter.x, 0, xzCenter.z]);
    const out = prismWorld;
    prismWorld = undefined;
    return out;
  } finally {
    if (csOutwardRaw) {
      try { csOutwardRaw.delete(); } catch { /* already dead */ }
    }
    if (clipRect) {
      try { clipRect.delete(); } catch { /* already dead */ }
    }
    if (clipRectPlaced) {
      try { clipRectPlaced.delete(); } catch { /* already dead */ }
    }
    if (csOutward) {
      try { csOutward.delete(); } catch { /* already dead */ }
    }
    if (prism0) {
      try { prism0.delete(); } catch { /* already dead */ }
    }
    if (prismCentred) {
      try { prismCentred.delete(); } catch { /* already dead */ }
    }
    if (prismUnrotated) {
      try { prismUnrotated.delete(); } catch { /* already dead */ }
    }
    if (prismWorld) {
      try { prismWorld.delete(); } catch { /* already dead */ }
    }
    if (localSlice) {
      disposeCutPlaneSlice(localSlice);
    }
  }
}

/**
 * Y-axis bounds of the shell (pre-slice) used by the seal builder. The
 * V-chevron prism's vertical extent is exactly this range — the V runs
 * the FULL shell height from bottom to top.
 */
export interface ShellYBounds {
  minY: number;
  maxY: number;
}

export interface ApplyVChevronSealArgs {
  toplevel: ManifoldToplevel;
  /**
   * Brimmed shell pieces in the same order as `sliceShellRadial` (piece
   * `i` bounded by cut angles `[angles[i], angles[(i+1) % sideCount]]`).
   * CONSUMED by this function: each input handle is `.delete()`-ed on
   * both success and failure paths. Returned array contains FRESH
   * handles.
   */
  pieces: Manifold[];
  sideCount: 2 | 3 | 4;
  xzCenter: XzCenter;
  angles: readonly number[];
  /**
   * Full shell's Y bounds pre-slice. The V-chevron prism is extruded
   * along Y from `shellY.minY` to `shellY.maxY` — full shell height.
   */
  shellY: ShellYBounds;
  /**
   * Radial distance from `xzCenter` to the shell's outer silhouette (mm).
   * `xApex` is set to this value so the V straddles the shell wall /
   * brim junction. Caller derives it from the pre-slice shell's bounding
   * box (see `generateMold.ts`).
   */
  shellOuterRadius_mm: number;
  /**
   * Brim radial width (mm). Used to build the cut-face 2D clipping slab
   * — `csOutward = csFilled.offset(brimWidth_mm)` matches the brim
   * builder's outer silhouette so the V-prism can be clipped to the
   * actual (brim + shell) cut-face footprint at every Y. Must match the
   * `brimWidth_mm` passed to `addBrim` for the same pieces.
   */
  brimWidth_mm: number;
  /**
   * CALLER-OWNED full (pre-slice) print shell Manifold. Used as the
   * fallback source when `cutPlaneSlices` doesn't have a pre-computed
   * entry for a cut angle (the seal builder re-slices the shell in that
   * case, the same way `addBrim` falls back). `applyTongueAndGrooveSeals`
   * does NOT `.delete()` this Manifold. Pass the same handle the caller
   * holds for `addBrim`.
   */
  shellManifold: Manifold;
  /**
   * Optional cache of pre-computed cut-plane cross-sections, same shape
   * as `AddBrimArgs.cutPlaneSlices`. When present, the seal builder
   * REUSES `csFilled` from the cache for each cut's slab, skipping the
   * re-slice + hole-fill. Typical caller pattern: share the cache with
   * the brim pass (build once per unique cut angle, feed both calls).
   *
   * CALLER-OWNED — entries are not disposed by the seal builder. A
   * `null` entry means "degenerate — skip seal at this cut plane"
   * (matches the cache semantics used by `addBrim`).
   */
  cutPlaneSlices?: ReadonlyMap<number, CutPlaneSlice | null>;
}

/**
 * Apply V-chevron tongue-and-groove seals to every shared cut plane.
 *
 * For each cut plane at angle `a_c`:
 *
 *   - `grooveIdx = c` (piece on +n_CCW(a_c) side): SUBTRACT an inflated
 *     triangular prism (halfWidth + CLEARANCE/2, apexDepth + CLEARANCE/2)
 *     — carves a GROOVE cavity into the cut face.
 *   - `tongueIdx = (c − 1 + sideCount) % sideCount` (piece on −n_CCW
 *     side): UNION a shrunk triangular prism (halfWidth − CLEARANCE/2,
 *     apexDepth − CLEARANCE/2) — bulges a TONGUE into +n_CCW
 *     territory, landing inside the mating piece's groove cavity with a
 *     `CLEARANCE / 2` air gap on every sloped contact face.
 *
 * sideCount=2 edge case: only one unique cut plane (a_0 = angles[0]).
 * Piece 0 is on +n_CCW(a_0) side → groove; piece 1 on −n side → tongue.
 *
 * @returns Fresh `Manifold[]` matching `pieces.length`. Caller owns
 *   each handle and must `.delete()` them. Inputs are consumed.
 */
export function applyTongueAndGrooveSeals(
  args: ApplyVChevronSealArgs,
): Manifold[] {
  const {
    toplevel,
    pieces,
    sideCount,
    xzCenter,
    angles,
    shellY,
    shellOuterRadius_mm,
    brimWidth_mm,
    shellManifold,
    cutPlaneSlices,
  } = args;

  if (pieces.length !== sideCount) {
    throw new Error(
      `applyTongueAndGrooveSeals: expected ${sideCount} pieces, got ${pieces.length}`,
    );
  }
  if (angles.length !== sideCount) {
    throw new Error(
      `applyTongueAndGrooveSeals: expected ${sideCount} angles, got ${angles.length}`,
    );
  }

  // Unique cut planes: sideCount=2 has one plane (the two angles define
  // the same vertical cut); sideCount=3/4 has one per angle.
  const cutCount = sideCount === 2 ? 1 : sideCount;

  // Groove prism: half-extents INFLATED by clearance/2 so the cavity is
  // `CLEARANCE/2` mm larger on every sloped contact.
  const grooveHalfWidth = SEAL_HALF_WIDTH_MM + SEAL_CLEARANCE_MM / 2;
  const grooveApexDepth = SEAL_APEX_DEPTH_MM + SEAL_CLEARANCE_MM / 2;
  // Tongue prism: half-extents SHRUNK by the same amount so the tongue
  // is `CLEARANCE/2` mm smaller on every sloped contact (net air gap
  // is CLEARANCE mm / 2 per side ⇒ CLEARANCE mm total across the pair).
  const tongueHalfWidth = SEAL_HALF_WIDTH_MM - SEAL_CLEARANCE_MM / 2;
  const tongueApexDepth = SEAL_APEX_DEPTH_MM - SEAL_CLEARANCE_MM / 2;
  if (!(tongueHalfWidth > 0) || !(tongueApexDepth > 0)) {
    throw new Error(
      `applyTongueAndGrooveSeals: clearance ${SEAL_CLEARANCE_MM} consumes the ` +
        `tongue (halfWidth=${SEAL_HALF_WIDTH_MM}, apexDepth=${SEAL_APEX_DEPTH_MM})`,
    );
  }

  // `result` aliases `pieces` slots so failure cleanup is straightforward:
  // whatever's in the slot (original or already-swapped) gets `.delete()`-ed
  // on throw.
  const result = [...pieces];

  const swapSlot = (idx: number, fresh: Manifold): void => {
    const old = result[idx] as Manifold;
    result[idx] = fresh;
    try { old.delete(); } catch { /* already dead */ }
  };

  // Slab half-depth: the cut-face 2D region is extruded by ±slabHalfDepth
  // along the cut-plane normal before intersecting the V-prism. The
  // groove (triangle) lives in Z_cs ∈ [0, +grooveApexDepth]; the tongue
  // (pentagon) lives in Z_cs ∈ [−SEAL_TONGUE_BOND_DEPTH_MM,
  // +tongueApexDepth]. Pick half-depth large enough to contain both
  // (|min| and max), plus 1 mm of slack so co-planar clips at the prism
  // extents don't get nicked by kernel epsilon.
  const slabHalfDepth =
    Math.max(grooveApexDepth, SEAL_TONGUE_BOND_DEPTH_MM) + 1;

  let done = false;
  try {
    for (let c = 0; c < cutCount; c++) {
      const angleDeg = angles[c] as number;
      const grooveIdx = c; // piece on +n_CCW(a_c) side
      const tongueIdx = (c - 1 + sideCount) % sideCount; // piece on −n side

      // Build the cut-face clipping slab ONCE per cut plane. Reused by
      // both the groove subtract and the tongue union so we pay the
      // slice + offset + extrude cost only once per cut, even on
      // sideCount=3/4 where each plane has both a groove and a tongue
      // piece.
      const cachedSlice = cutPlaneSlices?.get(angleDeg);
      const cutFaceSlab = buildCutFaceSlabAtCut(
        toplevel,
        angleDeg,
        xzCenter,
        brimWidth_mm,
        shellY.minY,
        shellY.maxY,
        slabHalfDepth,
        cachedSlice,
        shellManifold,
      );
      if (cutFaceSlab === null) {
        // Degenerate slice (empty shell at this cut plane, or cache
        // entry explicitly `null`). Skip the seal for this cut — the
        // piece stays unmodified, same behaviour as `addBrim` on a
        // degenerate slice.
        continue;
      }

      try {
        // Groove: subtract the inflated prism (clipped to the cut
        // face) from piece on +n_CCW side.
        const grooveRaw = buildVChevronAtCut(
          toplevel,
          angleDeg,
          xzCenter,
          shellOuterRadius_mm,
          grooveHalfWidth,
          grooveApexDepth,
          shellY.minY,
          shellY.maxY,
        );
        let groovePrism: Manifold;
        try {
          // Clip the V-prism to the cut-face slab → follows the edge
          // profile at every Y (no floating tongue past the brim's
          // narrow top on a tapered shell).
          groovePrism = toplevel.Manifold.intersection([grooveRaw, cutFaceSlab]);
        } finally {
          grooveRaw.delete();
        }
        try {
          if (!groovePrism.isEmpty()) {
            const grooved = toplevel.Manifold.difference([
              result[grooveIdx] as Manifold,
              groovePrism,
            ]);
            try {
              swapSlot(grooveIdx, grooved);
            } catch (err) {
              try { grooved.delete(); } catch { /* already dead */ }
              throw err;
            }
          }
        } finally {
          groovePrism.delete();
        }

        // Tongue: union the shrunk PENTAGON (clipped to the cut face)
        // onto piece on −n_CCW side. The pentagon's triangular apex
        // sticks into +n_CCW territory (foreign to the mating piece —
        // exactly where we want the tongue to extend). The rectangular
        // bond base at Z_cs ∈ [−SEAL_TONGUE_BOND_DEPTH_MM, 0] sits
        // INSIDE the mating piece so the union has real volume overlap
        // and produces a single connected solid (see PR-117 follow-up
        // comment above for the floating-tongue artifact this fixes).
        const tongueRaw = buildVChevronAtCut(
          toplevel,
          angleDeg,
          xzCenter,
          shellOuterRadius_mm,
          tongueHalfWidth,
          tongueApexDepth,
          shellY.minY,
          shellY.maxY,
          SEAL_TONGUE_BOND_DEPTH_MM,
        );
        let tonguePrism: Manifold;
        try {
          tonguePrism = toplevel.Manifold.intersection([tongueRaw, cutFaceSlab]);
        } finally {
          tongueRaw.delete();
        }
        try {
          if (!tonguePrism.isEmpty()) {
            const tongued = toplevel.Manifold.union(
              result[tongueIdx] as Manifold,
              tonguePrism,
            );
            try {
              swapSlot(tongueIdx, tongued);
            } catch (err) {
              try { tongued.delete(); } catch { /* already dead */ }
              throw err;
            }
          }
        } finally {
          tonguePrism.delete();
        }
      } finally {
        cutFaceSlab.delete();
      }
    }
    done = true;
    return result;
  } finally {
    if (!done) {
      for (const m of result) {
        if (m) {
          try { m.delete(); } catch { /* already dead */ }
        }
      }
    }
  }
}
