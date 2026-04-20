// tests/e2e/printable-preview.spec.ts
//
// End-to-end for issue #62: printable-parts preview + exploded-view
// extension.
//
// Flow:
//   1. Launch app, stub the Open dialog to return the mini-figurine.
//   2. Open STL → master loads; printable-parts toggle starts disabled.
//   3. Commit a face (camera-down-click, same helper as the silicone spec).
//   4. Click Generate → wait for volumes to populate.
//   5. Assert printable-parts toggle is enabled + not-pressed; group
//      still hidden (default OFF per issue #62).
//   6. Toggle printable-parts ON → group becomes visible; assert via
//      scene.traverse that base + 4 sides + topCap meshes exist.
//   7. Toggle exploded-view ON → wait for BOTH idle signals (silicone
//      + printable) → assert base world-Y < -20 mm (base fell below
//      origin) AND topCap world-Y > +20 mm.
//   8. Stale-invalidation: commit a different face → both preview
//      groups clear AND both toggles revert to disabled.
//
// Generator budget on the mini-figurine is ~2-3 s; we set the wait
// ceilings to 15 s for CI headroom, same as the silicone spec.

import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { launchApp } from './fixtures/app';

const MINI_FIGURINE_PATH = resolve(
  __dirname,
  '..',
  'fixtures',
  'meshes',
  'mini-figurine.stl',
);

/**
 * Commit the top face by swinging the camera straight down. Copied
 * verbatim from `silicone-preview.spec.ts` since the gesture sequence
 * is identical. Factored into a helper so divergence is obvious if
 * one spec ever needs a different camera approach.
 */
async function commitTopFace(page: Page): Promise<void> {
  await page.evaluate(() => {
    type ViewportHooks = {
      viewport?: {
        camera: {
          position: { set: (x: number, y: number, z: number) => void };
          up: { set: (x: number, y: number, z: number) => void };
          lookAt: (x: number, y: number, z: number) => void;
          updateMatrixWorld: () => void;
          updateProjectionMatrix: () => void;
        };
        enableFacePicking: () => void;
      };
    };
    const hooks = (window as unknown as { __testHooks?: ViewportHooks })
      .__testHooks;
    const vp = hooks?.viewport;
    if (!vp) throw new Error('viewport hook missing');
    vp.camera.position.set(0, 250, 0);
    vp.camera.up.set(0, 0, -1);
    vp.camera.lookAt(0, 35, 0);
    vp.camera.updateMatrixWorld();
    vp.camera.updateProjectionMatrix();
    vp.enableFacePicking();
  });
  const canvasBox = await page.locator('#viewport canvas').boundingBox();
  if (!canvasBox) throw new Error('canvas missing');
  const cx = canvasBox.x + canvasBox.width / 2;
  const cy = canvasBox.y + canvasBox.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.click(cx, cy);
  await page.waitForFunction(
    () => {
      type ViewportHooks = {
        viewport?: {
          isFacePickingActive: () => boolean;
          isOrientationCommitted: () => boolean;
        };
      };
      const hooks = (window as unknown as { __testHooks?: ViewportHooks })
        .__testHooks;
      return (
        hooks?.viewport?.isFacePickingActive() === false &&
        hooks?.viewport?.isOrientationCommitted() === true
      );
    },
    undefined,
    { timeout: 5_000 },
  );
}

async function commitSideFace(page: Page): Promise<void> {
  await page.evaluate(() => {
    type ViewportHooks = {
      viewport?: {
        resetOrientation: () => void;
        camera: {
          position: { set: (x: number, y: number, z: number) => void };
          up: { set: (x: number, y: number, z: number) => void };
          lookAt: (x: number, y: number, z: number) => void;
          updateMatrixWorld: () => void;
          updateProjectionMatrix: () => void;
        };
        enableFacePicking: () => void;
      };
    };
    const hooks = (window as unknown as { __testHooks?: ViewportHooks })
      .__testHooks;
    const vp = hooks?.viewport;
    if (!vp) throw new Error('viewport hook missing');
    vp.resetOrientation();
    vp.camera.position.set(250, 35, 0);
    vp.camera.up.set(0, 1, 0);
    vp.camera.lookAt(0, 35, 0);
    vp.camera.updateMatrixWorld();
    vp.camera.updateProjectionMatrix();
    vp.enableFacePicking();
  });
  const canvasBox = await page.locator('#viewport canvas').boundingBox();
  if (!canvasBox) throw new Error('canvas missing');
  const cx = canvasBox.x + canvasBox.width / 2;
  const cy = canvasBox.y + canvasBox.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.click(cx, cy);
  await page.waitForFunction(
    () => {
      type ViewportHooks = {
        viewport?: { isOrientationCommitted: () => boolean };
      };
      const hooks = (window as unknown as { __testHooks?: ViewportHooks })
        .__testHooks;
      return hooks?.viewport?.isOrientationCommitted() === true;
    },
    undefined,
    { timeout: 5_000 },
  );
}

