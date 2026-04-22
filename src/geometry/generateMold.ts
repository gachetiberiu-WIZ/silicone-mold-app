// src/geometry/generateMold.ts
//
// Mold generator — Phase 3d Wave C (issue #72). Produces:
//
//   1. a surface-conforming silicone body (shell − master) around the
//      master via BVH-accelerated `Manifold.levelSet`. Trimmed open at
//      `master.max.y` (issue #87 dogfood fix) so the master's top face
//      is exposed as the pour opening — the user pours liquid silicone
//      from above into the pour well that the shell rim forms above
//      the silicone.
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
// Wave D (issue #82, this commit) adds a printable base slab with a
// step-pocket interlock plug: the shell drops onto a 2 mm plug whose
// footprint matches the shell's inner-cavity outer edge minus 0.2 mm of
// clearance. The slab extrudes downward from `master.min.y` by
// `baseSlabThickness_mm`, with a footprint offset outward by
// `silicone + shell + overhang`. The shell's bottom trim moves from
// `master.min.y` to `master.min.y - 2 mm` so the shell wraps the plug
// flush. See `./baseSlab.ts` for the geometry helper.
//
// OUT OF SCOPE for this PR (deferred to Waves E/F):
//   - Radial slicing of the shell into 2/3/4 printable pieces (Wave E).
//   - Brims on the sliced pieces (Wave F).
//   - Registration keys on future brim interfaces (Wave F).
//   - Draft-angle application (separate wave).
//
// Offset algorithm + perf playbook:
//
//   The pipeline calls `Manifold.levelSet` TWICE against the SAME SDF
//   closure (silicone pass, then print-shell pass). See the
//   mesh-operations skill's "LevelSet perf playbook" section for:
//     - Unified grid bounds + quantised SDF cache (issue #74 #75).
//     - Far-field early-out.
//     - Non-axis-aligned parity ray (#74 topology-corruption fix).
//     - edgeLength floor (#71 #86).
//   Preserve those when editing this path.

