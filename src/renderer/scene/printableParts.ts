// src/renderer/scene/printableParts.ts
//
// Scene module owning the surface-conforming print-shell mesh + the
// printable base slab (Wave C + Wave D). Post-Wave-D this module manages
// TWO meshes under the `printableParts` group:
//
//   - print-shell mesh (tag: `print-shell`), lifted +Y on explode.
//   - base-slab mesh  (tag: `base-slab-mesh`), lifted -Y on explode.
//
// Both meshes share the same opaque print-grey material color
// (`MeshStandardMaterial({ color: 0xb8b8b8, roughness: 0.8, metalness: 0.0 })`),
// but we allocate two instances so each mesh can dispose its own material
// on teardown without coordinating refcounts.
//
// The module mirrors the `scene/silicone.ts` lifecycle pattern:
//
//   - exactly one print-shell + one base-slab live at a time,
//   - `setPrintableParts(scene, {printShell, basePart})` disposes the
//     previous meshes (geometry + material + Manifold `.delete()`)
//     before installing the new ones,
//   - `clearPrintableParts(scene)` is idempotent and safe on an empty
//     group (used by every staleness signal: commit, reset, new-STL).
//
// Ownership handoff:
//
//   The caller (`generateOrchestrator.ts` on the happy path) passes in
//   two freshly-generated Manifolds. From the moment `setPrintableParts`
//   returns, THIS MODULE owns both lifetimes — the caller must NOT
//   `.delete()` them again. Eviction happens on the next
//   `setPrintableParts` call, on any `clearPrintableParts` call, and on
//   viewport teardown.
//
// Frame alignment:
//
//   `generateSiliconeShell` applies the Master group's world matrix to
//   the master Manifold INSIDE the generator, so BOTH the returned
//   print-shell and base-slab Manifolds are ALREADY in the world frame.
//   We render the meshes at world origin with no group transform.
//
// Exploded view (Wave D update):
//
//   - print-shell lifts +Y by `max(40 mm, 0.25 * shellBboxHeight)`.
//   - base-slab  lifts -Y by `max(30 mm, 0.2 * slabBboxHeight)`.
//
//   Both tweens run in parallel through the same RAF clock. They share
//   the `setPrintablePartsExplodedView(scene, exploded)` entry-point,
//   which kicks off / cancels both tweens atomically so the animations
//   stay visually coupled even when the user toggles mid-flight.
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
  type Scene,
} from 'three';
import type { Manifold } from 'manifold-3d';

import { manifoldToBufferGeometry } from '@/geometry/adapters';

/** Tag on the printable-parts group created in `scene/index.ts`. */
const PRINTABLE_PARTS_GROUP_TAG = 'printableParts';

/** Tag on the print-shell mesh child. */
const PRINT_SHELL_MESH_TAG = 'print-shell';
/** Tag on the base-slab mesh child. */
const BASE_SLAB_MESH_TAG = 'base-slab-mesh';

/**
 * `userData` keys where we cache the Manifolds so teardown can release
 * them even if the Mesh nodes have been removed via another code path.
 * Exported so viewport-level dispose can read the same slots.
 */
export const PRINT_SHELL_MANIFOLD_KEY = 'printShellManifold';
export const BASE_SLAB_MANIFOLD_KEY = 'baseSlabManifold';

/** Default exploded-offset floor (mm) for the shell — lifts above silicone. */
const SHELL_EXPLODED_OFFSET_FLOOR_MM = 40;
const SHELL_EXPLODED_OFFSET_BBOX_FRACTION = 0.25;

/** Exploded-offset floor (mm) for the slab — drops below master. */
const SLAB_EXPLODED_OFFSET_FLOOR_MM = 30;
const SLAB_EXPLODED_OFFSET_BBOX_FRACTION = 0.2;

/** Tween duration for exploded-view transitions. Matches silicone. */
const EXPLODED_TWEEN_MS = 250;

/** Shape returned by `setPrintableParts`. */
export interface PrintablePartsResult {
  /** Union of shell + slab world-AABBs. Used to frame the camera. */
  readonly bbox: Box3;
  readonly shellMesh: Mesh;
  readonly slabMesh: Mesh;
}

/**
 * Per-mesh tween record. Each mesh animates along +Y (shell) or -Y
 * (slab) independently; the top-level state record below holds one per
 * mesh so mid-flight reversals can keep the two in sync.
 */
interface MeshTween {
  mesh: Mesh;
  /** Signed magnitude along Y applied at fraction=1. Positive for shell, negative for slab. */
  offset_mm: number;
  currentFraction: number;
  targetFraction: number;
  tweenStart_ms: number | null;
  tweenStartFraction: number;
  rafId: number;
  material: MeshStandardMaterial;
}

