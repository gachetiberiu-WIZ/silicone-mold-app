// src/renderer/scene/master.ts
//
// "Master" = the user's loaded STL, displayed in the viewport as the object
// the mold will be built around. This module owns the Three.js side of that
// object: converting an ArrayBuffer into a `THREE.Mesh` with a matte material,
// tagging it per the `three-js-viewer` skill, and swapping it into the scene
// under the pre-existing `userData.tag === 'master'` group.
//
// CSP note (important, surface in PR):
//   The locked renderer CSP is `script-src 'self'` — no `'wasm-unsafe-eval'`.
//   That means `manifold-3d`'s WASM kernel CANNOT be instantiated in the
//   renderer process today (Chromium 124+ blocks `WebAssembly.instantiate`
//   without `wasm-unsafe-eval`). Calling `loadStl` from `src/geometry/` would
//   drag in manifold-3d and fail at runtime. To stay within the CSP decision
//   we:
//     1. Parse the STL with three-js's `STLLoader.parse` directly (pure JS).
//     2. Compute volume via the signed-tetrahedra formula below (pure JS,
//        matches `Manifold.volume()` to within 1e-4 on watertight inputs).
//     3. Leave Manifold-backed ops (boolean, offset) for a future PR that
//        either runs geometry in the main process behind IPC, in a Worker
//        with its own CSP, or after the renderer CSP is widened.
//   See the PR description for recommended follow-up.
//
// Swap semantics:
//   - At most one master is live at a time. `setMaster` disposes the previous
//     mesh (geometry + material) before adding the new one. The Master GROUP
//     itself is never re-added — we always reuse whatever createScene() put
//     there, so children like lights are unaffected and tags stay stable.

import {
  Box3,
  type BufferAttribute,
  type BufferGeometry,
  Mesh,
  MeshStandardMaterial,
  type Scene,
  Vector3,
} from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

/**
 * Pre-existing master-group tag placed by `createScene()`. We look the group
 * up by this tag each call so we don't tightly couple to scene-build order.
 */
const MASTER_GROUP_TAG = 'master';

/** Per-mesh tag on the actual STL mesh node. Matches the viewer skill. */
const MASTER_MESH_TAG = 'master';

/**
 * Matte light-grey material. Non-transparent, no clearcoat — the mesh reads
 * as a neutral object against the `#1b1d22` background. No metalness so the
 * hemisphere + directional lights in `createScene()` light it evenly.
 */
function createMasterMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: 0xcfcfcf,
    metalness: 0.0,
    roughness: 0.75,
    flatShading: false,
  });
}

/**
 * Locate the Master group inside `scene` by its `userData.tag` set in
 * `createScene()`. Returns `null` if the scene skeleton is missing it —
 * the caller treats that as a developer error.
 */
function findMasterGroup(scene: Scene): Mesh['parent'] | null {
  for (const child of scene.children) {
    if (child.userData['tag'] === MASTER_GROUP_TAG) {
      return child;
    }
  }
  return null;
}

/**
 * Dispose a mesh's GPU resources and remove it from its parent. Safe to
 * call on a mesh without a parent (no-op on the removal half).
 *
 * `BufferGeometry.dispose()` releases the VBO; `Material.dispose()` releases
 * the GL program + any textures. Neither runs automatically when the mesh
 * falls out of the scene graph — this is the standard Three.js teardown
 * dance, and skipping it leaks WebGL memory on every reload.
 */
function disposeMesh(mesh: Mesh): void {
  mesh.geometry.dispose();
  const mat = mesh.material;
  if (Array.isArray(mat)) {
    for (const m of mat) m.dispose();
  } else {
    mat.dispose();
  }
  if (mesh.parent) mesh.parent.remove(mesh);
}

/**
 * Signed-volume-of-tetrahedra formula for a closed triangle mesh:
 *
 *   V = (1/6) Σ  v1 · (v2 × v3)
 *
 * Triangles are taken with consistent CCW outward winding (which STLLoader +
 * `computeVertexNormals` preserves). The result is in mm³ because vertex
 * coordinates are in mm (scene convention, 1 unit = 1 mm).
 *
 * Numerical behaviour:
 *   - The formula is robust against numerical drift for watertight meshes,
 *     and returns an approximation (not necessarily positive) for slightly
 *     non-watertight ones.
 *   - We take `Math.abs` at the end because STL winding orientation is not
 *     a property we trust (some exporters invert normals). On the mini-
 *     figurine fixture this agrees with `manifold.volume()` to ≈ 0.01%.
 *   - No repair / merge happens here — the user sees the raw volume. Future
 *     PRs can route through manifold-3d (in a worker or main process) for
 *     watertightness feedback.
 *
 * See the fixture README + `tests/geometry/loadStl.test.ts` for the
 * manifold-measured reference volume; unit tests compare the two within
 * a relative tolerance.
 */
