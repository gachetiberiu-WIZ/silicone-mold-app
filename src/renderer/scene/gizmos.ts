// src/renderer/scene/gizmos.ts
//
// Scene gizmos per the three-js-viewer skill:
//   - XZ grid at y=0, 100 mm major / 10 mm minor
//   - World AxesHelper anchored at the origin (so axis stems are visible
//     against meshes in the scene and occlude correctly behind them)
//   - Corner AxesHelper in the bottom-left (rendered via an overlay scene
//     so it doesn't scale with camera zoom)
//
// The overlay pattern: a second small Scene containing an AxesHelper + its
// own OrthographicCamera. The viewport owns renderer sequencing and clears
// the depth buffer before rendering the overlay into a clipped bottom-left
// viewport box.

import {
  AxesHelper,
  type Camera,
  Group,
  GridHelper,
  OrthographicCamera,
  Scene,
} from 'three';

/** Grid total size in mm. 1000 mm covers a comfortable build volume. */
const GRID_SIZE_MM = 1000;
/** Major divisions = 10 × 100 mm per skill convention. */
const GRID_DIVISIONS_MAJOR = 10;

/**
 * World AxesHelper stem length in mm. Half the grid extent keeps the stems
 * inside the visible grid footprint at default framing.
 */
const WORLD_AXES_SIZE_MM = 500;

/**
 * Vertical offset, in mm, applied to the grid group so it sits a hair below
 * y=0. Fixes z-fighting between the grid lines and the world AxesHelper at
 * the origin (both would otherwise rasterise to identical depth values on
 * the XZ plane).
 *
 * The issue (#26) surfaced four candidate fixes:
 *   1. Nudge the grid below y=0 by ε (this).
 *   2. `polygonOffset` on the grid material — does NOT work. GridHelper
 *      uses `LineSegments`; `GL_POLYGON_OFFSET_FILL` only affects filled
 *      polygons in the WebGL spec. Verified and rejected.
 *   3. Second render pass for axes — over-engineered for a 1-line fix.
 *   4. `depthTest: false` on axes — rejected (axes would shine through
 *      meshes sitting on the bed).
 *
 * Magnitude chosen: 0.01 mm. Comfortably above the float32 depth-buffer
 * noise floor at near=1/far=5000, below the 1e-4 relative tolerance the
 * geometry module asserts on (`CLAUDE.md` §Units), and imperceptible at
 * any practical zoom — 1/100 of a millimetre on a 1000 mm grid.
 */
const GRID_Y_EPSILON_MM = -0.01;

/** Axes gizmo size in overlay units (overlay ortho camera frames exactly
 *  ±1). 0.8 leaves some padding inside the overlay box. */
const OVERLAY_AXES_SIZE = 0.8;

/** Overlay viewport box size in CSS pixels. */
export const OVERLAY_SIZE_PX = 96;
/** Padding from the bottom-left edge of the canvas, in CSS pixels. */
export const OVERLAY_PADDING_PX = 12;

/**
 * Create the origin group: XZ ground grid (nudged a hair below y=0 per
 * `GRID_Y_EPSILON_MM`) + world-space AxesHelper anchored at the origin.
 *
 * Three's `GridHelper` draws in the XZ plane by default — exactly what we
 * want for a Y-up scene. Colours are low-contrast to keep the grid from
 * dominating the image; visible against the `#1b1d22` background.
 *
 * The returned Group carries tag `origin-gizmos`; its children are tagged
 * `grid-major`, `grid-minor`, and `world-axes` so the exploded-view
 * animator and test-hook assertions can locate them by `userData.tag`.
 */
export function createOriginGizmos(): Group {
  const group = new Group();
  group.userData['tag'] = 'origin-gizmos';

  const major = new GridHelper(
    GRID_SIZE_MM,
    GRID_DIVISIONS_MAJOR,
    0x4b5563, // centre lines — slightly brighter
    0x2b3038, // other major lines — subtle
  );
  major.position.y = GRID_Y_EPSILON_MM;
  major.userData['tag'] = 'grid-major';

  // Minor subdivisions: 10× finer (10 mm per minor cell). Nudged another
  // hair below the major grid to avoid self-z-fighting between the two
  // grids. Absolute world y = GRID_Y_EPSILON_MM + -0.001 = -0.011 mm.
  const minor = new GridHelper(
    GRID_SIZE_MM,
    GRID_DIVISIONS_MAJOR * 10,
    0x23272e,
    0x23272e,
  );
  minor.position.y = -0.001;
  minor.userData['tag'] = 'grid-minor';
  major.add(minor);

  // World-space axes anchored at the origin. Standard colours (X red, Y
  // green, Z blue) come from `AxesHelper`. The axis lines sit EXACTLY at
  // y=0 on the XZ plane; the grid is nudged below them so the depth test
  // resolves cleanly in favour of the axes wherever they overlap the grid.
  //
  // `depthTest` stays true (default) — axes must still occlude behind
  // meshes that sit on the print bed.
  const axes = new AxesHelper(WORLD_AXES_SIZE_MM);
  axes.userData['tag'] = 'world-axes';

  group.add(major);
  group.add(axes);
  return group;
}

/**
 * Axes gizmo overlay. Returns the mini-scene + its camera; the viewport
 * drives rendering into a clipped bottom-left viewport box. Standard colours
 * (X red, Y green, Z blue) come from `AxesHelper`.
 */
export interface AxesGizmoOverlay {
  readonly scene: Scene;
  readonly camera: OrthographicCamera;
  readonly root: Group;
  /** Sync the overlay's orientation to the main camera so dragging the
   *  scene rotates the gizmo in lockstep. Called each RAF tick. */
  sync(mainCamera: Camera): void;
}

export function createAxesGizmo(): AxesGizmoOverlay {
  const scene = new Scene();
  const root = new Group();
  root.userData['tag'] = 'axes-gizmo';

  const axes = new AxesHelper(OVERLAY_AXES_SIZE);
  root.add(axes);
  scene.add(root);

  // Ortho camera framed to a ±1 box, looking down -Z toward the origin.
  // The main camera's quaternion is copied (inverted) into the gizmo's root
  // each frame, so orbiting the main view rotates the axes here in sync.
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.set(0, 0, 3);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);

  return {
    scene,
    camera,
    root,
    sync(mainCamera) {
      root.quaternion.copy(mainCamera.quaternion).invert();
    },
  };
}
