// tests/geometry/generateMold.test.ts
//
// Vitest coverage for the Wave-C surface-conforming shell generator
// (issue #72). Fixture tiers:
//
//   1. unit-cube           (analytic-bounds silicone-volume + exact
//                           resin identity + shell bounds)
//   2. unit-sphere-icos-3  (approximate-volume check, icosphere tolerance)
//   3. mini-figurine       (perf budget + positivity / sanity invariants)
//
// Plus an adapter round-trip + a print-shell watertight / bounds check +
// a generate-×3 leak check.
//
// Load-bearing invariants (issue #72 AC):
//   - `resinVolume_mm3 === masterVolume_mm3` at 1e-9 relative on every
//     fixture (carry-over from PR #70).
//   - `printShell` is watertight (`isManifold()` true, `genus() === 0`),
//     non-empty, top-trimmed at `master.max.y + silicone + 3 mm` and
//     bottom-trimmed at `master.min.y`, bounds contained within the
//     expanded AABB.

import { describe, expect, test } from 'vitest';
import { Matrix4 } from 'three';

import {
  bufferGeometryToManifold,
  generateSiliconeShell,
  initManifold,
  isManifold,
  loadStl,
  manifoldToBufferGeometry,
} from '@/geometry';
import type { MoldGenerationResult } from '@/geometry/generateMold';
import { DEFAULT_PARAMETERS, type MoldParameters } from '@/renderer/state/parameters';
import { fixtureExists, fixturePaths } from '@fixtures/meshes/loader';
import { readFileSync } from 'node:fs';

/** Test-only: parameter patch helper with all DEFAULT fields + overrides. */
function params(patch: Partial<MoldParameters>): MoldParameters {
  return { ...DEFAULT_PARAMETERS, ...patch };
}

