// src/renderer/scene/silicone.ts
//
// Scene module owning the two silicone-half meshes produced by the
// `generateSiliconeShell` generator (Phase 3d wave 1, issue #47). This
// mirrors the `scene/master.ts` lifecycle pattern:
//
//   - one silicone-half pair live at a time,
//   - `setSilicone(scene, halves)` disposes the previous pair (geometry,
//     material, and Manifold `.delete()`) before installing the new one,
//   - `clearSilicone(scene)` is idempotent and safe on an empty group
//     (used by every staleness signal: commit, reset, new-STL).
//
// Ownership handoff:
//
//   The caller (`generateOrchestrator.ts` on the happy path) passes in
//   two freshly-generated Manifolds. From the moment `setSilicone` returns,
//   THIS MODULE owns their lifetime — the caller must NOT `.delete()` them
//   again. Eviction happens on the next `setSilicone` call, on any
//   `clearSilicone` call, and on viewport teardown (future hook).
//
// Frame alignment (the non-obvious bit):
//
//   `generateSiliconeShell` applies the Master group's world matrix to the
//   master Manifold INSIDE the generator, so the half-Manifolds it returns
//   are ALREADY in the world frame. That means we render them at world
//   origin with no group transform — no rotation, no translation. If we
//   composed the Master group's transform on top, we'd double-apply it and
//   the halves would drift away from the visible master.
//
// Material:
//
//   `MeshStandardMaterial({ color: 0x4a9eff, transparent: true,
//                           opacity: 0.35, side: DoubleSide,
//                           depthWrite: false, roughness: 0.6,
//                           metalness: 0.0 })`
//
//   `0x4a9eff` matches the CSS `--accent` token — silicone reads as
//   "app-blue translucent". `depthWrite: false` is the standard
//   translucent-mesh dance: it avoids self-z-fighting between a pair of
//   overlapping translucent bodies' front and back faces. No new colour
//   tokens introduced.
//
// Exploded view:
//
//   The parting plane is always horizontal in v1 (`[0, 1, 0]` normal;
//   see `src/geometry/generateMold.ts` step 4). Exploded offset is ±Y:
//     offset = max(30, 0.2 * bboxHeight_mm)
//   Tween over 250 ms via a lightweight RAF loop owned by this module.
//   No new tween library — vanilla `performance.now` + clamp-to-[0,1].
//
// Test-hook surface:
//
//   No module-level hooks exposed here. Consumers go through `scene` +
//   traversal (`userData.tag === 'silicone'`) — same contract master /
//   lay-flat use. The siblings keep the test API surface small.

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

/** Per-mesh tags so tests can distinguish the two halves. */
const SILICONE_UPPER_MESH_TAG = 'silicone-upper';
const SILICONE_LOWER_MESH_TAG = 'silicone-lower';

/**
 * `userData` keys where we cache the Manifolds so `clearSilicone` can
 * release them even if the Mesh nodes have been removed by some other
 * code path. Exported so future code (a dispose hook on viewport
 * teardown) can read the same slots.
 */
export const SILICONE_UPPER_MANIFOLD_KEY = 'siliconeUpperManifold';
export const SILICONE_LOWER_MANIFOLD_KEY = 'siliconeLowerManifold';

/** Default exploded-offset floor in mm (AC: `max(30, 0.2 * bboxHeight)`). */
const EXPLODED_OFFSET_FLOOR_MM = 30;
/** Fraction of bbox-height used for the exploded-offset ceiling. */
const EXPLODED_OFFSET_BBOX_FRACTION = 0.2;
/** Tween duration for exploded-view transitions. */
const EXPLODED_TWEEN_MS = 250;

/**
 * Shape returned by `setSilicone`. `bbox` is the world-space AABB of
 * the COMBINED halves (upper ∪ lower) computed from the Manifolds before
 * any exploded-view offset has been applied. Callers use it to frame the
 * camera over the master + silicone union.
 */
export interface SiliconeResult {
  readonly bbox: Box3;
  readonly upperMesh: Mesh;
  readonly lowerMesh: Mesh;
}

/**
 * Internal record stashed on the silicone group's `userData` so
 * `setExplodedView` can locate the tween target + Y-resting positions
 * without re-traversing the scene graph on every RAF tick.
 */
