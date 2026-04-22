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
  SEAL_APEX_DEPTH_MM,
  SEAL_CLEARANCE_MM,
  SEAL_HALF_WIDTH_MM,
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

// V-chevron seal regression coverage (issue piece-seal round 2, 2026-04-22
// dogfood). The seal stamps a horizontal V-shaped tongue-and-groove
// interlock onto every shared cut plane, running the full shell height,
// so silicone poured into the assembled mold can't leak along the seam.
// Invariants:
//
//   1. Adjacent pieces remain DISJOINT after sealing (clearance > 0 so
//      the tongue doesn't overlap the groove piece).
//   2. Adjacent pieces' volumes sum ≈ original shell volume within a
//      clearance budget (the tongue/groove volume delta is bounded by
//      the 2D chevron area × Y span × clearance).
//   3. Tongue-piece extends past the cut plane into +n_CCW territory:
//      specifically, the piece's bounding-box-derived extent in +n_CCW
//      exceeds the cut plane by ≈ apexDepth − clearance/2.
//   4. Groove-piece LOSES material at the cut plane: its bounding-box
//      extent in −n_CCW direction (on its side of the cut) has a
//      notch — detectable by a cross-section volume drop at the cut
//      plane.
//
// Reference frame: cut-local coordinates (X_cs, Y_cs, Z_cs) after
// rotating world by +θ_deg about +Y. With θ = 90° (the sideCount=2
// case), that rotation sends world (cos θ, 0, sin θ) = (0, 0, 1) → +X
// and sends n_CCW(90°) = (−1, 0, 0) → +Z. Piece 0 (grooveIdx for
// sideCount=2) is on the +n_CCW side = world −X side; piece 1 (the
// tongue piece) is on world +X side.

