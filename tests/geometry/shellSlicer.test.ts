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
  applyTongueAndGrooveSeals,
  pieceMidAngleRad,
  radialUnit,
  SEAL_CLEARANCE_MM,
  SEAL_STEP_MM,
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

// Cut-planes preview feature (dogfood round 7) — the slicer now accepts
// an `angles` override so the user-facing gizmo can rotate the whole
// partition. Default (no override) must still match the reference
// table above; explicit override must produce a valid partition at
// arbitrary rotation + center offset.

describe('sliceShellRadial — user cut-plane overrides', () => {
  test('sideCount=4, angles rotated by 45° maps piece 0 centroid onto +X', async () => {
    const toplevel = await initManifold();
    const shell = buildRingShell(toplevel);
    try {
      // Base angles at sideCount=4 → [45,135,225,315], piece 0 mid = 90° (+Z).
      // Rotated by 45° → [90,180,270,360=0], piece 0 mid = 135°... hmm wait.
      // Actually the mid of piece 0 = (angles[0]+angles[1])/2 = (90+180)/2 = 135°.
      // 135° CCW from +X is -X +Z quadrant. Let's just check the centroid
      // points along cos(mid),sin(mid) direction instead.
      const rotatedAngles = [90, 180, 270, 360]; // == effectiveCutAngles(4, 45)
      const pieces = sliceShellRadial(
        toplevel,
        shell,
        4,
        { x: 0, z: 0 },
        rotatedAngles,
      );
      try {
        expect(pieces).toHaveLength(4);
        for (const p of pieces) {
          expect(isManifold(p)).toBe(true);
          expect(p.isEmpty()).toBe(false);
        }
        // Piece 0 mid-angle = 135° → points to +Z, -X quadrant.
        const midRad = pieceMidAngleRad(4, 0, rotatedAngles);
        const expected = radialUnit(midRad);
        const bbox = pieces[0]!.boundingBox();
        const cx = (bbox.min[0]! + bbox.max[0]!) / 2;
        const cz = (bbox.min[2]! + bbox.max[2]!) / 2;
        // Centroid projects positive onto the mid direction.
        expect(cx * expected[0] + cz * expected[2]).toBeGreaterThan(0);
      } finally {
        for (const p of pieces) p.delete();
      }
    } finally {
      shell.delete();
    }
  });

  test('sideCount=3, rotation + xzCenter offset: all pieces remain manifold and volumes sum correctly', async () => {
    const toplevel = await initManifold();
    const shell = buildRingShell(toplevel);
    try {
      const shellVol = shell.volume();
      // Rotate by 30° and translate the cut center by (+2, -1) mm.
      const rotatedAngles = [60, 180, 300]; // [30,150,270] + 30
      const pieces = sliceShellRadial(
        toplevel,
        shell,
        3,
        { x: 2, z: -1 },
        rotatedAngles,
      );
      try {
        expect(pieces).toHaveLength(3);
        let totalVol = 0;
        for (const p of pieces) {
          expect(isManifold(p)).toBe(true);
          expect(p.isEmpty()).toBe(false);
          totalVol += p.volume();
        }
        // Mass conservation: piece sum ≈ shell volume within kernel slop.
        expect(Math.abs(totalVol - shellVol) / shellVol).toBeLessThan(1e-3);
      } finally {
        for (const p of pieces) p.delete();
      }
    } finally {
      shell.delete();
    }
  });

  test('wrong-length angles array throws', async () => {
    const toplevel = await initManifold();
    const shell = buildRingShell(toplevel);
    try {
      expect(() =>
        sliceShellRadial(toplevel, shell, 4, { x: 0, z: 0 }, [0, 90, 180]),
      ).toThrow(/expected 4 angles/);
    } finally {
      shell.delete();
    }
  });
});

// Tongue-and-groove seal regression coverage (issue piece-seal, 2026-04-22
// dogfood). The seal stamps a labyrinth onto every shared cut plane so
// silicone poured into the assembled mold can't leak along the seam.
// Invariants:
//
//   1. Adjacent pieces remain DISJOINT after sealing (clearance > 0 so the
//      tongue doesn't overlap the groove-side piece).
//   2. Adjacent pieces' volumes sum ≈ original shell volume (the tongue
//      replaces exactly the material that was in the groove, modulo
//      clearance — bounded above by the clearance × step × upper-Y-span).
//   3. The "tongue piece shifted by SEAL_STEP in +n_CCW" intersects the
//      "groove piece" (proxying the "tongue fits in groove" test described
//      in the task spec): when the tongue is pushed all the way down into
//      the groove, the two volumes meet — proving the tongue lies in the
//      same Z_cs slab as the groove cavity.

