// tests/e2e/generate-wire-up.spec.ts
//
// End-to-end: issue #40 — wire the Generate button to `generateSiliconeShell`
// and surface the computed silicone + resin volumes in the topbar.
//
// Flow (happy path):
//   1. Launch app, stub the dialog to return the mini-figurine fixture.
//   2. Open STL → master loads → master-volume readout populates.
//   3. Commit a face via the viewport's test hook (camera-down-click, same
//      technique as `generate-gate.spec.ts`) → Generate button enables.
//   4. Click Generate → button label flips to "Generating…" and disables.
//   5. Wait ≤ 15 s → silicone + resin readouts show positive numbers.
//   6. Commit a DIFFERENT face → silicone + resin readouts reset to the
//      placeholder (stale-invalidation AC).
//
// The generator takes ~2-3 s on the mini-figurine per the geometry-dev
// wave-1 PR (#39). 15 s is the ceiling including mesh prep, BVH build,
// LevelSet, boolean, and split.

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

/**
 * Commit whatever face is under the canvas-centre pixel when the camera is
 * looking straight down. Same technique as `tests/e2e/generate-gate.spec.ts`
 * — drives the lay-flat controller's commit without real pointer plumbing.
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

  // Wait for the controller's auto-exit-on-commit.
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
 * Commit a SIDE face — swing the camera around the X axis so a raycast
 * through canvas-centre hits the side of the mini-figurine. Used for
 * the stale-invalidation assertion (second commit after generate).
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
    // Reset first so we commit from a clean identity — the side face has
    // to be UNDER the canvas centre for the second click to land.
    vp.resetOrientation();
    // Point the camera at the figurine from the +X side. Canvas centre now
    // falls on the side surface.
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

test('generate wire-up: click → volumes populate → re-commit → volumes stale', async () => {
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

    // Precondition: silicone + resin readouts exist and show the placeholder.
    await expect(page.locator('[data-testid="silicone-volume-value"]'))
      .toHaveText('Click Generate');
    await expect(page.locator('[data-testid="resin-volume-value"]'))
      .toHaveText('Click Generate');

    const openBtn = page.locator('[data-testid="open-stl-btn"]');
    await expect(openBtn).toBeVisible();
    await expect(openBtn).toBeEnabled();

    // Snapshot the masterLoaded promise BEFORE clicking.
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

    // Master volume readout populates; silicone + resin stay placeholder.
    await expect(page.locator('[data-testid="volume-value"]'))
      .not.toHaveText('No master loaded');
    await expect(page.locator('[data-testid="silicone-volume-value"]'))
      .toHaveText('Click Generate');
    await expect(page.locator('[data-testid="resin-volume-value"]'))
      .toHaveText('Click Generate');

    // Commit a face → Generate button enables.
    await commitTopFace(page);
    await expect(page.locator('[data-testid="generate-btn"]')).toBeEnabled();

    // Click Generate. The button label should flip to "Generating…" during
    // generation. On fast Windows CI runners the generator can resolve in
    // under the 2 s Playwright polling window, racing `toHaveText`. Install
    // a `MutationObserver` on the button BEFORE clicking so we record every
    // `textContent` transition — the assertion later reads the array and
    // requires "Generating…" to appear at least once regardless of timing.
    await page.evaluate(() => {
      const btn = document.querySelector<HTMLButtonElement>(
        '[data-testid="generate-btn"]',
      );
      if (!btn) throw new Error('generate-btn missing');
      const seen: string[] = [btn.textContent ?? ''];
      const seenDisabled: boolean[] = [btn.disabled];
      const observer = new MutationObserver(() => {
        const text = btn.textContent ?? '';
        if (seen[seen.length - 1] !== text) seen.push(text);
        const disabled = btn.disabled;
        if (seenDisabled[seenDisabled.length - 1] !== disabled) {
          seenDisabled.push(disabled);
        }
      });
      observer.observe(btn, {
        childList: true,
        characterData: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['disabled', 'aria-disabled'],
      });
      (
        globalThis as unknown as {
          __generateBtnTransitions: {
            text: string[];
            disabled: boolean[];
            observer: MutationObserver;
          };
        }
      ).__generateBtnTransitions = { text: seen, disabled: seenDisabled, observer };
    });

    await page.locator('[data-testid="generate-btn"]').click();

    // Wait for the generator to finish — ≤ 15 s total (2-3 s typical).
    await expect(page.locator('[data-testid="generate-btn"]'))
      .toHaveText('Generate mold', { timeout: 15_000 });
    await expect(page.locator('[data-testid="generate-btn"]')).toBeEnabled();

    // Drain the observer and assert the busy-state transition was visible.
    // This is race-free: the observer captures every DOM mutation that
    // happens on the button between click and now.
    const transitions = await page.evaluate(() => {
      const cache = (
        globalThis as unknown as {
          __generateBtnTransitions: {
            text: string[];
            disabled: boolean[];
            observer: MutationObserver;
          };
        }
      ).__generateBtnTransitions;
      cache.observer.disconnect();
      return { text: cache.text, disabled: cache.disabled };
    });
    expect(
      transitions.text,
      `button text transitions: ${JSON.stringify(transitions.text)}`,
    ).toContain('Generating…');
    expect(
      transitions.disabled,
      `button disabled transitions: ${JSON.stringify(transitions.disabled)}`,
    ).toContain(true);
    // After generation the button must be back to the ready label + enabled.
    expect(transitions.text[transitions.text.length - 1]).toBe('Generate mold');

    // Both silicone + resin readouts now show concrete values (not the
    // placeholder) with the mm³ suffix.
    const siliconeText = await page
      .locator('[data-testid="silicone-volume-value"]')
      .textContent();
    const resinText = await page
      .locator('[data-testid="resin-volume-value"]')
      .textContent();
    expect(siliconeText).toMatch(/^[\d,]+\s+mm\u00B3$/);
    expect(resinText).toMatch(/^[\d,]+\s+mm\u00B3$/);

    // Sanity: the mini-figurine's silicone shell (10 mm wall) sits around
    // 320 000 mm³ (generator unit tests log 319 914) and resin equals the
    // master volume (~127 452 mm³). Use ±25 % windows — we only need to
    // catch order-of-magnitude regressions.
    const silicone_mm3 = Number(siliconeText?.replace(/[^\d]/g, '') ?? '0');
    const resin_mm3 = Number(resinText?.replace(/[^\d]/g, '') ?? '0');
    expect(silicone_mm3).toBeGreaterThan(250_000);
    expect(silicone_mm3).toBeLessThan(400_000);
    expect(resin_mm3).toBeGreaterThan(100_000);
    expect(resin_mm3).toBeLessThan(160_000);

    // Stale-invalidation: commit a different (side) face → silicone + resin
    // drop back to the placeholder. Master volume is invariant under rigid
    // transform so it stays populated.
    await commitSideFace(page);
    await expect(page.locator('[data-testid="silicone-volume-value"]'))
      .toHaveText('Click Generate');
    await expect(page.locator('[data-testid="resin-volume-value"]'))
      .toHaveText('Click Generate');
    await expect(page.locator('[data-testid="volume-value"]'))
      .not.toHaveText('No master loaded');

    // Sanity check the generate-summary log line from the geometry module
    // landed, so the DevTools eyeballing the issue mentions still works.
    expect(
      consoleLogs.some((l) => l.includes('[generateSiliconeShell] silicone=')),
    ).toBe(true);
  } finally {
    await app.close();
  }
});
