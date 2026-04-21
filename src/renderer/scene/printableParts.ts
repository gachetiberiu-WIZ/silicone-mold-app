// src/renderer/scene/printableParts.ts
//
// Scene module owning the N radially-sliced shell pieces (Wave E, issue
// #84, with brim flanges from Wave F) + the printable base slab (Wave
// D). Post-Wave-E this module manages N+1 meshes under the
// `printableParts` group:
//
//   - shell-piece-0 .. shell-piece-{N-1}: one mesh per piece. Each
//     piece translates RADIALLY outward from the master's XZ center on
//     explode. All pieces share the same grey print material color,
//     but each mesh owns its own `MeshStandardMaterial` instance so
//     teardown doesn't need refcount bookkeeping.
//   - base-slab-mesh: single slab, lifts -Y on explode (unchanged from
//     Wave D behaviour).
//
// Radial-explode direction per piece: derived once during install from
// the shell piece's own world-AABB XZ centroid. We compute the vector
// `(piece.xzCentroid - master.xzCenter)` and normalise it; the outward
// tween target position for piece `i` is
// `(maxRadial, 0, maxRadial_z) * outwardMagnitude_mm`, where
// `outwardMagnitude_mm = max(30, 0.3 * bboxHorizRadius)`. No Y lift
// for shell pieces — the pieces are side-by-side, not stacked.
//
// Per-piece world-space outward direction is captured per install so
// it stays stable across mid-tween reversals. The master's XZ center
// is passed in by the caller (viewport layer) — it's the same center
// used by the slicer to build the cut planes.
//
// Ownership handoff:
//
//   The caller passes an array `shellPieces: Manifold[]` + a single
//   `basePart: Manifold`. From the moment `setPrintableParts` returns,
//   THIS MODULE owns every lifetime — the caller must NOT `.delete()`
//   them again. Eviction happens on the next `setPrintableParts` call,
//   on any `clearPrintableParts` call, and on viewport teardown.
//
// Frame alignment:
//
//   `generateSiliconeShell` applies the Master group's world matrix to
//   the master Manifold INSIDE the generator, so BOTH the returned
//   shell-piece and base-slab Manifolds are ALREADY in the world
//   frame. We render the meshes at world origin with no group
//   transform.
//
// Test-hook surface:
//
//   Module-level getters: `arePrintablePartsVisible`,
//   `isPrintableExplodedIdle`, `hasPrintableParts`. Exposed on the
//   viewport handle. Read-only.

import {
  Box3,
  Group,
  Mesh,
  MeshStandardMaterial,
  Vector3,
  type Scene,
} from 'three';
import type { Manifold } from 'manifold-3d';

import { manifoldToBufferGeometry } from '@/geometry/adapters';

/** Tag on the printable-parts group created in `scene/index.ts`. */
const PRINTABLE_PARTS_GROUP_TAG = 'printableParts';

/** Tag prefix on each shell-piece mesh child — suffixed by piece index. */
const SHELL_PIECE_MESH_TAG_PREFIX = 'shell-piece-';
/** Tag on the base-slab mesh child. */
const BASE_SLAB_MESH_TAG = 'base-slab-mesh';

/**
 * `userData` keys where we cache the Manifolds so teardown can release
 * them even if the Mesh nodes have been removed via another code path.
 * Exported so viewport-level dispose can read the same slots.
 *
 * Shell pieces are cached as an ARRAY under a single key so the number
 * of pieces (2, 3, or 4) doesn't leak into the key naming.
 */
export const SHELL_PIECES_MANIFOLD_KEY = 'shellPiecesManifolds';
export const BASE_SLAB_MANIFOLD_KEY = 'baseSlabManifold';

/** Default radial exploded-offset floor (mm) for each shell piece. */
const SHELL_EXPLODED_OFFSET_FLOOR_MM = 30;
const SHELL_EXPLODED_OFFSET_BBOX_FRACTION = 0.3;

