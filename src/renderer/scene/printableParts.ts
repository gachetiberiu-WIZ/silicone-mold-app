// src/renderer/scene/printableParts.ts
//
// Scene module owning the printable-box parts produced by the
// `generateSiliconeShell` generator (Phase 3d wave 2, issue #50). This
// mirrors the `scene/silicone.ts` lifecycle pattern (issue #47):
//
//   - exactly one set of printable parts live at a time,
//   - `setPrintableParts(scene, {base, sides, topCap})` disposes the
//     previous set (geometry + material + Manifold `.delete()`) before
//     installing the new one,
//   - `clearPrintableParts(scene)` is idempotent and safe on an empty
//     group (used by every staleness signal: commit, reset, new-STL).
//
// Ownership handoff:
//
//   The caller (`generateOrchestrator.ts` on the happy path) passes in
//   1 + N + 1 freshly-generated Manifolds. From the moment
//   `setPrintableParts` returns, THIS MODULE owns their lifetime — the
//   caller must NOT `.delete()` them again. Eviction happens on the next
//   `setPrintableParts` call, on any `clearPrintableParts` call, and on
//   viewport teardown.
//
// Frame alignment:
//
//   `buildPrintableBox` (via `generateSiliconeShell`) operates in the
//   post-viewport-transform frame — same as the silicone halves. So we
//   render the parts at world origin with no group transform. Double-
//   applying the master group's matrix would drift them away from the
//   visible silicone.
//
// Material:
//
//   `MeshStandardMaterial({ color: 0xb8b8b8, roughness: 0.8, metalness: 0 })`
//   — opaque "3D-print plastic" gray. No transparency (the issue wants
//   solid parts that occlude silicone when visible). Single material
//   instance shared across all 1 + N + 1 parts: reduces GPU state churn
//   and the per-material JSON is ~40 bytes each, so sharing saves a
//   handful of dispose calls without introducing a lifetime trap (the
//   module owns the one material and disposes it in teardown).
//
// Visibility:
//
//   The printable-parts group starts HIDDEN on every install
//   (`group.visible = false`). The toolbar toggle flips `visible` via
//   `setPrintablePartsVisible`. This is the issue-specified "default OFF"
//   — silicone + master is the easier-to-understand-at-a-glance default.
//
// Exploded view:
//
//   Each part has its own resting position and an exploded offset vector:
//     - base:    -Y  (floor drops below the origin)
//     - topCap:  +Y  (ceiling rises above)
//     - sides:   radially outward in XZ from the printable bbox XZ center
//                (each side's centroid XZ ray, normalised)
//   Magnitude: `offset = max(30, 0.2 * bboxHeight)` — same rule as
//   silicone (see `silicone.ts`) so the two animations stay visually
//   coordinated when both modules animate together.
//
//   The tween is fraction-based and per-module: a local RAF loop drives
//   `currentFraction` from 0 toward `targetFraction` over 250 ms. When
//   the group is hidden (`group.visible === false`) or the fraction is
//   already at its target, no RAF is scheduled — no wasted per-frame
//   work (issue #62 performance AC).
//
// Test-hook surface:
//
//   Module-level getters: `arePrintablePartsVisible`,
//   `isPrintableExplodedIdle`, `hasPrintableParts`. Exposed on the
//   viewport handle per issue #62. Read-only; no setters through the
//   test hook.

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

/** Per-mesh tags so tests can distinguish the pieces. */
const PRINTABLE_BASE_MESH_TAG = 'printable-base';
const PRINTABLE_TOP_CAP_MESH_TAG = 'printable-top-cap';
/** Prefix for per-side meshes: `printable-side-0`, `printable-side-1`, ... */
const PRINTABLE_SIDE_MESH_TAG_PREFIX = 'printable-side-';

/**
 * `userData` keys where we cache the Manifolds so teardown can release
 * them even if the Mesh nodes have been removed via another code path.
 * Exported so viewport-level dispose can read the same slots.
 */
export const PRINTABLE_BASE_MANIFOLD_KEY = 'printableBaseManifold';
export const PRINTABLE_TOP_CAP_MANIFOLD_KEY = 'printableTopCapManifold';
export const PRINTABLE_SIDES_MANIFOLDS_KEY = 'printableSidesManifolds';

