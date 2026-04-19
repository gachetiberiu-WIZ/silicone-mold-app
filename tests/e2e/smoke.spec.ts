import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchApp } from './fixtures/app';

const pkg = JSON.parse(
  readFileSync(resolve(__dirname, '..', '..', 'package.json'), 'utf8'),
) as { version: string };

test('smoke: Electron app launches and shows package version via IPC', async () => {
  const app = await launchApp();
  try {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    // Title is set in index.html
    await expect(window).toHaveTitle(/Silicone Mold App/);

    // The version is hydrated via IPC — wait until it is replaced from the
    // default 'v…' placeholder.
    const versionLocator = window.locator('[data-testid="app-version"]');
    await expect(versionLocator).toHaveText(`v${pkg.version}`, {
      timeout: 10_000,
    });

    // The Open STL button exists but is disabled in this PR.
    const openBtn = window.locator('[data-testid="open-stl-btn"]');
    await expect(openBtn).toBeVisible();
    await expect(openBtn).toBeDisabled();
  } finally {
    await app.close();
  }
});