interface SiliconeState {
  upperMesh: Mesh;
  lowerMesh: Mesh;
  /** Max +Y offset for the upper mesh (lower mesh uses −offsetMax). */
  offsetMax_mm: number;
  /** Current exploded fraction in [0, 1]: 0 = collapsed, 1 = fully apart. */
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

/**
 * Locate the silicone group in `scene` by its `userData.tag`. Returns
 * `null` if the scene skeleton is missing the group — caller treats that
 * as a developer error.
 */
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

/**
 * Read (or null-out) the state record cached on the silicone group.
 * The record is populated inside `setSilicone` and cleared inside
 * `clearSilicone`.
 */
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

/**
 * Dispose a mesh's GPU resources (geometry + material) and remove it from
 * its parent. Safe on a mesh without a parent (no-op on the removal half).
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
 * Release a cached Manifold on the group's userData and clear the slot.
 * Idempotent. `.delete()` releases the underlying WASM heap allocation —
 * dropping the JS reference without calling it would leak.
 */
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

/**
 * Cancel any in-flight exploded-view tween. Safe to call on idle state.
 * Used inside `setSilicone` (we fully reset on every swap) and
 * `clearSilicone` (idempotent teardown).
 */
function cancelTween(state: SiliconeState): void {
  if (state.rafId !== 0) {
    cancelAnimationFrame(state.rafId);
    state.rafId = 0;
  }
  state.tweenStart_ms = null;
}

/**
 * Create the shared translucent silicone material. One fresh copy per
 * mesh so each is independently disposable — sharing would complicate
 * the per-half teardown path. At two halves × a few materials' worth of
 * uniforms, the memory cost is negligible.
 */
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
 * Compute the world-space AABB of the combined halves from the halves'
 * BufferGeometries. We trust manifold-3d's `boundingBox()` but take it
 * from the BufferGeometry post-conversion for consistency with the
 * rendered mesh (the generator applied the view transform to the
 * Manifold so both are in world frame).
 */
function unionBbox(upperMesh: Mesh, lowerMesh: Mesh): Box3 {
  const box = new Box3();
  upperMesh.geometry.computeBoundingBox();
  lowerMesh.geometry.computeBoundingBox();
  if (upperMesh.geometry.boundingBox) {
    box.union(upperMesh.geometry.boundingBox);
  }
  if (lowerMesh.geometry.boundingBox) {
    box.union(lowerMesh.geometry.boundingBox);
  }
  return box;
}

/**
 * Resolve the exploded-offset distance for a given combined bbox. Applies
 * the AC rule: `max(30 mm, 0.2 * bboxHeight)`. The bbox-height is the Y
 * extent of the combined silicone AABB — for a horizontal parting plane
 * the halves sit stacked along Y, so this is the natural metric.
 */
function resolveExplodedOffset(bbox: Box3): number {
  const heightY = Math.max(0, bbox.max.y - bbox.min.y);
  return Math.max(
    EXPLODED_OFFSET_FLOOR_MM,
    heightY * EXPLODED_OFFSET_BBOX_FRACTION,
  );
}

/**
 * Apply a fractional exploded offset to the half meshes. `fraction = 0`
 * collapses both halves to y = 0 (resting); `fraction = 1` pushes the
 * upper half to `+offsetMax` and the lower half to `−offsetMax` along Y.
 *
 * Writing `mesh.position.y` is the group-level-transform rule applied to
 * the mesh itself — we never mutate the BufferGeometry vertex data. The
 * halves share a silicone group that always stays at world origin, so
 * the mesh's local Y offset equals the world displacement.
 */
function applyFraction(state: SiliconeState, fraction: number): void {
  const clamped = Math.max(0, Math.min(1, fraction));
  state.currentFraction = clamped;
  state.upperMesh.position.y = clamped * state.offsetMax_mm;
  state.lowerMesh.position.y = -clamped * state.offsetMax_mm;
}

/**
 * Kick off (or update) an exploded-view tween toward `targetFraction`.
 * Uses a lightweight RAF loop owned by this module — no external tween
 * library. Reversing mid-flight is handled by snapshotting
 * `tweenStartFraction` at the moment the new target is set.
 *
 * Linear easing — the tween is short (250 ms) and the motion is along a
 * single axis, so the lack of easing is imperceptible. Keeping it linear
 * also makes the math testable without a timing harness.
 */
function startTween(state: SiliconeState, targetFraction: number): void {
  // Cancel any previous tween and re-seed from the CURRENT fraction so
  // reversals are smooth: "mid-open" → "close" tweens from wherever the
  // halves actually are, not from 1 (or 0).
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
 * Install a freshly-generated pair of silicone half-Manifolds into the
 * scene's silicone group. Disposes any previously-installed pair first —
 * only one pair is live at a time, matching the `setMaster` invariant.
 *
 * Ownership: from the moment this function returns successfully, the
 * scene owns both Manifolds. The caller MUST NOT `.delete()` them. The
 * next `setSilicone` call (or `clearSilicone`) evicts them via the same
 * cached-handle path `scene/master.ts` uses.
 *
 * Failure mode: if either BufferGeometry adapter throws, we dispose any
 * partially-built state AND delete both Manifolds so the caller's
 * lifetime assumption ("ownership transferred, don't double-free") still
 * holds without leaking WASM memory.
 *
 * @throws If the scene is missing its silicone group (developer error).
 */
export async function setSilicone(
  scene: Scene,
  halves: { upper: Manifold; lower: Manifold },
): Promise<SiliconeResult> {
  const group = findSiliconeGroup(scene);
  if (!group) {
    // Ownership transfer hasn't happened yet; dispose the caller's
    // Manifolds so the error path doesn't leak WASM heap.
    try { halves.upper.delete(); } catch { /* already dead */ }
    try { halves.lower.delete(); } catch { /* already dead */ }
    throw new Error(
      'setSilicone: scene is missing its silicone group (userData.tag === "silicone"). ' +
        'createScene() must have run first.',
    );
  }

  // Build display geometries for both halves FIRST, before touching the
  // existing children. If the adapter throws on one of them, we never
  // entered the "swap in progress" state — easy recovery.
  let upperGeom;
  let lowerGeom;
  try {
    upperGeom = await manifoldToBufferGeometry(halves.upper);
    lowerGeom = await manifoldToBufferGeometry(halves.lower);
  } catch (err) {
    // Ownership transfer never completes on the error branch — dispose
    // both Manifolds and anything we'd already built.
    if (upperGeom) upperGeom.dispose();
    try { halves.upper.delete(); } catch { /* already dead */ }
    try { halves.lower.delete(); } catch { /* already dead */ }
    throw err;
  }

  // Now swap. Tear down the previous pair (meshes + manifolds + tween)
  // atomically before installing the new one.
  const prev = getState(group);
  if (prev) cancelTween(prev);
  const existing = [...group.children];
  for (const child of existing) {
    if (child instanceof Mesh) disposeMesh(child);
  }
  disposeCachedManifold(group, SILICONE_UPPER_MANIFOLD_KEY);
  disposeCachedManifold(group, SILICONE_LOWER_MANIFOLD_KEY);
  setState(group, null);

  // Install the new meshes. One material instance per mesh so per-half
  // disposal is independent.
  const upperMesh = new Mesh(upperGeom, createSiliconeMaterial());
  upperMesh.userData['tag'] = SILICONE_UPPER_MESH_TAG;
  const lowerMesh = new Mesh(lowerGeom, createSiliconeMaterial());
  lowerMesh.userData['tag'] = SILICONE_LOWER_MESH_TAG;
  group.add(upperMesh);
  group.add(lowerMesh);

  // Cache the Manifolds on the group so `clearSilicone` (and future
  // disposal paths) can release WASM memory without needing the caller
  // to hold onto them.
  group.userData[SILICONE_UPPER_MANIFOLD_KEY] = halves.upper;
  group.userData[SILICONE_LOWER_MANIFOLD_KEY] = halves.lower;

  // Combined world-space bbox + exploded-offset computation.
  const bbox = unionBbox(upperMesh, lowerMesh);
  const offsetMax_mm = resolveExplodedOffset(bbox);

  const state: SiliconeState = {
    upperMesh,
    lowerMesh,
    offsetMax_mm,
    currentFraction: 0,
    targetFraction: 0,
    tweenStart_ms: null,
    tweenStartFraction: 0,
    rafId: 0,
  };
  setState(group, state);

  // Fresh halves render collapsed (fraction=0). Explicitly apply to pin
  // the initial Y — positions default to zero on a fresh Mesh, but we
  // assert via the test the invariant holds.
  applyFraction(state, 0);

  return { bbox, upperMesh, lowerMesh };
}

/**
 * Remove both silicone halves from the scene, dispose their GPU resources,
 * and `.delete()` the paired Manifolds. Idempotent and safe to call on a
 * scene that has no silicone installed — every staleness signal (commit,
 * reset, new-STL, viewport teardown) routes through this one function.
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
  disposeCachedManifold(group, SILICONE_UPPER_MANIFOLD_KEY);
  disposeCachedManifold(group, SILICONE_LOWER_MANIFOLD_KEY);
  setState(group, null);
}

/**
 * Toggle the exploded-view state. `true` animates the halves apart over
 * ~250 ms; `false` collapses them back. No-op when no silicone is
 * installed — the toggle's enabled-gate in the UI prevents that path
 * in production, but we short-circuit here for defence-in-depth.
 *
 * Mid-flight toggles are supported: the tween re-seeds from the current
 * fraction so a user who flips the toggle back before the animation
 * completes doesn't see a snap.
 */
export function setExplodedView(scene: Scene, exploded: boolean): void {
  const group = findSiliconeGroup(scene);
  if (!group) return;
  const state = getState(group);
  if (!state) return;
  startTween(state, exploded ? 1 : 0);
}

/**
 * Whether silicone is currently installed. Used by the toolbar toggle's
 * enable/disable wiring — `true` when there's something worth exploding.
 */
export function hasSilicone(scene: Scene): boolean {
  const group = findSiliconeGroup(scene);
  if (!group) return false;
  return getState(group) !== null;
}

/**
 * Whether the exploded-view tween is currently idle (no RAF in flight).
 * Returns `true` when no silicone is installed at all, or when the installed
 * pair's tween has completed (or never started).
 *
 * Used by visual-regression tests to gate `toHaveScreenshot` on a stable
 * scene — the tween runs off real-wall-clock `performance.now()` and
 * `requestAnimationFrame`, neither of which Playwright's `page.clock` fake
 * intercepts, so tests can't fast-forward it. Reading this hook lets a spec
 * `waitForFunction` until the scene has fully converged before snapshotting.
 *
 * Read-only: this function never mutates scene state. It's safe to poll.
 */
export function isExplodedViewIdle(scene: Scene): boolean {
  const group = findSiliconeGroup(scene);
  if (!group) return true;
  const state = getState(group);
  if (!state) return true;
  return state.rafId === 0 && state.tweenStart_ms === null;
}
