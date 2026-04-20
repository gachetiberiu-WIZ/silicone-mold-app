// tests/geometry/registrationKeys.test.ts
//
// Vitest coverage for the Wave-3 registration-key stamper (issue #55,
// `src/geometry/registrationKeys.ts`).
//
// These tests stay at the pure-algorithm level: clamp formula, layout
// math, tall-skinny throw, and a minimal end-to-end stamping on hand-
// built cube halves (no silicone-shell pipeline involvement, so each
// test is O(10 ms)). The full generator integration lives in
// `generateMold.test.ts`.

import { describe, expect, test } from 'vitest';

import { initManifold, isManifold } from '@/geometry';
import {
  DEFAULT_OFFSET_MULTIPLIER,
  GeometryError,
  KEY_CLEARANCE_MM,
  KEY_DIAMETER_WALL_RATIO,
  MAX_KEY_DIAMETER_MM,
  computeKeyDiameter,
  computeKeyLayout,
  resolveKeyOffsets,
  stampRegistrationKeys,
} from '@/geometry/registrationKeys';

describe('computeKeyDiameter', () => {
  test('returns the wall-ratio value when wall is thin enough', () => {
    // 10 mm wall × 0.3 ratio = 3 mm, below the 4 mm cap → ratio wins.
    expect(computeKeyDiameter(10)).toBeCloseTo(3, 10);
    // Also pin the constants so a future edit surfaces as a failure.
    expect(MAX_KEY_DIAMETER_MM).toBe(4);
    expect(KEY_DIAMETER_WALL_RATIO).toBe(0.3);
  });

  test('caps at MAX_KEY_DIAMETER_MM on thick walls', () => {
    // 20 mm wall × 0.3 = 6 mm, capped to 4 mm.
    expect(computeKeyDiameter(20)).toBe(4);
    // Right at the knee: 4 mm cap / 0.3 ratio ≈ 13.33 mm wall.
    expect(computeKeyDiameter(13.333)).toBeCloseTo(4, 2);
  });
});

describe('resolveKeyOffsets — clamp formula', () => {
  test('returns default multiplier when the ring is wide enough', () => {
    // 40 mm ring, 1.5 mm key radius, 1 mm clearance → safeHalf = 20 − 1.5 − 1 = 17.5;
    // maxMult = 17.5 / 20 = 0.875 → default 0.35 wins.
    const r = resolveKeyOffsets(40, 40, 1.5);
    expect(r.multX).toBe(DEFAULT_OFFSET_MULTIPLIER);
    expect(r.multZ).toBe(DEFAULT_OFFSET_MULTIPLIER);
  });

  test('clamps inward when the default would push a key outside the safe zone', () => {
    // Narrow ring: 10 mm wide, 1.5 mm radius, 1 mm clearance.
    // half = 5; safeHalf = 5 − 1.5 − 1 = 2.5; maxMult = 2.5 / 5 = 0.5.
    // Default 0.35 still wins here — the clamp kicks in only if the
    // default exceeds maxMult.
    const wide = resolveKeyOffsets(10, 10, 1.5);
    expect(wide.multX).toBe(0.35);

    // 8 mm ring, 2 mm radius, 1 mm clearance.
    // half = 4; safeHalf = 4 − 2 − 1 = 1; maxMult = 1 / 4 = 0.25.
    // Default 0.35 > 0.25 → clamp kicks in.
    const clamped = resolveKeyOffsets(8, 8, 2);
    expect(clamped.multX).toBeCloseTo(0.25, 6);
    expect(clamped.multZ).toBeCloseTo(0.25, 6);
  });

  test('throws GeometryError on a tall-skinny ring where safeHalf <= 0', () => {
    // 4 mm wide ring, 1.5 mm radius, 1 mm clearance.
    // half = 2; safeHalf = 2 − 1.5 − 1 = −0.5 → no valid placement.
    expect(() => resolveKeyOffsets(4, 20, 1.5)).toThrow(GeometryError);
    expect(() => resolveKeyOffsets(4, 20, 1.5)).toThrow(/too thin/);
    // Axis label in the message surfaces which axis is the offender.
    expect(() => resolveKeyOffsets(4, 20, 1.5)).toThrow(/X half-width/);
    expect(() => resolveKeyOffsets(20, 4, 1.5)).toThrow(/Z half-width/);
  });

  test('clearance + radius constants are respected', () => {
    // Pin the clearance constant so the formula math above doesn't
    // silently drift if someone loosens the mm clearance.
    expect(KEY_CLEARANCE_MM).toBe(1);
  });
});

