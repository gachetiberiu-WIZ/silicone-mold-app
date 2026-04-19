// tests/visual/empty-scene.spec.ts
//
// Baseline visual-regression test. Renders an empty WebGL canvas with a
// deterministic clear-colour and takes a golden screenshot. Exists so the
// visual-regression CI job has *something* to diff against from day 1.
//
// No app renderer is wired yet — this spec runs its own `new WebGL2
// RenderingContext` dance via an inline HTML data URL, so it's decoupled
// from `src/` entirely. When the real app ships, we'll add additional
// specs that launch the Vite dev server and snapshot app views.

import { expect, test } from '@playwright/test';

const EMPTY_SCENE_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { margin: 0; padding: 0; background: #101418; }
      canvas { display: block; width: 1280px; height: 800px; }
    </style>
  </head>
  <body>
    <canvas id="c" width="1280" height="800"></canvas>
    <script>
      // Deterministic clear — no animation, no RAF loop. A single paint.
      const canvas = document.getElementById('c');
      const gl =
        canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true }) ||
        canvas.getContext('webgl', { antialias: false, preserveDrawingBuffer: true });
      if (gl) {
        gl.clearColor(0.063, 0.078, 0.094, 1.0); // #101418
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.finish();
      }
      window.__empty_scene_ready = true;
    </script>
  </body>
</html>`;

test.describe('visual — empty scene', () => {
  test('renders the baseline empty WebGL canvas', async ({ page }) => {
    // Freeze `performance.now` / Date — keeps SwiftShader output reproducible
    // across runs even though we're not animating. Cheap insurance.
    await page.clock.install({ time: new Date('2026-04-18T00:00:00Z') });

    await page.setContent(EMPTY_SCENE_HTML);
    await page.waitForFunction(() => (window as unknown as { __empty_scene_ready?: boolean }).__empty_scene_ready === true);

    // Whole-page screenshot at 1280×800 — project config pins viewport + DPR.
    await expect(page).toHaveScreenshot('empty-scene.png', {
      maxDiffPixelRatio: 0.01,
      threshold: 0.15,
      animations: 'disabled',
      fullPage: false,
    });
  });
});
