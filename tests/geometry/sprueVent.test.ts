// tests/geometry/sprueVent.test.ts
//
// Vitest coverage for the Wave-3 sprue + vent helpers (issue #55,
// `src/geometry/sprueVent.ts`).
//
// These tests stay at the pure-algorithm + minimal-CSG level to keep
// wall-clock sane. The full generator integration lives in
// `generateMold.test.ts`.

import { describe, expect, test } from 'vitest';

import { initManifold, isManifold } from '@/geometry';
import {
  MIN_VENT_SEPARATION_MM,
  drillSprue,
  drillVents,
  selectVentCandidates,
} from '@/geometry/sprueVent';

describe('selectVentCandidates — greedy NMS', () => {
  test('ventCount=0 returns empty regardless of vertex list', () => {
    const verts = [
      { x: 0, y: 10, z: 0 },
      { x: 5, y: 9, z: 0 },
      { x: 0, y: 8, z: 5 },
    ];
    const out = selectVentCandidates(verts, {
      ventCount: 0,
      minSeparation: 1,
      sprueXZ: { x: 100, z: 100 },
      sprueExclusion: 0,
    });
    expect(out).toEqual([]);
  });

  test('picks the global maximum first', () => {
    const verts = [
      { x: 0, y: 1, z: 0 },
      { x: 20, y: 10, z: 0 },
      { x: -20, y: 5, z: 0 },
    ];
    const out = selectVentCandidates(verts, {
      ventCount: 1,
      minSeparation: 1,
      sprueXZ: { x: 100, z: 100 },
      sprueExclusion: 0,
    });
    expect(out).toEqual([{ x: 20, z: 0 }]);
  });

  test('respects minSeparation — second candidate within threshold is skipped', () => {
    // Two peaks 1 mm apart; minSeparation=5 → second gets rejected.
    const verts = [
      { x: 0, y: 10, z: 0 }, // peak A
      { x: 1, y: 9.5, z: 0 }, // too close to A
      { x: 20, y: 9, z: 0 }, // far enough from A
    ];
    const out = selectVentCandidates(verts, {
      ventCount: 3,
      minSeparation: 5,
      sprueXZ: { x: 100, z: 100 },
      sprueExclusion: 0,
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ x: 0, z: 0 });
    expect(out[1]).toEqual({ x: 20, z: 0 });
  });

  test('applies sprueExclusion — vent inside sprue radius is skipped', () => {
    // Sprue at origin with exclusion 5 mm; peak A at (2, ⋅, 0) is inside.
    const verts = [
      { x: 2, y: 10, z: 0 }, // inside sprue exclusion
      { x: 20, y: 9, z: 0 }, // outside
    ];
    const out = selectVentCandidates(verts, {
      ventCount: 2,
      minSeparation: 1,
      sprueXZ: { x: 0, z: 0 },
      sprueExclusion: 5,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ x: 20, z: 0 });
  });

  test('stops early when ventCount reached', () => {
    const verts = Array.from({ length: 10 }, (_, i) => ({
      x: i * 10,
      y: 100 - i,
      z: 0,
    }));
    const out = selectVentCandidates(verts, {
      ventCount: 3,
      minSeparation: 1,
      sprueXZ: { x: 1000, z: 1000 },
      sprueExclusion: 0,
    });
    expect(out).toHaveLength(3);
    // Highest 3 Y-values are indices 0, 1, 2.
    expect(out.map((p) => p.x)).toEqual([0, 10, 20]);
  });

  test('unit cube with ventCount=8 — at most 4 fit after NMS', () => {
    // Unit cube has 8 corner vertices, all at Y=0.5 (the top four) or
    // Y=−0.5 (bottom four). Top-4 corners are ~1.414 mm apart in XZ
    // (the cube's XZ diagonal on a unit edge). With
    // minSeparation=max(5, 2·1) = 5 mm, the top-4 are all within 5 mm
    // of each other → only the FIRST top corner fits. After that,
    // bottom-4 corners are at Y=−0.5 — still accepted if ventCount
    // hasn't been reached and minSeparation passes. Bottom-4 corners
    // are ALSO within 5 mm of the single accepted top corner on XZ
    // (they share XZ with top corners), so none of them pass either.
    // Result: exactly 1 vent fits.
    const verts: Array<{ x: number; y: number; z: number }> = [];
    for (const sx of [-0.5, 0.5])
      for (const sz of [-0.5, 0.5])
        for (const sy of [-0.5, 0.5]) verts.push({ x: sx, y: sy, z: sz });

    const out = selectVentCandidates(verts, {
      ventCount: 8,
      minSeparation: Math.max(MIN_VENT_SEPARATION_MM, 2 * 1), // 5 mm
      sprueXZ: { x: 100, z: 100 },
      sprueExclusion: 0,
    });
    expect(out.length).toBeLessThanOrEqual(1);
    // Warning will surface at the drillVents layer — the selector just
    // returns what fits.
    expect(out.length).toBeLessThan(8);
  });
});

