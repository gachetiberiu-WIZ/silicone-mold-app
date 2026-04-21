// tests/geometry/shellSlicer.test.ts
//
// Unit tests for the Wave-E radial shell slicer (issue #84). Builds a
// ring-ish "shell" Manifold from a large outer cube minus a smaller
// inner cube, then slices at each supported sideCount (2, 3, 4) and
// asserts:
//
//   - output array length matches sideCount,
//   - every piece is watertight (`isManifold`) and non-empty,
//   - sum of piece volumes ≈ original shell volume within 1e-3 rel
//     (trimming has micro-rounding but no mass loss beyond kernel
//     tolerance),
//   - piece 0's XZ centroid points along its expected mid-direction.

import { describe, expect, test } from 'vitest';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';

import { initManifold, isManifold } from '@/geometry';
import { SIDE_CUT_ANGLES } from '@/geometry/sideAngles';
import {
  pieceMidAngleRad,
  radialUnit,
  sliceShellRadial,
} from '@/geometry/shellSlicer';

/**
 * Build a simple shell-like Manifold: outer cube minus a smaller inner
 * cube, both centered at origin. That gives a hollow frame with the
 * outer bbox a known size. Thickness on every wall is `(outer-inner)/2`.
 */
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

describe('sliceShellRadial — output count + watertightness', () => {
  for (const sideCount of [2, 3, 4] as const) {
    test(`sideCount=${sideCount} produces exactly ${sideCount} watertight pieces`, async () => {
      const toplevel = await initManifold();
      const shell = buildRingShell(toplevel);
      try {
        const pieces = sliceShellRadial(toplevel, shell, sideCount, {
          x: 0,
          z: 0,
        });
        try {
          expect(pieces).toHaveLength(sideCount);
          for (const p of pieces) {
            expect(isManifold(p)).toBe(true);
            expect(p.isEmpty()).toBe(false);
            expect(p.volume()).toBeGreaterThan(0);
          }
        } finally {
          for (const p of pieces) p.delete();
        }
      } finally {
        shell.delete();
      }
    });
  }
});

describe('sliceShellRadial — volume conservation', () => {
  for (const sideCount of [2, 3, 4] as const) {
    test(`sideCount=${sideCount}: sum of piece volumes ≈ original shell volume`, async () => {
      const toplevel = await initManifold();
      const shell = buildRingShell(toplevel);
      try {
        const originalVol = shell.volume();
        const pieces = sliceShellRadial(toplevel, shell, sideCount, {
          x: 0,
          z: 0,
        });
        try {
          const summed = pieces.reduce((acc, p) => acc + p.volume(), 0);
          const relErr = Math.abs(summed - originalVol) / originalVol;
          expect(relErr).toBeLessThan(1e-3);
        } finally {
          for (const p of pieces) p.delete();
        }
      } finally {
        shell.delete();
      }
    });
  }
});

describe('sliceShellRadial — piece-centroid direction', () => {
  test('sideCount=4, piece 0 centroid points toward its mid-angle direction', async () => {
    const toplevel = await initManifold();
    const shell = buildRingShell(toplevel);
    try {
      const pieces = sliceShellRadial(toplevel, shell, 4, { x: 0, z: 0 });
      try {
        // Mid angle of piece 0 at sideCount=4 is (45+135)/2 = 90° → +Z.
        const midRad = pieceMidAngleRad(4, 0);
        const r = radialUnit(midRad);
        expect(r[2]).toBeCloseTo(1, 5); // +Z direction
        expect(Math.abs(r[0])).toBeLessThan(1e-5); // zero X

        // The piece's XZ centroid (AABB center) should align with that
        // direction — dot-product positive and dominant along expected
        // axis.
        const bb = pieces[0]!.boundingBox();
        const cx = (bb.min[0]! + bb.max[0]!) / 2;
        const cz = (bb.min[2]! + bb.max[2]!) / 2;
        // +Z-quadrant piece: cz strongly positive, cx ≈ 0 within the
        // small XZ extent of the piece's span.
        expect(cz).toBeGreaterThan(0);
        expect(cz).toBeGreaterThan(Math.abs(cx));
      } finally {
        for (const p of pieces) p.delete();
      }
    } finally {
      shell.delete();
    }
  });

  test('sideCount=2, pieces point +X and -X respectively', async () => {
    const toplevel = await initManifold();
    const shell = buildRingShell(toplevel);
    try {
      const pieces = sliceShellRadial(toplevel, shell, 2, { x: 0, z: 0 });
      try {
        // Mid angle of piece 0: (90+270)/2 = 180° → -X.
        // Mid angle of piece 1: (270+90+360)/2 - 180 = 360°/2 = 0° after
        // wraparound → +X.
        const bb0 = pieces[0]!.boundingBox();
        const cx0 = (bb0.min[0]! + bb0.max[0]!) / 2;
        expect(cx0).toBeLessThan(0); // piece 0 on -X side

        const bb1 = pieces[1]!.boundingBox();
        const cx1 = (bb1.min[0]! + bb1.max[0]!) / 2;
        expect(cx1).toBeGreaterThan(0); // piece 1 on +X side
      } finally {
        for (const p of pieces) p.delete();
      }
    } finally {
      shell.delete();
    }
  });
});

describe('sliceShellRadial — offset xzCenter', () => {
  test('planes pass through non-zero xzCenter', async () => {
    const toplevel = await initManifold();
    // Shift shell to (5, 0, 5) so xzCenter matters.
    const outerCube = toplevel.Manifold.cube([20, 20, 20], true);
    const innerCube = toplevel.Manifold.cube([10, 10, 10], true);
    const hollow = toplevel.Manifold.difference([outerCube, innerCube]);
    outerCube.delete();
    innerCube.delete();
    const shifted = hollow.translate([5, 0, 5]);
    hollow.delete();
    try {
      const pieces = sliceShellRadial(toplevel, shifted, 4, { x: 5, z: 5 });
      try {
        expect(pieces).toHaveLength(4);
        for (const p of pieces) {
          expect(isManifold(p)).toBe(true);
          expect(p.isEmpty()).toBe(false);
        }
        // Sum of volumes still matches the shifted shell's volume.
        const summed = pieces.reduce((acc, p) => acc + p.volume(), 0);
        const original = shifted.volume();
        expect(Math.abs(summed - original) / original).toBeLessThan(1e-3);
      } finally {
        for (const p of pieces) p.delete();
      }
    } finally {
      shifted.delete();
    }
  });
});

describe('sliceShellRadial — reference table matches documented convention', () => {
  test('SIDE_CUT_ANGLES[4] is [45, 135, 225, 315]', () => {
    expect(SIDE_CUT_ANGLES[4]).toEqual([45, 135, 225, 315]);
  });
  test('SIDE_CUT_ANGLES[3] is [30, 150, 270]', () => {
    expect(SIDE_CUT_ANGLES[3]).toEqual([30, 150, 270]);
  });
  test('SIDE_CUT_ANGLES[2] is [90, 270]', () => {
    expect(SIDE_CUT_ANGLES[2]).toEqual([90, 270]);
  });
});