/** Default exploded-offset floor in mm — same rule as silicone. */
const EXPLODED_OFFSET_FLOOR_MM = 30;
/** Fraction of bbox-height used for the exploded-offset ceiling. */
const EXPLODED_OFFSET_BBOX_FRACTION = 0.2;
/** Tween duration for exploded-view transitions. Matches silicone. */
const EXPLODED_TWEEN_MS = 250;

/**
 * Small helper: a per-part record stashed on the state so the tween can
 * translate each Mesh along its own precomputed exploded-offset vector
 * without re-deriving the direction on every RAF tick. `dir` is a
 * unit-length world-space vector; `mesh.position` is written as
 * `dir * (fraction * offsetMax)` each frame.
 */
interface PartTween {
  readonly mesh: Mesh;
  /** Unit-length direction (world frame). */
  readonly dir: Vector3;
}

/** Shape returned by `setPrintableParts`. */
export interface PrintablePartsResult {
  readonly bbox: Box3;
  readonly baseMesh: Mesh;
  readonly topCapMesh: Mesh;
  readonly sideMeshes: readonly Mesh[];
}

/**
 * Internal record stashed on the printable-parts group's `userData`.
 * Holds the tween targets + offset metadata + RAF handle so
 * `setPrintablePartsExplodedView` can update without re-traversing the
 * scene graph.
 */
interface PrintableState {
  baseMesh: Mesh;
  topCapMesh: Mesh;
  sideMeshes: Mesh[];
  /** Direction + mesh for every part in the tween set. */
  parts: PartTween[];
  /** Max magnitude (mm) applied at fraction=1. */
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
  /** Shared material used by every part, disposed in teardown. */
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
 * Remove a mesh from its parent. We do NOT dispose its geometry here —
 * the material is shared across all parts (disposed once at teardown)
 * and the geometry is per-mesh (disposed immediately per call).
 */
function disposeMeshGeometry(mesh: Mesh): void {
  mesh.geometry.dispose();
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
      console.warn(`[printableParts] disposing cached Manifold (${key}) threw:`, err);
    }
    delete group.userData[key];
  }
}

/**
 * Release all cached side-part Manifolds at once. Stored as an array on
 * userData since the count is dynamic (sideCount ∈ {2, 3, 4}).
 */
function disposeCachedSideManifolds(group: Group): void {
  const cached = group.userData[PRINTABLE_SIDES_MANIFOLDS_KEY] as
    | Manifold[]
    | undefined;
  if (Array.isArray(cached)) {
    for (const m of cached) {
      try {
        m.delete();
      } catch (err) {
        console.warn('[printableParts] disposing cached side Manifold threw:', err);
      }
    }
  }
  delete group.userData[PRINTABLE_SIDES_MANIFOLDS_KEY];
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
 * Create the shared opaque gray material. Single instance owned by the
 * state record — disposed once at teardown. Sharing across 6-ish parts
 * is safe because:
 *   - we never mutate material properties per-part,
 *   - teardown disposes the one shared reference (no double-dispose risk),
 *   - fresh `setPrintableParts` calls build a NEW material (they dispose
 *     the previous state including its material before installing).
 */
function createPrintableMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: 0xb8b8b8,
    roughness: 0.8,
    metalness: 0.0,
  });
}

/**
 * Compute the world-space AABB of all printable parts from their
 * BufferGeometries. The generator baked the viewport transform into the
 * Manifolds so the geometries are already in world frame.
 */
function unionBbox(meshes: readonly Mesh[]): Box3 {
  const box = new Box3();
  for (const mesh of meshes) {
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    if (bb) box.union(bb);
  }
  return box;
}

/**
 * Resolve the exploded-offset magnitude for a bbox. Applies the silicone
 * rule `max(30, 0.2 * bboxHeight)` for visual coordination between the
 * two modules (silicone + printable move in lockstep when both animate).
 */
function resolveExplodedOffset(bbox: Box3): number {
  const heightY = Math.max(0, bbox.max.y - bbox.min.y);
  return Math.max(
    EXPLODED_OFFSET_FLOOR_MM,
    heightY * EXPLODED_OFFSET_BBOX_FRACTION,
  );
}

