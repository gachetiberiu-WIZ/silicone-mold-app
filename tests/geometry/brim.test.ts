// tests/geometry/brim.test.ts
//
// Unit tests for the Wave-F brim builder (issue #84). We don't need a
// full generator-produced shell to exercise `addBrim` — any watertight
// manifold "piece" with a known bbox works. We use simple cuboids
// sliced via `sliceShellRadial` on a ring-ish hollow cube so the brim
// attaches to a realistic piece geometry.

import { describe, expect, test } from 'vitest';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';

import { initManifold, isManifold } from '@/geometry';
import { addBrim } from '@/geometry/brim';
import { sliceShellRadial } from '@/geometry/shellSlicer';

function buildRingShell(
  toplevel: ManifoldToplevel,
  outer = 20,
  inner = 10,
): Manifold {
  const outerCube = toplevel.Manifold.cube([outer, outer, outer], true);
  const innerCube = toplevel.Manifold.cube([inner, inner, inner], true);
  try {
    return toplevel.Manifold.difference([outerCube, innerCube]);
  } finally {
    outerCube.delete();
    innerCube.delete();
  }
}

describe('addBrim — sideCount=2 single-cut case', () => {
  test('brim adds volume proportional to brim_area × thickness', async () => {
    const toplevel = await initManifold();
    const shell = buildRingShell(toplevel, 20, 10);
    const shellVol = shell.volume();
    const shellBbox = shell.boundingBox();

    const pieces = sliceShellRadial(toplevel, shell, 2, { x: 0, z: 0 });
    shell.delete();

    try {
      const pieceVol = pieces[0]!.volume();

      const brimWidth = 10;
      const brimThickness = 3;
      const brimmed = addBrim({
        toplevel,
        piece: pieces[0]!,
        pieceIndex: 0,
        sideCount: 2,
        shellBboxWorld: {
          min: {
            x: shellBbox.min[0]!,
            y: shellBbox.min[1]!,
            z: shellBbox.min[2]!,
          },
          max: {
            x: shellBbox.max[0]!,
            y: shellBbox.max[1]!,
            z: shellBbox.max[2]!,
          },
        },
        xzCenter: { x: 0, z: 0 },
        brimWidth_mm: brimWidth,
        brimThickness_mm: brimThickness,
      });
      // addBrim consumes the input piece — slot 0 is now dead.
      // Leave slot 1 intact for cleanup.
      try {
        expect(isManifold(brimmed)).toBe(true);
        expect(brimmed.isEmpty()).toBe(false);
        const brimmedVol = brimmed.volume();
        // Volume gain is bounded roughly by
        //   brim_flange_area × thickness + inner-overlap absorbed
        // Loose check: brimmed piece is heavier than the raw piece,
        // lighter than the raw piece + an analytic upper-bound brim
        // box (width + overlap slop) × (shell height) × thickness × 2
        // (sideCount=2 has one brim per piece but allow generous
        // slack for box overlap interior to the piece).
        expect(brimmedVol).toBeGreaterThan(pieceVol);
        // Lower bound: at least `brimWidth × shellHeight × brimThickness`
        // (the outer-flange portion, discounting the inner overlap
        // that was already inside the piece).
        const shellHeight =
          shellBbox.max[1]! - shellBbox.min[1]! - 4; // 2mm margin top+bottom
        const outerFlangeVol = brimWidth * shellHeight * brimThickness;
        expect(brimmedVol - pieceVol).toBeGreaterThan(outerFlangeVol * 0.5);
        // Upper bound on the volume gain: generous — allow ~5× the
        // outer-flange volume as a safety net for how much of the
        // inner-overlap slop contributed (anything way above is a
        // bug).
        expect(brimmedVol - pieceVol).toBeLessThan(outerFlangeVol * 5);
        expect(brimmedVol).toBeLessThan(shellVol * 3);
        brimmed.delete();
      } catch (err) {
        brimmed.delete();
        throw err;
      }
    } finally {
      // Cleanup piece 1 (piece 0 was consumed by addBrim).
      pieces[1]!.delete();
    }
  });
});

