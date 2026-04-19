// tests/visual/scene-empty-axes.spec.ts
//
// Visual-regression snapshot of the empty Three.js scene mounted by the
// renderer: grid on the XZ plane, bottom-left axes gizmo overlay, iso-ish
// camera framing a unit-cube placeholder AABB.
//
// Preconditions: the renderer bundle is built in `--mode test` before the
// Playwright invocation (see `package.json` → `test:visual`), and the
// Playwright config's `webServer` block static-serves `dist/renderer` on
// `http://localhost:5174`. Chromium blocks module-script fetches from
// `file://` origins, so HTTP is required.
//
// The `?test=1` query flag forces deterministic render settings
// (antialias off, DPR=1, OrbitControls damping off) at the runtime layer —
// redundant with the build-time NODE_ENV=test but a belt-and-braces guard.

import { expect, test } from '@playwright/test';

const RENDERER_URL = 'http://localhost:5174/?test=1';

test.describe('visual — scene skeleton', () => {
  test('empty scene renders grid + axes gizmo deterministically', async ({
    page,
  }) => {
    // Freeze clock before navigation — any RAF-driven transition (OrbitControls
    // damping, animation tweens) sees a frozen `performance.now`.
    await page.clock.install({ time: new Date('2026-04-18T00:00:00Z') });

    // `window.api` is provided only by the Electron preload. For the
    // browser-side Chromium run, stub it before navigation so the
    // version-hydrate call in main.ts resolves without errors.
    await page.addInitScript(() => {
      (window as unknown as { api: Record<string, unknown> }).api = {
        getVersion: () => Promise.resolve('0.0.0'),
        openStl: () =>
          Promise.resolve({ canceled: true, paths: [] as string[] }),
        saveStl: () => Promise.resolve({ canceled: true }),
      };
    });

    await page.goto(RENDERER_URL);

    // Wait for the renderer to mount the viewport — either the test-hook
    // flag flips true (build-time NODE_ENV=test path) or, as a fallback,
    // a canvas element appears inside #viewport.
    await page.waitForFunction(
      () => {
        const hooks = (window as unknown as {
          __testHooks?: { viewportReady?: boolean };
        }).__testHooks;
        if (hooks?.viewportReady) return true;
        const container = document.getElementById('viewport');
        return !!container?.querySelector('canvas');
      },
      undefined,
      { timeout: 10_000 },
    );

    // Advance the frozen clock so at least one RAF tick fires post-mount —
    // the overlay (axes gizmo) renders in that same tick, so we need it
    // before snapshotting.
    await page.clock.runFor(100);

    await expect(page).toHaveScreenshot('scene-empty-axes.png', {
      maxDiffPixelRatio: 0.01,
      threshold: 0.15,
      animations: 'disabled',
      fullPage: false,
    });
  });
});
