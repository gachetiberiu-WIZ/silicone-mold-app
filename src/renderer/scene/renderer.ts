// src/renderer/scene/renderer.ts
//
// Thin factory around `THREE.WebGLRenderer`. Two concerns live here:
//
//   1. Test determinism. Per `.claude/skills/three-js-viewer/SKILL.md` and
//      `.claude/skills/testing-3d/SKILL.md`, visual-regression goldens need
//      `antialias: false` and `setPixelRatio(1)`. We detect that via the
//      `test` flag supplied by the caller (set from `NODE_ENV === 'test'`).
//   2. Canvas sizing. The renderer sizes itself to the container and exposes
//      a resize helper that honours the container's current client size.
//
// The renderer does NOT own the RAF loop — that's the viewport's job.

import { WebGLRenderer } from 'three';

export interface CreateRendererOptions {
  /** True when running under NODE_ENV === 'test'. Disables AA, pins DPR = 1. */
  test: boolean;
}

/**
 * Background colour for the scene. Dark neutral per the three-js-viewer skill
 * (`#1b1d22`). When a theme system lands, this moves out of here.
 */
export const SCENE_BACKGROUND = 0x1b1d22;

export function createRenderer(options: CreateRendererOptions): WebGLRenderer {
  const renderer = new WebGLRenderer({
    antialias: !options.test,
    alpha: false,
    powerPreference: 'high-performance',
  });

  // Pixel ratio: 1 in test (deterministic snapshots), devicePixelRatio in prod.
  const dpr = options.test ? 1 : window.devicePixelRatio;
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(SCENE_BACKGROUND, 1);

  return renderer;
}

/**
 * Resize the renderer's drawing buffer to match the container's client box.
 * Returns the new width/height so callers can update the camera aspect ratio
 * in the same pass.
 */
export function resizeRendererToContainer(
  renderer: WebGLRenderer,
  container: HTMLElement,
): { width: number; height: number } {
  const width = Math.max(1, container.clientWidth);
  const height = Math.max(1, container.clientHeight);
  renderer.setSize(width, height, /* updateStyle */ false);
  return { width, height };
}
