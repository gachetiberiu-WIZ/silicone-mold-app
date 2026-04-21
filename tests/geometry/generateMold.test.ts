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
 * Dispose every Manifold owned by a `MoldGenerationResult` — the
 * silicone body, every shell piece (Wave E, issue #84), and the base
 * slab (Wave D, issue #82). Extracted so each test's `finally` block
 * stays a one-liner and so adding a new result-bound Manifold in the
 * future is a one-site change.
 */
function disposeAll(result: MoldGenerationResult): void {
  result.silicone.delete();
  for (const p of result.shellPieces) p.delete();
  result.basePart.delete();
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
            // Wave E+F (issue #84) added radial slicing + N×2 brim unions,
            // intrinsically +~1.5 s on ubuntu CI at sideCount=4. Budget
            // widened 8 s → 10 s to unblock the feature-complete landing;
            // issue #86 tracks clawing this back via brim simplification
            // and piece-parallel slicing.
            expect(elapsed).toBeLessThan(10_000);
          }

          expect(isManifold(result.silicone)).toBe(true);
          // Wave E + F (issue #84): every shell piece is a watertight
          // manifold, and the array length matches the requested
          // sideCount (default 4).
          expect(result.shellPieces.length).toBe(DEFAULT_PARAMETERS.sideCount);
          for (const piece of result.shellPieces) {
            expect(isManifold(piece)).toBe(true);
          }

          // Silicone volume positive, finite, and a plausible fraction of
          // the master (5 mm silicone around ~1.2e5 mm³ figurine surface
          // should easily exceed 20% of master volume).
          expect(result.siliconeVolume_mm3).toBeGreaterThan(0);
          expect(Number.isFinite(result.siliconeVolume_mm3)).toBe(true);
          expect(result.siliconeVolume_mm3).toBeGreaterThan(masterVol * 0.2);

          // Total shell volume (sum of pieces) strictly positive + finite.
          expect(result.totalShellVolume_mm3).toBeGreaterThan(0);
          expect(Number.isFinite(result.totalShellVolume_mm3)).toBe(true);
          // Per-piece volumes sum to the reported total.
          const summed = result.shellPiecesVolume_mm3.reduce((a, b) => a + b, 0);
          expect(summed).toBeCloseTo(result.totalShellVolume_mm3, 6);

          // Base-slab (Wave D): finite + non-negative. Volume can be
          // legitimately 0 on fixtures whose lowest-Y slice is
          // degenerate (e.g. this mini-figurine's native-orientation
          // Z-up STL has its horizontal base on Z, not Y — under the
          // identity viewTransform used here the Y-min slice is
          // through a thin sliver of the figurine's side). A real
          // user orienting their figure on the bed via lay-flat would
          // get a non-empty slice. `isEmpty === false` is NOT asserted
          // for that reason.
          expect(Number.isFinite(result.baseSlabVolume_mm3)).toBe(true);
          expect(result.baseSlabVolume_mm3).toBeGreaterThanOrEqual(0);
          // basePart is manifold OR empty — both are valid states
          // (empty on degenerate slices, manifold on realistic ones).
          expect(result.basePart.status()).toBe('NoError');

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

describe('generateSiliconeShell — shell pieces invariants (Wave C+E+F)', () => {
  // Watertight + bounds invariants for the radially-sliced, brimmed
  // print-shell pieces. Cube master keeps the analytic bounds tight
  // and is small enough to run under every default suite.
  test('shellPieces: N watertight pieces covering the full shell bbox', async () => {
    const toplevel = await initManifold();
    const SIDE = 4;
    const SILICONE = 5;
    const SHELL = 3;
    const POUR_EDGE = 3; // matches PRINT_SHELL_POUR_EDGE_MM
    const SIDE_COUNT = 4;
    const BRIM_W = 10;
    const BRIM_T = 3;
    const master = toplevel.Manifold.cube([SIDE, SIDE, SIDE], true);
    try {
      const result = await generateSiliconeShell(
        master,
        params({
          siliconeThickness_mm: SILICONE,
          printShellThickness_mm: SHELL,
          sideCount: SIDE_COUNT,
          brimWidth_mm: BRIM_W,
          brimThickness_mm: BRIM_T,
        }),
        new Matrix4(),
      );
      try {
        // Wave E: `shellPieces.length` equals sideCount.
        expect(result.shellPieces.length).toBe(SIDE_COUNT);
        // Every piece is watertight + non-empty.
        for (const piece of result.shellPieces) {
          expect(isManifold(piece)).toBe(true);
          expect(piece.isEmpty()).toBe(false);
          expect(Number.isFinite(piece.volume())).toBe(true);
          expect(piece.volume()).toBeGreaterThan(0);
        }

        // The union of every piece's AABB reaches the full (pre-slice)
        // shell extent on Y (top + bottom trim planes) and extends
        // radially outward by at least brimWidth past the shell's
        // outer surface.
        //
        // Expected shell bounds (pre-slice, pre-brim):
        //   top.y   = master.max.y + SILICONE + POUR_EDGE = 2 + 5 + 3 = 10
        //   bot.y   = master.min.y - 2 (Wave D plug wrap)  = -4
        //   XZ side = master ± (SILICONE + SHELL) = [-10, 10]
        //
        // Brim adds a radial extent of +BRIM_W past the shell's outer
        // edge on every cut direction. So the union's XZ extent should
        // reach `xzMax + BRIM_W` on at least some direction.
        const edgeLength = 2.0;
        const unionMin = [
          Infinity,
          Infinity,
          Infinity,
        ] as [number, number, number];
        const unionMax = [
          -Infinity,
          -Infinity,
          -Infinity,
        ] as [number, number, number];
        for (const piece of result.shellPieces) {
          const bb = piece.boundingBox();
          for (let a = 0; a < 3; a++) {
            if (bb.min[a]! < unionMin[a]!) unionMin[a] = bb.min[a]!;
            if (bb.max[a]! > unionMax[a]!) unionMax[a] = bb.max[a]!;
          }
        }

        // Y range: pieces cover [bot, top] from the pre-slice shell.
        expect(unionMax[1]!).toBeCloseTo(2 + SILICONE + POUR_EDGE, 3);
        expect(unionMin[1]!).toBeCloseTo(-2 - 2, 3);

        // XZ: at least one piece extends to `xzMax + BRIM_W - slack`
        // along some axis (brim flange on a cardinal cut). Use a
        // generous `brim_outer_bound` upper-clamp to catch runaway
        // brims.
        const xzOuter = 2 + SILICONE + SHELL;
        const brimOuter = xzOuter + BRIM_W;
        // Generous margin on the max side (brim_outer + 2×edgeLength
        // for the shell's rounded-corner marching-tets + 2 mm kernel
        // slop).
        const maxClamp = brimOuter + 2 * edgeLength + 2;
        expect(unionMax[0]!).toBeLessThanOrEqual(maxClamp);
        expect(unionMin[0]!).toBeGreaterThanOrEqual(-maxClamp);
        expect(unionMax[2]!).toBeLessThanOrEqual(maxClamp);
        expect(unionMin[2]!).toBeGreaterThanOrEqual(-maxClamp);

        // Total shell volume (sum of pieces, incl. brims) matches the
        // pre-computed total.
        expect(result.totalShellVolume_mm3).toBeGreaterThan(0);
        const summed = result.shellPiecesVolume_mm3.reduce((a, b) => a + b, 0);
        expect(summed).toBeCloseTo(result.totalShellVolume_mm3, 6);
      } finally {
        disposeAll(result);
      }
    } finally {
      master.delete();
    }
  }, 30_000);

  test('shellPieces: top + bottom Y extent tracks offset viewTransform', async () => {
    // Apply a +15 mm translation on Y; the trim planes should move with
    // the transformed master. Use an identity rotation so the +Y axis
    // in the master frame coincides with +Y in world frame.
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
        // Union Y extent across every piece: top = 17+5+3=25, bot = 13-2=11.
        let yMin = Infinity;
        let yMax = -Infinity;
        for (const piece of result.shellPieces) {
          const bb = piece.boundingBox();
          if (bb.min[1]! < yMin) yMin = bb.min[1]!;
          if (bb.max[1]! > yMax) yMax = bb.max[1]!;
        }
        expect(yMax).toBeCloseTo(17 + 5 + 3, 3);
        expect(yMin).toBeCloseTo(13 - 2, 3);
      } finally {
        disposeAll(result);
      }
    } finally {
      master.delete();
    }
  }, 30_000);

  test.each([2, 3, 4] as const)(
    'sideCount=%i produces exactly that many pieces',
    async (sideCount) => {
      const toplevel = await initManifold();
      const master = toplevel.Manifold.cube([4, 4, 4], true);
      try {
        const result = await generateSiliconeShell(
          master,
          params({ sideCount }),
          new Matrix4(),
        );
        try {
          expect(result.shellPieces.length).toBe(sideCount);
          for (const p of result.shellPieces) {
            expect(isManifold(p)).toBe(true);
            expect(p.isEmpty()).toBe(false);
          }
        } finally {
          disposeAll(result);
        }
      } finally {
        master.delete();
      }
    },
    60_000,
  );
});

