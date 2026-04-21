// src/renderer/scene/silicone.ts
//
// Scene module owning the silicone Manifold produced by the
// `generateSiliconeShell` generator. Post-Wave-A (issue #69) the silicone
// is a SINGLE mesh — the horizontal split + mating registration keys from
// the pre-#69 two-halves-in-box pipeline are gone. This mirrors the
// `scene/master.ts` + `scene/printableParts.ts` lifecycle pattern:
//
//   - one silicone mesh live at a time,
//   - `setSilicone(scene, {silicone})` disposes the previous mesh
//     (geometry, material, and Manifold `.delete()`) before installing
//     the new one,
//   - `clearSilicone(scene)` is idempotent and safe on an empty group
//     (used by every staleness signal: commit, reset, new-STL).
//
// Ownership handoff:
//
//   The caller (`generateOrchestrator.ts` on the happy path) passes in
//   one freshly-generated Manifold. From the moment `setSilicone`
//   returns, THIS MODULE owns its lifetime — the caller must NOT
//   `.delete()` it again. Eviction happens on the next `setSilicone`
//   call, on any `clearSilicone` call, and on viewport teardown.
//
// Frame alignment:
//
//   `generateSiliconeShell` applies the Master group's world matrix to
//   the master Manifold INSIDE the generator, so the silicone Manifold
//   it returns is ALREADY in the world frame. That means we render it at
//   world origin with no group transform — no rotation, no translation.
//   If we composed the Master group's transform on top, we'd double-
//   apply it and the silicone would drift away from the visible master.
//
// Material:
//
//   `MeshStandardMaterial({ color: 0x4a9eff, transparent: true,
//                           opacity: 0.35, side: DoubleSide,
//                           depthWrite: false, roughness: 0.6,
//                           metalness: 0.0 })`
//
// Exploded view:
//
//   Post-Wave-A the silicone is one piece, so "exploded" now lifts the
//   entire silicone mesh along +Y. Offset rule carries over from the
//   pre-#69 halves pipeline: `max(30 mm, 0.2 * bboxHeight_mm)`. Printable
//   parts (base, sides, cap) retain their own per-part radial/axial
//   tweens in `printableParts.ts` — those are coordinated with this
//   single-mesh lift so the overall assembly reads cleanly when both
//   modules animate together.
//
// Test-hook surface:
//
//   No module-level hooks exposed here. Consumers go through `scene` +
//   traversal (`userData.tag === 'silicone-body'`) — same contract as
//   the master / printable-parts modules.

import {
  Box3,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  type Scene,
} from 'three';
import type { Manifold } from 'manifold-3d';

import { manifoldToBufferGeometry } from '@/geometry/adapters';

/** Tag on the silicone group created in `scene/index.ts`. */
const SILICONE_GROUP_TAG = 'silicone';

/**
 * Tag on the single silicone mesh child. Post-Wave-A we have ONE mesh,
 * not two halves, so the old upper / lower tags are gone. Tests + specs
 * that traversed by those tags have been updated to use this one.
 */
const SILICONE_BODY_MESH_TAG = 'silicone-body';

/**
 * `userData` key where we cache the Manifold so `clearSilicone` can
 * release it even if the Mesh has been removed by some other code path.
 * Exported so future code (a dispose hook on viewport teardown) can read
 * the same slot.
 */
export const SILICONE_MANIFOLD_KEY = 'siliconeManifold';

/** Default exploded-offset floor in mm (`max(30, 0.2 * bboxHeight)`). */
const EXPLODED_OFFSET_FLOOR_MM = 30;
/** Fraction of bbox-height used for the exploded-offset ceiling. */
const EXPLODED_OFFSET_BBOX_FRACTION = 0.2;
/** Tween duration for exploded-view transitions. */
const EXPLODED_TWEEN_MS = 250;

/**
 * Shape returned by `setSilicone`. `bbox` is the world-space AABB of the
 * silicone mesh computed from the Manifold before any exploded-view
 * offset has been applied. Callers use it to frame the camera over the
 * master + silicone union.
 */
export interface SiliconeResult {
  readonly bbox: Box3;
  readonly mesh: Mesh;
}

/**
 * Internal record stashed on the silicone group's `userData` so
 * `setExplodedView` can locate the tween target + rest position without
 * re-traversing the scene graph on every RAF tick.
 */
