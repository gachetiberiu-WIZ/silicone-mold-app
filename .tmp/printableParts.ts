// src/renderer/scene/printableParts.ts
//
// Scene module owning the surface-conforming print-shell mesh produced by
// `generateSiliconeShell` (Wave C, issue #72). Post-Wave-C this is a
// SINGLE mesh — the rectangular box + N-side radial split of the pre-#72
// pipeline is gone. The module mirrors the `scene/silicone.ts` lifecycle
// pattern:
//
//   - exactly one print-shell live at a time,
//   - `setPrintableParts(scene, {printShell})` disposes the previous
//     mesh (geometry + material + Manifold `.delete()`) before installing
//     the new one,
//   - `clearPrintableParts(scene)` is idempotent and safe on an empty
//     group (used by every staleness signal: commit, reset, new-STL).
//
// Ownership handoff:
//
//   The caller (`generateOrchestrator.ts` on the happy path) passes in
//   one freshly-generated Manifold. From the moment `setPrintableParts`
//   returns, THIS MODULE owns its lifetime — the caller must NOT
//   `.delete()` it again. Eviction happens on the next `setPrintableParts`
//   call, on any `clearPrintableParts` call, and on viewport teardown.
//
// Frame alignment:
//
//   `generateSiliconeShell` applies the Master group's world matrix to
//   the master Manifold INSIDE the generator, so the returned print-shell
//   Manifold is ALREADY in the world frame. We render the mesh at world
//   origin with no group transform. Double-applying the master group's
//   matrix would drift the mesh away from the visible silicone.
//
// Material:
//
//   `MeshStandardMaterial({ color: 0xb8b8b8, roughness: 0.8, metalness: 0.0 })`
//   — opaque "3D-print plastic" gray. No transparency — the print shell
//   occludes silicone + master when visible, and the exploded-view tween
//   lifts it out of the way so the user can inspect the silicone cavity.
//
// Visibility:
//
//   The group starts VISIBLE on every install (`group.visible = true`).
//   This is the issue #67 "default ON" behaviour carried forward from
//   the rectangular-box predecessor: users click "Generate mold" and
//   expect to see the mold; the toolbar toggle flips `visible` via
//   `setPrintablePartsVisible`.
//
// Exploded view:
//
//   Post-Wave-C the print shell is one piece; "exploded" lifts the
//   whole mesh along +Y. Offset rule: `max(40 mm, 0.25 * bboxHeight)` —
//   slightly higher than the silicone's `max(30, 0.2 * bboxHeight)` so
//   the shell lifts clear ABOVE the silicone when both modules animate
//   together, revealing the master + silicone beneath. Both modules use
//   the same +Y-only axis-aligned motion (no radial motion remains —
//   that was a property of the old N-sided ring frame).
//
// Test-hook surface:
//
//   Module-level getters: `arePrintablePartsVisible`,
//   `isPrintableExplodedIdle`, `hasPrintableParts`. Exposed on the
//   viewport handle. Read-only; no setters through the test hook.

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

/** Tag on the single print-shell mesh child. */
const PRINT_SHELL_MESH_TAG = 'print-shell';

/**
 * `userData` key where we cache the Manifold so teardown can release it
 * even if the Mesh node has been removed via another code path. Exported
 * so viewport-level dispose can read the same slot.
 */
export const PRINT_SHELL_MANIFOLD_KEY = 'printShellManifold';

/** Default exploded-offset floor in mm — shell lifts clear above silicone. */
const EXPLODED_OFFSET_FLOOR_MM = 40;
/**
 * Fraction of bbox-height used for the exploded-offset ceiling. Higher
 * than silicone's 0.2 so the shell rises clear of the silicone when both
 * animate together.
 */
const EXPLODED_OFFSET_BBOX_FRACTION = 0.25;
/** Tween duration for exploded-view transitions. Matches silicone. */
const EXPLODED_TWEEN_MS = 250;

/** Shape returned by `setPrintableParts`. */
export interface PrintablePartsResult {
  readonly bbox: Box3;
  readonly mesh: Mesh;
}

/**
 * Internal record stashed on the printable-parts group's `userData`.
 * Holds the tween target + offset metadata + RAF handle so
 * `setPrintablePartsExplodedView` can update without re-traversing the
 * scene graph.
 */
