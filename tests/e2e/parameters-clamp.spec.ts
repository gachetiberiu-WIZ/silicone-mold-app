// tests/e2e/parameters-clamp.spec.ts
//
// End-to-end: the right-sidebar parameter form renders inside the Electron
// renderer, an out-of-range input surfaces the inline error live, and blur
// clamps the value back into the legal range while clearing the error.
//
// Why this lives at the E2E tier (rather than the unit tier that already
// covers the same behaviour via happy-dom):
//
//   * Proves the panel is actually mounted in the production renderer under
//     Electron — not just in the Vitest jsdom simulacrum. If a future main.ts
//     change fails to call `mountParameterPanel`, the unit tests would still
//     pass but this would fail.
//   * Proves the i18n bundle is actually loaded in the Electron renderer
//     (labels and error messages come from the resolved keys, not the raw
//     placeholders).
//   * Exercises a real native input's focus → blur → change event sequence,
//     which happy-dom approximates but does not perfectly match.

import { expect, test } from '@playwright/test';
import { launchApp } from './fixtures/app';

test('sidebar renders with 8 fields + reset button on app launch', async () => {
  const app = await launchApp();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    // Sidebar container mounts fields inside.
    await expect(
      page.locator('[data-testid="sidebar"]'),
    ).toBeVisible();

    // Every field, every error slot, the reset button — eight inputs.
    const fieldIds = [
      'wallThickness',
      'baseThickness',
      'sideCount',
      'sprueDiameter',
      'ventDiameter',
      'ventCount',
      'registrationKeyStyle',
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

    // Default wall thickness = 10 mm → renders as "10.0" with the mm unit.
    await expect(
      page.locator('[data-testid="param-input-wallThickness"]'),
    ).toHaveValue('10.0');
  } finally {
    await app.close();
  }
});

test('out-of-range input shows error live, blur clamps + clears error', async () => {
  const app = await launchApp();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    const wall = page.locator('[data-testid="param-input-wallThickness"]');
    const err = page.locator('[data-testid="param-error-wallThickness"]');

    // Clear and type an out-of-range value. Using fill() — it fires 'input'.
    await wall.fill('99');

    // Error is visible with the clamped range interpolated in mm.
    await expect(err).toBeVisible();
    await expect(err).toContainText('6');
    await expect(err).toContainText('25');
    await expect(wall).toHaveAttribute('aria-invalid', 'true');

    // Blur the field — clamps to 25 and clears the error.
    await wall.blur();

    await expect(wall).toHaveValue('25.0');
    await expect(err).toBeHidden();
    // aria-invalid attribute is removed on valid state.
    await expect(wall).not.toHaveAttribute('aria-invalid', 'true');

    // The reset button is now enabled (store moved off defaults).
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
    await page.locator('[data-testid="param-input-wallThickness"]').fill('15');
    await page.locator('[data-testid="param-input-wallThickness"]').blur();
    await page
      .locator('[data-testid="param-input-sideCount"]')
      .selectOption('2');

    const reset = page.locator('[data-testid="param-reset"]');
    await expect(reset).toBeEnabled();

    await reset.click();

    // Defaults restored in the UI, and the button is disabled again.
    await expect(
      page.locator('[data-testid="param-input-wallThickness"]'),
    ).toHaveValue('10.0');
    await expect(
      page.locator('[data-testid="param-input-sideCount"]'),
    ).toHaveValue('4');
    await expect(reset).toBeDisabled();
  } finally {
    await app.close();
  }
});