describe('drillSprue — CSG discipline', () => {
  test('carves a cylindrical hole through both input Manifolds', async () => {
    const toplevel = await initManifold();
    const upper = toplevel.Manifold.cube([20, 5, 20], false).translate([-10, 0, -10]);
    const topCap = toplevel.Manifold.cube([20, 2, 20], false).translate([-10, 5, -10]);

    try {
      const upperVolBefore = upper.volume();
      const topCapVolBefore = topCap.volume();

      const { updatedUpper, updatedTopCap } = drillSprue(toplevel, upper, topCap, {
        xz: { x: 0, z: 0 },
        fromY: 0,
        toY: 7,
        diameter: 4, // radius 2, total Y extent = 7 through upper (5) + cap (2)
      });

      try {
        expect(isManifold(updatedUpper)).toBe(true);
        expect(isManifold(updatedTopCap)).toBe(true);

        // Expected loss: π · 2² · 5 = 20π from upper; π · 2² · 2 = 8π
        // from cap. A 1% relative tolerance covers the cylinder's
        // circular-segment quantisation error.
        const cylUpper = Math.PI * 4 * 5;
        const cylCap = Math.PI * 4 * 2;
        const dUpper = upperVolBefore - updatedUpper.volume();
        const dCap = topCapVolBefore - updatedTopCap.volume();
        expect(Math.abs(dUpper - cylUpper) / cylUpper).toBeLessThan(0.01);
        expect(Math.abs(dCap - cylCap) / cylCap).toBeLessThan(0.01);

        // Final upper + topCap are no longer solid (hole through Y) →
        // genus() > 0.
        expect(updatedUpper.genus()).toBe(1);
        expect(updatedTopCap.genus()).toBe(1);
      } finally {
        updatedUpper.delete();
        updatedTopCap.delete();
      }
    } finally {
      upper.delete();
      topCap.delete();
    }
  }, 30_000);

  test('rejects invalid input (toY <= fromY, non-positive diameter)', async () => {
    const toplevel = await initManifold();
    const upper = toplevel.Manifold.cube([10, 10, 10], true);
    const topCap = toplevel.Manifold.cube([10, 10, 10], true);
    try {
      expect(() =>
        drillSprue(toplevel, upper, topCap, {
          xz: { x: 0, z: 0 },
          fromY: 5,
          toY: 5,
          diameter: 1,
        }),
      ).toThrow(/toY=5 must be > opts.fromY=5/);
      expect(() =>
        drillSprue(toplevel, upper, topCap, {
          xz: { x: 0, z: 0 },
          fromY: 0,
          toY: 10,
          diameter: 0,
        }),
      ).toThrow(/diameter=0/);
    } finally {
      upper.delete();
      topCap.delete();
    }
  });
});

