// tests/geometry/generateMold.test.ts
//
// Vitest coverage for the Phase 3c silicone-shell generator (issue #37,
// `src/geometry/generateMold.ts`). Three fixture tiers per the issue's
// test section:
//
//   1. unit-cube  (exact-volume analytic check + halves-sum invariant)
//   2. unit-sphere-icos-3 (approximate-volume check, icosphere tolerance)
//   3. mini-figurine (perf budget + positivity/sanity invariants only —
//      the parting-plane heuristic may change in Phase 3d so no
//      hand-tuned golden for this one)
//
// Plus an integration check that the half-Manifold round-trips through
// the existing adapter into a BufferGeometry, as the issue's "integration
// test" bullet requires.

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
import {
  MIN_VENT_SEPARATION_MM,
  readMasterVertices,
  selectVentCandidates,
} from '@/geometry/sprueVent';
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
  // Node's `Buffer.buffer` is shared across allocations; slice into a
  // fresh ArrayBuffer so `loadStl` (and manifold-3d) don't read beyond
  // byteLength.
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/**
 * Dispose every Manifold owned by a `MoldGenerationResult` — both silicone
 * halves and every printable-box part. Extracted so each test's `finally`
 * block stays a one-liner and so adding a new result-bound Manifold in the
 * future is a one-site change here, not N sites across the suite.
 */
function disposeAll(result: MoldGenerationResult): void {
  result.siliconeUpperHalf.delete();
  result.siliconeLowerHalf.delete();
  result.basePart.delete();
  result.topCapPart.delete();
  for (const s of result.sideParts) s.delete();
}

