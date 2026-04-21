// src/renderer/scene/layFlatController.ts
//
// Orchestrator for the "Place on face" (lay-flat) interaction. Binds
// pointer events on the canvas, manages the hover-highlight mesh + the
// normal-overlay quad, and commits the rotation when the user clicks a
// face.
//
// Shape of the state machine:
//
//   idle           — no listeners; widgets invisible.
//   activating     — transitions handled inline in enable(); no state flag.
//   active-hover   — listening for pointermove; hover widgets follow cursor.
//   active-miss    — same listeners but cursor isn't over mesh; widgets off.
//   committing     — one-shot: applies rotation, recenters, re-frames camera,
//                    then auto-exits back to idle per the issue spec:
//                    "picking mode auto-exits on commit".
//
// Escape key exits from any active sub-state. The viewport handle owns
// the lifecycle so this module doesn't need to track it explicitly.
//
// Design constraints (issue #32):
//
//   - Group-level transform only. Never mutate BufferGeometry.
//   - `group.quaternion.premultiply(q)` compose order so repeated lay-flats
//     chain correctly.
//   - Re-run auto-center (`recenterGroup`) after rotation so the mesh
//     doesn't float above the bed.
//   - Re-frame camera after commit.
//
// This module is purposefully renderer-thin: it allocates its hover/
// overlay widgets lazily on enable, and disposes them on disable so
// the scene graph stays quiet when the mode is off.

import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  type PerspectiveCamera,
  type Scene,
  Vector3,
} from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { frameToBox3 } from './camera';
import {
  computeWorldBoxTight,
  quaternionToAlignFaceDown,
  recenterGroup,
  resetOrientation,
} from './layFlat';
import { pickFaceUnderPointer, type PickResult } from './picking';

/** Accent blue matching the app's CSS `--accent` variable (`#4a9eff`). */
const ACCENT_COLOR = 0x4a9eff;

/** Widgets live under the scene's `userData.tag === 'widgets'` group. */
const WIDGETS_GROUP_TAG = 'widgets';

/** Tag applied to our group of lay-flat widgets so tests can find it. */
export const LAY_FLAT_WIDGETS_TAG = 'lay-flat-widgets';

/**
 * Custom event fired on `document` whenever the lay-flat controller's active
 * state changes. Consumers (e.g. the UI toggle button) listen so they can
 * reflect the auto-exit-on-commit transition back into their own state
 * without polling the viewport handle on every animation frame.
 *
 * Detail payload is the new `active` boolean.
 */
export const LAY_FLAT_ACTIVE_EVENT = 'lay-flat-active-changed';

/**
 * Custom event fired on `document` when the "orientation committed" state
 * changes. Distinct from `LAY_FLAT_ACTIVE_EVENT` (which tracks picking-mode
 * in/out) — this tracks whether the user has actually committed a face via
 * `commit()`:
 *
 *   - `{ detail: true }`  after a successful `commit()` (face rotated onto
 *                         the bed; controller auto-exits picking).
 *   - `{ detail: false }` when the orientation is returned to the pristine
 *                         state via `reset()`.
 *   - `{ detail: false }` when `notifyMasterReset()` is called (a new STL
 *                         is loaded → orientation resets to identity; any
 *                         previous commit must NOT carry over).
 *
 * The Generate-mold button subscribes to this event to gate itself behind
 * a committed orientation (issue #36). Consumers should prefer this event
 * over polling `MountedViewport.isOrientationCommitted()` on every frame.
 */
export const LAY_FLAT_COMMITTED_EVENT = 'lay-flat-committed';

/** Dimensions for the flat normal-indicator quad, in mm. */
const NORMAL_QUAD_SIZE_MM = 15;

/**
 * Maximum pointer travel (in CSS pixels) between `pointerdown` and
 * `pointerup` for the up event to still count as a "click" that commits a
 * face.  Larger travel is treated as a drag (OrbitControls rotate / pan)
 * and the commit is silently dropped.
 *
 * Why this exists: the DOM `click` event, which this controller originally
 * listened for, is suppressed by Chromium whenever the pointer moves more
 * than ~5 px between down and up — any tiny hand-tremor during a click
 * would cause the commit to be dropped and the user would see no
 * feedback.  Listening to `pointerdown`/`pointerup` directly (issue #80
 * dogfood) + gating on travel distance gives us a deterministic commit
 * threshold we control instead of relying on Chromium's heuristic.
 *
 * 6 px is a touch above Chromium's own threshold so a commit that WOULD
 * have fired a `click` still commits here; it's well below the distance
 * a user would call "a drag" on a 1920-px-wide canvas.
 */
const CLICK_DRAG_THRESHOLD_PX = 6;

