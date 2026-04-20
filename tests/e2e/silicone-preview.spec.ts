// tests/e2e/silicone-preview.spec.ts
//
// End-to-end for issue #47: silicone preview + exploded-view toggle.
//
// Flow:
//   1. Launch app, stub the Open dialog to return the mini-figurine.
//   2. Open STL → master loads; exploded-view toggle starts disabled.
//   3. Commit a face (camera-down-click same as `generate-wire-up.spec.ts`).
//   4. Click Generate → wait for volumes to populate.
//   5. Assert two silicone meshes are live in the scene (via scene.traverse).
//   6. Assert the exploded-view toggle is enabled + not-pressed.
//   7. Click the exploded-view toggle.
//   8. Wait 300 ms (past the 250 ms tween) — assert upper mesh world-Y > +20.
//   9. Click again → halves collapse back to y ≈ 0.
//  10. Commit a different face → silicone meshes disappear + toggle disables.
//
// Generator budget on the mini-figurine is ~2-3 s; we set the wait ceilings
// to 15 s for CI headroom.

import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { launchApp } from './fixtures/app';

const MINI_FIGURINE_PATH = resolve(
  __dirname,
  '..',
  'fixtures',
  'meshes',
  'mini-figurine.stl',
);

/**
 * Commit the top face by swinging the camera straight down at the
 * figurine so a canvas-centre click hits its top surface. Same
 * technique `generate-gate.spec.ts` / `generate-wire-up.spec.ts` use.
 */