/**
 * Count printable-parts meshes by tag prefix. Returns `{base, sides,
 * topCap}` so tests can differentiate between "no parts installed" and
 * "partial install (bug)". The counts land at 1 / N / 1 after a
 * successful Generate with default sideCount=4.
 */
async function countPrintableMeshes(page: Page): Promise<{
  base: number;
  sides: number;
  topCap: number;
}> {
  return page.evaluate(() => {
    type SceneHook = {
      scene?: {
        traverse: (
          cb: (obj: { userData?: Record<string, unknown> }) => void,
        ) => void;
      };
    };
    const hooks = (window as unknown as { __testHooks?: SceneHook })
      .__testHooks;
    if (!hooks?.scene) throw new Error('scene hook missing');
    let base = 0;
    let sides = 0;
    let topCap = 0;
    hooks.scene.traverse((obj) => {
      const tag = obj.userData?.['tag'];
      if (tag === 'printable-base') base += 1;
      else if (tag === 'printable-top-cap') topCap += 1;
      else if (typeof tag === 'string' && tag.startsWith('printable-side-')) {
        sides += 1;
      }
    });
    return { base, sides, topCap };
  });
}

/**
 * Read the world-space Y of a printable mesh by tag. Returns NaN if the
 * mesh isn't in the scene. We read the matrix directly per the same
 * pattern as `silicone-preview.spec.ts` — Three's `getWorldPosition`
 * needs a Vector3 which a plain `page.evaluate` return shape can't carry.
 */
async function readPrintableMeshWorldY(
  page: Page,
  tag: string,
): Promise<number> {
  return page.evaluate((targetTag: string) => {
    type Obj = {
      userData?: Record<string, unknown>;
      matrixWorld?: { elements: ArrayLike<number> };
      updateWorldMatrix?: (u: boolean, v: boolean) => void;
    };
    type SceneHook = {
      scene?: { traverse: (cb: (obj: Obj) => void) => void };
    };
    const hooks = (window as unknown as { __testHooks?: SceneHook })
      .__testHooks;
    if (!hooks?.scene) throw new Error('scene hook missing');
    let worldY = Number.NaN;
    hooks.scene.traverse((obj) => {
      if (obj.userData?.['tag'] === targetTag) {
        if (obj.updateWorldMatrix) obj.updateWorldMatrix(true, false);
        if (obj.matrixWorld) {
          worldY = obj.matrixWorld.elements[13]!;
        }
      }
    });
    return worldY;
  }, tag);
}

