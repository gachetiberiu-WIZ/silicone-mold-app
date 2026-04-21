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
import { Box3, type Group, Mesh, type PerspectiveCamera, type Scene, type WebGLRenderer } from 'three';
import type { Manifold } from 'manifold-3d';

import { createCamera, computeAspect, frameToBox3 } from './camera';
import { createControls } from './controls';
import {
  createAxesGizmo,
  OVERLAY_PADDING_PX,
  OVERLAY_SIZE_PX,
  type AxesGizmoOverlay,
} from './gizmos';
import { recenterGroup } from './layFlat';
import { createLayFlatController, type LayFlatController } from './layFlatController';
import { createRenderer, resizeRendererToContainer } from './renderer';
import { createScene } from './index';
import {
  disposeMaster as sceneDisposeMaster,
  getNativeBbox as sceneGetNativeBbox,
  setMaster as sceneSetMaster,
  type MasterResult,
} from './master';
import {
  clearSilicone as sceneClearSilicone,
  isExplodedViewIdle as sceneIsExplodedViewIdle,
  setExplodedView as sceneSetExplodedView,
  setSilicone as sceneSetSilicone,
  type SiliconeResult,
} from './silicone';
import {
  arePrintablePartsVisible as sceneArePrintablePartsVisible,
  clearPrintableParts as sceneClearPrintableParts,
  hasPrintableParts as sceneHasPrintableParts,
  isPrintableExplodedIdle as sceneIsPrintableExplodedIdle,
  setPrintableParts as sceneSetPrintableParts,
  setPrintablePartsExplodedView as sceneSetPrintablePartsExplodedView,
  setPrintablePartsVisible as sceneSetPrintablePartsVisible,
  type PrintablePartsResult,
} from './printableParts';

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
  /**
   * Install the freshly-generated silicone Manifold (Wave-A single-body
   * contract, issue #69). Transfers ownership to the scene — caller must
   * NOT `.delete()` it after this call. After installing, re-frames the
   * camera to the union of the master + silicone bbox so the full
   * result is visible.
   */
  setSilicone: (payload: { silicone: Manifold }) => Promise<SiliconeResult>;
  /**
   * Tear down any silicone currently in the scene and release the paired
   * Manifolds. Idempotent. Wired to every staleness signal (commit,
   * reset, new-STL) via the generate-invalidation listener.
   */
  clearSilicone: () => void;
  /** Toggle the exploded-view animation on/off. No-op when no silicone. */
  setExplodedView: (exploded: boolean) => void;
  /**
   * Whether the exploded-view RAF tween has settled. `true` when no
   * silicone is installed, or the tween has completed / never started.
   *
   * Exists so visual-regression tests can gate `toHaveScreenshot` on a
   * converged scene — the tween uses real `performance.now()` + `requestAnimationFrame`,
   * which Playwright's `page.clock` fake doesn't intercept (issue #53).
   * Read-only and safe to poll from `page.waitForFunction`.
   */
  isExplodedViewIdle: () => boolean;
  /**
   * Install freshly-generated print-shell + base-slab Manifolds (Wave D,
   * issue #82 — two meshes in the printable-parts group). Transfers
   * ownership of both Manifolds to the scene; caller must NOT
   * `.delete()` them after this call. After installing, re-frames the
   * camera to the union of master + silicone + shell + slab bboxes.
   */
  setPrintableParts: (parts: {
    printShell: Manifold;
    basePart: Manifold;
  }) => Promise<PrintablePartsResult>;
  /**
   * Tear down any printable parts currently in the scene and release
   * paired Manifolds. Idempotent.
   */
  clearPrintableParts: () => void;
  /** Flip the printable-parts group visibility. No-op when no parts. */
  setPrintablePartsVisible: (visible: boolean) => void;
  /** Toggle printable-parts exploded-view animation. No-op when no parts. */
  setPrintablePartsExplodedView: (exploded: boolean) => void;
  /**
   * Whether the printable-parts group is currently visible. Used by
   * Playwright E2E specs as `viewport.arePrintablePartsVisible()` per
   * issue #62.
   */
  arePrintablePartsVisible: () => boolean;
  /**
   * Whether the printable-parts tween is idle. Mirror of
   * `isExplodedViewIdle` for the printable-parts module — same
   * Playwright-page.clock rationale. Used by visual-regression specs
   * alongside `isExplodedViewIdle` to wait for BOTH modules' tweens
   * to converge before screenshot (issue #62 visual-golden AC).
   */
  isPrintableExplodedIdle: () => boolean;
  /** Whether a printable-parts set is currently installed. */
  hasPrintableParts: () => boolean;
  /**
   * Issue #67 — whether the face-pick hover overlay is currently visible.
   * Exposed as a test-hook read so E2E specs can assert the hover feedback
   * without reaching through the lay-flat controller's internals. Returns
   * `false` when picking mode is inactive or the cursor is off the master
   * mesh; `true` when the cursor is over a triangle and the coplanar
   * overlay has been populated.
   */
  isFaceHoverOverlayVisible: () => boolean;
  /**
   * Issue #79 — apply a per-axis scale to the master group. Writes
   * `group.scale.set(sx, sy, sz)`, then re-runs `recenterGroup` so the
   * scaled mesh stays planted on the print bed (lowest Y=0, centered on
   * X=0/Z=0), and re-frames the camera to the new world AABB.
   *
   * Non-destructive: the underlying `BufferGeometry` and cached `Manifold`
   * are untouched. `generateMold` already receives `masterGroup.matrixWorld`
   * as its `viewTransform`, so the scale flows through to the geometry
   * kernel automatically — no changes to the generate pipeline.
   *
   * No-op when no master is loaded. Negative / zero / non-finite axes are
   * rejected (we early-return rather than throw — the UI layer clamps
   * inputs upstream).
   */
  setMasterScale: (scale: { sx: number; sy: number; sz: number }) => void;
  /**
   * Issue #79 — read-side companion to `setMasterScale`. Returns the
   * native (pre-transform) mesh-local AABB as a fresh `Box3`, or `null`
   * when no master is loaded. Used by the Dimensions panel to derive
   * live mm readouts as `nativeBbox × scale[axis]`.
   */
  getNativeBbox: () => Box3 | null;
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

  /**
   * Install a fresh silicone Manifold (Wave-A single-body contract) into
   * the scene. After the scene-side adapter finishes, re-frame the camera
   * to the union of the master group's bbox and the silicone bbox — so
   * the user sees the whole result without a manual zoom-out.
   *
   * Ownership: transfers the Manifold to the scene module. The caller
   * (orchestrator happy-path) must NOT `.delete()` it after this
   * resolves. On a throw, `scene/silicone.ts::setSilicone` disposes the
   * Manifold before re-throwing, so the error branch preserves the
   * lifetime contract without a second dispose here.
   */
  const setSilicone = async (
    payload: { silicone: Manifold },
  ): Promise<SiliconeResult> => {
    const installed = await sceneSetSilicone(scene, payload);

    // Union the silicone bbox with the master group's world-space bbox.
    // `Box3.setFromObject(masterGroup)` is fine here because the master
    // group's world matrix is maintained current by every transform path
    // (setMaster, lay-flat commit, reset) — no stale matrix risk.
    const masterGroup = scene.children.find(
      (c) => c.userData['tag'] === 'master',
    );
    const union = installed.bbox.clone();
    if (masterGroup) {
      const masterBbox = new Box3().setFromObject(masterGroup);
      if (!masterBbox.isEmpty()) union.union(masterBbox);
    }

    // Defence-in-depth: only frame if the union is non-empty. The
    // silicone bbox is non-empty by construction (two halves always have
    // vertices), but a fully-degenerate scene shouldn't crash the framer.
    if (!union.isEmpty()) {
      frameToBox3(camera, controls, union);
    }

    return installed;
  };

  /**
   * Install a freshly-generated print-shell Manifold (Wave-C single-mesh
   * contract, issue #72). Transfers ownership to the scene module. After
   * the adapter finishes, re-frames the camera to the union of the
   * master + silicone + print-shell bboxes so the whole assembly is
   * visible.
   *
   * On throw: `scene/printableParts.ts::setPrintableParts` disposes the
   * input Manifold before re-throwing, so the error branch preserves the
   * lifetime contract without a second dispose here.
   */
  const setPrintableParts = async (
    parts: { printShell: Manifold; basePart: Manifold },
  ): Promise<PrintablePartsResult> => {
    const installed = await sceneSetPrintableParts(scene, parts);

    // Union with master + silicone bboxes for camera framing. Same
    // traversal pattern as `setSilicone` above.
    const union = installed.bbox.clone();
    const masterGroup = scene.children.find(
      (c) => c.userData['tag'] === 'master',
    );
    if (masterGroup) {
      const masterBbox = new Box3().setFromObject(masterGroup);
      if (!masterBbox.isEmpty()) union.union(masterBbox);
    }
    const siliconeGroup = scene.children.find(
      (c) => c.userData['tag'] === 'silicone',
    );
    if (siliconeGroup) {
      const siliconeBbox = new Box3().setFromObject(siliconeGroup);
      if (!siliconeBbox.isEmpty()) union.union(siliconeBbox);
    }

    if (!union.isEmpty()) {
      frameToBox3(camera, controls, union);
    }

    return installed;
  };

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

  /**
   * Issue #79 — apply a per-axis scale to the Master group and re-run the
   * auto-center + re-frame passes. Called from the Dimensions panel on
   * every store update; also from the `__testHooks.viewport.setMasterScale`
   * surface for E2E specs.
   *
   * Edge cases:
   *   - No master loaded → no-op. We don't throw because the panel
   *     subscribes to the store BEFORE the master is loaded on first
   *     launch, and the store may fire (e.g. during `reset`) before a
   *     master exists in the scene.
   *   - Non-finite / non-positive axes → no-op. The dimensions state slice
   *     clamps upstream, but guard defensively so a buggy caller can't
   *     `scale.set(0,0,0)` and hide the mesh.
   */
  const setMasterScale = (scale: {
    sx: number;
    sy: number;
    sz: number;
  }): void => {
    const { sx, sy, sz } = scale;
    if (
      !Number.isFinite(sx) || !Number.isFinite(sy) || !Number.isFinite(sz) ||
      sx <= 0 || sy <= 0 || sz <= 0
    ) {
      return;
    }

    const masterGroup = scene.children.find(
      (c) => c.userData['tag'] === 'master',
    ) as Group | undefined;
    if (!masterGroup) return;

    // The group must host a mesh for recenterGroup to operate on. First
    // load or post-dispose → no child mesh → early-return. The scale
    // still applies to `group.scale` so when a master DOES load, the
    // transform is already in place — but we skip the recenter+reframe
    // half because there's nothing to center.
    const mesh = masterGroup.children.find((c) => c instanceof Mesh) as
      | Mesh
      | undefined;
    masterGroup.scale.set(sx, sy, sz);
    if (!mesh) {
      masterGroup.updateMatrixWorld(true);
      return;
    }

    // Re-apply the on-bed auto-center pass. `recenterGroup` wipes the
    // group's translation, computes a tight vertex-walk world bbox under
    // the current rotation + scale, and translates the group so the
    // mesh sits on Y=0 centered on X=0/Z=0. Same code path that
    // `layFlatController::commit` runs after a rotation.
    recenterGroup(masterGroup, mesh);

    // Re-frame the camera to the new world bbox so the user sees the
    // scaled mesh in full without a manual zoom-out. `Box3.setFromObject`
    // with the default (non-precise) flag is acceptable here: after
    // `recenterGroup`, the group's world matrix is coherent and the
    // mesh's local AABB is what we ultimately want framed.
    const worldBbox = new Box3().setFromObject(masterGroup);
    if (!worldBbox.isEmpty()) {
      frameToBox3(camera, controls, worldBbox);
    }
  };

  const getNativeBboxFromScene = (): Box3 | null => sceneGetNativeBbox(scene);

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
    // Release any cached master Manifold — the WASM kernel won't free it
    // automatically when the viewport's JS state is dropped. Idempotent and
    // safe on a scene that never loaded a master.
    sceneDisposeMaster(scene);
    // Mirror for silicone: `clearSilicone` releases the cached half-
    // Manifolds + GPU resources. Idempotent on an empty scene.
    sceneClearSilicone(scene);
    // Mirror for printable parts (issue #62): release cached Manifolds
    // + GPU resources. Idempotent on an empty scene.
    sceneClearPrintableParts(scene);
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
    setSilicone,
    clearSilicone: () => sceneClearSilicone(scene),
    setExplodedView: (exploded: boolean) => sceneSetExplodedView(scene, exploded),
    isExplodedViewIdle: () => sceneIsExplodedViewIdle(scene),
    setPrintableParts,
    clearPrintableParts: () => sceneClearPrintableParts(scene),
    setPrintablePartsVisible: (visible: boolean) =>
      sceneSetPrintablePartsVisible(scene, visible),
    setPrintablePartsExplodedView: (exploded: boolean) =>
      sceneSetPrintablePartsExplodedView(scene, exploded),
    arePrintablePartsVisible: () => sceneArePrintablePartsVisible(scene),
    isPrintableExplodedIdle: () => sceneIsPrintableExplodedIdle(scene),
    hasPrintableParts: () => sceneHasPrintableParts(scene),
    isFaceHoverOverlayVisible: () => layFlat.getHoverOverlay().visible,
    setMasterScale,
    getNativeBbox: getNativeBboxFromScene,
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
