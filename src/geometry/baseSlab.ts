// src/geometry/baseSlab.ts
//
// Wave D (issue #82). Builds the printable base slab that sits under the
// print shell, with a step-pocket interlock:
//
//   - A flat slab body under the master, footprint = master XZ footprint
//     offset outward by `silicone + printShell + overhang`, extruded
//     DOWN from `master.min.y` by `baseSlabThickness`.
//   - A raised plug on top of that slab, footprint = master XZ footprint
//     offset outward by `silicone - 0.2 mm` (horizontal clearance so the
//     shell drops on without binding). Extruded UP by 2 mm.
//   - Unioned into a single watertight Manifold.
//
// Slicing frame — coordinate-system gotcha
// ----------------------------------------
//
// `Manifold.slice(height)` slices parallel to the XY plane at Z=height.
// Our pipeline is Y-up (three.js), so we rotate the master +90° about +X
// so our-world +Y becomes rotated-frame +Z — that's the direction slice
// expects. After offsetting / extruding the 2D footprint in the rotated
// frame, we rotate the result -90° about +X to bring it back into our
// Y-up world.
//
// Verification of the rotation direction (matches `./primitives.ts`
// comments): a rotation of +90° about +X has matrix
//
//   [ 1  0   0  ]
//   [ 0  0  -1  ]       →  (x, y, z) → (x, -z, y)
//   [ 0  1   0  ]
//
// Applied to a world-space vector (0, 1, 0) (our +Y), we get (0, 0, 1) —
// rotated-frame +Z. ✓  So `.rotate([90, 0, 0])` is the direction we want
// for the forward pass; `.rotate([-90, 0, 0])` rotates back.
//
// Note: the Wave D spec in issue #82 says `rotate([-90, 0, 0])` / "Y→Z"
// — that's the OPPOSITE sign. The forward mapping of `.rotate([-90,0,0])`
// is (x,y,z) → (x, z, -y), i.e. our-world +Y → rotated-frame -Z. Either
// direction works (slice accepts any Z, extrude accepts any height), but
// the signs on the translations used to position slab/plug differ. We
// chose `+90` so the translations read directly as the target world-Y
// positions.
//
// Offsets use `JoinType.Round` with 32 circular segments (matches
// `CIRCULAR_SEGMENTS` in `./primitives.ts`) — smoother silhouette on
// curved masters and keeps the resulting slab topologically clean.
//
// Ownership: every function here returns a FRESH `Manifold` owned by the
// caller. Each intermediate Manifold / CrossSection is disposed
// explicitly within this module — no leaks even on the failure paths
// (try/finally). Caller must `.delete()` the returned slab.

import type {
  CrossSection,
  Manifold,
  ManifoldToplevel,
} from 'manifold-3d';

import { CIRCULAR_SEGMENTS } from './primitives';

/**
 * Horizontal clearance (mm) between the plug outer edge and the shell's
 * inner-cavity outer edge. Picked at 0.2 mm per issue #82 spec — big
 * enough to give FDM parts room to drop on without binding, small enough
 * that the plug still locates the shell mechanically.
 */
const PLUG_CLEARANCE_MM = 0.2;

/**
 * Plug height (mm) above `master.min.y`. Hardcoded per issue #82 spec —
 * the shell's bottom trim is moved from `master.min.y` to
 * `master.min.y - 2 mm` so the shell wraps the plug. See the call site in
 * `generateMold.ts` for the mirroring shell-trim adjustment.
 */
export const BASE_SLAB_PLUG_HEIGHT_MM = 2;

/**
 * Inputs to `buildBaseSlab`. Master-bbox fields are in OUR-world (Y-up)
 * coordinates — the helper handles the slice-frame rotation internally.
 */
