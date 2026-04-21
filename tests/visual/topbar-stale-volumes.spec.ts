// tests/visual/topbar-stale-volumes.spec.ts
//
// Visual regression: the topbar silicone + resin readouts in the "stale"
// muted state (issue #64, Option A). After a successful generate, the
// user tweaks a parameter; the orchestrator has not run again, so the
// displayed silicone + resin numbers are for the OLD parameter set. The
// UI flags this by adding `is-stale` to the two readout wraps, which
// triggers the italic + 50 % opacity rule defined in index.html.
//
// Master volume is NOT stale (it's invariant under parameter change) —
// the snapshot also asserts the master readout remains at full opacity.
//
// Driven through `window.__testHooks.topbar.setVolumesStale(true)` so
// the spec doesn't need to simulate a full parameter-store event flow;
// the wiring from parameters store → topbar is covered in the
// orchestrator / invalidation unit tests. The visual here is purely the
// CSS rule + the class placement on the correct wraps.
//
// First-run note: this spec produces a new golden on its first green
// CI run via the one-shot `update-linux-goldens.yml` workflow (pattern
// from PR #63). Per ADR-003 §B visual-regression is advisory for 2
// weeks after first green, so the missing-golden failure does not
// block PR merge.

import { expect, test, type Page } from '@playwright/test';

const RENDERER_URL = 'http://localhost:5174/?test=1';
const TOPBAR_CLIP = { x: 0, y: 0, width: 1280, height: 48 } as const;

interface TopbarHook {
  setMasterVolume(mm3: number | null): void;
  setSiliconeVolume(mm3: number | null): void;
  setPrintShellVolume(mm3: number | null): void;
  setResinVolume(mm3: number | null): void;
  setVolumesStale(stale: boolean): void;
  setUnits(unit: 'mm' | 'in'): void;
}

async function openRenderer(page: Page): Promise<void> {
  await page.clock.install({ time: new Date('2026-04-20T00:00:00Z') });
  await page.addInitScript(() => {
    (window as unknown as { api: Record<string, unknown> }).api = {
      getVersion: () => Promise.resolve('0.0.0'),
      openStl: () => Promise.resolve({ canceled: true, paths: [] as string[] }),
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

test.describe('visual — topbar stale silicone + resin readouts', () => {
  test('mm mode, stale silicone + resin, master remains bright', async ({ page }) => {
    await openRenderer(page);
    await page.evaluate(() => {
      const t = (
        window as unknown as { __testHooks: { topbar: TopbarHook } }
      ).__testHooks.topbar;
      t.setUnits('mm');
      // Canonical mini-figurine numbers (same as `topbar-all-volumes`
      // so the diff reads cleanly — only the muted style differs).
      t.setMasterVolume(127_451.6);
      t.setSiliconeVolume(319_914);
      t.setPrintShellVolume(455_000);
      t.setResinVolume(127_451.6);
      // Flip to the stale state — silicone + print-shell + resin should
      // now render italic + 50 % opacity; master unchanged.
      t.setVolumesStale(true);
    });
    await page.clock.runFor(50);
    await expect(page).toHaveScreenshot('topbar-stale-volumes-mm.png', {
      clip: TOPBAR_CLIP,
    });
  });
});
