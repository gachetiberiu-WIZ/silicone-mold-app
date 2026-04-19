// tests/e2e/lay-flat.spec.ts
//
// End-to-end for issue #32 ("Place on face"). Launches the real Electron
// app, loads the mini-figurine fixture via the stubbed native Open dialog,
// enters picking mode, synthesises a click at a screen position where
// the rendered mesh is known to have a visible top surface, and asserts:
//
//   - After the click, the Master group's world-space AABB has min.y ≈ 0
//     with 1e-4 mm tolerance.
//   - The mesh.geometry.attributes.position buffer is BYTE-IDENTICAL
//     before and after the click — proves the lay-flat invariant
//     ("viewport transforms live on the Group, never on the geometry").
//   - The group's quaternion has moved off identity (the rotation
//     actually happened).
//
// We drive the interaction through `window.__testHooks.viewport` rather
// than synthesising pointer events on the canvas, because synthetic
// pointermove events don't reliably route to Three.js `Raycaster` inside
// Electron's Chromium without a layered PointerEvent polyfill. The
// controller ultimately calls `pickFaceUnderPointer(event, canvas, ...)`
// so we invoke the viewport-level API and supply a synthetic click
// position via the exposed picking helpers.

import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { launchApp } from './fixtures/app';

const MINI_FIGURINE_PATH = resolve(
  __dirname,
  '..',
  'fixtures',
  'meshes',
  'mini-figurine.stl',
);