describe('applyTongueAndGrooveSeals — V-chevron: adjacent pieces disjoint', () => {
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
          shellOuterRadius_mm: OUTER / 2,
        });
        expect(sealedPieces).toHaveLength(sideCount);
        for (const p of sealedPieces) {
          expect(isManifold(p)).toBe(true);
          expect(p.isEmpty()).toBe(false);
          expect(p.volume()).toBeGreaterThan(0);
        }
        // Adjacent-piece disjointness at every (i, i+1) pair.
        for (let i = 0; i < sealedPieces.length; i++) {
          const j = (i + 1) % sealedPieces.length;
          const a = sealedPieces[i]!;
          const b = sealedPieces[j]!;
          const inter = toplevel.Manifold.intersection([a, b]);
          try {
            const overlap = inter.volume();
            // Allow 1 mm³ — kernel co-planar slop + float rounding at
            // the clearance gap. The clearance itself is 0.2 mm so the
            // analytic air-gap volume is ≈ 0, but the kernel can leave
            // sub-mm slivers at the V's tip where tongue and groove
            // meet.
            expect(overlap).toBeLessThan(1);
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

describe('applyTongueAndGrooveSeals — V-chevron: mass conservation', () => {
  test.each([2, 3, 4] as const)(
    'sideCount=%i: sealed-piece volumes sum close to raw-slice total',
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
          shellOuterRadius_mm: OUTER / 2,
        });
        const sealedTotal = sealedPieces.reduce((s, p) => s + p.volume(), 0);
        // The sealed total differs from rawTotal by the per-cut
        // tongue/groove volume delta. Groove = subtract inflated
        // prism (half-extents + clearance/2); Tongue = union shrunk
        // prism (half-extents − clearance/2). Net delta per cut ≈
        // tongue_vol − groove_vol (both measured relative to the
        // material at the cut plane); both are O(halfWidth ×
        // apexDepth × shellYSpan).
        //
        // Upper bound per cut: (halfWidth + clearance/2) × (apexDepth
        // + clearance/2) × shellYSpan — the groove prism volume,
        // which is the larger of the two and the magnitude of the
        // biggest single change to any piece's volume.
        //
        // With sideCount=2 we have one unique cut; sideCount=3/4 have
        // `sideCount` cuts. Use this as a generous budget.
        const uniqueCuts = sideCount === 2 ? 1 : sideCount;
        const perCutGrooveVol =
          (SEAL_HALF_WIDTH_MM + SEAL_CLEARANCE_MM / 2) *
          (SEAL_APEX_DEPTH_MM + SEAL_CLEARANCE_MM / 2) *
          shellYSpan;
        const budget = uniqueCuts * perCutGrooveVol;
        expect(Math.abs(rawTotal - sealedTotal)).toBeLessThan(budget);
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

describe('applyTongueAndGrooveSeals — V-chevron: tongue + groove extents', () => {
  test('sideCount=2: tongue piece extends past cut plane into +n_CCW territory', async () => {
    // With sideCount=2, angles=[90°, 270°]. Single cut plane at 90°.
    // n_CCW(90°) = (−1, 0, 0) = world −X. Piece 0 = grooveIdx (on +n_CCW
    // side → world −X). Piece 1 = tongueIdx (on −n_CCW side → world +X).
    //
    // Without seal, piece 1's bounding box X starts at 0 (the cut plane
    // passes through x=0). With the tongue, piece 1 gains a triangular
    // prism bulging into +n_CCW = world −X direction, so its bbox MIN
    // X should drop below 0 by ≈ apexDepth − clearance/2.
    const toplevel = await initManifold();
    const OUTER = 20;
    const INNER = 10;
    const shell = buildRingShell(toplevel, OUTER, INNER);
    const shellBbox = shell.boundingBox();
    const rawPieces = sliceShellRadial(toplevel, shell, 2, { x: 0, z: 0 });
    let sealedPieces: Manifold[] | undefined;
    try {
      sealedPieces = applyTongueAndGrooveSeals({
        toplevel,
        pieces: rawPieces,
        sideCount: 2,
        xzCenter: { x: 0, z: 0 },
        angles: SIDE_CUT_ANGLES[2],
        shellY: {
          minY: shellBbox.min[1]!,
          maxY: shellBbox.max[1]!,
        },
        shellOuterRadius_mm: OUTER / 2,
      });
      const tonguePiece = sealedPieces[1]!; // world +X side
      const tongueBbox = tonguePiece.boundingBox();
      // n_CCW(90°) = world −X. Tongue bulges in +n_CCW = world −X, so
      // the piece's MIN X goes NEGATIVE by ≈ (apexDepth − clearance/2).
      // Be generous: accept any negative value ≥ half the expected
      // protrusion (kernel might shave a tiny slice).
      const expectedProtrusion = SEAL_APEX_DEPTH_MM - SEAL_CLEARANCE_MM / 2;
      expect(tongueBbox.min[0]!).toBeLessThan(-expectedProtrusion / 2);
      // And not more than the full apex depth + a smidge of slop.
      expect(tongueBbox.min[0]!).toBeGreaterThan(-(expectedProtrusion + 0.5));
    } finally {
      if (sealedPieces) {
        for (const p of sealedPieces) p.delete();
      } else {
        for (const p of rawPieces) p.delete();
      }
      shell.delete();
    }
  });

  test('sideCount=2: groove piece has a notch at the cut plane', async () => {
    // Groove piece (piece 0) sits on world −X side of the cut. The
    // groove carves a triangular cavity INTO piece 0's +n_CCW-facing
    // boundary (which in world coords is the +X side of piece 0 —
    // its cut face). The cavity's apex reaches Z_cs = +apexDepth →
    // in world, X = −(apexDepth + clearance/2). So piece 0 is MISSING
    // material in the X ∈ [0, −(apexDepth + clearance/2)] band near
    // Y_cs centered at X_apex = +shellOuterRadius = +10 along X_cs.
    //
    // Verification: intersect piece 0 with a small slab near the cut
    // plane at Y_cs ∈ [shellMinY, shellMaxY], X_cs ∈ [shellOuter −
    // halfWidth, shellOuter + halfWidth], Z_cs ∈ [−1, 0]. The slab's
    // volume inside piece 0 should be reduced relative to a shell
    // piece without the groove.
    //
    // Simpler indirect check: the groove piece's volume is strictly
    // LESS than the raw piece's volume by the groove prism volume
    // (minus any outside-the-shell overhang of the prism, which in
    // this fixture is zero because the prism sits entirely within
    // the shell ring thickness).
    const toplevel = await initManifold();
    const OUTER = 20;
    const INNER = 10;
    const shell = buildRingShell(toplevel, OUTER, INNER);
    const shellBbox = shell.boundingBox();
    const rawPieces = sliceShellRadial(toplevel, shell, 2, { x: 0, z: 0 });
    const rawGrooveVol = rawPieces[0]!.volume();
    let sealedPieces: Manifold[] | undefined;
    try {
      sealedPieces = applyTongueAndGrooveSeals({
        toplevel,
        pieces: rawPieces,
        sideCount: 2,
        xzCenter: { x: 0, z: 0 },
        angles: SIDE_CUT_ANGLES[2],
        shellY: {
          minY: shellBbox.min[1]!,
          maxY: shellBbox.max[1]!,
        },
        shellOuterRadius_mm: OUTER / 2,
      });
      const sealedGroovePiece = sealedPieces[0]!;
      const sealedGrooveVol = sealedGroovePiece.volume();
      // The groove removes volume from piece 0. The removed volume is
      // at most the full groove prism (halfWidth+c/2) × (apexDepth+c/2)
      // × shellYSpan, and at least half of that (even the ring shell
      // fixture has the cut-plane face only partially overlapping the
      // prism — the ring wall thickness is 5 mm but the prism's X span
      // is 6 mm, so the prism might extend past the ring on one side).
      const shellYSpan = shellBbox.max[1]! - shellBbox.min[1]!;
      const maxRemoved =
        (SEAL_HALF_WIDTH_MM + SEAL_CLEARANCE_MM / 2) *
        (SEAL_APEX_DEPTH_MM + SEAL_CLEARANCE_MM / 2) *
        shellYSpan;
      const delta = rawGrooveVol - sealedGrooveVol;
      // Some material was removed — the groove is non-trivial.
      expect(delta).toBeGreaterThan(0);
      // Not more than the prism's full volume.
      expect(delta).toBeLessThan(maxRemoved + 1);
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

describe('applyTongueAndGrooveSeals — V-chevron: input validation', () => {
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
          shellOuterRadius_mm: 10,
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
          shellOuterRadius_mm: 10,
        }),
      ).toThrow(/expected 4 angles/);
    } finally {
      for (const p of pieces) p.delete();
      shell.delete();
    }
  });
});