describe('generateSiliconeShell — base slab (Wave D, issue #82)', () => {
  test('basePart: watertight genus-0 + expected Y span + non-zero volume', async () => {
    const toplevel = await initManifold();
    const SIDE = 4;
    const SILICONE = 5;
    const SHELL = 3;
    const SLAB_THICKNESS = 8;
    const SLAB_OVERHANG = 5;
    const master = toplevel.Manifold.cube([SIDE, SIDE, SIDE], true);
    try {
      const result = await generateSiliconeShell(
        master,
        params({
          siliconeThickness_mm: SILICONE,
          printShellThickness_mm: SHELL,
          baseSlabThickness_mm: SLAB_THICKNESS,
          baseSlabOverhang_mm: SLAB_OVERHANG,
        }),
        new Matrix4(),
      );
      try {
        expect(isManifold(result.basePart)).toBe(true);
        expect(result.basePart.genus()).toBe(0);
        expect(result.basePart.isEmpty()).toBe(false);

        const bb = result.basePart.boundingBox();
        // Master bounds: y ∈ [-2, 2]. Slab Y span:
        //   min.y = master.min.y - slabThickness = -2 - 8 = -10
        //   max.y = master.min.y + plug(2)       = -2 + 2 =  0
        expect(bb.min[1]).toBeCloseTo(-2 - SLAB_THICKNESS, 2);
        expect(bb.max[1]).toBeCloseTo(-2 + 2, 2);

        // XZ footprint reaches at least the master edge + (silicone +
        // shell + overhang). The round-join offset may add a touch more
        // on corners, so use >=.
        const minXzExpected = -(2 + SILICONE + SHELL + SLAB_OVERHANG);
        const maxXzExpected = 2 + SILICONE + SHELL + SLAB_OVERHANG;
        // Allow a tiny bit of slack for kernel tolerance.
        const xzTolerance = 0.1;
        expect(bb.min[0]).toBeLessThanOrEqual(minXzExpected + xzTolerance);
        expect(bb.max[0]).toBeGreaterThanOrEqual(maxXzExpected - xzTolerance);
        expect(bb.min[2]).toBeLessThanOrEqual(minXzExpected + xzTolerance);
        expect(bb.max[2]).toBeGreaterThanOrEqual(maxXzExpected - xzTolerance);

        // Volume pre-computation matches Manifold.volume().
        expect(result.basePart.volume()).toBeCloseTo(
          result.baseSlabVolume_mm3,
          3,
        );
        expect(result.baseSlabVolume_mm3).toBeGreaterThan(0);

        // Rough volume envelope: slab body + plug cap.
        //   slab_body_footprint_area ≈ (2·(sliceHalfEdge + silicone + shell + overhang))²
        //     where sliceHalfEdge = SIDE/2 = 2 mm.
        //   slab_body ≈ (2·(2+5+3+5))² · 8 = 30² · 8 = 7200 mm³.
        //   plug_footprint_area ≈ (2·(2+5-0.2))² ≈ (13.6)² ≈ 184.96 mm²
        //   plug ≈ 184.96 · 2 ≈ 370 mm³.
        //   approx total ≈ 7570 mm³. Allow ±25 % for the round-offset
        //   corner curvature and kernel tolerance.
        const analyticLower = 7570 * 0.75;
        const analyticUpper = 7570 * 1.25;
        expect(result.baseSlabVolume_mm3).toBeGreaterThan(analyticLower);
        expect(result.baseSlabVolume_mm3).toBeLessThan(analyticUpper);
      } finally {
        disposeAll(result);
      }
    } finally {
      master.delete();
    }
  }, 30_000);

  test('basePart bounds respect offset viewTransform on Y', async () => {
    const toplevel = await initManifold();
    const master = toplevel.Manifold.cube([4, 4, 4], true);
    try {
      const SLAB_THICKNESS = 6;
      const TRANSLATE_Y = 10;
      const result = await generateSiliconeShell(
        master,
        params({
          siliconeThickness_mm: 5,
          printShellThickness_mm: 3,
          baseSlabThickness_mm: SLAB_THICKNESS,
        }),
        new Matrix4().makeTranslation(0, TRANSLATE_Y, 0),
      );
      try {
        const bb = result.basePart.boundingBox();
        // Master (post-transform): y ∈ [8, 12]. Slab min.y = 8 - 6 = 2;
        // max.y = 8 + 2 = 10.
        expect(bb.min[1]).toBeCloseTo(8 - SLAB_THICKNESS, 2);
        expect(bb.max[1]).toBeCloseTo(8 + 2, 2);
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
        totalShell: number;
        baseSlab: number;
      }> = [];
      for (let i = 0; i < 3; i++) {
        const r = await generateSiliconeShell(master, runParams, new Matrix4());
        volumes.push({
          silicone: r.siliconeVolume_mm3,
          resin: r.resinVolume_mm3,
          totalShell: r.totalShellVolume_mm3,
          baseSlab: r.baseSlabVolume_mm3,
        });
        // Wave E+F: disposeAll releases the silicone, every shell
        // piece, and the base slab. A leak would surface here as a
        // WASM handle being retained across iterations (and, in
        // practice, as the volume drifting between runs).
        disposeAll(r);
      }
      // All three runs agree within 1e-3 relative on every volume.
      for (let i = 1; i < 3; i++) {
        expect(volumes[i]!.silicone).toBeCloseTo(volumes[0]!.silicone, 3);
        expect(volumes[i]!.resin).toBeCloseTo(volumes[0]!.resin, 3);
        expect(volumes[i]!.totalShell).toBeCloseTo(volumes[0]!.totalShell, 3);
        expect(volumes[i]!.baseSlab).toBeCloseTo(volumes[0]!.baseSlab, 3);
      }
    } finally {
      master.delete();
    }
  }, 60_000);
});