/** Exploded-offset floor (mm) for the slab — drops below master. */
const SLAB_EXPLODED_OFFSET_FLOOR_MM = 30;
const SLAB_EXPLODED_OFFSET_BBOX_FRACTION = 0.2;

/** Tween duration for exploded-view transitions. Matches silicone. */
const EXPLODED_TWEEN_MS = 250;

/** Shape returned by `setPrintableParts`. */
export interface PrintablePartsResult {
  /** Union of every shell-piece AABB + slab AABB. Used to frame the camera. */
  readonly bbox: Box3;
  /** Array of shell-piece meshes in the same order as the input Manifolds. */
  readonly shellMeshes: readonly Mesh[];
  readonly slabMesh: Mesh;
}

/**
 * Per-mesh tween record. Each mesh animates along an INDEPENDENT 3D
 * offset vector set at install time (radial-outward for shell pieces,
 * -Y for the slab); the top-level state record below holds one per
 * mesh so mid-flight reversals can keep the N+1 tweens in sync.
 */
interface MeshTween {
  mesh: Mesh;
  /**
   * World-space offset vector applied at fraction=1. For shell pieces
   * this is radial-outward (x,0,z); for the slab it is (0,-mag,0).
   * Captured at install so rotations between install and explode
   * don't change the direction.
   */
  offset: Vector3;
  currentFraction: number;
  targetFraction: number;
  tweenStart_ms: number | null;
  tweenStartFraction: number;
  rafId: number;
  material: MeshStandardMaterial;
}

/**
 * Internal record stashed on the printable-parts group's `userData`.
 * Holds all N+1 tweens so `setPrintablePartsExplodedView` can update
 * without re-traversing the scene graph.
 */
interface PrintableState {
  shellPieces: MeshTween[];
  slab: MeshTween;
}

/** `userData` key on the printable-parts group where the state lives. */
const PRINTABLE_STATE_KEY = 'printablePartsState';

/**
 * Locate the printable-parts group in `scene` by its `userData.tag`.
 * Returns `null` if the scene skeleton is missing the group.
 */
function findGroup(scene: Scene): Group | null {
  for (const child of scene.children) {
    if (
      child.userData['tag'] === PRINTABLE_PARTS_GROUP_TAG &&
      child instanceof Group
    ) {
      return child;
    }
  }
  return null;
}

function getState(group: Group): PrintableState | null {
  const s = group.userData[PRINTABLE_STATE_KEY] as PrintableState | undefined;
  return s ?? null;
}

function setState(group: Group, state: PrintableState | null): void {
  if (state === null) {
    delete group.userData[PRINTABLE_STATE_KEY];
  } else {
    group.userData[PRINTABLE_STATE_KEY] = state;
  }
}

/**
 * Remove a mesh from its parent, dispose GPU geometry + material.
 */
function disposeMesh(mesh: Mesh, material: MeshStandardMaterial): void {
  mesh.geometry.dispose();
  material.dispose();
  if (mesh.parent) mesh.parent.remove(mesh);
}

/**
 * Release every cached Manifold under the shell-pieces userData slot
 * and clear the slot. Idempotent on an empty / missing slot.
 */
function disposeCachedShellPieces(group: Group): void {
  const cached = group.userData[SHELL_PIECES_MANIFOLD_KEY] as
    | Manifold[]
    | undefined;
  if (cached) {
    for (const m of cached) {
      try {
        m.delete();
      } catch (err) {
        console.warn(
          `[printableParts] disposing cached shell-piece Manifold threw:`,
          err,
        );
      }
    }
    delete group.userData[SHELL_PIECES_MANIFOLD_KEY];
  }
}

/**
 * Release the cached base-slab Manifold on the group's userData and
 * clear the slot. Idempotent.
 */
function disposeCachedBaseSlab(group: Group): void {
  const cached = group.userData[BASE_SLAB_MANIFOLD_KEY] as Manifold | undefined;
  if (cached) {
    try {
      cached.delete();
    } catch (err) {
      console.warn(
        `[printableParts] disposing cached base-slab Manifold threw:`,
        err,
      );
    }
    delete group.userData[BASE_SLAB_MANIFOLD_KEY];
  }
}

