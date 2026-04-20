// src/geometry/primitives.ts
//
// Shared primitive-builder helpers used by Wave 3 (issue #55 — registration
// keys + sprue + vent channels). Extracted here so the sprue and vent
// helpers in `./sprueVent.ts` can share the exact same cylinder-construction
// path without each duplicating the translation + segment-count defaults.
//
// Registration keys (in `./registrationKeys.ts`) build hemispheres, not
// cylinders, so they don't consume these helpers. Hemisphere construction
// stays local to that module — small, specialised, and unlikely to grow a
// second caller.
//
// Every helper here returns a FRESH `Manifold` owned by the caller. Nothing
// in this module holds references to the returned handles; the caller is
// responsible for `.delete()`-ing them before their scope exits. Each
// helper's JSDoc repeats the ownership contract for clarity at the call
// site.

import type { Manifold, ManifoldToplevel } from 'manifold-3d';

/**
 * Default circular-segment count for cylinders + hemispheres built by
 * Wave 3 helpers. Tuned per the issue body's guidance ("32 for keys +
 * sprue + vents is a good balance between curve fidelity and CSG cost").
 *
 * 32 segments on a radius-2.5 mm cylinder produces ~0.5 mm facet chord —
 * well below the silicone's own levelSet grid resolution, so the curve
 * faceting never becomes the limiting factor for resin-channel fidelity.
 */
export const CIRCULAR_SEGMENTS = 32;

/**
 * Build a vertical (Y-axis) cylinder spanning `[fromY, toY]` on the Y axis,
 * centred at `(xz.x, xz.z)` in the XZ plane, with the given `radius`.
 *
 * Implementation detail — manifold-3d's `Manifold.cylinder` constructor
 * builds an UPWARD cylinder along the Z axis by default (the API docs say
 * "Z-extent"). To produce a Y-axis cylinder we build a Z-axis cylinder of
 * height `toY − fromY`, rotate 90° about +X (so +Z becomes +Y), then
 * translate into place.
 *
 * @param toplevel Initialised Manifold toplevel handle.
 * @param fromY Y coordinate of the cylinder's bottom face (mm).
 * @param toY Y coordinate of the cylinder's top face (mm). MUST be > `fromY`.
 * @param xz XZ-centre of the cylinder's axis, in mm.
 * @param radius Cylinder radius in mm. MUST be > 0.
 * @param segments Optional override for the circular-segment count.
 *   Defaults to `CIRCULAR_SEGMENTS`.
 * @returns A fresh `Manifold` owned by the caller — `.delete()` when done.
 * @throws If `toY <= fromY` or `radius <= 0` (defence-in-depth; the
 *   production callers in Wave 3 guard these before calling).
 */
export function verticalCylinder(
  toplevel: ManifoldToplevel,
  fromY: number,
  toY: number,
  xz: { x: number; z: number },
  radius: number,
  segments: number = CIRCULAR_SEGMENTS,
): Manifold {
  const height = toY - fromY;
  if (!(height > 0) || !Number.isFinite(height)) {
    throw new Error(
      `primitives.verticalCylinder: fromY=${fromY}, toY=${toY} produces non-positive height=${height}`,
    );
  }
  if (!(radius > 0) || !Number.isFinite(radius)) {
    throw new Error(`primitives.verticalCylinder: radius=${radius} must be positive and finite`);
  }

  // Build a Z-axis cylinder at origin (bottom face at Z=0), rotate so
  // its axis becomes +Y, then translate to the intended XZ centre with
  // bottom face at fromY.
  //
  // `Manifold.cylinder(h, r)` with no `center` flag puts the base at Z=0
  // and the top at Z=h. manifold-3d rotations follow the right-hand rule
  // in a right-handed coordinate system. A rotation of +90° about the
  // global X axis takes +Y → +Z (and +Z → −Y), which would leave the
  // cylinder pointing DOWN. The rotation we actually want is −90° about
  // X (or equivalently +270°), which takes +Z → +Y and leaves the axis
  // pointing up.
  //
  // After `.rotate([-90, 0, 0])`:
  //   - the original +Z becomes +Y (bottom at Y=0, top at Y=h)
  //   - the original X stays X, original Y becomes +Z
  // Both consequences are irrelevant for a circular cylinder (rotationally
  // symmetric about the new axis), so we only have to translate in
  // (x, y, z) to position the base at (xz.x, fromY, xz.z).
  const cyl = toplevel.Manifold.cylinder(height, radius, radius, segments, false);
  // rotate + translate are lazy on manifold-3d; the returned handle is the
  // one the caller owns.
  const rotated = cyl.rotate([-90, 0, 0]);
  cyl.delete();
  const translated = rotated.translate([xz.x, fromY, xz.z]);
  rotated.delete();
  return translated;
}
