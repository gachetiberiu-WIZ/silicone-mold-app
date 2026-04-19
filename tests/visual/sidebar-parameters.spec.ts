// tests/visual/sidebar-parameters.spec.ts
//
// Visual regression: the right-sidebar parameter form at default state.
// Captures the whole app window so the viewport + grid layout + sidebar
// render together — this is the "user's first-launch experience" view.
//
// First-run behaviour: this spec will produce a new golden on its first
// green CI run. Per ADR-003 §B (§"Visual-regression gating policy") the
// visual-regression job is advisory for the first 2 weeks after first
// green, so the missing-golden failure does not block PR merge. QA will
// confirm the golden-candidate in CI before the diff is committed.

import { expect, test, type Page } from '@playwright/test';

const RENDERER_URL = 'http://localhost:5174/?test=1';

async function openRenderer(page: Page): Promise<void> {
  await page.clock.install({ time: new Date('2026-04-18T00:00:00Z') });
  await page.addInitScript(() => {
    (window as unknown as { api: Record<string, unknown> }).api = {
      getVersion: () => Promise.resolve('0.0.0'),
      openStl: () =>
        Promise.resolve({ canceled: true, paths: [] as string[] }),
      saveStl: () => Promise.resolve({ canceled: true }),
    };
    try {
      window.localStorage.removeItem('units');
    } catch {
      /* ignore */
    }
  });
  await page.goto(RENDERER_URL);
  // Wait for the sidebar to be populated — the reset button is the
  // last element mounted by `mountParameterPanel`.
  await page.waitForSelector('[data-testid="param-reset"]', {
    timeout: 10_000,
  });
  // Also wait for the topbar so the full window is deterministic.
  await page.waitForFunction(
    () =>
      !!(
        window as unknown as {
          __testHooks?: { topbar?: unknown; parameters?: unknown };
        }
      ).__testHooks?.parameters,
    undefined,
    { timeout: 10_000 },
  );
  await page.clock.runFor(100);
}

test.describe('visual — sidebar parameters', () => {
  test('default state: all 8 fields + reset disabled', async ({ page }) => {
    await openRenderer(page);
    await expect(page).toHaveScreenshot('sidebar-parameters-defaults.png', {
      maxDiffPixelRatio: 0.01,
      threshold: 0.15,
      animations: 'disabled',
      fullPage: false,
    });
  });

  test('inches mode: length fields redisplay with 3 decimals', async ({
    page,
  }) => {
    await openRenderer(page);
    // Flip the topbar toggle.
    await page.click('[data-testid="units-toggle-in"]');
    await page.clock.runFor(50);
    await expect(page).toHaveScreenshot(
      'sidebar-parameters-inches.png',
      {
        maxDiffPixelRatio: 0.01,
        threshold: 0.15,
        animations: 'disabled',
        fullPage: false,
      },
    );
  });
});