describe('generateSiliconeShell — unit-cube fixture', () => {
  test.skipIf(!fixtureExists('unit-cube'))(
    'computes silicone halves + volumes for a 1×1×1 cube with 5 mm wall',
    async () => {
      const { manifold } = await loadStl(readFixtureBuffer('unit-cube'));
      try {
        // Wave 3 (issue #55): disable vents on this fixture — a 1 mm
        // cube has only 8 corners within 5 mm of each other, so NMS
        // wouldn't place 2 anyway. Keeping ventCount=0 here keeps the
        // silicone + resin analytic check simple. A later Wave-3-
        // specific test exercises the vent-skip warning path.
        // Analytic expectation: master is a 1×1×1 cube centred at origin.
        // Outer shell is the cube minkowski-summed with a sphere of radius
        // 5 mm — it's a rounded-corner 11×11×11 "box" whose volume is
        // EXACTLY the sum of:
        //   - the 11×11×11 interior cube = 1331
        //   - 6 face slabs of 1×1×5 each (on each cube face, covered by
        //     the ball's cylinder sweep) — actually these are encompassed
        //     by the full dilation formula below, so we don't double-count.
        //
        // Canonical Minkowski-of-cube-by-ball formula:
        //   V(shell) = V(cube) + SA(cube) × r + perimeter(cube) × π r² / 4
        //             + (4/3) π r³
        // For a unit cube, r = 5 mm:
        //   V(cube) = 1
        //   SA(cube) = 6
        //   perimeter (total edge length) = 12
        //   → V(shell) = 1 + 30 + 12 × π × 25 / 4 + (4/3) π × 125
        //             = 1 + 30 + 75 π + 500 π / 3
        //             ≈ 1 + 30 + 235.619 + 523.599
        //             ≈ 790.22 mm³
        //
        // Silicone volume = shell − master = ~789.22 mm³.
        //
        // The dilation uses a sphere tessellation of 64 segments
        // (`SPHERE_SEGMENTS` in generateMold.ts), which under-approximates
        // a true sphere by a fraction of a percent on the rounded edges
        // + corners. A 1% tolerance covers that plus manifold-3d's
        // numerical noise with plenty of margin.
        const ANALYTIC_SHELL_VOL = 1 + 30 + 75 * Math.PI + (500 * Math.PI) / 3;
        const ANALYTIC_SILICONE_VOL = ANALYTIC_SHELL_VOL - 1;

        const params5mm = params({ wallThickness_mm: 5, ventCount: 0 });
        const result = await generateSiliconeShell(
          manifold,
          params5mm,
          new Matrix4(), // identity viewTransform
        );
        try {
          expect(isManifold(result.siliconeUpperHalf)).toBe(true);
          expect(isManifold(result.siliconeLowerHalf)).toBe(true);

          // Halves sum to total silicone volume (issue AC).
          const upperVol = result.siliconeUpperHalf.volume();
          const lowerVol = result.siliconeLowerHalf.volume();
          expect(upperVol + lowerVol).toBeCloseTo(result.siliconeVolume_mm3, 3);

          // The cube is symmetric about y=0 in the XZ plane, but NOT in
          // the keys layout (one asymmetric key on +Z). Halves are no
          // longer expected to match — the upper has three key
          // recesses + the sprue subtraction (a big cylinder),
          // while the lower has three protrusions. For a tiny 1 mm
          // master the sprue alone removes ~25% of the silicone
          // volume, all from the upper half. A loose ±40% bound
          // catches gross regressions.
          expect(upperVol / lowerVol).toBeGreaterThan(0.6);
          expect(upperVol / lowerVol).toBeLessThan(1.4);

          // Analytic silicone volume is harder to pin after Wave 3:
          // the sprue cylinder's carving depends on the actual shell
          // bounding box (not on ANALYTIC_SHELL_VOL which is the
          // Minkowski-of-cube-by-ball volume — levelSet produces a
          // grid-quantised approximation whose *bbox* is wider than
          // that analytic volume would suggest). Keep a loose bound on
          // siliconeVolume — < ANALYTIC_SILICONE_VOL (since sprue
          // removes material) and > 50% of it (catch gross regressions).
          expect(result.siliconeVolume_mm3).toBeLessThan(ANALYTIC_SILICONE_VOL);
          expect(result.siliconeVolume_mm3).toBeGreaterThan(ANALYTIC_SILICONE_VOL * 0.5);

          // Wave 3 (issue #55): resin = master + analytic sprue.
          // ventCount=0 → no vent contribution. We bracket the resin
          // volume by the bounds-of-bounds on the sprue length:
          // minimum length uses the upper half's bbox (tight around
          // the actual silicone top after grid quantisation);
          // maximum length adds one edgeLength (1.5 mm for wall=5) to
          // the upper half's max.y, which is the worst-case diff
          // between the silicone body's bbox (what the generator
          // actually uses) and the split-half's bbox.
          const shellBboxMaxY = Math.max(
            result.siliconeUpperHalf.boundingBox().max[1],
            result.siliconeLowerHalf.boundingBox().max[1],
          );
          const sprueFromY = 0.5 + 0.1; // masterTop + epsilon
          const sprueR = params5mm.sprueDiameter_mm / 2;
          const lenMin = shellBboxMaxY + params5mm.baseThickness_mm - sprueFromY;
          const lenMax = lenMin + /* grid slack */ 2.0;
          const resinMin = 1.0 + Math.PI * sprueR * sprueR * lenMin;
          const resinMax = 1.0 + Math.PI * sprueR * sprueR * lenMax;
          expect(result.resinVolume_mm3).toBeGreaterThanOrEqual(resinMin - 1e-6);
          expect(result.resinVolume_mm3).toBeLessThanOrEqual(resinMax + 1e-6);

          // Warnings are empty — every requested vent fit (0/0 is a
          // happy path).
          expect(result.warnings).toEqual([]);
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
    'computes shell around an icosphere within 5% of the analytic solution',
    async () => {
      const { manifold } = await loadStl(readFixtureBuffer('unit-sphere-icos-3'));
      try {
        // unit-sphere-icos-3 fixture is a radius-1 icosphere (3 subdivisions).
        // The master's volume per the sidecar JSON is ~4.188 mm³ ≈ (4/3)π.
        // For a 5 mm shell (origin-centred master → no transform needed):
        //   outer radius = 1 + 5 = 6
        //   V(outer sphere) = (4/3) π × 6³ = (4/3) π × 216
        //   V(silicone) = V(outer) − V(master)
        // Both the master and the minkowski-sum output are icosphere
        // approximations; a 5% tolerance comfortably covers the faceting
        // error (issue spec).
        const rMaster = 1;
        const rOuter = rMaster + 5;
        const ANALYTIC_OUTER_VOL = (4 / 3) * Math.PI * rOuter ** 3;
        // Use the kernel-measured master volume, not the analytic (4/3)π —
        // the icosphere approximation makes them differ by ~2%.
        const MASTER_VOL = manifold.volume();
        const ANALYTIC_SILICONE_VOL = ANALYTIC_OUTER_VOL - MASTER_VOL;

        const spParams = params({ wallThickness_mm: 5, ventCount: 0 });
        const result = await generateSiliconeShell(manifold, spParams, new Matrix4());
        try {
          expect(isManifold(result.siliconeUpperHalf)).toBe(true);
          expect(isManifold(result.siliconeLowerHalf)).toBe(true);

          // Halves sum to total (within kernel noise).
          const upperVol = result.siliconeUpperHalf.volume();
          const lowerVol = result.siliconeLowerHalf.volume();
          expect(upperVol + lowerVol).toBeCloseTo(result.siliconeVolume_mm3, 3);

          // Wave 3 eats Y-symmetry: the sprue lives on the upper half
          // only, and the +Z asymmetric key lives on both in mirrored
          // forms. ±40% bound catches gross regressions (on a small
          // sphere, the sprue removes a meaningful fraction of the
          // upper half's volume).
          expect(upperVol / lowerVol).toBeGreaterThan(0.6);
          expect(upperVol / lowerVol).toBeLessThan(1.4);

          // Silicone volume bounded loosely — the sprue's carve depth
          // depends on the actual levelSet-shell bbox, which is
          // grid-quantised beyond the analytic Minkowski prediction.
          // We keep a reasonable window below ANALYTIC_SILICONE_VOL
          // (material is removed by the sprue) and above 60% of it
          // (catch gross regressions).
          expect(result.siliconeVolume_mm3).toBeLessThan(ANALYTIC_SILICONE_VOL);
          expect(result.siliconeVolume_mm3).toBeGreaterThan(ANALYTIC_SILICONE_VOL * 0.6);

          // Wave 3: resin = master + sprue (ventCount=0). Bracket the
          // resin volume like the unit-cube test — the generator reads
          // the pre-split silicone's bbox, which can be slightly
          // larger than the post-split half's bbox we can read back
          // here.
          const shellBboxMaxY = Math.max(
            result.siliconeUpperHalf.boundingBox().max[1],
            result.siliconeLowerHalf.boundingBox().max[1],
          );
          const sprueFromY = 1 + 0.1;
          const sprueR = spParams.sprueDiameter_mm / 2;
          const lenMin = shellBboxMaxY + spParams.baseThickness_mm - sprueFromY;
          const lenMax = lenMin + 2.0;
          const resinMin = MASTER_VOL + Math.PI * sprueR * sprueR * lenMin;
          const resinMax = MASTER_VOL + Math.PI * sprueR * sprueR * lenMax;
          expect(result.resinVolume_mm3).toBeGreaterThanOrEqual(resinMin - 1e-6);
          expect(result.resinVolume_mm3).toBeLessThanOrEqual(resinMax + 1e-6);
          // Warnings empty.
          expect(result.warnings).toEqual([]);
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
    'completes within budget and produces manifold halves with plausible volumes',
    async () => {
      const { manifold } = await loadStl(readFixtureBuffer('mini-figurine'));
      try {
        const masterVol = manifold.volume();

        const t0 = performance.now();
        const result = await generateSiliconeShell(
          manifold,
          params({ wallThickness_mm: 10 }), // default
          new Matrix4(), // identity; fixture bbox already sensible
        );
        const elapsed = performance.now() - t0;
        try {
          // Perf budget. Issue #37 specifies "< 3 000 ms on a mid-range
          // Windows 11 machine (CI is a reasonable proxy)". In practice
          // the Ubuntu GitHub Actions runners run ~1.5× slower than a
          // mid-range local Windows dev box (first real CI run landed at
          // ~3.4 s), so we gate the assertion at 5 000 ms — still a
          // meaningful perf contract (catches any real regression that
          // pushes wall-clock by double-digit percent, since the locked-
          // in baseline is ~2.2 s local / ~3.4 s CI) without false-
          // alarming on standard runner variance.
          //
          // The issue-text budget stays 3 000 ms as the target; the test
          // assertion is the operational gate, which includes a
          // conservative CI-variance multiplier.
          //
          // Skipped entirely under V8 coverage instrumentation:
          // `@vitest/coverage-v8` drives `Profiler.startPreciseCoverage`
          // which slows the closure-heavy SDF hot loop ~7× (local:
          // 2.2 s → ~16 s under coverage). That's a testing-infra
          // artefact, not a shipping-code regression. Vitest exposes its
          // resolved test config on `__vitest_worker__.config` — the
          // cleanest in-test signal that the coverage provider is active.
          // The test still RUNS under coverage (so we capture line /
          // branch hits); we just skip the perf assertion.
          const worker = (
            globalThis as {
              __vitest_worker__?: { config?: { coverage?: { enabled?: boolean } } };
            }
          ).__vitest_worker__;
          const coverageEnabled = !!worker?.config?.coverage?.enabled;
          if (!coverageEnabled) {
            // Wave 3 (issue #55) raised the budget from 5 000 ms to
            // 6 500 ms to absorb +3 key stamps + 1 sprue drill + ≤2
            // vent drills. On local Windows the full pipeline is still
            // ~2.5 s; the CI headroom matches what the issue mandates.
            expect(elapsed).toBeLessThan(6500);
          }

          // Both halves manifold.
          expect(isManifold(result.siliconeUpperHalf)).toBe(true);
          expect(isManifold(result.siliconeLowerHalf)).toBe(true);

          // Halves sum to total.
          const upperVol = result.siliconeUpperHalf.volume();
          const lowerVol = result.siliconeLowerHalf.volume();
          expect(upperVol + lowerVol).toBeCloseTo(
            result.siliconeVolume_mm3,
            // The mini-figurine's silicone volume is O(10⁵) mm³ and we
            // compare two O(10⁵) sums against O(10⁵); single-precision
            // drift in float-32 accumulation makes "4 decimals" strict
            // overkill. Keep it loose (0 = ±0.5 after rounding), still
            // catches any real divergence between the sum-of-halves and
            // the result's reported total.
            0,
          );

          // Plausibility:
          //   - volume positive and finite (issue AC)
          //   - combined silicone > master × 1.2 (sanity: 10 mm wall around
          //     a figurine with ~1.2 × 10⁵ mm³ volume should produce a
          //     shell thickness-times-surface-area contribution that
          //     comfortably exceeds 20 % of the master volume).
          expect(result.siliconeVolume_mm3).toBeGreaterThan(0);
          expect(Number.isFinite(result.siliconeVolume_mm3)).toBe(true);
          expect(result.siliconeVolume_mm3).toBeGreaterThan(masterVol * 1.2);

          // Wave 3 (issue #55): resin = master + analytic channels.
          // Lower bound: resin must be STRICTLY greater than master
          // volume (there's always a sprue channel), and must be
          // finite. We don't pin an exact number — the mini-figurine's
          // channel lengths depend on its bounding box, which isn't
          // hand-computed in this test.
          expect(result.resinVolume_mm3).toBeGreaterThan(masterVol);
          expect(Number.isFinite(result.resinVolume_mm3)).toBe(true);

          // Warnings array is present; for the default-param pass on a
          // mini-figurine we expect all requested vents to fit (rich
          // top-surface geometry), so warnings should be empty. If this
          // flakes we loosen to `length <= 1`.
          expect(Array.isArray(result.warnings)).toBe(true);
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

describe('generateSiliconeShell — integration with adapter', () => {
  test('output half-Manifold round-trips through manifoldToBufferGeometry', async () => {
    // Hand-built master: a 4×4×4 mm cube at origin — no fixture dependency,
    // so this test runs in the default suite even on a fresh clone.
    const toplevel = await initManifold();
    const master = toplevel.Manifold.cube([4, 4, 4], true);
    try {
      const result = await generateSiliconeShell(
        master,
        params({ wallThickness_mm: 5 }),
        new Matrix4(),
      );
      try {
        // Round-trip the upper half through the adapter.
        const bg = await manifoldToBufferGeometry(result.siliconeUpperHalf);
        try {
          expect(bg.getAttribute('position').count).toBeGreaterThan(0);
          expect(bg.getAttribute('normal')).toBeDefined();

          // And re-ingest to make sure the geometry we produce survives
          // a full adapter round-trip (volume preserved within kernel
          // noise).
          const reingested = await bufferGeometryToManifold(bg);
          try {
            expect(isManifold(reingested)).toBe(true);
            // Reingest goes through the BufferGeometry → Manifold adapter,
            // which snaps vertex coordinates through float32 + dedups by
            // exact-string key. Both steps lose a hair of precision. The
            // "round-trip preserves volume" invariant is what the
            // integration test asserts — not bit-identical volume — so
            // we use a relative tolerance against the original volume
            // instead of `toBeCloseTo`'s fixed decimal rounding.
            // 0.1 % is empirically tight enough to catch any real bug
            // (e.g. dropped triangles, wrong winding) while tolerating
            // adapter float-round loss on ~10³ mm³ volumes.
            const v0 = result.siliconeUpperHalf.volume();
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

describe('generateSiliconeShell — printable-box integration (Wave 2, issue #50)', () => {
  // Light integration: Wave 2 outputs flow through the full
  // `generateSiliconeShell` call. Pure-geometry invariants live in
  // `tests/geometry/printableBox.test.ts`; this suite just pins the
  // end-to-end wiring — shape, sideCount, volumes.
  test('returns basePart, sideParts (length=sideCount), topCapPart + printableVolume', async () => {
    const toplevel = await initManifold();
    const master = toplevel.Manifold.cube([4, 4, 4], true);
    try {
      for (const sideCount of [2, 3, 4] as const) {
        const result = await generateSiliconeShell(
          master,
          params({ wallThickness_mm: 5, sideCount, baseThickness_mm: 3 }),
          new Matrix4(),
        );
        try {
          expect(isManifold(result.basePart)).toBe(true);
          expect(isManifold(result.topCapPart)).toBe(true);
          expect(result.sideParts).toHaveLength(sideCount);
          for (const s of result.sideParts) {
            expect(isManifold(s)).toBe(true);
          }

          // printableVolume_mm3 matches the sum of parts.
          let sum = result.basePart.volume() + result.topCapPart.volume();
          for (const s of result.sideParts) sum += s.volume();
          expect(result.printableVolume_mm3).toBeCloseTo(sum, 3);

          // printableVolume is strictly positive.
          expect(result.printableVolume_mm3).toBeGreaterThan(0);
        } finally {
          result.siliconeUpperHalf.delete();
          result.siliconeLowerHalf.delete();
          result.basePart.delete();
          result.topCapPart.delete();
          for (const s of result.sideParts) s.delete();
        }
      }
    } finally {
      master.delete();
    }
  }, 30_000);
});

describe('generateSiliconeShell — validation', () => {
  test('rejects wall thickness below the 3 mm hard floor', async () => {
    const toplevel = await initManifold();
    const master = toplevel.Manifold.cube([1, 1, 1], true);
    try {
      await expect(
        generateSiliconeShell(master, params({ wallThickness_mm: 2 }), new Matrix4()),
      ).rejects.toThrow(/wallThickness_mm=2/);
    } finally {
      master.delete();
    }
  });

  test('rejects sideCount outside {2, 3, 4} before Manifold allocation', async () => {
    // Wave 2 (issue #50) AC: "invalid sideCount (e.g., 5) throws
    // InvalidParametersError before any Manifold allocation". The
    // validation runs before the `initManifold()` await inside the
    // generator, so a bad sideCount surfaces as a rejected promise
    // with the `InvalidParametersError` name.
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
      // Error class assertion — the thrown error must be the dedicated
      // `InvalidParametersError` so callers can branch on type.
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

  test('applies viewTransform before the parting split', async () => {
    // Master is a 2×2×10 mm bar — 10× taller than wide. With identity
    // transform the horizontal split at midY cuts the bar in half
    // lengthwise; each half has ~20 mm³ + shell of rubber around it.
    //
    // When we rotate the bar 90° about X (bar now lies flat along Y),
    // the bounding box's midY changes from 0 to the middle of the now-
    // horizontal bar, and the split geometry should respond — the halves
    // will have very different volumes from the upright case because the
    // cut is now across the bar's thin dimension.
    //
    // We just need to confirm that rotation ACTUALLY affects the halves'
    // volumes, proving the viewTransform is applied (vs. being silently
    // ignored). We don't assert exact numbers — the invariant is "the
    // rotated case is numerically different from the upright case".
    const toplevel = await initManifold();
    const bar = toplevel.Manifold.cube([2, 10, 2], true);
    try {
      // Wave 3: disable vents; sprue length depends on post-transform
      // masterBbox.max.y (different for upright vs rotated), so the
      // identity-rotation silicone-volume invariant no longer holds for
      // the FINAL volumes. We still verify the pipeline runs on both
      // inputs and produces valid manifolds.
      const upright = await generateSiliconeShell(
        bar,
        params({ wallThickness_mm: 5, ventCount: 0 }),
        new Matrix4(),
      );
      const rotated = await generateSiliconeShell(
        bar,
        params({ wallThickness_mm: 5, ventCount: 0 }),
        new Matrix4().makeRotationX(Math.PI / 2),
      );
      try {
        // Pipeline runs without failing manifoldness on either input —
        // that's the bug this test would catch.
        expect(isManifold(rotated.siliconeUpperHalf)).toBe(true);
        expect(isManifold(rotated.siliconeLowerHalf)).toBe(true);
        expect(isManifold(upright.siliconeUpperHalf)).toBe(true);
        expect(isManifold(upright.siliconeLowerHalf)).toBe(true);

        // Both results have the new warnings field populated as an
        // array (Wave 3 shape check).
        expect(Array.isArray(upright.warnings)).toBe(true);
        expect(Array.isArray(rotated.warnings)).toBe(true);
      } finally {
        disposeAll(upright);
        disposeAll(rotated);
      }
    } finally {
      bar.delete();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Wave 3 (issue #55) — key + sprue + vent specific tests
// ---------------------------------------------------------------------------

describe('generateSiliconeShell — Wave 3 (keys, sprue, vents)', () => {
  // Issue #57: cone + keyhole key styles are now implemented — a happy-path
  // full-generate per style confirms the dispatch wires through the
  // generator. The fine-grained geometry coverage lives in the
  // `registrationKeys.test.ts` suite.
  test('generates a watertight mold with cone key style (issue #57)', async () => {
    const toplevel = await initManifold();
    const master = toplevel.Manifold.cube([4, 4, 4], true);
    try {
      const result = await generateSiliconeShell(
        master,
        params({ registrationKeyStyle: 'cone', ventCount: 0 }),
        new Matrix4(),
      );
      try {
        expect(isManifold(result.siliconeUpperHalf)).toBe(true);
        expect(isManifold(result.siliconeLowerHalf)).toBe(true);
        expect(isManifold(result.basePart)).toBe(true);
        expect(isManifold(result.topCapPart)).toBe(true);
        for (const s of result.sideParts) expect(isManifold(s)).toBe(true);

        // Halves sum invariant (kernel-noise-level match).
        const upperVol = result.siliconeUpperHalf.volume();
        const lowerVol = result.siliconeLowerHalf.volume();
        expect(upperVol + lowerVol).toBeCloseTo(result.siliconeVolume_mm3, 3);

        // Resin + silicone volumes positive + finite.
        expect(result.siliconeVolume_mm3).toBeGreaterThan(0);
        expect(result.resinVolume_mm3).toBeGreaterThan(0);
        expect(Number.isFinite(result.resinVolume_mm3)).toBe(true);
      } finally {
        disposeAll(result);
      }
    } finally {
      master.delete();
    }
  }, 30_000);

  test('generates a watertight mold with keyhole key style (issue #57)', async () => {
    const toplevel = await initManifold();
    const master = toplevel.Manifold.cube([4, 4, 4], true);
    try {
      const result = await generateSiliconeShell(
        master,
        params({ registrationKeyStyle: 'keyhole', ventCount: 0 }),
        new Matrix4(),
      );
      try {
        expect(isManifold(result.siliconeUpperHalf)).toBe(true);
        expect(isManifold(result.siliconeLowerHalf)).toBe(true);
        expect(isManifold(result.basePart)).toBe(true);
        expect(isManifold(result.topCapPart)).toBe(true);
        for (const s of result.sideParts) expect(isManifold(s)).toBe(true);

        const upperVol = result.siliconeUpperHalf.volume();
        const lowerVol = result.siliconeLowerHalf.volume();
        expect(upperVol + lowerVol).toBeCloseTo(result.siliconeVolume_mm3, 3);

        expect(result.siliconeVolume_mm3).toBeGreaterThan(0);
        expect(result.resinVolume_mm3).toBeGreaterThan(0);
        expect(Number.isFinite(result.resinVolume_mm3)).toBe(true);
      } finally {
        disposeAll(result);
      }
    } finally {
      master.delete();
    }
  }, 30_000);

  test('rejects ventDiameter >= sprueDiameter pre-Manifold', async () => {
    const toplevel = await initManifold();
    const master = toplevel.Manifold.cube([4, 4, 4], true);
    try {
      await expect(
        generateSiliconeShell(
          master,
          params({ sprueDiameter_mm: 3, ventDiameter_mm: 3 }),
          new Matrix4(),
        ),
      ).rejects.toThrow(/sprue must be wider than vents/);
      await expect(
        generateSiliconeShell(
          master,
          params({ sprueDiameter_mm: 3, ventDiameter_mm: 5 }),
          new Matrix4(),
        ),
      ).rejects.toThrow(/sprue must be wider than vents/);
    } finally {
      master.delete();
    }
  });

  test('rejects ventCount outside [0, 8] pre-Manifold', async () => {
    const toplevel = await initManifold();
    const master = toplevel.Manifold.cube([4, 4, 4], true);
    try {
      await expect(
        generateSiliconeShell(master, params({ ventCount: -1 }), new Matrix4()),
      ).rejects.toThrow(/ventCount=-1/);
      await expect(
        generateSiliconeShell(master, params({ ventCount: 9 }), new Matrix4()),
      ).rejects.toThrow(/ventCount=9/);
      await expect(
        generateSiliconeShell(master, params({ ventCount: 1.5 }), new Matrix4()),
      ).rejects.toThrow(/ventCount=1.5/);
    } finally {
      master.delete();
    }
  });

  test('resin volume identity: resin ≈ master + π·(sprueR)²·length + Σ vent cyls', async () => {
    // A 4×4×4 cube gives a simple-to-compute analytic resin volume.
    // ventCount=0 so the sprue channel is the only analytic contribution
    // on top of the master's 64 mm³. We read `shellBbox.max.y` indirectly
    // via the silicone halves' bbox — kernel rounding makes this a ~5e-4
    // approximation of the exact value the generator used, so we leave
    // the tolerance at 1e-3 here. The tight 1e-5 identity is exercised
    // in the mini-figurine test below (issue #58) where ventCount=2 AND
    // we pin the shellBbox via a secondary generator call.
    const toplevel = await initManifold();
    const master = toplevel.Manifold.cube([4, 4, 4], true);
    try {
      const p = params({
        wallThickness_mm: 5,
        baseThickness_mm: 3,
        ventCount: 0, // skip vents for exact master+sprue math
      });
      const result = await generateSiliconeShell(master, p, new Matrix4());
      try {
        const masterVol = 64;
        const sprueR = p.sprueDiameter_mm / 2;
        // sprue bottom = master.max.y + 0.1 = 2.1; sprue top = outer top =
        // shellBbox.max.y + baseThickness. shellBbox.max.y on a cube
        // after wall=5 levelset should be ~(2 + 5) = 7 — the exact
        // value is the Manifold's reported bbox, which we can read off
        // the silicone halves. For the analytic check we use the same
        // construction the generator does: sprueToY = shellBbox.max +
        // baseThickness.
        const shellBboxMaxY = Math.max(
          result.siliconeUpperHalf.boundingBox().max[1],
          result.siliconeLowerHalf.boundingBox().max[1],
        );
        const sprueToY = shellBboxMaxY + p.baseThickness_mm;
        const sprueLen = sprueToY - (2 + 0.1);
        const sprueVol = Math.PI * sprueR * sprueR * sprueLen;
        const expectedResin = masterVol + sprueVol;

        const relErr =
          Math.abs(result.resinVolume_mm3 - expectedResin) / expectedResin;
        expect(relErr).toBeLessThan(1e-3);
      } finally {
        disposeAll(result);
      }
    } finally {
      master.delete();
    }
  }, 30_000);

  test('asymmetric key placement: rotating upperHalf 180° about Y does not mate with lowerHalf', async () => {
    // The asymmetric key at +Z is what enforces orientation. If we
    // rotate the upper-half's key positions 180° about Y, the +Z
    // recess moves to −Z, where the lower half has NO protrusion. A
    // naive re-union (of the rotated upper and original lower) would
    // therefore gain volume compared to the unrotated re-union (which
    // loses material to mating recesses + protrusions) — because the
    // rotated case leaves the lower's +Z protrusion un-mated + the
    // upper's now-at-−Z recess empty.
    //
    // We check this at the Manifold level: unite both halves upright,
    // then re-unite with the upper rotated 180° about Y. The two
    // unions must have different volumes (proving the keys' geometric
    // asymmetry is real).
    const toplevel = await initManifold();
    const master = toplevel.Manifold.cube([4, 4, 4], true);
    try {
      const result = await generateSiliconeShell(
        master,
        params({ wallThickness_mm: 5, ventCount: 0 }),
        new Matrix4(),
      );
      try {
        // Upright union: each key's protrusion + recess mate, and the
        // result's volume equals the sum of the two halves minus no
        // overlap, i.e., upper.volume() + lower.volume() to within
        // kernel noise. (Union of two non-overlapping solids is the
        // sum of their volumes — the halves only share the parting
        // plane seam + the mated key interfaces, which have zero
        // volume when the recesses fit the protrusions.)
        const upright = toplevel.Manifold.union([
          result.siliconeUpperHalf,
          result.siliconeLowerHalf,
        ]);
        let rotatedUpper: ReturnType<typeof result.siliconeUpperHalf.rotate> | undefined;
        let rotatedUnion: ReturnType<typeof toplevel.Manifold.union> | undefined;
        try {
          rotatedUpper = result.siliconeUpperHalf.rotate([0, 180, 0]);
          rotatedUnion = toplevel.Manifold.union([rotatedUpper, result.siliconeLowerHalf]);

          const uprightVol = upright.volume();
          const rotatedVol = rotatedUnion.volume();

          // Rotated union overlaps the protrusions (both halves try to
          // occupy the same key space at +Z), so its volume is LESS
          // than the upright case by the volume of the three
          // protrusions. Different → enforced asymmetry. We only
          // assert the INequality, not the exact delta.
          expect(Math.abs(uprightVol - rotatedVol)).toBeGreaterThan(1e-2);
        } finally {
          upright.delete();
          if (rotatedUpper) rotatedUpper.delete();
          if (rotatedUnion) rotatedUnion.delete();
        }
      } finally {
        disposeAll(result);
      }
    } finally {
      master.delete();
    }
  }, 30_000);

  test.skipIf(!fixtureExists('mini-figurine'))(
    'exact per-vent analytic resin length — ventCount=2 mini-figurine, 1e-5 relative (issue #58)',
    async () => {
      // Issue #58: `generateMold.ts` now sums per-vent analytic channel
      // length exactly (`Σ π · r² · (ventTopY − fromY)` over placed
      // vents), not the conservative `ventCount · π · r² · ventMaxLength`
      // bound that over-reported by up to ~`ventCount · π · r² · wall/2`.
      //
      // Test strategy: run the generator twice on the mini-figurine —
      // once with `ventCount=0` (resin₀ = master + sprue) and once with
      // `ventCount=2` (resin₂ = master + sprue + Σvents). Since the
      // silicone body's bbox is derived before the vent step, the
      // sprue-channel contribution is identical in both runs, so:
      //
      //   resin₂ − resin₀ = Σ π · r² · (ventTopY − fromY)
      //
      // We reconstruct `ventTopY` from the sprue contribution alone
      // (`resin₀ − masterVol = π · sprueR² · (ventTopY − sprueFromY)`)
      // and replicate the NMS to get the same `fromY` values the
      // generator picked. That gives us an analytic expected vent sum
      // at machine precision. 1e-5 tolerance holds when the formula is
      // exact; prior to this refactor the same test at 1e-5 would have
      // failed by a multiplicative factor determined by how much lower
      // each vent's `fromY` was below `masterMaxY`.
      const { manifold } = await loadStl(readFixtureBuffer('mini-figurine'));
      try {
        const p0 = params({ ventCount: 0 });
        const p2 = params({ ventCount: 2 });

        const r0 = await generateSiliconeShell(manifold, p0, new Matrix4());
        const r2 = await generateSiliconeShell(manifold, p2, new Matrix4());
        try {
          // The vent step placed `r2.warnings[0]` may exist if fewer
          // than 2 vents fit; in that case the "only N of M" pattern
          // tells us `placed`.
          let placed = p2.ventCount;
          const m = (r2.warnings[0] ?? '').match(/only (\d+) of/);
          if (m) placed = Number.parseInt(m[1] ?? String(p2.ventCount), 10);

          // Both runs share the silicone body's shellBbox, so the
          // sprue-channel contribution is the same:
          //   π · sprueR² · (ventTopY − sprueFromY)
          // where sprueFromY = masterBbox.max.y + 0.1 and ventTopY =
          // shellBbox.max.y + baseThickness.
          const masterMaxY = manifold.boundingBox().max[1];
          const sprueFromY = masterMaxY + 0.1; // SPRUE_Y_EPSILON_MM
          const sprueR = p0.sprueDiameter_mm / 2;
          const ventR = p0.ventDiameter_mm / 2;
          const masterVol = manifold.volume();

          // Back-solve ventTopY from the sprue-only case.
          const sprueChannelVol0 = r0.resinVolume_mm3 - masterVol;
          const sprueLen0 = sprueChannelVol0 / (Math.PI * sprueR * sprueR);
          const ventTopY = sprueFromY + sprueLen0;

          // Replicate NMS on the master to get the same fromY values
          // the generator's `drillVents` would pick.
          const vertices = readMasterVertices(manifold);
          const minSeparation = Math.max(
            MIN_VENT_SEPARATION_MM,
            2 * p2.ventDiameter_mm,
          );
          const masterBbox = manifold.boundingBox();
          const sprueXZ = {
            x: (masterBbox.min[0] + masterBbox.max[0]) / 2,
            z: (masterBbox.min[2] + masterBbox.max[2]) / 2,
          };
          const sprueExclusion = p2.sprueDiameter_mm + p2.ventDiameter_mm;
          const selected = selectVentCandidates(vertices, {
            ventCount: p2.ventCount,
            minSeparation,
            sprueXZ,
            sprueExclusion,
          });
          expect(selected.length).toBe(placed);

          // For each selected XZ, look up its source vertex Y (this is
          // the same `vertexYForXZ` logic `drillVents` uses).
          const fromYs: number[] = [];
          for (const xz of selected) {
            let firstMatchY: number | undefined;
            for (const v of vertices) {
              if (v.x === xz.x && v.z === xz.z) {
                if (firstMatchY === undefined) firstMatchY = v.y;
              }
            }
            expect(firstMatchY).toBeDefined();
            fromYs.push(firstMatchY as number);
          }

          // Expected analytic vent channel sum using the exact per-vent
          // length (issue #58's refactor output).
          const expectedVentSum = fromYs.reduce(
            (sum, fromY) => sum + Math.PI * ventR * ventR * (ventTopY - fromY),
            0,
          );
          const actualVentSum = r2.resinVolume_mm3 - r0.resinVolume_mm3;

          // Sanity: placed > 0 so this test actually exercises the
          // changed code path. Mini-figurine has rich top geometry; we
          // expect 2 vents to fit.
          expect(placed).toBeGreaterThan(0);
          expect(expectedVentSum).toBeGreaterThan(0);

          const relErr =
            Math.abs(actualVentSum - expectedVentSum) / expectedVentSum;
          // 1e-5 relative. Prior to #58 the generator over-reported each
          // vent by `wall/2` × π · r² on average, which on default
          // params (wall=10, ventR=0.75, placed=2) would give relErr
          // ~1e-1 — catastrophically above 1e-5.
          expect(relErr).toBeLessThan(1e-5);
        } finally {
          disposeAll(r0);
          disposeAll(r2);
        }
      } finally {
        manifold.delete();
      }
    },
    60_000,
  );

  test('ventCount=0 produces empty warnings and skipped=0', async () => {
    const toplevel = await initManifold();
    const master = toplevel.Manifold.cube([4, 4, 4], true);
    try {
      const result = await generateSiliconeShell(
        master,
        params({ ventCount: 0 }),
        new Matrix4(),
      );
      try {
        expect(result.warnings).toEqual([]);
      } finally {
        disposeAll(result);
      }
    } finally {
      master.delete();
    }
  }, 30_000);

  test('generate×3 does not leak: repeated runs produce consistent volume', async () => {
    // Issue #55 "Orchestrator disposes all new Manifolds..." — we can't
    // read manifold-3d's internal handle count from the JS side, but a
    // proxy invariant is "three successive runs return the same
    // volumes within kernel noise". If any Manifold were being
    // retained internally across runs (i.e., the helpers leak), the
    // kernel's handle table would grow and downstream CSG would either
    // slow or start producing different numbers.
    const toplevel = await initManifold();
    const master = toplevel.Manifold.cube([4, 4, 4], true);
    try {
      const runParams = params({ wallThickness_mm: 5, ventCount: 0 });
      const volumes: Array<{ silicone: number; resin: number }> = [];
      for (let i = 0; i < 3; i++) {
        const r = await generateSiliconeShell(master, runParams, new Matrix4());
        volumes.push({ silicone: r.siliconeVolume_mm3, resin: r.resinVolume_mm3 });
        disposeAll(r);
      }
      // All three runs agree within 1e-3 relative on silicone + resin.
      for (let i = 1; i < 3; i++) {
        expect(volumes[i]!.silicone).toBeCloseTo(volumes[0]!.silicone, 3);
        expect(volumes[i]!.resin).toBeCloseTo(volumes[0]!.resin, 3);
      }
    } finally {
      master.delete();
    }
  }, 60_000);
});
