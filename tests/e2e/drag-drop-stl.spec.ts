// tests/e2e/drag-drop-stl.spec.ts
//
// End-to-end coverage for issue #27 (drag-drop STL onto the window).
//
// What this exercises:
//   - A programmatic drop event synthesised inside the renderer — we
//     can't drive the host OS drag layer from Playwright/Electron, so we
//     construct a DragEvent with a DataTransfer carrying a real `File`
//     built from the fixture bytes. This is the same entry point the
//     production drop handler sees from a real OS drag.
//   - Post-load state parity with the Open-STL dialog flow: a `master`
//     mesh enters the scene + the topbar volume readout shows a real
//     value. Mirrors `tests/e2e/load-stl-flow.spec.ts` so a drift in
//     loadMasterFromBuffer between the two entrypoints would fail both.
//   - Error-toast surfacing for the three validation rules:
//     wrong-extension, multi-file, too-large.
//
// Why Chromium synthesis and not the real drag layer: Playwright's
// `page.dispatchEvent` can't construct a DataTransfer with files; the
// community pattern is to build the DragEvent inside the page via
// `page.evaluate` (see microsoft/playwright#2136). This matches how
// real browser tests for drag-and-drop work.

import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchApp } from './fixtures/app';

const UNIT_CUBE_PATH = resolve(
  __dirname,
  '..',
  'fixtures',
  'meshes',
  'unit-cube.stl',
);

test('drag-drop: single .stl loads identically to Open-STL dialog', async () => {
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

    // Capture the masterLoaded promise BEFORE dropping — same pattern as
    // load-stl-flow.spec.ts. The viewport rotates the promise on each
    // successful load so this await covers exactly one load cycle.
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

    // Read the STL bytes on the Node side and pass them through as a
    // regular array (structured-clone over the CDP boundary). The renderer
    // reassembles a File/DataTransfer and dispatches the DragEvent on
    // `#app`, which is where `attachDropZone` listens.
    const stlBytes = Array.from(readFileSync(UNIT_CUBE_PATH));

    await page.evaluate(
      ({ bytes, fileName }) => {
        const buffer = new Uint8Array(bytes);
        const file = new File([buffer], fileName, { type: 'model/stl' });
        const dt = new DataTransfer();
        dt.items.add(file);

        const target = document.getElementById('app');
        if (!target) throw new Error('#app container missing');

        // Fire the standard drag sequence. dragenter + dragover must both
        // preventDefault for the subsequent drop to be honoured; the
        // handler does that internally.
        const dragEnter = new DragEvent('dragenter', {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
        });
        target.dispatchEvent(dragEnter);
        const dragOver = new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
        });
        target.dispatchEvent(dragOver);
        const drop = new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
        });
        target.dispatchEvent(drop);
      },
      { bytes: stlBytes, fileName: 'unit-cube.stl' },
    );

    // Await the load. 30 s is generous — unit-cube is 12 tri, so really
    // bounded by the manifold-3d init cost.
    await page.evaluate(
      () =>
        (
          globalThis as unknown as { __pendingMasterLoaded: Promise<void> }
        ).__pendingMasterLoaded,
    );

    // A mesh tagged 'master' now lives in the scene — identical assertion
    // to load-stl-flow.spec.ts, proving parity between the two entry points.
    const hasMasterMesh = await page.evaluate(() => {
      const scene = (
        window as unknown as {
          __testHooks?: {
            scene?: {
              traverse: (
                cb: (o: {
                  userData?: Record<string, unknown>;
                  type?: string;
                }) => void,
              ) => void;
            };
          };
        }
      ).__testHooks?.scene;
      if (!scene) return false;
      let found = false;
      scene.traverse((obj) => {
        if (obj.userData?.['tag'] === 'master' && obj.type === 'Mesh') {
          found = true;
        }
      });
      return found;
    });
    expect(hasMasterMesh).toBe(true);

    // Topbar master-volume readout shows a concrete value rather than the
    // empty-state placeholder.
    const volumeText = await page
      .locator('[data-testid="volume-value"]')
      .textContent();
    expect(volumeText).toBeTruthy();
    expect(volumeText).not.toBe('No master loaded');
    expect(volumeText).toMatch(/mm\u00B3$/);
  } finally {
    await app.close();
  }
});

test('drag-drop: wrong-extension surfaces the user-visible error', async () => {
  const app = await launchApp();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    await page.evaluate(() => {
      const file = new File([new Uint8Array([1, 2, 3])], 'readme.txt', {
        type: 'text/plain',
      });
      const dt = new DataTransfer();
      dt.items.add(file);
      const target = document.getElementById('app');
      if (!target) throw new Error('#app missing');
      target.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
        }),
      );
    });

    const toast = page.locator('[data-testid="error-toast"]');
    await expect(toast).toBeVisible();
    await expect(toast).toHaveText('Only .stl files are supported');

    // No master in the scene — the topbar should still show the empty state.
    await expect(page.locator('[data-testid="volume-value"]')).toHaveText(
      'No master loaded',
    );
  } finally {
    await app.close();
  }
});

test('drag-drop: multi-file surfaces the user-visible error', async () => {
  const app = await launchApp();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(
        new File([new Uint8Array([0])], 'a.stl', { type: 'model/stl' }),
      );
      dt.items.add(
        new File([new Uint8Array([0])], 'b.stl', { type: 'model/stl' }),
      );
      const target = document.getElementById('app');
      if (!target) throw new Error('#app missing');
      target.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
        }),
      );
    });

    const toast = page.locator('[data-testid="error-toast"]');
    await expect(toast).toBeVisible();
    await expect(toast).toHaveText('Drop one file at a time');
    await expect(page.locator('[data-testid="volume-value"]')).toHaveText(
      'No master loaded',
    );
  } finally {
    await app.close();
  }
});

test('drag-drop: oversized file surfaces the user-visible error', async () => {
  const app = await launchApp();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    await page.evaluate(() => {
      // A File with a spoofed size > 500 MB. We can't actually allocate
      // half a gig in a Playwright spec; the handler reads File.size,
      // so overriding the property is enough to hit the too-large path.
      const file = new File([new Uint8Array([0])], 'huge.stl', {
        type: 'model/stl',
      });
      Object.defineProperty(file, 'size', {
        value: 600 * 1024 * 1024,
        writable: false,
      });
      const dt = new DataTransfer();
      dt.items.add(file);
      const target = document.getElementById('app');
      if (!target) throw new Error('#app missing');
      target.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
        }),
      );
    });

    const toast = page.locator('[data-testid="error-toast"]');
    await expect(toast).toBeVisible();
    await expect(toast).toHaveText('File too large');
    await expect(page.locator('[data-testid="volume-value"]')).toHaveText(
      'No master loaded',
    );
  } finally {
    await app.close();
  }
});
