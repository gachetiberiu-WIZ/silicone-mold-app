// tests/e2e/printable-preview.spec.ts
//
// End-to-end for issue #62 (updated for Wave E+F, issue #84): printable-
// parts preview + exploded-view extension. Post-Wave-E the print shell
// is radially SLICED into N pieces (default sideCount=4 → 4 pieces)
// each tagged `shell-piece-0..N-1`. Exploded view moves each piece
// RADIALLY outward from the master's XZ center (not +Y).
//
// Flow:
//   1. Launch app, stub the Open dialog to return the mini-figurine.
//   2. Open STL → master loads; printable-parts toggle starts disabled.
//   3. Commit a face (camera-down-click, same helper as the silicone spec).
//   4. Click Generate → wait for volumes to populate.
//   5. Assert printable-parts toggle is enabled + pressed (default ON per
//      issue #67 carry-forward).
//   6. N `shell-piece-i` meshes + 1 `base-slab-mesh` exist in the scene.
//   7. Toggle exploded-view ON → wait for BOTH idle signals (silicone
//      + printable-parts) → assert at least one shell piece has moved
//      RADIALLY (XZ distance > 20 mm) from origin while its Y stays ~0.
//   8. Stale-invalidation: commit a different face → every preview
//      mesh clears AND both toggles revert to disabled.
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
 * Count printable meshes in the scene. Post-Wave-E (issue #84) the
 * print shell is radially sliced into N pieces each tagged
 * `shell-piece-{i}`. The base slab is tagged `base-slab-mesh`.
 */
async function countPrintableMeshes(page: Page): Promise<{
  shellPieces: number;
  baseSlab: number;
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
    let shellPieces = 0;
    let baseSlab = 0;
    hooks.scene.traverse((obj) => {
      const tag = obj.userData?.['tag'];
      if (typeof tag === 'string' && tag.startsWith('shell-piece-')) {
        shellPieces += 1;
      }
      if (tag === 'base-slab-mesh') baseSlab += 1;
    });
    return { shellPieces, baseSlab };
  });
}

/**
 * Read the world-space (x, y, z) of a printable mesh by tag. Returns
 * `null` if the mesh isn't in the scene. We read the matrix directly
 * per the same pattern as `silicone-preview.spec.ts`.
 */
async function readPrintableMeshWorldPos(
  page: Page,
  tag: string,
): Promise<{ x: number; y: number; z: number } | null> {
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
    let found: { x: number; y: number; z: number } | null = null;
    hooks.scene.traverse((obj) => {
      if (obj.userData?.['tag'] === targetTag) {
        if (obj.updateWorldMatrix) obj.updateWorldMatrix(true, false);
        if (obj.matrixWorld) {
          const e = obj.matrixWorld.elements;
          found = { x: e[12]!, y: e[13]!, z: e[14]! };
        }
      }
    });
    return found;
  }, tag);
}

test('printable-parts preview: default-ON reveals shell pieces → exploded fans pieces radially outward', async () => {
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

    // Shell pieces + base slab installed AND visible (default ON per
    // #67). Wave E (issue #84): N=4 shell pieces (default sideCount) +
    // 1 base slab in the printable-parts group.
    const counts = await countPrintableMeshes(page);
    expect(counts.shellPieces).toBe(4);
    expect(counts.baseSlab).toBe(1);

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

    // Every shell piece currently at its origin (not exploded yet).
    for (let i = 0; i < 4; i++) {
      const pos = await readPrintableMeshWorldPos(page, `shell-piece-${i}`);
      if (!pos) throw new Error(`shell-piece-${i} missing from scene`);
      expect(pos.x).toBeCloseTo(0, 3);
      expect(pos.y).toBeCloseTo(0, 3);
      expect(pos.z).toBeCloseTo(0, 3);
    }

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

    // Wave E: every shell piece moves RADIALLY outward, NOT +Y. Each
    // piece's translation magnitude is `max(30, 0.3 * bboxHorizRadius)
    // ≥ 30`. Assert that at least one piece has XZ distance > 20 mm
    // (conservative floor under the 30 mm default), with Y ≈ 0.
    let anyPieceMovedRadially = false;
    for (let i = 0; i < 4; i++) {
      const pos = await readPrintableMeshWorldPos(page, `shell-piece-${i}`);
      if (!pos) throw new Error(`shell-piece-${i} missing from scene`);
      const xzNorm = Math.sqrt(pos.x * pos.x + pos.z * pos.z);
      // Y stays at ~0 — no +Y lift for sliced pieces.
      expect(Math.abs(pos.y)).toBeLessThan(5);
      if (xzNorm > 20) anyPieceMovedRadially = true;
    }
    expect(anyPieceMovedRadially).toBe(true);

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
    for (let i = 0; i < 4; i++) {
      const pos = await readPrintableMeshWorldPos(page, `shell-piece-${i}`);
      if (!pos) throw new Error(`shell-piece-${i} missing from scene`);
      expect(pos.x).toBeCloseTo(0, 2);
      expect(pos.y).toBeCloseTo(0, 2);
      expect(pos.z).toBeCloseTo(0, 2);
    }

    // Commit a DIFFERENT face → stale invalidation tears everything down.
    await commitSideFace(page);
    await expect(printableToggle).toBeDisabled();
    await expect(printableToggle).toHaveAttribute('aria-pressed', 'false');
    const countsAfterStale = await countPrintableMeshes(page);
    expect(countsAfterStale.shellPieces).toBe(0);
    expect(countsAfterStale.baseSlab).toBe(0);
  } finally {
    await app.close();
  }
});