/**
 * Compute per-part unit-vector directions for the exploded-view tween:
 *
 *   - base: straight -Y.
 *   - topCap: straight +Y.
 *   - sides: radially outward in XZ from the overall bbox XZ center,
 *     derived from each side mesh's own bbox center. For sideCount=3/4
 *     this produces the natural "petals opening" motion. For the (rare)
 *     degenerate case where a side's centroid coincides with the XZ
 *     center (numerically, within 1e-6 mm), we fall back to +X so the
 *     animation still produces motion rather than a silent no-op.
 *
 * Returns a `parts` array in the same order as `[base, ...sides, topCap]`
 * which matches the scene-graph add order.
 */
function computePartTweens(
  baseMesh: Mesh,
  sideMeshes: readonly Mesh[],
  topCapMesh: Mesh,
  unionBox: Box3,
): PartTween[] {
  const out: PartTween[] = [];
  out.push({ mesh: baseMesh, dir: new Vector3(0, -1, 0) });
  out.push({ mesh: topCapMesh, dir: new Vector3(0, 1, 0) });

  // XZ center of the union bbox — anchor for the radial direction.
  const center = new Vector3();
  unionBox.getCenter(center);

  for (const side of sideMeshes) {
    side.geometry.computeBoundingBox();
    const sideBox = side.geometry.boundingBox;
    // Defence-in-depth: if the side geometry is somehow empty, emit a
    // +X direction so the test still sees a finite motion vector.
    if (!sideBox) {
      out.push({ mesh: side, dir: new Vector3(1, 0, 0) });
      continue;
    }
    const sideCenter = new Vector3();
    sideBox.getCenter(sideCenter);
    const dx = sideCenter.x - center.x;
    const dz = sideCenter.z - center.z;
    const lenSq = dx * dx + dz * dz;
    // 1e-6 mm² threshold — below this the centroid is numerically at
    // the center and we'd divide by ~0.
    if (lenSq < 1e-12) {
      out.push({ mesh: side, dir: new Vector3(1, 0, 0) });
      continue;
    }
    const len = Math.sqrt(lenSq);
    out.push({ mesh: side, dir: new Vector3(dx / len, 0, dz / len) });
  }
  return out;
}

/**
 * Write the tween fraction into every part's `position`. `fraction = 0`
 * collapses all parts to their resting origin; `fraction = 1` places
 * each at `dir * offsetMax`.
 *
 * Group-level-transform rule applies: we write `mesh.position`, never
 * mutate the BufferGeometry. The printable-parts group stays at world
 * origin so the mesh's local offset equals world displacement.
 */