async function commitTopFace(page: Page): Promise<void> {
  await page.evaluate(() => {
    type ViewportHooks = {
      viewport?: {
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
    vp.camera.position.set(0, 250, 0);
    vp.camera.up.set(0, 0, -1);
    vp.camera.lookAt(0, 35, 0);
    vp.camera.updateMatrixWorld();
    vp.camera.updateProjectionMatrix();
    vp.enableFacePicking();
  });
  const canvasBox = await page.locator('#viewport canvas').boundingBox();
  if (!canvasBox) throw new Error('canvas missing');
  const cx = canvasBox.x + canvasBox.width / 2;
  const cy = canvasBox.y + canvasBox.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.click(cx, cy);
  await page.waitForFunction(
    () => {
      type ViewportHooks = {
        viewport?: {
          isFacePickingActive: () => boolean;
          isOrientationCommitted: () => boolean;
        };
      };
      const hooks = (window as unknown as { __testHooks?: ViewportHooks })
        .__testHooks;
      return (
        hooks?.viewport?.isFacePickingActive() === false &&
        hooks?.viewport?.isOrientationCommitted() === true
      );
    },
    undefined,
    { timeout: 5_000 },
  );
}

/**
 * Commit a SIDE face — swing camera around the X axis so a canvas-centre
 * raycast hits the side of the mini-figurine. Same helper shape as
 * `generate-wire-up.spec.ts`.
 */
async function commitSideFace(page: Page): Promise<void> {
  await page.evaluate(() => {
    type ViewportHooks = {
      viewport?: {
        resetOrientation: () => void;
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
    vp.resetOrientation();
    vp.camera.position.set(250, 35, 0);
    vp.camera.up.set(0, 1, 0);
    vp.camera.lookAt(0, 35, 0);
    vp.camera.updateMatrixWorld();
    vp.camera.updateProjectionMatrix();
    vp.enableFacePicking();
  });
  const canvasBox = await page.locator('#viewport canvas').boundingBox();
  if (!canvasBox) throw new Error('canvas missing');
  const cx = canvasBox.x + canvasBox.width / 2;
  const cy = canvasBox.y + canvasBox.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.click(cx, cy);
  await page.waitForFunction(
    () => {
      type ViewportHooks = {
        viewport?: { isOrientationCommitted: () => boolean };
      };
      const hooks = (window as unknown as { __testHooks?: ViewportHooks })
        .__testHooks;
      return hooks?.viewport?.isOrientationCommitted() === true;
    },
    undefined,
    { timeout: 5_000 },
  );
}

/**
 * Count silicone meshes currently in the scene by walking from the
 * scene-root test-hook and checking `userData.tag`. Returns the raw
 * count so the caller can assert exactly-two.
 */
async function countSiliconeMeshes(page: Page): Promise<number> {
  return page.evaluate(() => {
    type SceneHook = {
      scene?: {
        traverse: (cb: (obj: { userData?: Record<string, unknown> }) => void) => void;
      };
    };
    const hooks = (window as unknown as { __testHooks?: SceneHook })
      .__testHooks;
    if (!hooks?.scene) throw new Error('scene hook missing');
    let count = 0;
    hooks.scene.traverse((obj) => {
      const tag = obj.userData?.['tag'];
      if (tag === 'silicone-upper' || tag === 'silicone-lower') count += 1;
    });
    return count;
  });
}

/**
 * Read the world-space Y position of the upper silicone mesh. Used to
 * detect the exploded-view animation has landed at its +offset target.
 */
async function readUpperMeshWorldY(page: Page): Promise<number> {
  return page.evaluate(() => {
    type Obj = {
      userData?: Record<string, unknown>;
      getWorldPosition?: (v: { y: number }) => { y: number };
      position?: { y: number };
    };
    type SceneHook = {
      scene?: { traverse: (cb: (obj: Obj) => void) => void };
    };
    const hooks = (window as unknown as { __testHooks?: SceneHook })
      .__testHooks;
    if (!hooks?.scene) throw new Error('scene hook missing');
    let worldY = Number.NaN;
    hooks.scene.traverse((obj) => {
      if (obj.userData?.['tag'] === 'silicone-upper') {
        // `getWorldPosition` walks the parent chain — silicone group is
        // at identity, so world Y === mesh.position.y. We use
        // `getWorldPosition` anyway so a future group transform would
        // still produce the right reading.
        if (typeof obj.getWorldPosition === 'function') {
          const p = obj.getWorldPosition({ y: 0 });
          worldY = p.y;
        } else if (obj.position) {
          worldY = obj.position.y;
        }
      }
    });
    return worldY;
  });
}

test('silicone preview: generate → two meshes live → exploded view tweens halves apart', async () => {
  const app = await launchApp();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    // Stub the dialog with the mini-figurine fixture.
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

    // Exploded-view toggle exists and starts disabled (no silicone yet).
    const explodedToggle = page.locator('[data-testid="exploded-view-toggle"]');
    await expect(explodedToggle).toBeVisible();
    await expect(explodedToggle).toBeDisabled();

    // Snapshot masterLoaded → open → await.
    await page.evaluate(() => {
      const hooks = (
        window as unknown as { __testHooks?: { masterLoaded?: Promise<void> } }
      ).__testHooks;
      if (!hooks?.masterLoaded) throw new Error('masterLoaded hook missing');
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

    // Commit a face → Generate enables.
    await commitTopFace(page);
    await expect(page.locator('[data-testid="generate-btn"]')).toBeEnabled();

    // Toggle still disabled — silicone doesn't exist yet.
    await expect(explodedToggle).toBeDisabled();

    // Click Generate. Wait for the button to flip back to the ready label
    // (generator finished) — this is ≤ 15 s per the wire-up spec.
    await page.locator('[data-testid="generate-btn"]').click();
    await expect(page.locator('[data-testid="generate-btn"]'))
      .toHaveText('Generate mold', { timeout: 15_000 });
    await expect(page.locator('[data-testid="generate-btn"]')).toBeEnabled();

    // Volumes populated (sanity — proves the orchestrator ran to completion).
    await expect(page.locator('[data-testid="silicone-volume-value"]'))
      .not.toHaveText('Click Generate', { timeout: 5_000 });

    // Two silicone meshes live in the scene.
    expect(await countSiliconeMeshes(page)).toBe(2);

    // Toggle now enabled + not-pressed.
    await expect(explodedToggle).toBeEnabled();
    await expect(explodedToggle).toHaveAttribute('aria-pressed', 'false');

    // Collapsed state: both halves at y ≈ 0.
    expect(await readUpperMeshWorldY(page)).toBeCloseTo(0, 3);

    // Click the toggle. Wait 300 ms so the 250 ms tween lands.
    await explodedToggle.click();
    await expect(explodedToggle).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(300);

    // Upper mesh pushed up along +Y by the exploded offset.
    // Offset = max(30, 0.2 * bboxHeight). For the mini-figurine the
    // bbox height is ~70 mm → 0.2 * 70 = 14, floor = 30 → offset = 30.
    // We assert > 20 mm to have tolerance for CI timing jitter.
    const explodedY = await readUpperMeshWorldY(page);
    expect(explodedY).toBeGreaterThan(20);

    // Click again → collapse back to 0.
    await explodedToggle.click();
    await expect(explodedToggle).toHaveAttribute('aria-pressed', 'false');
    await page.waitForTimeout(300);
    const collapsedY = await readUpperMeshWorldY(page);
    expect(collapsedY).toBeCloseTo(0, 2);

    // Stale-invalidation: commit a different face → silicone meshes
    // disappear AND toggle returns to disabled + not-pressed.
    await commitSideFace(page);
    expect(await countSiliconeMeshes(page)).toBe(0);
    await expect(explodedToggle).toBeDisabled();
    await expect(explodedToggle).toHaveAttribute('aria-pressed', 'false');
  } finally {
    await app.close();
  }
});
