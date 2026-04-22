// tests/e2e/dimensions-roundtrip.spec.ts
//
// End-to-end: issue #79 — scaling the master via the Dimensions panel
// flows through the `viewTransform` into `generateSiliconeShell` so the
// generated silicone body scales appropriately.
//
// Flow:
//   1. Launch Electron, stub the Open dialog to return the mini-figurine.
//   2. Open STL. Capture native dimensions from the panel.
//   3. Commit top face → Generate button enables.
//   4. Click Generate. Capture silicone volume at 100 % scale.
//   5. Scale master to 200 % via the dimensions-panel store.
//   6. Generate again. Capture silicone volume at 200 % scale.
//   7. Assert: silicone volume ≈ surface_area × silicone_thickness
//      (fixed 5 mm parameter). Surface area scales quadratically under
//      a linear 2× scale: area ∝ N² → silicone_volume ∝ N². Expected
//      ratio ≈ 4×. Accept the window [3.5, 4.5]×.
//
//      If scale-on-generate were broken (viewTransform never picked up
//      the new master.scale), the silicone volume would stay pinned
//      at its 100 %-scale value (ratio ≈ 1), well below this window.
//      A 2× uniform scale also doesn't ambiguously match any OTHER
//      plausible bug (3× → 9× solid scaling, 1.4× → 2× area scaling);
//      so [3.5, 4.5]× is a tight, falsifiable signal that the panel's
//      edits flow through the generate pipeline.
//
// Note — we DON'T assert on the resin readout: `generateSiliconeShell`
// derives `resinVolume_mm3 = master.volume()` on the UNTRANSFORMED master,
// so it's invariant under the dimensions-panel scale. That's a
// pre-existing geometry-module behaviour orthogonal to issue #79.
//
// Budget: 60 s per Generate. Two Generate runs → 120 s total, plus
// load + commit overhead. Test timeout bumped to 240 s — similar spike
// budget to `generate-wire-up.spec.ts`.

import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { launchApp } from './fixtures/app';

const MINI_FIGURINE_PATH = resolve(
  __dirname,
  '..',
  'fixtures',
  'meshes',
  'mini-figurine.stl',
);

/** Same camera-down-and-click technique as `generate-wire-up.spec.ts`. */
async function commitTopFace(page: Page): Promise<void> {
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
    // Camera looks straight down at the (scaled) master — centre of canvas
    // hits the top face. The figurine's world bbox is auto-centered after
    // recenterGroup, so any scale factor still intersects at the origin.
    vp.camera.position.set(0, 500, 0);
    vp.camera.up.set(0, 0, -1);
    vp.camera.lookAt(0, 50, 0);
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
    { timeout: 10_000 },
  );
}

async function clickGenerateAndWait(page: Page): Promise<number> {
  // Longer click timeout than Playwright's 30 s default — running the
  // roundtrip as part of the full E2E suite occasionally takes >30 s to
  // settle the button into its "enabled" state right after a stale
  // invalidation + re-commit cycle.
  await page.locator('[data-testid="generate-btn"]').click({ timeout: 60_000 });
  await expect(page.locator('[data-testid="generate-btn"]'))
    // 200 % scale pushes the mini-figurine through an 8× volume levelSet
    // (linear scale³ law) on top of the conformal brim's ~4 s geometry
    // cost. Base generate is ~15-18 s on Windows CI → 2× scale observed
    // at ~60-120 s. 180 s timeout absorbs the peak; follow-up tracks
    // clawing back the levelSet + brim cost.
    .toHaveText('Generate mold', { timeout: 180_000 });
  const siliconeText = await page
    .locator('[data-testid="silicone-volume-value"]')
    .textContent();
  const mm3 = Number((siliconeText ?? '').replace(/[^\d]/g, ''));
  if (!Number.isFinite(mm3) || mm3 <= 0) {
    throw new Error(`silicone volume not populated, got "${siliconeText}"`);
  }
  return mm3;
}

test('dimensions roundtrip: 200% scale → silicone volume scales ~4× (square law)', async () => {
  test.setTimeout(300_000);
  const app = await launchApp();
  const consoleLogs: string[] = [];
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    page.on('console', (msg: ConsoleMessage) => {
      consoleLogs.push(msg.text());
    });
    page.on('pageerror', (err) => {
      console.log(`[renderer:pageerror] ${err.message}`);
    });

    // Stub the native Open dialog.
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
    await expect(openBtn).toBeEnabled();

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

    // Dimensions panel must be populated — native mm readouts visible.
    const widthInput = page.locator('[data-testid="dimensions-width-input"]');
    await expect(widthInput).toBeVisible();
    const nativeWidthText = await widthInput.inputValue();
    const nativeWidthMm = Number(nativeWidthText);
    expect(nativeWidthMm).toBeGreaterThan(0);

    // First generate at 100 %.
    await commitTopFace(page);
    await expect(page.locator('[data-testid="generate-btn"]')).toBeEnabled();
    const silicone100 = await clickGenerateAndWait(page);
    expect(silicone100).toBeGreaterThan(100_000);
    expect(silicone100).toBeLessThan(300_000);

    // Scale to 200 %. Writing to the dimensions store directly via the
    // test hook is equivalent to the user typing "200" in the percent
    // field + committing: the store subscription pushes the scale into
    // the master group, and the stale-invalidation edge marks silicone
    // stale. Using the hook (not the DOM) keeps the test stable against
    // any future field-layer UX tweaks.
    await page.evaluate(() => {
      const hooks = (
        window as unknown as {
          __testHooks?: {
            dimensions?: {
              update: (patch: {
                scaleX: number;
                scaleY: number;
                scaleZ: number;
              }) => void;
            };
          };
        }
      ).__testHooks;
      if (!hooks?.dimensions) throw new Error('dimensions hook missing');
      hooks.dimensions.update({ scaleX: 2, scaleY: 2, scaleZ: 2 });
    });

    // The width input should now read ~2 × nativeWidthMm.
    await expect
      .poll(async () => Number(await widthInput.inputValue()), {
        timeout: 5_000,
      })
      .toBeGreaterThan(nativeWidthMm * 1.9);

    // The scale-driven recenter doesn't drop the commit flag, so we only
    // need to click Generate again. The stale-invalidation path flips
    // the silicone readout back to "Click Generate" which is what we
    // want — and the generate button stays enabled.
    await expect(page.locator('[data-testid="generate-btn"]')).toBeEnabled();
    const silicone200 = await clickGenerateAndWait(page);

    // Silicone volume ≈ surface_area × fixed_thickness (5 mm default).
    // Surface area is a SQUARE law under linear scale: 2× → 4× area
    // → 4× silicone volume at the same thickness. Accept [3.5, 4.5]×.
    // If scale-on-generate were broken (viewTransform ignores the new
    // master scale), the silicone volume would stay at its 100 %-scale
    // value (ratio ≈ 1), well below this window.
    const ratio = silicone200 / silicone100;
    expect(
      ratio,
      `silicone(200%)=${silicone200}, silicone(100%)=${silicone100}, ratio=${ratio.toFixed(2)}`,
    ).toBeGreaterThan(3.5);
    expect(ratio).toBeLessThan(4.5);

    // Sanity: the geometry log fires twice (once per Generate click).
    const generateLogs = consoleLogs.filter((l) =>
      l.includes('[generateSiliconeShell] silicone='),
    );
    expect(generateLogs.length).toBeGreaterThanOrEqual(2);
  } finally {
    await app.close();
  }
});
