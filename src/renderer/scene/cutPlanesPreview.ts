// src/renderer/scene/cutPlanesPreview.ts
//
// Scene module owning the cut-planes preview overlay + TransformControls
// gizmos (dogfood round 7, PR B). Renders N translucent blue planes
// arranged at the current `SIDE_CUT_ANGLES[sideCount]` around a parent
// anchor group. The anchor is what TransformControls manipulates:
//
//   - A `translate` gizmo with Y disabled (X + Z arrows only) slides the
//     pivot point around the XZ plane.
//   - A `rotate` gizmo with X + Z disabled (Y ring only) spins the whole
//     cut-plane set around the vertical axis.
//
// Both gizmos attach to the SAME anchor group — TransformControls
// supports one mode per instance, so we create two, both attached to
// the same Object3D. Dragging either one disables OrbitControls for
// the duration of the drag (via each gizmo's `dragging-changed` event),
// so the orbit+gizmo can coexist.
//
// Axis constraint defense: on every frame (driven by the viewport's
// RAF loop through `onFrame()`) we clamp:
//   - anchor.position.y = yCenter  (kills any vertical drift)
//   - anchor.rotation.x = 0, anchor.rotation.z = 0  (kills X/Z tilt)
//
// Bounds clamp: every `objectChange` from the translate gizmo is
// followed by a clamp of `|offset.x|` and `|offset.z|` to
// `0.9 × min(bbox half-extent from xzCenter)` so the pivot never
// escapes the master.
//
// Store wiring: `objectChange` reads the anchor and pushes into the
// cutOverridesStore via `setRotation` / `setCenterOffset`. A separate
// `cutOverridesStore.subscribe` brings programmatic updates back to
// the anchor (so tests can set values directly and see the anchor
// reflect them). We guard against feedback loops with a
// `syncingFromStore` flag — when the anchor is being written FROM the
// store, we skip the `objectChange` handler that would otherwise loop
// the write back into the store.

import {
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  type Box3,
  type PerspectiveCamera,
  type Scene,
} from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';

import { SIDE_CUT_ANGLES } from '@/geometry/sideAngles';
import type { CutOverridesStore } from '../state/cutOverrides';

/** Tag placed on the root group so tests can locate it in the scene graph. */
export const CUT_PLANES_PREVIEW_TAG = 'cut-planes-preview';
/** Tag placed on the anchor (child) group — the object TransformControls attaches to. */
export const CUT_PLANES_ANCHOR_TAG = 'cut-planes-anchor';

/** Accent blue matching the app's CSS `--accent` variable. */
const ACCENT_COLOR = 0x4a9eff;

/**
 * Fractional safety margin on the XZ bounds clamp — 0.9 means the
 * anchor can ride up to 90% of the master's XZ half-extent from the
 * center, leaving a ~10% buffer so the user can't drag the pivot
 * outside the master.
 */
const BOUNDS_CLAMP_FRAC = 0.9;

/**
 * World-space axis-aligned bounding box, as used by the viewport
 * layer. Structural alias for three's Box3 so the caller can supply
 * whatever they have on hand without us importing the concrete class
 * into our public API.
 */
export type WorldBbox = Box3;

export interface CutPlanesPreviewOptions {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly canvas: HTMLCanvasElement;
  /** Return the master's world-space AABB, or null if no master is loaded. */
  readonly getMasterBbox: () => WorldBbox | null;
  /** Return the shell's desired vertical span in mm — typically `bbox.max.y − bbox.min.y` + pad. */
  readonly getShellHeight: () => number;
  /** Return the current sideCount (2, 3, or 4). */
  readonly getSideCount: () => 2 | 3 | 4;
  /** Store driving / receiving the rotation + center offset. */
  readonly cutOverridesStore: CutOverridesStore;
  /**
   * Optional callback fired when the user releases a drag on EITHER
   * gizmo. Main wires this to flip the generate button to a stale
   * state (since the cut overrides changed since the last generate).
   */
  readonly onDragRelease?: () => void;
}

