// src/geometry/adapters.ts
//
// Thin conversion layer between three.js `BufferGeometry` (what Three renders,
// what `three-mesh-bvh` accelerates) and `manifold-3d`'s `Mesh` / `Manifold`
// (the compute representation). Per the `mesh-operations` skill this is the
// *single* place these two representations meet — everything else in the
// app should go through these two functions, never reaching into raw vertex
// arrays across module boundaries.
//
// Design notes:
// - Strip UVs / colors / non-position attributes on the way IN. Manifold only
//   needs positions for our v1 pipeline; re-deriving normals from winding is
//   the pattern the skill mandates ("ignore STL's stored normals").
// - Re-derive normals on the way OUT. Manifold preserves triangle winding so
//   `computeVertexNormals()` yields correct outward-facing normals.
// - Deduplicate positions by exact-coordinate key on the way IN so that we
//   produce a real oriented 2-manifold (not triangle soup). Fixtures are
//   small (≤ 50k tri) so an O(N) string-keyed dedup is fine. If this ever
//   shows up in a profile we swap to a quantised spatial hash; premature
//   optimisation otherwise.
// - `isManifold(m)` lives here because watertightness is a property of the
//   *adapter contract*: a Manifold is "manifold" when the kernel reports
//   `status() === 'NoError'` AND it is non-empty. The mesh-operations skill
//   calls `manifold.isManifold()` for short — we provide that semantic here
//   as a free function since the v3.4.1 JS API exposes `status()` / `isEmpty()`
//   rather than a boolean predicate.

import { BufferAttribute, BufferGeometry } from 'three';
import type { Manifold, ManifoldToplevel, Mesh } from 'manifold-3d';
import { initManifold } from './initManifold';

/**
 * Watertight-ness predicate. Returns `true` iff the manifold reports no error
 * status AND contains at least one triangle. See the `mesh-operations` skill:
 * every mesh returned by our geometry API must satisfy this before going
 * anywhere near an STL export or a Boolean op.
 */
export function isManifold(m: Manifold): boolean {
  return m.status() === 'NoError' && !m.isEmpty();
}

/**
 * Build a `Mesh` object (manifold-3d's MeshGL input shape) from a three.js
 * `BufferGeometry`. Used by `bufferGeometryToManifold` and also reusable by
 * any caller that wants to hand Manifold a mesh without the full wrapping.
 *
 * Behaviour:
 * - Reads `attributes.position` only. UVs, colors, custom attrs are dropped.
 * - Handles both indexed and non-indexed geometries. If non-indexed, we
 *   deduplicate vertices by exact float key so manifold-3d sees shared
 *   vertices across triangles (required for manifoldness).
 * - `numProp` is fixed at 3 (just x/y/z) — we pass no extra channels.
 */
function bufferGeometryToManifoldMesh(
  geometry: BufferGeometry,
  toplevel: ManifoldToplevel,
): Mesh {
  const posAttr = geometry.getAttribute('position');
  if (!posAttr) {
    throw new Error(
      'bufferGeometryToManifold: BufferGeometry has no position attribute',
    );
  }
  if (posAttr.itemSize !== 3) {
    throw new Error(
      `bufferGeometryToManifold: expected itemSize=3 on position attribute, got ${posAttr.itemSize}`,
    );
  }

  const index = geometry.getIndex();

  // Indexed case: positions already deduplicated; trust the index buffer.
  if (index) {
    const numVerts = posAttr.count;
    const vertProperties = new Float32Array(numVerts * 3);
    for (let v = 0; v < numVerts; v++) {
      vertProperties[v * 3] = posAttr.getX(v);
      vertProperties[v * 3 + 1] = posAttr.getY(v);
      vertProperties[v * 3 + 2] = posAttr.getZ(v);
    }
    const triVerts = new Uint32Array(index.count);
    for (let i = 0; i < index.count; i++) triVerts[i] = index.getX(i);
    return new toplevel.Mesh({
      numProp: 3,
      vertProperties,
      triVerts,
    });
  }

  // Non-indexed (triangle soup) — e.g. STLLoader output. Deduplicate by
  // exact-coordinate key. Any tolerance-based merge is Manifold's job at
  // construction time (it collapses verts within its own epsilon).
  const triCount = posAttr.count / 3;
  if (!Number.isInteger(triCount)) {
    throw new Error(
      `bufferGeometryToManifold: non-indexed geometry vertex count ${posAttr.count} is not a multiple of 3`,
    );
  }
  const vertIndex = new Map<string, number>();
  const vertsFlat: number[] = [];
  const triVerts = new Uint32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    for (let v = 0; v < 3; v++) {
      const srcIdx = t * 3 + v;
      const x = posAttr.getX(srcIdx);
      const y = posAttr.getY(srcIdx);
      const z = posAttr.getZ(srcIdx);
      const key = `${x},${y},${z}`;
      let idx = vertIndex.get(key);
      if (idx === undefined) {
        idx = vertsFlat.length / 3;
        vertsFlat.push(x, y, z);
        vertIndex.set(key, idx);
      }
      triVerts[t * 3 + v] = idx;
    }
  }
  return new toplevel.Mesh({
    numProp: 3,
    vertProperties: new Float32Array(vertsFlat),
    triVerts,
  });
}

