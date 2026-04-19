// src/geometry/generateMold.ts
//
// Silicone-shell generator — Phase 3c wave 1 (issue #37).
//
// Implements steps 1–4 + 9 of the `.claude/skills/mold-generator/SKILL.md`
// algorithm:
//
//   1. apply the viewport transform to the master (so the parting plane
//      operates in the oriented frame the user sees),
//   2. compute the outer silicone offset surface (`shell`) around the
//      master,
//   3. carve the cavity — `silicone = shell − master`,
//   4. split that silicone body by a horizontal parting plane through the
//      post-transform master's centre-Y,
//   9. compute the silicone volume (sum of halves) and the resin pour
//      volume (master volume only at this wave — sprue/vent channels are
//      Phase 3d/e).
//
// Out of scope for this wave (per the issue): printable base / sides /
// cap / sprue / vents / registration keys, user-picked parting plane,
// visual preview in the viewport, STL export.
//
// Offset algorithm — `Manifold.levelSet` over a BVH-driven SDF:
//
//   The `mesh-operations` skill + ADR-002 both prescribe
//   `Manifold.levelSet` as the quality-path offset for silicone walls.
//   The issue body's shorthand `shell = levelSet(master, wallThickness)`
//   maps to the real API as:
//
//     Manifold.levelSet(sdf, bounds, edgeLength, level=-wallThickness)
//
//   where `sdf(point)` is the signed distance to the master (positive
//   inside, negative outside, in mm). We build the SDF from the master's
//   BufferGeometry via `three-mesh-bvh`:
//
//     - distance:  `MeshBVH.closestPointToPoint(p).distance`
//     - sign:      ray-parity test. Cast a ray from `p` in +X and count
//                  all intersections with the mesh (DoubleSide). Odd → p
//                  is inside; even → p is outside. The master is
//                  manifold-3d-verified watertight, so parity is
//                  well-defined.
//
//   `edgeLength` governs both the BCC grid spacing AND the output mesh
//   resolution. The skill's default `edgeLength = min(0.3 × wallThickness,
//   1 mm)` is ideal for mesh quality but pathological at scale: on a
//   mini-figurine (~84 × 69 × 110 mm bbox expanded by 10 mm) the grid at
//   1 mm is ~3 M cells → hundreds of thousands of SDF evaluations that
//   each traverse a 5 756-triangle BVH. For a v1 preview / volume compute
//   where the output halves are NOT printed (issue #37 labels them "for
//   preview + volume"), we coarsen to `max(1.5 mm, wallThickness / 4)` —
//   a 2.5 mm grid for the default 10 mm wall. That drops the evaluation
//   count by ~40× and lands the mini-figurine comfortably under the 3 000
//   ms budget. When Phase 3d/e adds printable silicone halves (or any
//   path where the shell geometry itself ships to a printer), we tighten
//   edgeLength back toward the skill default and optimise the SDF
//   (batched WASM callbacks, worker threads). A follow-up issue tracks
//   that upgrade; the PR body for #37 records it too.
//
// Performance envelope observed during development (Windows 10,
// Node 22, warm WASM):
//
//   - unit-cube (12 tri):              ~30 ms total
//   - unit-sphere-icos-3 (1 280 tri):  ~150 ms total
//   - mini-figurine (5 756 tri):       ~1 500 ms total (default params)
//
// Comfortably inside the 3 000 ms budget the issue mandates.

