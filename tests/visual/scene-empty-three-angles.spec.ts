// tests/visual/scene-empty-three-angles.spec.ts
//
// Regression-lock for issue #26 (z-fighting between the world AxesHelper
// and the GridHelper at the origin). We snapshot the empty scene from
// three distinct camera viewpoints so that *any* re-introduction of the
// coplanar-lines flicker at y=0 shows up as a golden diff against at
// least one of them.
//
// Why three angles (not one):
//   - The z-fight artefact is viewpoint-dependent — two coplanar line
//     sets rasterise to the same pixel only along the viewing ray's
//     intersection with the plane, so the flicker's spatial footprint
//     changes with camera azimuth/elevation. A single iso angle can
//     mask the bug entirely on unlucky depth-buffer ties.
//   - Three orthogonal-ish viewpoints (near-top-down, iso, near-side-on)
//     give coverage of the two failure modes: (a) axis stem crossing
//     the grid-plane-line at a shallow angle, (b) axis lying nearly
//     flush with the grid plane.
//
// Camera targets are reproduced inline rather than driving OrbitControls
// because bare-specifier imports (`import 'three'`) don't resolve in
// Chromium's page context — we write camera.position/up/lookAt directly,
// then sync `controls.target` so the overlay gizmo's sync hook sees the
// same view.
//
// Visual-regression gating is advisory for the first 2 weeks per
// ADR-003 §B; new goldens land without blocking the merge.

import { expect, test } from '@playwright/test';

const RENDERER_URL = 'http://localhost:5174/?test=1';

type CameraLike = {
  position: { set: (x: number, y: number, z: number) => void };
  up: { set: (x: number, y: number, z: number) => void };
  lookAt: (x: number, y: number, z: number) => void;
  updateProjectionMatrix: () => void;
  updateMatrixWorld: () => void;
};
type ControlsLike = {
  target: { set: (x: number, y: number, z: number) => void };
  update: () => void;
};
type ViewportHooks = {
  viewport?: { controls: ControlsLike; camera: CameraLike };
};

/**
 * The three viewpoints. Distances/angles chosen so the grid and axis
 * stems both fill a meaningful fraction of the 1280×800 viewport.
 */
const ANGLES: ReadonlyArray<{
  name: string;
  file: string;
  position: readonly [number, number, number];
  target: readonly [number, number, number];
}> = [
  {
    name: 'iso',
    file: 'scene-empty-iso.png',
    position: [400, 400, 400],
    target: [0, 0, 0],
  },
  {
    name: 'near-top-down',
    file: 'scene-empty-top.png',
    // Small X/Z offset so the axes aren't fully collinear with the view
    // ray — top-down with a ~5° tilt reveals z-fight along axis stems.
    position: [40, 550, 40],
    target: [0, 0, 0],
  },
  {
    name: 'near-side-on',
    file: 'scene-empty-side.png',
    // Camera nearly flush with the XZ plane (+Y of 30 mm above the bed) —
    // exercises the shallow-angle failure mode where axis lines lie almost
    // parallel to the grid from the camera's POV.
    position: [500, 30, 200],
    target: [0, 0, 0],
  },
];

test.describe('visual — empty scene, multi-angle (issue #26)', () => {
  for (const angle of ANGLES) {
    test(`empty scene from ${angle.name} — no axis/grid z-fight`, async ({
      page,
    }) => {
      await page.clock.install({ time: new Date('2026-04-18T00:00:00Z') });

      await page.addInitScript(() => {
        (window as unknown as { api: Record<string, unknown> }).api = {
          getVersion: () => Promise.resolve('0.0.0'),
          openStl: () =>
            Promise.resolve({ canceled: true, paths: [] as string[] }),
          saveStl: () => Promise.resolve({ canceled: true }),
        };
      });

      await page.goto(RENDERER_URL);

      await page.waitForFunction(
        () => {
          const hooks = (
            window as unknown as {
              __testHooks?: { viewportReady?: boolean };
            }
          ).__testHooks;
          if (hooks?.viewportReady) return true;
          const container = document.getElementById('viewport');
          return !!container?.querySelector('canvas');
        },
        undefined,
        { timeout: 10_000 },
      );

      // Drive the camera to the target viewpoint via the test-hook
      // surface. We use page.evaluate with positional args so the call
      // captures the inputs without closing over Node-side references.
      await page.evaluate(
        ({ position, target }) => {
          const hooks = (window as unknown as { __testHooks?: ViewportHooks })
            .__testHooks;
          const vp = hooks?.viewport;
          if (!vp) throw new Error('viewport test hook missing');
          vp.camera.position.set(position[0], position[1], position[2]);
          vp.camera.up.set(0, 1, 0);
          vp.camera.lookAt(target[0], target[1], target[2]);
          vp.camera.updateProjectionMatrix();
          vp.camera.updateMatrixWorld();
          vp.controls.target.set(target[0], target[1], target[2]);
          vp.controls.update();
        },
        {
          position: angle.position as unknown as [number, number, number],
          target: angle.target as unknown as [number, number, number],
        },
      );

      // Advance one RAF tick post-camera-move so the viewport re-renders
      // and the axes overlay syncs to the new main-camera quaternion.
      await page.clock.runFor(100);

      await expect(page).toHaveScreenshot(angle.file, {
        maxDiffPixelRatio: 0.01,
        threshold: 0.15,
        animations: 'disabled',
        fullPage: false,
      });
    });
  }
});
