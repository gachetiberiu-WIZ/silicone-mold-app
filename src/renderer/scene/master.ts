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
//
// Manifold lifetime (Phase 3c, issue #37 — silicone-shell generator):
//   `setMaster` now KEEPS the Manifold alive past return. It is cached on the
//   Master group's `userData[MASTER_MANIFOLD_KEY]` and lives until the next
//   `setMaster` call (which disposes the previous Manifold before replacing
//   it) or until `disposeMaster(scene)` is invoked during viewport teardown.
//
//   Rationale: the silicone-shell generator (`generateSiliconeShell` in
//   `src/geometry/generateMold.ts`) needs the master Manifold as input, and
//   the generate button is a user-driven action with no strict upper bound
//   on delay after load — re-parsing the STL on every Generate click would
//   needlessly burn 50–500 ms on anything above a trivial mesh. Caching on
//   the Master group keeps ownership colocated with the scene node the
//   Manifold describes, so eviction is trivially hooked into the existing
//   "previous master → swap" lifecycle in this module.
//
//   WASM-memory invariant: at most ONE master Manifold is live at a time.
//   `setMaster` disposes the previous one before installing the new one;
//   `disposeMaster` is idempotent and safe to call on an empty group.
//
// Swap semantics:
//   - At most one master is live at a time. `setMaster` disposes the previous
//     mesh (geometry + material) before adding the new one. The Master GROUP
//     itself is never re-added — we always reuse whatever createScene() put
//     there, so children like lights are unaffected and tags stay stable.

import { Box3, Mesh, MeshStandardMaterial, Vector3, type Scene } from 'three';
import type { Manifold } from 'manifold-3d';

import { loadStl } from '@/geometry/loadStl';
import { manifoldToBufferGeometry } from '@/geometry/adapters';
import { meshVolume } from '@/geometry/volume';
import { prepareMeshForPicking, releaseMeshPicking } from './picking';

/**
 * Pre-existing master-group tag placed by `createScene()`. We look the group
 * up by this tag each call so we don't tightly couple to scene-build order.
 */
const MASTER_GROUP_TAG = 'master';

/** Per-mesh tag on the actual STL mesh node. Matches the viewer skill. */
const MASTER_MESH_TAG = 'master';

/**
 * `userData` key used to stash the live master Manifold on the Master group.
 * Exported so `getMasterManifold` / `disposeMaster` — and future callers that
 * need direct access (e.g. the silicone-shell generator) — share a single
 * canonical key. Do not collide with this name elsewhere on the group's
 * userData.
 */
export const MASTER_MANIFOLD_KEY = 'masterManifold';

/**
 * `userData` key that holds the mesh-LOCAL AABB of the current master at
 * the moment it was loaded — i.e. BEFORE any group-level transforms
 * (auto-center, lay-flat rotation, dimensions-panel scale) were applied.
 * The Dimensions panel (issue #79) reads this to compute user-visible mm
 * readouts as `nativeBbox × scale[axis]`. The stored `Box3` is a clone —
 * callers can safely hold the reference across master swaps without
 * observing later mutation.
 *
 * Lifetime: set inside `setMaster` for every successful load, cleared
 * inside `disposeMaster` + replaced inside `setMaster` before adding the
 * new mesh. Consumers should fetch via `getNativeBbox(scene)` instead of
 * reading this key directly.
 */
