// src/geometry/generateMold.ts
//
// Mold generator — Phase 3d Wave C (issue #72). Produces:
//
//   1. a surface-conforming silicone body (shell − master) around the
//      master via BVH-accelerated `Manifold.levelSet`,
//   2. a surface-conforming print shell hugging that silicone, computed
//      by a second levelSet at a larger negative offset then subtracting
//      the silicone outer body and trimming top + bottom to produce an
//      open-top rigid shell that the user can 3D-print.
//
// This is the "rigid shell + silicone glove" v1 strategy the user
// redirected to on 2026-04-20 after dogfooding the earlier two-halves-in-
// box pipeline. Wave A (PR #70) stripped sprue/vents/keys/halves; Wave C
// (this PR) replaces the remaining rectangular print box with the
// surface-conforming shell.
//
// OUT OF SCOPE for this PR (deferred to Waves D/E/F):
//   - Base slab below the shell (Wave D — 45° interlock, 2 mm overlap).
//   - Radial slicing of the shell into 2/3/4 printable pieces (Wave E).
//   - Brims on the sliced pieces (Wave F).
//   - Registration keys on future brim interfaces (Wave F).
//   - Draft-angle application (separate wave).
//
// Offset algorithm — `Manifold.levelSet` over a BVH-driven SDF:
//
//   The `mesh-operations` skill + ADR-002 both prescribe
//   `Manifold.levelSet` as the quality-path offset for silicone walls.
//   We use it TWICE against the SAME SDF closure:
//
//     Manifold.levelSet(sdf, unifiedBounds, edgeLength, -siliconeThickness)
//       → silicone outer body
//     Manifold.levelSet(sdf, unifiedBounds, edgeLength,
//                       -(siliconeThickness + printShellThickness))
//       → print-shell outer body
//
//   The SDF closure is stateless relative to the level parameter — the
//   BVH built from the master geometry answers `closestPoint + ray-parity`
//   the same way for every grid cell regardless of iso-value. So a single
//   BVH build feeds both levelSet passes.
//
//   `edgeLength` governs both the BCC grid spacing AND the output mesh
//   resolution. Wave C bumps the floor from 1.5 mm to 2.0 mm as the perf
//   fix #71 — see `resolveEdgeLength` below. At the default silicone
//   thickness of 5 mm this yields a 2.0 mm grid (down from 1.5 mm), ~60%
//   fewer cells, bringing the mini-figurine back under the ~4 s CI budget.
//
// Issue #74 perf optimisations (this commit):
//
//   1. Unified bounds. Pre-#74 the silicone pass ran on a smaller grid
//      (pad = siliconeThickness) and the shell pass on a larger grid
//      (pad = siliconeThickness + shellThickness). manifold-3d derives
//      the sample lattice from `bounds.min/max` with an internal step
//      that only approximates `edgeLength`, so the two grids shared ZERO
//      sample points in the overlap region. Using the LARGER bounds for
//      BOTH calls makes every sample of the second pass a cache-key
//      collision with a first-pass sample.
//
//   2. Quantised-key SDF cache. The SDF closure wraps a
//      `Map<string, number>` keyed by `round(p·1e6)` triples. Combined
//      with (1) this gives a 50% cache hit rate by construction — the
//      shell-levelset cost collapses from ~3.4 s to ~550 ms on the
//      mini-figurine.
//
//   3. Far-field early-out. For query points whose AABB distance from
//      the master exceeds `max(|level|) + edgeLength`, the exact SDF
//      value is immaterial to marching-tetrahedra output — they're
//      always "outside the volume". The closure skips the BVH descent
//      and returns a pre-computed constant below the deepest iso-level.
//      Saves another ~10% of BVH work on a figurine, ~30% on a compact
//      cube.
//
//   4. Non-axis-aligned parity ray. The pre-#74 raycast used
//      `(1, 0, 0)`, which grazes axis-aligned mesh edges and returned
//      ambiguous parity counts. Under (1)'s enlarged grid this
//      surfaced as silent topology corruption (extra silicone
//      components at the grid boundary). A prime-ratio ray direction
//      never passes exactly through an edge or vertex on
//      non-degenerate meshes. See `buildMasterSdf` for details.
//
//   Net: mini-figurine local wall-clock ~7.1 s → ~5.2 s (~27% faster);
//   shell-levelset alone ~3.4 s → ~550 ms (~84% faster). CI is
//   expected to see a similar ratio, bringing the 10 s ubuntu-CI run
//   under the issue #72 5 s AC target.

