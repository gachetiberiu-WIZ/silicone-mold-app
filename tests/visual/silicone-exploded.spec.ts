// tests/visual/silicone-exploded.spec.ts
//
// Visual regression: mini-figurine master + silicone halves + exploded-view
// toggle ON. Exercises the full preview pipeline for issue #47.
//
// Because `generateSiliconeShell` itself takes 2-3 s on the mini-figurine,
// we drive the full pipeline through the same `window.__testHooks` surface
// the E2E spec uses. Determinism: Chromium is launched with SwiftShader
// (configured in `playwright.config.ts` visual project) and the clock is
// frozen before snapshotting.
//
// First-run behaviour: this spec ships its first golden on the first green
// CI run. Per ADR-003 §B visual regression is advisory for 2 weeks after
// first green, so the missing-golden failure does not block PR merge.

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

test.describe('visual — silicone preview + exploded view', () => {
  test('mini-figurine + silicone halves + exploded view ON', async ({ page }) => {
    // 90 s timeout — the generator takes 2-3 s on warm machines, up to
    // ~5-8 s on a cold Chromium under SwiftShader. Headroom for CI.
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

    // Wait for viewport + UI mount.
    await page.waitForFunction(
      () => {
        const hooks = (
          window as unknown as {
            __testHooks?: {
              viewportReady?: boolean;
              viewport?: unknown;
              explodedView?: unknown;
            };
          }
        ).__testHooks;
        return !!(hooks?.viewportReady && hooks?.viewport && hooks?.explodedView);
      },
      undefined,
      { timeout: 15_000 },
    );

    // Hand the fixture bytes to the viewport's setMaster helper.
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

    // Drive a synthetic lay-flat commit by manipulating the master group's
    // quaternion directly. We don't need a face-accurate rotation here —
    // the lay-flat controller's commit flag is what the Generate-mold
    // button gates on. We just need committed=true. The simplest path is
    // to go through the viewport's face-picking API, but driving the
    // camera + click across SwiftShader is fragile. Instead: bypass to
    // `notifyMasterReset` + a direct commit via the controller isn't
    // exposed, so we dispatch `LAY_FLAT_COMMITTED_EVENT` with detail=true
    // — the Generate button subscription keys off that event for its
    // enabled state, and the orchestrator doesn't read the lay-flat
    // controller's `isCommitted()` directly.
    await page.evaluate(() => {
      const event = new CustomEvent('lay-flat-committed', { detail: true });
      document.dispatchEvent(event);
    });

    // Click Generate via the test hook (no click coords needed).
    await page.evaluate(() => {
      const btn = document.querySelector<HTMLButtonElement>(
        '[data-testid="generate-btn"]',
      );
      if (!btn) throw new Error('generate-btn missing');
      btn.click();
    });

    // Wait for the generator to finish — volumes populate.
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

    // Wait for silicone to actually be in the scene. Post-#69 we
    // expect exactly ONE silicone mesh (the horizontal split is gone).
    await page.waitForFunction(
      () => {
        type Obj = { userData?: Record<string, unknown> };
        type SceneHook = {
          scene?: { traverse: (cb: (obj: Obj) => void) => void };
        };
        const hooks = (window as unknown as { __testHooks?: SceneHook })
          .__testHooks;
        if (!hooks?.scene) return false;
        let count = 0;
        hooks.scene.traverse((obj) => {
          const tag = obj.userData?.['tag'];
          if (tag === 'silicone-body') count += 1;
        });
        return count === 1;
      },
      undefined,
      { timeout: 10_000 },
    );

    // Flip exploded view on via the UI toggle + wait for the tween to
    // fully complete. The tween runs off real `performance.now()` +
    // `requestAnimationFrame`, neither of which Playwright's `page.clock`
    // fake intercepts (issue #53 root cause: `page.clock.runFor(400)`
    // below doesn't advance the scene's wall-clock RAF loop at all).
    // Instead, we gate on the viewport's `isExplodedViewIdle()` hook —
    // which reads the silicone module's `state.rafId === 0 && state.tweenStart_ms === null`
    // — so the screenshot only fires once the halves have settled at
    // their fraction=1 resting positions. `page.clock.runFor` still runs
    // to flush any fake-clock-bound CSS transition the rest of the UI
    // has in flight.
    await page.evaluate(() => {
      type Hooks = {
        explodedView?: { setEnabled: (v: boolean) => void };
        viewport?: { setExplodedView: (v: boolean) => void };
      };
      const hooks = (window as unknown as { __testHooks?: Hooks })
        .__testHooks;
      // Ensure the toggle is enabled (the orchestrator's installed hook
      // drives this, but belt-and-braces for visual determinism).
      hooks?.explodedView?.setEnabled(true);
      // Fire the scene-side tween directly — this is what a click
      // eventually does. Running it from the test bypasses any pointer
      // plumbing SwiftShader jitter.
      hooks?.viewport?.setExplodedView(true);
    });
    await page.clock.runFor(400);

    // Wait for the RAF tween to converge. 2 s is ~8x the 250 ms tween
    // duration — generous slop for a cold SwiftShader.
    await page.waitForFunction(
      () => {
        type IdleHook = {
          viewport?: { isExplodedViewIdle: () => boolean };
        };
        const hooks = (window as unknown as { __testHooks?: IdleHook })
          .__testHooks;
        return hooks?.viewport?.isExplodedViewIdle?.() === true;
      },
      undefined,
      { timeout: 2_000 },
    );

    // `timeout: 60_000` overrides the Playwright 5 s default for
    // `toHaveScreenshot`'s internal stability loop (back-to-back snapshots
    // until two match pixel-exactly). Empirical: even with the tween
    // idle-gate above, SwiftShader's first-frame raster of the translucent
    // `DoubleSide + depthWrite: false` silicone material takes several
    // seconds to converge on ubuntu-latest (issue #53 hypothesis #2).
    // 60 s gives SwiftShader more headroom; still under the 90 s outer
    // `setTimeout` above. The first-run regen (`--update-snapshots`)
    // took >30 s on the Wave-A rebaseline pass (issue #69 CI run
    // 24710372003); 60 s is the post-hoc safe ceiling.
    await expect(page).toHaveScreenshot('silicone-exploded.png', {
      maxDiffPixelRatio: 0.01,
      threshold: 0.15,
      animations: 'disabled',
      fullPage: false,
      timeout: 60_000,
    });
  });
});
