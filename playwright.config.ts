// playwright.config.ts
//
// Two projects per ADR-003 §B + §C:
//   - `visual`        → Chromium headed with SwiftShader, deterministic
//                       rendering, fixed 1280×800 viewport, used for golden
//                       screenshots (`tests/visual/**/*.spec.ts`).
//   - `e2e-electron`  → Electron launched via `_electron.launch()` from
//                       `tests/e2e/**/*.spec.ts`.
//
// Both projects share the `tests/__screenshots__/` golden dir. Goldens for
// visual tests are committed under `tests/__screenshots__/linux-ci/` on the
// Linux runner; actuals/diffs are git-ignored.
//
// Runtime flags (advisory-for-now, aligned with ADR-003 §B):
//   - `--use-gl=swiftshader` + `--enable-unsafe-swiftshader` for deterministic WebGL.
//   - `deviceScaleFactor: 1`, `viewport: 1280x800`, `hasTouch: false`.
//   - `antialias: false` is the *renderer* side — the app honours it when
//     `NODE_ENV === 'test'`. See `.claude/skills/testing-3d/SKILL.md`.

import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';

const CI = !!process.env.CI;

const config: PlaywrightTestConfig = {
  testDir: './tests',
  // Keep the two test suites separated by path so project filtering is clean.
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  reporter: CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  // Golden snapshots are sharded by platform to match ADR-003 §B
  // ("goldens committed under `__screenshots__/linux-ci/*.png`"). CI is the
  // source of truth — devs generate local snapshots for fast-feedback only.
  // Local Windows/macOS runs write to platform-scoped dirs that are
  // .gitignored, so developers don't accidentally commit non-authoritative
  // goldens. Linux CI writes to `__screenshots__/linux-ci/...` which IS
  // checked in.
  snapshotDir: './tests/__screenshots__',
  snapshotPathTemplate:
    '{snapshotDir}/{platform}-ci/{testFileDir}/{testFileName}-snapshots/{arg}{ext}',
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01,
      threshold: 0.15,
      animations: 'disabled',
    },
  },
  use: {
    // Global defaults; overridden per-project where needed.
    trace: CI ? 'retain-on-failure' : 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'visual',
      testMatch: /tests[\\/]visual[\\/].*\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
        hasTouch: false,
        // Deterministic WebGL via SwiftShader — ADR-003 §B.
        launchOptions: {
          args: [
            '--use-gl=swiftshader',
            '--enable-unsafe-swiftshader',
            '--disable-gpu-vsync',
            '--disable-renderer-backgrounding',
            '--hide-scrollbars',
          ],
        },
        colorScheme: 'light',
      },
    },
    {
      name: 'e2e-electron',
      testMatch: /tests[\\/]e2e[\\/].*\.spec\.ts/,
      // Electron tests launch their own app via `_electron.launch()` — they
      // don't use a project-level browser. This project exists so `--project`
      // routing works for the CI job.
      use: {
        trace: CI ? 'retain-on-failure' : 'on-first-retry',
      },
    },
  ],
};

// `workers` is only set on CI — omit it entirely locally so Playwright uses
// its default. With `exactOptionalPropertyTypes: true` we can't assign
// `undefined` to an optional property.
if (CI) {
  config.workers = 1;
}

export default defineConfig(config);
