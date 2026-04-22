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

import type { Manifold, ManifoldToplevel, Vec3 } from 'manifold-3d';

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
// Inter-piece tongue-and-groove seal (issue piece-seal, 2026-04-22 dogfood).
// ============================================================================
//
// After `sliceShellRadial` (+ brim) each piece's cut face is a flat vertical
// plane. When the user pours silicone into the assembled mold, any
// microscopic gap along the seam between two pieces lets silicone flow out.
// Industry-standard fix: a half-height STEP on each cut face that forms a
// tongue-and-groove interlock when assembled, turning a straight leak path
// into a labyrinth.
//
// Geometry:
//
//   At each cut plane at angle θ through `xzCenter`, the plane's normal is
//   `n_CCW(θ) = (-sin θ, 0, cos θ)`. Piece N on the +n_CCW side has its
//   interior at `dot(p, n_CCW) > 0`; piece N+1 on the -n side has interior
//   at `dot(p, n_CCW) < 0`. Partition the cut face horizontally at
//   `midShellY = (shellMinY + shellMaxY) / 2`:
//
//     - LOWER half (Y < midShellY): cut face STAYS at Z_cs = 0 (unchanged).
//     - UPPER half (Y > midShellY): piece N GROOVE — subtract a block that
//       occupies piece N's near-cut material at Z_cs ∈ [0, SEAL_STEP_MM].
//       After subtraction, piece N's upper cut face is at Z_cs = SEAL_STEP.
//
//     - UPPER half, piece N+1 (on -n side): TONGUE — UNION a block that
//       extends into piece N's territory at Z_cs ∈ [0, SEAL_STEP - CLEARANCE].
//       This tongue slides into the groove when assembled.
//
//   Clearance: `SEAL_CLEARANCE_MM` keeps the tongue slightly thinner than the
//   groove so FDM parts slide together without binding.
//
// Cut-plane-local frame:
//
//   Manifold.cube builds axis-aligned prisms. Rather than build a
//   half-space-normal-aligned block from scratch (non-trivial), we build
//   the block in a LOCAL frame where the cut plane coincides with the
//   world XY plane (Z_cs = 0), then rotate + translate it back to world.
//
//   Forward transform to local frame (mirrors `brim.ts`):
//     1. Translate by `(-xzCenter.x, 0, -xzCenter.z)` so the cut axis passes
//        through world origin.
//     2. Rotate about +Y by `+θ_deg`. Maps `radial(θ) → +X_cs`, `n_CCW(θ) →
//        +Z_cs`.
//
//   Inverse transform:
//     1. Rotate about +Y by `-θ_deg`.
//     2. Translate by `+xzCenter`.
//
// sideCount=2 case:
//
//   Only one unique cut plane (the two angles 90° and 270° define the same
//   vertical plane). Piece 0 is on +n_CCW(90°) = -X side; piece 1 is on +X
//   side. Apply the groove to piece 0 and the tongue to piece 1 — consistent
//   with the "piece i on +n_CCW(a_i) side gets groove, piece i+1 gets tongue"
//   rule applied to the single a_0 = 90°.
//
// Ownership:
//
//   - Input pieces are CONSUMED (`.delete()`-ed) on both success and
//     failure. Returned array contains FRESH Manifold handles the caller
//     owns.
//   - On partial failure, every remaining consumed/replaced piece is
//     cleaned up before re-throw.

/**
 * Groove depth (mm). The step cut INTO piece N at the cut plane. Picked at
 * 2 mm per issue spec — large enough to form a labyrinth even after FDM
 * layer-by-layer smoothing, small enough to fit within the shell wall on
 * the minimum-viable printShellThickness (3 mm default).
 */
export const SEAL_STEP_MM = 2.0;

/**
 * Tongue/groove clearance (mm). The tongue is made `SEAL_STEP - SEAL_CLEARANCE`
 * wide on Z_cs so FDM parts slide together without binding. Also applied
 * as vertical clearance at the step's upper Y bound so the tongue's top
 * doesn't bottom out in the groove.
 */
export const SEAL_CLEARANCE_MM = 0.2;

/**
 * Extra Z_cs slop (mm) on the groove-subtract block, past `SEAL_STEP_MM`.
 * Ensures the subtract block fully envelopes piece N's Z_cs ∈ [0, SEAL_STEP]
 * region even after kernel rounding. Safe because the extra slop sits in
 * Z_cs > SEAL_STEP which is ENTIRELY OUTSIDE piece N's interior — subtract
 * of empty-intersection is a no-op.
 */
const SEAL_GROOVE_SLOP_MM = 0.5;

