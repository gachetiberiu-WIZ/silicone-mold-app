// src/geometry/generateMold.ts
//
// Mold generator — Phase 3c Wave 1 (issue #37) + Wave 2 (issue #50).
//
// Wave 1 (issue #37) implemented steps 1–4 + 9 of
// `.claude/skills/mold-generator/SKILL.md`:
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
// Wave 2 (issue #50) extends the pipeline to produce the raw printable-box
// parts: base + `sideCount` sides + top cap. These are built from the
// silicone body's AABB in the oriented frame (no air gap to silicone in
// v1) expanded by `baseThickness_mm` on all six sides. The radial-split
// algorithm lives in `./printableBox.ts`; see that module for the
// load-bearing side-cut-angles table and wedge-trim algorithm.
//
// Out of scope (still — carried forward from the issues): registration
// keys, sprue + vent channels through the top cap, user-picked parting
// plane, draft angles on the inner cavity, viewport preview of the
// printable parts, STL export.
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
import type { Box, Manifold, ManifoldToplevel, Mat4, Vec3 } from 'manifold-3d';

import type { MoldParameters } from '@/renderer/state/parameters';
import { NUMERIC_CONSTRAINTS, SIDE_COUNT_OPTIONS } from '@/renderer/state/parameters';
import { manifoldToBufferGeometry, isManifold } from './adapters';
import { initManifold } from './initManifold';
import { buildPrintableBox } from './printableBox';
import { stampRegistrationKeys } from './registrationKeys';
import {
  SPRUE_Y_EPSILON_MM,
  boxCentreXZ,
  drillSprue,
  drillVents,
  sprueVentDiameterRatioIsValid,
} from './sprueVent';

/**
 * Error raised on invalid `MoldParameters` input to `generateSiliconeShell`
 * BEFORE any Manifold allocation. Separate class so callers (and tests)
 * can distinguish parameter-validation failures from downstream kernel
 * errors without string-matching. See issue #50 "Validation" —
 * defence-in-depth against UI constraints being bypassed by tests or
 * future non-UI call paths.
 */
export class InvalidParametersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidParametersError';
  }
}

/**
 * Result of a single silicone + printable-box generation pass.
 *
 * Ownership — every `Manifold` returned here is a FRESH handle owned by
 * the caller. The caller MUST `.delete()` each of:
 *
 *   - `siliconeUpperHalf`, `siliconeLowerHalf`
 *   - `basePart`, `topCapPart`
 *   - every element of `sideParts`
 *
 * to release WASM heap memory. The input `master` Manifold is NOT
 * consumed — its lifetime remains with whoever owns it (typically the
 * Master group's userData; see `src/renderer/scene/master.ts`).
 *
 * The orchestrator (`src/renderer/ui/generateOrchestrator.ts`) owns this
 * contract on the renderer side. In Wave 2 (issue #50) the printable-box
 * parts are not yet rendered, so the orchestrator `.delete()`s them
 * immediately after reading `printableVolume_mm3`. Wave 4 will introduce
 * a viewport preview that takes over printable-parts ownership — the
 * silicone-halves hand-off (issue #47) is the template.
 */