/** Read a fixture STL as an `ArrayBuffer`, detached from Node's Buffer pool. */
function readFixtureBuffer(name: string): ArrayBuffer {
  const { stl } = fixturePaths(name);
  const buf = readFileSync(stl);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/**
 * Dispose every Manifold owned by a `MoldGenerationResult` — the silicone
 * body and the surface-conforming print shell. Extracted so each test's
 * `finally` block stays a one-liner and so adding a new result-bound
 * Manifold in the future is a one-site change.
 */
function disposeAll(result: MoldGenerationResult): void {
  result.silicone.delete();
  result.printShell.delete();
}

describe('generateSiliconeShell — unit-cube fixture', () => {
  test.skipIf(!fixtureExists('unit-cube'))(
    'computes silicone body + volumes for a 1×1×1 cube with 5 mm silicone',
    async () => {
      const { manifold } = await loadStl(readFixtureBuffer('unit-cube'));
      try {
        // Analytic silicone expectation — Minkowski-of-cube-by-ball:
        //   V(shell) = V(cube) + SA(cube)·r + perimeter·π·r²/4 + (4/3)·π·r³
        // For unit cube, r=5:
        //   V(cube)=1, SA=6, perimeter=12 → V(shell) ≈ 790.22 mm³
        // Silicone = shell − master = V(shell) − V(master) ≈ 789.22 mm³.
        const ANALYTIC_SHELL_VOL = 1 + 30 + 75 * Math.PI + (500 * Math.PI) / 3;
        const ANALYTIC_SILICONE_VOL = ANALYTIC_SHELL_VOL - 1;

        const p = params({ siliconeThickness_mm: 5 });
        const result = await generateSiliconeShell(
          manifold,
          p,
          new Matrix4(), // identity viewTransform
        );
        try {
          expect(isManifold(result.silicone)).toBe(true);

          // Silicone volume matches the Manifold's reported volume exactly.
          expect(result.silicone.volume()).toBeCloseTo(result.siliconeVolume_mm3, 3);

          // Silicone volume within ±15% of the analytic Minkowski-sum
          // prediction. The levelSet grid coarsens the Minkowski exactly —
          // bigger than analytic on the rounded-corner dilation side, so
          // we lose a little curvature mass in both directions.
          expect(result.siliconeVolume_mm3).toBeLessThan(ANALYTIC_SILICONE_VOL * 1.15);
          expect(result.siliconeVolume_mm3).toBeGreaterThan(ANALYTIC_SILICONE_VOL * 0.85);

          // Resin identity: the Wave-A pipeline defines resin as master
          // volume exactly. Pin at 1e-9 relative (carried forward from
          // issue #69 AC).
          const masterVol = manifold.volume();
          expect(result.resinVolume_mm3).toBeCloseTo(masterVol, 9);
          const relErr =
            Math.abs(result.resinVolume_mm3 - masterVol) / Math.abs(masterVol);
          expect(relErr).toBeLessThan(1e-9);
        } finally {
          disposeAll(result);
        }
      } finally {
        manifold.delete();
      }
    },
    30_000,
  );
});

describe('generateSiliconeShell — unit-sphere fixture', () => {
  test.skipIf(!fixtureExists('unit-sphere-icos-3'))(
    'computes silicone around an icosphere within 10% of the analytic prediction',
    async () => {
      const { manifold } = await loadStl(readFixtureBuffer('unit-sphere-icos-3'));
      try {
        // unit-sphere-icos-3 is a radius-1 icosphere (3 subdivisions).
        // Master vol ≈ (4/3)π ≈ 4.188 mm³.
        // For a 5 mm silicone layer: outer radius = 6; V(outer) =
        // (4/3)π·216 ≈ 904.78 mm³. Silicone ≈ 900.59 mm³.
        const rMaster = 1;
        const rOuter = rMaster + 5;
        const ANALYTIC_OUTER_VOL = (4 / 3) * Math.PI * rOuter ** 3;
        const MASTER_VOL = manifold.volume();
        const ANALYTIC_SILICONE_VOL = ANALYTIC_OUTER_VOL - MASTER_VOL;

        const p = params({ siliconeThickness_mm: 5 });
        const result = await generateSiliconeShell(manifold, p, new Matrix4());
        try {
          expect(isManifold(result.silicone)).toBe(true);

          // Silicone volume ≈ analytic within ±10% (icosphere approximation
          // + levelSet grid both contribute faceting error).
          expect(result.siliconeVolume_mm3).toBeLessThan(ANALYTIC_SILICONE_VOL * 1.1);
          expect(result.siliconeVolume_mm3).toBeGreaterThan(ANALYTIC_SILICONE_VOL * 0.9);

          // Resin identity at 1e-9 relative.
          expect(result.resinVolume_mm3).toBeCloseTo(MASTER_VOL, 9);
        } finally {
          disposeAll(result);
        }
      } finally {
        manifold.delete();
      }
    },
    30_000,
  );
});

describe('generateSiliconeShell — mini-figurine fixture', () => {
  test.skipIf(!fixtureExists('mini-figurine'))(
    'completes within budget and produces a manifold silicone with plausible volume',
    async () => {
      const { manifold } = await loadStl(readFixtureBuffer('mini-figurine'));
      try {
        const masterVol = manifold.volume();

        const t0 = performance.now();
        const result = await generateSiliconeShell(
          manifold,
          params({}), // defaults
          new Matrix4(), // identity; fixture bbox already sensible
        );
        const elapsed = performance.now() - t0;
        try {
          // Perf budget. Post-#74 (SDF cache across both levelSet passes
          // + far-field early-out + unified grid) the Wave C pipeline
          // costs roughly 30% less than the pre-#74 raw double-pass on
          // the mini-figurine. Observed wall-clocks:
          //
          //   - local warm-WASM Win:  ~1.5-2.5 s (pre-#74: ~2.5-3.5 s;
          //     raw vitest run: ~5-6 s, WASM cold on first invocation).
          //   - ubuntu CI (SwiftShader closure-heavy SDF loop):
          //     ~4-5 s (pre-#74: ~10 s). Meets issue #72's original
          //     5 s AC retroactively.
          //
          // 8 s bound = pre-#74 median CI wall-clock ÷ 1.25 + headroom
          // for CI-runner noise and WASM-cold first-call. Catches
          // ≥ 25% regressions against the new steady-state. Tighter
          // than the pre-#74 15 s ceiling per issue #74 AC "bring the
          // perf test bound down".
          //
          // Skipped entirely under V8 coverage instrumentation (coverage
          // slows the closure-heavy SDF hot loop ~7×).
          const worker = (
            globalThis as {
              __vitest_worker__?: { config?: { coverage?: { enabled?: boolean } } };
            }
          ).__vitest_worker__;
          const coverageEnabled = !!worker?.config?.coverage?.enabled;
          if (!coverageEnabled) {
            expect(elapsed).toBeLessThan(8_000);
          }

          expect(isManifold(result.silicone)).toBe(true);
          expect(isManifold(result.printShell)).toBe(true);

          // Silicone volume positive, finite, and a plausible fraction of
          // the master (5 mm silicone around ~1.2e5 mm³ figurine surface
          // should easily exceed 20% of master volume).
          expect(result.siliconeVolume_mm3).toBeGreaterThan(0);
          expect(Number.isFinite(result.siliconeVolume_mm3)).toBe(true);
          expect(result.siliconeVolume_mm3).toBeGreaterThan(masterVol * 0.2);

          // Print-shell volume strictly positive + finite.
          expect(result.printShellVolume_mm3).toBeGreaterThan(0);
          expect(Number.isFinite(result.printShellVolume_mm3)).toBe(true);

          // Resin identity: EXACTLY master volume at 1e-9 relative.
          expect(result.resinVolume_mm3).toBeCloseTo(masterVol, 9);
          const relErr =
            Math.abs(result.resinVolume_mm3 - masterVol) / Math.abs(masterVol);
          expect(relErr).toBeLessThan(1e-9);
        } finally {
          disposeAll(result);
        }
      } finally {
        manifold.delete();
      }
    },
    // 60 s test timeout (NOT the perf budget — that's the 8 s assertion
    // above, and it's skipped under coverage instrumentation). Coverage
    // slows the closure-heavy SDF hot loop ~7×, so the pre-#74 30 s
    // timeout fired under `pnpm vitest run --coverage` even though the
    // perf assertion was already guarded. The generous ceiling keeps
    // coverage runs green without weakening the 8 s perf guard.
    60_000,
  );
});

describe('generateSiliconeShell — integration with adapter', () => {
  test('output silicone round-trips through manifoldToBufferGeometry', async () => {
    // Hand-built master: a 4×4×4 mm cube at origin — no fixture dependency,
    // so this test runs in the default suite even on a fresh clone.
    const toplevel = await initManifold();
    const master = toplevel.Manifold.cube([4, 4, 4], true);
    try {
      const result = await generateSiliconeShell(
        master,
        params({ siliconeThickness_mm: 5 }),
        new Matrix4(),
      );
      try {
        const bg = await manifoldToBufferGeometry(result.silicone);
        try {
          expect(bg.getAttribute('position').count).toBeGreaterThan(0);
          expect(bg.getAttribute('normal')).toBeDefined();

          // And re-ingest to make sure the geometry we produce survives
          // a full adapter round-trip (volume preserved within kernel
          // noise).
          const reingested = await bufferGeometryToManifold(bg);
          try {
            expect(isManifold(reingested)).toBe(true);
            const v0 = result.silicone.volume();
            const v1 = reingested.volume();
            expect(Math.abs(v1 - v0) / v0).toBeLessThan(0.001);
          } finally {
            reingested.delete();
          }
        } finally {
          bg.dispose();
        }
      } finally {
        disposeAll(result);
      }
    } finally {
      master.delete();
    }
  }, 30_000);
});

describe('generateSiliconeShell — print-shell invariants (Wave C)', () => {
  // Watertight + bounds + trim-plane invariants for the surface-conforming
  // print shell. Cube master keeps the analytic bounds tight and is small
  // enough to run under every default suite.
  test('printShell is watertight genus-0 with correct top/bottom trims', async () => {
    const toplevel = await initManifold();
    const SIDE = 4;
    const SILICONE = 5;
    const SHELL = 3;
    const POUR_EDGE = 3; // matches PRINT_SHELL_POUR_EDGE_MM
    const master = toplevel.Manifold.cube([SIDE, SIDE, SIDE], true);
    try {
      const result = await generateSiliconeShell(
        master,
        params({ siliconeThickness_mm: SILICONE, printShellThickness_mm: SHELL }),
        new Matrix4(),
      );
      try {
        // Watertight + genus-0. The iso-surface from a single-piece
        // levelSet followed by a difference + two plane trims must be
        // a valid solid ball (the shell is a bowl topology, genus 0).
        expect(isManifold(result.printShell)).toBe(true);
        expect(result.printShell.genus()).toBe(0);
        expect(result.printShell.isEmpty()).toBe(false);

        // Master bounds: [-SIDE/2, SIDE/2]³. Expected shell bounds:
        //   top.y   = master.max.y + SILICONE + POUR_EDGE = 2 + 5 + 3 = 10
        //   bot.y   = master.min.y                         = -2
        //   XZ side = master ± (SILICONE + SHELL) = [-10, 10]
        //
        // Allow `2 × edgeLength` slack on XZ because the BCC marching-
        // tetrahedra iso-surface rounds corners outward by up to one
        // grid cell, and for small cube fixtures the padded `shellBounds`
        // also rounds to the next grid step — two sources of +edgeLength
        // shift that add near corners. Y cuts stay tight because they
        // come from explicit `trimByPlane` (kernel precision).
        const bb = result.printShell.boundingBox();
        const edgeLength = 2.0;

        expect(bb.max[1]).toBeCloseTo(2 + SILICONE + POUR_EDGE, 3);
        expect(bb.min[1]).toBeCloseTo(-2, 3);

        const xzMax = 2 + SILICONE + SHELL;
        expect(bb.max[0]).toBeLessThanOrEqual(xzMax + 2 * edgeLength);
        expect(bb.min[0]).toBeGreaterThanOrEqual(-(xzMax + 2 * edgeLength));
        expect(bb.max[2]).toBeLessThanOrEqual(xzMax + 2 * edgeLength);
        expect(bb.min[2]).toBeGreaterThanOrEqual(-(xzMax + 2 * edgeLength));

        // Volume matches the Manifold.volume() exactly.
        expect(result.printShell.volume()).toBeCloseTo(result.printShellVolume_mm3, 3);
        expect(result.printShellVolume_mm3).toBeGreaterThan(0);
      } finally {
        disposeAll(result);
      }
    } finally {
      master.delete();
    }
  }, 30_000);

  test('printShell top + bottom trims respect offset viewTransform', async () => {
    // Apply a +15 mm translation on Y; the trim planes should move with
    // the transformed master. Use an identity rotation so the +Y axis in
    // the master frame coincides with +Y in world frame — if we rotated,
    // the trim planes (which are world-frame, per the generator) would
    // not track the master's up axis.
    const toplevel = await initManifold();
    const master = toplevel.Manifold.cube([4, 4, 4], true);
    try {
      const TRANSLATE_Y = 15;
      const result = await generateSiliconeShell(
        master,
        params({ siliconeThickness_mm: 5, printShellThickness_mm: 3 }),
        new Matrix4().makeTranslation(0, TRANSLATE_Y, 0),
      );
      try {
        const bb = result.printShell.boundingBox();
        // Master (post-transform) bounds y ∈ [13, 17]. Shell top = 17 + 5 + 3 = 25; bottom = 13.
        expect(bb.max[1]).toBeCloseTo(17 + 5 + 3, 3);
        expect(bb.min[1]).toBeCloseTo(13, 3);
      } finally {
        disposeAll(result);
      }
    } finally {
      master.delete();
    }
  }, 30_000);
});

describe('generateSiliconeShell — validation', () => {
  test('rejects silicone thickness below the 1 mm hard floor', async () => {
    const toplevel = await initManifold();
    const master = toplevel.Manifold.cube([1, 1, 1], true);
    try {
      await expect(
        generateSiliconeShell(
          master,
          params({ siliconeThickness_mm: 0.5 }),
          new Matrix4(),
        ),
      ).rejects.toThrow(/siliconeThickness_mm=0\.5/);
    } finally {
      master.delete();
    }
  });

  test('rejects sideCount outside {2, 3, 4} before Manifold allocation', async () => {
    const toplevel = await initManifold();
    const master = toplevel.Manifold.cube([1, 1, 1], true);
    try {
      const bad = {
        ...DEFAULT_PARAMETERS,
        sideCount: 5 as unknown as 2 | 3 | 4,
      };
      await expect(generateSiliconeShell(master, bad, new Matrix4())).rejects.toThrow(
        /sideCount=5/,
      );
      try {
        await generateSiliconeShell(master, bad, new Matrix4());
        throw new Error('expected generateSiliconeShell to reject');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).name).toBe('InvalidParametersError');
      }
    } finally {
      master.delete();
    }
  });

  test('rejects non-positive printShellThickness before Manifold allocation', async () => {
    const toplevel = await initManifold();
    const master = toplevel.Manifold.cube([1, 1, 1], true);
    try {
      await expect(
        generateSiliconeShell(
          master,
          params({ printShellThickness_mm: 0 }),
          new Matrix4(),
        ),
      ).rejects.toThrow(/printShellThickness_mm=0/);
    } finally {
      master.delete();
    }
  });

  test('applies viewTransform before building the silicone body', async () => {
    // Master is a 2×10×2 mm bar (Y extent 10). With the identity transform
    // the bar stands upright. When rotated 90° about X, the bar lies flat
    // along Z. Both pipelines should still produce a valid silicone body;
    // we assert manifoldness on both to catch a silent transform-skip.
    const toplevel = await initManifold();
    const bar = toplevel.Manifold.cube([2, 10, 2], true);
    try {
      const upright = await generateSiliconeShell(
        bar,
        params({ siliconeThickness_mm: 5 }),
        new Matrix4(),
      );
      const rotated = await generateSiliconeShell(
        bar,
        params({ siliconeThickness_mm: 5 }),
        new Matrix4().makeRotationX(Math.PI / 2),
      );
      try {
        expect(isManifold(upright.silicone)).toBe(true);
        expect(isManifold(rotated.silicone)).toBe(true);
      } finally {
        disposeAll(upright);
        disposeAll(rotated);
      }
    } finally {
      bar.delete();
    }
  }, 30_000);
});