interface SiliconeState {
  mesh: Mesh;
  /** Max +Y offset applied at fraction=1. */
  offsetMax_mm: number;
  /** Current exploded fraction in [0, 1]: 0 = collapsed, 1 = fully lifted. */
  currentFraction: number;
  /** Target exploded fraction; the tween walks `currentFraction` to this. */
  targetFraction: number;
  /** `performance.now()` at which the in-flight tween started (null = idle). */
  tweenStart_ms: number | null;
  /** Starting fraction at tween-start — lets mid-flight reversals tween smoothly. */
  tweenStartFraction: number;
  /** RAF handle for the in-flight tween (0 = none). */
  rafId: number;
}

/** `userData` key on the silicone group where the state record lives. */
const SILICONE_STATE_KEY = 'siliconeState';

function findSiliconeGroup(scene: Scene): Group | null {
  for (const child of scene.children) {
    if (
      child.userData['tag'] === SILICONE_GROUP_TAG &&
      child instanceof Group
    ) {
      return child;
    }
  }
  return null;
}

function getState(group: Group): SiliconeState | null {
  const s = group.userData[SILICONE_STATE_KEY] as SiliconeState | undefined;
  return s ?? null;
}
function setState(group: Group, state: SiliconeState | null): void {
  if (state === null) {
    delete group.userData[SILICONE_STATE_KEY];
  } else {
    group.userData[SILICONE_STATE_KEY] = state;
  }
}

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

function disposeCachedManifold(group: Group, key: string): void {
  const cached = group.userData[key] as Manifold | undefined;
  if (cached) {
    try {
      cached.delete();
    } catch (err) {
      console.warn(`[silicone] disposing cached Manifold (${key}) threw:`, err);
    }
    delete group.userData[key];
  }
}

function cancelTween(state: SiliconeState): void {
  if (state.rafId !== 0) {
    cancelAnimationFrame(state.rafId);
    state.rafId = 0;
  }
  state.tweenStart_ms = null;
}

function createSiliconeMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: 0x4a9eff,
    transparent: true,
    opacity: 0.35,
    side: DoubleSide,
    depthWrite: false,
    roughness: 0.6,
    metalness: 0.0,
  });
}

/**
 * Compute the world-space AABB of the silicone mesh from its
 * BufferGeometry.
 */
function meshBbox(mesh: Mesh): Box3 {
  mesh.geometry.computeBoundingBox();
  const box = new Box3();
  if (mesh.geometry.boundingBox) {
    box.copy(mesh.geometry.boundingBox);
  }
  return box;
}

function resolveExplodedOffset(bbox: Box3): number {
  const heightY = Math.max(0, bbox.max.y - bbox.min.y);
  return Math.max(
    EXPLODED_OFFSET_FLOOR_MM,
    heightY * EXPLODED_OFFSET_BBOX_FRACTION,
  );
}

/**
 * Apply a fractional exploded offset to the silicone mesh. `fraction = 0`
 * collapses it back to rest (y = 0); `fraction = 1` lifts it by
 * `+offsetMax` along Y.
 */
function applyFraction(state: SiliconeState, fraction: number): void {
  const clamped = Math.max(0, Math.min(1, fraction));
  state.currentFraction = clamped;
  state.mesh.position.y = clamped * state.offsetMax_mm;
}

