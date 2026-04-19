---
name: testing-3d
description: Test conventions for 3D code — Vitest tolerances, canonical mesh fixtures, STL SHA-256 snapshots, visual regression via Playwright, test-hook surface. Use whenever writing or reviewing tests for geometry, viewport, or E2E.
---

# testing-3d skill

## When to invoke

Writing or modifying tests under `tests/` — unit, integration, E2E, visual. Also: adding a new fixture, debugging a flaky visual test, setting up coverage.

## Locked decisions

- **Unit runner:** Vitest 3.x. No Jest, no Mocha.
- **E2E + visual:** Playwright (`@playwright/test`), Electron via `_electron.launch()`.
- **Custom matcher:** `toEqualWithTolerance(expected, { abs?, rel? })` registered in `tests/setup.ts` via `expect.extend`.
- **STL snapshot strategy:** canonicalise (sort triangles, re-derive normals, round floats to 1e-5 mm, little-endian binary), then SHA-256. Commit hex digest under `__snapshots__/*.sha256.txt`. Raw bytes are brittle.
- **Determinism engine:** `manifold-3d` is deterministic across platforms — this is what makes hash snapshots viable.

## Canonical fixtures

Under `tests/fixtures/meshes/`:

| File | Tri count | Known volume (mm³) | Use |
|---|---|---|---|
| `unit-cube.stl` | 12 | 1.0 | Primitive sanity; volume exactness |
| `unit-sphere-icos-3.stl` | 1280 | 4.188 (≈ 4/3 π) | Curved surfaces, genus-0 |
| `torus-32x16.stl` | 1024 | varies (document in fixture README) | Genus-1 topology |
| `mini-figurine.stl` | ≤ 50 000 | documented in fixture README | Real-world master |

Each fixture has a sibling `.json` with `{ triCount, volume_mm3, boundingBoxMin, boundingBoxMax, source, license }`.

## Writing a unit test

```ts
import { expect, test } from 'vitest';
import { loadFixture } from '@fixtures/meshes/loader';
import { meshVolume, offsetMesh } from '@/geometry';

test('offset expands unit cube correctly', async () => {
  const cube = await loadFixture('unit-cube');
  const shell = await offsetMesh(cube, 0.1);

  expect(await shell.isManifold()).toBe(true);
  expect(meshVolume(shell)).toBeCloseTo(1.728, 2); // 1.2^3
  expect(shell.boundingBox()).toEqualWithTolerance(
    { min: [-0.6, -0.6, -0.6], max: [0.6, 0.6, 0.6] },
    { abs: 1e-4 },
  );
});
```

## Writing an STL snapshot assertion

```ts
import { stlSha256 } from '@/geometry/canonical-stl';
import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('generated base part is byte-stable', async () => {
  const { basePart } = await generateMold(fixtures.miniFigurine, defaultParams);
  const hash = await stlSha256(basePart);

  const expected = readFileSync(
    join(__dirname, '__snapshots__/base-mini-figurine.sha256.txt'),
    'utf8',
  ).trim();
  expect(hash).toBe(expected);
});
```

Update snapshot via `vitest -u` after an intentional change. **Review the hash diff in the PR** — accidental changes are how regressions ship.

## Writing a visual test

```ts
import { test, expect } from '@playwright/test';

test('master loaded view', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.__testHooks.readyForInput);
  await loadFixture(page, 'mini-figurine');
  await page.evaluate(() => window.__testHooks.parseComplete.get('mini-figurine'));
  await expect(page).toHaveScreenshot('master-loaded.png', {
    maxDiffPixelRatio: 0.01,
    threshold: 0.15,
  });
});
```

## Determinism requirements

For any visual or hash-snapshot test:

- Chromium launched with `--use-gl=swiftshader --enable-unsafe-swiftshader`.
- Renderer `antialias: false`, `setPixelRatio(1)`.
- Fixed viewport `1280×800`.
- `page.clock.install()` to freeze `performance.now`.
- OrbitControls damping off (honour `NODE_ENV === 'test'`).
- No fonts in the canvas; use `TextGeometry` bakes with a committed font fixture if labels are needed.

## Visual-regression gating policy

- **Weeks 1–2 after first green CI run:** advisory only (`continue-on-error: true` in the workflow). Reports diffs but doesn't block merge.
- **Week 3 onward:** required, IF flake rate < 1 %. The `build-installer` job is always gated.

## Test-hook surface

Expose `window.__testHooks` **only** when `process.env.NODE_ENV === 'test'` at build time. Vite tree-shakes the guarded block. Verify in CI by grepping the prod bundle:

```sh
! grep -q '__testHooks' dist/renderer/index.*.js
```

## Anti-patterns

- `setTimeout` / `waitForTimeout` in E2E — always hook `window.__testHooks.X`.
- Snapshotting raw STL bytes (non-deterministic across platforms even with manifold-3d).
- Asserting on exact tri counts without tolerance (Boolean ops can add/remove a handful of degenerate triangles).
- Committing visual-regression *diff* or *actual* PNGs (only goldens; add to `.gitignore`).
- Running visual tests on the developer's machine's GPU and committing the goldens (not deterministic across GPUs — CI runners are the source of truth).
- Adding a 4th fixture without a `.json` spec file and a `source + license` field.

## Coverage

- **Geometry module (`src/geometry/**`)**: 70 % lines from day 1. Enforced in the `geometry-unit` CI job.
- UI modules: no enforced threshold at v1. Re-evaluate at v1.1.
