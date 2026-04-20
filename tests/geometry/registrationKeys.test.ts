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
import type { Manifold } from 'manifold-3d';

import { initManifold, isManifold } from '@/geometry';
import {
  DEFAULT_OFFSET_MULTIPLIER,
  GeometryError,
  KEYHOLE_SLOT_LENGTH_RATIO,
  KEYHOLE_SLOT_WIDTH_RATIO,
  KEY_CLEARANCE_MM,
  KEY_DIAMETER_WALL_RATIO,
  MAX_KEY_DIAMETER_MM,
  computeKeyDiameter,
  computeKeyLayout,
  keyholeDirectionForIndex,
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

// ---------------------------------------------------------------------------
// Issue #57 — cone key style
// ---------------------------------------------------------------------------
//
// The `cone` style uses a "double cone" (two cones base-to-base at the
// parting plane) as the shared tool — analogous to the sphere tool used
// by `asymmetric-hemi`. Each protrusion/recess is an upward-pointing
// cone of height = radius (so the full key diameter-to-tip distance,
// measured tip-to-tip across the parting plane, is 2·radius =
// diameter). Expected per-key recess/protrusion volume is the upper
// cone's volume: (1/3) π r² h, with h = r, so (1/3) π r³.

describe('stampRegistrationKeys — cone style', () => {
  test('returns watertight halves; volume delta matches 3 cones', async () => {
    const toplevel = await initManifold();
    const lowerRaw = toplevel.Manifold.cube([40, 10, 40], false).translate([-20, -10, -20]);
    const upperRaw = toplevel.Manifold.cube([40, 10, 40], false).translate([-20, 0, -20]);
    const shellBbox = { min: [-20, -10, -20], max: [20, 10, 20] };
    const partingY = 0;
    const wall = 10;

    try {
      const volUpperBefore = upperRaw.volume();
      const volLowerBefore = lowerRaw.volume();

      const { updatedUpper, updatedLower } = stampRegistrationKeys(
        toplevel,
        upperRaw,
        lowerRaw,
        shellBbox,
        partingY,
        wall,
        'cone',
      );

      try {
        expect(isManifold(updatedUpper)).toBe(true);
        expect(isManifold(updatedLower)).toBe(true);

        const rKey = 1.5; // diameter = 3 mm at wall=10 → radius = 1.5
        // Per-key upper-cone volume = (1/3) π r² h, with h = r = 1.5.
        // So volume = (1/3) π r³.
        const coneVol = (1 / 3) * Math.PI * Math.pow(rKey, 3);
        const threeCones = 3 * coneVol;

        const volUpperAfter = updatedUpper.volume();
        const volLowerAfter = updatedLower.volume();

        // 32-segment cone facet-chord error is ~1.5% on a 1.5 mm radius
        // cone. A 5% relative tolerance comfortably covers that plus
        // kernel noise on union/subtract.
        const upperDelta = volUpperBefore - volUpperAfter;
        expect(Math.abs(upperDelta - threeCones) / threeCones).toBeLessThan(0.05);
        const lowerDelta = volLowerAfter - volLowerBefore;
        expect(Math.abs(lowerDelta - threeCones) / threeCones).toBeLessThan(0.05);
      } finally {
        updatedUpper.delete();
        updatedLower.delete();
      }
    } finally {
      upperRaw.delete();
      lowerRaw.delete();
    }
  }, 30_000);

  test('asymmetric +Z key: upper-half rotated 180° about Y does not mate with lower half', async () => {
    // Mirrors the asymmetric-hemi orientation test at the generator level.
    // If the upper half's +Z recess swaps to −Z under a 180° Y rotation,
    // the lower half's +Z protrusion is unopposed — re-uniting the two
    // halves no longer yields the same volume as the upright case.
    const toplevel = await initManifold();
    const lowerRaw = toplevel.Manifold.cube([40, 10, 40], false).translate([-20, -10, -20]);
    const upperRaw = toplevel.Manifold.cube([40, 10, 40], false).translate([-20, 0, -20]);
    const shellBbox = { min: [-20, -10, -20], max: [20, 10, 20] };

    try {
      const { updatedUpper, updatedLower } = stampRegistrationKeys(
        toplevel,
        upperRaw,
        lowerRaw,
        shellBbox,
        0,
        10,
        'cone',
      );

      let rotatedUpper: Manifold | undefined;
      let upright: Manifold | undefined;
      let rotatedUnion: Manifold | undefined;
      try {
        upright = toplevel.Manifold.union([updatedUpper, updatedLower]);
        rotatedUpper = updatedUpper.rotate([0, 180, 0]);
        rotatedUnion = toplevel.Manifold.union([rotatedUpper, updatedLower]);

        const uprightVol = upright.volume();
        const rotatedVol = rotatedUnion.volume();
        expect(Math.abs(uprightVol - rotatedVol)).toBeGreaterThan(1e-2);
      } finally {
        if (upright) upright.delete();
        if (rotatedUpper) rotatedUpper.delete();
        if (rotatedUnion) rotatedUnion.delete();
        updatedUpper.delete();
        updatedLower.delete();
      }
    } finally {
      upperRaw.delete();
      lowerRaw.delete();
    }
  }, 30_000);

  test('throws GeometryError on a tall-skinny bbox (same clamp branch as hemi)', async () => {
    const toplevel = await initManifold();
    const lower = toplevel.Manifold.cube([4, 10, 40], false).translate([-2, -10, -20]);
    const upper = toplevel.Manifold.cube([4, 10, 40], false).translate([-2, 0, -20]);
    const shellBbox = { min: [-2, -10, -20], max: [2, 10, 20] };
    try {
      expect(() =>
        stampRegistrationKeys(toplevel, upper, lower, shellBbox, 0, 10, 'cone'),
      ).toThrow(GeometryError);
    } finally {
      upper.delete();
      lower.delete();
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #57 — keyhole key style
// ---------------------------------------------------------------------------
//
// The `keyhole` tool is a radially-oriented circle + rectangular slot
// extruded symmetrically across the parting plane. Per-key cross-section
// area = π r² (circle) + slot-rect-area − circle-rect-overlap. The
// rectangle extends from x = −radius to x = +diameter with width =
// radius (centred on y=0 in the 2D cross-section). The overlap between
// circle + rectangle is HARD to close-form because the rectangle's
// −radius edge sits INSIDE the circle. Rather than hand-derive the
// exact volume, we assert:
//
//   1. Both halves remain watertight manifolds after stamping.
//   2. Upper half LOSES volume; lower half GAINS volume (sign invariants).
//   3. The absolute volume delta is between one sphere-hemi volume
//      (a lower bound — the circle alone matches the hemi case) and
//      three times the tool's full-extrude volume (an upper bound —
//      no two keys' slots overlap in the silicone ring).
//   4. The 180°-about-Y rotation test proves the asymmetric +Z key is
//      honoured.

describe('keyholeDirectionForIndex', () => {
  test('maps layout indices to the correct radial direction', () => {
    expect(keyholeDirectionForIndex(0)).toBe('x-neg'); // −X key
    expect(keyholeDirectionForIndex(1)).toBe('x-pos'); // +X key
    expect(keyholeDirectionForIndex(2)).toBe('z-pos'); // +Z key
  });

  test('throws on out-of-range indices', () => {
    expect(() => keyholeDirectionForIndex(-1)).toThrow(/out of range/);
    expect(() => keyholeDirectionForIndex(3)).toThrow(/out of range/);
  });

  test('pins the slot-width + slot-length ratio constants', () => {
    // Issue #57: slot width = diameter / 2, slot length = diameter.
    expect(KEYHOLE_SLOT_WIDTH_RATIO).toBe(0.5);
    expect(KEYHOLE_SLOT_LENGTH_RATIO).toBe(1.0);
  });
});

describe('stampRegistrationKeys — keyhole style', () => {
  test('returns watertight halves; volume delta is bounded and has the right sign', async () => {
    const toplevel = await initManifold();
    const lowerRaw = toplevel.Manifold.cube([40, 10, 40], false).translate([-20, -10, -20]);
    const upperRaw = toplevel.Manifold.cube([40, 10, 40], false).translate([-20, 0, -20]);
    const shellBbox = { min: [-20, -10, -20], max: [20, 10, 20] };

    try {
      const volUpperBefore = upperRaw.volume();
      const volLowerBefore = lowerRaw.volume();

      const { updatedUpper, updatedLower } = stampRegistrationKeys(
        toplevel,
        upperRaw,
        lowerRaw,
        shellBbox,
        0,
        10,
        'keyhole',
      );

      try {
        expect(isManifold(updatedUpper)).toBe(true);
        expect(isManifold(updatedLower)).toBe(true);

        // Per-key tool's upper half (above parting) volume:
        //   tool cross-section area = πr² (circle) + slot_rect_area -
        //                             circle∩slot_rect_area.
        //
        // Analytic bounds (per key, upper-half only — depth = diameter/2 = r):
        //   Lower bound on area: the circle alone = π r²
        //     → upper-half volume ≥ π r² × r = π r³
        //   Upper bound on area: circle + full slot rect with no overlap
        //     slot width = r, slot length outer = 2r, slot length inner = -r
        //     slot rect area = r × (2r - (-r)) = r × 3r = 3 r² → WRONG,
        //     correct slot rect area = width × total_length = r × 3r = 3r².
        //     + circle = π r². Total < 3r² + π r² ≈ 6.14 r².
        //     → upper-half volume ≤ 6.14 r³.
        //
        // For r = 1.5: π r³ ≈ 10.6 mm³;
        //              6.14 r³ ≈ 20.7 mm³ per key upper-half; × 3 keys
        //              = [31.8, 62.2] mm³ for the 3-key delta.
        const rKey = 1.5;
        const threeLowerBound = 3 * Math.PI * Math.pow(rKey, 3);
        // Upper bound: circle + slot area (no overlap correction). The
        // rectangle extends from x = -r to x = +2r, so its area = 3r × r = 3r²;
        // plus circle π r². Total per-key area ≤ (3 + π) r². Times depth r,
        // times 3 keys.
        const threeUpperBound = 3 * (3 + Math.PI) * Math.pow(rKey, 3);

        const volUpperAfter = updatedUpper.volume();
        const volLowerAfter = updatedLower.volume();

        // Upper half: volume DECREASED by the 3-key recess total.
        const upperDelta = volUpperBefore - volUpperAfter;
        expect(upperDelta).toBeGreaterThan(0);
        expect(upperDelta).toBeGreaterThanOrEqual(threeLowerBound * 0.95);
        expect(upperDelta).toBeLessThanOrEqual(threeUpperBound * 1.05);

        // Lower half: volume INCREASED by the same total (kernel noise
        // aside). We apply the same bounds — the protrusion volume
        // equals the recess volume for a parting-plane-symmetric tool.
        const lowerDelta = volLowerAfter - volLowerBefore;
        expect(lowerDelta).toBeGreaterThan(0);
        expect(lowerDelta).toBeGreaterThanOrEqual(threeLowerBound * 0.95);
        expect(lowerDelta).toBeLessThanOrEqual(threeUpperBound * 1.05);

        // Protrusion volume ≈ recess volume (symmetry about parting plane).
        // 5% relative bound to absorb kernel / facet noise.
        expect(Math.abs(upperDelta - lowerDelta) / upperDelta).toBeLessThan(0.05);
      } finally {
        updatedUpper.delete();
        updatedLower.delete();
      }
    } finally {
      upperRaw.delete();
      lowerRaw.delete();
    }
  }, 30_000);

  test('asymmetric +Z key: upper-half rotated 180° about Y does not mate with lower half', async () => {
    // Same orientation-enforcement invariant as the hemi + cone tests.
    const toplevel = await initManifold();
    const lowerRaw = toplevel.Manifold.cube([40, 10, 40], false).translate([-20, -10, -20]);
    const upperRaw = toplevel.Manifold.cube([40, 10, 40], false).translate([-20, 0, -20]);
    const shellBbox = { min: [-20, -10, -20], max: [20, 10, 20] };

    try {
      const { updatedUpper, updatedLower } = stampRegistrationKeys(
        toplevel,
        upperRaw,
        lowerRaw,
        shellBbox,
        0,
        10,
        'keyhole',
      );

      let rotatedUpper: Manifold | undefined;
      let upright: Manifold | undefined;
      let rotatedUnion: Manifold | undefined;
      try {
        upright = toplevel.Manifold.union([updatedUpper, updatedLower]);
        rotatedUpper = updatedUpper.rotate([0, 180, 0]);
        rotatedUnion = toplevel.Manifold.union([rotatedUpper, updatedLower]);

        const uprightVol = upright.volume();
        const rotatedVol = rotatedUnion.volume();
        expect(Math.abs(uprightVol - rotatedVol)).toBeGreaterThan(1e-2);
      } finally {
        if (upright) upright.delete();
        if (rotatedUpper) rotatedUpper.delete();
        if (rotatedUnion) rotatedUnion.delete();
        updatedUpper.delete();
        updatedLower.delete();
      }
    } finally {
      upperRaw.delete();
      lowerRaw.delete();
    }
  }, 30_000);

  test('throws GeometryError on a tall-skinny bbox (same clamp branch as hemi)', async () => {
    const toplevel = await initManifold();
    const lower = toplevel.Manifold.cube([4, 10, 40], false).translate([-2, -10, -20]);
    const upper = toplevel.Manifold.cube([4, 10, 40], false).translate([-2, 0, -20]);
    const shellBbox = { min: [-2, -10, -20], max: [2, 10, 20] };
    try {
      expect(() =>
        stampRegistrationKeys(toplevel, upper, lower, shellBbox, 0, 10, 'keyhole'),
      ).toThrow(GeometryError);
    } finally {
      upper.delete();
      lower.delete();
    }
  });
});