export interface CutPlanesPreviewApi {
  /** Attach to the scene — idempotent. */
  attach(): void;
  /** Detach from the scene — idempotent. */
  detach(): void;
  /** Rebuild the plane meshes — call on sideCount or master change. */
  rebuild(): void;
  /** Flip the whole preview visible on/off (after attach). */
  setVisible(v: boolean): void;
  /** Whether the preview is currently attached AND visible. */
  isVisible(): boolean;
  /** Whether the user is actively dragging either gizmo. */
  isActivelyDragging(): boolean;
  /** Tick — the viewport's RAF loop calls this every frame while attached. */
  onFrame(): void;
  /** Dispose GPU resources + detach gizmos. Safe to call multiple times. */
  dispose(): void;
}

/**
 * Build a cut-planes preview bound to the given scene. Not yet attached —
 * the caller decides when to call `attach()`, typically after the master
 * is loaded AND the orientation has been committed.
 */
export function createCutPlanesPreview(
  options: CutPlanesPreviewOptions,
): CutPlanesPreviewApi {
  const {
    scene,
    camera,
    controls,
    canvas,
    getMasterBbox,
    getShellHeight,
    getSideCount,
    cutOverridesStore,
    onDragRelease,
  } = options;

  // --- Scene graph: root → anchor → N plane meshes -------------------------

  const root = new Group();
  root.userData['tag'] = CUT_PLANES_PREVIEW_TAG;
  root.visible = false;

  const anchor = new Group();
  anchor.userData['tag'] = CUT_PLANES_ANCHOR_TAG;
  root.add(anchor);

  // Material shared across all plane meshes — they all render the same
  // translucent accent blue.
  const planeMaterial = new MeshBasicMaterial({
    color: ACCENT_COLOR,
    transparent: true,
    opacity: 0.18,
    side: DoubleSide,
    depthWrite: false,
  });

  let planeMeshes: Mesh[] = [];
  let planeGeometries: PlaneGeometry[] = [];

  /** Cached metrics captured from the master bbox on the last attach/rebuild. */
  let cachedXzCenter: { x: number; z: number } = { x: 0, z: 0 };
  let cachedYCenter = 0;
  let cachedMaxRadius = 0;
  let cachedShellHeight = 0;

  // --- Gizmos --------------------------------------------------------------

  // Two TransformControls on the SAME anchor — translate (X+Z) and
  // rotate (Y only). Constructed lazily on attach so tests that never
  // attach can run without a real camera/canvas.
  let translateGizmo: TransformControls | null = null;
  let rotateGizmo: TransformControls | null = null;
  let translateHelper: ReturnType<TransformControls['getHelper']> | null = null;
  let rotateHelper: ReturnType<TransformControls['getHelper']> | null = null;

  // Re-entrancy guard: when we push store → anchor (on external
  // subscribe), skip the objectChange handler that would re-write the
  // anchor's values BACK into the store.
  let syncingFromStore = false;

  /** True while the user is mid-drag on either gizmo. */
  let activelyDragging = false;

  let attached = false;
  let disposed = false;
  let unsubscribeStore: (() => void) | null = null;

  // --- Helpers -------------------------------------------------------------

  function refreshMetricsFromBbox(): void {
    const bbox = getMasterBbox();
    if (!bbox || bbox.isEmpty()) {
      cachedXzCenter = { x: 0, z: 0 };
      cachedYCenter = 0;
      cachedMaxRadius = 0;
      cachedShellHeight = Math.max(1, getShellHeight());
      return;
    }
    cachedXzCenter = {
      x: (bbox.min.x + bbox.max.x) * 0.5,
      z: (bbox.min.z + bbox.max.z) * 0.5,
    };
    cachedYCenter = (bbox.min.y + bbox.max.y) * 0.5;
    // Radial distance from XZ center to farthest XZ corner — used to
    // both size each plane's radial span AND clamp offset bounds.
    const halfX = (bbox.max.x - bbox.min.x) * 0.5;
    const halfZ = (bbox.max.z - bbox.min.z) * 0.5;
    cachedMaxRadius = Math.hypot(halfX, halfZ);
    cachedShellHeight = Math.max(1, getShellHeight());
  }

  /**
   * Dispose current plane meshes and their geometries. Material is
   * shared and kept alive across rebuilds — freed only in `dispose()`.
   */
  function disposePlanes(): void {
    for (const g of planeGeometries) {
      g.dispose();
    }
    for (const m of planeMeshes) {
      anchor.remove(m);
    }
    planeMeshes = [];
    planeGeometries = [];
  }

  /**
   * Rebuild the N plane meshes from the current sideCount + cached
   * bbox metrics. Each plane is a PlaneGeometry oriented along its
   * local +X axis (radial outward) in the anchor's local frame.
   *
   * A plane's local orientation: PlaneGeometry is created in the XY
   * plane by default (faces +Z). We rotate it so its normal points
   * perpendicular to the radial direction — i.e. the plane CONTAINS
   * the radial direction + the Y axis. Specifically: rotate Y by
   * (angle_rad + π/2) so the plane's normal is along the
   * perpendicular-to-radial tangent.
   */
  function buildPlanes(): void {
    disposePlanes();
    refreshMetricsFromBbox();
    const sideCount = getSideCount();
    const angles = SIDE_CUT_ANGLES[sideCount];
    // Each plane spans from the anchor radially outward by
    // `cachedMaxRadius * 2` (so it clearly cuts across the whole
    // master even after offset). Height is the shell's vertical span.
    // Radial span: 2x max radius gives the full diameter of the
    // bounding cylinder; double that (4x) ensures the plane is visible
    // even when the user offsets the pivot near an edge and the far
    // side needs to still cover the master.
    const radialSpan = Math.max(1, cachedMaxRadius * 4);
    const height = cachedShellHeight;

    for (const angleDeg of angles) {
      const rad = (angleDeg * Math.PI) / 180;

      // PlaneGeometry defaults to XY plane with normal +Z. We want the
      // plane to lie in the Y axis + radial direction. Create in local
      // X + Y axes (so width-along-X = radialSpan, height-along-Y =
      // height) then rotate the mesh around Y so that +X points along
      // the radial direction.
      const geom = new PlaneGeometry(radialSpan, height);
      const mesh = new Mesh(geom, planeMaterial);
      // Rotate around Y so the plane's local +X axis points along the
      // radial direction for this cut angle.
      mesh.rotation.y = rad;
      // Center the plane halfway outward so its inner edge sits near
      // the anchor (visual clarity — planes radiating OUT from the
      // pivot).
      // Actually, keep the plane centered at the anchor (local origin)
      // so it clearly represents a cut-plane passing THROUGH the pivot
      // — that's what the slicer's cut plane actually does.
      mesh.position.set(0, 0, 0);

      anchor.add(mesh);
      planeMeshes.push(mesh);
      planeGeometries.push(geom);
    }
  }

  /** Clamp |offset.x|, |offset.z| to 0.9 × max radius. Returns clamped pair. */
  function clampOffset(x: number, z: number): { x: number; z: number } {
    const r = cachedMaxRadius * BOUNDS_CLAMP_FRAC;
    if (r <= 0) return { x, z };
    const cx = Math.max(-r, Math.min(r, x));
    const cz = Math.max(-r, Math.min(r, z));
    return { x: cx, z: cz };
  }

  /**
   * Push the store's current value onto the anchor. Guards against
   * feedback into the `objectChange` handler via `syncingFromStore`.
   */
  function applyStoreToAnchor(): void {
    const snap = cutOverridesStore.get();
    const offset = snap.centerOffset_mm;
    const rotRad = (snap.rotation_deg * Math.PI) / 180;
    syncingFromStore = true;
    try {
      anchor.position.set(
        cachedXzCenter.x + offset.x,
        cachedYCenter,
        cachedXzCenter.z + offset.z,
      );
      anchor.rotation.set(0, rotRad, 0);
      anchor.updateMatrix();
      anchor.updateMatrixWorld(true);
    } finally {
      syncingFromStore = false;
    }
  }

  /**
   * Called on TransformControls `objectChange`. Read the anchor's
   * current position/rotation and push to the store.
   */
  function onGizmoObjectChange(): void {
    if (syncingFromStore) return;
    // Center offset = anchor.position - master.xzCenter (before clamp).
    const rawX = anchor.position.x - cachedXzCenter.x;
    const rawZ = anchor.position.z - cachedXzCenter.z;
    const { x: cx, z: cz } = clampOffset(rawX, rawZ);
    // If clamping moved the anchor, push the clamped value back to it.
    if (cx !== rawX || cz !== rawZ) {
      anchor.position.x = cachedXzCenter.x + cx;
      anchor.position.z = cachedXzCenter.z + cz;
    }
    const rotationDeg = (anchor.rotation.y * 180) / Math.PI;
    // Push to store — rotation gets normalised inside the store.
    // Guard against self-notifying-loop by using syncingFromStore
    // while the store emits, so our own subscriber skips the
    // anchor-write.
    syncingFromStore = true;
    try {
      cutOverridesStore.setRotation(rotationDeg);
      cutOverridesStore.setCenterOffset(cx, cz);
    } finally {
      syncingFromStore = false;
    }
  }

  function onDraggingChanged(event: { value: unknown }): void {
    const dragging = Boolean(event.value);
    // Treat "any gizmo currently dragging" as the active state. With
    // two gizmos, check both.
    const tDrag =
      translateGizmo && typeof translateGizmo.dragging === 'boolean'
        ? translateGizmo.dragging
        : false;
    const rDrag =
      rotateGizmo && typeof rotateGizmo.dragging === 'boolean'
        ? rotateGizmo.dragging
        : false;
    activelyDragging = dragging || tDrag || rDrag;
    controls.enabled = !activelyDragging;
    if (!dragging && onDragRelease) {
      onDragRelease();
    }
  }

  function setupGizmos(): void {
    if (translateGizmo || rotateGizmo) return;

    translateGizmo = new TransformControls(camera, canvas);
    translateGizmo.setMode('translate');
    translateGizmo.showY = false;
    translateGizmo.attach(anchor);
    translateGizmo.addEventListener('objectChange', onGizmoObjectChange);
    translateGizmo.addEventListener('dragging-changed', onDraggingChanged);
    translateHelper = translateGizmo.getHelper();
    scene.add(translateHelper);

    rotateGizmo = new TransformControls(camera, canvas);
    rotateGizmo.setMode('rotate');
    rotateGizmo.showX = false;
    rotateGizmo.showZ = false;
    rotateGizmo.attach(anchor);
    rotateGizmo.addEventListener('objectChange', onGizmoObjectChange);
    rotateGizmo.addEventListener('dragging-changed', onDraggingChanged);
    rotateHelper = rotateGizmo.getHelper();
    scene.add(rotateHelper);
  }

  /**
   * Safely dispose a TransformControls instance. Three's
   * `TransformControls.dispose()` walks `this.traverse` internally — a
   * method `Controls` (the parent class) doesn't expose. On real
   * runtime this works because TransformControls monkey-patches the
   * traverse onto its own prototype; under test environments where the
   * gizmo might be partially constructed, we swallow the error so
   * test teardown doesn't fail.
   */
  function safeDispose(gizmo: TransformControls | null): void {
    if (!gizmo) return;
    try {
      gizmo.dispose();
    } catch {
      // Some three.js / jsdom combos raise "traverse is not a function"
      // here — TC.dispose() calls this.traverse which is only defined
      // when the class is properly constructed via the Controls base.
      // Swallow; the helper's subgraph is disposed via its own
      // `dispose()` below when we walk the helper tree.
    }
    // Dispose the helper's geometry/material walk as a defensive
    // backstop — some three.js versions put the GPU-owning nodes on
    // the helper rather than the controls instance.
    const helper = typeof gizmo.getHelper === 'function' ? gizmo.getHelper() : null;
    if (helper && typeof (helper as { traverse?: unknown }).traverse === 'function') {
      helper.traverse((child: unknown) => {
        const c = child as {
          geometry?: { dispose?: () => void };
          material?: { dispose?: () => void };
        };
        if (c.geometry?.dispose) c.geometry.dispose();
        if (c.material?.dispose) c.material.dispose();
      });
    }
  }

  function teardownGizmos(): void {
    if (translateGizmo) {
      translateGizmo.removeEventListener('objectChange', onGizmoObjectChange);
      translateGizmo.removeEventListener('dragging-changed', onDraggingChanged);
      translateGizmo.detach();
      safeDispose(translateGizmo);
      translateGizmo = null;
    }
    if (translateHelper) {
      if (translateHelper.parent) translateHelper.parent.remove(translateHelper);
      translateHelper = null;
    }
    if (rotateGizmo) {
      rotateGizmo.removeEventListener('objectChange', onGizmoObjectChange);
      rotateGizmo.removeEventListener('dragging-changed', onDraggingChanged);
      rotateGizmo.detach();
      safeDispose(rotateGizmo);
      rotateGizmo = null;
    }
    if (rotateHelper) {
      if (rotateHelper.parent) rotateHelper.parent.remove(rotateHelper);
      rotateHelper = null;
    }
    activelyDragging = false;
    controls.enabled = true;
  }

  // --- Public API ----------------------------------------------------------

  const api: CutPlanesPreviewApi = {
    attach(): void {
      if (disposed) return;
      if (attached) return;
      attached = true;
      scene.add(root);
      buildPlanes();
      applyStoreToAnchor();
      setupGizmos();
      unsubscribeStore = cutOverridesStore.subscribe(() => {
        // Skip writes we triggered ourselves from `onGizmoObjectChange`.
        if (syncingFromStore) return;
        applyStoreToAnchor();
      });
      root.visible = true;
    },
    detach(): void {
      if (!attached) return;
      attached = false;
      if (unsubscribeStore) {
        unsubscribeStore();
        unsubscribeStore = null;
      }
      teardownGizmos();
      disposePlanes();
      if (root.parent) root.parent.remove(root);
      root.visible = false;
    },
    rebuild(): void {
      if (!attached) return;
      buildPlanes();
      applyStoreToAnchor();
    },
    setVisible(v: boolean): void {
      root.visible = v;
      if (translateHelper) translateHelper.visible = v;
      if (rotateHelper) rotateHelper.visible = v;
    },
    isVisible(): boolean {
      return attached && root.visible;
    },
    isActivelyDragging(): boolean {
      return activelyDragging;
    },
    onFrame(): void {
      if (!attached) return;
      // Axis-constraint defense: ensure the anchor never drifts off
      // the Y plane or picks up X/Z tilt. These are theoretically
      // prevented by showX/Z + showY=false on the respective gizmos,
      // but TransformControls has historically had edge cases where
      // a diagonal drag can introduce off-axis motion.
      if (anchor.position.y !== cachedYCenter) {
        anchor.position.y = cachedYCenter;
      }
      if (anchor.rotation.x !== 0) anchor.rotation.x = 0;
      if (anchor.rotation.z !== 0) anchor.rotation.z = 0;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      api.detach();
      planeMaterial.dispose();
    },
  };

  return api;
}