/**
 * Angle tolerance (cosine) for coplanar flood-fill during hover (issue #67).
 * `cos(2°) ≈ 0.99939` — two triangles whose LOCAL normals dot above this
 * threshold are treated as coplanar. The mini-figurine fixture's flat
 * faces triangulate at 0° mutual angle within a few epsilons; real-world
 * STLs with smoothing groups can drift up to ~1°. 2° leaves room for the
 * latter without bleeding the highlight across genuine edges.
 */
const COPLANAR_COS_THRESHOLD = Math.cos((2 * Math.PI) / 180);

/**
 * Safety cap on the flood-fill queue. Even a dense 500 k-tri master has
 * ≤ a few k triangles in any given coplanar face; 50 k is ~10× headroom
 * and prevents a pathological non-indexed mesh (where every vertex is
 * duplicated per tri and `buildAdjacency` degenerates) from hanging the
 * hover tick.
 */
const COPLANAR_FLOOD_MAX_TRIS = 50_000;

/**
 * Viewport DOM class applied while picking mode is active. The CSS rule
 * `.viewport.is-picking { cursor: crosshair }` in `index.html` paints the
 * crosshair cursor over the ENTIRE viewport (not just the canvas), so a
 * pointer parked over an axes-overlay scissor region still reads as
 * "picking is live". Kept in sync with the canvas-level inline style so
 * the cursor is correct even in tests that bypass the DOM class path.
 */
const VIEWPORT_PICKING_CLASS = 'is-picking';

/**
 * Flood-fill the triangles of a non-indexed mesh that are "coplanar" with
 * the seed triangle — i.e. share a normal whose angle to the seed's
 * normal is below the 2° cosine threshold — and are reachable by a walk
 * across shared edges.
 *
 * Returns an array of triangle indices (including the seed). The walk is
 * bounded by `COPLANAR_FLOOD_MAX_TRIS` as a defensive ceiling against
 * pathological inputs.
 *
 * Mesh assumption: the master mesh's geometry is non-indexed (our adapter
 * in `manifoldToBufferGeometry` emits non-indexed buffers). Triangle `t`
 * occupies vertex rows `[3t, 3t+1, 3t+2]`.
 *
 * Edge adjacency: two triangles share an edge when they share any two
 * vertex POSITIONS (NOT indices — on a non-indexed mesh, coincident
 * corners live at distinct row indices). We build a hash from "edge
 * key" → owning triangles once per mesh and memoise it on the geometry's
 * userData, since the hash survives every lay-flat rotation (the local
 * position buffer never mutates — PR #29 invariant).
 */
export interface CoplanarFloodResult {
  /** Triangle indices (in the non-indexed row/3 frame) that form the face. */
  readonly triangles: number[];
}

/**
 * Quantise a float coordinate to 1e-5 mm for edge-key hashing. Matches
 * the STL canonical-hash quantisation in `testing-3d/SKILL.md` — any two
 * vertices within 10 nm of each other are treated as the same point for
 * adjacency purposes. Generous enough to bridge FP round-off from the
 * manifold-3d → BufferGeometry adapter without merging genuinely distinct
 * vertices.
 */
function quantCoord(x: number): number {
  return Math.round(x * 1e5);
}

/**
 * Build an edge-key → triangle-list adjacency map for the given
 * BufferGeometry. Keys encode the unordered pair of vertex positions
 * (quantised), so triangles that share an edge end up in the same bucket.
 *
 * The result is memoised on `geometry.userData.__layFlatAdjacency` — the
 * position buffer never mutates over a master's lifetime (PR #29 group-
 * transform invariant), so the adjacency is stable until the master is
 * swapped (which disposes the geometry, taking the userData with it).
 */
function buildAdjacency(
  geometry: BufferGeometry,
): Map<string, number[]> {
  const cache = (geometry as unknown as {
    userData?: { __layFlatAdjacency?: Map<string, number[]> };
  }).userData;
  if (cache?.__layFlatAdjacency) return cache.__layFlatAdjacency;

  const pos = geometry.getAttribute('position');
  const triCount = Math.floor(pos.count / 3);
  const adj = new Map<string, number[]>();

  for (let t = 0; t < triCount; t++) {
    const i0 = t * 3;
    const i1 = i0 + 1;
    const i2 = i0 + 2;
    const v0 = [
      quantCoord(pos.getX(i0)),
      quantCoord(pos.getY(i0)),
      quantCoord(pos.getZ(i0)),
    ];
    const v1 = [
      quantCoord(pos.getX(i1)),
      quantCoord(pos.getY(i1)),
      quantCoord(pos.getZ(i1)),
    ];
    const v2 = [
      quantCoord(pos.getX(i2)),
      quantCoord(pos.getY(i2)),
      quantCoord(pos.getZ(i2)),
    ];
    const keys = [edgeKey(v0, v1), edgeKey(v1, v2), edgeKey(v2, v0)];
    for (const k of keys) {
      const bucket = adj.get(k);
      if (bucket) bucket.push(t);
      else adj.set(k, [t]);
    }
  }

  // Memoise onto the geometry. userData is a plain object on Three.js
  // BufferGeometry — safe to stash our cache key there alongside
  // anything else that might already be on it.
  const ud = (geometry as unknown as { userData: Record<string, unknown> })
    .userData;
  ud['__layFlatAdjacency'] = adj;
  return adj;
}

