// tests/e2e/degenerate-slab-notice.spec.ts
//
// E2E for the degenerate-slab notice (issue #93). When the user
// commits the wrong face for lay-flat (e.g., the mini-figurine's
// TOP face instead of its BOTTOM) the base slab footprint collapses
// to zero area. Pre-#93 `base-slab.stl` still wrote a valid-but-empty
// binary STL (0 triangles) and the user had no warning. Post-#93 the
// orchestrator surfaces a NOTICE-level toast identifying the problem
// and suggesting "Place on face" with a different face.
//
// Flow mirrors `generate-progress.spec.ts`: stub Open dialog, load
// mini-figurine, commit its top face via a canvas-centre click from
// a camera-down position, click Generate, assert the notice toast
// appears and contains the expected i18n string.
//
// The mini-figurine's top face is known to produce the degenerate
// Y-min slice — see the tolerant assertion in
// `stl-export-roundtrip.spec.ts` line ~254 "base-slab.stl may be empty".

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
 * figurine so a canvas-centre click hits its top surface — same
 * technique as `silicone-preview.spec.ts` and `generate-progress.spec.ts`.
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

test('degenerate-slab notice: top-face commit on mini-figurine triggers notice toast', async () => {
  const app = await launchApp();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    // Stub the Open dialog with the mini-figurine fixture.
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

    // Commit the TOP face (wrong orientation) → Generate enables.
    // The mini-figurine's top-face commit produces the zero-area
    // Y-min slice we want to trigger the notice.
    await commitTopFace(page);
    const generateBtn = page.locator('[data-testid="generate-btn"]');
    await expect(generateBtn).toBeEnabled();

    // Click Generate. Wait for it to complete (un-busy) before
    // asserting on the toast — the notice fires on the happy-path
    // terminal branch AFTER the scene hand-off.
    await generateBtn.click();
    await expect(generateBtn).toHaveText('Generate mold', { timeout: 20_000 });

    // Volumes populated (proves orchestrator ran to completion).
    await expect(
      page.locator('[data-testid="silicone-volume-value"]'),
    ).not.toHaveText('Click Generate', { timeout: 5_000 });

    // Notice toast is visible and carries the degenerate-slab copy.
    // The overlay reuses the `error-toast` testid for both error +
    // notice levels (`errorToast.ts` has single-slot semantics).
    const toast = page.locator('[data-testid="error-toast"]');
    await expect(toast).toBeVisible({ timeout: 5_000 });
    const text = (await toast.textContent()) ?? '';
    expect(text).toContain('Base slab has zero volume');
    expect(text).toContain('Place on face');
  } finally {
    await app.close();
  }
});