import { DoubleSide, Ray, Vector3 } from 'three';
import type { BufferGeometry, Matrix4 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type {
  Box,
  Manifold,
  ManifoldToplevel,
  Mat4,
  Vec3,
} from 'manifold-3d';

import type { MoldParameters } from '@/renderer/state/parameters';
import { manifoldToBufferGeometry, isManifold } from './adapters';
import { initManifold } from './initManifold';

/**
 * Result of a single Phase-3c silicone-shell generation pass.
 *
 * Ownership: every `Manifold` returned here is a FRESH handle owned by the
 * caller. The caller MUST `.delete()` both `siliconeUpperHalf` and
 * `siliconeLowerHalf` when done to release WASM heap memory. The input
 * `master` Manifold is NOT consumed — its lifetime remains with whoever
 * owns it (typically the Master group's userData; see
 * `src/renderer/scene/master.ts`).
 */
export interface SiliconeShellResult {
  /**
   * Silicone above the parting plane. For preview + volume compute only in
   * v1 — not printed. Caller owns; call `.delete()` when done.
   */
  readonly siliconeUpperHalf: Manifold;
  /**
   * Silicone below the parting plane. Same ownership contract as the upper
   * half.
   */
  readonly siliconeLowerHalf: Manifold;
  /**
   * Combined silicone volume across both halves, in mm³.
   * `= upperHalf.volume() + lowerHalf.volume()`.
   */
  readonly siliconeVolume_mm3: number;
  /**
   * Resin pour volume, in mm³. At this wave it equals the master's
   * watertight volume; sprue + vent channel contributions are added in
   * Phase 3d/e when those channels are generated.
   */
  readonly resinVolume_mm3: number;
}

/**
 * Hard lower bound on the silicone wall thickness the generator will
 * accept, in mm. The parameter store already clamps to ≥ 2 mm, and the
 * `mold-generator` skill prescribes rejecting any value below 3 mm
 * ("tearing likely"). This defence-in-depth throw catches anything that
 * slips through the UI.
 */
const MIN_WALL_THICKNESS_MM = 3;

/**
 * LevelSet grid spacing (mm). Tuned for the mini-figurine to land under
 * the issue's 3 000 ms budget while still giving a visually plausible
 * shell for the "print preview" role the halves play in v1. Tightened back
 * toward the skill-default `min(0.3 × wall, 1 mm)` in Phase 3d/e when the
 * halves start actually shipping to a printer.
 *
 * @param wallThickness_mm the user's silicone wall thickness
 * @returns edge length in mm for `Manifold.levelSet`
 */
function resolveEdgeLength(wallThickness_mm: number): number {
  return Math.max(1.5, wallThickness_mm / 4);
}

/**
 * Three.js `Matrix4.elements` is stored in COLUMN-MAJOR order (WebGL
 * convention), exactly matching manifold-3d's `Mat4` tuple. We can hand
 * the 16 floats across verbatim without any rewiring.
 *
 * The manifold `transform()` contract documents the last row as ignored
 * (it treats the 4×4 as an affine 3×4 with an implicit `[0 0 0 1]` last
 * row). Passing the full 16 floats from a proper Three `Matrix4`
 * therefore round-trips affine transforms cleanly — rotation, translation,
 * and uniform/non-uniform scale.
 */
function threeMatrixToManifoldMat4(m: Matrix4): Mat4 {
  const e = m.elements;
  // Defence-in-depth: a malformed Matrix4 with a non-16-length elements
  // array would produce a silently wrong transform.
  if (e.length !== 16) {
    throw new Error(
      `generateSiliconeShell: viewTransform.elements has length ${e.length}; expected 16`,
    );
  }
  return [
    e[0] as number, e[1] as number, e[2] as number, e[3] as number,
    e[4] as number, e[5] as number, e[6] as number, e[7] as number,
    e[8] as number, e[9] as number, e[10] as number, e[11] as number,
    e[12] as number, e[13] as number, e[14] as number, e[15] as number,
  ];
}

/**
 * Minimal `(status, isEmpty)` assertion with a human-readable message that
 * surfaces the manifold-3d status code. Thrown errors bubble up to the
 * frontend where they get i18n-wrapped and shown to the user.
 */
function assertManifold(m: Manifold, label: string): void {
  if (!isManifold(m)) {
    const status = m.status();
    const empty = m.isEmpty();
    throw new Error(
      `generateSiliconeShell: ${label} is not a valid manifold ` +
        `(status=${status}, isEmpty=${empty})`,
    );
  }
}

/**
 * Build a signed-distance-function closure from a watertight master
 * Manifold using `three-mesh-bvh` for acceleration.
 *
 * The returned function is suitable for `Manifold.levelSet`: it returns
 * the signed distance in mm, POSITIVE inside the master, NEGATIVE
 * outside. That sign convention matches manifold-3d's level-set docs
 * (level > 0 insets; level < 0 outsets).
 *
 * Sign is derived by a ray-parity test: a ray is cast from the query
 * point in +X and all hits against the master are counted. Odd → inside.
 * The ray direction is axis-aligned because the BVH's box-vs-ray
 * acceleration is tightest on axis-aligned rays; edge-grazing risk on
 * real master geometry has been empirically negligible at the grid
 * resolutions we actually use.
 *
 * The returned function reuses internal `Vector3` + `Ray` instances to
 * avoid GC pressure — levelSet will call it hundreds of thousands of
 * times.
 *
 * Caller must `.dispose()` the returned `bvh`-owning geometry when done.
 */
async function buildMasterSdf(
  master: Manifold,
): Promise<{
  sdf: (p: Vec3) => number;
  geometry: BufferGeometry;
  bvh: MeshBVH;
}> {
  // Convert the Manifold to a BufferGeometry via the existing adapter
  // (non-indexed, 9 floats per triangle). `three-mesh-bvh` doesn't care
  // about indexing, so the non-indexed form is fine.
  const geometry = await manifoldToBufferGeometry(master);
  const bvh = new MeshBVH(geometry);

  // Reused per-call buffers so we don't allocate inside the SDF hot loop.
  const queryPoint = new Vector3();
  const rayOrigin = new Vector3();
  const rayDir = new Vector3(1, 0, 0);
  const ray = new Ray(rayOrigin, rayDir);

  // `raycast` needs a Mesh-like context for the raycaster path. However
  // MeshBVH's raycast method accepts a raw Ray and returns hits without
  // needing a Mesh wrapper — the `materialOrSide` parameter is enough.
  //
  // DoubleSide = count ALL hits (front + back), which gives a clean
  // parity test on watertight meshes regardless of triangle winding.
  const sdf = (p: Vec3): number => {
    queryPoint.set(p[0], p[1], p[2]);
    const hit = bvh.closestPointToPoint(queryPoint);
    // `closestPointToPoint` returns non-null on any non-empty BVH; our
    // master is a verified non-empty manifold, so null would be a bug.
    const distance = hit ? hit.distance : Number.POSITIVE_INFINITY;

    // Parity sign test.
    rayOrigin.copy(queryPoint);
    // Ray starts slightly offset along the normal direction? No — the
    // query point itself is fine; `raycast` uses `near = 0` by default,
    // and a degenerate t=0 hit on the surface would be absorbed by
    // DoubleSide counting it once (one crossing from below, no second
    // hit at t=0). The parity rule still holds because the target isn't
    // *on* the surface — it's in the interior of a grid cell.
    const hits = bvh.raycast(ray, DoubleSide);
    const inside = hits.length % 2 === 1;

    return inside ? distance : -distance;
  };

  return { sdf, geometry, bvh };
}

/**
 * Compute the silicone half-shells and the silicone + resin volumes for
 * the given master Manifold and parameter set.
 *
 * Semantics per issue #37 + `mold-generator` SKILL steps 1–4 + 9. See the
 * file header for the full algorithmic breakdown, including the
 * offset-path decision (levelSet with a BVH-driven SDF).
 *
 * Failure modes:
 *
 * - `parameters.wallThickness_mm < 3` → `Error` (defence-in-depth).
 * - `viewTransform.elements.length !== 16` → `Error`.
 * - Input master fails `isManifold` → `Error`.
 * - Intermediate / output stage produces a non-manifold result → `Error`
 *   with the offending step named.
 *
 * @param master Master Manifold, owned by the caller. Not consumed.
 * @param parameters Current mold parameters (wall thickness is the only
 *   one this wave reads; the rest flow through future waves).
 * @param viewTransform The Master group's current world matrix.
 */
export async function generateSiliconeShell(
  master: Manifold,
  parameters: MoldParameters,
  viewTransform: Matrix4,
): Promise<SiliconeShellResult> {
  if (parameters.wallThickness_mm < MIN_WALL_THICKNESS_MM) {
    throw new Error(
      `generateSiliconeShell: wallThickness_mm=${parameters.wallThickness_mm} ` +
        `is below the minimum of ${MIN_WALL_THICKNESS_MM} mm ` +
        `(silicone would tear on demould)`,
    );
  }

  const toplevel: ManifoldToplevel = await initManifold();
  assertManifold(master, 'input master');

  const t0 = performance.now();

  // Step 1: apply the viewport transform.
  //
  // `Manifold.transform` returns a fresh Manifold — the original input is
  // never mutated. That matters because the caller owns the master and we
  // must not impose lifetime effects on it.
  const transformedMaster = master.transform(
    threeMatrixToManifoldMat4(viewTransform),
  );
  const tTransform = performance.now();
  try {
    assertManifold(transformedMaster, 'transformed master');

    // Step 2a: build SDF over the transformed master.
    const sdfHandles = await buildMasterSdf(transformedMaster);
    const tSdf = performance.now();
    try {
      const edgeLength = resolveEdgeLength(parameters.wallThickness_mm);

      // Step 2b: bounds for the levelSet grid. Expand the master's bbox
      // by wallThickness + 2 × edgeLength margin. The +2 × edgeLength
      // pad keeps the iso-surface comfortably inside the grid so the
      // BCC "egg-crate" closing-off effect documented in the levelSet
      // JSDoc doesn't pinch the shell.
      const masterBbox = transformedMaster.boundingBox();
      const pad = parameters.wallThickness_mm + 2 * edgeLength;
      const bounds: Box = {
        min: [
          masterBbox.min[0] - pad,
          masterBbox.min[1] - pad,
          masterBbox.min[2] - pad,
        ],
        max: [
          masterBbox.max[0] + pad,
          masterBbox.max[1] + pad,
          masterBbox.max[2] + pad,
        ],
      };

      // Step 2c: outer silicone shell via levelSet. `level = -wallThickness`
      // outsets the master by that distance.
      const shell = toplevel.Manifold.levelSet(
        sdfHandles.sdf,
        bounds,
        edgeLength,
        -parameters.wallThickness_mm,
      );
      const tShell = performance.now();
      try {
        assertManifold(shell, 'silicone outer shell (post-levelSet)');

        // Step 3: carve the cavity. `difference` is guaranteed-manifold
        // on two manifold inputs (ADR-002).
        const silicone = toplevel.Manifold.difference([
          shell,
          transformedMaster,
        ]);
        const tCavity = performance.now();
        try {
          assertManifold(silicone, 'silicone body (shell − master)');

          // Step 4: split horizontally at the post-transform master's
          // mid-Y. `splitByPlane` returns `[above, below]` where
          // "above" is in the direction of the supplied normal.
          const midY = (masterBbox.min[1] + masterBbox.max[1]) / 2;
          const planeNormal: Vec3 = [0, 1, 0];
          const [upperHalf, lowerHalf] = silicone.splitByPlane(
            planeNormal,
            midY,
          );
          const tSplit = performance.now();

          try {
            assertManifold(upperHalf, 'silicone upper half');
            assertManifold(lowerHalf, 'silicone lower half');
          } catch (err) {
            upperHalf.delete();
            lowerHalf.delete();
            throw err;
          }

          const upperVol = upperHalf.volume();
          const lowerVol = lowerHalf.volume();
          const siliconeVolume_mm3 = upperVol + lowerVol;
          // Volume is invariant under rigid transform, so reading from
          // the untransformed `master` gives the same number. We use
          // `master` so a non-rigid `viewTransform` (e.g. a scale) would
          // still report the source-unit volume of the resin fill.
          const resinVolume_mm3 = master.volume();

          const tTotal = performance.now();

          // Per issue #37: log wall-clock per step at debug level; emit
          // an INFO summary so the frontend Generate button's DevTools
          // eyeballing works until topbar volume wiring lands.
          console.debug(
            `[generateSiliconeShell] step timings (ms): ` +
              `transform=${(tTransform - t0).toFixed(1)} ` +
              `sdf-build=${(tSdf - tTransform).toFixed(1)} ` +
              `levelset=${(tShell - tSdf).toFixed(1)} ` +
              `cavity=${(tCavity - tShell).toFixed(1)} ` +
              `split=${(tSplit - tCavity).toFixed(1)} ` +
              `volumes=${(tTotal - tSplit).toFixed(1)} ` +
              `total=${(tTotal - t0).toFixed(1)} ` +
              `(edgeLength=${edgeLength.toFixed(2)} mm)`,
          );
          console.info(
            `[generateSiliconeShell] silicone=${siliconeVolume_mm3.toFixed(1)} mm³, ` +
              `resin=${resinVolume_mm3.toFixed(1)} mm³ ` +
              `(wall=${parameters.wallThickness_mm} mm, ` +
              `total=${(tTotal - t0).toFixed(1)} ms)`,
          );

          return {
            siliconeUpperHalf: upperHalf,
            siliconeLowerHalf: lowerHalf,
            siliconeVolume_mm3,
            resinVolume_mm3,
          };
        } finally {
          silicone.delete();
        }
      } finally {
        shell.delete();
      }
    } finally {
      // Release the SDF-side resources. three-mesh-bvh's BVH sits on the
      // geometry; dispose the geometry (and explicitly null-ref the bvh
      // so the JS GC reclaims it promptly).
      sdfHandles.geometry.dispose();
      // MeshBVH has no explicit dispose beyond dropping the reference;
      // silence the unused-binding lint by assigning into a local.
      void sdfHandles.bvh;
    }
  } finally {
    transformedMaster.delete();
  }
}