export interface BuildBaseSlabArgs {
  /**
   * Master Manifold already transformed into world space by the generator
   * (`master.transform(viewTransform)`). NOT consumed — the helper clones
   * the handle via `.rotate()` before slicing.
   */
  transformedMaster: Manifold;
  /**
   * Master AABB in OUR-world coordinates (post-`transform`). Callers can
   * pass `transformedMaster.boundingBox()` reformatted to `{x,y,z}`. Pre-
   * computed here so the caller doesn't re-walk the bbox.
   */
  masterBboxWorld: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  };
  /** Silicone layer thickness (mm). */
  siliconeThickness_mm: number;
  /** Print-shell thickness (mm). */
  printShellThickness_mm: number;
  /**
   * Base-slab thickness (mm). Slab extrudes downward from
   * `master.min.y - baseSlabThickness_mm` up to `master.min.y`.
   */
  baseSlabThickness_mm: number;
  /**
   * Base-slab overhang (mm). Slab footprint is the master XZ footprint
   * offset outward by `silicone + printShell + overhang` — the overhang
   * controls how much slab sticks out past the print shell's outer edge.
   */
  baseSlabOverhang_mm: number;
}

/**
 * Build the Wave D base slab + plug for the given master. Returns a fresh
 * Manifold in OUR-world (Y-up) coordinates with bounds:
 *
 *   X, Z:  master XZ footprint expanded by `silicone + printShell + overhang`.
 *   Y:     [`master.min.y - baseSlabThickness`, `master.min.y + 2 mm`].
 *
 * Failure modes:
 *
 * - The master slice at `master.min.y` can legitimately be empty for
 *   pathological masters (e.g. a single vertex at the lowest Y with no
 *   supporting face). In that case the outer offset becomes empty and we
 *   return an empty Manifold — callers must check `isEmpty()` before
 *   trusting the result. In the typical case (a figurine with a flat or
 *   near-flat base), the slice is non-empty and the slab is a proper
 *   solid.
 *
 * @param toplevel Initialised manifold-3d toplevel handle.
 * @param args See `BuildBaseSlabArgs`.
 * @returns A fresh `Manifold` — caller owns, `.delete()` when done.
 */