function cancelMeshTween(tween: MeshTween): void {
  if (tween.rafId !== 0) {
    cancelAnimationFrame(tween.rafId);
    tween.rafId = 0;
  }
  tween.tweenStart_ms = null;
}

function cancelAllTweens(state: PrintableState): void {
  for (const t of state.shellPieces) cancelMeshTween(t);
  cancelMeshTween(state.slab);
}

function createPrintMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: 0xb8b8b8,
    roughness: 0.8,
    metalness: 0.0,
  });
}

/**
 * Compute the world-space AABB of a mesh from its BufferGeometry.
 */
function meshBbox(mesh: Mesh): Box3 {
  mesh.geometry.computeBoundingBox();
  const box = new Box3();
  if (mesh.geometry.boundingBox) {
    box.copy(mesh.geometry.boundingBox);
  }
  return box;
}

/**
 * Horizontal radius (XZ plane) of a Box3 from a reference XZ center
 * — the furthest XZ corner distance. Used to scale the radial
 * exploded offset per piece.
 */
function horizRadius(bbox: Box3, xzCenterX: number, xzCenterZ: number): number {
  const dx = Math.max(
    Math.abs(bbox.max.x - xzCenterX),
    Math.abs(bbox.min.x - xzCenterX),
  );
  const dz = Math.max(
    Math.abs(bbox.max.z - xzCenterZ),
    Math.abs(bbox.min.z - xzCenterZ),
  );
  return Math.max(dx, dz);
}

/**
 * Resolve the shell piece's radial exploded-offset magnitude (mm) from
 * its AABB extent relative to the master's XZ center.
 */
function resolveShellExplodedOffset(
  bbox: Box3,
  xzCenterX: number,
  xzCenterZ: number,
): number {
  const bboxR = horizRadius(bbox, xzCenterX, xzCenterZ);
  return Math.max(
    SHELL_EXPLODED_OFFSET_FLOOR_MM,
    bboxR * SHELL_EXPLODED_OFFSET_BBOX_FRACTION,
  );
}

/** Resolve the slab's exploded offset magnitude (unsigned). The actual motion is -Y. */
function resolveSlabExplodedOffset(bbox: Box3): number {
  const heightY = Math.max(0, bbox.max.y - bbox.min.y);
  return Math.max(
    SLAB_EXPLODED_OFFSET_FLOOR_MM,
    heightY * SLAB_EXPLODED_OFFSET_BBOX_FRACTION,
  );
}

/**
 * Write the tween fraction into a mesh's `position`. `fraction = 0`
 * collapses to rest (origin); `fraction = 1` places at `offset`.
 */
function applyFraction(tween: MeshTween, fraction: number): void {
  const clamped = Math.max(0, Math.min(1, fraction));
  tween.currentFraction = clamped;
  tween.mesh.position.set(
    clamped * tween.offset.x,
    clamped * tween.offset.y,
    clamped * tween.offset.z,
  );
}

/**
 * Kick off (or update) a tween for a single mesh toward `targetFraction`.
 * Linear easing over 250 ms. Mid-flight reversals supported.
 */
function startMeshTween(tween: MeshTween, targetFraction: number): void {
  cancelMeshTween(tween);
  tween.targetFraction = targetFraction;
  tween.tweenStartFraction = tween.currentFraction;
  if (tween.currentFraction === targetFraction) {
    return;
  }
  tween.tweenStart_ms = performance.now();

  const step = (): void => {
    if (tween.tweenStart_ms === null) return;
    const elapsed = performance.now() - tween.tweenStart_ms;
    const t = Math.max(0, Math.min(1, elapsed / EXPLODED_TWEEN_MS));
    const fraction =
      tween.tweenStartFraction +
      (tween.targetFraction - tween.tweenStartFraction) * t;
    applyFraction(tween, fraction);
    if (t >= 1) {
      tween.rafId = 0;
      tween.tweenStart_ms = null;
      return;
    }
    tween.rafId = requestAnimationFrame(step);
  };
  tween.rafId = requestAnimationFrame(step);
}