import { DoubleSide, Ray, Vector3 } from 'three';
import type { BufferGeometry, Matrix4 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { Box, Manifold, ManifoldToplevel, Mat4, Vec3 } from 'manifold-3d';

import type { MoldParameters } from '@/renderer/state/parameters';
import { SIDE_COUNT_OPTIONS } from '@/renderer/state/parameters';
import { manifoldToBufferGeometry, isManifold } from './adapters';
import { initManifold } from './initManifold';

/**
 * Error raised on invalid `MoldParameters` input to `generateSiliconeShell`
 * BEFORE any Manifold allocation. Separate class so callers (and tests)
 * can distinguish parameter-validation failures from downstream kernel
 * errors without string-matching.
 */
export class InvalidParametersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidParametersError';
  }
}

/**
 * Result of a single silicone + print-shell generation pass.
 *
 * Ownership — every `Manifold` returned here is a FRESH handle owned by
 * the caller. The caller MUST `.delete()` each of:
 *
 *   - `silicone`
 *   - `printShell`
 *
 * to release WASM heap memory. The input `master` Manifold is NOT
 * consumed — its lifetime remains with whoever owns it (typically the
 * Master group's userData; see `src/renderer/scene/master.ts`).
 *
 * The orchestrator (`src/renderer/ui/generateOrchestrator.ts`) owns this
 * contract on the renderer side. On the happy path both the silicone and
 * the print-shell hand off to their scene sinks; on stale-drop / error
 * paths the orchestrator disposes each Manifold here.
 */
export interface MoldGenerationResult {
  /**
   * Surface-conforming silicone body = shell minus master. Single piece.
   * Caller owns; `.delete()` when done.
   */
  readonly silicone: Manifold;
  /**
   * Surface-conforming rigid print shell hugging the silicone outer
   * surface. Open-top pour edge (trimmed at
   * `master.max.y + siliconeThickness + 3 mm`) and bottom trim at
   * `master.min.y`. Caller owns; `.delete()` when done.
   */
  readonly printShell: Manifold;
  /** Silicone body volume in mm³. */
  readonly siliconeVolume_mm3: number;
  /**
   * Resin pour volume in mm³. With sprue + vent channels removed, this
   * equals the master's volume exactly (to within kernel tolerance the
   * `manifold.volume()` call returns). Identity with `masterVolume_mm3`
   * is pinned in tests at 1e-9 relative.
   */
  readonly resinVolume_mm3: number;
  /**
   * Volume of the rigid print shell in mm³. Pre-computed once so
   * downstream topbar / UI surfaces don't have to re-walk the Manifold
   * to read it.
   */
  readonly printShellVolume_mm3: number;
}

/**
 * Hard lower bound on the silicone thickness the generator will accept,
 * in mm. The parameter store clamps to ≥ 1 mm; this defence-in-depth
 * floor matches so a kernel caller bypassing the UI still gets rejected
 * on the pre-#69 "wall too thin" condition.
 */
const MIN_SILICONE_THICKNESS_MM = 1;

/**
 * Top-trim lip (mm) above `master.max.y + siliconeThickness`. Creates a
 * 3 mm open pour edge above the silicone so the user can reach the
 * cavity with a pour spout and the top-of-silicone meniscus has room to
 * sit without touching the print shell. Captured here as a named
 * constant so Wave D/E/F can reference the same value.
 */
