// src/renderer/scene/viewport.ts
//
// Glue: wire renderer + scene + camera + controls + axes overlay into a
// container element, run a hidden-page-aware RAF loop, and expose a
// `dispose()` and `setMaster()` for the outside world.
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
import type { Mesh, PerspectiveCamera, Scene, WebGLRenderer } from 'three';

import { createCamera, computeAspect, frameToBox3 } from './camera';
import { createControls } from './controls';
import {
  createAxesGizmo,
  OVERLAY_PADDING_PX,
  OVERLAY_SIZE_PX,
  type AxesGizmoOverlay,
} from './gizmos';
import { createLayFlatController, type LayFlatController } from './layFlatController';
import { createRenderer, resizeRendererToContainer } from './renderer';
import { createScene } from './index';
import { setMaster as sceneSetMaster, type MasterResult } from './master';

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
  /**
   * Load an STL buffer as the active master: parses, builds the mesh, swaps
   * out any previous master, then frames the camera + orbit to the mesh's
   * AABB with 1.4× padding. Resolves with the `MasterResult` (mesh, volume,
   * bbox) so callers can update dependent UI (e.g. the topbar volume
   * readout).
   */
  setMaster: (buffer: ArrayBuffer) => Promise<MasterResult>;
  /**
   * Enter "Place on face" (lay-flat) mode. Pointer move highlights the
   * face under the cursor; click commits a rotation so that face lies
   * flat on the print bed. No-op if no master is loaded. Escape key exits.
   */
  enableFacePicking: () => void;
  /** Exit "Place on face" mode. Safe to call when already inactive. */
  disableFacePicking: () => void;
  /** Whether face-picking mode is currently active. */
  isFacePickingActive: () => boolean;
  /**
   * Reset the master's orientation to identity and re-run the auto-center
   * pass. The camera is re-framed to the restored AABB. No-op when no
   * master is loaded.
   */
  resetOrientation: () => void;
  /**
   * Whether the user has committed an orientation via Place-on-face since
   * the last reset or master load. Mirrors the controller's `isCommitted()`.
   *
   * The Generate-mold button (issue #36) gates on this: pristine /
   * post-reset / post-Open-STL state returns `false`; post-commit returns
   * `true`. Subscribers should prefer `LAY_FLAT_COMMITTED_EVENT` on
   * `document` over polling this on every frame.
   */
  isOrientationCommitted: () => boolean;
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

  // Lay-flat (Place-on-face) controller. Widgets attach to the scene's
  // 'widgets' group (created by createScene). The controller is idle
  // until `enableFacePicking()` is called. It holds a getter reference
  // to the current master so swap-master (below) keeps it working.
  let layFlatMasterMesh: Mesh | null = null;
  const layFlat: LayFlatController = createLayFlatController({
    scene,
    camera,
    controls,
    canvas,
    getMasterMesh: () => layFlatMasterMesh,
  });

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

  // `setMaster` wires the scene-level loader into the camera + orbit retarget.
  // We also notify any consumers waiting on `__testHooks.masterLoaded` so
  // E2E specs can `await` the load flow deterministically.
  let masterLoadedResolve: (() => void) | null = null;
  let masterLoaded: Promise<void> = new Promise<void>((resolve) => {
    masterLoadedResolve = resolve;
  });

  const setMaster = async (buffer: ArrayBuffer): Promise<MasterResult> => {
    // Exit any active lay-flat session before swapping the master — the old
    // mesh (and its BVH) is about to be disposed, and stale cursor listeners
    // would point at freed GPU resources.
    if (layFlat.isActive()) layFlat.disable();
    const result = await sceneSetMaster(scene, buffer);
    layFlatMasterMesh = result.mesh;
    // `scene/master.ts` resets the group quaternion to identity on every
    // load (see its "Reset rotation before adding the new mesh" block).
    // Tell the lay-flat controller so it clears any lingering committed
    // flag and fires `LAY_FLAT_COMMITTED_EVENT` — the Generate-mold button
    // (#36) re-disables itself on this edge.
    layFlat.notifyMasterReset();
    frameToBox3(camera, controls, result.bbox);
    // Signal test hooks, then install a fresh promise so a second load
    // is independently awaitable.
    if (masterLoadedResolve) {
      masterLoadedResolve();
      masterLoadedResolve = null;
    }
    if (BUILD_TIME_TEST) {
      // Rotate the promise so callers that grab a reference AFTER the first
      // load still have something that resolves on the next load.
      const nextPromise = new Promise<void>((resolve) => {
        masterLoadedResolve = resolve;
      });
      masterLoaded = nextPromise;
      const w = window as unknown as {
        __testHooks?: Record<string, unknown>;
      };
      if (w.__testHooks) w.__testHooks['masterLoaded'] = masterLoaded;
    }
    return result;
  };

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
    // `masterLoaded` starts as a pending promise; E2E specs can `await` it
    // after clicking Open STL. The promise is rotated on each successful
    // load so each new call-site sees a fresh waitable.
    hooks['masterLoaded'] = masterLoaded;
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
    layFlat.dispose();
    controls.dispose();
    renderer.dispose();
    if (canvas.parentElement === container) {
      container.removeChild(canvas);
    }
  };

  const handle: MountedViewport = {
    scene,
    camera,
    renderer,
    controls,
    axes,
    setMaster,
    enableFacePicking: () => layFlat.enable(),
    disableFacePicking: () => layFlat.disable(),
    isFacePickingActive: () => layFlat.isActive(),
    resetOrientation: () => layFlat.reset(),
    isOrientationCommitted: () => layFlat.isCommitted(),
    dispose,
  };

  // Expose the full handle on the test-hook surface so E2E specs can drive
  // `setMaster` directly (bypassing the file dialog) — useful for visual
  // regression snapshots that need a known mesh in the viewport.
  if (BUILD_TIME_TEST) {
    const w = window as unknown as {
      __testHooks?: Record<string, unknown>;
    };
    if (w.__testHooks) w.__testHooks['viewport'] = handle;
  }

  return handle;
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
