// tests/e2e/printable-preview.spec.ts
//
// End-to-end for issue #62 (updated for Wave C, issue #72): printable-
// parts preview + exploded-view extension. Post-Wave-C the print shell
// is a SINGLE surface-conforming mesh (no rectangular box / N sides /
// top cap).
//
// Flow:
//   1. Launch app, stub the Open dialog to return the mini-figurine.
//   2. Open STL → master loads; printable-parts toggle starts disabled.
//   3. Commit a face (camera-down-click, same helper as the silicone spec).
//   4. Click Generate → wait for volumes to populate.
//   5. Assert printable-parts toggle is enabled + pressed (default ON per
//      issue #67 carry-forward).
//   6. Single `print-shell` mesh exists in the scene.
//   7. Toggle exploded-view ON → wait for BOTH idle signals (silicone
//      + print-shell) → assert print-shell world-Y > +20 mm (shell
//      lifted along +Y above silicone).
//   8. Stale-invalidation: commit a different face → both preview
//      groups clear AND both toggles revert to disabled.
//
// Generator budget on the mini-figurine is ~3-4 s post-Wave-C (two
// levelSet passes against the same SDF); wait ceilings bumped to 20 s
// for CI headroom.

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
 * Count print-shell meshes in the scene. Post-Wave-C (issue #72) this
 * is a single surface-conforming mesh tagged `print-shell` — the
 * rectangular-box rectangular base/sides/top-cap tags are gone.
 * Returned as an object so the shape can extend in Wave D/E/F (base
 * slab, sliced shell pieces) without churning call sites.
 */
async function countPrintableMeshes(page: Page): Promise<{
  printShell: number;
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
    let printShell = 0;
    hooks.scene.traverse((obj) => {
      const tag = obj.userData?.['tag'];
      if (tag === 'print-shell') printShell += 1;
    });
    return { printShell };
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

test('print-shell preview: default-ON reveals shell → exploded lifts shell above Y=+20', async () => {
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

    // Print shell is installed AND visible (default ON per #67). Wave C:
    // one surface-conforming mesh, not 6 rectangular pieces.
    const counts = await countPrintableMeshes(page);
    expect(counts.printShell).toBe(1);

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

    // Print shell currently at y ≈ 0 (not exploded yet).
    expect(await readPrintableMeshWorldY(page, 'print-shell')).toBeCloseTo(
      0,
      3,
    );

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

    // Wave C: the print shell is a single mesh that lifts along +Y with
    // offset = max(40, 0.25 * bboxHeight) ≥ 40, so the shell should be
    // at y ≈ 40+ after exploding. +20 is a conservative lower bound that
    // catches a "shell never moved" regression while tolerating any
    // bbox-height fluctuation.
    const shellY = await readPrintableMeshWorldY(page, 'print-shell');
    expect(shellY).toBeGreaterThan(20);

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
    expect(await readPrintableMeshWorldY(page, 'print-shell')).toBeCloseTo(
      0,
      2,
    );

    // Commit a DIFFERENT face → stale invalidation tears everything down.
    await commitSideFace(page);
    await expect(printableToggle).toBeDisabled();
    await expect(printableToggle).toHaveAttribute('aria-pressed', 'false');
    const countsAfterStale = await countPrintableMeshes(page);
    expect(countsAfterStale.printShell).toBe(0);
  } finally {
    await app.close();
  }
});