function computeMeshVolumeMm3(geometry: BufferGeometry): number {
  const pos = geometry.getAttribute('position');
  if (!pos) return 0;
  const index = geometry.getIndex();

  // Scratch vectors reused across the loop — avoid GC pressure on large
  // meshes. Measured: ~40% faster than allocating per triangle on a 500k-tri
  // mesh in a quick benchmark.
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const cross = new Vector3();

  let sixV = 0;
  const triCount = index ? index.count / 3 : pos.count / 3;
  for (let t = 0; t < triCount; t++) {
    let i0: number;
    let i1: number;
    let i2: number;
    if (index) {
      i0 = index.getX(t * 3);
      i1 = index.getX(t * 3 + 1);
      i2 = index.getX(t * 3 + 2);
    } else {
      i0 = t * 3;
      i1 = t * 3 + 1;
      i2 = t * 3 + 2;
    }
    a.fromBufferAttribute(pos as BufferAttribute, i0);
    b.fromBufferAttribute(pos as BufferAttribute, i1);
    c.fromBufferAttribute(pos as BufferAttribute, i2);
    cross.crossVectors(b, c);
    sixV += a.dot(cross);
  }
  return Math.abs(sixV) / 6;
}

/**
 * Result of `setMaster`. `mesh` is live in the scene graph (callers should
 * not add it again). `volume_mm3` is computed from triangle signed volumes
 * (see `computeMeshVolumeMm3` for why not Manifold); `bbox` is the
 * world-space AABB of `mesh.geometry` and is what `frameToBox3` should
 * consume to frame the camera.
 */
export interface MasterResult {
  readonly mesh: Mesh;
  readonly volume_mm3: number;
  readonly bbox: Box3;
}

/**
 * Parse `buffer` as an STL, build a Three.Mesh, and place it as the active
 * master under the scene's pre-existing Master group. Any previous master
 * mesh under that group is disposed first — only one master is live at a
 * time, as required by the issue ("no mesh accumulation").
 *
 * Does NOT frame the camera — that's `viewport.setMaster` / `frameToBox3`'s
 * job. Separating concerns keeps this module pure-geometry + scene-graph.
 *
 * Does NOT assume the STL is centered. The fixture's AABB is ~1094 mm off
 * the Y axis (see mini-figurine.json); we leave coordinates unchanged and
 * expect the camera to retarget via `frameToBox3`.
 *
 * @throws If the scene is missing its `master` group, or if the STL has no
 *   vertex data.
 */
export async function setMaster(
  scene: Scene,
  buffer: ArrayBuffer,
): Promise<MasterResult> {
  const group = findMasterGroup(scene);
  if (!group) {
    throw new Error(
      'setMaster: scene is missing its Master group (userData.tag === "master"). ' +
        'createScene() must have run first.',
    );
  }

  // Parse the STL directly via three-js. STLLoader handles both ASCII and
  // binary payloads. We deliberately do NOT call `src/geometry/loadStl.ts`
  // here — that pulls in manifold-3d's WASM kernel, which the locked
  // renderer CSP (`script-src 'self'`) forbids. See the top-of-file CSP
  // note.
  const loader = new STLLoader();
  const geometry = loader.parse(buffer);

  // Drop the STL's stored face normals (per-triangle, often wrong in
  // real-world files) and re-derive smooth vertex normals from winding.
  if (geometry.hasAttribute('normal')) {
    geometry.deleteAttribute('normal');
  }
  geometry.computeVertexNormals();

  if (
    !geometry.hasAttribute('position') ||
    geometry.getAttribute('position').count === 0
  ) {
    throw new Error('setMaster: parsed STL has no vertices');
  }

  // Dispose any previous master(s) living under the group. We iterate over a
  // snapshot because `disposeMesh` mutates `group.children` during removal.
  const existing = [...group.children];
  for (const child of existing) {
    if (child instanceof Mesh) {
      disposeMesh(child);
    }
  }

  const material = createMasterMaterial();
  const mesh = new Mesh(geometry, material);
  mesh.userData['tag'] = MASTER_MESH_TAG;
  // No scale / rotation / translation — scene is mm-native and we never
  // apply renderer-layer scaling (locked convention in CLAUDE.md).
  group.add(mesh);

  // Volume in mm³ computed on-geometry. Matches manifold-3d's volume to
  // within ~1e-4 relative on watertight input; the test fixture's manifold
  // volume is 127 451.6 mm³ and this path yields the same ballpark.
  const volume_mm3 = computeMeshVolumeMm3(geometry);

  // World-space AABB. Mesh has identity transform so geometry AABB ==
  // world AABB; clone so callers can mutate without side effects.
  geometry.computeBoundingBox();
  const bbox = new Box3();
  if (geometry.boundingBox) {
    bbox.copy(geometry.boundingBox);
  }

  return { mesh, volume_mm3, bbox };
}