const PRINT_SHELL_POUR_EDGE_MM = 3;

/**
 * LevelSet grid spacing (mm). Tuned for the mini-figurine to land under
 * the CI budget while still giving a visually plausible silicone body.
 *
 * WAVE C bump (issue #72 bundles #71): floor raised from 1.5 mm → 2.0 mm.
 * At the default 5 mm silicone thickness, `5/4 = 1.25 mm < 2.0 mm`, so
 * the floor controls; raising it from 1.5 to 2.0 mm drops the BCC grid
 * cell count by ~60% (cell count scales ~n³, and the grid spans the
 * master bbox expanded by the offset magnitude). On the mini-figurine
 * this brings the observed CI wall-clock from ~7 s back under ~4 s —
 * the pre-Wave-B envelope.
 *
 * 2.0 mm is still `0.4 × thickness` at the default — well within the
 * `mesh-operations` skill's `0.3 × thickness` preview-fidelity budget.
 * When a future wave ships printable silicone (currently only rendered
 * for preview + volume), tighten this back toward
 * `min(0.3 × siliconeThickness, 1 mm)` per the skill default.
 *
 * Thanks to the QA follow-up on PR #70 + issue #71 for surfacing the
 * pre-Wave-B perf regression.
 */
function resolveEdgeLength(siliconeThickness_mm: number): number {
  return Math.max(2.0, siliconeThickness_mm / 4);
}

/**
 * Three.js `Matrix4.elements` is stored in COLUMN-MAJOR order (WebGL
 * convention), exactly matching manifold-3d's `Mat4` tuple. We can hand
 * the 16 floats across verbatim without any rewiring.
 */
