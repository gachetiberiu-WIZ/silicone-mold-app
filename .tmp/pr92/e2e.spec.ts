// tests/e2e/stl-export-roundtrip.spec.ts
//
// End-to-end roundtrip for STL export (issue #91). Verifies the full
// user journey:
//
//   1. Launch the app, stub both native dialogs (Open STL + folder
//      picker) at the main-process level via `__testDialogStub`.
//   2. Click Open STL → mini-figurine loads as the master.
//   3. Commit a face via a canvas-centre click from a camera-down
//      position — the helper is a copy of the one in
//      `silicone-preview.spec.ts`.
//   4. Click Generate, wait for the shell pieces to install.
//   5. Export STL button now enabled → click it.
//   6. Folder picker stub returns `testInfo.outputDir`.
//   7. Verify N+1 binary STL files land on disk: `base-slab.stl` +
//      `shell-piece-0..3.stl` (default sideCount=4).
//   8. Each file passes a basic binary-STL shape check: ≥ 84 bytes
//      (80-byte header + 4-byte tri count), the tri count matches
//      the file size (84 + tri*50), and the header does NOT begin
//      with ASCII `solid` (which would be the ASCII STL marker).
//   9. Success toast is visible in the renderer.
//
// The generator takes ~3-4 s on the mini-figurine; wait ceilings are
// generous (15 s) for CI headroom.

