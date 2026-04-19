// src/renderer/scene/camera.ts
//
// Perspective camera matching the three-js-viewer skill:
//   fov = 45°, near = 1 mm, far = 5000 mm. Y-up. One Three.js unit = 1 mm.
//
// On init we frame a unit cube (placeholder AABB). The real frame-to-mesh
// behaviour arrives with mesh loading in a later PR.

import { PerspectiveCamera, Box3, Vector3 } from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export const CAMERA_FOV_DEG = 45;
export const CAMERA_NEAR = 1;
export const CAMERA_FAR = 5000;

/** Padding factor applied to AABB fit. Matches the skill convention (1.4×). */
const FRAME_PADDING = 1.4;

/**
 * Create the scene's single perspective camera. Aspect is derived from the
 * container's current client size (fall back to 16:10 if the container has
 * zero size, e.g. before layout).
 *
 * Framing on init: a placeholder 200 mm cube centred at the origin. The
 * issue spec calls for a "unit cube" frame, but in a mm-scale scene that
 * puts the camera inside the near plane (1 mm) and clips the entire scene.
 * A 200-mm placeholder sits comfortably in front of near and keeps the
 * 1000-mm grid visible. Real frame-to-mesh behaviour arrives with mesh
 * loading in a later PR.
 */
export const INITIAL_FRAME_HALF_EXTENT_MM = 100;

export function createCamera(container: HTMLElement): PerspectiveCamera {
  const aspect = computeAspect(container);
  const camera = new PerspectiveCamera(
    CAMERA_FOV_DEG,
    aspect,
    CAMERA_NEAR,
    CAMERA_FAR,
  );

  const h = INITIAL_FRAME_HALF_EXTENT_MM;
  frameBox(camera, new Box3(new Vector3(-h, -h, -h), new Vector3(h, h, h)));

  return camera;
}

export function computeAspect(container: HTMLElement): number {
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (w <= 0 || h <= 0) return 16 / 10;
  return w / h;
}

/**
 * Position the camera so `box` fits in view with a small padding, looking at
 * the box centre from a fixed iso-ish angle (+X, +Y, +Z octant). Visible
 * in visual tests — keep deterministic.
 */
export function frameBox(
  camera: PerspectiveCamera,
  box: Box3,
  padding = FRAME_PADDING,
): void {
  const size = new Vector3();
  const center = new Vector3();
  box.getSize(size);
  box.getCenter(center);

  const maxDim = Math.max(size.x, size.y, size.z, 1e-3);
  const fovRad = (camera.fov * Math.PI) / 180;
  // Distance so the largest dimension fits the vertical FOV, times padding.
  const distance = (maxDim / 2 / Math.tan(fovRad / 2)) * padding;

  // Fixed iso-ish viewpoint. Deterministic: same camera for every visual test
  // until mesh loading supplies a per-mesh target.
  const dir = new Vector3(1, 1, 1).normalize();
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.up.set(0, 1, 0);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

/**
 * Frame the camera AND retarget the OrbitControls to a given AABB.
 *
 * Why this exists (and not just `frameBox`):
 *   - `frameBox` repositions the camera and calls `camera.lookAt(center)`,
 *     which sets the camera's rotation to look at `center`. But OrbitControls
 *     owns orbit rotation via its own `.target` — if we don't update the
 *     controls' target, the next mouse-drag snaps the camera back to orbit
 *     around the old target (typically origin). That is jarring and hides
 *     the freshly-loaded mesh.
 *   - We therefore set `controls.target` to the box centre AND call
 *     `controls.update()` so the camera's rotation is re-derived from
 *     target + position in one consistent pass.
 *
 * `padding` defaults to 1.4 per the three-js-viewer skill ("Frame-on-load
 * to master's AABB with 1.4× padding").
 */
export function frameToBox3(
  camera: PerspectiveCamera,
  controls: OrbitControls,
  box: Box3,
  padding = FRAME_PADDING,
): void {
  const center = new Vector3();
  box.getCenter(center);

  // Position the camera via the shared helper. `frameBox` calls
  // `camera.lookAt(center)`; we re-assert that orientation via
  // `controls.update()` below so both agree on the target.
  frameBox(camera, box, padding);

  // Retarget the orbit so subsequent pans/rotates pivot around the mesh,
  // not the world origin.
  controls.target.copy(center);
  controls.update();
}
