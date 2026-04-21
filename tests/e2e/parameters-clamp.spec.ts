// tests/e2e/parameters-clamp.spec.ts
//
// End-to-end: the right-sidebar parameter form renders inside the Electron
// renderer, an out-of-range input surfaces the inline error live, and blur
// clamps the value back into the legal range while clearing the error.
//
// Post-#82 scope: six rows (silicone thickness, print-shell thickness,
// base-slab thickness, base-slab overhang, sideCount, draftAngle).

import { expect, test } from '@playwright/test';
import { launchApp } from './fixtures/app';

test('sidebar renders with 6 fields + reset button on app launch', async () => {
  const app = await launchApp();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    await expect(
      page.locator('[data-testid="sidebar"]'),
    ).toBeVisible();

    const fieldIds = [
      'siliconeThickness',
      'printShellThickness',
      'baseSlabThickness',
      'baseSlabOverhang',
      'sideCount',
      'draftAngle',
    ];
    for (const id of fieldIds) {
      await expect(
        page.locator(`[data-testid="param-input-${id}"]`),
      ).toBeVisible();
    }

    // Reset button is disabled on mount (store starts at defaults).
    const reset = page.locator('[data-testid="param-reset"]');
    await expect(reset).toBeDisabled();

    // Default silicone thickness = 5 mm post-#69 → renders as "5.0" with
    // the mm unit.
    await expect(
      page.locator('[data-testid="param-input-siliconeThickness"]'),
    ).toHaveValue('5.0');
  } finally {
    await app.close();
  }
});

test('out-of-range input shows error live, blur clamps + clears error', async () => {
  const app = await launchApp();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    const silicone = page.locator('[data-testid="param-input-siliconeThickness"]');
    const err = page.locator('[data-testid="param-error-siliconeThickness"]');

    // Clear and type an out-of-range value. Using fill() — it fires 'input'.
    await silicone.fill('99');

    // Error is visible with the clamped range interpolated (1–15 mm
    // post-#69).
    await expect(err).toBeVisible();
    await expect(err).toContainText('1');
    await expect(err).toContainText('15');
    await expect(silicone).toHaveAttribute('aria-invalid', 'true');

    // Blur the field — clamps to 15 and clears the error.
    await silicone.blur();

    await expect(silicone).toHaveValue('15.0');
    await expect(err).toBeHidden();
    await expect(silicone).not.toHaveAttribute('aria-invalid', 'true');

    await expect(
      page.locator('[data-testid="param-reset"]'),
    ).toBeEnabled();
  } finally {
    await app.close();
  }
});

test('reset-to-defaults restores every field and disables itself', async () => {
  const app = await launchApp();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    // Move a couple of fields off-default.
    await page.locator('[data-testid="param-input-siliconeThickness"]').fill('12');
    await page.locator('[data-testid="param-input-siliconeThickness"]').blur();
    await page
      .locator('[data-testid="param-input-sideCount"]')
      .selectOption('2');

    const reset = page.locator('[data-testid="param-reset"]');
    await expect(reset).toBeEnabled();

    await reset.click();

    await expect(
      page.locator('[data-testid="param-input-siliconeThickness"]'),
    ).toHaveValue('5.0');
    await expect(
      page.locator('[data-testid="param-input-sideCount"]'),
    ).toHaveValue('4');
    await expect(reset).toBeDisabled();
  } finally {
    await app.close();
  }
});