/** Build an order-independent string key for an edge between two quantised verts. */
function edgeKey(a: number[], b: number[]): string {
  // Sort lexicographically on the 3-tuple so (a,b) and (b,a) produce the
  // same key. Using a string join is fine — we only need a hashable key.
  const ax = a[0]!;
  const ay = a[1]!;
  const az = a[2]!;
  const bx = b[0]!;
  const by = b[1]!;
  const bz = b[2]!;
  const aFirst =
    ax < bx ||
    (ax === bx && (ay < by || (ay === by && az <= bz)));
  if (aFirst) return `${ax},${ay},${az}|${bx},${by},${bz}`;
  return `${bx},${by},${bz}|${ax},${ay},${az}`;
}

/**
 * Flood-fill the coplanar face starting at `seedTri`. Returns the list of
 * triangle indices in the same face. Uses the cached adjacency map.
 *
 * Normals are computed in mesh-LOCAL space from the vertex buffer (not
 * trusting `face.normal` on the Raycaster's Intersection result, which
 * can differ in sign under mirrored transforms).
 */
export function coplanarFloodFill(
  geometry: BufferGeometry,
  seedTri: number,
): CoplanarFloodResult {
  const adj = buildAdjacency(geometry);
  const pos = geometry.getAttribute('position');
  const triCount = Math.floor(pos.count / 3);
  if (seedTri < 0 || seedTri >= triCount) {
    return { triangles: [] };
  }

  const seedNormal = triangleNormal(pos, seedTri);
  // Degenerate triangle (zero area) — can't flood from it. Return just the
  // seed so the caller still gets a (degenerate) single-tri overlay.
  if (seedNormal.lengthSq() < 1e-24) {
    return { triangles: [seedTri] };
  }
  seedNormal.normalize();

  const visited = new Set<number>();
  const queue: number[] = [seedTri];
  visited.add(seedTri);
  const result: number[] = [];

  while (queue.length > 0 && result.length < COPLANAR_FLOOD_MAX_TRIS) {
    const t = queue.shift()!;
    result.push(t);

    // Neighbours: every triangle that shares any edge with `t`.
    const i0 = t * 3;
    const v0 = [
      quantCoord(pos.getX(i0)),
      quantCoord(pos.getY(i0)),
      quantCoord(pos.getZ(i0)),
    ];
    const v1 = [
      quantCoord(pos.getX(i0 + 1)),
      quantCoord(pos.getY(i0 + 1)),
      quantCoord(pos.getZ(i0 + 1)),
    ];
    const v2 = [
      quantCoord(pos.getX(i0 + 2)),
      quantCoord(pos.getY(i0 + 2)),
      quantCoord(pos.getZ(i0 + 2)),
    ];
    const edgeKeys = [edgeKey(v0, v1), edgeKey(v1, v2), edgeKey(v2, v0)];

    for (const k of edgeKeys) {
      const bucket = adj.get(k);
      if (!bucket) continue;
      for (const neigh of bucket) {
        if (visited.has(neigh)) continue;
        const n = triangleNormal(pos, neigh);
        if (n.lengthSq() < 1e-24) continue;
        n.normalize();
        if (n.dot(seedNormal) >= COPLANAR_COS_THRESHOLD) {
          visited.add(neigh);
          queue.push(neigh);
        }
      }
    }
  }

  return { triangles: result };
}

/** Compute the unnormalised triangle normal for triangle `t`. */
function triangleNormal(
  pos: ReturnType<BufferGeometry['getAttribute']>,
  t: number,
): Vector3 {
  const i0 = t * 3;
  const ax = pos.getX(i0);
  const ay = pos.getY(i0);
  const az = pos.getZ(i0);
  const bx = pos.getX(i0 + 1);
  const by = pos.getY(i0 + 1);
  const bz = pos.getZ(i0 + 1);
  const cx = pos.getX(i0 + 2);
  const cy = pos.getY(i0 + 2);
  const cz = pos.getZ(i0 + 2);
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = cx - ax;
  const vy = cy - ay;
  const vz = cz - az;
  return new Vector3(
    uy * vz - uz * vy,
    uz * vx - ux * vz,
    ux * vy - uy * vx,
  );
}