describe('generateSiliconeShell — Generate×3 leak check', () => {
  // We can't read manifold-3d's internal handle count from the JS side,
  // but a proxy invariant is "three successive runs return the same
  // volumes within kernel noise". If any Manifold were retained across
  // runs, the kernel's handle table would grow and downstream CSG would
  // either slow or produce different numbers.
  test('generate×3 does not leak: repeated runs produce consistent volume', async () => {
    const toplevel = await initManifold();
    const master = toplevel.Manifold.cube([4, 4, 4], true);
    try {
      const runParams = params({ siliconeThickness_mm: 5 });
      const volumes: Array<{
        silicone: number;
        resin: number;
        printShell: number;
      }> = [];
      for (let i = 0; i < 3; i++) {
        const r = await generateSiliconeShell(master, runParams, new Matrix4());
        volumes.push({
          silicone: r.siliconeVolume_mm3,
          resin: r.resinVolume_mm3,
          printShell: r.printShellVolume_mm3,
        });
        disposeAll(r);
      }
      // All three runs agree within 1e-3 relative on every volume.
      for (let i = 1; i < 3; i++) {
        expect(volumes[i]!.silicone).toBeCloseTo(volumes[0]!.silicone, 3);
        expect(volumes[i]!.resin).toBeCloseTo(volumes[0]!.resin, 3);
        expect(volumes[i]!.printShell).toBeCloseTo(volumes[0]!.printShell, 3);
      }
    } finally {
      master.delete();
    }
  }, 60_000);
});
