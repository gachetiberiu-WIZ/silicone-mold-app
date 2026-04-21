// src/geometry/generateMold.ts
//
// Mold generator — Phase 3d Wave A (issue #69) trims the pipeline to:
//
//   1. apply the viewport transform to the master (so all downstream
//      operations are in the oriented frame the user sees),
//   2. compute the outer silicone offset surface (`shell`) around the
//      master via BVH-accelerated `Manifold.levelSet`,
//   3. carve the cavity — `silicone = shell − master`,
//   4. build the (still-rectangular) printable-box parts (base + N sides +
//      top cap) via `buildPrintableBox` using the silicone body's AABB as
//      the inner cavity,
//   5. compute volumes: silicone volume, resin volume (== master volume —
//      no sprue/vent channels now), and printable volume.
//
// REMOVED in Wave A:
//   - horizontal silicone split (the silicone is now a single body),
//   - registration-key stamping,
//   - sprue drilling,
//   - vent drilling.
// These belonged to the two-halves-in-box strategy the user has replaced
// with "rigid-shell + silicone-glove" (issue #69 context). The rectangular
// print box stays in this PR; it's replaced by a surface-conforming shell
// in the follow-up PR (Wave C).
//
// Offset algorithm — `Manifold.levelSet` over a BVH-driven SDF:
//
//   The `mesh-operations` skill + ADR-002 both prescribe
//   `Manifold.levelSet` as the quality-path offset for silicone walls.
//   The issue body's shorthand `shell = levelSet(master, siliconeThickness)`
//   maps to the real API as:
//
//     Manifold.levelSet(sdf, bounds, edgeLength, level=-siliconeThickness)
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
//   resolution. We coarsen to `max(1.5 mm, siliconeThickness / 4)` —
//   ~1.5 mm on the post-#69 default 5 mm silicone thickness. This keeps
//   the mini-figurine well under the 3 000 ms budget. When a future wave
//   ships printable silicone (currently only rendered for preview +
//   volume), tighten edgeLength back toward the skill default.

