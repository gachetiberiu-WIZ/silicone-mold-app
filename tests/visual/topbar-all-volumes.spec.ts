// tests/visual/topbar-all-volumes.spec.ts
//
// Visual regression: the topbar with all three volume readouts populated
// (issue #40). The existing `topbar-units.spec.ts` covers the single-
// readout (master-only) baseline; this spec adds the post-generate view.
//
// Two states:
//   1. mm mode with the mini-figurine's master volume (~127 451.6 mm³)
//      plus the generator's canonical silicone (~319 914 mm³) and resin
//      (~127 451.6 mm³) outputs.
//   2. Same values, inches mode — verifies all three readouts re-format
//      coherently in a single unit flip.
//
// The master-volume readout uses the pre-existing `data-testid="volume-
// value"` (unchanged); the two new readouts live at `silicone-volume-
// value` and `resin-volume-value`.
//
// First-run note: this spec produces new goldens on its first green CI
// run. Per ADR-003 §B the visual-regression job is advisory for 2 weeks
// after first green, so the missing-golden failure does not block PR
// merge.

import { expect, test, type Page } from '@playwright/test';

const RENDERER_URL = 'http://localhost:5174/?test=1';
// Slightly wider clip than the single-readout topbar spec — three readouts
// + the toggle use more horizontal real estate.
const TOPBAR_CLIP = { x: 0, y: 0, width: 1280, height: 48 } as const;

interface TopbarHook {
  setVolume(mm3: number | null): void;
  setMasterVolume(mm3: number | null): void;
  setSiliconeVolume(mm3: number | null): void;
  setResinVolume(mm3: number | null): void;
  setUnits(unit: 'mm' | 'in'): void;
  getUnits(): 'mm' | 'in';
}

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
  await page.waitForFunction(
    () =>
      !!(
        window as unknown as { __testHooks?: { topbar?: TopbarHook } }
      ).__testHooks?.topbar,
    undefined,
    { timeout: 10_000 },
  );
  await page.clock.runFor(50);
}

test.describe('visual — topbar with all three volumes', () => {
  test('mm mode, master + silicone + resin populated', async ({ page }) => {
    await openRenderer(page);
    await page.evaluate(() => {
      const t = (
        window as unknown as { __testHooks: { topbar: TopbarHook } }
      ).__testHooks.topbar;
      t.setUnits('mm');
      // Canonical numbers observed from the generator's unit tests:
      // silicone ≈ 319 914 mm³, resin = master = 127 451.6 mm³ for the
      // mini-figurine fixture with default 10 mm wall thickness.
      t.setMasterVolume(127_451.6);
      t.setSiliconeVolume(319_914);
      t.setResinVolume(127_451.6);
    });
    await page.clock.runFor(50);
    await expect(page).toHaveScreenshot('topbar-all-volumes-mm.png', {
      clip: TOPBAR_CLIP,
    });
  });

  test('inches mode, master + silicone + resin populated', async ({ page }) => {
    await openRenderer(page);
    await page.evaluate(() => {
      const t = (
        window as unknown as { __testHooks: { topbar: TopbarHook } }
      ).__testHooks.topbar;
      t.setUnits('in');
      t.setMasterVolume(127_451.6);
      t.setSiliconeVolume(319_914);
      t.setResinVolume(127_451.6);
    });
    await page.clock.runFor(50);
    await expect(page).toHaveScreenshot('topbar-all-volumes-in.png', {
      clip: TOPBAR_CLIP,
    });
  });
});
