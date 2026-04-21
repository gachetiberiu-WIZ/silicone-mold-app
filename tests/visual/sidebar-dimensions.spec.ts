// tests/visual/sidebar-dimensions.spec.ts
//
// Visual regression for the Dimensions sidebar section (issue #79).
// Captures a single golden showing the full sidebar (Dimensions panel
// above the MOLD PARAMETERS form) with a loaded master — which is the
// user's primary view after an Open STL.
//
// Flow:
//   1. Stub `window.api` so the version hydrator doesn't crash.
//   2. Navigate the renderer; wait for viewport + sidebar test hooks.
//   3. Load the mini-figurine fixture via `viewport.setMaster` so the
//      Dimensions panel populates with real mm values.
//   4. Snapshot the full window (sidebar + viewport + topbar) so the
//      panel renders in its native visual context.
//
// The extended default timeout (60 s) matches the other load-bearing
// specs (silicone-exploded, printable-parts-exploded) — the first
// viewport boot under SwiftShader on cold CI can drift above 30 s.

import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RENDERER_URL = 'http://localhost:5174/?test=1';
const FIXTURE_PATH = resolve(
  __dirname,
  '..',
  'fixtures',
  'meshes',
  'mini-figurine.stl',
);

test.describe('visual — sidebar dimensions', () => {
  test.setTimeout(60_000);

  test('with a loaded master', async ({ page }: { page: Page }) => {
    await page.clock.install({ time: new Date('2026-04-21T00:00:00Z') });

    await page.addInitScript(() => {
      (window as unknown as { api: Record<string, unknown> }).api = {
        getVersion: () => Promise.resolve('0.0.0'),
        openStl: () => Promise.resolve({ canceled: true }),
        saveStl: () => Promise.resolve({ canceled: true }),
      };
      try {
        window.localStorage.removeItem('units');
      } catch {
        /* ignore */
      }
    });

    await page.goto(RENDERER_URL);

    // Wait for the viewport + dimensions panel test hooks.
    await page.waitForSelector('[data-testid="dimensions-panel"]', {
      timeout: 15_000,
    });
    await page.waitForFunction(
      () => {
        const hooks = (
          window as unknown as {
            __testHooks?: {
              viewportReady?: boolean;
              viewport?: { setMaster?: unknown };
            };
          }
        ).__testHooks;
        return !!hooks?.viewportReady && !!hooks?.viewport?.setMaster;
      },
      undefined,
      { timeout: 15_000 },
    );

    // Load the mini-figurine so the Dimensions panel populates with real mm
    // readouts. Mirrors the `scene-with-mini-figurine.spec.ts` pattern.
    const fixtureBytes = readFileSync(FIXTURE_PATH);
    const byteArray = Array.from(fixtureBytes);
    await page.evaluate(async (bytes: number[]) => {
      const u8 = new Uint8Array(bytes);
      const ab = u8.buffer.slice(
        u8.byteOffset,
        u8.byteOffset + u8.byteLength,
      );
      const hooks = (
        window as unknown as {
          __testHooks?: {
            viewport?: { setMaster: (buf: ArrayBuffer) => Promise<unknown> };
          };
        }
      ).__testHooks;
      if (!hooks?.viewport) {
        throw new Error('viewport test hook missing');
      }
      await hooks.viewport.setMaster(ab);
    }, byteArray);

    await page.clock.runFor(200);

    await expect(page).toHaveScreenshot('sidebar-dimensions.png', {
      maxDiffPixelRatio: 0.01,
      threshold: 0.15,
      animations: 'disabled',
      fullPage: false,
    });
  });
});