export interface LayFlatController {
  /** Enter picking mode: attach listeners, show cursor as crosshair. */
  enable(): void;
  /** Exit picking mode: detach listeners, hide widgets. */
  disable(): void;
  /** Return the group to identity rotation and re-center + re-frame. */
  reset(): void;
  /** Whether picking mode is currently active. */
  isActive(): boolean;
  /**
   * Whether the user has committed an orientation since the last reset or
   * master load. Mirrored onto `document` via `LAY_FLAT_COMMITTED_EVENT`.
   */
  isCommitted(): boolean;
  /**
   * Signal that the master mesh has been replaced (new STL loaded). The
   * controller forgets any previous committed orientation and fires
   * `LAY_FLAT_COMMITTED_EVENT` with `detail: false` so gated UI re-locks.
   * The scene-graph side of the master swap is owned by `setMaster`; this
   * method only manages the controller's own state + event.
   */
  notifyMasterReset(): void;
  /**
   * Issue #67 — read-only handle to the hover-highlight overlay mesh so
   * tests can assert its visibility + geometry state without reaching
   * through the scene graph. Production code should not touch this —
   * the controller owns the mesh's lifetime.
   */
  getHoverOverlay(): Mesh;
  /** Tear down permanently — remove widget group from the scene. */
  dispose(): void;
}

export interface LayFlatControllerOptions {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly canvas: HTMLCanvasElement;
  /**
   * Retrieve the current master mesh. Returns `null` if no master is loaded,
   * in which case `enable()` becomes a no-op. We accept a getter (not a
   * snapshot) because the master can be swapped while the controller is
   * long-lived — viewport ownership outlives any single master.
   */
  readonly getMasterMesh: () => Mesh | null;
}

/**
 * Create a controller bound to a viewport. No listeners are attached
 * until `enable()` is called. The widgets group is lazily created on
 * first enable and reused across enable/disable cycles.
 */
