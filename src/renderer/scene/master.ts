// src/renderer/scene/master.ts
//
// "Master" = the user's loaded STL, displayed in the viewport as the object
// the mold will be built around. This module owns the Three.js side of that
// object: converting an ArrayBuffer into a `THREE.Mesh` with a matte material,
// tagging it per the `three-js-viewer` skill, and swapping it into the scene
// under the pre-existing `userData.tag === 'master'` group.
//
// Kernel integration (post-CSP-widen):
//   The locked renderer CSP now includes `'wasm-unsafe-eval'` (see
//   `src/renderer/index.html` and `.claude/skills/desktop-app-shell/SKILL.md`),
//   which permits `manifold-3d`'s WASM kernel to instantiate in the renderer.
//   Per ADR-002 the kernel is the single source of truth for geometry:
//   - `loadStl(buffer)` parses the STL and returns `{ geometry, manifold }`
//     with an automatic repair pass (silent repair is surfaced via a console
//     warning inside `bufferGeometryToManifold`).
//   - `meshVolume(manifold)` returns the watertight volume in mm³, matching
//     the manifold-3d `volume()` API — deterministic cross-platform.
//   - The display mesh's `BufferGeometry` is derived from the repaired
//     manifold via `manifoldToBufferGeometry`, so the rendered mesh is
//     guaranteed to match what downstream booleans / offsets will consume.
//   We deliberately do NOT hold onto the `Manifold` here; we `.delete()` it
//   before returning to release WASM memory. Future PRs that need the live
//   manifold (booleans, offsets, slicing) will rework the lifecycle then.
//
// Swap semantics:
//   - At most one master is live at a time. `setMaster` disposes the previous
//     mesh (geometry + material) before adding the new one. The Master GROUP
//     itself is never re-added — we always reuse whatever createScene() put
//     there, so children like lights are unaffected and tags stay stable.

import {
  Box3,
  Mesh,
  MeshStandardMaterial,
  type Scene,
} from 'three';

import { loadStl } from '@/geometry/loadStl';
import { manifoldToBufferGeometry } from '@/geometry/adapters';
import { meshVolume } from '@/geometry/volume';

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
 * Result of `setMaster`. `mesh` is live in the scene graph (callers should
 * not add it again). `volume_mm3` is the watertight volume reported by
 * manifold-3d's kernel (ADR-002); `bbox` is the world-space AABB of
 * `mesh.geometry` and is what `frameToBox3` should consume to frame the
 * camera.
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

  // Hand off to the geometry kernel. `loadStl` produces both the parsed
  // `BufferGeometry` and the paired `Manifold` (repaired by the kernel).
  // We use the manifold's watertight volume and a BufferGeometry derived
  // from the manifold so the rendered mesh matches what a downstream
  // boolean/offset would consume — no "what you see isn't what gets cut"
  // divergence.
  const loaded = await loadStl(buffer);

  let volume_mm3: number;
  let displayGeometry;
  try {
    volume_mm3 = meshVolume(loaded.manifold);
    displayGeometry = await manifoldToBufferGeometry(loaded.manifold);
  } finally {
    // Release the WASM-backed manifold as soon as we've extracted what we
    // need. Keeping it alive across renders would leak WASM heap memory on
    // every Open STL. Future PRs that need the live manifold (booleans,
    // offsets) will have to rework this lifecycle.
    loaded.manifold.delete();
    // The parsed `loaded.geometry` is the three-js-side parse result from
    // the STL loader; we don't attach it to the scene (we use the
    // manifold-derived `displayGeometry` instead), so release its VBO too.
    loaded.geometry.dispose();
  }

  if (
    !displayGeometry.hasAttribute('position') ||
    displayGeometry.getAttribute('position').count === 0
  ) {
    displayGeometry.dispose();
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
  const mesh = new Mesh(displayGeometry, material);
  mesh.userData['tag'] = MASTER_MESH_TAG;
  // No scale / rotation / translation — scene is mm-native and we never
  // apply renderer-layer scaling (locked convention in CLAUDE.md).
  group.add(mesh);

  // World-space AABB. Mesh has identity transform so geometry AABB ==
  // world AABB; clone so callers can mutate without side effects.
  displayGeometry.computeBoundingBox();
  const bbox = new Box3();
  if (displayGeometry.boundingBox) {
    bbox.copy(displayGeometry.boundingBox);
  }

  return { mesh, volume_mm3, bbox };
}