import { expect, test, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { launchApp } from './fixtures/app';

const MINI_FIGURINE_PATH = resolve(
  __dirname,
  '..',
  'fixtures',
  'meshes',
  'mini-figurine.stl',
);

/**
 * Commit the figurine's top face. Copy of the helper in
 * `silicone-preview.spec.ts`. Inlined here so this spec stays self-
 * contained — the export flow is narrower than the preview flow and
 * doesn't need all the exploded-view plumbing.
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
 * Validate a binary STL file's on-disk bytes:
 *   - at least 84 bytes (80-byte header + 4-byte tri count),
 *   - tri-count in the 4-byte LE field matches `(size - 84) / 50`,
 *   - header does NOT start with ASCII `solid` (that'd be ASCII STL).
 *
 * `expectNonEmpty`: when true (default for shell pieces) also asserts
 * tri-count > 0. The base slab can legitimately come out empty when the
 * committed orientation has no bottom face resting at Y=0 (the figurine-
 * top-face commit is one such case); the validator relaxes that check
 * when the caller opts in.
 */
async function assertBinaryStl(
  path: string,
  { expectNonEmpty }: { expectNonEmpty: boolean } = { expectNonEmpty: true },
): Promise<number> {
  const s = await stat(path);
  expect(s.size).toBeGreaterThanOrEqual(84);
  const fd = await fs.open(path, 'r');
  try {
    const headerBuf = Buffer.alloc(84);
    await fd.read(headerBuf, 0, 84, 0);
    const header5 = headerBuf.subarray(0, 5).toString('ascii').toLowerCase();
    expect(header5).not.toBe('solid');
    const triCount = headerBuf.readUInt32LE(80);
    if (expectNonEmpty) {
      expect(triCount).toBeGreaterThan(0);
    }
    const expectedSize = 84 + triCount * 50;
    expect(s.size).toBe(expectedSize);
    return triCount;
  } finally {
    await fd.close();
  }
}

// Use the `{}, testInfo` shape Playwright ships — an empty-object
// destructure on the first arg is the official way to opt out of the
// built-in fixtures (we launch Electron manually via `launchApp`).
// `eslint-disable` is local to this signature because the project's
// flat ESLint config defaults to `no-empty-pattern: error`.
// eslint-disable-next-line no-empty-pattern
test('STL export roundtrip: open → commit → generate → export → files on disk', async ({}, testInfo) => {
  const app = await launchApp();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    page.on('console', (msg) => {
      console.log(`[renderer:${msg.type()}] ${msg.text()}`);
    });
    page.on('pageerror', (err) => {
      console.log(`[renderer:pageerror] ${err.message}`);
    });

    // Install both dialog stubs on the main process. The Open dialog
    // returns the mini-figurine; the folder picker returns the
    // per-test temp dir Playwright hands us. `testInfo.outputDir` is
    // lazily created — we `mkdir -p` here so the main process can
    // write files into it before any Playwright-owned artefact triggers
    // the default creation.
    const outDir = testInfo.outputDir;
    await fs.mkdir(outDir, { recursive: true });
    await app.evaluate(
      (_electron, { fixturePath, folderPath }) => {
        (
          globalThis as unknown as {
            __testDialogStub: {
              showOpenDialog: () => Promise<{
                canceled: boolean;
                filePaths: string[];
              }>;
              showOpenFolder: () => Promise<{
                canceled: boolean;
                filePaths: string[];
              }>;
            };
          }
        ).__testDialogStub = {
          showOpenDialog: () =>
            Promise.resolve({ canceled: false, filePaths: [fixturePath] }),
          showOpenFolder: () =>
            Promise.resolve({ canceled: false, filePaths: [folderPath] }),
        };
      },
      { fixturePath: MINI_FIGURINE_PATH, folderPath: outDir },
    );

    // Export button exists + starts disabled.
    const exportBtn = page.locator('[data-testid="export-stl-btn"]');
    await expect(exportBtn).toBeVisible();
    await expect(exportBtn).toBeDisabled();

    // Open STL.
    const openBtn = page.locator('[data-testid="open-stl-btn"]');
    await expect(openBtn).toBeEnabled();
    await page.evaluate(() => {
      const hooks = (
        window as unknown as {
          __testHooks?: { masterLoaded?: Promise<void> };
        }
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

    // Commit a face → Generate enables.
    await commitTopFace(page);
    await expect(page.locator('[data-testid="generate-btn"]')).toBeEnabled();

    // Generate + wait for the button to un-busy.
    await page.locator('[data-testid="generate-btn"]').click();
    await expect(page.locator('[data-testid="generate-btn"]'))
      .toHaveText('Generate mold', { timeout: 15_000 });
    await expect(page.locator('[data-testid="generate-btn"]')).toBeEnabled();

    // Volumes populated (proves orchestrator ran to completion).
    await expect(page.locator('[data-testid="silicone-volume-value"]'))
      .not.toHaveText('Click Generate', { timeout: 5_000 });

    // Export button now enabled.
    await expect(exportBtn).toBeEnabled({ timeout: 5_000 });

    // Click → folder-picker stub returns `outDir` → writes happen.
    await exportBtn.click();

    // Wait for the button to un-busy (label flips back to "Export STL"),
    // then verify files on disk.
    await expect(exportBtn).toHaveText('Export STL', { timeout: 30_000 });
    await expect(exportBtn).toBeEnabled();

    // N+1 files: `base-slab.stl` + `shell-piece-0..3.stl` (default
    // sideCount=4). Any extra files (e.g. Playwright's own artefacts)
    // are ignored — we only check the ones we care about.
    const expected = [
      'base-slab.stl',
      'shell-piece-0.stl',
      'shell-piece-1.stl',
      'shell-piece-2.stl',
      'shell-piece-3.stl',
    ];
    const entries = await readdir(outDir);
    for (const name of expected) {
      expect(entries, `missing ${name} in ${outDir} (got ${entries.join(', ')})`)
        .toContain(name);
      // `base-slab.stl` may be empty when the committed top-face has no
      // bottom surface to slab off (figurine is a mini with a complex
      // underside → degenerate baseSlab volume). Every shell piece must
      // always be non-empty — shell generation is viewport-independent.
      const expectNonEmpty = name !== 'base-slab.stl';
      await assertBinaryStl(join(outDir, name), { expectNonEmpty });
    }
    // At minimum, every shell piece produced real triangles. This
    // guarantees the binary STL serialiser actually walked the Manifold
    // mesh, rather than writing a 4-byte zero-tri header for every
    // file (which would satisfy the format-shape check but miss a
    // regression where the Manifold-to-geometry adapter silently
    // returns an empty BufferGeometry).
    for (let i = 0; i < 4; i++) {
      const tris = await assertBinaryStl(join(outDir, `shell-piece-${i}.stl`));
      expect(tris).toBeGreaterThan(0);
    }

    // Success toast visible.
    await expect(page.locator('[data-testid="error-toast"]'))
      .toBeVisible();
    const toastText = await page
      .locator('[data-testid="error-toast"]')
      .textContent();
    expect(toastText).toContain('Exported 5 files to');
  } finally {
    await app.close();
  }
});