test('lay-flat: pick top face → mesh re-seats on Y=0 + vertex buffer unchanged', async () => {
  const app = await launchApp();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    page.on('console', (msg) => {
      console.log(`[renderer:${msg.type()}] ${msg.text()}`);
    });
    page.on('pageerror', (err) => {
      console.log(`[renderer:pageerror] ${err.message}`);
    });

    await app.evaluate((_electron, fixturePath) => {
      (
        globalThis as unknown as {
          __testDialogStub: {
            showOpenDialog: () => Promise<{
              canceled: boolean;
              filePaths: string[];
            }>;
          };
        }
      ).__testDialogStub = {
        showOpenDialog: () =>
          Promise.resolve({ canceled: false, filePaths: [fixturePath] }),
      };
    }, MINI_FIGURINE_PATH);

    const openBtn = page.locator('[data-testid="open-stl-btn"]');
    await expect(openBtn).toBeVisible();
    await expect(openBtn).toBeEnabled();

    // Snapshot the masterLoaded promise BEFORE clicking Open STL.
    await page.evaluate(() => {
      const hooks = (
        window as unknown as {
          __testHooks?: { masterLoaded?: Promise<void> };
        }
      ).__testHooks;
      if (!hooks?.masterLoaded) {
        throw new Error('window.__testHooks.masterLoaded missing');
      }
      (
        globalThis as unknown as { __pendingMasterLoaded: Promise<void> }
      ).__pendingMasterLoaded = hooks.masterLoaded;
    });

    await openBtn.click();
    await page.evaluate(
      () =>
        (
          globalThis as unknown as { __pendingMasterLoaded: Promise<void> }
        ).__pendingMasterLoaded,
    );

    // Capture a baseline of the mesh's vertex buffer before lay-flat.
    // `position.array` is a Float32Array; we serialise to a regular array
    // so Playwright can transport it across the worker boundary.
    const beforeBuffer: number[] = await page.evaluate(() => {
      type Hooks = {
        scene?: { traverse: (cb: (o: { userData?: Record<string, unknown>; type?: string; geometry?: { getAttribute: (n: string) => { array: ArrayLike<number> } } }) => void) => void };
      };
      const hooks = (window as unknown as { __testHooks?: Hooks }).__testHooks;
      const scene = hooks?.scene;
      if (!scene) throw new Error('scene hook missing');
      let meshArr: number[] | null = null;
      scene.traverse((obj) => {
        if (
          obj.userData?.['tag'] === 'master' &&
          obj.type === 'Mesh' &&
          obj.geometry
        ) {
          const attr = obj.geometry.getAttribute('position');
          meshArr = Array.from(attr.array);
        }
      });
      if (!meshArr) throw new Error('master mesh missing');
      return meshArr;
    });
    expect(beforeBuffer.length).toBeGreaterThan(0);

    // Enter picking mode + commit the TOP face (we know the mini-figurine
    // fixture sits centered on the bed after auto-center, so a ray from
    // straight above hits the highest face). We drive the controller by
    // temporarily repositioning the camera and hand-synthesising a click
    // at the canvas center.
    await page.evaluate(() => {
      type ViewportHooks = {
        viewport?: {
          scene: unknown;
          camera: {
            position: { set: (x: number, y: number, z: number) => void };
            up: { set: (x: number, y: number, z: number) => void };
            lookAt: (x: number, y: number, z: number) => void;
            updateMatrixWorld: () => void;
            updateProjectionMatrix: () => void;
          };
          enableFacePicking: () => void;
        };
      };
      const hooks = (window as unknown as { __testHooks?: ViewportHooks })
        .__testHooks;
      const vp = hooks?.viewport;
      if (!vp) throw new Error('viewport hook missing');
      // Aim the camera straight down the -Y axis so a ray from the canvas
      // centre hits the top of the mini-figurine. The fixture's post-
      // auto-center AABB is ~[−42, 0, −20] → [+42, +70, +90] mm
      // (its 2026-04-19 volume = 127 k mm³), so placing the camera at
      // (0, 250, 0) looking at (0, 35, 0) puts the top face in the
      // middle of the frame.
      vp.camera.position.set(0, 250, 0);
      vp.camera.up.set(0, 0, -1);
      vp.camera.lookAt(0, 35, 0);
      vp.camera.updateMatrixWorld();
      vp.camera.updateProjectionMatrix();
      vp.enableFacePicking();
    });

    // Synthesise a pointerdown → click at the canvas centre.
    const canvasBox = await page.locator('#viewport canvas').boundingBox();
    if (!canvasBox) throw new Error('canvas missing');
    const cx = canvasBox.x + canvasBox.width / 2;
    const cy = canvasBox.y + canvasBox.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.click(cx, cy);

    // Give the RAF loop a tick to apply the rotation + re-center.
    // Then assert the post-commit world bbox satisfies min.y ≈ 0.
    await page.waitForFunction(
      () => {
        type ViewportHooks = {
          viewport?: { isFacePickingActive: () => boolean };
        };
        const hooks = (window as unknown as { __testHooks?: ViewportHooks })
          .__testHooks;
        // Controller auto-exits on commit — use that as the "done" signal.
        return hooks?.viewport?.isFacePickingActive() === false;
      },
      undefined,
      { timeout: 5_000 },
    );

    const worldMinY: number = await page.evaluate(() => {
      // Find the master mesh via scene traversal.
      type MeshShape = {
        userData?: Record<string, unknown>;
        type?: string;
        matrixWorld: { elements: Float32Array | number[] };
        geometry: { getAttribute: (n: string) => { array: Float32Array; count: number } };
        updateMatrixWorld: (force: boolean) => void;
      };
      type Hooks = {
        scene?: { traverse: (cb: (o: unknown) => void) => void };
      };
      const hooks = (window as unknown as { __testHooks?: Hooks }).__testHooks;
      const scene = hooks?.scene;
      if (!scene) throw new Error('scene hook missing');
      let found: MeshShape | null = null;
      scene.traverse((obj: unknown) => {
        const o = obj as MeshShape;
        if (o.userData?.['tag'] === 'master' && o.type === 'Mesh') {
          found = o;
        }
      });
      if (!found) throw new Error('master mesh missing');
      const m: MeshShape = found;
      // Compute world-space min.y by applying mesh.matrixWorld (4x4) to
      // each local vertex and tracking the minimum Y. Equivalent to
      // `Box3().setFromObject(mesh).min.y` but doesn't require a Box3
      // import inside the page context.
      m.updateMatrixWorld(true);
      const e = m.matrixWorld.elements;
      const attr = m.geometry.getAttribute('position');
      const arr = attr.array;
      let minY = Infinity;
      for (let i = 0; i < attr.count; i++) {
        const x = arr[i * 3]!;
        const y = arr[i * 3 + 1]!;
        const z = arr[i * 3 + 2]!;
        const worldY = e[1]! * x + e[5]! * y + e[9]! * z + e[13]!;
        if (worldY < minY) minY = worldY;
      }
      return minY;
    });
    expect(worldMinY).toBeCloseTo(0, 4); // 1e-4 mm tolerance.

    // Vertex buffer is UNCHANGED.
    const afterBuffer: number[] = await page.evaluate(() => {
      type Hooks = {
        scene?: { traverse: (cb: (o: { userData?: Record<string, unknown>; type?: string; geometry?: { getAttribute: (n: string) => { array: ArrayLike<number> } } }) => void) => void };
      };
      const hooks = (window as unknown as { __testHooks?: Hooks }).__testHooks;
      const scene = hooks?.scene;
      if (!scene) throw new Error('scene hook missing');
      let arr: number[] | null = null;
      scene.traverse((obj) => {
        if (
          obj.userData?.['tag'] === 'master' &&
          obj.type === 'Mesh' &&
          obj.geometry
        ) {
          const a = obj.geometry.getAttribute('position');
          arr = Array.from(a.array);
        }
      });
      if (!arr) throw new Error('master mesh missing');
      return arr;
    });
    expect(afterBuffer.length).toBe(beforeBuffer.length);
    for (let i = 0; i < beforeBuffer.length; i++) {
      // Exact equality — NO FP tolerance. The buffer must not be touched.
      expect(afterBuffer[i]).toBe(beforeBuffer[i]);
    }

    // The group quaternion moved off identity (a rotation actually happened).
    const isRotated = await page.evaluate(() => {
      type MeshShape = { userData?: Record<string, unknown>; type?: string };
      type Hooks = { scene?: { traverse: (cb: (o: MeshShape) => void) => void; children: unknown[] } };
      const hooks = (window as unknown as { __testHooks?: Hooks }).__testHooks;
      const scene = hooks?.scene;
      if (!scene) throw new Error('scene hook missing');
      // The Master group is the scene child with tag 'master'.
      const group = (
        scene.children as unknown as Array<{
          userData?: Record<string, unknown>;
          quaternion?: { x: number; y: number; z: number; w: number };
        }>
      ).find((c) => c.userData?.['tag'] === 'master');
      if (!group?.quaternion) return false;
      const { x, y, z, w } = group.quaternion;
      const deltaFromIdentity = Math.hypot(x, y, z, w - 1);
      return deltaFromIdentity > 1e-4;
    });
    expect(isRotated).toBe(true);
  } finally {
    await app.close();
  }
});