interface PrintableState {
  mesh: Mesh;
  /** Max +Y offset applied at fraction=1. */
  offsetMax_mm: number;
  /** Current exploded fraction ∈ [0, 1]. */
  currentFraction: number;
  /** Target exploded fraction ∈ [0, 1]; tween walks currentFraction there. */
  targetFraction: number;
  /** `performance.now()` at tween start, or null when idle. */
  tweenStart_ms: number | null;
  /** Starting fraction at tween-start — lets mid-flight reversals tween smoothly. */
  tweenStartFraction: number;
  /** RAF handle for the in-flight tween (0 = none). */
  rafId: number;
  /** Material used by the mesh, disposed in teardown. */
  material: MeshStandardMaterial;
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
 * Remove a mesh from its parent and dispose its GPU geometry. The
 * material is disposed separately by the state teardown because it's
 * owned by the state record (not the mesh — same instance would be shared
 * in a hypothetical multi-mesh world; kept for symmetry with the tween
 * state lifetime).
 */
function disposeMeshGeometry(mesh: Mesh): void {
  mesh.geometry.dispose();
  if (mesh.parent) mesh.parent.remove(mesh);
}

/**
 * Release the cached Manifold on the group's userData and clear the slot.
 * Idempotent. `.delete()` releases the underlying WASM heap allocation —
 * dropping the JS reference without calling it would leak.
 */
function disposeCachedManifold(group: Group): void {
  const cached = group.userData[PRINT_SHELL_MANIFOLD_KEY] as Manifold | undefined;
  if (cached) {
    try {
      cached.delete();
    } catch (err) {
      console.warn('[printableParts] disposing cached print-shell Manifold threw:', err);
    }
    delete group.userData[PRINT_SHELL_MANIFOLD_KEY];
  }
}

/**
 * Cancel any in-flight exploded-view tween. Safe to call on idle state.
 */
function cancelTween(state: PrintableState): void {
  if (state.rafId !== 0) {
    cancelAnimationFrame(state.rafId);
    state.rafId = 0;
  }
  state.tweenStart_ms = null;
}

/**
 * Create the opaque gray material. Single instance owned by the state
 * record — disposed once at teardown. Fresh `setPrintableParts` calls
 * build a NEW material (they dispose the previous state including its
 * material before installing).
 */
function createPrintShellMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: 0xb8b8b8,
    roughness: 0.8,
    metalness: 0.0,
  });
}

/**
 * Compute the world-space AABB of the print-shell mesh from its
 * BufferGeometry. The generator baked the viewport transform into the
 * Manifold so the geometry is already in world frame.
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
 * Resolve the exploded-offset magnitude for a bbox. Applies the Wave-C
 * rule `max(40, 0.25 * bboxHeight)` — slightly larger than silicone's
 * (30, 0.2) so the shell lifts clear ABOVE the silicone when both
 * animate together.
 */
function resolveExplodedOffset(bbox: Box3): number {
  const heightY = Math.max(0, bbox.max.y - bbox.min.y);
  return Math.max(
    EXPLODED_OFFSET_FLOOR_MM,
    heightY * EXPLODED_OFFSET_BBOX_FRACTION,
  );
}

/**
 * Write the tween fraction into the mesh's `position.y`. `fraction = 0`
 * collapses to rest (y = 0); `fraction = 1` places at +offsetMax along Y.
 */
function applyFraction(state: PrintableState, fraction: number): void {
  const clamped = Math.max(0, Math.min(1, fraction));
  state.currentFraction = clamped;
  state.mesh.position.y = clamped * state.offsetMax_mm;
}

/**
 * Kick off (or update) an exploded-view tween toward `targetFraction`.
 * Linear easing over 250 ms. Mid-flight reversals are supported via the
 * `tweenStartFraction` snapshot — same pattern as silicone.ts.
 */
function startTween(state: PrintableState, targetFraction: number): void {
  cancelTween(state);
  state.targetFraction = targetFraction;
  state.tweenStartFraction = state.currentFraction;
  // If we're already at the target, no RAF work to do.
  if (state.currentFraction === targetFraction) {
    return;
  }
  state.tweenStart_ms = performance.now();

  const step = (): void => {
    if (state.tweenStart_ms === null) return;
    const elapsed = performance.now() - state.tweenStart_ms;
    const t = Math.max(0, Math.min(1, elapsed / EXPLODED_TWEEN_MS));
    const fraction =
      state.tweenStartFraction +
      (state.targetFraction - state.tweenStartFraction) * t;
    applyFraction(state, fraction);
    if (t >= 1) {
      state.rafId = 0;
      state.tweenStart_ms = null;
      return;
    }
    state.rafId = requestAnimationFrame(step);
  };
  state.rafId = requestAnimationFrame(step);
}

/**
 * Install a freshly-generated print-shell Manifold into the scene's
 * printable-parts group. Disposes the previous mesh first; only one is
 * live at a time.
 *
 * Ownership: from the moment this function returns successfully, the
 * scene owns the Manifold. The caller MUST NOT `.delete()` it. The next
 * `setPrintableParts` call (or `clearPrintableParts`) evicts it.
 *
 * Visibility (issue #67 carry-forward): the new group starts VISIBLE
 * regardless of the previous visibility state — fresh Generate → users
 * see the mold immediately.
 *
 * Failure mode: if the BufferGeometry adapter throws, we dispose the
 * Manifold so the caller's lifetime assumption still holds without
 * leaking WASM.
 *
 * @throws If the scene is missing its printable-parts group.
 */
