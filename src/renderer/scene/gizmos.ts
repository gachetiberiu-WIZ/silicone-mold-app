// src/renderer/scene/gizmos.ts
//
// Scene gizmos per the three-js-viewer skill:
//   - XZ grid at y=0, 100 mm major / 10 mm minor
//   - AxesHelper in the bottom-left (rendered via an overlay scene so it
//     doesn't scale with camera zoom)
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

/** Axes gizmo size in overlay units (overlay ortho camera frames exactly
 *  ±1). 0.8 leaves some padding inside the overlay box. */
const OVERLAY_AXES_SIZE = 0.8;

/** Overlay viewport box size in CSS pixels. */
export const OVERLAY_SIZE_PX = 96;
/** Padding from the bottom-left edge of the canvas, in CSS pixels. */
export const OVERLAY_PADDING_PX = 12;

/**
 * Create the XZ ground grid at y=0.
 *
 * Three's `GridHelper` draws in the XZ plane by default — exactly what we
 * want for a Y-up scene. Colours are low-contrast to keep the grid from
 * dominating the image; visible against the `#1b1d22` background.
 *
 * Returns the major-grid helper with a minor-grid helper attached as a
 * child so the caller treats them as a single unit.
 */
export function createGrid(): GridHelper {
  const major = new GridHelper(
    GRID_SIZE_MM,
    GRID_DIVISIONS_MAJOR,
    0x4b5563, // centre lines — slightly brighter
    0x2b3038, // other major lines — subtle
  );
  major.position.y = 0;
  major.userData['tag'] = 'grid-major';

  // Minor subdivisions: 10× finer (10 mm per minor cell). Nudged a hair below
  // the major grid to avoid z-fighting.
  const minor = new GridHelper(
    GRID_SIZE_MM,
    GRID_DIVISIONS_MAJOR * 10,
    0x23272e,
    0x23272e,
  );
  minor.position.y = -0.001;
  minor.userData['tag'] = 'grid-minor';

  major.add(minor);
  return major;
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