/**
 * Extended result of `bufferGeometryToManifoldWithRepair` — the Manifold
 * plus the input / output tri counts so callers can surface the repair
 * delta to the user (issue #64). `repairedTriCount` is the absolute
 * difference (`|input - output|`) and is zero when the input was already
 * manifold.
 */
export interface BufferGeometryToManifoldResult {
  manifold: Manifold;
  /** Tri count of the input BufferGeometry as seen by manifold-3d. */
  inputTriCount: number;
  /** Tri count of the resulting Manifold after construction. */
  outputTriCount: number;
  /**
   * `|inputTriCount - outputTriCount|`. Zero iff the input was already a
   * valid 2-manifold. Positive when manifold-3d collapsed / dropped
   * degenerate triangles on construction — surface this to the user via a
   * notice-level toast (issue #64).
   */
  repairedTriCount: number;
}

/**
 * Convert a three.js `BufferGeometry` to a manifold-3d `Manifold`,
 * returning the Manifold plus tri-count metadata so callers can surface
 * silent-repair events to the user (issue #64).
 *
 * Side effects:
 * - Calls `initManifold()` (module-scope cached) to ensure the WASM kernel
 *   is ready. Safe to call repeatedly.
 * - Logs a tri-count delta warning to the console if Manifold's construction
 *   repaired non-manifold input (see the `mesh-operations` skill's
 *   "Watertightness discipline" section — developers watching the console
 *   keep the old signal; the structured return value is what the UI layer
 *   uses to drive the user-visible toast).
 *
 * @returns `{ manifold, inputTriCount, outputTriCount, repairedTriCount }`.
 *   Caller owns `manifold` and must `.delete()` it when done. The result
 *   is not guaranteed non-empty — check `isManifold(manifold)` if you
 *   need watertightness confirmation.
 */
export async function bufferGeometryToManifoldWithRepair(
  geometry: BufferGeometry,
): Promise<BufferGeometryToManifoldResult> {
  const toplevel = await initManifold();
  const mesh = bufferGeometryToManifoldMesh(geometry, toplevel);
  const inputTriCount = mesh.triVerts.length / 3;
  const manifold = new toplevel.Manifold(mesh);
  const outputTriCount = manifold.numTri();
  const repairedTriCount = Math.abs(inputTriCount - outputTriCount);
  if (repairedTriCount !== 0) {
    // Surface silent repair to the developer. Non-fatal — a diff of a
    // handful of degenerate triangles is normal even on clean STL files.
    // User-visible surfacing is the caller's job (see `loadStl` + the
    // `loadMasterFromBuffer` path in `main.ts`).
    console.warn(
      `[geometry] manifold-3d repaired non-manifold input: ${inputTriCount} tri → ${outputTriCount} tri (status=${manifold.status()})`,
    );
  }
  return { manifold, inputTriCount, outputTriCount, repairedTriCount };
}

/**
 * Convert a three.js `BufferGeometry` to a manifold-3d `Manifold`.
 *
 * Backwards-compatible wrapper around `bufferGeometryToManifoldWithRepair`
 * that discards the tri-count metadata. Prefer the `WithRepair` variant
 * when you want to surface silent-repair events to the user (issue #64);
 * this thin wrapper is kept for call sites (tests, generateMold's
 * re-ingest path) that only need the Manifold.
 *
 * Side effects identical to `bufferGeometryToManifoldWithRepair`.
 *
 * @returns A fresh `Manifold`. Caller owns it and must `.delete()` when done
 *   to release WASM memory. The return is not guaranteed to be non-empty —
 *   check `isManifold(result)` if you need watertightness confirmation.
 */
export async function bufferGeometryToManifold(
  geometry: BufferGeometry,
): Promise<Manifold> {
  const { manifold } = await bufferGeometryToManifoldWithRepair(geometry);
  return manifold;
}

/**
 * Convert a manifold-3d `Manifold` back into a three.js `BufferGeometry`,
 * ready for renderer / BVH consumption. Re-derives normals from the CCW
 * winding Manifold preserves. STL's per-face stored normals are never trusted.
 *
 * The returned geometry is non-indexed (3 verts × numTri). We could emit an
 * indexed form to halve the memory footprint; hold off until a profile says
 * it matters. Simpler code wins at v1.
 */
export async function manifoldToBufferGeometry(
  manifold: Manifold,
): Promise<BufferGeometry> {
  // Awaiting init is effectively a no-op once warm, but keeps this module's
  // "every public call is safe without a prior explicit init" invariant.
  await initManifold();
  const mesh = manifold.getMesh();
  const numTri = mesh.triVerts.length / 3;

  // Expand to non-indexed positions so Three's BufferGeometry doesn't need
  // an index buffer. 9 floats per triangle.
  const positions = new Float32Array(numTri * 9);
  for (let t = 0; t < numTri; t++) {
    for (let v = 0; v < 3; v++) {
      const vertIdx = mesh.triVerts[t * 3 + v]!;
      const base = vertIdx * mesh.numProp;
      positions[t * 9 + v * 3] = mesh.vertProperties[base]!;
      positions[t * 9 + v * 3 + 1] = mesh.vertProperties[base + 1]!;
      positions[t * 9 + v * 3 + 2] = mesh.vertProperties[base + 2]!;
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  // Re-derive normals — Manifold preserves CCW winding; compute fresh normals.
  geometry.computeVertexNormals();
  return geometry;
}