/**
 * Radial bloat applied to the step block's X_cs half-extent past the shell
 * outer radius. Must cover the brim flange's full radial extent so the
 * groove cuts through both the shell and the brim in a single subtract.
 * 50 mm covers brims up to that width with slack — the brim parameter
 * tops out at ~20 mm in practice, so there's plenty of headroom.
 */
const SEAL_BLOCK_RADIAL_SLOP_MM = 50;

/**
 * Build one step block in world frame for the cut plane at `angleDeg`
 * through `xzCenter`. The block occupies, in cut-local frame:
 *
 *   X_cs ∈ [-X_half, +X_half]  — spans the full radial extent at the cut
 *   Y    ∈ [midShellY, blockMaxY]  — upper half only
 *   Z_cs ∈ [zMin, zMax]  — caller-specified (groove extent or tongue extent)
 *
 * The block is built in the local frame via `Manifold.cube` + `.translate`,
 * then rotated `-angleDeg` about +Y and translated by `+xzCenter` to land
 * in world-space on the correct cut plane.
 *
 * Returns a fresh Manifold (caller `.delete()` when done).
 */
function buildStepBlockAtCut(
  toplevel: ManifoldToplevel,
  angleDeg: number,
  xzCenter: XzCenter,
  midShellY: number,
  blockMaxY: number,
  xHalfExtent: number,
  zMin: number,
  zMax: number,
): Manifold {
  const blockYSpan = blockMaxY - midShellY;
  const blockZSpan = zMax - zMin;
  const blockXSpan = 2 * xHalfExtent;
  if (!(blockYSpan > 0) || !(blockZSpan > 0) || !(blockXSpan > 0)) {
    throw new Error(
      `buildStepBlockAtCut: degenerate block span (X=${blockXSpan}, ` +
        `Y=${blockYSpan}, Z=${blockZSpan})`,
    );
  }
  // Centered cube → span [-xHalfExtent, xHalfExtent] × [-Y/2, Y/2] ×
  // [-Z/2, Z/2] in its local frame. Translate so its center lands at the
  // desired midpoint.
  const blockCentered = toplevel.Manifold.cube(
    [blockXSpan, blockYSpan, blockZSpan],
    /* center */ true,
  );
  let blockLocal: Manifold | undefined;
  let blockRotated: Manifold | undefined;
  let blockWorld: Manifold | undefined;
  try {
    // In local frame (pre-inverse-rotation): cut-plane origin is at
    // (0, 0, 0), the cut plane is Z_cs = 0 (world XY after rotation).
    // Target block center: (0, (midShellY + blockMaxY)/2, (zMin + zMax)/2).
    blockLocal = blockCentered.translate([
      0,
      (midShellY + blockMaxY) / 2,
      (zMin + zMax) / 2,
    ]);
    // Inverse rotation: `-angleDeg` about +Y maps local +X → radial(θ) and
    // local +Z → n_CCW(θ). Matches the inverse of the forward rotation
    // used in `brim.ts` + `buildCutPlaneSlice`.
    blockRotated = blockLocal.rotate([0, -angleDeg, 0]);
    // Inverse translation: bring the cut-axis origin back to xzCenter.
    blockWorld = blockRotated.translate([xzCenter.x, 0, xzCenter.z]);
    const out = blockWorld;
    blockWorld = undefined;
    return out;
  } finally {
    blockCentered.delete();
    if (blockLocal) blockLocal.delete();
    if (blockRotated) blockRotated.delete();
    if (blockWorld) blockWorld.delete();
  }
}

/**
 * Y-axis bounds of the shell (pre-slice) used by the seal builder.
 */
export interface ShellYBounds {
  minY: number;
  maxY: number;
}

export interface ApplyTongueAndGrooveArgs {
  toplevel: ManifoldToplevel;
  /**
   * Brimmed shell pieces in the same order as `sliceShellRadial` (piece i
   * bounded by cut angles `[angles[i], angles[(i+1) % sideCount]]`). CONSUMED
   * by this function: each input handle is `.delete()`-ed on both success and
   * failure paths. Returned array contains FRESH handles.
   */
  pieces: Manifold[];
  sideCount: 2 | 3 | 4;
  xzCenter: XzCenter;
  angles: readonly number[];
  /**
   * Full shell's Y bounds pre-slice. The seal's step sits at the midpoint of
   * this range; UPPER half = Y > midY.
   */
  shellY: ShellYBounds;
  /**
   * Maximum radial extent to cover at each cut (from xzCenter outward to the
   * brim's outer edge). The step block's X_cs half-extent is set to
   * `radialMax_mm + SEAL_BLOCK_RADIAL_SLOP_MM` so the block spans the full
   * shell+brim width at that cut.
   */
  radialMax_mm: number;
}