export const MASTER_NATIVE_BBOX_KEY = 'masterNativeBbox';

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
  // Release the three-mesh-bvh bounds tree first. `disposeBoundsTree` is a
  // no-op when no tree was ever built, so this is safe to call on meshes
  // loaded by earlier code paths that didn't install picking.
  releaseMeshPicking(mesh);
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
 * manifold-3d's kernel (ADR-002).
 *
 * `bbox` is the **world-space** AABB, i.e. the mesh's geometry-local AABB
 * translated by the Master group's auto-centering offset. This is what
 * `frameToBox3` should consume — framing the mesh-local AABB would put the
 * origin grid + axes gizmo off-camera (see issue #25).
 *
 * `offset` is the translation that `setMaster` applied to the Master group
 * so the mesh sits "on the bed" (min-Y on Y=0) and centered on X=0/Z=0.
 * Internal `BufferGeometry` vertex coords are UNCHANGED; the offset lives
 * purely on the Group's transform — downstream booleans / offsets / STL
 * export therefore keep the user's original coordinates. Future UI that
 * needs to display user-space coords (coord picker, dimension readouts)
 * can subtract this offset from a world-space point.
 *
 * `manifold` is the live manifold-3d handle corresponding to `mesh`. Ownership
 * stays with the Master group (we cache it on `group.userData`) — callers
 * must NOT `.delete()` it. It is valid until the next `setMaster` call or
 * until `disposeMaster(scene)` runs. See file header for the lifetime
 * contract and the rationale for keeping it alive.
 */
export interface MasterResult {
  readonly mesh: Mesh;
  readonly volume_mm3: number;
  readonly bbox: Box3;
  readonly offset: Vector3;
  readonly manifold: Manifold;
  /**
   * Tri-count delta around the manifold-3d construction call (issue #64).
   * Zero when the STL was already a watertight 2-manifold; positive when
   * the kernel silently repaired non-manifold input. Surfaced here so the
   * `loadMasterFromBuffer` path in `main.ts` can fire a notice-level toast
   * ("Repaired non-manifold STL on load...") without reaching back into
   * the geometry adapter layer.
   */
  readonly repairedTriCount: number;
}

/**
 * Internal helper: dispose whatever Manifold is currently cached on a Master
 * group and clear the slot. Idempotent. Used by both `setMaster` (before
 * installing a new master) and `disposeMaster` (on viewport teardown).
 *
 * `.delete()` releases the underlying WASM heap allocation. Dropping the JS
 * reference without calling it would leak — Emscripten handles have no
 * finaliser.
 */
function disposeCachedManifold(group: NonNullable<Mesh['parent']>): void {
  const cached = group.userData[MASTER_MANIFOLD_KEY] as Manifold | undefined;
  if (cached) {
    try {
      cached.delete();
    } catch (err) {
      // Non-fatal — a double-dispose / already-deleted handle shouldn't
      // prevent us from proceeding. Log so leaks / double-frees still
      // surface in dev.
      console.warn('[master] disposing cached Manifold threw:', err);
    }
    delete group.userData[MASTER_MANIFOLD_KEY];
  }
}

/**
 * Returns the live master Manifold cached on the scene's Master group, or
 * `null` if no master is currently loaded. This is the read-side API for the
 * silicone-shell generator and any other geometry op that needs direct
 * Manifold access outside the load path.
 *
 * Caller must NOT `.delete()` the returned handle — ownership stays with the
 * Master group per the lifetime contract documented at the top of this file.
 */
export function getMasterManifold(scene: Scene): Manifold | null {
  const group = findMasterGroup(scene);
  if (!group) return null;
  const cached = group.userData[MASTER_MANIFOLD_KEY] as Manifold | undefined;
  return cached ?? null;
}

/**
 * Returns a CLONE of the native (mesh-local, pre-transform) AABB of the
 * currently-loaded master. Used by the Dimensions panel (issue #79) to
 * compute `nativeBbox × scale[axis]` mm readouts live as the user edits
 * the scale controls.
 *
 * Returns `null` when no master is loaded (the panel renders a placeholder
 * in that state). Always returns a fresh `Box3`, so consumers that mutate
 * the result — e.g. `bbox.getSize(new Vector3())` — don't corrupt the
 * cached snapshot.
 */
export function getNativeBbox(scene: Scene): Box3 | null {
  const group = findMasterGroup(scene);
  if (!group) return null;
  const cached = group.userData[MASTER_NATIVE_BBOX_KEY] as Box3 | undefined;
  if (!cached) return null;
  return cached.clone();
}

/**
 * Tear down any live master Manifold and its cache slot. Idempotent and safe
 * to call on a scene that never loaded a master. Intended for viewport
 * disposal; `setMaster` handles the per-swap case internally.
 */
export function disposeMaster(scene: Scene): void {
  const group = findMasterGroup(scene);
  if (!group) return;
  disposeCachedManifold(group);
  // Drop the native-bbox cache too — it's a plain Box3, no WASM resources
  // to release, but leaving it on a disposed group would let stale data
  // leak across a viewport remount.
  delete group.userData[MASTER_NATIVE_BBOX_KEY];
}

/**
 * Parse `buffer` as an STL, build a Three.Mesh, and place it as the active
 * master under the scene's pre-existing Master group. Any previous master
 * mesh under that group is disposed first — only one master is live at a
 * time, as required by the issue ("no mesh accumulation").
 *
 * Auto-centering (issue #25): after computing the mesh's local AABB, this
 * function applies a translation to the **Master group** (not the geometry
 * or the manifold) so the mesh sits "on the bed":
 *
 *   group.position.x = -bbox.center.x    (centered on X)
 *   group.position.y = -bbox.min.y       (lowest point on Y=0)
 *   group.position.z = -bbox.center.z    (centered on Z)
 *
 * The `BufferGeometry.attributes.position` values are NEVER mutated. This
 * matters: Phase 3b mold-gen, booleans, offsets, and STL export all keep
 * the user's original coordinates — the translation is a display-layer
 * convenience only. `.position.set(...)` is absolute, so a second load
 * fully replaces the offset (no accumulation).
 *
 * Does NOT frame the camera — that's `viewport.setMaster` / `frameToBox3`'s
 * job. We return a **world-space** bbox (local bbox + offset) so that the
 * camera framing reflects where the mesh actually sits post-translation,
 * which in turn keeps the origin grid + axes gizmo in frame.
 *
 * @throws If the scene is missing its `master` group, or if the STL has no
 *   vertex data.
 */
export async function setMaster(scene: Scene, buffer: ArrayBuffer): Promise<MasterResult> {
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

  // Extract volume + derive the display geometry while the manifold is live.
  // We deliberately do NOT dispose the manifold here — per the file-header
  // lifetime contract, the Manifold is kept alive for the silicone-shell
  // generator (issue #37). It's handed off to the group's userData below.
  // If either derivation throws we must still release the manifold (and the
  // STL parse output) to avoid leaking WASM memory.
  let volume_mm3: number;
  let displayGeometry;
  try {
    volume_mm3 = meshVolume(loaded.manifold);
    displayGeometry = await manifoldToBufferGeometry(loaded.manifold);
  } catch (err) {
    loaded.manifold.delete();
    loaded.geometry.dispose();
    throw err;
  }
  // The parsed `loaded.geometry` is the three-js-side parse result from the
  // STL loader; we don't attach it to the scene (we use the manifold-derived
  // `displayGeometry` instead), so release its VBO regardless of outcome.
  loaded.geometry.dispose();

  if (
    !displayGeometry.hasAttribute('position') ||
    displayGeometry.getAttribute('position').count === 0
  ) {
    displayGeometry.dispose();
    loaded.manifold.delete();
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

  // Release the previous master's WASM-backed Manifold (if any) before
  // installing the new one. At most one master Manifold is ever alive —
  // this is the single eviction point that enforces that invariant.
  disposeCachedManifold(group);

  // Reset rotation before adding the new mesh. A previous `setMaster` could
  // have composed a lay-flat rotation onto the group via the Place-on-face
  // UI (issue #32); without this line, a second Open STL would inherit the
  // prior orientation — which is jarring and would fail the issue's AC
  // ("Load second STL after a lay-flat rotation → new master loads at
  // identity orientation, not inheriting stale quaternion").
  group.quaternion.identity();
  // Issue #79 — same story for per-axis scale. A previous `setMaster` may
  // have run with the Dimensions panel scale != (1,1,1). The dimensions
  // store is reset to defaults by the entrypoint on every new load, but
  // the scene-graph side has to mirror that: without this line the new
  // master inherits stale scale until the first dimensions event fires.
  group.scale.set(1, 1, 1);

  const material = createMasterMaterial();
  const mesh = new Mesh(displayGeometry, material);
  mesh.userData['tag'] = MASTER_MESH_TAG;
  // No scale / rotation / translation — scene is mm-native and we never
  // apply renderer-layer scaling (locked convention in CLAUDE.md).
  group.add(mesh);

  // Build the three-mesh-bvh bounds tree on the new geometry so face
  // picking (issue #32) is O(log N). This must happen AFTER the mesh is
  // parented (the bounds tree only needs the geometry, but we keep the
  // ordering obvious) and BEFORE any picking / raycasting by sibling
  // code. Matched by `releaseMeshPicking(mesh)` inside `disposeMesh`.
  prepareMeshForPicking(mesh);

  // Mesh-local AABB (the raw geometry bounds, before any group transform).
  // This is the input to the auto-center calculation below.
  displayGeometry.computeBoundingBox();
  const localBbox = new Box3();
  if (displayGeometry.boundingBox) {
    localBbox.copy(displayGeometry.boundingBox);
  }

  // Auto-center on the print bed (issue #25). We translate the Master GROUP
  // so the mesh:
  //   - is centered on the X and Z axes (bbox.center → origin)
  //   - rests on Y=0 with its lowest face (bbox.min.y → 0)
  // Applied on the group, never on the geometry: the vertex buffer must
  // stay STL-faithful so downstream mold-gen + STL export see the user's
  // original coordinates.
  //
  // We use the mesh-local bbox directly (instead of going through
  // `recenterGroup` → `Box3.setFromObject` as the lay-flat path does)
  // because we just reset the group quaternion to identity above. On
  // identity rotation the local bbox equals the world-space bbox
  // bit-identically, and reading it directly avoids the float32 drift
  // that per-vertex world-matrix multiplies introduce on fixtures with
  // large coordinates (e.g. mini-figurine at Y≈1094 → ~1e-4 mm drift).
  //
  // `.set()` is absolute (not additive), which means a second load fully
  // replaces any previous offset — no accumulation across loads.
  const localCenter = new Vector3();
  localBbox.getCenter(localCenter);
  const offset = new Vector3(-localCenter.x, -localBbox.min.y, -localCenter.z);
  group.position.set(offset.x, offset.y, offset.z);
  // Keep the group's world matrices current so subsequent calls that rely
  // on `mesh.getWorldPosition(...)` etc. see the new transform without
  // waiting for the next render tick.
  group.updateMatrixWorld(true);

  // World-space AABB. The mesh has identity local transform, but the
  // group now carries the offset — apply it to the local bbox so callers
  // (notably `frameToBox3`) frame the camera around where the mesh
  // actually sits, not where the raw geometry would have sat. Framing the
  // mesh-local bbox on an off-origin master (e.g. mini-figurine at Y≈1094)
  // would leave the origin grid + axes gizmo off-camera.
  const bbox = localBbox.clone().translate(offset);

  // Install the live Manifold on the group's userData so the silicone-shell
  // generator (and future geometry ops) can retrieve it via
  // `getMasterManifold(scene)`. Ownership is the group's — callers must not
  // `.delete()` the handle; eviction happens via `disposeCachedManifold`
  // above on the next `setMaster`, or via `disposeMaster(scene)` at
  // viewport teardown.
  group.userData[MASTER_MANIFOLD_KEY] = loaded.manifold;

  // Cache the NATIVE (mesh-local, pre-transform) AABB for the Dimensions
  // panel (issue #79). We stash a CLONE so later consumers that mutate
  // the returned bbox — e.g. `getNativeBbox(scene).expandByScalar(...)`
  // for exploratory math — cannot corrupt the cached snapshot. Eviction
  // mirrors the Manifold cache: replaced on the next `setMaster`, cleared
  // on `disposeMaster`.
  group.userData[MASTER_NATIVE_BBOX_KEY] = localBbox.clone();

  return {
    mesh,
    volume_mm3,
    bbox,
    offset,
    manifold: loaded.manifold,
    repairedTriCount: loaded.repairedTriCount,
  };
}
