// tests/e2e/face-pick-hover.spec.ts
//
// End-to-end for issue #67 Bug 1: face-pick hover feedback.
//
// Flow:
//   1. Launch app, stub the Open dialog to return the mini-figurine.
//   2. Open STL → master loads.
//   3. Enter face-picking via the toolbar toggle.
//   4. Aim the camera straight down at the master, dispatch a
//      pointermove at the canvas centre.
//   5. Assert `viewport.isFaceHoverOverlayVisible()` returns true
//      (the hover overlay has been populated with the coplanar face).
//   6. Move the pointer OFF the master (a point in the corner of the
//      viewport where the raycast misses) → assert the overlay hides.
//   7. Exit picking mode (Escape) → assert the overlay hides + the
//      `.is-picking` CSS class is removed from the viewport.
//
// Note on pointer events: Chromium's synthetic pointermove reaches our
// `pointermove` listener on the canvas, which is what the lay-flat
// controller subscribes to. The raycast + flood-fill executes on the
// same event, so by the time the `page.waitForFunction` poll fires the
// overlay state is already settled.

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
 * Aim the camera straight down at the master's top face. Same helper
 * pattern the lay-flat + printable-preview specs use — the mini-figurine
 * sits auto-centered on the print bed after setMaster, so a ray from
 * straight above hits the highest face.
 */
async function aimCameraDown(page: Page): Promise<void> {
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
  });
}

test('face-pick hover: overlay appears over master, hides on miss, clears on Escape', async () => {
  const app = await launchApp();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

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

    // Enter face-picking mode via the toolbar toggle (this is the click
    // path the user actually takes, not the viewport-hook shortcut — so
    // we're exercising the full wiring).
    const placeBtn = page.locator('[data-testid="place-on-face-toggle"]');
    await expect(placeBtn).toBeEnabled();
    await placeBtn.click();
    await expect(placeBtn).toHaveAttribute('aria-pressed', 'true');

    // Assert the viewport container has the `.is-picking` class (CSS
    // cursor rule target + accent-on-picking visual).
    const hasPickingClass = await page.evaluate(() => {
      const el = document.getElementById('viewport');
      return el?.classList.contains('is-picking') ?? null;
    });
    expect(hasPickingClass).toBe(true);

    // Aim the camera straight down and move the pointer over the master's
    // top face.
    await aimCameraDown(page);

    const canvasBox = await page.locator('#viewport canvas').boundingBox();
    if (!canvasBox) throw new Error('canvas missing');
    const cx = canvasBox.x + canvasBox.width / 2;
    const cy = canvasBox.y + canvasBox.height / 2;
    await page.mouse.move(cx, cy);

    // Wait for the hover overlay to become visible. The controller's
    // pointermove handler runs synchronously within the dispatched event,
    // so by the next micro-tick the overlay flag is settled.
    await page.waitForFunction(
      () => {
        type ViewportHooks = {
          viewport?: { isFaceHoverOverlayVisible: () => boolean };
        };
        const hooks = (window as unknown as { __testHooks?: ViewportHooks })
          .__testHooks;
        return hooks?.viewport?.isFaceHoverOverlayVisible() === true;
      },
      undefined,
      { timeout: 5_000 },
    );

    // Move the pointer off the master — a corner of the viewport where
    // the ray misses every triangle.
    await page.mouse.move(canvasBox.x + 2, canvasBox.y + 2);
    await page.waitForFunction(
      () => {
        type ViewportHooks = {
          viewport?: { isFaceHoverOverlayVisible: () => boolean };
        };
        const hooks = (window as unknown as { __testHooks?: ViewportHooks })
          .__testHooks;
        return hooks?.viewport?.isFaceHoverOverlayVisible() === false;
      },
      undefined,
      { timeout: 5_000 },
    );

    // Escape exits picking mode → overlay hides + `.is-picking` class gone.
    await page.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    await expect(placeBtn).toHaveAttribute('aria-pressed', 'false');
    const afterEscape = await page.evaluate(() => {
      type ViewportHooks = {
        viewport?: { isFaceHoverOverlayVisible: () => boolean };
      };
      const hooks = (window as unknown as { __testHooks?: ViewportHooks })
        .__testHooks;
      return {
        overlay: hooks?.viewport?.isFaceHoverOverlayVisible() ?? null,
        hasPickingClass:
          document.getElementById('viewport')?.classList.contains(
            'is-picking',
          ) ?? null,
      };
    });
    expect(afterEscape.overlay).toBe(false);
    expect(afterEscape.hasPickingClass).toBe(false);
  } finally {
    await app.close();
  }
});