function threeMatrixToManifoldMat4(m: Matrix4): Mat4 {
  const e = m.elements;
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
 * surfaces the manifold-3d status code.
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
 * Counters and timings exposed by a cached SDF — profiling aid. Reset per
 * `generateSiliconeShell` call. `rawCalls` is the total SDF invocations from
 * the `Manifold.levelSet` WASM side; `cacheHits` is how many of those were
 * satisfied by the quantised-key cache (no BVH descent); `bvhTimeMs` is the
 * cumulative wall-clock spent inside the BVH closest-point + raycast work
 * on CACHE MISSES only. Diff = rawCalls - cacheHits is the miss count.
 */
interface SdfStats {
  rawCalls: number;
  cacheHits: number;
  farFieldSkips: number;
  bvhTimeMs: number;
}

/**
 * Axis-aligned distance from a point to a bounding box. Returns 0 when
 * the point is inside the box, otherwise the Euclidean distance to the
 * nearest face/edge/corner. Used to cheaply early-out on far-field
 * samples that can skip the BVH descent entirely — see the SDF closure
 * in `buildMasterSdf` + issue #74 for the rationale.
 */
function distanceToAabb(
  px: number,
  py: number,
  pz: number,
  bb: Box,
): number {
  const dx = Math.max(0, bb.min[0] - px, px - bb.max[0]);
  const dy = Math.max(0, bb.min[1] - py, py - bb.max[1]);
  const dz = Math.max(0, bb.min[2] - pz, pz - bb.max[2]);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Build a signed-distance-function closure from a watertight master
 * Manifold using `three-mesh-bvh` for acceleration. Returns positive
 * distance inside the master, negative outside (matching manifold-3d's
 * levelSet convention: level > 0 insets, level < 0 outsets).
 *
 * The returned `sdf` is stateless relative to the level parameter — the
 * same closure can feed multiple `Manifold.levelSet` calls at different
 * iso-values (see Wave C pipeline: one call for silicone outer, one
 * for print-shell outer).
 *
 * Issue #74 perf fixes layered into the closure:
 *
 *   - **Quantised-key cache.** Keys are `round(p·1/cacheQuantum)`
 *     integer triples packed into a string. Combined with identical
 *     bounds across the two levelSet passes (see `unifiedBounds` in
 *     `generateSiliconeShell`), every sample of the second pass
 *     collides with a sample of the first pass — 50% hit rate exactly.
 *   - **Far-field early-out.** Samples whose AABB distance from the
 *     master exceeds `farFieldThreshold` skip the BVH descent and
 *     return a pre-computed constant below the deepest iso-level;
 *     marching-tets classifies those cells as "outside the volume"
 *     without needing an exact SDF magnitude.
 *   - **Non-axis-aligned parity ray.** See the `rayDir` literal below
 *     — axis-aligned rays graze shared edges of an axis-aligned
 *     master and produce ambiguous parity counts, which silently
 *     corrupted the iso-surface topology on the unit-cube fixture.
 *
 * The cache is scoped to a single `generateSiliconeShell` call via
 * closure state and released when the closure goes out of scope —
 * callers get no shared state across invocations.
 *
 * Caller must `.dispose()` the returned `geometry` when done; dropping
 * the `bvh` reference lets the JS GC reclaim it.
 */
async function buildMasterSdf(
  master: Manifold,
  cacheQuantum: number,
  farFieldThreshold: number,
): Promise<{
  sdf: (p: Vec3) => number;
  geometry: BufferGeometry;
  bvh: MeshBVH;
  stats: SdfStats;
}> {
  const geometry = await manifoldToBufferGeometry(master);
  const bvh = new MeshBVH(geometry);
  const masterBbox = master.boundingBox();

  const queryPoint = new Vector3();
  const rayOrigin = new Vector3();
  // Non-axis-aligned ray direction for parity-based inside/outside.
  //
  // Issue #74: the pre-fix code used `(1,0,0)` which grazes axis-aligned
  // mesh edges (cube faces, for instance) and returns ambiguous parity
  // counts when a ray passes through a shared edge between two
  // triangles. Under enlarged `bounds.min` (see `unifiedBounds` below),
  // the enlarged silicone grid exposes more samples whose rays cross
  // the axis-aligned master at a degenerate angle, and on the unit-cube
  // fixture the silicone iso-surface developed a spurious component at
  // the X-min grid wall (topology corruption surfacing as
  // `printShell.genus() === 3`). An irrational-ish direction
  // de-correlates the ray from any polygonal mesh so it never passes
  // exactly through an edge or vertex for non-degenerate inputs. The
  // chosen components (prime-ish fractions of a unit vector) keep the
  // ray predominantly along +X so the BVH spatial split still prunes
  // aggressively. Normalised so BVH distance comparisons stay in world
  // units.
  const rayDir = new Vector3(1, 0.00931, 0.01373).normalize();
  const ray = new Ray(rayOrigin, rayDir);

  // Quantised-key cache keyed by integer triple `(ix,iy,iz)` packed into
  // a string. `Map<string, number>` was measured 1.3-1.6× faster than a
  // `Map<bigint, number>` + bit-packed key on V8 18 for this workload —
  // string interning + short lifetimes play nicely with the nursery.
  const cache = new Map<string, number>();
  const invQ = 1 / cacheQuantum;
  const stats: SdfStats = {
    rawCalls: 0,
    cacheHits: 0,
    farFieldSkips: 0,
    bvhTimeMs: 0,
  };

  // Pre-computed far-field signed-distance return value. Any query with
  // AABB distance >= `farFieldThreshold` lies further from the master
  // than ANY iso-level the caller will ever request (callers pass
  // `shellThickness + siliconeThickness + margin`), so the exact SDF
  // magnitude is immaterial — marching tetrahedra only needs a value
  // strictly below the iso-level to classify the cell as "outside
  // volume". Returning a large negative constant is therefore
  // information-preserving for the level-set output.
  const farFieldReturnValue = -farFieldThreshold;

  const sdf = (p: Vec3): number => {
    stats.rawCalls++;
    // Quantise with `Math.round` so truly-identical grid samples (paid
    // for once by the first pass, hit free by the second) coalesce
    // despite any sub-LSB float drift across WASM→JS call sites.
    const ix = Math.round(p[0] * invQ);
    const iy = Math.round(p[1] * invQ);
    const iz = Math.round(p[2] * invQ);
    const key = `${ix},${iy},${iz}`;
    const hit = cache.get(key);
    if (hit !== undefined) {
      stats.cacheHits++;
      return hit;
    }

    // Issue #74 perf fix: far-field early-out. BVH descent is O(log N)
    // with a non-trivial constant factor (~1 µs on the figurine's
    // 5.7k-tri BVH); for grid samples outside the envelope of any iso
    // surface we ever compute, that cost is pure waste. The caller
    // derives `farFieldThreshold` from `max(|level|) + margin`, so this
    // check catches the entire "outer ring" of the enlarged levelSet
    // grid (~20% of samples on a typical figurine) and skips both the
    // closestPointToPoint and raycast calls.
    const aabbDist = distanceToAabb(p[0], p[1], p[2], masterBbox);
    if (aabbDist >= farFieldThreshold) {
      stats.farFieldSkips++;
      cache.set(key, farFieldReturnValue);
      return farFieldReturnValue;
    }

    const t0 = performance.now();
    queryPoint.set(p[0], p[1], p[2]);
    const bvhHit = bvh.closestPointToPoint(queryPoint);
    const distance = bvhHit ? bvhHit.distance : Number.POSITIVE_INFINITY;

    rayOrigin.copy(queryPoint);
    const hits = bvh.raycast(ray, DoubleSide);
    const inside = hits.length % 2 === 1;
    const signed = inside ? distance : -distance;
    stats.bvhTimeMs += performance.now() - t0;

    cache.set(key, signed);
    return signed;
  };

  return { sdf, geometry, bvh, stats };
}


/**
 * Compute the silicone body + the surface-conforming print shell + the
 * associated volumes for the given master Manifold and parameter set.
 *
 * Failure modes:
 *
 * - `parameters.siliconeThickness_mm < 1` → `InvalidParametersError`.
 * - `parameters.printShellThickness_mm` non-positive / non-finite
 *   → `InvalidParametersError`.
 * - `viewTransform.elements.length !== 16` → `Error`.
 * - Input master fails `isManifold` → `Error`.
 * - Intermediate / output stage produces a non-manifold result → `Error`
 *   with the offending step named.
 *
 * @param master Master Manifold, owned by the caller. Not consumed.
 * @param parameters Current mold parameters.
 * @param viewTransform The Master group's current world matrix.
 */
export async function generateSiliconeShell(
  master: Manifold,
  parameters: MoldParameters,
  viewTransform: Matrix4,
): Promise<MoldGenerationResult> {
  // Defence-in-depth validation. The UI's parameters panel already clamps
  // to legal ranges, but this function is reachable from tests and any
  // future non-UI caller, so the kernel validates its own inputs. Every
  // check here runs BEFORE the first Manifold allocation so a rejection
  // costs zero WASM heap.
  if (parameters.siliconeThickness_mm < MIN_SILICONE_THICKNESS_MM) {
    throw new InvalidParametersError(
      `generateSiliconeShell: siliconeThickness_mm=${parameters.siliconeThickness_mm} ` +
        `is below the minimum of ${MIN_SILICONE_THICKNESS_MM} mm`,
    );
  }
  if (!SIDE_COUNT_OPTIONS.includes(parameters.sideCount)) {
    throw new InvalidParametersError(
      `generateSiliconeShell: sideCount=${String(parameters.sideCount)} ` +
        `is not supported (must be one of ${SIDE_COUNT_OPTIONS.join(', ')})`,
    );
  }
  if (
    !(parameters.printShellThickness_mm > 0) ||
    !Number.isFinite(parameters.printShellThickness_mm)
  ) {
    throw new InvalidParametersError(
      `generateSiliconeShell: printShellThickness_mm=${parameters.printShellThickness_mm} ` +
        `must be a positive finite number`,
    );
  }

  const toplevel: ManifoldToplevel = await initManifold();
  assertManifold(master, 'input master');

  const t0 = performance.now();

  // Step 1: apply the viewport transform. `Manifold.transform` returns a
  // fresh Manifold — the original input is never mutated.
  const transformedMaster = master.transform(threeMatrixToManifoldMat4(viewTransform));
  const tTransform = performance.now();
  try {
    assertManifold(transformedMaster, 'transformed master');

    const edgeLength = resolveEdgeLength(parameters.siliconeThickness_mm);
    const siliconeThickness = parameters.siliconeThickness_mm;
    const shellThickness = parameters.printShellThickness_mm;
    const totalOffset = siliconeThickness + shellThickness;

    // Step 2a: build SDF over the transformed master. One BVH feeds both
    // levelSet passes below — the SDF closure is stateless w.r.t. the
    // iso-level, so no rebuild is needed between the silicone and
    // print-shell outsets.
    //
    // Issue #74 perf fix: the SDF wraps (a) a quantised-key cache shared
    // across both levelSet passes, and (b) a far-field early-out that
    // skips the BVH descent for samples outside the shell-offset
    // envelope. See `buildMasterSdf` for the details on both.
    //
    // `cacheQuantum` is *well* below the numerical tolerance we care
    // about (1e-6 mm per CLAUDE.md's vertex-coincidence tolerance) —
    // we only want to coalesce queries that manifold-3d intends as the
    // *same* lattice point computed via slightly different float paths
    // across the two passes.
    //
    // An earlier iteration used a coarser quantum (`edgeLength / 8`,
    // ~0.25 mm) to also absorb cross-pass drift when the two grids had
    // *different* lattices. That caused up-to-one-quantum SDF errors,
    // which for cells where the iso-surface sat near a BCC edge flipped
    // the marching-tetrahedra classification and changed topology —
    // surfaced as `printShell.genus() === 3` on the unit-cube test.
    //
    // With `unifiedBounds` below, the two grids ALREADY share a common
    // lattice — cross-pass matches come for free at machine precision.
    // A tight quantum is therefore lossless.
    //
    // `farFieldThreshold` bounds the AABB distance beyond which the
    // exact SDF value is immaterial to the marching-tetrahedra output.
    // Set to `totalOffset + edgeLength` so:
    //   1. No iso-level we ever request (max |level| = totalOffset)
    //      sits *inside* the far-field region — the iso-surface is
    //      always sampled in the near-field where the BVH provides
    //      exact distances.
    //   2. There is at least one grid-step of padding between the deep
    //      iso-level and the far-field cutoff, so a cell whose corners
    //      straddle the boundary still produces a monotonic
    //      interpolation (the far-field constant is more negative than
    //      the deepest iso-level by ≥ edgeLength), and marching-tets
    //      classifies such a cell as "fully outside the volume".
    const cacheQuantum = 1e-6;
    const farFieldThreshold = totalOffset + edgeLength;
    const sdfHandles = await buildMasterSdf(
      transformedMaster,
      cacheQuantum,
      farFieldThreshold,
    );
    const tSdf = performance.now();
    try {
      const masterBbox = transformedMaster.boundingBox();

      // Issue #74 perf fix: unify the two levelSet bounds onto one grid.
      //
      // manifold-3d's `levelSet` derives its BCC sample lattice from
      // `bounds.min` in steps related to `edgeLength`. Pre-#74 we ran the
      // silicone pass on a smaller grid (pad = silicone + 2·eL) and the
      // shell pass on a larger grid (pad = silicone + shell + 2·eL).
      // The two grids shared ZERO sample points in the overlap region
      // because their `min` corners sat on different sub-lattices, so
      // the SDF cache (`buildMasterSdf`) only captured ~22% cross-pass
      // hits on the mini-figurine despite ~80% geometric overlap. We
      // tried snapping `shellBounds.min = siliconeBounds.min − k·eL` to
      // force alignment — no effect, because manifold-3d rounds/adjusts
      // `bounds.min` internally before deriving the lattice and the
      // adjustment depends on `bounds.max − bounds.min`, not just min.
      //
      // Working fix: use IDENTICAL bounds for both calls. Same `min`,
      // same `max` → same lattice → every shell-pass sample is a
      // literal cache key collision with a silicone-pass sample. Cache
      // hit rate = 50.0% exactly (one full grid worth of cached
      // values; the shell pass contributes zero new work in the BVH
      // hot path). The silicone grid is enlarged to the shell pad, so
      // the silicone pass itself costs slightly more (~1.3× on a
      // figurine bbox) — but the shell pass collapses from O(shellGrid)
      // to O(cache-lookup), a much bigger win.
      //
      // The silicone iso-surface (level = -siliconeThickness) still
      // lives comfortably inside the enlarged grid — larger bounds
      // never clip an iso-surface that was already safe in the
      // original.
      const unifiedPad = totalOffset + 2 * edgeLength;
      const unifiedBounds: Box = {
        min: [
          masterBbox.min[0] - unifiedPad,
          masterBbox.min[1] - unifiedPad,
          masterBbox.min[2] - unifiedPad,
        ],
        max: [
          masterBbox.max[0] + unifiedPad,
          masterBbox.max[1] + unifiedPad,
          masterBbox.max[2] + unifiedPad,
        ],
      };
      const siliconeBounds = unifiedBounds;
      const shellBounds = unifiedBounds;

      // Step 3a: outer silicone shell via levelSet. `level = -siliconeThickness`
      // outsets the master by that distance.
      const siliconeOuter = toplevel.Manifold.levelSet(
        sdfHandles.sdf,
        siliconeBounds,
        edgeLength,
        -siliconeThickness,
      );
      const tSiliconeLevel = performance.now();
      let silicone: Manifold | undefined;
      let printShell: Manifold | undefined;
      try {
        assertManifold(siliconeOuter, 'silicone outer shell (post-levelSet)');

        // Step 3b: carve the cavity. `difference` is guaranteed-manifold
        // on two manifold inputs (ADR-002). The result is the SINGLE
        // silicone body we return.
        silicone = toplevel.Manifold.difference([siliconeOuter, transformedMaster]);
        assertManifold(silicone, 'silicone body (silicone outer − master)');
        const tCavity = performance.now();

        // Step 4a: SECOND levelSet for the print-shell outer at a larger
        // offset. Same SDF closure, bigger bounds to hold the bigger
        // negative iso-value.
        const shellOuter = toplevel.Manifold.levelSet(
          sdfHandles.sdf,
          shellBounds,
          edgeLength,
          -totalOffset,
        );
        const tShellLevel = performance.now();
        try {
          assertManifold(shellOuter, 'print-shell outer (post-levelSet)');

          // Step 4b: subtract the silicone outer body from the shell
          // outer body — yields a hollow surface-conforming shell with
          // the silicone fitting exactly inside.
          const shellRaw = toplevel.Manifold.difference([shellOuter, siliconeOuter]);
          let shellTrimTop: Manifold | undefined;
          try {
            assertManifold(shellRaw, 'print-shell raw (shellOuter − siliconeOuter)');

            // Step 4c: top trim. Plane normal [0, -1, 0] + originOffset
            // `-topY` keeps the half where `y <= topY` (the -y-axis half-
            // space below the plane y=topY). The top cut sits 3 mm above
            // the silicone top — leaves a pour edge.
            const topY = masterBbox.max[1] + siliconeThickness + PRINT_SHELL_POUR_EDGE_MM;
            shellTrimTop = shellRaw.trimByPlane([0, -1, 0], -topY);
            assertManifold(shellTrimTop, 'print-shell after top trim');

            // Step 4d: bottom trim. Plane normal [0, 1, 0] +
            // originOffset `bottomY` keeps the half where `y >= bottomY`.
            // The bottom cut sits at the master's lowest point — Wave D
            // will close this interface with a base slab; for Wave C the
            // shell simply ends there.
            const bottomY = masterBbox.min[1];
            printShell = shellTrimTop.trimByPlane([0, 1, 0], bottomY);
            assertManifold(printShell, 'print-shell after bottom trim');
          } finally {
            shellRaw.delete();
            if (shellTrimTop) shellTrimTop.delete();
          }

          const tPrintShell = performance.now();

          // Step 5: volumes. Resin identity (resin ≡ masterVolume) pinned
          // at 1e-9 relative — no sprue / vent channels contribute any
          // more.
          const siliconeVolume_mm3 = silicone.volume();
          const resinVolume_mm3 = master.volume();
          const printShellVolume_mm3 = printShell.volume();

          const sdfStats = sdfHandles.stats;
          const hitRate =
            sdfStats.rawCalls > 0
              ? (sdfStats.cacheHits / sdfStats.rawCalls) * 100
              : 0;
          const farFieldRate =
            sdfStats.rawCalls > 0
              ? (sdfStats.farFieldSkips / sdfStats.rawCalls) * 100
              : 0;
          console.debug(
            `[generateSiliconeShell] step timings (ms): ` +
              `transform=${(tTransform - t0).toFixed(1)} ` +
              `sdf-build=${(tSdf - tTransform).toFixed(1)} ` +
              `silicone-levelset=${(tSiliconeLevel - tSdf).toFixed(1)} ` +
              `cavity=${(tCavity - tSiliconeLevel).toFixed(1)} ` +
              `shell-levelset=${(tShellLevel - tCavity).toFixed(1)} ` +
              `shell-trim=${(tPrintShell - tShellLevel).toFixed(1)} ` +
              `total=${(tPrintShell - t0).toFixed(1)} ` +
              `(edgeLength=${edgeLength.toFixed(2)} mm, ` +
              `sideCount=${parameters.sideCount}) ` +
              `sdf: calls=${sdfStats.rawCalls} ` +
              `cacheHits=${sdfStats.cacheHits}(${hitRate.toFixed(1)}%) ` +
              `farSkips=${sdfStats.farFieldSkips}(${farFieldRate.toFixed(1)}%) ` +
              `bvhMs=${sdfStats.bvhTimeMs.toFixed(0)}`,
          );
          console.info(
            `[generateSiliconeShell] silicone=${siliconeVolume_mm3.toFixed(1)} mm³, ` +
              `resin=${resinVolume_mm3.toFixed(1)} mm³, ` +
              `printShell=${printShellVolume_mm3.toFixed(1)} mm³ ` +
              `(siliconeThickness=${siliconeThickness} mm, ` +
              `printShellThickness=${shellThickness} mm, ` +
              `sideCount=${parameters.sideCount}, ` +
              `total=${(tPrintShell - t0).toFixed(1)} ms)`,
          );

          return {
            silicone,
            printShell,
            siliconeVolume_mm3,
            resinVolume_mm3,
            printShellVolume_mm3,
          };
        } finally {
          shellOuter.delete();
        }
      } catch (err) {
        // On any failure between silicone allocation and return, release
        // every successfully-allocated Manifold so the caller never
        // inherits an un-owned WASM handle.
        if (silicone && silicone !== printShell) {
          silicone.delete();
        }
        if (printShell) printShell.delete();
        throw err;
      } finally {
        siliconeOuter.delete();
      }
    } finally {
      // Release the SDF-side resources.
      sdfHandles.geometry.dispose();
      void sdfHandles.bvh;
    }
  } finally {
    transformedMaster.delete();
  }
}
