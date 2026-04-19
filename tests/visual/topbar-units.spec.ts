// tests/visual/topbar-units.spec.ts
//
// Visual regression for the topbar UI. Captures four states:
//
//   1. mm mode, no master loaded (placeholder state).
//   2. mm mode, with a known volume (mini-figurine's 127 451.6 mm³).
//   3. in mode, no master loaded.
//   4. in mode, with the same volume.
//
// Uses `window.__testHooks.topbar` (exposed by `main.ts` when the build
// runs with `NODE_ENV=test`) to drive the state deterministically rather
// than clicking through the UI.
//
// The capture area is clipped to the topbar row so downstream viewport
// rendering (which has its own visual spec in `scene-empty-axes.spec.ts`)
// does not pollute the diff.

import { expect, test, type Page } from '@playwright/test';

const RENDERER_URL = 'http://localhost:5174/?test=1';
const TOPBAR_CLIP = { x: 0, y: 0, width: 1280, height: 48 } as const;

interface TopbarHook {
  setVolume(mm3: number | null): void;
  setUnits(unit: 'mm' | 'in'): void;
  getUnits(): 'mm' | 'in';
}

/**
 * Stub `window.api` before navigation and clear any persisted units so
 * each test starts from the default (mm). Then wait for the topbar API
 * to be installed on `__testHooks`.
 */
async function openRenderer(page: Page): Promise<void> {
  await page.clock.install({ time: new Date('2026-04-18T00:00:00Z') });
  await page.addInitScript(() => {
    (window as unknown as { api: Record<string, unknown> }).api = {
      getVersion: () => Promise.resolve('0.0.0'),
      openStl: () =>
        Promise.resolve({ canceled: true, paths: [] as string[] }),
      saveStl: () => Promise.resolve({ canceled: true }),
    };
    try {
      window.localStorage.removeItem('units');
    } catch {
      /* ignore */
    }
  });
  await page.goto(RENDERER_URL);
  await page.waitForFunction(
    () =>
      !!(
        window as unknown as { __testHooks?: { topbar?: TopbarHook } }
      ).__testHooks?.topbar,
    undefined,
    { timeout: 10_000 },
  );
  // One RAF tick so the version IPC stub settles and the topbar fully paints.
  await page.clock.runFor(50);
}

test.describe('visual — topbar units', () => {
  test('mm mode, no master loaded', async ({ page }) => {
    await openRenderer(page);
    await page.evaluate(() => {
      const t = (
        window as unknown as { __testHooks: { topbar: TopbarHook } }
      ).__testHooks.topbar;
      t.setUnits('mm');
      t.setVolume(null);
    });
    await page.clock.runFor(50);
    await expect(page).toHaveScreenshot('topbar-mm-empty.png', {
      clip: TOPBAR_CLIP,
    });
  });

  test('mm mode, mini-figurine volume', async ({ page }) => {
    await openRenderer(page);
    await page.evaluate(() => {
      const t = (
        window as unknown as { __testHooks: { topbar: TopbarHook } }
      ).__testHooks.topbar;
      t.setUnits('mm');
      t.setVolume(127451.6);
    });
    await page.clock.runFor(50);
    await expect(page).toHaveScreenshot('topbar-mm-mini-figurine.png', {
      clip: TOPBAR_CLIP,
    });
  });

  test('inches mode, no master loaded', async ({ page }) => {
    await openRenderer(page);
    await page.evaluate(() => {
      const t = (
        window as unknown as { __testHooks: { topbar: TopbarHook } }
      ).__testHooks.topbar;
      t.setUnits('in');
      t.setVolume(null);
    });
    await page.clock.runFor(50);
    await expect(page).toHaveScreenshot('topbar-in-empty.png', {
      clip: TOPBAR_CLIP,
    });
  });

  test('inches mode, mini-figurine volume', async ({ page }) => {
    await openRenderer(page);
    await page.evaluate(() => {
      const t = (
        window as unknown as { __testHooks: { topbar: TopbarHook } }
      ).__testHooks.topbar;
      t.setUnits('in');
      t.setVolume(127451.6);
    });
    await page.clock.runFor(50);
    await expect(page).toHaveScreenshot('topbar-in-mini-figurine.png', {
      clip: TOPBAR_CLIP,
    });
  });
});