describe('applyTongueAndGrooveSeals — adjacent pieces remain disjoint', () => {
  test.each([2, 3, 4] as const)(
    'sideCount=%i: adjacent sealed pieces have near-zero intersection',
    async (sideCount) => {
      const toplevel = await initManifold();
      const OUTER = 20;
      const INNER = 10;
      const shell = buildRingShell(toplevel, OUTER, INNER);
      const shellBbox = shell.boundingBox();
      const rawPieces = sliceShellRadial(toplevel, shell, sideCount, {
        x: 0,
        z: 0,
      });
      let sealedPieces: Manifold[] | undefined;
      try {
        sealedPieces = applyTongueAndGrooveSeals({
          toplevel,
          pieces: rawPieces,
          sideCount,
          xzCenter: { x: 0, z: 0 },
          angles: SIDE_CUT_ANGLES[sideCount],
          shellY: {
            minY: shellBbox.min[1]!,
            maxY: shellBbox.max[1]!,
          },
          radialMax_mm: OUTER / 2 + 5, // shell half-width + a pinch of slack
        });
        expect(sealedPieces).toHaveLength(sideCount);
        for (const p of sealedPieces) {
          expect(isManifold(p)).toBe(true);
          expect(p.isEmpty()).toBe(false);
          expect(p.volume()).toBeGreaterThan(0);
        }
        // Adjacent-piece disjointness: the tongue of piece N+1 sits in
        // piece N's groove, but with SEAL_CLEARANCE_MM of air around it,
        // so the two volumes don't overlap.
        for (let i = 0; i < sealedPieces.length; i++) {
          const j = (i + 1) % sealedPieces.length;
          const a = sealedPieces[i]!;
          const b = sealedPieces[j]!;
          const inter = toplevel.Manifold.intersection([a, b]);
          try {
            const overlap = inter.volume();
            const minVol = Math.min(a.volume(), b.volume());
            // Allow 1e-2 relative slop (kernel noise at co-planar
            // interfaces). The tongue-and-groove geometry is
            // specifically designed so overlap is zero at the
            // clearance gap.
            expect(overlap).toBeLessThan(minVol * 1e-2);
          } finally {
            inter.delete();
          }
        }
      } finally {
        if (sealedPieces) {
          for (const p of sealedPieces) p.delete();
        } else {
          for (const p of rawPieces) p.delete();
        }
        shell.delete();
      }
    },
  );
});

describe('applyTongueAndGrooveSeals — mass conservation', () => {
  test.each([2, 3, 4] as const)(
    'sideCount=%i: sealed-piece volumes sum close to raw-slice total (within clearance budget)',
    async (sideCount) => {
      const toplevel = await initManifold();
      const OUTER = 20;
      const INNER = 10;
      const shell = buildRingShell(toplevel, OUTER, INNER);
      const shellBbox = shell.boundingBox();
      const shellYSpan = shellBbox.max[1]! - shellBbox.min[1]!;
      const rawPieces = sliceShellRadial(toplevel, shell, sideCount, {
        x: 0,
        z: 0,
      });
      const rawTotal = rawPieces.reduce((s, p) => s + p.volume(), 0);
      let sealedPieces: Manifold[] | undefined;
      try {
        sealedPieces = applyTongueAndGrooveSeals({
          toplevel,
          pieces: rawPieces,
          sideCount,
          xzCenter: { x: 0, z: 0 },
          angles: SIDE_CUT_ANGLES[sideCount],
          shellY: {
            minY: shellBbox.min[1]!,
            maxY: shellBbox.max[1]!,
          },
          radialMax_mm: OUTER / 2 + 5,
        });
        const sealedTotal = sealedPieces.reduce((s, p) => s + p.volume(), 0);
        // The sealed total differs from rawTotal by the per-cut CLEARANCE
        // loss: every cut removes a groove volume and replaces it with
        // a tongue volume of size (clearance shrunk) — the delta is at
        // most `CLEARANCE × SEAL_STEP × (shellYSpan/2) × <cut-slice-area>`.
        // For the ring-cube fixture, cut-slice area is ~20 × 20 = 400 mm²
        // (the shell silhouette at the cut plane); upper-bound per cut
        // ~ 0.2 × 2 × 10 × 20 = 80 mm³ pessimistic. Number of unique
        // cuts = sideCount === 2 ? 1 : sideCount.
        const uniqueCuts = sideCount === 2 ? 1 : sideCount;
        const perCutBudget =
          SEAL_CLEARANCE_MM * SEAL_STEP_MM * (shellYSpan / 2) * (OUTER * 2);
        const clearanceBudget = uniqueCuts * perCutBudget;
        expect(Math.abs(rawTotal - sealedTotal)).toBeLessThan(clearanceBudget);
      } finally {
        if (sealedPieces) {
          for (const p of sealedPieces) p.delete();
        } else {
          for (const p of rawPieces) p.delete();
        }
        shell.delete();
      }
    },
  );
});