describe('computeKeyLayout', () => {
  test('places 3 keys symmetrically at ±X and +Z on a centred bbox', () => {
    // 40 × 10 × 40 ring centred at origin.
    const bbox = {
      min: [-20, -5, -20],
      max: [20, 5, 20],
    };
    const wall = 10;
    const layout = computeKeyLayout(bbox, wall);

    // Diameter = min(4, 0.3 × 10) = 3 → radius = 1.5.
    expect(layout.radius).toBeCloseTo(1.5, 10);

    // Both axes wide → default multiplier 0.35 on each.
    expect(layout.multX).toBe(0.35);
    expect(layout.multZ).toBe(0.35);

    // Centre-X = 0, ringWidth_X/2 = 20 → offsetX = 0.35 × 20 = 7.
    // Positions: (−7, 0), (+7, 0), (0, +7).
    expect(layout.positions).toHaveLength(3);
    expect(layout.positions[0]).toEqual({ x: -7, z: 0 });
    expect(layout.positions[1]).toEqual({ x: 7, z: 0 });
    expect(layout.positions[2]).toEqual({ x: 0, z: 7 });
  });

  test('anchor key on +Z is NOT mirrored on −Z — asymmetry enforces orientation', () => {
    const bbox = { min: [-20, -5, -20], max: [20, 5, 20] };
    const layout = computeKeyLayout(bbox, 10);
    const zs = layout.positions.map((p) => p.z).sort((a, b) => a - b);
    // We should have exactly ONE key at +Z, the other two at Z=0. No
    // key at −Z.
    expect(zs.filter((z) => z > 0).length).toBe(1);
    expect(zs.filter((z) => z < 0).length).toBe(0);
    expect(zs.filter((z) => z === 0).length).toBe(2);
  });

  test('offsets scale with an off-origin bbox', () => {
    // Shifted bbox — key centres should follow.
    const bbox = { min: [10, 0, 100], max: [50, 10, 140] };
    const layout = computeKeyLayout(bbox, 10);
    const centreX = 30;
    const centreZ = 120;
    const ringHalfX = 20;
    const ringHalfZ = 20;
    const offsetX = 0.35 * ringHalfX;
    const offsetZ = 0.35 * ringHalfZ;
    expect(layout.positions[0]!.x).toBeCloseTo(centreX - offsetX, 10);
    expect(layout.positions[1]!.x).toBeCloseTo(centreX + offsetX, 10);
    expect(layout.positions[2]!.z).toBeCloseTo(centreZ + offsetZ, 10);
    // All three keys at Z = centreZ (for keys 0+1) or offsetZ above
    // centre (for key 2).
    expect(layout.positions[0]!.z).toBeCloseTo(centreZ, 10);
    expect(layout.positions[1]!.z).toBeCloseTo(centreZ, 10);
  });

  test('throws on tall-skinny bbox that cannot accept keys', () => {
    // 5 mm wide → half=2.5; radius=1.5 (10 mm wall); safeHalf=0 → throw.
    const bbox = { min: [-2.5, 0, -20], max: [2.5, 10, 20] };
    expect(() => computeKeyLayout(bbox, 10)).toThrow(GeometryError);
  });
});

describe('stampRegistrationKeys — end-to-end on minimal cube halves', () => {
  // The generator feeds pre-split silicone halves. For a unit test we
  // hand-build two cube "halves" that share the Y=0 parting plane. This
  // doesn't exercise the full silicone pipeline; it exercises the
  // stamper's CSG discipline in isolation.

  test('returns two watertight halves; mass is conserved within kernel noise', async () => {
    const toplevel = await initManifold();
    // Lower half = 40 × 10 × 40 cube spanning Y ∈ [−10, 0].
    const lowerRaw = toplevel.Manifold.cube([40, 10, 40], false).translate([-20, -10, -20]);
    // Upper half = same footprint spanning Y ∈ [0, 10].
    const upperRaw = toplevel.Manifold.cube([40, 10, 40], false).translate([-20, 0, -20]);

    const shellBbox = { min: [-20, -10, -20], max: [20, 10, 20] };
    const partingY = 0;
    const wall = 10;

    try {
      expect(isManifold(upperRaw)).toBe(true);
      expect(isManifold(lowerRaw)).toBe(true);

      // Volumes before stamping (analytic: 40 × 10 × 40 = 16 000).
      const volUpperBefore = upperRaw.volume();
      const volLowerBefore = lowerRaw.volume();
      expect(volUpperBefore).toBeCloseTo(16000, 5);
      expect(volLowerBefore).toBeCloseTo(16000, 5);

      const { updatedUpper, updatedLower } = stampRegistrationKeys(
        toplevel,
        upperRaw,
        lowerRaw,
        shellBbox,
        partingY,
        wall,
      );

      try {
        expect(isManifold(updatedUpper)).toBe(true);
        expect(isManifold(updatedLower)).toBe(true);

        // Volume deltas match the key geometry:
        // - Lower gets 3 protrusions (upper hemispheres above partingY,
        //   each = (2/3) π r³). Radius = 1.5 → per-hemi volume = 7.0686 mm³.
        // - Upper loses 3 recesses of the same size.
        const rKey = 1.5;
        const hemiVol = (2 / 3) * Math.PI * Math.pow(rKey, 3);
        const threeHemis = 3 * hemiVol;

        const volUpperAfter = updatedUpper.volume();
        const volLowerAfter = updatedLower.volume();
        // Upper should lose ~threeHemis of material. A 5% relative
        // tolerance covers the sphere-32-segment facet-chord error on
        // the hemisphere's curved surface (~2-3%) plus kernel noise.
        const upperDelta = volUpperBefore - volUpperAfter;
        expect(Math.abs(upperDelta - threeHemis) / threeHemis).toBeLessThan(0.05);
        // Lower should gain ~threeHemis of material.
        const lowerDelta = volLowerAfter - volLowerBefore;
        expect(Math.abs(lowerDelta - threeHemis) / threeHemis).toBeLessThan(0.05);
      } finally {
        updatedUpper.delete();
        updatedLower.delete();
      }
    } finally {
      upperRaw.delete();
      lowerRaw.delete();
    }
  }, 30_000);

  test('throws GeometryError when the bbox is tall-skinny', async () => {
    const toplevel = await initManifold();
    // 4 mm wide cube — too narrow to fit a 10 mm wall's 3 mm key.
    const lower = toplevel.Manifold.cube([4, 10, 40], false).translate([-2, -10, -20]);
    const upper = toplevel.Manifold.cube([4, 10, 40], false).translate([-2, 0, -20]);
    const shellBbox = { min: [-2, -10, -20], max: [2, 10, 20] };
    try {
      expect(() =>
        stampRegistrationKeys(toplevel, upper, lower, shellBbox, 0, 10),
      ).toThrow(GeometryError);
    } finally {
      upper.delete();
      lower.delete();
    }
  });
});