export function buildBaseSlab(
  toplevel: ManifoldToplevel,
  args: BuildBaseSlabArgs,
): Manifold {
  const {
    transformedMaster,
    masterBboxWorld,
    siliconeThickness_mm,
    printShellThickness_mm,
    baseSlabThickness_mm,
    baseSlabOverhang_mm,
  } = args;

  const masterMinY = masterBboxWorld.min.y;

  const outerOffset =
    siliconeThickness_mm + printShellThickness_mm + baseSlabOverhang_mm;
  const plugOffset = siliconeThickness_mm - PLUG_CLEARANCE_MM;

  // Forward pass: our+Y → rotated+Z. See block comment at the top of the
  // file for the full derivation.
  const masterForSlice = transformedMaster.rotate([90, 0, 0]);
  let sliceCs: CrossSection | undefined;
  let outerCs: CrossSection | undefined;
  let plugCs: CrossSection | undefined;
  let slabRaw: Manifold | undefined;
  let plugRaw: Manifold | undefined;
  let slabPlaced: Manifold | undefined;
  let plugPlaced: Manifold | undefined;
  let unionRotated: Manifold | undefined;
  try {
    // Horizontal footprint of the master at its lowest Y (our world).
    // Under `.rotate([90,0,0])`, our-world Y maps directly to
    // rotated-frame Z with the same sign, so the slice height is just
    // `masterMinY`.
    sliceCs = masterForSlice.slice(masterMinY);

    // Step 1 — outer slab footprint.
    //
    // Offset outward by `silicone + shell + overhang`. If the master's
    // lowest-Y slice is degenerate (e.g. a single-vertex bottom on an
    // icosphere, or a master oriented sideways so its min.y slice is
    // through a thin sliver), the offset may produce an empty or
    // geometrically-invalid CrossSection. We detect that here and
    // return a valid empty Manifold — callers (the orchestrator + the
    // scene's printable-parts module) handle the empty case by simply
    // not rendering a slab mesh / reporting volume=0.
    outerCs = sliceCs.offset(outerOffset, 'Round', 2, CIRCULAR_SEGMENTS);
    if (outerCs.isEmpty() || outerCs.numContour() === 0) {
      // Build a valid empty Manifold by intersecting two non-overlapping
      // unit cubes — this path stays within the "always return a valid
      // Manifold" contract without tripping the `cube([0,0,0])` invalid-
      // construction kernel error path.
      const a = toplevel.Manifold.cube([1, 1, 1], true);
      const b = toplevel.Manifold.cube([1, 1, 1], true).translate([10, 0, 0]);
      try {
        return toplevel.Manifold.intersection(a, b);
      } finally {
        a.delete();
        b.delete();
      }
    }
    slabRaw = outerCs.extrude(baseSlabThickness_mm);

    // Step 2 — raised plug (on top of the slab).
    //
    // Offset outward by `silicone - clearance`. This matches the shell's
    // inner cavity outer edge minus 0.2 mm so the shell drops over the
    // plug with a small but positive clearance. Extrude height is 2 mm
    // (hardcoded per issue spec — the shell's bottom trim moves down by
    // the same 2 mm so the shell wraps the plug flush).
    plugCs = sliceCs.offset(plugOffset, 'Round', 2, CIRCULAR_SEGMENTS);
    // Empty plug → skip the plug and return just the slab. Shouldn't
    // happen in practice because plugOffset is strictly smaller than
    // outerOffset and we already verified outerCs is non-empty, but
    // guard defensively.
    if (!plugCs.isEmpty() && plugCs.numContour() > 0) {
      plugRaw = plugCs.extrude(BASE_SLAB_PLUG_HEIGHT_MM);
    }

    // `extrude(h)` places the base at rotated-frame Z=0, top at Z=h.
    // The rotate-back `.rotate([-90,0,0])` maps rotated-frame Z → our-
    // world Y with the same sign (matches the +Y↔+Z forward mapping),
    // so rotated-frame Z translations read directly as target world-Y
    // positions:
    //
    //   - Slab top must sit at Y = masterMinY  →  rotated-frame Z span
    //     [masterMinY - thickness, masterMinY]  →  translate by
    //     (masterMinY - thickness) along rotated-frame Z.
    //   - Plug base must sit at Y = masterMinY  →  rotated-frame Z span
    //     [masterMinY, masterMinY + 2]  →  translate by masterMinY along
    //     rotated-frame Z.
    slabPlaced = slabRaw.translate([
      0,
      0,
      masterMinY - baseSlabThickness_mm,
    ]);
    slabRaw.delete();
    slabRaw = undefined;

    let combinedRotated: Manifold;
    if (plugRaw) {
      plugPlaced = plugRaw.translate([0, 0, masterMinY]);
      plugRaw.delete();
      plugRaw = undefined;
      // Union slab + plug into a single watertight piece.
      unionRotated = toplevel.Manifold.union(slabPlaced, plugPlaced);
      combinedRotated = unionRotated;
    } else {
      combinedRotated = slabPlaced;
    }

    // Rotate back to our Y-up world. `.rotate()` returns a FRESH
    // Manifold that is NOT in the finally list — that's the handle we
    // give the caller.
    const slabWorld = combinedRotated.rotate([-90, 0, 0]);
    return slabWorld;
  } finally {
    masterForSlice.delete();
    if (sliceCs) sliceCs.delete();
    if (outerCs) outerCs.delete();
    if (plugCs) plugCs.delete();
    if (slabRaw) slabRaw.delete();
    if (plugRaw) plugRaw.delete();
    if (slabPlaced) slabPlaced.delete();
    if (plugPlaced) plugPlaced.delete();
    if (unionRotated) unionRotated.delete();
  }
}
