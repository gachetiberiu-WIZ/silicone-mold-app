// tests/visual/topbar-all-volumes.spec.ts
//
// Visual regression: the topbar with all four volume readouts populated
// (Wave C, issue #72 extends the Wave-A three-readout set with
// "Print shell"). The existing `topbar-units.spec.ts` covers the single-
// readout (master-only) baseline; this spec adds the post-generate view.
//
// Two states:
//   1. mm mode with the mini-figurine's master volume (~127 451.6 mm³)
//      plus canonical silicone (~319 914 mm³), print-shell (~455 000 mm³)
//      and resin (~127 451.6 mm³) outputs.
//   2. Same values, inches mode — verifies all four readouts re-format
//      coherently in a single unit flip.
//
// Test-id layout: `volume-value` (master, unchanged), `silicone-volume-
// value`, `print-shell-volume-value`, `resin-volume-value`.
//
// Goldens are regenerated on this branch via the one-shot
// `update-linux-goldens.yml` workflow (the 4th readout shifts the layout
// enough that the Wave-A baselines no longer match). Per ADR-003 §B the
// visual-regression job is advisory for 2 weeks after first green, so
// the missing-golden failure does not block PR merge.

import { expect, test, type Page } from '@playwright/test';

const RENDERER_URL = 'http://localhost:5174/?test=1';
// Slightly wider clip than the single-readout topbar spec — three readouts
// + the toggle use more horizontal real estate.
const TOPBAR_CLIP = { x: 0, y: 0, width: 1280, height: 48 } as const;

interface TopbarHook {
  setVolume(mm3: number | null): void;
  setMasterVolume(mm3: number | null): void;
  setSiliconeVolume(mm3: number | null): void;
  setPrintShellVolume(mm3: number | null): void;
  setBaseSlabVolume(mm3: number | null): void;
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
  test('mm mode, all five volumes populated', async ({ page }) => {
    await openRenderer(page);
    await page.evaluate(() => {
      const t = (
        window as unknown as { __testHooks: { topbar: TopbarHook } }
      ).__testHooks.topbar;
      t.setUnits('mm');
      // Canonical numbers observed from the generator's unit tests.
      t.setMasterVolume(127_451.6);
      t.setSiliconeVolume(319_914);
      t.setPrintShellVolume(455_000);
      t.setBaseSlabVolume(88_888);
      t.setResinVolume(127_451.6);
    });
    await page.clock.runFor(50);
    await expect(page).toHaveScreenshot('topbar-all-volumes-mm.png', {
      clip: TOPBAR_CLIP,
    });
  });

  test('inches mode, all five volumes populated', async ({ page }) => {
    await openRenderer(page);
    await page.evaluate(() => {
      const t = (
        window as unknown as { __testHooks: { topbar: TopbarHook } }
      ).__testHooks.topbar;
      t.setUnits('in');
      t.setMasterVolume(127_451.6);
      t.setSiliconeVolume(319_914);
      t.setPrintShellVolume(455_000);
      t.setBaseSlabVolume(88_888);
      t.setResinVolume(127_451.6);
    });
    await page.clock.runFor(50);
    await expect(page).toHaveScreenshot('topbar-all-volumes-in.png', {
      clip: TOPBAR_CLIP,
    });
  });
});
