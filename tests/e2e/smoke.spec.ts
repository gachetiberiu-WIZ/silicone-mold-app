import { test, expect } from '@playwright/test';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchApp } from './fixtures/app';

const pkg = JSON.parse(
  readFileSync(resolve(__dirname, '..', '..', 'package.json'), 'utf8'),
) as { version: string };

const MINI_FIGURINE_PATH = resolve(
  __dirname,
  '..',
  'fixtures',
  'meshes',
  'mini-figurine.stl',
);

test('smoke: Electron app launches and shows package version via IPC', async () => {
  const app = await launchApp();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    // Title is set in index.html
    await expect(page).toHaveTitle(/Silicone Mold App/);

    // The version is hydrated via IPC — wait until it is replaced from the
    // default 'v…' placeholder.
    const versionLocator = page.locator('[data-testid="app-version"]');
    await expect(versionLocator).toHaveText(`v${pkg.version}`, {
      timeout: 10_000,
    });

    // The Open STL button exists but is disabled in this PR — renderer-side
    // wiring ships in a follow-up issue.
    const openBtn = page.locator('[data-testid="open-stl-btn"]');
    await expect(openBtn).toBeVisible();
    await expect(openBtn).toBeDisabled();
  } finally {
    await app.close();
  }
});

test('smoke: file:open-stl returns ArrayBuffer matching fixture byteLength', async () => {
  const app = await launchApp();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    // Stub the native Open dialog in the main process. `app.evaluate` runs
    // in the Electron main process; `globalThis.__testDialogStub` is the
    // escape hatch that src/main/dialogs.ts honours only when NODE_ENV=test.
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

    // Drive the IPC call directly from the renderer — the button is still
    // disabled in this PR, so we exercise `window.api.openStl` through
    // `page.evaluate`. The returned ArrayBuffer is marshalled over the
    // structured-clone IPC boundary; we only need its byteLength here.
    const result = await page.evaluate(async () => {
      const response = await window.api.openStl({});
      if (response.canceled) return { canceled: true as const };
      if ('error' in response) {
        return { canceled: false as const, error: response.error };
      }
      return {
        canceled: false as const,
        name: response.name,
        byteLength: response.buffer.byteLength,
      };
    });

    const expectedSize = statSync(MINI_FIGURINE_PATH).size;
    expect(result).toEqual({
      canceled: false,
      name: 'mini-figurine.stl',
      byteLength: expectedSize,
    });
    // Sanity check against the committed fixture size. If this drifts the
    // fixture was regenerated — update the constant deliberately.
    expect(expectedSize).toBe(289984);
  } finally {
    await app.close();
  }
});

test('smoke: file:open-stl returns cancel variant when user dismisses dialog', async () => {
  const app = await launchApp();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    await app.evaluate(() => {
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
          Promise.resolve({ canceled: true, filePaths: [] }),
      };
    });

    const result = await page.evaluate(async () => {
      const response = await window.api.openStl({});
      return response;
    });

    expect(result).toEqual({ canceled: true });
  } finally {
    await app.close();
  }
});
