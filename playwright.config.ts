import { defineConfig } from '@playwright/test';

/**
 * Playwright config for Electron E2E tests.
 *
 * `test:e2e` runs the default project against the packaged dev bundle.
 * `test:visual` (added later) will use a separate project for screenshot
 * regressions.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env['CI'] ? [['github'], ['list']] : [['list']],
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'electron',
      testMatch: /.*\.spec\.ts$/,
      testIgnore: /.*\.visual\.spec\.ts$/,
    },
    {
      name: 'visual',
      testMatch: /.*\.visual\.spec\.ts$/,
    },
  ],
});
