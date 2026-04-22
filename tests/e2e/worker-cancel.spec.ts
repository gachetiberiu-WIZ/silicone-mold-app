// tests/e2e/worker-cancel.spec.ts
//
// E2E for the `generateMold` worker cancellation path (issue #77). Pins:
//
//   1. Launch the app, load the mini-figurine, commit a face, click
//      Generate. The pipeline now runs in a dedicated web worker, so the
//      generator can be terminated mid-flight from the main thread.
//   2. While the Generate is still in flight (busy button), fire a new
//      Open-STL flow that loads the SAME fixture again. The existing
//      `attachGenerateInvalidation` plumbing tears down silicone +
//      printable parts + invalidates the orchestrator's epoch, and the
//      new runner-level cancel hook terminates the in-flight worker.
//   3. On the new master, commit a face, click Generate again. The
//      second Generate must complete cleanly (worker termination from
//      round 1 did not leave a broken WASM / worker pool behind) and
//      populate volumes.
//
// Success criteria:
//   - No crash during the mid-flight Open-STL.
//   - The topbar volume readouts populate after the second Generate
//     within the normal budget (≤20 s).
//   - No stray error toast from the cancelled run.

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

test('worker cancel: new Open-STL mid-generate terminates worker, second generate succeeds', async () => {
  const app = await launchApp();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    // Stub the Open dialog — always returns the mini-figurine.
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

    // Snapshot masterLoaded before clicking Open.
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

    await commitTopFace(page);
    const generateBtn = page.locator('[data-testid="generate-btn"]');
    await expect(generateBtn).toBeEnabled();

    // Click Generate #1. Do NOT await — we want to interrupt mid-flight.
    await generateBtn.click();

    // Wait for the banner to become visible so we know the worker has
    // actually started. This also means there's something to cancel.
    const banner = page.locator('[data-testid="generate-status"]');
    await expect(banner).toHaveClass(/is-visible/, { timeout: 5_000 });

    // Snapshot a NEW masterLoaded promise (the old one has already
    // resolved for run #1), then click Open again while Generate #1
    // is still in flight. main.ts's Open-STL flow clears silicone /
    // parts and bumps the generate epoch; the new runner-level cancel
    // hook terminates the in-flight worker.
    await page.evaluate(() => {
      const hooks = (
        window as unknown as { __testHooks?: { masterLoaded?: Promise<void> } }
      ).__testHooks;
      if (!hooks?.masterLoaded) throw new Error('masterLoaded hook missing');
      (
        globalThis as unknown as { __pendingMasterLoaded2: Promise<void> }
      ).__pendingMasterLoaded2 = hooks.masterLoaded;
    });
    await openBtn.click();
    await page.evaluate(
      () =>
        (
          globalThis as unknown as { __pendingMasterLoaded2: Promise<void> }
        ).__pendingMasterLoaded2,
    );

    // After the new STL load lands, the Generate button should come
    // back enabled (orientation reset on new master load requires a
    // fresh commit, so the button is again gated on Place-on-Face).
    // Commit a face and click Generate again.
    await commitTopFace(page);
    await expect(generateBtn).toBeEnabled({ timeout: 5_000 });
    await generateBtn.click();

    // Generate #2 must complete cleanly — volumes populated, banner
    // hidden. 20 s budget for CI headroom on the mini-figurine.
    await expect(generateBtn).toHaveText('Generate mold', { timeout: 25_000 });
    await expect(
      page.locator('[data-testid="silicone-volume-value"]'),
    ).not.toHaveText('Click Generate', { timeout: 5_000 });
    await expect(banner).toHaveClass(/is-hidden/, { timeout: 3_000 });

    // No error toast should be visible from the cancelled run.
    const toast = page.locator('#app-error-toast');
    await expect(toast).not.toHaveClass(/is-visible/);
  } finally {
    await app.close();
  }
});