function applyFraction(state: PrintableState, fraction: number): void {
  const clamped = Math.max(0, Math.min(1, fraction));
  state.currentFraction = clamped;
  const mag = clamped * state.offsetMax_mm;
  for (const part of state.parts) {
    part.mesh.position.set(
      part.dir.x * mag,
      part.dir.y * mag,
      part.dir.z * mag,
    );
  }
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
  // If we're already at the target, no RAF work to do. This is the
  // "no wasted per-frame work when not moving" guarantee from the issue.
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
 * Install a freshly-generated set of printable-box Manifolds into the
 * scene's printable-parts group. Disposes the previous set first; only
 * one set is live at a time.
 *
 * Ownership: from the moment this function returns successfully, the
 * scene owns every Manifold. The caller MUST NOT `.delete()` them. The
 * next `setPrintableParts` call (or `clearPrintableParts`) evicts them.
 *
 * Visibility: the new group starts HIDDEN (`group.visible = false`)
 * regardless of the previous visibility state — fresh Generate, fresh
 * "user opts in to see it" toggle. Callers flip visibility via
 * `setPrintablePartsVisible(scene, true)` once the toolbar toggle is
 * flipped on.
 *
 * Failure mode: if any BufferGeometry adapter throws, we dispose any
 * partially-built geometries AND `.delete()` every input Manifold so
 * the caller's lifetime assumption still holds without leaking WASM.
 *
 * @throws If the scene is missing its printable-parts group.
 */
export async function setPrintableParts(
  scene: Scene,
  parts: {
    base: Manifold;
    sides: readonly Manifold[];
    topCap: Manifold;
  },
): Promise<PrintablePartsResult> {
  const group = findGroup(scene);
  if (!group) {
    // Ownership hasn't transferred — dispose on behalf of the caller so
    // the error branch doesn't leak WASM heap.
    try { parts.base.delete(); } catch { /* already dead */ }
    try { parts.topCap.delete(); } catch { /* already dead */ }
    for (const s of parts.sides) {
      try { s.delete(); } catch { /* already dead */ }
    }
    throw new Error(
      'setPrintableParts: scene is missing its printable-parts group ' +
        '(userData.tag === "printableParts"). createScene() must have run first.',
    );
  }

  // Build every BufferGeometry first — atomic replacement on failure.
  const sideGeoms: Array<Awaited<ReturnType<typeof manifoldToBufferGeometry>>> = [];
  let baseGeom: Awaited<ReturnType<typeof manifoldToBufferGeometry>> | undefined;
  let topCapGeom: Awaited<ReturnType<typeof manifoldToBufferGeometry>> | undefined;
  try {
    baseGeom = await manifoldToBufferGeometry(parts.base);
    for (const s of parts.sides) {
      sideGeoms.push(await manifoldToBufferGeometry(s));
    }
    topCapGeom = await manifoldToBufferGeometry(parts.topCap);
  } catch (err) {
    // Dispose anything already built + every caller-supplied Manifold.
    if (baseGeom) baseGeom.dispose();
    for (const g of sideGeoms) g.dispose();
    if (topCapGeom) topCapGeom.dispose();
    try { parts.base.delete(); } catch { /* already dead */ }
    try { parts.topCap.delete(); } catch { /* already dead */ }
    for (const s of parts.sides) {
      try { s.delete(); } catch { /* already dead */ }
    }
    throw err;
  }

  // Tear down the previous set atomically.
  const prev = getState(group);
  if (prev) {
    cancelTween(prev);
    // Dispose the previous material alongside the previous geometries.
    prev.material.dispose();
  }
  const existing = [...group.children];
  for (const child of existing) {
    if (child instanceof Mesh) disposeMeshGeometry(child);
  }
  disposeCachedManifold(group, PRINTABLE_BASE_MANIFOLD_KEY);
  disposeCachedManifold(group, PRINTABLE_TOP_CAP_MANIFOLD_KEY);
  disposeCachedSideManifolds(group);
  setState(group, null);

  // Fresh install starts hidden (issue #62 AC: default OFF).
  group.visible = false;

  // One shared material for the whole set.
  const material = createPrintableMaterial();

  // Build the meshes. The scene-graph add order matters only for
  // `group.children` traversal stability in tests — `[base, ...sides, topCap]`
  // matches the input parameter order so tests can index deterministically.
  const baseMesh = new Mesh(baseGeom, material);
  baseMesh.userData['tag'] = PRINTABLE_BASE_MESH_TAG;
  group.add(baseMesh);

  const sideMeshes: Mesh[] = [];
  for (let i = 0; i < sideGeoms.length; i++) {
    const sg = sideGeoms[i];
    if (!sg) continue;
    const m = new Mesh(sg, material);
    m.userData['tag'] = `${PRINTABLE_SIDE_MESH_TAG_PREFIX}${i}`;
    group.add(m);
    sideMeshes.push(m);
  }

  const topCapMesh = new Mesh(topCapGeom, material);
  topCapMesh.userData['tag'] = PRINTABLE_TOP_CAP_MESH_TAG;
  group.add(topCapMesh);

  // Cache the Manifolds on the group so clearPrintableParts can release
  // WASM memory without needing the caller to hold onto them.
  group.userData[PRINTABLE_BASE_MANIFOLD_KEY] = parts.base;
  group.userData[PRINTABLE_TOP_CAP_MANIFOLD_KEY] = parts.topCap;
  group.userData[PRINTABLE_SIDES_MANIFOLDS_KEY] = [...parts.sides];

  // Compute union bbox + exploded offset magnitude + per-part directions.
  const allMeshes: Mesh[] = [baseMesh, ...sideMeshes, topCapMesh];
  const bbox = unionBbox(allMeshes);
  const offsetMax_mm = resolveExplodedOffset(bbox);
  const partsTween = computePartTweens(baseMesh, sideMeshes, topCapMesh, bbox);

  const state: PrintableState = {
    baseMesh,
    topCapMesh,
    sideMeshes,
    parts: partsTween,
    offsetMax_mm,
    currentFraction: 0,
    targetFraction: 0,
    tweenStart_ms: null,
    tweenStartFraction: 0,
    rafId: 0,
    material,
  };
  setState(group, state);

  // Pin positions at fraction=0 (collapsed). Default Mesh.position is
  // zero already, but explicit application ensures the invariant.
  applyFraction(state, 0);

  return { bbox, baseMesh, topCapMesh, sideMeshes };
}

/**
 * Remove all printable parts from the scene, dispose GPU resources, and
 * `.delete()` every cached Manifold. Idempotent and safe on a scene
 * with no printable parts installed.
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
  disposeCachedManifold(group, PRINTABLE_BASE_MANIFOLD_KEY);
  disposeCachedManifold(group, PRINTABLE_TOP_CAP_MANIFOLD_KEY);
  disposeCachedSideManifolds(group);
  setState(group, null);
  // Leave `group.visible` as-is; the next install resets it to false.
  // A consumer that clears + immediately queries `arePrintablePartsVisible`
  // should see false (enforced by the no-state guard in that getter).
}

/**
 * Flip the visibility of the whole printable-parts group. Called by the
 * toolbar toggle. No-op when no parts are installed (defence-in-depth;
 * the toolbar toggle's enable-gate already prevents it in production).
 */
export function setPrintablePartsVisible(scene: Scene, visible: boolean): void {
  const group = findGroup(scene);
  if (!group) return;
  const state = getState(group);
  if (!state) return;
  group.visible = visible;
  // When parts are hidden, cancel any running tween so the RAF loop
  // doesn't keep burning CPU on invisible geometry (issue #62 perf AC).
  // The tween's CURRENT and TARGET fractions are preserved so the next
  // visible transition resumes from the expected state.
  if (!visible && state.rafId !== 0) {
    cancelTween(state);
    // Snap to the target fraction so the next show reveals parts at
    // their intended rest position (not mid-tween).
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
 * Whether a printable-parts set is currently installed. Used by the
 * toolbar toggle to gate enablement.
 */
export function hasPrintableParts(scene: Scene): boolean {
  const group = findGroup(scene);
  if (!group) return false;
  return getState(group) !== null;
}

/**
 * Toggle the exploded-view state for printable parts. `true` animates
 * base/topCap/sides to their exploded positions; `false` collapses them.
 * No-op when no parts are installed OR when the group is hidden — the
 * issue's perf AC demands the tween stay idle when nothing is visible.
 *
 * The tween DOES still run while hidden if we wanted (for "pre-animate
 * before reveal" patterns), but the issue explicitly calls out the
 * wasted-work concern, so we short-circuit here. Callers that flip
 * visibility ON while exploded is already desired should either:
 *   (a) set visibility ON first, then call this, or
 *   (b) use the main.ts pattern: track a module-level "exploded"
 *       boolean in the UI layer, and apply it after every `setVisible(true)`.
 */
export function setPrintablePartsExplodedView(scene: Scene, exploded: boolean): void {
  const group = findGroup(scene);
  if (!group) return;
  const state = getState(group);
  if (!state) return;
  const target = exploded ? 1 : 0;
  // If the group is hidden, snap to the target (no tween, no RAF) so
  // that the next setVisible(true) shows parts at the right place.
  if (!group.visible) {
    cancelTween(state);
    state.targetFraction = target;
    applyFraction(state, target);
    return;
  }
  startTween(state, target);
}

/**
 * Whether the exploded-view tween for printable parts is currently idle.
 * Returns `true` when no parts are installed, OR the group is hidden, OR
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
  // Hidden implies idle — we cancel the tween on hide.
  if (!group.visible) return true;
  return state.rafId === 0 && state.tweenStart_ms === null;
}