/**
 * Apply tongue-and-groove seals to every shared cut plane between adjacent
 * pieces. For each cut plane at angle `a_c`:
 *
 *   - Piece c (its lower-CCW bound, on +n_CCW(a_c) side): SUBTRACT the
 *     full-depth groove block (Z_cs ∈ [0, SEAL_STEP_MM + slop]) in upper Y half.
 *   - Piece (c - 1) mod sideCount (its upper-CCW bound, on -n side):
 *     UNION a tongue (Z_cs ∈ [0, SEAL_STEP_MM − SEAL_CLEARANCE_MM]) in upper
 *     Y half. The tongue's radial silhouette is clipped to the shell's
 *     actual shape at the cut by intersecting with the mating piece shifted
 *     +SEAL_STEP along +n_CCW, so the tongue inherits the shell's exact
 *     outline (no slab-past-the-brim).
 *
 * sideCount=2 edge case: only one cut plane (a_0 = angles[0]). Piece 0 is
 * on +n_CCW(a_0) side → gets groove; piece 1 on -n side → gets tongue.
 *
 * @returns Fresh `Manifold[]` matching `pieces.length`. Caller owns each
 *   handle and must `.delete()` them. Inputs are consumed.
 */
export function applyTongueAndGrooveSeals(
  args: ApplyTongueAndGrooveArgs,
): Manifold[] {
  const {
    toplevel,
    pieces,
    sideCount,
    xzCenter,
    angles,
    shellY,
    radialMax_mm,
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

  const midShellY = (shellY.minY + shellY.maxY) / 2;
  const xHalfExtent = radialMax_mm + SEAL_BLOCK_RADIAL_SLOP_MM;

  // Determine the unique cut planes. For sideCount=3/4 there are `sideCount`
  // cut planes (one per angle). Piece i is bounded by a_i (its lower-CCW
  // bound) and a_{i+1} (its upper-CCW bound), so:
  //   - cut a_i is SHARED between piece i (on +n_CCW(a_i) side → groove)
  //     and piece (i - 1 + sideCount) % sideCount (on -n_CCW(a_i) side →
  //     tongue).
  //
  // For sideCount=2 angles = [90, 270], but both 90° and 270° define the
  // SAME vertical plane (normals are opposites, half-space flips). Apply
  // ONE step at a_0 = 90°: piece 0 on +n_CCW(90°) side = -X world → groove;
  // piece 1 on +X world → tongue.
  const cutCount = sideCount === 2 ? 1 : sideCount;

  // `result` aliases `pieces` slots so failure cleanup is straightforward.
  // After each groove/tongue step we swap the slot in place.
  const result = [...pieces];

  // Whether a piece slot still holds the ORIGINAL input handle (false) or
  // a fresh handle we allocated (true). Used only for error-path cleanup
  // symmetry — either way, we `.delete()` whatever's in the slot on error.
  const disposableSlots = new Set<number>();
  for (let i = 0; i < result.length; i++) disposableSlots.add(i);

  // Helper to replace slot `idx` with `fresh` and safely delete the old.
  const swapSlot = (idx: number, fresh: Manifold): void => {
    const old = result[idx] as Manifold;
    result[idx] = fresh;
    try { old.delete(); } catch { /* already dead */ }
  };

  try {
    for (let c = 0; c < cutCount; c++) {
      const angleDeg = angles[c] as number;
      const grooveIdx = c; // piece on +n_CCW(a_c) side (its lower-CCW bound)
      const tongueIdx = (c - 1 + sideCount) % sideCount; // piece on -n side (its upper-CCW bound)

      // Groove block: Z_cs ∈ [0, SEAL_STEP + slop], full upper-Y.
      // Slop in +Z_cs is safe because Z_cs > SEAL_STEP is outside piece's
      // volume entirely (piece i extends only to Z_cs = 0 at worst at the
      // cut face; the slop carves through air).
      const grooveBlock = buildStepBlockAtCut(
        toplevel,
        angleDeg,
        xzCenter,
        midShellY,
        shellY.maxY,
        xHalfExtent,
        0,
        SEAL_STEP_MM + SEAL_GROOVE_SLOP_MM,
      );
      try {
        const grooved = toplevel.Manifold.difference([
          result[grooveIdx] as Manifold,
          grooveBlock,
        ]);
        try {
          // Swap. `grooved` may legitimately be empty on pathological
          // inputs (tiny piece wholly inside the upper-Y step block's
          // footprint) — we tolerate empty here rather than throwing.
          swapSlot(grooveIdx, grooved);
        } catch (err) {
          try { grooved.delete(); } catch { /* already dead */ }
          throw err;
        }
      } finally {
        grooveBlock.delete();
      }

      // Tongue block: Z_cs ∈ [0, SEAL_STEP - CLEARANCE], vertical-clamped
      // so its TOP doesn't quite reach shellY.maxY (leaves CLEARANCE mm
      // of air above the tongue so the mating piece's groove face
      // doesn't bottom-out). Bottom stays at midShellY.
      const tongueTopY = shellY.maxY - SEAL_CLEARANCE_MM;
      const tongueZMax = SEAL_STEP_MM - SEAL_CLEARANCE_MM;
      if (tongueTopY <= midShellY || !(tongueZMax > 0)) {
        // Degenerate tongue (clearance ≥ step, or upper-Y span <= 0).
        // Skip this cut's tongue. Groove still applied above.
        continue;
      }
      // Build the raw tongue block with FULL radial extent — needed so
      // the next intersect step inherits the exact shell silhouette at
      // the cut plane rather than a box-truncated approximation.
      const tongueBlockRaw = buildStepBlockAtCut(
        toplevel,
        angleDeg,
        xzCenter,
        midShellY,
        tongueTopY,
        xHalfExtent,
        0,
        tongueZMax,
      );
      try {
        // Clip the tongue to the shell's actual shape in the +Z_cs
        // (piece-N) territory. The tongue sits where piece N had
        // material pre-groove — EXACTLY the region
        // `groovedPiece ∪ grooveBlock` restricted to Z_cs ∈ [0, tongueZMax].
        // We reconstruct the pre-groove piece N by unioning the current
        // (grooved) piece with the grooveBlock ∩ tongueBlockRaw sliver.
        // Cheaper equivalent: intersect the tongueBlockRaw with
        // (piece_N_current ∪ grooveBlock). Since the current piece
        // doesn't reach into Z_cs > 0 (the groove was subtracted), the
        // result lies entirely within grooveBlock ∩ tongueBlockRaw —
        // which is the tongueBlockRaw itself (tongueZMax ≤ grooveDepth).
        // So simpler still: intersect with the RAW piece-N-preseal,
        // computed as grooveBlock unioned with the grooved piece.
        //
        // In practice the cleanest construction that clips the tongue to
        // the shell's radial profile is:
        //
        //   pieceN_preseal = result[grooveIdx] ∪ grooveBlockJustRemoved
        //                  = (current grooved piece) ∪
        //                    (original piece_N ∩ grooveBlock)
        //
        // We don't have `original piece_N`, but we have the current
        // grooved piece and the grooveBlock we subtracted. Recovering
        // `original piece_N` precisely is equivalent to redoing the
        // levelSet slice — too heavy. Simpler: clip by piece N+1's
        // TWIN — piece N+1 has identical shell silhouette as piece N
        // at the cut plane (both share the same shell wall locally),
        // so we intersect the tongueBlockRaw with `result[tongueIdx]`
        // shifted up by SEAL_STEP_MM along +Z_cs (world direction
        // n_CCW(θ) × SEAL_STEP_MM). That maps piece N+1's -Z_cs
        // material into the +Z_cs tongue region, giving us a
        // shell-accurate tongue shape.
        //
        // World shift vector for +Z_cs * tongueZMax:
        //   n_CCW(θ) = (-sin θ, 0, cos θ) → world shift = n_CCW × step
        const thetaRad = angleDeg * (Math.PI / 180);
        const shiftX = -Math.sin(thetaRad) * SEAL_STEP_MM;
        const shiftZ = Math.cos(thetaRad) * SEAL_STEP_MM;
        const shiftedPieceNplus1 = (result[tongueIdx] as Manifold).translate([
          shiftX,
          0,
          shiftZ,
        ]);
        let tongued: Manifold | undefined;
        try {
          const tongueClipped = toplevel.Manifold.intersection([
            tongueBlockRaw,
            shiftedPieceNplus1,
          ]);
          try {
            if (tongueClipped.isEmpty()) {
              // No tongue material — skip the union (would be a no-op
              // anyway). Continue to the next cut.
              continue;
            }
            tongued = toplevel.Manifold.union(
              result[tongueIdx] as Manifold,
              tongueClipped,
            );
          } finally {
            tongueClipped.delete();
          }
        } finally {
          shiftedPieceNplus1.delete();
        }
        try {
          swapSlot(tongueIdx, tongued);
        } catch (err) {
          try { tongued.delete(); } catch { /* already dead */ }
          throw err;
        }
      } finally {
        tongueBlockRaw.delete();
      }
    }
    // Clear the disposables set — on success the caller owns everything.
    disposableSlots.clear();
    return result;
  } catch (err) {
    for (const idx of disposableSlots) {
      const m = result[idx];
      if (m) {
        try { m.delete(); } catch { /* already dead */ }
      }
    }
    throw err;
  }
}
