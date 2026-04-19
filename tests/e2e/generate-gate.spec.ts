// tests/e2e/generate-gate.spec.ts
//
// End-to-end for issue #36: the Generate-mold UX gate. Launches the real
// Electron app, loads the mini-figurine fixture via the stubbed native Open
// dialog, and asserts the four state transitions from the AC:
//
//   1. On app launch with no master loaded → button disabled, hint shows
//      "Load an STL to begin.".
//   2. After Open STL → button disabled, hint shows the "Orient the part..."
//      instruction.
//   3. After Place-on-face commits a face → button enabled, hint shows
//      "Ready to generate".
//   4. After Reset orientation → button disabled again, hint re-shows the
//      "Orient the part..." instruction.
//
// Commit is driven through `window.__testHooks.viewport.enableFacePicking()`
// plus a synthetic click at the canvas centre — the same technique the
// lay-flat spec uses. The controller dispatches `LAY_FLAT_COMMITTED_EVENT`
// and the renderer wiring in `main.ts` calls `generateButton.setEnabled()`.
//
// Clicking Generate when enabled must log the expected payload to the
// console without unhandled rejections. We capture console messages via
// `page.on('console')` and assert the expected string shows up.

import { expect, test, type ConsoleMessage } from '@playwright/test';
import { resolve } from 'node:path';
import { launchApp } from './fixtures/app';

const MINI_FIGURINE_PATH = resolve(
  __dirname,
  '..',
  'fixtures',
  'meshes',
  'mini-figurine.stl',
);

test('generate-mold gate: disabled → enabled → disabled across commit/reset', async () => {
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

    // AC 1: on launch, before any master, the button is disabled and the
    // hint reads "Load an STL to begin.".
    await expect(page.locator('[data-testid="generate-btn"]')).toBeDisabled();
    const initialHint = await page
      .locator('[data-testid="generate-hint"]')
      .textContent();
    expect(initialHint).toBe('Load an STL to begin.');

    // Stub the native file dialog to return the fixture path — same pattern
    // the lay-flat + smoke specs use.
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

    // AC 2: after Open STL, button still disabled, hint flipped to the
    // orient-first instruction.
    await expect(page.locator('[data-testid="generate-btn"]')).toBeDisabled();
    await expect(page.locator('[data-testid="generate-hint"]')).toHaveText(
      'Orient the part on its base (use Place on face in the toolbar), then click Generate.',
    );

    // Commit a face via the viewport's test hook. Same camera positioning
    // the lay-flat spec uses — point straight down at the mini-figurine so
    // a canvas-centre click hits its top face.
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

    // Synthesise a click at the canvas centre.
    const canvasBox = await page.locator('#viewport canvas').boundingBox();
    if (!canvasBox) throw new Error('canvas missing');
    const cx = canvasBox.x + canvasBox.width / 2;
    const cy = canvasBox.y + canvasBox.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.click(cx, cy);

    // Wait for the controller's auto-exit-on-commit so we know the commit
    // event has fired. Then the button subscription updates via microtask.
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

    // AC 3: after commit, button enabled, hint = "Ready to generate".
    await expect(page.locator('[data-testid="generate-btn"]')).toBeEnabled();
    await expect(page.locator('[data-testid="generate-hint"]')).toHaveText(
      'Ready to generate',
    );

    // Clicking Generate must log the expected payload.
    await page.locator('[data-testid="generate-btn"]').click();
    // Give the microtask + console plumbing a moment to flush.
    await page.waitForFunction(
      () =>
        Array.from(
          (
            globalThis as unknown as {
              __capturedLogs?: string[];
            }
          ).__capturedLogs ?? [],
        ).length > 0,
      undefined,
      // A short poll window; the fallback expects Playwright to have
      // captured via its own `console` listener.
      { timeout: 1_000 },
    ).catch(() => {
      // Playwright's `page.on('console')` is the authoritative channel;
      // the waitForFunction above is advisory only.
    });
    // Assert via the Playwright-captured log stream.
    const didLog = consoleLogs.some((l) => l.includes('[generate] requested'));
    expect(didLog).toBe(true);

    // AC 4: Reset orientation flips the gate back off.
    await page.evaluate(() => {
      type ViewportHooks = {
        viewport?: { resetOrientation: () => void };
      };
      const hooks = (window as unknown as { __testHooks?: ViewportHooks })
        .__testHooks;
      hooks?.viewport?.resetOrientation();
    });
    await expect(page.locator('[data-testid="generate-btn"]')).toBeDisabled();
    await expect(page.locator('[data-testid="generate-hint"]')).toHaveText(
      'Orient the part on its base (use Place on face in the toolbar), then click Generate.',
    );
  } finally {
    await app.close();
  }
});

test('generate-mold gate: loading a second master re-locks the button', async () => {
  // AC: "After Open STL loads a new master: button re-disabled (inherited
  // commit state does not carry over)". Exercises the `notifyMasterReset`
  // wiring in `viewport.setMaster` → controller → button.
  const app = await launchApp();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    // Stub the dialog to return the mini-figurine both times.
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

    // First load + commit.
    await page.evaluate(() => {
      const hooks = (
        window as unknown as {
          __testHooks?: { masterLoaded?: Promise<void> };
        }
      ).__testHooks;
      if (!hooks?.masterLoaded) {
        throw new Error('masterLoaded hook missing');
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

    // Commit a face — reuse the camera-down-click technique.
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
    await page.mouse.move(
      canvasBox.x + canvasBox.width / 2,
      canvasBox.y + canvasBox.height / 2,
    );
    await page.mouse.click(
      canvasBox.x + canvasBox.width / 2,
      canvasBox.y + canvasBox.height / 2,
    );
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
    await expect(page.locator('[data-testid="generate-btn"]')).toBeEnabled();

    // Second load — refresh the masterLoaded promise first.
    await page.evaluate(() => {
      const hooks = (
        window as unknown as {
          __testHooks?: { masterLoaded?: Promise<void> };
        }
      ).__testHooks;
      if (!hooks?.masterLoaded) {
        throw new Error('masterLoaded hook missing');
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

    // Button must be re-disabled after the new load.
    await expect(page.locator('[data-testid="generate-btn"]')).toBeDisabled();
    await expect(page.locator('[data-testid="generate-hint"]')).toHaveText(
      'Orient the part on its base (use Place on face in the toolbar), then click Generate.',
    );
  } finally {
    await app.close();
  }
});
