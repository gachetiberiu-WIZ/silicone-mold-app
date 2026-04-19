// src/renderer/scene/viewport.ts
//
// Glue: wire renderer + scene + camera + controls + axes overlay into a
// container element, run a hidden-page-aware RAF loop, and expose a
// `dispose()` for teardown.
//
// The `test` mode (disables antialias + DPR + OrbitControls damping) is
// derived from two signals, either of which suffices:
//
//   1. Build-time:   `process.env.NODE_ENV === 'test'`  — Vite replaces this
//      at build time. Gates the `window.__testHooks` block so production
//      bundles are stripped of test-only code (per `.claude/skills/three-
//      js-viewer/SKILL.md`).
//   2. Runtime:      URL query `?test=1`                 — Lets a production
//      bundle render deterministically when loaded from a visual-regression
//      spec. Does NOT enable test-hook exposure.

import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { PerspectiveCamera, Scene, WebGLRenderer } from 'three';

import { createCamera, computeAspect } from './camera';
import { createControls } from './controls';
import {
  createAxesGizmo,
  OVERLAY_PADDING_PX,
  OVERLAY_SIZE_PX,
  type AxesGizmoOverlay,
} from './gizmos';
import { createRenderer, resizeRendererToContainer } from './renderer';
import { createScene } from './index';

function hasTestQueryFlag(): boolean {
  if (typeof window === 'undefined') return false;
  const q = window.location?.search ?? '';
  if (!q) return false;
  return new URLSearchParams(q).get('test') === '1';
}

/** True at build time under test mode. Vite folds this to a constant. */
const BUILD_TIME_TEST = process.env.NODE_ENV === 'test';

export interface MountedViewport {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly renderer: WebGLRenderer;
  readonly controls: OrbitControls;
  readonly axes: AxesGizmoOverlay;
  /** Stop RAF, detach listeners, dispose GPU resources, remove the canvas. */
  dispose: () => void;
}

export function mount(container: HTMLElement): MountedViewport {
  // Render determinism is requested via either build-time NODE_ENV=test OR
  // a runtime `?test=1` query param. See top-of-file note for the rationale.
  const testRuntime = hasTestQueryFlag();
  const test = BUILD_TIME_TEST || testRuntime;

  const renderer = createRenderer({ test });
  const canvas = renderer.domElement;
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  container.appendChild(canvas);

  const scene = createScene();
  const camera = createCamera(container);
  const controls = createControls(camera, canvas, { test });
  const axes = createAxesGizmo();

  // Initial size sync after everything is wired.
  syncSize(renderer, camera, container);

  // Resize: a ResizeObserver on the container catches every layout change
  // (window resize, devtools dock, split-pane drag). Falls back to
  // `window.resize` if ResizeObserver is unavailable (universal in Electron
  // Chromium, but guard defensively).
  let resizeObserver: ResizeObserver | null = null;
  const onWindowResize = () => syncSize(renderer, camera, container);
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() =>
      syncSize(renderer, camera, container),
    );
    resizeObserver.observe(container);
  } else {
    window.addEventListener('resize', onWindowResize);
  }

  // RAF loop. Pause when the page is hidden (battery + determinism).
  let rafId = 0;
  let running = true;

  const tick = () => {
    if (!running) return;
    rafId = requestAnimationFrame(tick);

    controls.update();

    // Main pass — full-canvas viewport, no scissor.
    const canvasW = renderer.domElement.width;
    const canvasH = renderer.domElement.height;
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, canvasW, canvasH);
    renderer.render(scene, camera);

    // Overlay pass — axes gizmo clipped to a bottom-left viewport. Clear
    // only depth; the main image stays in the colour buffer.
    axes.sync(camera);
    const dpr = renderer.getPixelRatio();
    const overlayPx = OVERLAY_SIZE_PX * dpr;
    const paddingPx = OVERLAY_PADDING_PX * dpr;
    const x = paddingPx;
    const y = paddingPx; // WebGL origin is bottom-left.
    renderer.setScissorTest(true);
    renderer.setViewport(x, y, overlayPx, overlayPx);
    renderer.setScissor(x, y, overlayPx, overlayPx);
    renderer.clearDepth();
    renderer.render(axes.scene, axes.camera);
    renderer.setScissorTest(false);
  };

  const onVisibilityChange = () => {
    if (document.hidden) {
      if (running) {
        running = false;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
      }
    } else {
      if (!running) {
        running = true;
        rafId = requestAnimationFrame(tick);
      }
    }
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  // Test-hook surface — gated on BUILD-TIME NODE_ENV=test so prod bundles
  // tree-shake this block. Runtime `?test=1` alone does NOT expose hooks.
  if (BUILD_TIME_TEST) {
    const w = window as unknown as {
      __testHooks?: Record<string, unknown>;
    };
    const hooks = (w.__testHooks ??= {});
    hooks['scene'] = scene;
    hooks['camera'] = camera;
    hooks['renderer'] = renderer;
    hooks['viewportReady'] = true;
  }

  rafId = requestAnimationFrame(tick);

  const dispose = () => {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (resizeObserver) {
      resizeObserver.disconnect();
    } else {
      window.removeEventListener('resize', onWindowResize);
    }
    controls.dispose();
    renderer.dispose();
    if (canvas.parentElement === container) {
      container.removeChild(canvas);
    }
  };

  return { scene, camera, renderer, controls, axes, dispose };
}

function syncSize(
  renderer: WebGLRenderer,
  camera: PerspectiveCamera,
  container: HTMLElement,
): void {
  resizeRendererToContainer(renderer, container);
  camera.aspect = computeAspect(container);
  camera.updateProjectionMatrix();
}