export async function setPrintableParts(
  scene: Scene,
  parts: { printShell: Manifold },
): Promise<PrintablePartsResult> {
  const group = findGroup(scene);
  if (!group) {
    try { parts.printShell.delete(); } catch { /* already dead */ }
    throw new Error(
      'setPrintableParts: scene is missing its printable-parts group ' +
        '(userData.tag === "printableParts"). createScene() must have run first.',
    );
  }

  // Build display geometry first — atomic replacement on failure.
  let geom: Awaited<ReturnType<typeof manifoldToBufferGeometry>> | undefined;
  try {
    geom = await manifoldToBufferGeometry(parts.printShell);
  } catch (err) {
    try { parts.printShell.delete(); } catch { /* already dead */ }
    throw err;
  }

  // Tear down the previous state atomically.
  const prev = getState(group);
  if (prev) {
    cancelTween(prev);
    prev.material.dispose();
  }
  const existing = [...group.children];
  for (const child of existing) {
    if (child instanceof Mesh) disposeMeshGeometry(child);
  }
  disposeCachedManifold(group);
  setState(group, null);

  // Fresh install starts VISIBLE (issue #67 carry-forward).
  group.visible = true;

  // Build the mesh.
  const material = createPrintShellMaterial();
  const mesh = new Mesh(geom, material);
  mesh.userData['tag'] = PRINT_SHELL_MESH_TAG;
  group.add(mesh);

  // Cache the Manifold so clearPrintableParts can release WASM memory
  // without the caller holding onto it.
  group.userData[PRINT_SHELL_MANIFOLD_KEY] = parts.printShell;

  const bbox = meshBbox(mesh);
  const offsetMax_mm = resolveExplodedOffset(bbox);

  const state: PrintableState = {
    mesh,
    offsetMax_mm,
    currentFraction: 0,
    targetFraction: 0,
    tweenStart_ms: null,
    tweenStartFraction: 0,
    rafId: 0,
    material,
  };
  setState(group, state);

  // Pin position at fraction=0 (collapsed). Default Mesh.position is zero
  // already, but explicit application ensures the invariant.
  applyFraction(state, 0);

  return { bbox, mesh };
}

/**
 * Remove the print shell from the scene, dispose GPU resources, and
 * `.delete()` the cached Manifold. Idempotent and safe on a scene with
 * no print shell installed.
 */
export function clearPrintableParts(scene: Scene): void {
  const group = findGroup(scene);
  if (!group) return;
  const state = getState(group);
  if (state) {
    cancelTween(state);
    state.material.dispose();
  }
  const existing = [...group.children];
  for (const child of existing) {
    if (child instanceof Mesh) disposeMeshGeometry(child);
  }
  disposeCachedManifold(group);
  setState(group, null);
  // Leave `group.visible` as-is; the next install resets it to true.
}

/**
 * Flip the visibility of the printable-parts group. Called by the
 * toolbar toggle. No-op when no parts are installed (defence-in-depth).
 */
export function setPrintablePartsVisible(scene: Scene, visible: boolean): void {
  const group = findGroup(scene);
  if (!group) return;
  const state = getState(group);
  if (!state) return;
  group.visible = visible;
  // When hidden, cancel any running tween so the RAF loop doesn't burn
  // CPU on invisible geometry. Snap to target so the next show reveals
  // the mesh at its intended rest position.
  if (!visible && state.rafId !== 0) {
    cancelTween(state);
    applyFraction(state, state.targetFraction);
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
 * Whether a print shell is currently installed. Used by the toolbar
 * toggle to gate enablement.
 */
export function hasPrintableParts(scene: Scene): boolean {
  const group = findGroup(scene);
  if (!group) return false;
  return getState(group) !== null;
}

/**
 * Toggle the exploded-view state for the print shell. `true` animates
 * the mesh to +Y; `false` collapses it. No-op when no shell is
 * installed OR when the group is hidden.
 */
export function setPrintablePartsExplodedView(scene: Scene, exploded: boolean): void {
  const group = findGroup(scene);
  if (!group) return;
  const state = getState(group);
  if (!state) return;
  const target = exploded ? 1 : 0;
  // If the group is hidden, snap to the target (no tween, no RAF) so
  // that the next setVisible(true) shows the mesh at the right place.
  if (!group.visible) {
    cancelTween(state);
    state.targetFraction = target;
    applyFraction(state, target);
    return;
  }
  startTween(state, target);
}

/**
 * Whether the exploded-view tween for the print shell is currently idle.
 * Returns `true` when no shell is installed, OR the group is hidden, OR
 * the tween has completed / never started.
 *
 * Used by visual-regression tests to gate `toHaveScreenshot` on a stable
 * scene (the tween runs on real wall-clock `performance.now()` which
 * Playwright's `page.clock` fake doesn't intercept). Mirror of
 * `isExplodedViewIdle` from silicone.ts.
 */
export function isPrintableExplodedIdle(scene: Scene): boolean {
  const group = findGroup(scene);
  if (!group) return true;
  const state = getState(group);
  if (!state) return true;
  if (!group.visible) return true;
  return state.rafId === 0 && state.tweenStart_ms === null;
}
