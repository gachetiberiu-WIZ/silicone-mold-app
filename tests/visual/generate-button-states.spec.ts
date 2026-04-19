// tests/visual/generate-button-states.spec.ts
//
// Visual regression: the sidebar Generate-mold block in its three visible
// states (issue #36).
//
//   - Disabled + no master: hint reads "Load an STL to begin.". This is
//     also the default first-launch view.
//   - Disabled + master loaded: hint reads the orient-first instruction.
//   - Enabled (orientation committed): button accent-coloured, hint reads
//     "Ready to generate".
//
// We drive the state through `window.__testHooks.generateButton` plus the
// master/controller hooks so each snapshot is deterministic without
// simulating pointer events inside a SwiftShader-backed Chromium.
//
// First-run behaviour: these specs will produce new goldens on their
// first green CI run. Per ADR-003 §B the visual-regression job is
// advisory for 2 weeks after first green, so the missing-golden
// failure does not block PR merge.

import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RENDERER_URL = 'http://localhost:5174/?test=1';
const FIXTURE_PATH = resolve(
  __dirname,
  '..',
  'fixtures',
  'meshes',
  'mini-figurine.stl',
);

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
  // Wait for the generate block (last thing to mount in the sidebar).
  await page.waitForSelector('[data-testid="generate-btn"]', {
    timeout: 10_000,
  });
  await page.waitForFunction(
    () =>
      !!(
        window as unknown as {
          __testHooks?: { generateButton?: unknown; parameters?: unknown };
        }
      ).__testHooks?.generateButton,
    undefined,
    { timeout: 10_000 },
  );
  await page.clock.runFor(100);
}

async function loadFixtureAsMaster(page: Page): Promise<void> {
  const fixtureBytes = readFileSync(FIXTURE_PATH);
  const byteArray = Array.from(fixtureBytes);
  await page.evaluate(async (bytes: number[]) => {
    const u8 = new Uint8Array(bytes);
    const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    const hooks = (
      window as unknown as {
        __testHooks?: {
          viewport?: { setMaster: (buf: ArrayBuffer) => Promise<unknown> };
          generateButton?: { setHasMaster: (v: boolean) => void };
        };
      }
    ).__testHooks;
    if (!hooks?.viewport) throw new Error('viewport hook missing');
    await hooks.viewport.setMaster(ab);
    // main.ts only calls `setHasMaster(true)` from the Open-STL IPC path.
    // Since the visual spec bypasses IPC (no real file dialog in Chromium),
    // drive the hint state directly via the generate-button hook.
    hooks.generateButton?.setHasMaster(true);
  }, byteArray);
  await page.clock.runFor(100);
}

test.describe('visual — generate-mold button states', () => {
  test('disabled + no master: hint reads "Load an STL to begin."', async ({
    page,
  }) => {
    await openRenderer(page);
    await expect(page).toHaveScreenshot('generate-block-no-master.png', {
      maxDiffPixelRatio: 0.01,
      threshold: 0.15,
      animations: 'disabled',
      fullPage: false,
    });
  });

  test('disabled + master loaded: hint reads the orient-first instruction', async ({
    page,
  }) => {
    await openRenderer(page);
    await loadFixtureAsMaster(page);
    await expect(page).toHaveScreenshot('generate-block-disabled-with-master.png', {
      maxDiffPixelRatio: 0.01,
      threshold: 0.15,
      animations: 'disabled',
      fullPage: false,
    });
  });

  test('enabled (committed): button accent-coloured + hint = "Ready to generate"', async ({
    page,
  }) => {
    await openRenderer(page);
    await loadFixtureAsMaster(page);
    // Flip the generate button's enabled state directly via its test hook,
    // short-circuiting the lay-flat commit pipeline (which is verified
    // separately in `tests/e2e/generate-gate.spec.ts`). The visual under
    // test is purely the button's enabled rendering.
    await page.evaluate(() => {
      const hooks = (
        window as unknown as {
          __testHooks?: {
            generateButton?: { setEnabled: (v: boolean) => void };
          };
        }
      ).__testHooks;
      hooks?.generateButton?.setEnabled(true);
    });
    await page.clock.runFor(50);
    await expect(page).toHaveScreenshot('generate-block-enabled.png', {
      maxDiffPixelRatio: 0.01,
      threshold: 0.15,
      animations: 'disabled',
      fullPage: false,
    });
  });
});