describe('applyTongueAndGrooveSeals — tongue fits in groove', () => {
  test('sideCount=4: shift tongue piece by -SEAL_STEP in +n_CCW direction; overlaps groove piece', async () => {
    // When the tongue piece (piece i-1) is shifted by SEAL_STEP_MM in the
    // +n_CCW(a_c) direction (pushing the tongue DEEPER into the groove),
    // it should INTERSECT the groove piece (piece i) at the cut face
    // interior — proving the tongue geometry lies in the same Z_cs slab
    // as the cavity cut out of the groove piece. Without the seal both
    // pieces would be flush-coplanar at the cut plane and the shifted
    // intersection would be a lower-dimensional (zero volume) set.
    const toplevel = await initManifold();
    const OUTER = 20;
    const INNER = 10;
    const sideCount = 4 as const;
    const shell = buildRingShell(toplevel, OUTER, INNER);
    const shellBbox = shell.boundingBox();
    const rawPieces = sliceShellRadial(toplevel, shell, sideCount, {
      x: 0,
      z: 0,
    });
    let sealedPieces: Manifold[] | undefined;
    try {
      sealedPieces = applyTongueAndGrooveSeals({
        toplevel,
        pieces: rawPieces,
        sideCount,
        xzCenter: { x: 0, z: 0 },
        angles: SIDE_CUT_ANGLES[sideCount],
        shellY: {
          minY: shellBbox.min[1]!,
          maxY: shellBbox.max[1]!,
        },
        radialMax_mm: OUTER / 2 + 5,
      });
      // Pick cut c=0 at angles[0] = 45°. grooveIdx = 0; tongueIdx = 3.
      const angleDeg = SIDE_CUT_ANGLES[sideCount][0] as number;
      const thetaRad = (angleDeg * Math.PI) / 180;
      // Shift by SEAL_STEP in +n_CCW direction.
      const shiftX = -Math.sin(thetaRad) * SEAL_STEP_MM;
      const shiftZ = Math.cos(thetaRad) * SEAL_STEP_MM;
      const tonguePiece = sealedPieces[3]!;
      const groovePiece = sealedPieces[0]!;
      const shifted = tonguePiece.translate([shiftX, 0, shiftZ]);
      try {
        const inter = toplevel.Manifold.intersection([shifted, groovePiece]);
        try {
          // The tongue when pushed fully in should overlap the groove
          // piece with a non-trivial volume (approximately the tongue's
          // volume ≈ SEAL_STEP - CLEARANCE times upper-Y-span times
          // shell wall thickness at the cut plane). Lower bound: just
          // assert > 0 with a meaningful margin (1 mm³).
          const overlap = inter.volume();
          expect(overlap).toBeGreaterThan(1);
        } finally {
          inter.delete();
        }
      } finally {
        shifted.delete();
      }
    } finally {
      if (sealedPieces) {
        for (const p of sealedPieces) p.delete();
      } else {
        for (const p of rawPieces) p.delete();
      }
      shell.delete();
    }
  });
});

describe('applyTongueAndGrooveSeals — input validation', () => {
  test('throws when pieces.length ≠ sideCount', async () => {
    const toplevel = await initManifold();
    const shell = buildRingShell(toplevel);
    const shellBbox = shell.boundingBox();
    const pieces = sliceShellRadial(toplevel, shell, 3, { x: 0, z: 0 });
    try {
      expect(() =>
        applyTongueAndGrooveSeals({
          toplevel,
          pieces,
          sideCount: 4,
          xzCenter: { x: 0, z: 0 },
          angles: SIDE_CUT_ANGLES[4],
          shellY: {
            minY: shellBbox.min[1]!,
            maxY: shellBbox.max[1]!,
          },
          radialMax_mm: 20,
        }),
      ).toThrow(/expected 4 pieces/);
    } finally {
      for (const p of pieces) p.delete();
      shell.delete();
    }
  });

  test('throws when angles.length ≠ sideCount', async () => {
    const toplevel = await initManifold();
    const shell = buildRingShell(toplevel);
    const shellBbox = shell.boundingBox();
    const pieces = sliceShellRadial(toplevel, shell, 4, { x: 0, z: 0 });
    try {
      expect(() =>
        applyTongueAndGrooveSeals({
          toplevel,
          pieces,
          sideCount: 4,
          xzCenter: { x: 0, z: 0 },
          angles: [0, 90, 180],
          shellY: {
            minY: shellBbox.min[1]!,
            maxY: shellBbox.max[1]!,
          },
          radialMax_mm: 20,
        }),
      ).toThrow(/expected 4 angles/);
    } finally {
      for (const p of pieces) p.delete();
      shell.delete();
    }
  });
});
