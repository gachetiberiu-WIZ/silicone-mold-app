// tests/visual/scene-with-mini-figurine.spec.ts
//
// Visual regression: the scene with the mini-figurine fixture loaded as the
// master mesh. Exercises the full `viewport.setMaster(buffer)` path without
// going through the Electron dialog — we fetch the fixture bytes in Node and
// hand them to the renderer via `window.__testHooks.viewport.setMaster`.
//
// Preconditions:
//   - The renderer must be built in `--mode test` (Playwright's `webServer`
//     config + the `test:visual` script take care of that).
//   - `?test=1` in the URL forces deterministic render settings at runtime
//     (antialias off, DPR=1, OrbitControls damping off). Redundant with
//     build-time NODE_ENV=test but belt-and-braces.
//
// Determinism notes:
//   - Fixture is origin-offset in its STL bytes (AABB at ~X=267..351,
//     Y=1094..1163). Issue #25 auto-centers the Master group on the print
//     bed: after `setMaster`, the mesh's lowest point sits on Y=0 and its
//     X/Z-centre is on the origin. The golden therefore shows the
//     figurine sitting ON the grid with the origin axes gizmo visible
//     behind it — NOT floating ~1 m off the grid as it would have if we
//     rendered the STL coordinates verbatim.
//   - `frameToBox3` inside `setMaster` then retargets the camera + orbit
//     to the world-space bbox (local bbox + offset), so the mesh fills
//     the frame alongside the origin gizmo.
//   - manifold-3d is deterministic cross-platform (ADR-002), so volume +
//     vertex positions are stable, which in turn makes the rendered output
//     stable modulo the SwiftShader rasteriser jitter budget.

import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RENDERER_URL = 'http://localhost:5174/?test=1';

const FIXTURE_PATH = resolve(__dirname, '..', 'fixtures', 'meshes', 'mini-figurine.stl');

test.describe('visual — scene with master', () => {
  test('renders mini-figurine master with camera framed to AABB', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-04-18T00:00:00Z') });

    // Stub `window.api` before navigation. The visual bundle runs in plain
    // Chromium, so the Electron preload never fires — the version-hydrate
    // call in main.ts would error without this shim.
    await page.addInitScript(() => {
      (window as unknown as { api: Record<string, unknown> }).api = {
        getVersion: () => Promise.resolve('0.0.0'),
        openStl: () => Promise.resolve({ canceled: true }),
        saveStl: () => Promise.resolve({ canceled: true }),
      };
    });

    await page.goto(RENDERER_URL);

    // Wait for the viewport to mount — either the test-hook flag flips or a
    // canvas appears inside #viewport.
    await page.waitForFunction(
      () => {
        const hooks = (
          window as unknown as {
            __testHooks?: { viewportReady?: boolean };
          }
        ).__testHooks;
        if (hooks?.viewportReady) return true;
        const container = document.getElementById('viewport');
        return !!container?.querySelector('canvas');
      },
      undefined,
      { timeout: 10_000 },
    );

    // Read the STL fixture in Node and hand the bytes to the renderer. The
    // renderer's `setMaster` accepts an ArrayBuffer (same shape the IPC
    // response delivers in the real flow), so this precisely exercises the
    // visual output of the load path.
    const fixtureBytes = readFileSync(FIXTURE_PATH);
    const byteArray = Array.from(fixtureBytes);

    await page.evaluate(async (bytes: number[]) => {
      const u8 = new Uint8Array(bytes);
      // Clone into a standalone ArrayBuffer (not a view over a shared one)
      // so the buffer looks identical to the IPC round-trip output.
      const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
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

    // One RAF tick after the load so the freshly-positioned camera renders
    // into the backbuffer before we snapshot. The visibility-change + clock
    // combo keeps this deterministic.
    await page.clock.runFor(100);

    await expect(page).toHaveScreenshot('scene-with-mini-figurine.png', {
      maxDiffPixelRatio: 0.01,
      threshold: 0.15,
      animations: 'disabled',
      fullPage: false,
    });
  });
});