export function createLayFlatController(
  options: LayFlatControllerOptions,
): LayFlatController {
  const { scene, camera, controls, canvas, getMasterMesh } = options;

  let active = false;
  let disposed = false;
  // Orientation-committed flag (issue #36). Starts false: a freshly-loaded
  // master has pristine identity orientation. Flipped true inside `commit()`,
  // flipped false inside `reset()` and `notifyMasterReset()`.
  let committed = false;

  // --- Widgets --------------------------------------------------------------

  const widgetsRoot = findWidgetsGroup(scene);
  const widgets = new Group();
  widgets.userData['tag'] = LAY_FLAT_WIDGETS_TAG;
  widgets.visible = false;
  widgetsRoot.add(widgets);

  // Triangle outline (LineSegments) that traces the picked triangle's edges.
  // Three vertices → three edges → 6 position entries (3 segments × 2 verts).
  const triOutlineGeom = new BufferGeometry();
  triOutlineGeom.setAttribute(
    'position',
    new BufferAttribute(new Float32Array(18), 3),
  );
  const triOutlineMat = new LineBasicMaterial({
    color: ACCENT_COLOR,
    depthTest: false,
    transparent: true,
    opacity: 0.95,
  });
  const triOutline = new LineSegments(triOutlineGeom, triOutlineMat);
  triOutline.renderOrder = 999;
  widgets.add(triOutline);

  // Flat overlay quad — 2-tri square in the picked face's plane, centered at
  // the hit point. Renders translucent to suggest "this plane goes flat".
  const quadGeom = new BufferGeometry();
  quadGeom.setAttribute(
    'position',
    new BufferAttribute(new Float32Array(18), 3),
  );
  const quadMat = new MeshBasicMaterial({
    color: ACCENT_COLOR,
    transparent: true,
    opacity: 0.22,
    side: DoubleSide,
    depthTest: false,
    depthWrite: false,
  });
  const normalQuad = new Mesh(quadGeom, quadMat);
  normalQuad.renderOrder = 998;
  widgets.add(normalQuad);

  // --- Coplanar-face hover overlay (issue #67) --------------------------
  //
  // A single reused Mesh whose BufferGeometry is rebuilt on every hover
  // change to contain exactly the triangles the COMMIT path would act on
  // (same face normal as the hovered triangle, adjacent-accessible by a
  // coplanar flood-fill). Tinted with the CSS `--accent` token and
  // rendered translucent with `polygonOffset: true` so it sits cleanly
  // on top of the master without z-fighting.
  //
  // Lifetime: the geometry is cheap (at most a few thousand floats in
  // the worst real case); we allocate a fresh BufferGeometry on each
  // hover-change rather than growing a Float32Array in place — the
  // flood-fill result size is unknowable upfront, and the per-hover
  // allocation cost is well below the raycast cost. `visible = false`
  // hides without allocating; the mesh is disposed once on picking-
  // mode exit.
  //
  // Transform: the overlay is written in WORLD coordinates, so it's
  // attached to the WIDGETS group (which stays at identity). Writing
  // local coordinates into the master group would chain the master's
  // rotation onto the already-world-transformed vertices — a double-
  // transform bug we want no part of.
  const hoverOverlayMat = new MeshBasicMaterial({
    color: ACCENT_COLOR,
    transparent: true,
    opacity: 0.35,
    side: DoubleSide,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  let hoverOverlayGeom = new BufferGeometry();
  hoverOverlayGeom.setAttribute(
    'position',
    new BufferAttribute(new Float32Array(0), 3),
  );
  const hoverOverlay = new Mesh(hoverOverlayGeom, hoverOverlayMat);
  hoverOverlay.userData['tag'] = 'lay-flat-hover-overlay';
  hoverOverlay.renderOrder = 997;
  hoverOverlay.visible = false;
  widgets.add(hoverOverlay);

  // Last processed pointer position (canvas-relative) for the hover-throttle:
  // skip the raycast when the pointer hasn't moved since the previous frame.
  // Stored as integers (`Math.floor(clientX)`, `Math.floor(clientY)`) — sub-
  // pixel jitter from some trackpads would otherwise force a re-raycast
  // every frame without any visual change.
  let lastPointerX: number = Number.NaN;
  let lastPointerY: number = Number.NaN;
  // Last seed triangle passed through the flood-fill, cached so we reuse
  // the existing overlay geometry when the user's cursor wanders within
  // the same face.
  let lastHoverSeedTri: number = -1;

  function updateWidgets(pick: PickResult): void {
    const mesh = getMasterMesh();
    if (!mesh) return;

    // --- Triangle outline: read the three vertex positions from the mesh's
    //     BufferGeometry, transform them to world space, stuff into the
    //     LineSegments buffer as 3 edges (a-b, b-c, c-a).
    const positions = mesh.geometry.getAttribute('position');
    const triIndex = pick.faceIndex;
    // Non-indexed geometry: triangle t occupies vertex indices [3t, 3t+1, 3t+2].
    // Our adapters always emit non-indexed meshes from `manifoldToBufferGeometry`.
    const v0 = new Vector3().fromBufferAttribute(positions, triIndex * 3);
    const v1 = new Vector3().fromBufferAttribute(positions, triIndex * 3 + 1);
    const v2 = new Vector3().fromBufferAttribute(positions, triIndex * 3 + 2);
    mesh.localToWorld(v0);
    mesh.localToWorld(v1);
    mesh.localToWorld(v2);

    const outlineArr = triOutlineGeom.getAttribute('position')
      .array as Float32Array;
    // Edge 0-1
    outlineArr[0] = v0.x;
    outlineArr[1] = v0.y;
    outlineArr[2] = v0.z;
    outlineArr[3] = v1.x;
    outlineArr[4] = v1.y;
    outlineArr[5] = v1.z;
    // Edge 1-2
    outlineArr[6] = v1.x;
    outlineArr[7] = v1.y;
    outlineArr[8] = v1.z;
    outlineArr[9] = v2.x;
    outlineArr[10] = v2.y;
    outlineArr[11] = v2.z;
    // Edge 2-0
    outlineArr[12] = v2.x;
    outlineArr[13] = v2.y;
    outlineArr[14] = v2.z;
    outlineArr[15] = v0.x;
    outlineArr[16] = v0.y;
    outlineArr[17] = v0.z;
    triOutlineGeom.getAttribute('position').needsUpdate = true;
    triOutlineGeom.computeBoundingSphere();

    // --- Normal indicator quad: build a 2-triangle square in the plane
    //     perpendicular to the world normal, centered at the hit point.
    //     Offset slightly along the normal so it doesn't z-fight the mesh.
    const n = pick.worldNormal.clone().normalize();
    // Pick an arbitrary basis perpendicular to n. Prefer world-X; fall back
    // to world-Y if n is too close to X.
    const ref = Math.abs(n.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
    const u = new Vector3().crossVectors(n, ref).normalize().multiplyScalar(
      NORMAL_QUAD_SIZE_MM / 2,
    );
    const v = new Vector3().crossVectors(n, u).normalize().multiplyScalar(
      NORMAL_QUAD_SIZE_MM / 2,
    );
    const c = pick.point.clone().addScaledVector(n, 0.05);

    const p0 = c.clone().sub(u).sub(v);
    const p1 = c.clone().add(u).sub(v);
    const p2 = c.clone().add(u).add(v);
    const p3 = c.clone().sub(u).add(v);

    const quadArr = quadGeom.getAttribute('position').array as Float32Array;
    // Tri 0: p0, p1, p2
    quadArr[0] = p0.x;
    quadArr[1] = p0.y;
    quadArr[2] = p0.z;
    quadArr[3] = p1.x;
    quadArr[4] = p1.y;
    quadArr[5] = p1.z;
    quadArr[6] = p2.x;
    quadArr[7] = p2.y;
    quadArr[8] = p2.z;
    // Tri 1: p0, p2, p3
    quadArr[9] = p0.x;
    quadArr[10] = p0.y;
    quadArr[11] = p0.z;
    quadArr[12] = p2.x;
    quadArr[13] = p2.y;
    quadArr[14] = p2.z;
    quadArr[15] = p3.x;
    quadArr[16] = p3.y;
    quadArr[17] = p3.z;
    quadGeom.getAttribute('position').needsUpdate = true;
    quadGeom.computeVertexNormals();
    quadGeom.computeBoundingSphere();

    // --- Coplanar-face hover overlay (issue #67).
    //
    // Rebuild the overlay geometry ONLY when the seed triangle changes —
    // wandering within the same face keeps the existing buffer. This
    // is a significant win on large dense meshes where flood-fill can
    // touch several thousand triangles per hover.
    if (triIndex !== lastHoverSeedTri) {
      lastHoverSeedTri = triIndex;
      const flood = coplanarFloodFill(mesh.geometry, triIndex);
      rebuildHoverOverlay(mesh, flood.triangles);
    }
    hoverOverlay.visible = true;

    widgets.visible = true;
  }

  /**
   * Populate `hoverOverlay.geometry` with world-space triangles for the
   * given tri indices on the master mesh. Disposes the previous geometry
   * first (we allocate a fresh `BufferGeometry` each change — the
   * allocation cost is tiny compared to the surrounding work, and the
   * fresh-buffer path skips the "do I need to grow?" branching).
   */
  function rebuildHoverOverlay(
    mesh: Mesh,
    triangleIndices: readonly number[],
  ): void {
    const pos = mesh.geometry.getAttribute('position');
    const triCount = triangleIndices.length;
    const verts = new Float32Array(triCount * 9);
    // Cache the mesh's world matrix once — applying it per vertex is the
    // same cost Three's `localToWorld` pays inside a loop. We expand the
    // matrix inline to avoid the per-Vector3 allocation `localToWorld`
    // would do (matters on large flood fills).
    mesh.updateWorldMatrix(true, false);
    const e = mesh.matrixWorld.elements;
    const e0 = e[0]!;
    const e1 = e[1]!;
    const e2 = e[2]!;
    const e4 = e[4]!;
    const e5 = e[5]!;
    const e6 = e[6]!;
    const e8 = e[8]!;
    const e9 = e[9]!;
    const e10 = e[10]!;
    const e12 = e[12]!;
    const e13 = e[13]!;
    const e14 = e[14]!;

    for (let k = 0; k < triCount; k++) {
      const t = triangleIndices[k]!;
      const base = t * 3;
      for (let corner = 0; corner < 3; corner++) {
        const row = base + corner;
        const lx = pos.getX(row);
        const ly = pos.getY(row);
        const lz = pos.getZ(row);
        const wx = e0 * lx + e4 * ly + e8 * lz + e12;
        const wy = e1 * lx + e5 * ly + e9 * lz + e13;
        const wz = e2 * lx + e6 * ly + e10 * lz + e14;
        const out = k * 9 + corner * 3;
        verts[out] = wx;
        verts[out + 1] = wy;
        verts[out + 2] = wz;
      }
    }

    // Dispose and swap. Allocating a fresh BufferGeometry is ~microseconds;
    // the alternative — growing a single buffer in place — would need to
    // track attribute-count gates and call `setDrawRange`, which adds
    // complexity without measurable benefit on realistic flood sizes.
    hoverOverlay.geometry.dispose();
    const next = new BufferGeometry();
    next.setAttribute('position', new BufferAttribute(verts, 3));
    next.computeVertexNormals();
    next.computeBoundingSphere();
    hoverOverlay.geometry = next;
    hoverOverlayGeom = next;
  }

  function hideWidgets(): void {
    widgets.visible = false;
    // Also drop the hover-overlay's visibility flag so a subsequent
    // `widgets.visible = true` from another widget path (future) doesn't
    // leak a stale face highlight into view. `widgets.visible = false`
    // already hides all children via scene-graph traversal, but pinning
    // the overlay's own flag false keeps the invariant "overlay.visible
    // is true iff there IS a current hover hit" independently testable.
    hoverOverlay.visible = false;
    // Reset the seed cache so the next pointer-move (even over the SAME
    // triangle the cursor was last on) rebuilds the overlay — otherwise
    // the first raycast after a miss would skip the rebuild and leave
    // the overlay at its pre-miss geometry until the user crosses a
    // different face.
    lastHoverSeedTri = -1;
  }

  // --- Pointer handlers -----------------------------------------------------

  function onPointerMove(ev: PointerEvent): void {
    if (!active) return;
    const mesh = getMasterMesh();
    if (!mesh) {
      hideWidgets();
      return;
    }
    // Throttle by integer pixel position — sub-pixel trackpad jitter
    // shouldn't refire the raycast + flood-fill. Using `clientX/Y`
    // (canvas-relative work happens inside `pickFaceUnderPointer`).
    const px = Math.floor(ev.clientX);
    const py = Math.floor(ev.clientY);
    if (px === lastPointerX && py === lastPointerY) return;
    lastPointerX = px;
    lastPointerY = py;

    const pick = pickFaceUnderPointer(ev, canvas, camera, mesh);
    if (pick) {
      updateWidgets(pick);
    } else {
      hideWidgets();
    }
  }

  function onPointerLeave(): void {
    if (!active) return;
    hideWidgets();
  }

  // --- Click-vs-drag gate (issue #80 dogfood) ------------------------------
  //
  // Arm on `pointerdown` (left button over the canvas); commit on
  // `pointerup` only if the pointer hasn't travelled more than
  // CLICK_DRAG_THRESHOLD_PX CSS pixels AND the up landed on the same
  // canvas.  Replaces the `click` listener — Chromium suppresses `click`
  // when the down→up travel exceeds ~5 px, which was silently dropping
  // commits on anyone whose hand twitched during a pick.
  let downArmed = false;
  let downX = 0;
  let downY = 0;

  function onPointerDown(ev: PointerEvent): void {
    if (!active) return;
    if (ev.button !== 0) {
      // Non-primary button (e.g. right-drag → OrbitControls pan). Keep
      // the armed flag as-is — a parallel primary-button click isn't
      // possible (single pointer), so we simply don't re-arm here.
      return;
    }
    if (ev.target !== canvas) {
      // Pointer down originated outside our canvas — don't claim it.
      return;
    }
    downArmed = true;
    downX = ev.clientX;
    downY = ev.clientY;
  }

  function onPointerUp(ev: PointerEvent): void {
    if (!active) return;
    if (!downArmed) return;
    downArmed = false;
    if (ev.button !== 0) return;
    if (ev.target !== canvas) {
      // Up landed off-canvas (user dragged off the viewport). Not a click.
      return;
    }
    const dx = ev.clientX - downX;
    const dy = ev.clientY - downY;
    if (Math.hypot(dx, dy) > CLICK_DRAG_THRESHOLD_PX) {
      // Treat as a drag (OrbitControls rotate) — don't commit.
      return;
    }

    const mesh = getMasterMesh();
    if (!mesh) return;

    // Re-pick at the up position so the commit acts on whatever's under
    // the cursor at the moment of release — not whatever pointermove
    // last saw, which could be one frame behind. Feels tighter.
    const pick = pickFaceUnderPointer(ev, canvas, camera, mesh);
    if (!pick) return;

    commit(pick, mesh);
  }

  /**
   * OrbitControls fires `change` on every camera adjustment (rotate / pan /
   * zoom). While picking mode is active we cache the last pointer position
   * + last-seed-tri so repeated hovers over the same face can skip the
   * raycast + flood-fill. Those caches become STALE the instant the camera
   * moves — the cursor is in the same CSS pixel but now points at a
   * different triangle.  Without this invalidation the hover overlay would
   * still highlight the previous face until the user wiggled the mouse to
   * invalidate it by hand.  Issue #80 dogfood.
   */
  function onControlsChange(): void {
    if (!active) return;
    lastPointerX = Number.NaN;
    lastPointerY = Number.NaN;
    lastHoverSeedTri = -1;
  }

  function onKeyDown(ev: KeyboardEvent): void {
    if (!active) return;
    if (ev.key === 'Escape') {
      disable();
    }
  }

  // --- Commit + reset -------------------------------------------------------

  function commit(pick: PickResult, mesh: Mesh): void {
    const group = mesh.parent;
    if (!group) return;

    // Compose the lay-flat rotation onto the group. `premultiply` (not
    // `multiply`) so chaining lay-flats behaves as "rotate in world frame":
    //   final = q_layFlat · existing_rotation
    // which matches the user's mental model of "pick a face now, whatever
    // the current orientation is".
    const q = quaternionToAlignFaceDown(pick.worldNormal);
    group.quaternion.premultiply(q);

    // Re-apply auto-center post-rotation. Without this the mesh floats off
    // the bed after the rotation (its world-space AABB has shifted).
    recenterGroup(group, mesh);

    // Re-frame the camera to the NEW world-space AABB (issue AC: "after
    // commit, re-frame to the new world AABB"). Use the vertex-walk bbox
    // — `Box3.setFromObject` without `precise=true` transforms the local
    // AABB's 8 corners, which for an arbitrary rotation over-estimates
    // the world bbox and would leave the camera framed to the wrong size.
    const worldBbox = computeWorldBoxTight(mesh);
    frameToBox3(camera, controls, worldBbox);

    // Belt-and-braces: re-normalise the quaternion post-compose to keep it
    // a unit quaternion even after many chained lay-flats (numerical drift
    // accumulates slowly but surely).
    group.quaternion.normalize();

    // Clean up hover widgets + auto-exit picking mode (issue AC: "picking
    // mode auto-exits on commit"). `disable()` fires its own active-event;
    // sequencing it BEFORE the committed-event means subscribers observing
    // both events see them in causal order: "picking ended → orientation
    // committed". This matters for the Generate-mold button gate (#36):
    // the button's enable tick lands after the picking cue has cleared,
    // not in the middle of it.
    disable();

    // Flip committed=true and notify — AFTER the rotation has been applied
    // and the scene-graph is consistent. The Generate-mold button (#36)
    // listens to this event to unlock itself.
    if (!committed) {
      committed = true;
      emitCommittedChanged();
    }
  }

  function reset(): void {
    const mesh = getMasterMesh();
    if (!mesh) return;
    const group = mesh.parent;
    if (!group) return;

    resetOrientation(group, mesh);
    // Tight vertex-walk bbox — see `commit()` for why we don't use
    // `Box3.setFromObject`.
    const worldBbox = computeWorldBoxTight(mesh);
    frameToBox3(camera, controls, worldBbox);

    // Reset does not force picking mode on or off — the user might want to
    // reset while the toggle is active (to pick a different face cleanly)
    // or while it is inactive (pure "undo"). Respect current state.

    // Orientation has been returned to identity → the committed flag must
    // drop, re-disabling the Generate-mold button (#36). Only fire the
    // event when the flag actually transitions, to keep the event stream
    // meaningful.
    if (committed) {
      committed = false;
      emitCommittedChanged();
    }
  }

  /**
   * External signal: the master mesh has been replaced (new STL loaded).
   * Any previous committed orientation is no longer meaningful — the new
   * master enters at identity with the committed flag cleared. See
   * issue #36 AC: "After Open STL loads a new master → button re-disabled
   * (inherited commit state does not carry over)".
   */
  function notifyMasterReset(): void {
    if (!committed) return;
    committed = false;
    emitCommittedChanged();
  }

  // --- Enable / disable / dispose -------------------------------------------

  function emitActiveChanged(): void {
    document.dispatchEvent(
      new CustomEvent<boolean>(LAY_FLAT_ACTIVE_EVENT, { detail: active }),
    );
  }

  /**
   * Fire `LAY_FLAT_COMMITTED_EVENT` with the current `committed` flag. The
   * Generate-mold button subscribes so its disabled state mirrors the
   * controller's truth. We always fire on transitions (caller's
   * responsibility to only call when the flag actually changed) so
   * listeners receive a consistent sequence.
   */
  function emitCommittedChanged(): void {
    document.dispatchEvent(
      new CustomEvent<boolean>(LAY_FLAT_COMMITTED_EVENT, { detail: committed }),
    );
  }

  function enable(): void {
    if (disposed) return;
    if (active) return;
    const mesh = getMasterMesh();
    if (!mesh) return;
    active = true;
    canvas.style.cursor = 'crosshair';
    // Issue #67 — also toggle a CSS class on the #viewport container so
    // the accent-on-picking cursor paints over the whole viewport area
    // (including axes-overlay scissor regions). Wrapped in a guard
    // because this code runs in test environments that can synthesise a
    // canvas without a real parent chain; absent parents just skip the
    // class update without aborting picking-mode enable.
    const viewportEl = canvas.parentElement;
    if (viewportEl) viewportEl.classList.add(VIEWPORT_PICKING_CLASS);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('pointerdown', onPointerDown);
    // `pointerup` goes on the window so a release that drifts off the
    // canvas (mid-drag) still clears the armed flag — otherwise the next
    // real click over the canvas would be ignored because `downArmed`
    // was never reset.
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('keydown', onKeyDown);
    // Invalidate the hover-pointer + seed-tri caches whenever the camera
    // moves — the same CSS-pixel now points at a different triangle.
    controls.addEventListener('change', onControlsChange);
    emitActiveChanged();
  }

  function disable(): void {
    if (!active) return;
    active = false;
    canvas.style.cursor = '';
    const viewportEl = canvas.parentElement;
    if (viewportEl) viewportEl.classList.remove(VIEWPORT_PICKING_CLASS);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    canvas.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('keydown', onKeyDown);
    controls.removeEventListener('change', onControlsChange);
    hideWidgets();
    // Reset throttle state so the next enable starts clean.
    lastPointerX = Number.NaN;
    lastPointerY = Number.NaN;
    lastHoverSeedTri = -1;
    downArmed = false;
    emitActiveChanged();
  }

  function dispose(): void {
    disable();
    disposed = true;
    triOutlineGeom.dispose();
    triOutlineMat.dispose();
    quadGeom.dispose();
    quadMat.dispose();
    hoverOverlay.geometry.dispose();
    hoverOverlayMat.dispose();
    if (widgets.parent) widgets.parent.remove(widgets);
  }

  return {
    enable,
    disable,
    reset,
    isActive: () => active,
    isCommitted: () => committed,
    notifyMasterReset,
    getHoverOverlay: () => hoverOverlay,
    dispose,
  };
}

/**
 * Locate the scene's pre-built Widgets group (`tag: 'widgets'`) for
 * attaching lay-flat overlays. Falls back to the scene itself if no such
 * group exists — avoids crashing on a scene that was hand-built in a test.
 */
function findWidgetsGroup(scene: Scene): Scene | Group {
  for (const child of scene.children) {
    if (child.userData['tag'] === WIDGETS_GROUP_TAG && child instanceof Group) {
      return child;
    }
  }
  return scene;
}