/**
 * Derive the master XZ center from the generator-supplied XZ center OR
 * fall back to the scene's master group bbox. Either works — the
 * generator and scene share the same world frame (generateSiliconeShell
 * applies the viewTransform inside), and the master group's bbox is
 * read as a fallback in case the caller doesn't supply an xzCenter
 * (legacy call sites in tests).
 *
 * Default fallback: (0, 0).
 */
function resolveXzCenter(
  scene: Scene,
  override: { x: number; z: number } | undefined,
): { x: number; z: number } {
  if (override) return override;
  const masterGroup = scene.children.find(
    (c) => c.userData['tag'] === 'master',
  );
  if (masterGroup) {
    const bb = new Box3().setFromObject(masterGroup);
    if (!bb.isEmpty()) {
      return {
        x: (bb.min.x + bb.max.x) / 2,
        z: (bb.min.z + bb.max.z) / 2,
      };
    }
  }
  return { x: 0, z: 0 };
}

/**
 * Install fresh shell-piece + base-slab Manifolds into the scene's
 * printable-parts group. Disposes the previous meshes first; only one
 * set is live at a time.
 *
 * Ownership: from the moment this function returns successfully, the
 * scene owns EVERY Manifold. The caller MUST NOT `.delete()` them. The
 * next `setPrintableParts` call (or `clearPrintableParts`) evicts them.
 *
 * Visibility: the new group starts `visible=true` regardless of the
 * previous state.
 *
 * Failure mode: if any BufferGeometry adapter throws, we dispose any
 * partially-allocated GPU state AND `.delete()` every input Manifold
 * so the caller's lifetime assumption still holds without leaking
 * WASM.
 *
 * @throws If the scene is missing its printable-parts group.
 */
