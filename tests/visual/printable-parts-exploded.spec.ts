// tests/visual/printable-parts-exploded.spec.ts
//
// Visual regression: mini-figurine master + silicone halves + printable
// parts (visible) + exploded-view toggle ON. Exercises the full Wave 4
// preview pipeline for issue #62.
//
// The generator takes ~2-3 s on warm machines; we set an outer 90 s
// timeout to cover cold SwiftShader runs. Determinism: Chromium is
// launched with SwiftShader (configured in `playwright.config.ts`) and
// the clock is frozen before snapshotting — same pattern as
// `silicone-exploded.spec.ts`.
//
// First-run behaviour: this spec ships its first golden on the first
// green CI run. Per ADR-003 §B visual regression is advisory for 2
// weeks after first green, so the missing-golden failure does not block
// PR merge. The one-shot `update-linux-goldens.yml` workflow on this
// branch regenerates the baseline on ubuntu-latest and commits it back.

import { expect, test } from '@playwright/test';
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

test.describe('visual — printable parts preview + exploded view', () => {
  test('mini-figurine + silicone + printable parts + exploded view ON', async ({
    page,
  }) => {
    test.setTimeout(90_000);

    await page.clock.install({ time: new Date('2026-04-18T00:00:00Z') });
    await page.addInitScript(() => {
      (window as unknown as { api: Record<string, unknown> }).api = {
        getVersion: () => Promise.resolve('0.0.0'),
        openStl: () => Promise.resolve({ canceled: true }),
        saveStl: () => Promise.resolve({ canceled: true }),
      };
    });

    await page.goto(RENDERER_URL);

    // Wait for viewport + all toolbar toggles to mount.
    await page.waitForFunction(
      () => {
        const hooks = (
          window as unknown as {
            __testHooks?: {
              viewportReady?: boolean;
              viewport?: unknown;
              explodedView?: unknown;
              printablePartsToggle?: unknown;
            };
          }
        ).__testHooks;
        return !!(
          hooks?.viewportReady &&
          hooks?.viewport &&
          hooks?.explodedView &&
          hooks?.printablePartsToggle
        );
      },
      undefined,
      { timeout: 15_000 },
    );

    const fixtureBytes = readFileSync(FIXTURE_PATH);
    const byteArray = Array.from(fixtureBytes);
    await page.evaluate(async (bytes: number[]) => {
      const u8 = new Uint8Array(bytes);
      const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      type SetMasterHooks = {
        viewport?: {
          setMaster: (buf: ArrayBuffer) => Promise<unknown>;
        };
      };
      const hooks = (window as unknown as { __testHooks?: SetMasterHooks })
        .__testHooks;
      if (!hooks?.viewport) throw new Error('viewport hook missing');
      await hooks.viewport.setMaster(ab);
    }, byteArray);

    // Synthetic lay-flat commit via the event bus — same technique as
    // `silicone-exploded.spec.ts`.
    await page.evaluate(() => {
      const event = new CustomEvent('lay-flat-committed', { detail: true });
      document.dispatchEvent(event);
    });

    // Click Generate via the hook — no pointer coords needed.
    await page.evaluate(() => {
      const btn = document.querySelector<HTMLButtonElement>(
        '[data-testid="generate-btn"]',
      );
      if (!btn) throw new Error('generate-btn missing');
      btn.click();
    });

    // Wait for the volumes to populate (orchestrator finished).
    await page.waitForFunction(
      () => {
        const el = document.querySelector<HTMLElement>(
          '[data-testid="silicone-volume-value"]',
        );
        return el?.textContent && el.textContent !== 'Click Generate';
      },
      undefined,
      { timeout: 60_000 },
    );

    // Wait for BOTH silicone AND printable-parts meshes to be live in
    // the scene. Printable parts install at `group.visible=false`
    // initially, but `scene.traverse` walks them regardless.
    await page.waitForFunction(
      () => {
        type Obj = { userData?: Record<string, unknown> };
        type SceneHook = {
          scene?: { traverse: (cb: (obj: Obj) => void) => void };
        };
        const hooks = (window as unknown as { __testHooks?: SceneHook })
          .__testHooks;
        if (!hooks?.scene) return false;
        let silicone = 0;
        let printable = 0;
        hooks.scene.traverse((obj) => {
          const tag = obj.userData?.['tag'];
          if (tag === 'silicone-upper' || tag === 'silicone-lower') silicone += 1;
          if (
            tag === 'printable-base' ||
            tag === 'printable-top-cap' ||
            (typeof tag === 'string' && tag.startsWith('printable-side-'))
          ) {
            printable += 1;
          }
        });
        // 2 silicone halves + 1 base + 4 sides + 1 topCap = 8 parts.
        return silicone === 2 && printable >= 4;
      },
      undefined,
      { timeout: 10_000 },
    );

    // Flip printable-parts visibility ON + flip exploded-view ON. We
    // drive both via the scene-level functions directly — the UI toggle
    // path works too but going through hooks is less fragile on
    // SwiftShader (where hover-dispatched clicks can jitter).
    await page.evaluate(() => {
      type Hooks = {
        printablePartsToggle?: {
          setEnabled: (v: boolean) => void;
          setActive: (v: boolean) => void;
        };
        explodedView?: { setEnabled: (v: boolean) => void; setActive: (v: boolean) => void };
        viewport?: {
          setPrintablePartsVisible: (v: boolean) => void;
          setExplodedView: (v: boolean) => void;
          setPrintablePartsExplodedView: (v: boolean) => void;
        };
      };
      const hooks = (window as unknown as { __testHooks?: Hooks })
        .__testHooks;
      hooks?.printablePartsToggle?.setEnabled(true);
      hooks?.printablePartsToggle?.setActive(true);
      hooks?.explodedView?.setEnabled(true);
      hooks?.explodedView?.setActive(true);
      hooks?.viewport?.setPrintablePartsVisible(true);
      hooks?.viewport?.setExplodedView(true);
      hooks?.viewport?.setPrintablePartsExplodedView(true);
    });
    await page.clock.runFor(400);

    // Wait for BOTH tweens to converge before screenshot. The silicone
    // module's `isExplodedViewIdle` + the printable-parts module's
    // `isPrintableExplodedIdle` must both be true — issue #62 visual AC.
    await page.waitForFunction(
      () => {
        type IdleHook = {
          viewport?: {
            isExplodedViewIdle: () => boolean;
            isPrintableExplodedIdle: () => boolean;
          };
        };
        const hooks = (window as unknown as { __testHooks?: IdleHook })
          .__testHooks;
        return (
          hooks?.viewport?.isExplodedViewIdle?.() === true &&
          hooks?.viewport?.isPrintableExplodedIdle?.() === true
        );
      },
      undefined,
      { timeout: 3_000 },
    );

    // `timeout: 30_000` per the #53/#54 precedent for complex visual
    // scenes. Same rationale: SwiftShader's first-frame raster with
    // multiple transparent + opaque meshes takes several seconds to
    // stabilise, and toHaveScreenshot's default 5 s internal stability
    // loop can fall just short.
    await expect(page).toHaveScreenshot('printable-parts-exploded.png', {
      maxDiffPixelRatio: 0.01,
      threshold: 0.15,
      animations: 'disabled',
      fullPage: false,
      timeout: 30_000,
    });
  });
});