import { DoubleSide, Ray, Vector3 } from 'three';
import type { BufferGeometry, Matrix4 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { Box, Manifold, ManifoldToplevel, Mat4, Vec3 } from 'manifold-3d';

import type { MoldParameters } from '@/renderer/state/parameters';
import { SIDE_COUNT_OPTIONS } from '@/renderer/state/parameters';
import { manifoldToBufferGeometry, isManifold } from './adapters';
import { initManifold } from './initManifold';
import { buildPrintableBox } from './printableBox';

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
 * Result of a single silicone + printable-box generation pass.
 *
 * Ownership — every `Manifold` returned here is a FRESH handle owned by
 * the caller. The caller MUST `.delete()` each of:
 *
 *   - `silicone`
 *   - `basePart`, `topCapPart`
 *   - every element of `sideParts`
 *
 * to release WASM heap memory. The input `master` Manifold is NOT
 * consumed — its lifetime remains with whoever owns it (typically the
 * Master group's userData; see `src/renderer/scene/master.ts`).
 *
 * The orchestrator (`src/renderer/ui/generateOrchestrator.ts`) owns this
 * contract on the renderer side. On the happy path both the silicone and
 * the printable-box parts hand off to their scene sinks; on stale-drop /
 * error paths the orchestrator disposes each Manifold here.
 */
export interface MoldGenerationResult {
  /**
   * Surface-conforming silicone body = shell minus master. Single piece
   * in the Wave-A pipeline (the horizontal split is gone). Caller owns;
   * `.delete()` when done.
   */
  readonly silicone: Manifold;
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
   * Sum of `basePart.volume() + Σ sideParts[i].volume() +
   * topCapPart.volume()`, in mm³. Pre-computed so downstream topbar /
   * UI surfaces don't have to re-walk the parts to read it.
   */
  readonly printableVolume_mm3: number;
}

/**
 * Hard lower bound on the silicone thickness the generator will accept,
 * in mm. The parameter store clamps to ≥ 1 mm; this defence-in-depth
 * floor matches so a kernel caller bypassing the UI still gets rejected
 * on the pre-#69 "wall too thin" condition.
 */
const MIN_SILICONE_THICKNESS_MM = 1;

/**
 * LevelSet grid spacing (mm). Tuned for the mini-figurine to land under
 * the 3 000 ms budget while still giving a visually plausible silicone
 * body. When a future wave ships printable silicone, tighten this back
 * toward `min(0.3 × siliconeThickness, 1 mm)` per the `mesh-operations`
 * skill default.
 */
function resolveEdgeLength(siliconeThickness_mm: number): number {
  return Math.max(1.5, siliconeThickness_mm / 4);
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
 * Build a signed-distance-function closure from a watertight master
 * Manifold using `three-mesh-bvh` for acceleration. Returns positive
 * distance inside the master, negative outside (matching manifold-3d's
 * levelSet convention: level > 0 insets, level < 0 outsets).
 *
 * Caller must `.dispose()` the returned `geometry` when done; dropping the
 * `bvh` reference lets the JS GC reclaim it.
 */
async function buildMasterSdf(master: Manifold): Promise<{
  sdf: (p: Vec3) => number;
  geometry: BufferGeometry;
  bvh: MeshBVH;
}> {
  const geometry = await manifoldToBufferGeometry(master);
  const bvh = new MeshBVH(geometry);

  const queryPoint = new Vector3();
  const rayOrigin = new Vector3();
  const rayDir = new Vector3(1, 0, 0);
  const ray = new Ray(rayOrigin, rayDir);

  const sdf = (p: Vec3): number => {
    queryPoint.set(p[0], p[1], p[2]);
    const hit = bvh.closestPointToPoint(queryPoint);
    const distance = hit ? hit.distance : Number.POSITIVE_INFINITY;

    rayOrigin.copy(queryPoint);
    const hits = bvh.raycast(ray, DoubleSide);
    const inside = hits.length % 2 === 1;

    return inside ? distance : -distance;
  };

  return { sdf, geometry, bvh };
}

/**
 * Compute the silicone body + the printable-box parts + associated volumes
 * for the given master Manifold and parameter set.
 *
 * Failure modes:
 *
 * - `parameters.siliconeThickness_mm < 1` → `InvalidParametersError`.
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
  if (!(parameters.printShellThickness_mm > 0) || !Number.isFinite(parameters.printShellThickness_mm)) {
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

    // Step 2a: build SDF over the transformed master.
    const sdfHandles = await buildMasterSdf(transformedMaster);
    const tSdf = performance.now();
    try {
      const edgeLength = resolveEdgeLength(parameters.siliconeThickness_mm);

      // Step 2b: bounds for the levelSet grid. Expand the master's bbox
      // by siliconeThickness + 2 × edgeLength margin. The +2 × edgeLength
      // pad keeps the iso-surface comfortably inside the grid.
      const masterBbox = transformedMaster.boundingBox();
      const pad = parameters.siliconeThickness_mm + 2 * edgeLength;
      const bounds: Box = {
        min: [masterBbox.min[0] - pad, masterBbox.min[1] - pad, masterBbox.min[2] - pad],
        max: [masterBbox.max[0] + pad, masterBbox.max[1] + pad, masterBbox.max[2] + pad],
      };

      // Step 2c: outer silicone shell via levelSet. `level = -siliconeThickness`
      // outsets the master by that distance.
      const shell = toplevel.Manifold.levelSet(
        sdfHandles.sdf,
        bounds,
        edgeLength,
        -parameters.siliconeThickness_mm,
      );
      const tShell = performance.now();
      try {
        assertManifold(shell, 'silicone outer shell (post-levelSet)');

        // Step 3: carve the cavity. `difference` is guaranteed-manifold
        // on two manifold inputs (ADR-002). The result is the SINGLE
        // silicone body we return — no horizontal split in Wave A.
        const silicone = toplevel.Manifold.difference([shell, transformedMaster]);
        const tCavity = performance.now();
        let printableBoxParts;
        try {
          assertManifold(silicone, 'silicone body (shell − master)');

          // Step 4 (Wave-A): build the printable-box parts. We read the
          // silicone body's AABB directly — no split-halves to unify
          // bboxes from. `buildPrintableBox` is synchronous.
          const shellBbox = silicone.boundingBox();
          try {
            printableBoxParts = buildPrintableBox(toplevel, shellBbox, parameters);
          } catch (err) {
            silicone.delete();
            throw err;
          }
          const tPrintable = performance.now();

          // Step 5: volumes. With sprue + vent channels removed, the
          // resin pour volume equals the master's volume exactly. Tests
          // pin the identity at 1e-9 relative; kernel float noise is
          // the only source of drift.
          const siliconeVolume_mm3 = silicone.volume();
          const resinVolume_mm3 = master.volume();
          const printableVolume_mm3 = printableBoxParts.printableVolume_mm3;

          console.debug(
            `[generateSiliconeShell] step timings (ms): ` +
              `transform=${(tTransform - t0).toFixed(1)} ` +
              `sdf-build=${(tSdf - tTransform).toFixed(1)} ` +
              `levelset=${(tShell - tSdf).toFixed(1)} ` +
              `cavity=${(tCavity - tShell).toFixed(1)} ` +
              `printable-box=${(tPrintable - tCavity).toFixed(1)} ` +
              `total=${(tPrintable - t0).toFixed(1)} ` +
              `(edgeLength=${edgeLength.toFixed(2)} mm, ` +
              `sideCount=${parameters.sideCount})`,
          );
          console.info(
            `[generateSiliconeShell] silicone=${siliconeVolume_mm3.toFixed(1)} mm³, ` +
              `resin=${resinVolume_mm3.toFixed(1)} mm³, ` +
              `printable=${printableVolume_mm3.toFixed(1)} mm³ ` +
              `(siliconeThickness=${parameters.siliconeThickness_mm} mm, ` +
              `printShellThickness=${parameters.printShellThickness_mm} mm, ` +
              `sideCount=${parameters.sideCount}, ` +
              `total=${(tPrintable - t0).toFixed(1)} ms)`,
          );

          return {
            silicone,
            basePart: printableBoxParts.basePart,
            sideParts: printableBoxParts.sideParts,
            topCapPart: printableBoxParts.topCapPart,
            siliconeVolume_mm3,
            resinVolume_mm3,
            printableVolume_mm3,
          };
        } catch (err) {
          // silicone is released inside the `buildPrintableBox`-throw
          // branch already; on any other throw here, nothing is owned
          // by the result yet — safe to bail.
          throw err;
        }
      } finally {
        shell.delete();
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