/**
 * Internal record stashed on the printable-parts group's `userData`.
 * Holds both tweens + metadata so `setPrintablePartsExplodedView` can
 * update without re-traversing the scene graph.
 */
interface PrintableState {
  shell: MeshTween;
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
 * Release the cached Manifold on the group's userData for the given key
 * and clear the slot. Idempotent.
 */
function disposeCachedManifold(group: Group, key: string): void {
  const cached = group.userData[key] as Manifold | undefined;
  if (cached) {
    try {
      cached.delete();
    } catch (err) {
      console.warn(`[printableParts] disposing cached Manifold (${key}) threw:`, err);
    }
    delete group.userData[key];
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
  cancelMeshTween(state.shell);
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

/** Resolve the shell's exploded offset (positive Y). */
function resolveShellExplodedOffset(bbox: Box3): number {
  const heightY = Math.max(0, bbox.max.y - bbox.min.y);
  return Math.max(
    SHELL_EXPLODED_OFFSET_FLOOR_MM,
    heightY * SHELL_EXPLODED_OFFSET_BBOX_FRACTION,
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
 * Write the tween fraction into a mesh's `position.y`. `fraction = 0`
 * collapses to rest (y = 0); `fraction = 1` places at `offset_mm` along
 * Y. `offset_mm` is already signed (positive for shell, negative for
 * slab).
 */
function applyFraction(tween: MeshTween, fraction: number): void {
  const clamped = Math.max(0, Math.min(1, fraction));
  tween.currentFraction = clamped;
  tween.mesh.position.y = clamped * tween.offset_mm;
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
 * Install fresh print-shell + base-slab Manifolds into the scene's
 * printable-parts group. Disposes the previous meshes first; only one
 * pair is live at a time.
 *
 * Ownership: from the moment this function returns successfully, the
 * scene owns BOTH Manifolds. The caller MUST NOT `.delete()` them. The
 * next `setPrintableParts` call (or `clearPrintableParts`) evicts them.
 *
 * Visibility (issue #67 carry-forward): the new group starts
 * `visible=true` regardless of the previous state.
 *
 * Failure mode: if either BufferGeometry adapter throws, we dispose any
 * partially-allocated GPU state AND `.delete()` both input Manifolds so
 * the caller's lifetime assumption still holds without leaking WASM.
 *
 * @throws If the scene is missing its printable-parts group.
 */
export async function setPrintableParts(
  scene: Scene,
  parts: { printShell: Manifold; basePart: Manifold },
): Promise<PrintablePartsResult> {
  const group = findGroup(scene);
  if (!group) {
    try { parts.printShell.delete(); } catch { /* already dead */ }
    try { parts.basePart.delete(); } catch { /* already dead */ }
    throw new Error(
      'setPrintableParts: scene is missing its printable-parts group ' +
        '(userData.tag === "printableParts"). createScene() must have run first.',
    );
  }

  // Build both display geometries BEFORE touching existing children —
  // atomic replacement on any failure. If the slab adapter throws after
  // the shell geometry was built, we dispose the shell geometry and both
  // Manifolds before re-throwing.
  let shellGeom: Awaited<ReturnType<typeof manifoldToBufferGeometry>> | undefined;
  let slabGeom: Awaited<ReturnType<typeof manifoldToBufferGeometry>> | undefined;
  try {
    shellGeom = await manifoldToBufferGeometry(parts.printShell);
    slabGeom = await manifoldToBufferGeometry(parts.basePart);
  } catch (err) {
    if (shellGeom) shellGeom.dispose();
    if (slabGeom) slabGeom.dispose();
    try { parts.printShell.delete(); } catch { /* already dead */ }
    try { parts.basePart.delete(); } catch { /* already dead */ }
    throw err;
  }

  // Tear down the previous state atomically.
  const prev = getState(group);
  if (prev) {
    cancelAllTweens(prev);
    prev.shell.material.dispose();
    prev.slab.material.dispose();
  }
  const existing = [...group.children];
  for (const child of existing) {
    if (child instanceof Mesh) {
      child.geometry.dispose();
      if (child.parent) child.parent.remove(child);
    }
  }
  disposeCachedManifold(group, PRINT_SHELL_MANIFOLD_KEY);
  disposeCachedManifold(group, BASE_SLAB_MANIFOLD_KEY);
  setState(group, null);

  // Fresh install starts VISIBLE (issue #67 carry-forward).
  group.visible = true;

  // Build the meshes.
  const shellMaterial = createPrintMaterial();
  const shellMesh = new Mesh(shellGeom, shellMaterial);
  shellMesh.userData['tag'] = PRINT_SHELL_MESH_TAG;
  group.add(shellMesh);

  const slabMaterial = createPrintMaterial();
  const slabMesh = new Mesh(slabGeom, slabMaterial);
  slabMesh.userData['tag'] = BASE_SLAB_MESH_TAG;
  group.add(slabMesh);

  // Cache Manifolds so clearPrintableParts can release WASM memory.
  group.userData[PRINT_SHELL_MANIFOLD_KEY] = parts.printShell;
  group.userData[BASE_SLAB_MANIFOLD_KEY] = parts.basePart;

  const shellBbox = meshBbox(shellMesh);
  const slabBbox = meshBbox(slabMesh);

  const shellOffset = resolveShellExplodedOffset(shellBbox);
  // Slab drops DOWN on explode — negate the magnitude so applyFraction
  // writes negative Y positions.
  const slabOffset = -resolveSlabExplodedOffset(slabBbox);

  const shellTween: MeshTween = {
    mesh: shellMesh,
    offset_mm: shellOffset,
    currentFraction: 0,
    targetFraction: 0,
    tweenStart_ms: null,
    tweenStartFraction: 0,
    rafId: 0,
    material: shellMaterial,
  };
  const slabTween: MeshTween = {
    mesh: slabMesh,
    offset_mm: slabOffset,
    currentFraction: 0,
    targetFraction: 0,
    tweenStart_ms: null,
    tweenStartFraction: 0,
    rafId: 0,
    material: slabMaterial,
  };
  const state: PrintableState = { shell: shellTween, slab: slabTween };
  setState(group, state);

  // Pin both positions at fraction=0 (collapsed). Default Mesh.position
  // is already zero, but explicit application is the invariant.
  applyFraction(shellTween, 0);
  applyFraction(slabTween, 0);

  // Union of shell + slab bboxes — useful for camera framing.
  const unionBbox = shellBbox.clone();
  if (!slabBbox.isEmpty()) unionBbox.union(slabBbox);

  return { bbox: unionBbox, shellMesh, slabMesh };
}

/**
 * Remove the print shell + base slab from the scene, dispose GPU
 * resources, and `.delete()` the cached Manifolds. Idempotent and safe
 * on a scene with nothing installed.
 */
export function clearPrintableParts(scene: Scene): void {
  const group = findGroup(scene);
  if (!group) return;
  const state = getState(group);
  if (state) {
    cancelAllTweens(state);
    disposeMesh(state.shell.mesh, state.shell.material);
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
  disposeCachedManifold(group, PRINT_SHELL_MANIFOLD_KEY);
  disposeCachedManifold(group, BASE_SLAB_MANIFOLD_KEY);
  setState(group, null);
  // Leave `group.visible` as-is; the next install resets it to true.
}

/**
 * Flip the visibility of the printable-parts group. Called by the
 * toolbar toggle. Hides BOTH meshes together (they share the group).
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
    if (state.shell.rafId !== 0) {
      cancelMeshTween(state.shell);
      applyFraction(state.shell, state.shell.targetFraction);
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
 * Whether a print shell + base slab are currently installed.
 */
export function hasPrintableParts(scene: Scene): boolean {
  const group = findGroup(scene);
  if (!group) return false;
  return getState(group) !== null;
}

/**
 * Toggle the exploded-view state for BOTH printable meshes at once.
 * `true` animates shell → +Y and slab → -Y in parallel; `false`
 * collapses both. No-op when no parts installed OR the group is hidden.
 */
export function setPrintablePartsExplodedView(scene: Scene, exploded: boolean): void {
  const group = findGroup(scene);
  if (!group) return;
  const state = getState(group);
  if (!state) return;
  const target = exploded ? 1 : 0;
  // If the group is hidden, snap both to targets (no tween, no RAF) so
  // the next setVisible(true) shows the meshes at the right place.
  if (!group.visible) {
    cancelMeshTween(state.shell);
    cancelMeshTween(state.slab);
    state.shell.targetFraction = target;
    state.slab.targetFraction = target;
    applyFraction(state.shell, target);
    applyFraction(state.slab, target);
    return;
  }
  startMeshTween(state.shell, target);
  startMeshTween(state.slab, target);
}

/**
 * Whether the exploded-view tweens for printable parts are currently
 * idle. Returns `true` when no parts installed, OR the group is hidden,
 * OR BOTH tweens have completed / never started.
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
  const shellIdle =
    state.shell.rafId === 0 && state.shell.tweenStart_ms === null;
  const slabIdle =
    state.slab.rafId === 0 && state.slab.tweenStart_ms === null;
  return shellIdle && slabIdle;
}
