// src/renderer/scene/controls.ts
//
// OrbitControls wrapper. Per the three-js-viewer skill, damping is disabled
// when `NODE_ENV === 'test'` for visual-regression determinism.

import type { PerspectiveCamera } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export interface CreateControlsOptions {
  /** True when running under NODE_ENV === 'test'. Disables damping. */
  test: boolean;
}

export function createControls(
  camera: PerspectiveCamera,
  domElement: HTMLElement,
  options: CreateControlsOptions,
): OrbitControls {
  const controls = new OrbitControls(camera, domElement);

  // Damping ON in prod for smooth rotate; OFF in tests so snapshots are
  // framewise-deterministic (no half-lerped transitions).
  controls.enableDamping = !options.test;
  controls.dampingFactor = 0.08;

  // Orbit around the world origin by default; the viewport retargets this
  // when a mesh is loaded in a later PR.
  controls.target.set(0, 0, 0);

  // Sensible camera limits for a desktop mm-scale scene. Far is well under
  // the camera's far plane (5000) to avoid clipping during pan/zoom-out.
  controls.minDistance = 10;
  controls.maxDistance = 3000;

  // Screen-space panning feels natural for an STL viewer.
  controls.screenSpacePanning = true;

  controls.update();
  return controls;
}