import { DoubleSide, Ray, Vector3 } from 'three';
import type { BufferGeometry, Matrix4 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { Box, CrossSection, Manifold, ManifoldToplevel, Mat4, Vec3 } from 'manifold-3d';

import type { MoldParameters } from '@/renderer/state/parameters';
import { SIDE_COUNT_OPTIONS } from '@/renderer/state/parameters';
import { manifoldToBufferGeometry, isManifold } from './adapters';
import { buildBaseSlab, BASE_SLAB_PLUG_HEIGHT_MM } from './baseSlab';
import { addBrim } from './brim';
import { initManifold } from './initManifold';
import { sliceShellRadial } from './shellSlicer';

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
 *   - every `shellPieces[i]` (Wave E, issue #84)
 *   - `basePart`
 *
 * to release WASM heap memory. The input `master` Manifold is NOT
 * consumed — its lifetime remains with whoever owns it (typically the
 * Master group's userData; see `src/renderer/scene/master.ts`).
 *
 * The orchestrator (`src/renderer/ui/generateOrchestrator.ts`) owns this
 * contract on the renderer side. On the happy path the silicone and the
 * shell pieces hand off to their scene sinks; on stale-drop / error
 * paths the orchestrator disposes every Manifold here.
 */
export interface MoldGenerationResult {
  /**
   * Surface-conforming silicone body = shell minus master. Single piece.
   * Caller owns; `.delete()` when done.
   */
  readonly silicone: Manifold;
  /**
   * Radially-sliced rigid print shell pieces (Wave E, issue #84) with
   * brim flanges attached on each cut face (Wave F). `length` equals
   * `parameters.sideCount`. The original surface-conforming shell hugs
   * the silicone outer surface (open-top pour edge trimmed at
   * `master.max.y + siliconeThickness + 3 mm`, bottom trim at
   * `master.min.y - 2 mm` so the shell wraps the base-slab plug); it is
   * then split into `sideCount` pieces by vertical half-space planes
   * through the master's XZ center at the angles from `SIDE_CUT_ANGLES`.
   * Caller owns each element; `.delete()` when done.
   */
  readonly shellPieces: readonly Manifold[];
  /**
   * Printable base slab with step-pocket interlock (Wave D, issue #82).
   * Flat slab under the shell + raised plug that locates the shell over
   * the master cavity. Caller owns; `.delete()` when done.
   */
  readonly basePart: Manifold;
  /** Silicone body volume in mm³. */
  readonly siliconeVolume_mm3: number;
  /**
   * Resin pour volume in mm³. With sprue + vent channels removed, this
   * equals the TRANSFORMED master's volume exactly (to within kernel
   * tolerance the `manifold.volume()` call returns). Identity with
   * `transformedMaster.volume()` is pinned in tests at 1e-9 relative.
   *
   * Issue #81: pre-fix this read `master.volume()` (untransformed), so
   * a non-identity viewTransform — notably the Dimensions panel scale
   * (#79) — left the Resin topbar readout pegged at the untransformed
   * volume even as the viewport + silicone scaled correctly. Now
   * derived from `transformedMaster.volume()` so scale + rotation +
   * translation all flow through. Identity viewTransform still yields
   * `master.volume()` within `Manifold.transform` roundoff, preserving
   * the original 1e-9 relative identity for untransformed fixtures.
   */
  readonly resinVolume_mm3: number;
  /**
   * Per-piece volume (mm³) of each shell piece in `shellPieces`, same
   * order. Pre-computed once so downstream UIs don't re-walk the
   * Manifolds.
   */
  readonly shellPiecesVolume_mm3: readonly number[];
  /**
   * Total shell volume (mm³) = sum of `shellPiecesVolume_mm3`. Backs
   * the topbar's "Print shell" readout (plural pieces aggregated for
   * display consistency with pre-Wave-E releases).
   */
  readonly totalShellVolume_mm3: number;
  /**
   * Volume of the printable base slab in mm³ (Wave D, issue #82). Pre-
   * computed once so the topbar can render it without re-walking.
   */
  readonly baseSlabVolume_mm3: number;
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
 * Safety slop (mm) added above the shell's top Y when extruding the pour-
 * channel prism, so the channel poses past the shell's dome cap and
 * guarantees a through-hole after subtraction.
 *
 * See issue #94 Fix 1. The shell's post-trim top Y sits at
 * `masterMaxY + siliconeThickness + PRINT_SHELL_POUR_EDGE_MM`; extruding
 * the pour channel by `siliconeThickness + PRINT_SHELL_POUR_EDGE_MM +
 * PRINT_SHELL_POUR_CHANNEL_SLOP_MM` above `masterMaxY` puts the channel's
 * top face above the shell's topmost geometry, so `shell.difference(channel)`
 * fully carves out the remaining cap. 2 mm is the same slop convention
 * used elsewhere in the pipeline for trim-past safety.
 */
const PRINT_SHELL_POUR_CHANNEL_SLOP_MM = 2;

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
 * Build a vertical prism (pour channel) whose XZ footprint matches the
 * silicone-outer's silhouette at world-Y = `masterMaxYInWorld`, extending
 * from `masterMaxYInWorld` upward by `channelHeight`. Used to carve an
 * open-top pour hole through the shell's dome cap (issue #94 Fix 1).
 *
 * Pre-#94 the print shell had a CLOSED cap at the top: the levelSet that
 * built the shell's outer body produced a dome that extended PAST the
 * silicone outer's dome (the shell outset is larger), and the single top-
 * trim plane at `masterMaxY + siliconeThickness + PRINT_SHELL_POUR_EDGE_MM`
 * only sliced the tip — leaving solid shell material covering the pour
 * well. For the mold to actually be pourable end-to-end, the user needs
 * a THROUGH-HOLE from above.
 *
 * Algorithm:
 *
 *   1. Rotate siliconeOuter `[90, 0, 0]` so our-world +Y maps to rotated
 *      +Z (Manifold's slice frame is XY plane at z=height; matches the
 *      convention in `./baseSlab.ts`).
 *   2. `slice(masterMaxYInWorld)` returns a CrossSection equal to the
 *      horizontal silhouette of the silicone outer at the master's top
 *      face — exactly the XZ footprint of the pour well.
 *   3. `extrude(channelHeight)` pushes that 2D silhouette up by the given
 *      height; the extruded prism sits in rotated-frame Z ∈ [0, height].
 *   4. Rotate back `[-90, 0, 0]` to our-world, then translate so the
 *      base sits at world-Y = `masterMaxYInWorld` and the top at
 *      `masterMaxYInWorld + channelHeight`.
 *
 * If the silicone-outer slice at `masterMaxYInWorld` is empty or has
 * zero contours (degenerate master-top geometry), returns `undefined` —
 * the caller skips the subtraction in that case (no hole to carve but
 * also no cap to worry about for that pathological input).
 *
 * Ownership: every intermediate CrossSection + Manifold is disposed
 * inside this helper. The returned Manifold (if any) is fresh — caller
 * owns it and must `.delete()` after use.
 */
function buildPourChannelPrism(
  siliconeOuter: Manifold,
  masterMaxYInWorld: number,
  channelHeight: number,
): Manifold | undefined {
  // Forward pass: our-Y → rotated-Z. Matches `./baseSlab.ts`.
  const rotatedSiliconeOuter = siliconeOuter.rotate([90, 0, 0]);
  let silhouetteCs: CrossSection | undefined;
  let channelInRotated: Manifold | undefined;
  let channelInWorld: Manifold | undefined;
  try {
    silhouetteCs = rotatedSiliconeOuter.slice(masterMaxYInWorld);
    if (silhouetteCs.isEmpty() || silhouetteCs.numContour() === 0) {
      return undefined;
    }
    // Extrude in rotated frame — prism spans rotated-Z ∈ [0, channelHeight].
    channelInRotated = silhouetteCs.extrude(channelHeight);
    // Rotate back to our-world Y-up frame. `.rotate([-90,0,0])` maps
    // rotated +Z → our-world +Y.
    const backRotated = channelInRotated.rotate([-90, 0, 0]);
    channelInRotated.delete();
    channelInRotated = undefined;
    // Translate so the prism's base sits at world-Y = masterMaxYInWorld.
    // Post-rotation the prism lies in world-Y ∈ [0, channelHeight], so
    // we shift by +masterMaxYInWorld on Y.
    channelInWorld = backRotated.translate([0, masterMaxYInWorld, 0]);
    backRotated.delete();
    // Hand off ownership; clear the local so the finally doesn't re-delete.
    const out = channelInWorld;
    channelInWorld = undefined;
    return out;
  } finally {
    rotatedSiliconeOuter.delete();
    if (silhouetteCs) silhouetteCs.delete();
    if (channelInRotated) channelInRotated.delete();
    if (channelInWorld) channelInWorld.delete();
  }
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
 * Phase identifier emitted by `generateSiliconeShell` via its optional
 * `onPhase` callback (issue #87 Fix 1). Used by the renderer to update
 * a progress banner during the generate pipeline so the user sees
 * something besides a frozen canvas on a 10–60 s run.
 *
 * Emitted at each phase boundary BEFORE the work for that phase begins;
 * the callback caller can `await` a RAF tick between emissions so the
 * DOM paints before the next synchronous manifold op blocks the UI
 * thread.
 */
export type GeneratePhase =
  | 'silicone'
  | 'shell'
  | 'slicing'
  | 'brims'
  | 'slab';

/**
 * Optional progress callback signature. Typed as `Promise<void> | void`
 * so the orchestrator can return a RAF-yield promise and the generator
 * will await it — that's what buys us "DOM paints between phases"
 * without restructuring the pipeline into an async generator.
 */
export type OnGeneratePhase = (
  phase: GeneratePhase,
) => void | Promise<void>;

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
 * @param onPhase Optional progress callback fired BEFORE each heavy
 *   phase begins. The return value (sync or Promise) is awaited, so
 *   the caller can yield to RAF between phases — see issue #87 Fix 1.
 */
export async function generateSiliconeShell(
  master: Manifold,
  parameters: MoldParameters,
  viewTransform: Matrix4,
  onPhase?: OnGeneratePhase,
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
  if (
    !(parameters.baseSlabThickness_mm > 0) ||
    !Number.isFinite(parameters.baseSlabThickness_mm)
  ) {
    throw new InvalidParametersError(
      `generateSiliconeShell: baseSlabThickness_mm=${parameters.baseSlabThickness_mm} ` +
        `must be a positive finite number`,
    );
  }
  if (
    !(parameters.baseSlabOverhang_mm > 0) ||
    !Number.isFinite(parameters.baseSlabOverhang_mm)
  ) {
    throw new InvalidParametersError(
      `generateSiliconeShell: baseSlabOverhang_mm=${parameters.baseSlabOverhang_mm} ` +
        `must be a positive finite number`,
    );
  }
  if (
    !(parameters.brimWidth_mm > 0) ||
    !Number.isFinite(parameters.brimWidth_mm)
  ) {
    throw new InvalidParametersError(
      `generateSiliconeShell: brimWidth_mm=${parameters.brimWidth_mm} ` +
        `must be a positive finite number`,
    );
  }
  if (
    !(parameters.brimThickness_mm > 0) ||
    !Number.isFinite(parameters.brimThickness_mm)
  ) {
    throw new InvalidParametersError(
      `generateSiliconeShell: brimThickness_mm=${parameters.brimThickness_mm} ` +
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

      // Issue #87 Fix 1: fire the per-phase progress callback BEFORE
      // each heavy step starts. Awaiting the return value lets the
      // caller yield to RAF so the progress banner repaints before
      // the synchronous manifold op blocks the UI thread.
      if (onPhase) await onPhase('silicone');

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
      let shellPieces: Manifold[] | undefined;
      let basePart: Manifold | undefined;
      try {
        assertManifold(siliconeOuter, 'silicone outer shell (post-levelSet)');

        // Step 3b: carve the cavity. `difference` is guaranteed-manifold
        // on two manifold inputs (ADR-002). The result is the SINGLE
        // silicone body we return.
        const siliconeClosed = toplevel.Manifold.difference([
          siliconeOuter,
          transformedMaster,
        ]);
        let siliconeClosedDisposed = false;
        try {
          assertManifold(
            siliconeClosed,
            'silicone body (silicone outer − master)',
          );

          // Step 3c (issue #87 dogfood fix): trim the silicone top so
          // the master's upper face is EXPOSED — the user pours liquid
          // silicone from above through this opening. Pre-fix the
          // silicone fully enclosed the master (genus ≥ 1, sealed
          // jacket) and there was no visible pour path.
          //
          // Trim plane: y = masterMaxYInWorld. `trimByPlane(n, d)` keeps
          // the half where `dot(p, n) >= d`. For `n = [0, -1, 0]`,
          // `d = -masterMaxY` keeps `-y >= -masterMaxY`, i.e.
          // `y <= masterMaxY`. The result is a silicone body whose top
          // surface lies at the master's top Y with the master's top
          // outline as a hole — the pour opening.
          //
          // The shell's top trim still sits at
          // `masterMaxY + siliconeThickness + PRINT_SHELL_POUR_EDGE_MM`,
          // so the shell now forms a rim `siliconeThickness + 3 mm`
          // above the silicone → a pour well the user pours liquid
          // silicone into.
          const siliconeTrimY = masterBbox.max[1];
          silicone = siliconeClosed.trimByPlane([0, -1, 0], -siliconeTrimY);
          // Release the closed-top silicone immediately — ownership of
          // the trimmed result transfers to `silicone` for the rest of
          // the pipeline.
          siliconeClosed.delete();
          siliconeClosedDisposed = true;
          assertManifold(silicone, 'silicone body (top-trimmed for pour)');
        } finally {
          // Defence-in-depth: if `trimByPlane` throws or `assertManifold`
          // rejects the trimmed result, make sure we release the
          // pre-trim Manifold. `silicone` itself is released by the
          // broader error path already in place below.
          if (!siliconeClosedDisposed) {
            try { siliconeClosed.delete(); } catch { /* already dead */ }
          }
        }
        const tCavity = performance.now();

        if (onPhase) await onPhase('shell');

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
        let printShellFull: Manifold | undefined;
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
            //
            // Wave D (issue #82): the bottom cut sits at
            // `master.min.y - BASE_SLAB_PLUG_HEIGHT_MM` (= 2 mm) so the
            // shell wraps the plug of the base slab. Pre-Wave-D (Wave C)
            // this trim was flush at `master.min.y`. Moving it down by
            // the plug height gives a cleaner mechanical interlock: the
            // shell drops over the plug and the plug's 0.2 mm horizontal
            // clearance locates it.
            const bottomY = masterBbox.min[1] - BASE_SLAB_PLUG_HEIGHT_MM;
            printShellFull = shellTrimTop.trimByPlane([0, 1, 0], bottomY);
            assertManifold(printShellFull, 'print-shell after bottom trim');
          } finally {
            shellRaw.delete();
            if (shellTrimTop) shellTrimTop.delete();
          }

          // Step 4e (issue #94 Fix 1): carve an OPEN POUR CHANNEL through
          // the shell's top cap. The levelSet-built shellOuter extends
          // past siliconeOuter's dome (the shell outset is larger), so
          // the step-4c top trim at `masterMaxY + siliconeThickness +
          // PRINT_SHELL_POUR_EDGE_MM` only slices the tip — leaving a
          // solid cap over the pour well. For the mold to be actually
          // pourable end-to-end, we subtract a vertical prism whose XZ
          // footprint matches siliconeOuter's silhouette at
          // `master.max.y`, extruded upward past the shell's top trim
          // plane. The result is a through-hole from the shell's top
          // face down to the silicone's pour opening.
          const masterMaxYInWorld = masterBbox.max[1];
          // Channel height measured from `masterMaxY`: enough to poke
          // past the shell's top-trim plane (at masterMaxY + silicone +
          // PRINT_SHELL_POUR_EDGE_MM) with a safety slop so
          // `shell.difference(channel)` fully removes the remaining cap.
          const pourChannelHeight =
            siliconeThickness +
            PRINT_SHELL_POUR_EDGE_MM +
            PRINT_SHELL_POUR_CHANNEL_SLOP_MM;
          const pourChannel = buildPourChannelPrism(
            siliconeOuter,
            masterMaxYInWorld,
            pourChannelHeight,
          );
          if (pourChannel) {
            try {
              const closedShell = printShellFull;
              const shellWithHole = toplevel.Manifold.difference([
                closedShell,
                pourChannel,
              ]);
              try {
                assertManifold(
                  shellWithHole,
                  'print-shell after pour-channel subtract',
                );
              } catch (err) {
                shellWithHole.delete();
                throw err;
              }
              // Swap: printShellFull now owns the through-holed shell,
              // and the old closed-cap shell is released.
              closedShell.delete();
              printShellFull = shellWithHole;
            } finally {
              pourChannel.delete();
            }
          }

          const tPrintShell = performance.now();

          // Step 5: Wave E + F — radial slice + brim. Capture the pre-
          // slice shell's bounding box for the brim builder (brim Y
          // span clamps to `[shellMinY+2, shellMaxY-2]`, radial extent
          // derived from `shellOuterRadius = max |shellBbox - xzCenter|`
          // along any XZ face). Then slice into `sideCount` pieces and
          // union a brim onto each piece's cut face(s).
          const shellBbox = printShellFull.boundingBox();
          const xzCenter = {
            x: (masterBbox.min[0] + masterBbox.max[0]) / 2,
            z: (masterBbox.min[2] + masterBbox.max[2]) / 2,
          };
          const shellBboxWorld = {
            min: {
              x: shellBbox.min[0],
              y: shellBbox.min[1],
              z: shellBbox.min[2],
            },
            max: {
              x: shellBbox.max[0],
              y: shellBbox.max[1],
              z: shellBbox.max[2],
            },
          };
          if (onPhase) await onPhase('slicing');
          const rawPieces = sliceShellRadial(
            toplevel,
            printShellFull,
            parameters.sideCount,
            xzCenter,
          );
          // The full shell is no longer needed — the pieces cover its
          // volume minus trimming rounding.
          printShellFull.delete();
          printShellFull = undefined;
          const tSlice = performance.now();

          if (onPhase) await onPhase('brims');
          // Add brim to each piece. `addBrim` consumes its input and
          // returns a fresh Manifold; we swap the array entry in-place
          // so the failure path can release all currently-owned pieces
          // in one sweep.
          shellPieces = new Array<Manifold>(rawPieces.length);
          try {
            for (let i = 0; i < rawPieces.length; i++) {
              const rawPiece = rawPieces[i] as Manifold;
              // Null out the slot BEFORE addBrim so if it throws we
              // don't double-delete (addBrim disposes its input on
              // both success AND failure per contract).
              rawPieces[i] = undefined as unknown as Manifold;
              const brimmed = addBrim({
                toplevel,
                piece: rawPiece,
                pieceIndex: i,
                sideCount: parameters.sideCount,
                shellBboxWorld,
                xzCenter,
                brimWidth_mm: parameters.brimWidth_mm,
                brimThickness_mm: parameters.brimThickness_mm,
                // Issue #89 fix: pass the shell's inner-cavity volume
                // (master-outset by `siliconeThickness`) + the shell
                // thickness so the brim builder can (a) size the brim
                // to cover `bondOverlap = printShellThickness` inward
                // into the shell wall, and (b) carve the silicone
                // cavity out of the brim box so it never intrudes.
                // `siliconeOuter` is the Manifold allocated above at
                // the silicone-outer levelSet step; the `finally`
                // at the end of this try block disposes it AFTER
                // every addBrim call completes (it needs to survive
                // every iteration).
                siliconeOuter,
                printShellThickness_mm: shellThickness,
              });
              assertManifold(brimmed, `shell piece ${i} (post-brim)`);
              shellPieces[i] = brimmed;
            }
          } catch (err) {
            // Release any remaining raw pieces that haven't been
            // handed to addBrim yet.
            for (const rp of rawPieces) {
              if (rp) {
                try { rp.delete(); } catch { /* already dead */ }
              }
            }
            throw err;
          }
          const tBrim = performance.now();

          if (onPhase) await onPhase('slab');
          // Step 6: Wave D base slab + plug. Slice the transformed
          // master at its lowest Y, offset the footprint twice (outer
          // slab ring, inner plug ring), extrude each, union into one
          // watertight piece. Returns a fresh Manifold in our world
          // frame — its bounds sit at
          // Y ∈ [master.min.y - baseSlabThickness, master.min.y + 2 mm].
          basePart = buildBaseSlab(toplevel, {
            transformedMaster,
            masterBboxWorld: {
              min: {
                x: masterBbox.min[0],
                y: masterBbox.min[1],
                z: masterBbox.min[2],
              },
              max: {
                x: masterBbox.max[0],
                y: masterBbox.max[1],
                z: masterBbox.max[2],
              },
            },
            siliconeThickness_mm: siliconeThickness,
            printShellThickness_mm: shellThickness,
            baseSlabThickness_mm: parameters.baseSlabThickness_mm,
            baseSlabOverhang_mm: parameters.baseSlabOverhang_mm,
          });
          // `basePart` can legitimately be empty if the master's lowest-Y
          // slice is degenerate (e.g. a sphere tapering to a single-vertex
          // bottom) — `buildBaseSlab` returns a valid-but-empty Manifold
          // in that case. We don't assertManifold here; downstream (the
          // scene module + topbar) handle the empty case gracefully.
          //
          // Issue #97 Fix 3 (polish dogfood 2026-04-21 round 3): surface
          // a console.warn when the slab came out empty. Silent empties
          // looked like "slab missing from scene" in the dogfood session
          // even though the geometry was technically correct for the
          // given master. Gated off under NODE_ENV=test to keep the
          // geometry unit-test log output quiet for fixtures that
          // intentionally hit the degenerate path.
          if (basePart.isEmpty() && process.env.NODE_ENV !== 'test') {
            console.warn(
              '[generateSiliconeShell] base slab came out empty — the ' +
                "master's lowest-Y slice is degenerate (no supporting " +
                'footprint). The printable-parts scene module will render ' +
                'zero slab geometry; shell pieces are unaffected. If you ' +
                'see "slab missing" in the UI, try re-orienting the master ' +
                'so a flat face sits on the bed.',
            );
          }
          const tBaseSlab = performance.now();

          // Step 7: volumes. Resin identity (resin ≡ transformedMasterVolume)
          // pinned at 1e-9 relative — no sprue / vent channels contribute
          // any more.
          //
          // Issue #81: use `transformedMaster.volume()` (not the raw
          // `master`) so the Dimensions panel's scale + any lay-flat
          // rotation + translation all flow into the Resin readout.
          // Every downstream op in this pipeline already runs against
          // `transformedMaster`; this line is catching up to the rest.
          // Identity viewTransform falls back to the untransformed
          // volume within `Manifold.transform` roundoff (< 1e-12 rel).
          const siliconeVolume_mm3 = silicone.volume();
          const resinVolume_mm3 = transformedMaster.volume();
          const shellPiecesVolume_mm3 = shellPieces.map((p) => p.volume());
          const totalShellVolume_mm3 = shellPiecesVolume_mm3.reduce(
            (sum, v) => sum + v,
            0,
          );
          const baseSlabVolume_mm3 = basePart.volume();

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
              `shell-slice=${(tSlice - tPrintShell).toFixed(1)} ` +
              `shell-brims=${(tBrim - tSlice).toFixed(1)} ` +
              `baseSlab-build=${(tBaseSlab - tBrim).toFixed(1)} ` +
              `total=${(tBaseSlab - t0).toFixed(1)} ` +
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
              `shellPieces=${shellPieces.length} (total=${totalShellVolume_mm3.toFixed(1)} mm³), ` +
              `baseSlab=${baseSlabVolume_mm3.toFixed(1)} mm³ ` +
              `(siliconeThickness=${siliconeThickness} mm, ` +
              `printShellThickness=${shellThickness} mm, ` +
              `baseSlabThickness=${parameters.baseSlabThickness_mm} mm, ` +
              `baseSlabOverhang=${parameters.baseSlabOverhang_mm} mm, ` +
              `brimWidth=${parameters.brimWidth_mm} mm, ` +
              `brimThickness=${parameters.brimThickness_mm} mm, ` +
              `sideCount=${parameters.sideCount}, ` +
              `total=${(tBaseSlab - t0).toFixed(1)} ms)`,
          );

          return {
            silicone,
            shellPieces,
            basePart,
            siliconeVolume_mm3,
            resinVolume_mm3,
            shellPiecesVolume_mm3,
            totalShellVolume_mm3,
            baseSlabVolume_mm3,
          };
        } finally {
          shellOuter.delete();
          if (printShellFull) printShellFull.delete();
        }
      } catch (err) {
        // On any failure between silicone allocation and return, release
        // every successfully-allocated Manifold so the caller never
        // inherits an un-owned WASM handle.
        if (silicone) silicone.delete();
        if (shellPieces) {
          for (const p of shellPieces) {
            if (p) {
              try { p.delete(); } catch { /* already dead */ }
            }
          }
        }
        if (basePart) basePart.delete();
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