function startTween(state: SiliconeState, targetFraction: number): void {
  cancelTween(state);
  state.targetFraction = targetFraction;
  state.tweenStartFraction = state.currentFraction;
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
 * Install a freshly-generated silicone Manifold into the scene's silicone
 * group. Disposes any previously-installed mesh first — only one is live
 * at a time, matching the `setMaster` / `setPrintableParts` invariant.
 *
 * Ownership: from the moment this function returns successfully, the
 * scene owns the Manifold. The caller MUST NOT `.delete()` it. The next
 * `setSilicone` call (or `clearSilicone`) evicts it via the same
 * cached-handle path `scene/master.ts` uses.
 *
 * Failure mode: if the BufferGeometry adapter throws, we dispose any
 * partially-built state AND delete the Manifold so the caller's lifetime
 * assumption ("ownership transferred, don't double-free") still holds
 * without leaking WASM memory.
 *
 * @throws If the scene is missing its silicone group (developer error).
 */
export async function setSilicone(
  scene: Scene,
  payload: { silicone: Manifold },
): Promise<SiliconeResult> {
  const group = findSiliconeGroup(scene);
  if (!group) {
    try { payload.silicone.delete(); } catch { /* already dead */ }
    throw new Error(
      'setSilicone: scene is missing its silicone group (userData.tag === "silicone"). ' +
        'createScene() must have run first.',
    );
  }

  // Build display geometry FIRST, before touching the existing children.
  // If the adapter throws, we never entered the "swap in progress"
  // state — easy recovery.
  let geom;
  try {
    geom = await manifoldToBufferGeometry(payload.silicone);
  } catch (err) {
    try { payload.silicone.delete(); } catch { /* already dead */ }
    throw err;
  }

  // Now swap. Tear down the previous mesh + manifold + tween
  // atomically before installing the new one.
  const prev = getState(group);
  if (prev) cancelTween(prev);
  const existing = [...group.children];
  for (const child of existing) {
    if (child instanceof Mesh) disposeMesh(child);
  }
  disposeCachedManifold(group, SILICONE_MANIFOLD_KEY);
  setState(group, null);

  // Install the new mesh.
  const mesh = new Mesh(geom, createSiliconeMaterial());
  mesh.userData['tag'] = SILICONE_BODY_MESH_TAG;
  group.add(mesh);

  // Cache the Manifold on the group so `clearSilicone` (and future
  // disposal paths) can release WASM memory without needing the caller
  // to hold onto it.
  group.userData[SILICONE_MANIFOLD_KEY] = payload.silicone;

  const bbox = meshBbox(mesh);
  const offsetMax_mm = resolveExplodedOffset(bbox);

  const state: SiliconeState = {
    mesh,
    offsetMax_mm,
    currentFraction: 0,
    targetFraction: 0,
    tweenStart_ms: null,
    tweenStartFraction: 0,
    rafId: 0,
  };
  setState(group, state);

  // Fresh silicone renders collapsed (fraction=0). Explicitly apply to
  // pin the initial Y — positions default to zero on a fresh Mesh, but
  // we assert via the test that the invariant holds.
  applyFraction(state, 0);

  return { bbox, mesh };
}

/**
 * Remove the silicone mesh from the scene, dispose its GPU resources,
 * and `.delete()` the cached Manifold. Idempotent and safe to call on
 * a scene that has no silicone installed — every staleness signal
 * (commit, reset, new-STL, viewport teardown) routes through this one
 * function.
 */
export function clearSilicone(scene: Scene): void {
  const group = findSiliconeGroup(scene);
  if (!group) return;
  const state = getState(group);
  if (state) cancelTween(state);
  const existing = [...group.children];
  for (const child of existing) {
    if (child instanceof Mesh) disposeMesh(child);
  }
  disposeCachedManifold(group, SILICONE_MANIFOLD_KEY);
  setState(group, null);
}

/**
 * Toggle the exploded-view state. `true` animates the silicone mesh
 * upward over ~250 ms; `false` collapses it back. No-op when no silicone
 * is installed.
 */
export function setExplodedView(scene: Scene, exploded: boolean): void {
  const group = findSiliconeGroup(scene);
  if (!group) return;
  const state = getState(group);
  if (!state) return;
  startTween(state, exploded ? 1 : 0);
}

/** Whether silicone is currently installed. */
export function hasSilicone(scene: Scene): boolean {
  const group = findSiliconeGroup(scene);
  if (!group) return false;
  return getState(group) !== null;
}

/**
 * Whether the exploded-view tween is currently idle (no RAF in flight).
 * Returns `true` when no silicone is installed at all, or when the
 * installed mesh's tween has completed (or never started).
 *
 * Used by visual-regression tests to gate `toHaveScreenshot` on a stable
 * scene — the tween runs off real-wall-clock `performance.now()` and
 * `requestAnimationFrame`, neither of which Playwright's `page.clock`
 * fake intercepts, so tests can't fast-forward it. Read-only: this
 * function never mutates scene state. Safe to poll.
 */
export function isExplodedViewIdle(scene: Scene): boolean {
  const group = findSiliconeGroup(scene);
  if (!group) return true;
  const state = getState(group);
  if (!state) return true;
  return state.rafId === 0 && state.tweenStart_ms === null;
}
