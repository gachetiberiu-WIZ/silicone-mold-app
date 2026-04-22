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