test('printable-parts preview: toggle reveals → exploded drops base below Y=-20', async () => {
  const app = await launchApp();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    await app.evaluate((_electron, fixturePath) => {
      (
        globalThis as unknown as {
          __testDialogStub: {
            showOpenDialog: () => Promise<{
              canceled: boolean;
              filePaths: string[];
            }>;
          };
        }
      ).__testDialogStub = {
        showOpenDialog: () =>
          Promise.resolve({ canceled: false, filePaths: [fixturePath] }),
      };
    }, MINI_FIGURINE_PATH);

    const openBtn = page.locator('[data-testid="open-stl-btn"]');
    await expect(openBtn).toBeVisible();
    await expect(openBtn).toBeEnabled();

    const printableToggle = page.locator(
      '[data-testid="printable-parts-toggle"]',
    );
    const explodedToggle = page.locator('[data-testid="exploded-view-toggle"]');
    await expect(printableToggle).toBeVisible();
    await expect(printableToggle).toBeDisabled();
    await expect(explodedToggle).toBeDisabled();

    // Open STL → master loads.
    await page.evaluate(() => {
      const hooks = (
        window as unknown as {
          __testHooks?: { masterLoaded?: Promise<void> };
        }
      ).__testHooks;
      if (!hooks?.masterLoaded) throw new Error('masterLoaded hook missing');
      (
        globalThis as unknown as { __pendingMasterLoaded: Promise<void> }
      ).__pendingMasterLoaded = hooks.masterLoaded;
    });
    await openBtn.click();
    await page.evaluate(
      () =>
        (
          globalThis as unknown as { __pendingMasterLoaded: Promise<void> }
        ).__pendingMasterLoaded,
    );

    // Commit a face → Generate enables.
    await commitTopFace(page);
    await expect(page.locator('[data-testid="generate-btn"]')).toBeEnabled();

    // Click Generate, wait for the button to un-busy.
    await page.locator('[data-testid="generate-btn"]').click();
    await expect(page.locator('[data-testid="generate-btn"]'))
      .toHaveText('Generate mold', { timeout: 15_000 });
    await expect(page.locator('[data-testid="generate-btn"]')).toBeEnabled();

    // Volumes populated (proves orchestrator ran to completion).
    await expect(page.locator('[data-testid="silicone-volume-value"]'))
      .not.toHaveText('Click Generate', { timeout: 5_000 });

    // Issue #67 — printable-parts toggle should now be enabled AND
    // pressed (default ON after Generate). Exploded-view stays
    // enabled + not-pressed (unchanged by this PR).
    await expect(printableToggle).toBeEnabled();
    await expect(printableToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(explodedToggle).toBeEnabled();
    await expect(explodedToggle).toHaveAttribute('aria-pressed', 'false');

    // Printable parts are installed AND visible (default ON per #67).
    const counts = await countPrintableMeshes(page);
    expect(counts.base).toBe(1);
    expect(counts.sides).toBe(4); // default sideCount
    expect(counts.topCap).toBe(1);

    // Scene-level visibility flag is true without any user click.
    const visibleAfterGenerate = await page.evaluate(() => {
      type Hook = {
        viewport?: { arePrintablePartsVisible: () => boolean };
      };
      return (
        (window as unknown as { __testHooks?: Hook }).__testHooks?.viewport
          ?.arePrintablePartsVisible() ?? null
      );
    });
    expect(visibleAfterGenerate).toBe(true);

    // Clicking the toggle (already pressed) flips it OFF — the user's
    // "hide the mold to focus on silicone" path stays back-compat.
    await printableToggle.click();
    await expect(printableToggle).toHaveAttribute('aria-pressed', 'false');
    const visibleAfterHideClick = await page.evaluate(() => {
      type Hook = {
        viewport?: { arePrintablePartsVisible: () => boolean };
      };
      return (
        (window as unknown as { __testHooks?: Hook }).__testHooks?.viewport
          ?.arePrintablePartsVisible() ?? null
      );
    });
    expect(visibleAfterHideClick).toBe(false);

    // Flip back ON so the remainder of the spec exercises the visible
    // + exploded path (same behaviour as before this PR, just reached
    // from the other direction).
    await printableToggle.click();
    await expect(printableToggle).toHaveAttribute('aria-pressed', 'true');
    const visibleAfterToggle = await page.evaluate(() => {
      type Hook = {
        viewport?: { arePrintablePartsVisible: () => boolean };
      };
      return (
        (window as unknown as { __testHooks?: Hook }).__testHooks?.viewport
          ?.arePrintablePartsVisible() ?? null
      );
    });
    expect(visibleAfterToggle).toBe(true);

    // Base + topCap currently at y ≈ 0 (not exploded yet).
    expect(await readPrintableMeshWorldY(page, 'printable-base')).toBeCloseTo(
      0,
      3,
    );
    expect(
      await readPrintableMeshWorldY(page, 'printable-top-cap'),
    ).toBeCloseTo(0, 3);

    // Toggle exploded view ON. This fans out to BOTH scene modules —
    // silicone halves AND printable parts animate simultaneously.
    await explodedToggle.click();
    await expect(explodedToggle).toHaveAttribute('aria-pressed', 'true');

    // Wait for BOTH idle signals before asserting positions — the RAF
    // tween runs off real wall-clock ms which Playwright's page.clock
    // can't advance. Same rationale as the silicone-exploded visual spec.
    await page.waitForFunction(
      () => {
        type Hook = {
          viewport?: {
            isExplodedViewIdle: () => boolean;
            isPrintableExplodedIdle: () => boolean;
          };
        };
        const hooks = (window as unknown as { __testHooks?: Hook })
          .__testHooks;
        return (
          hooks?.viewport?.isExplodedViewIdle?.() === true &&
          hooks?.viewport?.isPrintableExplodedIdle?.() === true
        );
      },
      undefined,
      { timeout: 5_000 },
    );

    // Base falls below -20 mm. Offset = max(30, 0.2 * bboxHeight) ≥ 30,
    // so base should be at y ≈ -30 after exploding. -20 is the issue-
    // specified assertion threshold (issue #62 E2E AC).
    const baseY = await readPrintableMeshWorldY(page, 'printable-base');
    expect(baseY).toBeLessThan(-20);
    const topCapY = await readPrintableMeshWorldY(page, 'printable-top-cap');
    expect(topCapY).toBeGreaterThan(20);

    // Collapse exploded view.
    await explodedToggle.click();
    await expect(explodedToggle).toHaveAttribute('aria-pressed', 'false');
    await page.waitForFunction(
      () => {
        type Hook = {
          viewport?: {
            isExplodedViewIdle: () => boolean;
            isPrintableExplodedIdle: () => boolean;
          };
        };
        const hooks = (window as unknown as { __testHooks?: Hook })
          .__testHooks;
        return (
          hooks?.viewport?.isExplodedViewIdle?.() === true &&
          hooks?.viewport?.isPrintableExplodedIdle?.() === true
        );
      },
      undefined,
      { timeout: 5_000 },
    );
    expect(await readPrintableMeshWorldY(page, 'printable-base')).toBeCloseTo(
      0,
      2,
    );

    // Commit a DIFFERENT face → stale invalidation tears everything down.
    await commitSideFace(page);
    await expect(printableToggle).toBeDisabled();
    await expect(printableToggle).toHaveAttribute('aria-pressed', 'false');
    const countsAfterStale = await countPrintableMeshes(page);
    expect(countsAfterStale.base).toBe(0);
    expect(countsAfterStale.sides).toBe(0);
    expect(countsAfterStale.topCap).toBe(0);
  } finally {
    await app.close();
  }
});
