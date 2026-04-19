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

/** Dimensions for the flat normal-indicator quad, in mm. */
const NORMAL_QUAD_SIZE_MM = 15;

export interface LayFlatController {
  /** Enter picking mode: attach listeners, show cursor as crosshair. */
  enable(): void;
  /** Exit picking mode: detach listeners, hide widgets. */
  disable(): void;
  /** Return the group to identity rotation and re-center + re-frame. */
  reset(): void;
  /** Whether picking mode is currently active. */
  isActive(): boolean;
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

    widgets.visible = true;
  }

  function hideWidgets(): void {
    widgets.visible = false;
  }

  // --- Pointer handlers -----------------------------------------------------

  function onPointerMove(ev: PointerEvent): void {
    if (!active) return;
    const mesh = getMasterMesh();
    if (!mesh) {
      hideWidgets();
      return;
    }
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

  function onClick(ev: PointerEvent): void {
    if (!active) return;
    // Only primary-button clicks commit. Right-drag is OrbitControls pan —
    // we must not hijack it.
    if (ev.button !== 0) return;

    const mesh = getMasterMesh();
    if (!mesh) return;

    // Re-pick at the click position so the commit acts on whatever's under
    // the cursor at the moment of click — not whatever pointermove last saw,
    // which could be one frame behind. Feels tighter.
    const pick = pickFaceUnderPointer(ev, canvas, camera, mesh);
    if (!pick) return;

    commit(pick, mesh);
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
    // mode auto-exits on commit").
    disable();
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
  }

  // --- Enable / disable / dispose -------------------------------------------

  function emitActiveChanged(): void {
    document.dispatchEvent(
      new CustomEvent<boolean>(LAY_FLAT_ACTIVE_EVENT, { detail: active }),
    );
  }

  function enable(): void {
    if (disposed) return;
    if (active) return;
    const mesh = getMasterMesh();
    if (!mesh) return;
    active = true;
    canvas.style.cursor = 'crosshair';
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('click', onClick);
    window.addEventListener('keydown', onKeyDown);
    emitActiveChanged();
  }

  function disable(): void {
    if (!active) return;
    active = false;
    canvas.style.cursor = '';
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    canvas.removeEventListener('click', onClick);
    window.removeEventListener('keydown', onKeyDown);
    hideWidgets();
    emitActiveChanged();
  }

  function dispose(): void {
    disable();
    disposed = true;
    triOutlineGeom.dispose();
    triOutlineMat.dispose();
    quadGeom.dispose();
    quadMat.dispose();
    if (widgets.parent) widgets.parent.remove(widgets);
  }

  return {
    enable,
    disable,
    reset,
    isActive: () => active,
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