describe('drillVents — CSG + metadata', () => {
  test('ventCount=0 short-circuits and returns fresh clones with no warnings', async () => {
    const toplevel = await initManifold();
    const upper = toplevel.Manifold.cube([10, 10, 10], true);
    const topCap = toplevel.Manifold.cube([10, 2, 10], true);
    const master = toplevel.Manifold.cube([2, 2, 2], true);
    try {
      const upperVolBefore = upper.volume();

      const result = drillVents(toplevel, upper, topCap, {
        master,
        topY: 10,
        sprueXZ: { x: 0, z: 0 },
        sprueDiameter: 5,
        ventDiameter: 1,
        ventCount: 0,
      });

      try {
        expect(result.placed).toBe(0);
        expect(result.skipped).toBe(0);
        expect(result.warnings).toEqual([]);
        // Output Manifolds are fresh handles with matching volume.
        expect(result.updatedUpper.volume()).toBeCloseTo(upperVolBefore, 3);
        expect(isManifold(result.updatedUpper)).toBe(true);
        expect(isManifold(result.updatedTopCap)).toBe(true);
      } finally {
        result.updatedUpper.delete();
        result.updatedTopCap.delete();
      }
    } finally {
      upper.delete();
      topCap.delete();
      master.delete();
    }
  });

  test('unit cube with ventCount=8 — warning surfaces "only N of 8"', async () => {
    const toplevel = await initManifold();
    // Large surrounding materials so vent cylinders don't escape them.
    const upper = toplevel.Manifold.cube([20, 10, 20], false).translate([-10, 0, -10]);
    const topCap = toplevel.Manifold.cube([20, 2, 20], false).translate([-10, 10, -10]);
    // The "master" is a unit cube centred at origin with top at Y=0.5.
    const master = toplevel.Manifold.cube([1, 1, 1], true);

    try {
      const result = drillVents(toplevel, upper, topCap, {
        master,
        topY: 12,
        sprueXZ: { x: 100, z: 100 }, // far away — no sprue exclusion
        sprueDiameter: 5,
        ventDiameter: 1,
        ventCount: 8,
      });

      try {
        // On a unit cube, only a small handful of corners can be spaced
        // > 5 mm apart — often just one. The exact count depends on
        // kernel-level vertex ordering, but `placed` MUST be < 8.
        expect(result.placed).toBeLessThan(8);
        expect(result.placed).toBeGreaterThan(0);
        expect(result.skipped).toBe(8 - result.placed);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toMatch(
          new RegExp(`only ${result.placed} of 8 vents placed: insufficient local maxima`),
        );
      } finally {
        result.updatedUpper.delete();
        result.updatedTopCap.delete();
      }
    } finally {
      upper.delete();
      topCap.delete();
      master.delete();
    }
  }, 30_000);

  test('vent near sprue XZ is skipped (sprue-overlap exclusion)', async () => {
    const toplevel = await initManifold();
    // A wide upper/topCap so the test doesn't depend on vent length.
    const upper = toplevel.Manifold.cube([40, 10, 40], false).translate([-20, 0, -20]);
    const topCap = toplevel.Manifold.cube([40, 2, 40], false).translate([-20, 10, -20]);
    // Master: a tall cube centred at origin → its corner vertices are
    // at ±0.5 in X and Z. Sprue exclusion = sprueD + ventD = 5 + 1 = 6 mm.
    // All 4 top-corners are within 6 mm of origin → ALL are excluded.
    const master = toplevel.Manifold.cube([1, 1, 1], true);
    try {
      const result = drillVents(toplevel, upper, topCap, {
        master,
        topY: 12,
        sprueXZ: { x: 0, z: 0 },
        sprueDiameter: 5,
        ventDiameter: 1,
        ventCount: 2,
      });
      try {
        expect(result.placed).toBe(0);
        expect(result.skipped).toBe(2);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toMatch(/only 0 of 2 vents placed/);
      } finally {
        result.updatedUpper.delete();
        result.updatedTopCap.delete();
      }
    } finally {
      upper.delete();
      topCap.delete();
      master.delete();
    }
  }, 30_000);
});