export interface MoldGenerationResult {
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
  /**
   * Printable base plate — rectangular slab sitting entirely below the
   * silicone bbox. Watertight (genus 0). Caller owns; `.delete()` when
   * done.
   */
  readonly basePart: Manifold;
  /**
   * Printable side walls — `length === parameters.sideCount` wedges
   * covering the ring frame around the silicone bbox at
   * Y ∈ [shellBbox.min.y, shellBbox.max.y]. Each wedge is watertight
   * (genus 0). Caller owns each Manifold; `.delete()` each when done.
   * Pairwise overlap is zero within kernel tolerance.
   */
  readonly sideParts: readonly Manifold[];
  /**
   * Printable top cap — rectangular slab sitting entirely above the
   * silicone bbox. Watertight (genus 0). Caller owns; `.delete()` when
   * done.
   */
  readonly topCapPart: Manifold;
  /**
   * Sum of `basePart.volume() + Σ sideParts[i].volume() +
   * topCapPart.volume()`, in mm³. Pre-computed so downstream topbar /
   * UI surfaces don't have to re-walk the parts to read it.
   */
  readonly printableVolume_mm3: number;
  /**
   * Soft warnings surfaced by Wave 3 channels generation — e.g. when
   * fewer vents fit than the user requested on a particular master. Empty
   * array on the happy path. Call sites log these at info level and/or
   * surface them in the UI; never throw.
   */
  readonly warnings: ReadonlyArray<string>;
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
    e[0] as number,
    e[1] as number,
    e[2] as number,
    e[3] as number,
    e[4] as number,
    e[5] as number,
    e[6] as number,
    e[7] as number,
    e[8] as number,
    e[9] as number,
    e[10] as number,
    e[11] as number,
    e[12] as number,
    e[13] as number,
    e[14] as number,
    e[15] as number,
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
async function buildMasterSdf(master: Manifold): Promise<{
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
): Promise<MoldGenerationResult> {
  // Defence-in-depth validation. The UI's parameters panel already
  // clamps to legal ranges, but this function is reachable from tests
  // and any future non-UI caller, so the kernel validates its own
  // inputs. Every check here runs BEFORE the first Manifold allocation
  // so a rejection costs zero WASM heap.
  if (parameters.wallThickness_mm < MIN_WALL_THICKNESS_MM) {
    throw new InvalidParametersError(
      `generateSiliconeShell: wallThickness_mm=${parameters.wallThickness_mm} ` +
        `is below the minimum of ${MIN_WALL_THICKNESS_MM} mm ` +
        `(silicone would tear on demould)`,
    );
  }
  if (!SIDE_COUNT_OPTIONS.includes(parameters.sideCount)) {
    throw new InvalidParametersError(
      `generateSiliconeShell: sideCount=${String(parameters.sideCount)} ` +
        `is not supported (must be one of ${SIDE_COUNT_OPTIONS.join(', ')})`,
    );
  }
  if (!(parameters.baseThickness_mm > 0) || !Number.isFinite(parameters.baseThickness_mm)) {
    throw new InvalidParametersError(
      `generateSiliconeShell: baseThickness_mm=${parameters.baseThickness_mm} ` +
        `must be a positive finite number`,
    );
  }

  // Wave 3 (issue #55): validate key style + sprue/vent ordering + vent
  // count range. All pre-Manifold so bad input costs zero WASM heap.
  if (
    parameters.registrationKeyStyle === 'cone' ||
    parameters.registrationKeyStyle === 'keyhole'
  ) {
    throw new InvalidParametersError(
      `generateSiliconeShell: registrationKeyStyle='${parameters.registrationKeyStyle}' ` +
        `is not implemented yet in v1 — use 'asymmetric-hemi' (the default)`,
    );
  }
  if (!sprueVentDiameterRatioIsValid(parameters)) {
    throw new InvalidParametersError(
      `generateSiliconeShell: sprueDiameter_mm=${parameters.sprueDiameter_mm} ` +
        `must be strictly greater than ventDiameter_mm=${parameters.ventDiameter_mm} ` +
        `(sprue must be wider than vents)`,
    );
  }
  const ventCountMin = NUMERIC_CONSTRAINTS.ventCount.min;
  const ventCountMax = NUMERIC_CONSTRAINTS.ventCount.max;
  if (
    !Number.isInteger(parameters.ventCount) ||
    parameters.ventCount < ventCountMin ||
    parameters.ventCount > ventCountMax
  ) {
    throw new InvalidParametersError(
      `generateSiliconeShell: ventCount=${parameters.ventCount} ` +
        `is outside the allowed integer range ` +
        `[${ventCountMin}, ${ventCountMax}]`,
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
  const transformedMaster = master.transform(threeMatrixToManifoldMat4(viewTransform));
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
        min: [masterBbox.min[0] - pad, masterBbox.min[1] - pad, masterBbox.min[2] - pad],
        max: [masterBbox.max[0] + pad, masterBbox.max[1] + pad, masterBbox.max[2] + pad],
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
        const silicone = toplevel.Manifold.difference([shell, transformedMaster]);
        const tCavity = performance.now();
        try {
          assertManifold(silicone, 'silicone body (shell − master)');

          // Step 4: split horizontally at the post-transform master's
          // mid-Y. `splitByPlane` returns `[above, below]` where
          // "above" is in the direction of the supplied normal.
          const midY = (masterBbox.min[1] + masterBbox.max[1]) / 2;
          const planeNormal: Vec3 = [0, 1, 0];
          const [upperHalf, lowerHalf] = silicone.splitByPlane(planeNormal, midY);
          const tSplit = performance.now();

          try {
            assertManifold(upperHalf, 'silicone upper half');
            assertManifold(lowerHalf, 'silicone lower half');
          } catch (err) {
            upperHalf.delete();
            lowerHalf.delete();
            throw err;
          }

          // Wave 2 (issue #50): compute the silicone body's AABB in the
          // oriented frame, then hand it to `buildPrintableBox` for the
          // base + sides + top cap. `silicone` (the pre-split body) and
          // `transformedMaster` have identical XZ extents post-levelSet
          // inside the grid — the exterior of the silicone body is the
          // outside of `shell`, whose bbox we read here. We read from
          // the still-alive `silicone` Manifold rather than recomputing
          // from the halves (fewer boundingBox() calls, one source of
          // truth, and the halves may have floating-point-smaller
          // bboxes after the splitByPlane).
          const shellBbox = silicone.boundingBox();

          // buildPrintableBox is synchronous (no WASM init, no await —
          // `toplevel` is already warm at this point). It throws
          // `InvalidParametersError` (for bad sideCount; already
          // validated above but defence-in-depth) or a generic Error
          // with a "printableBox: ..." prefix on a watertightness
          // failure. Any throw must release the silicone halves
          // because the caller never sees them.
          let printableBoxParts;
          try {
            printableBoxParts = buildPrintableBox(toplevel, shellBbox, parameters);
          } catch (err) {
            upperHalf.delete();
            lowerHalf.delete();
            throw err;
          }
          const tPrintable = performance.now();

          // --- Wave 3 (issue #55): registration keys + sprue + vents. -----
          //
          // The pipeline at this point holds two ownership groups:
          //   - Wave-1 silicone halves: `upperHalf`, `lowerHalf`
          //   - Wave-2 printable box: `basePart`, `topCapPart`, `sideParts[]`
          //
          // Each Wave-3 step returns FRESH Manifolds; we dispose the
          // pre-step reference after reassigning the variable. If any
          // step throws, the catch below releases the Manifolds we
          // currently own across both groups — the caller never sees a
          // partially-stamped result.
          //
          // Wave-3 mutations (in order):
          //   3. stamp keys: (upper, lower) → (upperKeyed, lowerKeyed)
          //   4. drill sprue: (upperKeyed, topCap) → (upperSprued, topCapSprued)
          //   5. drill vents: (upperSprued, topCapSprued) → (upperFinal, topCapFinal)
          //
          // After step 5 the final upperHalf, lowerHalf (from step 3),
          // basePart (unchanged), sideParts (unchanged), topCapPart
          // (from step 5) are the outputs.
          //
          // Volume accounting:
          //   - silicone volume: recompute from the FINAL halves. Boolean
          //     ops drop a small amount of mass at kernel precision, and
          //     the recesses + sprue + vent holes remove real volume.
          //   - resin volume: analytic — master volume + π r² · length
          //     for the sprue + each vent. This is what the USER pours,
          //     not what the subtraction removed (the subtraction's
          //     removed volume equals the channel volume only to within
          //     the kernel's ~1e-4 relative tolerance; the analytic is
          //     exact).
          //   - printable volume: recompute from basePart + sideParts +
          //     final topCapPart.

          let currentUpper: Manifold = upperHalf;
          let currentLower: Manifold = lowerHalf;
          let currentTopCap: Manifold = printableBoxParts.topCapPart;
          const warnings: string[] = [];
          let ventPlaced = 0;
          let ventSkipped = 0;
          // Per-vent `fromY` values (issue #58). Populated in the Wave-3
          // `drillVents` step; consumed by the analytic resin-volume sum
          // below. Default `[]` covers the error path where step 5 hasn't
          // run yet (we keep the FINAL volumes out of the throw path).
          let ventPlacedFromYs: ReadonlyArray<number> = [];

          // Derived geometry for the sprue + vents. The master bbox lives
          // in the post-transform frame (we read from `transformedMaster`
          // which was already transformed at the top of the function).
          const sprueXZ = boxCentreXZ(masterBbox);
          const sprueFromY = masterBbox.max[1] + SPRUE_Y_EPSILON_MM;
          const sprueToY = shellBbox.max[1] + parameters.baseThickness_mm; // = outer top = topCap top
          const ventTopY = sprueToY; // shared top Y for all channels
          const sprueLength = sprueToY - sprueFromY;

          try {
            // Step 3: registration keys.
            const partingY = (masterBbox.min[1] + masterBbox.max[1]) / 2;
            const keyed = stampRegistrationKeys(
              toplevel,
              currentUpper,
              currentLower,
              shellBbox,
              partingY,
              parameters.wallThickness_mm,
            );
            // Swap refs: old halves are no longer the "current" ones —
            // release them, then take ownership of the keyed ones.
            currentUpper.delete();
            currentLower.delete();
            currentUpper = keyed.updatedUpper;
            currentLower = keyed.updatedLower;

            // Step 4: drill sprue.
            const sprued = drillSprue(toplevel, currentUpper, currentTopCap, {
              xz: sprueXZ,
              fromY: sprueFromY,
              toY: sprueToY,
              diameter: parameters.sprueDiameter_mm,
            });
            currentUpper.delete();
            currentTopCap.delete();
            currentUpper = sprued.updatedUpper;
            currentTopCap = sprued.updatedTopCap;

            // Step 5: drill vents.
            const vented = drillVents(toplevel, currentUpper, currentTopCap, {
              master: transformedMaster,
              topY: ventTopY,
              sprueXZ,
              sprueDiameter: parameters.sprueDiameter_mm,
              ventDiameter: parameters.ventDiameter_mm,
              ventCount: parameters.ventCount,
            });
            currentUpper.delete();
            currentTopCap.delete();
            currentUpper = vented.updatedUpper;
            currentTopCap = vented.updatedTopCap;
            ventPlaced = vented.placed;
            ventSkipped = vented.skipped;
            for (const w of vented.warnings) warnings.push(w);
            // Capture per-vent source Ys for the exact analytic resin-
            // volume sum below (issue #58). Length === `vented.placed`.
            ventPlacedFromYs = vented.placedVents.map((v) => v.fromY);
          } catch (err) {
            // Release all Manifolds we currently own across both groups.
            // `currentUpper` / `currentLower` / `currentTopCap` point at
            // whatever the last successful step produced (or the Wave-1
            // / Wave-2 originals if step 3 was the thrower).
            currentUpper.delete();
            currentLower.delete();
            currentTopCap.delete();
            printableBoxParts.basePart.delete();
            for (const s of printableBoxParts.sideParts) s.delete();
            throw err;
          }

          const tWave3 = performance.now();

          // Recompute final volumes (step 6–7 per the issue spec).
          const finalUpperVol = currentUpper.volume();
          const finalLowerVol = currentLower.volume();
          const finalSiliconeVolume_mm3 = finalUpperVol + finalLowerVol;

          // Analytic resin volume: master + sprue + vents (what the user
          // pours in, not what the subtraction removed).
          const sprueR = parameters.sprueDiameter_mm / 2;
          const ventR = parameters.ventDiameter_mm / 2;
          const sprueChannelVol = Math.PI * sprueR * sprueR * sprueLength;
          // Per-vent EXACT analytic length (issue #58). Each cylinder
          // runs from its source vertex Y (`v.fromY`, recorded by
          // `drillVents`) up to the shared `ventTopY`. Summing
          // `π·r²·(ventTopY − fromY)` over the actually-placed vents
          // gives the exact poured-resin volume in the vent channels,
          // rather than the prior conservative overestimate that used
          // `ventTopY − masterBbox.max.y` for every vent. The old bound
          // over-reported by at most ~`ventCount · π·r² · wall/2` mm³
          // (on default params: ~18 mm³ on a ~127 000 mm³ mini-figurine
          // → ~1.4e-4 relative); the exact sum tightens this to kernel
          // noise.
          const ventChannelVolTotal = ventPlacedFromYs.reduce(
            (sum, fromY) => sum + Math.PI * ventR * ventR * (ventTopY - fromY),
            0,
          );
          const finalResinVolume_mm3 =
            master.volume() + sprueChannelVol + ventChannelVolTotal;

          // Recompute printable volume from the final Manifolds — the
          // topCap lost its sprue + vent cylinders and the basePart /
          // sideParts are unchanged.
          const finalBaseVol = printableBoxParts.basePart.volume();
          const finalTopCapVol = currentTopCap.volume();
          let finalSidesVol = 0;
          for (const s of printableBoxParts.sideParts) finalSidesVol += s.volume();
          const finalPrintableVolume_mm3 = finalBaseVol + finalSidesVol + finalTopCapVol;

          // Per issue #37 / extended in #50 / #55: log wall-clock per
          // step at debug level; emit an INFO summary including the
          // printable volume so DevTools + tests can eyeball it.
          console.debug(
            `[generateSiliconeShell] step timings (ms): ` +
              `transform=${(tTransform - t0).toFixed(1)} ` +
              `sdf-build=${(tSdf - tTransform).toFixed(1)} ` +
              `levelset=${(tShell - tSdf).toFixed(1)} ` +
              `cavity=${(tCavity - tShell).toFixed(1)} ` +
              `split=${(tSplit - tCavity).toFixed(1)} ` +
              `printable-box=${(tPrintable - tSplit).toFixed(1)} ` +
              `keys+sprue+vents=${(tWave3 - tPrintable).toFixed(1)} ` +
              `total=${(tWave3 - t0).toFixed(1)} ` +
              `(edgeLength=${edgeLength.toFixed(2)} mm, ` +
              `sideCount=${parameters.sideCount}, ` +
              `vents=${ventPlaced}/${parameters.ventCount})`,
          );
          console.info(
            `[generateSiliconeShell] silicone=${finalSiliconeVolume_mm3.toFixed(1)} mm³, ` +
              `resin=${finalResinVolume_mm3.toFixed(1)} mm³, ` +
              `printable=${finalPrintableVolume_mm3.toFixed(1)} mm³ ` +
              `(wall=${parameters.wallThickness_mm} mm, ` +
              `sideCount=${parameters.sideCount}, ` +
              `ventsPlaced=${ventPlaced}, ventsSkipped=${ventSkipped}, ` +
              `total=${(tWave3 - t0).toFixed(1)} ms)`,
          );

          return {
            siliconeUpperHalf: currentUpper,
            siliconeLowerHalf: currentLower,
            siliconeVolume_mm3: finalSiliconeVolume_mm3,
            resinVolume_mm3: finalResinVolume_mm3,
            basePart: printableBoxParts.basePart,
            sideParts: printableBoxParts.sideParts,
            topCapPart: currentTopCap,
            printableVolume_mm3: finalPrintableVolume_mm3,
            warnings: Object.freeze(warnings.slice()),
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
