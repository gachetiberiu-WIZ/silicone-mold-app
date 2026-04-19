// src/renderer/scene/picking.ts
//
// BVH-accelerated face picking for the Master mesh.
//
// `three-mesh-bvh` ships three monkey-patches that, once installed,
// route all `Mesh.raycast` calls through a precomputed bounds tree.
// ADR-002 locks `three-mesh-bvh` as the single interactive-picking
// library; issue #32's BVH-setup reminder repeats the pattern.
//
// The patches are global and idempotent — we install them once at
// module load. Calling `installAcceleratedRaycast()` more than once
// is safe; the implementation short-circuits on subsequent calls.
//
// Per-mesh lifecycle:
//
//   `prepareMeshForPicking(mesh)`   — build the BVH (`computeBoundsTree`)
//                                     on the mesh's geometry.
//   `releaseMeshPicking(mesh)`      — dispose the BVH. Called from the
//                                     master-teardown path in `master.ts`
//                                     so a reloaded STL doesn't leak
//                                     a stale tree.
//
// Picking:
//
//   `pickFaceUnderPointer(event, camera, mesh)` — projects the pointer
//                                                 event into a world-
//                                                 space ray, raycasts
//                                                 against the BVH-backed
//                                                 mesh, and returns the
//                                                 hit + world-normal or
//                                                 `null` if the cursor
//                                                 missed. Works on either
//                                                 a `PointerEvent` from
//                                                 the canvas or a plain
//                                                 `{clientX, clientY}`
//                                                 shape (useful for tests
//                                                 that dispatch synthetic
//                                                 events).

import {
  BufferGeometry,
  Mesh,
  type PerspectiveCamera,
  Raycaster,
  Vector2,
  type Vector3,
} from 'three';
import {
  acceleratedRaycast,
  computeBoundsTree,
  disposeBoundsTree,
} from 'three-mesh-bvh';

import { localNormalToWorld } from './layFlat';

/** Module-scope flag — patches are global and only safe to install once. */
let patchesInstalled = false;

/**
 * Install the three `three-mesh-bvh` monkey-patches required for accelerated
 * raycasting: `Mesh.raycast` + `BufferGeometry.{compute,dispose}BoundsTree`.
 *
 * Idempotent. Called automatically by `prepareMeshForPicking` — callers
 * rarely need to invoke it directly, but it's exported for test setup.
 */
export function installAcceleratedRaycast(): void {
  if (patchesInstalled) return;
  // `any`-casts here because `three-mesh-bvh`'s typing augments prototypes
  // but we install at runtime without module augmentation to keep the
  // types simple. Safe: the cast target is the method slot we're patching.
  (Mesh.prototype as unknown as { raycast: typeof acceleratedRaycast }).raycast =
    acceleratedRaycast;
  (
    BufferGeometry.prototype as unknown as {
      computeBoundsTree: typeof computeBoundsTree;
    }
  ).computeBoundsTree = computeBoundsTree;
  (
    BufferGeometry.prototype as unknown as {
      disposeBoundsTree: typeof disposeBoundsTree;
    }
  ).disposeBoundsTree = disposeBoundsTree;
  patchesInstalled = true;
}

/**
 * Build a bounds tree (BVH) on `mesh.geometry` so subsequent
 * `raycaster.intersectObject(mesh)` calls are O(log N) instead of O(N).
 *
 * Calls `installAcceleratedRaycast()` transitively, so a caller that only
 * imports this function gets both the patches and the per-mesh tree.
 *
 * Re-entrant: if a tree already exists on the geometry, it's disposed
 * first and a fresh one is built. This matches the lifecycle in
 * `master.ts`: every new STL gets a new bounds tree, the previous tree
 * is released.
 */
export function prepareMeshForPicking(mesh: Mesh): void {
  installAcceleratedRaycast();
  const geom = mesh.geometry as BufferGeometry & {
    boundsTree?: unknown;
    computeBoundsTree?: () => void;
    disposeBoundsTree?: () => void;
  };
  if (geom.boundsTree && geom.disposeBoundsTree) {
    geom.disposeBoundsTree();
  }
  if (geom.computeBoundsTree) {
    geom.computeBoundsTree();
  }
}

/**
 * Release the BVH attached to `mesh.geometry`, if any. Idempotent:
 * safe to call on meshes that never had a tree installed.
 *
 * Call this from the disposal path when a master mesh is swapped out —
 * see `disposeMesh` in `master.ts`.
 */
export function releaseMeshPicking(mesh: Mesh): void {
  const geom = mesh.geometry as BufferGeometry & {
    boundsTree?: unknown;
    disposeBoundsTree?: () => void;
  };
  if (geom.boundsTree && geom.disposeBoundsTree) {
    geom.disposeBoundsTree();
  }
}

/** Result of a successful face pick. */
export interface PickResult {
  /** Index of the picked triangle in the mesh's BufferGeometry. */
  readonly faceIndex: number;
  /** World-space hit point. */
  readonly point: Vector3;
  /** World-space face normal (unit length). */
  readonly worldNormal: Vector3;
  /** Mesh-local face normal (unit length). */
  readonly localNormal: Vector3;
}

/**
 * Pointer-like shape we accept as input. We don't need the full
 * `PointerEvent` interface — just the client coordinates. Using a
 * structural type means test harnesses can pass plain objects.
 */
export interface PointerLike {
  readonly clientX: number;
  readonly clientY: number;
}

/**
 * Raycast the pointer against `mesh`, returning the closest hit or `null`.
 *
 * Coordinate math:
 *   - Convert `(clientX, clientY)` relative to `canvas.getBoundingClientRect()`
 *     into normalised device coordinates in [-1, 1].
 *   - `Raycaster.setFromCamera(ndc, camera)` then emits a world-space ray.
 *   - `intersectObject(mesh, recursive=false)` returns hits sorted by
 *     distance; we take the first.
 *
 * Normal math:
 *   - Three.js populates `intersection.face.normal` with the face's
 *     mesh-LOCAL normal. For the lay-flat math we need the WORLD normal,
 *     which is a transform via the mesh's normal matrix. `layFlat.ts`
 *     owns that conversion (`localNormalToWorld`).
 */
export function pickFaceUnderPointer(
  event: PointerLike,
  canvas: HTMLCanvasElement,
  camera: PerspectiveCamera,
  mesh: Mesh,
): PickResult | null {
  const rect = canvas.getBoundingClientRect();
  // Guard against unmounted canvas (0x0) — no valid NDC possible.
  if (rect.width <= 0 || rect.height <= 0) return null;

  const ndc = new Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    // NDC Y is inverted: canvas top is +1, bottom is -1.
    -(((event.clientY - rect.top) / rect.height) * 2 - 1),
  );

  const raycaster = new Raycaster();
  raycaster.setFromCamera(ndc, camera);

  const hits = raycaster.intersectObject(mesh, /* recursive */ false);
  if (hits.length === 0) return null;

  const hit = hits[0]!;
  if (!hit.face) return null;
  const faceIndex = typeof hit.faceIndex === 'number' ? hit.faceIndex : -1;
  if (faceIndex < 0) return null;

  const localNormal = hit.face.normal.clone().normalize();
  const worldNormal = localNormalToWorld(mesh, localNormal);

  return {
    faceIndex,
    point: hit.point.clone(),
    worldNormal,
    localNormal,
  };
}
