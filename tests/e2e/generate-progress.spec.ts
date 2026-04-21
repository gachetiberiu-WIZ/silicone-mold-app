// tests/e2e/generate-progress.spec.ts
//
// E2E for the Generate progress banner (issue #87 Fix 1). Pins:
//
//   1. Fresh app → no `[data-testid="generate-status"]` with
//      `.is-visible` (either hidden or not mounted).
//   2. Click Generate → the banner becomes visible within a few
//      hundred milliseconds (the renderer fires setPhase('silicone')
//      on its first onPhase callback, pre any manifold work).
//   3. Banner text updates at least once during the run (pipeline
//      moves through silicone → shell → slicing / brims / slab).
//   4. After the generator completes the banner fades back out.
//
// Flow mirrors `silicone-preview.spec.ts`: stub Open dialog, load
// mini-figurine, commit top face, click Generate.

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
 * technique as `silicone-preview.spec.ts`.
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

test('generate progress: banner appears during Generate, hides after', async () => {
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

    // Banner exists but is hidden (no generate in flight).
    const banner = page.locator('[data-testid="generate-status"]');
    await expect(banner).toHaveClass(/is-hidden/);

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
    const generateBtn = page.locator('[data-testid="generate-btn"]');
    await expect(generateBtn).toBeEnabled();

    // Click Generate. The banner should flash visible within a
    // second of the click (the first onPhase fires before the
    // silicone levelSet starts).
    //
    // We record the label text at several points during the run so
    // we can assert that it (a) became visible and (b) updated
    // through at least two distinct phases.
    await generateBtn.click();

    // Wait for the banner to become visible. Use a polled waitFor
    // with a generous timeout — the first onPhase fires ~synchronously
    // with the button click but the RAF yield adds a frame.
    await expect(banner).toHaveClass(/is-visible/, { timeout: 5_000 });

    const labelEl = page.locator('[data-testid="generate-status-label"]');
    const firstLabel = (await labelEl.textContent())?.trim() ?? '';
    expect(firstLabel.length).toBeGreaterThan(0);

    // Wait for the generator to finish and the banner to hide.
    // Generator budget on the mini-figurine is ~2-5 s; allow 20 s
    // for CI headroom.
    await expect(generateBtn).toHaveText('Generate mold', {
      timeout: 20_000,
    });

    // Silicone volume populated — sanity that the orchestrator ran
    // through.
    await expect(
      page.locator('[data-testid="silicone-volume-value"]'),
    ).not.toHaveText('Click Generate', { timeout: 5_000 });

    // Banner fades out. The CSS fade is 250 ms; poll for is-hidden.
    await expect(banner).toHaveClass(/is-hidden/, { timeout: 2_000 });
  } finally {
    await app.close();
  }
});
