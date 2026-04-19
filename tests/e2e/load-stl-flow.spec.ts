// tests/e2e/load-stl-flow.spec.ts
//
// End-to-end: click Open STL → native dialog (stubbed) returns the mini-
// figurine fixture → renderer loads it as master → camera frames to AABB →
// topbar volume readout shows a non-placeholder value.
//
// What this covers that unit / visual tests do not:
//   - The real Electron IPC round-trip (dialog stub → fs.readFile → structured
//     clone of ArrayBuffer into renderer).
//   - The click-driven entry point on the Open STL button — its disabled →
//     enabled transition is tested here implicitly (a disabled button can't
//     be clicked).
//   - The test-hook promise surface (`__testHooks.masterLoaded`) — future
//     specs will rely on this, so it needs a guard.

import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { launchApp } from './fixtures/app';

const MINI_FIGURINE_PATH = resolve(
  __dirname,
  '..',
  'fixtures',
  'meshes',
  'mini-figurine.stl',
);

test('load STL flow: click Open → master mesh renders + topbar shows volume', async () => {
  const app = await launchApp();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    // Surface renderer-side errors into the Playwright log. Without this,
    // a setMaster failure silently leaves the masterLoaded promise pending
    // and the test just times out.
    page.on('console', (msg) => {
      console.log(`[renderer:${msg.type()}] ${msg.text()}`);
    });
    page.on('pageerror', (err) => {
      console.log(`[renderer:pageerror] ${err.message}`);
    });

    // Stub the native Open dialog in the main process. Matches the pattern
    // used in smoke.spec.ts — `src/main/dialogs.ts` honours the stub only
    // when NODE_ENV=test (set by launchApp).
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

    // Wait for the button to exist + become enabled. Main.ts enables it in
    // the DOMContentLoaded handler after the topbar mounts.
    const openBtn = page.locator('[data-testid="open-stl-btn"]');
    await expect(openBtn).toBeVisible();
    await expect(openBtn).toBeEnabled();

    // Capture the masterLoaded promise BEFORE clicking — otherwise the load
    // may resolve before we await it and we'd hang waiting for the NEXT one.
    // `window.__testHooks.masterLoaded` is exposed by viewport.ts under
    // NODE_ENV=test; it's a Promise<void> that resolves when setMaster
    // completes.
    await page.evaluate(() => {
      const hooks = (
        window as unknown as {
          __testHooks?: { masterLoaded?: Promise<void> };
        }
      ).__testHooks;
      if (!hooks?.masterLoaded) {
        throw new Error(
          'window.__testHooks.masterLoaded missing — NODE_ENV=test not honoured?',
        );
      }
      (
        globalThis as unknown as { __pendingMasterLoaded: Promise<void> }
      ).__pendingMasterLoaded = hooks.masterLoaded;
    });

    await openBtn.click();

    // Await the load. 30 s is generous — mini-figurine is 5.8 k tri and
    // manifold-3d init takes ~1 s cold on a dev laptop.
    await page.evaluate(
      () =>
        (
          globalThis as unknown as { __pendingMasterLoaded: Promise<void> }
        ).__pendingMasterLoaded,
    );

    // A mesh with userData.tag === 'master' now lives somewhere in the
    // scene graph (nested under the Master group per createScene()).
    const hasMasterMesh = await page.evaluate(() => {
      const scene = (
        window as unknown as {
          __testHooks?: {
            scene?: {
              traverse: (cb: (o: { userData?: Record<string, unknown>; type?: string }) => void) => void;
            };
          };
        }
      ).__testHooks?.scene;
      if (!scene) return false;
      let found = false;
      scene.traverse((obj) => {
        if (
          obj.userData?.['tag'] === 'master' &&
          obj.type === 'Mesh'
        ) {
          found = true;
        }
      });
      return found;
    });
    expect(hasMasterMesh).toBe(true);

    // The topbar volume readout now shows a concrete value. The default
    // (empty) state is the i18n string "No master loaded" (see en.json);
    // after load it is a formatted number + " mm\u00B3" / " in\u00B3".
    const volumeText = await page
      .locator('[data-testid="volume-value"]')
      .textContent();
    expect(volumeText).toBeTruthy();
    expect(volumeText).not.toBe('No master loaded');
    // In mm (the default) the readout ends with "mm³" (U+00B3 superscript 3).
    // Shape-only regex — the exact number drifts with fixture regens.
    expect(volumeText).toMatch(/^[\d,]+\s+mm\u00B3$/);

    // Sanity: the mini-figurine's manifold volume is ~127 451.6 mm³
    // (per tests/fixtures/meshes/mini-figurine.json). Our renderer uses
    // the signed-tetrahedra formula on raw STL triangles without the
    // manifold-3d repair pass, so the displayed value will differ by the
    // tri-delta that `bufferGeometryToManifold` would repair. We therefore
    // assert a GENEROUS ±30 % window (100 000 – 160 000 mm³) — this is a
    // shape check for "did we multiply by some sensible scale?" not a
    // regression guard.
    const displayed = Number(volumeText?.replace(/[^\d]/g, '') ?? '0');
    expect(displayed).toBeGreaterThan(100_000);
    expect(displayed).toBeLessThan(160_000);
  } finally {
    await app.close();
  }
});