export async function setPrintableParts(
  scene: Scene,
  parts: {
    shellPieces: readonly Manifold[];
    basePart: Manifold;
    /** Master XZ center — same (cx, cz) passed to the generator's slicer. Optional. */
    xzCenter?: { x: number; z: number };
  },
): Promise<PrintablePartsResult> {
  const group = findGroup(scene);
  if (!group) {
    for (const p of parts.shellPieces) {
      try { p.delete(); } catch { /* already dead */ }
    }
    try { parts.basePart.delete(); } catch { /* already dead */ }
    throw new Error(
      'setPrintableParts: scene is missing its printable-parts group ' +
        '(userData.tag === "printableParts"). createScene() must have run first.',
    );
  }

  // Build every display geometry BEFORE touching existing children —
  // atomic replacement on any failure.
  const shellGeoms: Awaited<ReturnType<typeof manifoldToBufferGeometry>>[] = [];
  let slabGeom:
    | Awaited<ReturnType<typeof manifoldToBufferGeometry>>
    | undefined;
  try {
    for (const sp of parts.shellPieces) {
      shellGeoms.push(await manifoldToBufferGeometry(sp));
    }
    slabGeom = await manifoldToBufferGeometry(parts.basePart);
  } catch (err) {
    for (const g of shellGeoms) g.dispose();
    if (slabGeom) slabGeom.dispose();
    for (const p of parts.shellPieces) {
      try { p.delete(); } catch { /* already dead */ }
    }
    try { parts.basePart.delete(); } catch { /* already dead */ }
    throw err;
  }

  // Tear down the previous state atomically.
  const prev = getState(group);
  if (prev) {
    cancelAllTweens(prev);
    for (const t of prev.shellPieces) t.material.dispose();
    prev.slab.material.dispose();
  }
  const existing = [...group.children];
  for (const child of existing) {
    if (child instanceof Mesh) {
      child.geometry.dispose();
      if (child.parent) child.parent.remove(child);
    }
  }
  disposeCachedShellPieces(group);
  disposeCachedBaseSlab(group);
  setState(group, null);

  // Fresh install starts VISIBLE.
  group.visible = true;

  const xzCenter = resolveXzCenter(scene, parts.xzCenter);

  // Build shell-piece meshes.
  const shellMeshes: Mesh[] = [];
  const shellMaterials: MeshStandardMaterial[] = [];
  for (let i = 0; i < shellGeoms.length; i++) {
    const material = createPrintMaterial();
    const mesh = new Mesh(shellGeoms[i], material);
    mesh.userData['tag'] = `${SHELL_PIECE_MESH_TAG_PREFIX}${i}`;
    group.add(mesh);
    shellMeshes.push(mesh);
    shellMaterials.push(material);
  }

  // Build slab mesh.
  const slabMaterial = createPrintMaterial();
  const slabMesh = new Mesh(slabGeom, slabMaterial);
  slabMesh.userData['tag'] = BASE_SLAB_MESH_TAG;
  group.add(slabMesh);

  // Cache Manifolds so clearPrintableParts can release WASM memory.
  group.userData[SHELL_PIECES_MANIFOLD_KEY] = [...parts.shellPieces];
  group.userData[BASE_SLAB_MANIFOLD_KEY] = parts.basePart;

  // Compute each shell piece's outward radial direction + magnitude
  // from its own world-AABB. Each piece gets an INDEPENDENT direction
  // so the exploded view fans pieces apart like peeling a flower.
  const shellTweens: MeshTween[] = [];
  const shellBboxes: Box3[] = [];
  for (let i = 0; i < shellMeshes.length; i++) {
    const mesh = shellMeshes[i] as Mesh;
    const bbox = meshBbox(mesh);
    shellBboxes.push(bbox);
    // Piece XZ centroid minus master XZ center → outward vector.
    const dx = (bbox.min.x + bbox.max.x) / 2 - xzCenter.x;
    const dz = (bbox.min.z + bbox.max.z) / 2 - xzCenter.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    // Guard: if the piece somehow has its centroid exactly at the
    // master XZ center (e.g. a degenerate symmetric case), fall back
    // to +X so the explode doesn't collapse to a no-op.
    const nx = len > 1e-9 ? dx / len : 1;
    const nz = len > 1e-9 ? dz / len : 0;
    const magnitude = resolveShellExplodedOffset(bbox, xzCenter.x, xzCenter.z);
    shellTweens.push({
      mesh,
      offset: new Vector3(nx * magnitude, 0, nz * magnitude),
      currentFraction: 0,
      targetFraction: 0,
      tweenStart_ms: null,
      tweenStartFraction: 0,
      rafId: 0,
      material: shellMaterials[i] as MeshStandardMaterial,
    });
  }

  const slabBbox = meshBbox(slabMesh);
  const slabOffsetMag = resolveSlabExplodedOffset(slabBbox);
  const slabTween: MeshTween = {
    mesh: slabMesh,
    offset: new Vector3(0, -slabOffsetMag, 0),
    currentFraction: 0,
    targetFraction: 0,
    tweenStart_ms: null,
    tweenStartFraction: 0,
    rafId: 0,
    material: slabMaterial,
  };
  const state: PrintableState = { shellPieces: shellTweens, slab: slabTween };
  setState(group, state);

  // Pin every position at fraction=0 (collapsed). Default Mesh.position
  // is already zero, but explicit application is the invariant.
  for (const t of shellTweens) applyFraction(t, 0);
  applyFraction(slabTween, 0);

  // Union of every shell-piece bbox + slab bbox — useful for camera
  // framing.
  const unionBbox = new Box3();
  for (const bb of shellBboxes) unionBbox.union(bb);
  if (!slabBbox.isEmpty()) unionBbox.union(slabBbox);

  return { bbox: unionBbox, shellMeshes, slabMesh };
}

/**
 * Remove every shell piece + the base slab from the scene, dispose GPU
 * resources, and `.delete()` every cached Manifold. Idempotent and safe
 * on a scene with nothing installed.
 */