describe('addBrim — sideCount=4 two-cut case', () => {
  test('brim extends AABB outward by roughly brimWidth on both cut normals', async () => {
    const toplevel = await initManifold();
    const shell = buildRingShell(toplevel, 20, 10);
    const shellBbox = shell.boundingBox();
    const pieces = sliceShellRadial(toplevel, shell, 4, { x: 0, z: 0 });
    shell.delete();

    try {
      const pieceBboxPre = pieces[0]!.boundingBox();
      const brimmed = addBrim({
        toplevel,
        piece: pieces[0]!,
        pieceIndex: 0,
        sideCount: 4,
        shellBboxWorld: {
          min: {
            x: shellBbox.min[0]!,
            y: shellBbox.min[1]!,
            z: shellBbox.min[2]!,
          },
          max: {
            x: shellBbox.max[0]!,
            y: shellBbox.max[1]!,
            z: shellBbox.max[2]!,
          },
        },
        xzCenter: { x: 0, z: 0 },
        brimWidth_mm: 10,
        brimThickness_mm: 3,
      });
      try {
        expect(isManifold(brimmed)).toBe(true);

        // Piece 0 at sideCount=4 occupies arc [45°, 135°] (+Z
        // quadrant). Brim flanges extend along the two cut directions
        // (45° and 135°). After unioning, the piece's AABB should
        // grow in the +X direction (from the 45° cut flange), the -X
        // direction (135° flange), and in +Z (both flanges extend
        // away from center). We check that the XZ extent grew
        // outward by at least ~brimWidth/2 on each side (conservative
        // accounting for diagonal projection: the flange's radial
        // direction is at 45° so its projection onto +X is
        // brimWidth / sqrt(2) ≈ 7 mm for brimWidth=10).
        const brimmedBbox = brimmed.boundingBox();
        // Brim pushes the piece's AABB outward; use a loose >= check
        // rather than strict pre-vs-post deltas because the original
        // piece already has an outward extent.
        const projectedBrim = 10 / Math.SQRT2 * 0.7; // 70% of analytic
        // +X should have grown (45° flange projects positive X).
        expect(brimmedBbox.max[0]!).toBeGreaterThan(
          pieceBboxPre.max[0]! + projectedBrim,
        );
        // -X should have grown (135° flange projects negative X).
        expect(brimmedBbox.min[0]!).toBeLessThan(
          pieceBboxPre.min[0]! - projectedBrim,
        );
        brimmed.delete();
      } catch (err) {
        brimmed.delete();
        throw err;
      }
    } finally {
      for (let i = 1; i < pieces.length; i++) pieces[i]!.delete();
    }
  });

  test('sideCount=3: every piece survives addBrim as a manifold', async () => {
    const toplevel = await initManifold();
    const shell = buildRingShell(toplevel, 20, 10);
    const shellBbox = shell.boundingBox();
    const pieces = sliceShellRadial(toplevel, shell, 3, { x: 0, z: 0 });
    shell.delete();

    const brimmed: Manifold[] = [];
    try {
      for (let i = 0; i < pieces.length; i++) {
        const out = addBrim({
          toplevel,
          piece: pieces[i]!,
          pieceIndex: i,
          sideCount: 3,
          shellBboxWorld: {
            min: {
              x: shellBbox.min[0]!,
              y: shellBbox.min[1]!,
              z: shellBbox.min[2]!,
            },
            max: {
              x: shellBbox.max[0]!,
              y: shellBbox.max[1]!,
              z: shellBbox.max[2]!,
            },
          },
          xzCenter: { x: 0, z: 0 },
          brimWidth_mm: 10,
          brimThickness_mm: 3,
        });
        brimmed.push(out);
      }
      for (const p of brimmed) {
        expect(isManifold(p)).toBe(true);
        expect(p.isEmpty()).toBe(false);
        expect(p.volume()).toBeGreaterThan(0);
      }
    } finally {
      for (const p of brimmed) p.delete();
    }
  });
});