export function clearPrintableParts(scene: Scene): void {
  const group = findGroup(scene);
  if (!group) return;
  const state = getState(group);
  if (state) {
    cancelAllTweens(state);
    for (const t of state.shellPieces) disposeMesh(t.mesh, t.material);
    disposeMesh(state.slab.mesh, state.slab.material);
  } else {
    // Defence-in-depth: if state is missing but children exist, drop them.
    const existing = [...group.children];
    for (const child of existing) {
      if (child instanceof Mesh) {
        child.geometry.dispose();
        if (child.parent) child.parent.remove(child);
      }
    }
  }
  disposeCachedShellPieces(group);
  disposeCachedBaseSlab(group);
  setState(group, null);
  // Leave `group.visible` as-is; the next install resets it to true.
}

/**
 * Flip the visibility of the printable-parts group. Called by the
 * toolbar toggle. Hides ALL meshes together (they share the group).
 * No-op when no parts are installed.
 */
export function setPrintablePartsVisible(scene: Scene, visible: boolean): void {
  const group = findGroup(scene);
  if (!group) return;
  const state = getState(group);
  if (!state) return;
  group.visible = visible;
  // When hidden, cancel any running tweens so the RAF loop doesn't burn
  // CPU on invisible geometry. Snap to targets so the next show reveals
  // the meshes at their intended rest positions.
  if (!visible) {
    for (const t of state.shellPieces) {
      if (t.rafId !== 0) {
        cancelMeshTween(t);
        applyFraction(t, t.targetFraction);
      }
    }
    if (state.slab.rafId !== 0) {
      cancelMeshTween(state.slab);
      applyFraction(state.slab, state.slab.targetFraction);
    }
  }
}

/**
 * Whether the printable-parts group is visible. Returns `false` if no
 * parts are installed OR the group's visibility flag is off.
 */
export function arePrintablePartsVisible(scene: Scene): boolean {
  const group = findGroup(scene);
  if (!group) return false;
  const state = getState(group);
  if (!state) return false;
  return group.visible;
}

/**
 * Whether any shell pieces + base slab are currently installed.
 */
export function hasPrintableParts(scene: Scene): boolean {
  const group = findGroup(scene);
  if (!group) return false;
  return getState(group) !== null;
}

/**
 * Toggle the exploded-view state for ALL printable meshes at once.
 * `true` animates each shell piece radially outward AND the slab to
 * -Y in parallel; `false` collapses everything. No-op when no parts
 * installed OR the group is hidden.
 */
export function setPrintablePartsExplodedView(scene: Scene, exploded: boolean): void {
  const group = findGroup(scene);
  if (!group) return;
  const state = getState(group);
  if (!state) return;
  const target = exploded ? 1 : 0;
  // If the group is hidden, snap everything to targets (no tween, no
  // RAF) so the next setVisible(true) shows the meshes at the right
  // place.
  if (!group.visible) {
    for (const t of state.shellPieces) {
      cancelMeshTween(t);
      t.targetFraction = target;
      applyFraction(t, target);
    }
    cancelMeshTween(state.slab);
    state.slab.targetFraction = target;
    applyFraction(state.slab, target);
    return;
  }
  for (const t of state.shellPieces) startMeshTween(t, target);
  startMeshTween(state.slab, target);
}

/**
 * Whether the exploded-view tweens for printable parts are currently
 * idle. Returns `true` when no parts installed, OR the group is hidden,
 * OR EVERY tween has completed / never started.
 *
 * Used by visual-regression tests to gate `toHaveScreenshot` on a
 * stable scene.
 */
export function isPrintableExplodedIdle(scene: Scene): boolean {
  const group = findGroup(scene);
  if (!group) return true;
  const state = getState(group);
  if (!state) return true;
  if (!group.visible) return true;
  for (const t of state.shellPieces) {
    if (t.rafId !== 0 || t.tweenStart_ms !== null) return false;
  }
  if (state.slab.rafId !== 0 || state.slab.tweenStart_ms !== null) return false;
  return true;
}
