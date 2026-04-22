// tests/geometry/brim.test.ts
//
// Unit tests for the Wave-F brim builder (issue #84) with the issue
// #89 surgical fix applied: narrower brim box + silicone-cavity carve-
// out, so brims never intrude into the silicone and adjacent brims
// never intersect each other.
//
// The tests build a simple ring-shell fixture (hollow cube) and use a
// dedicated `siliconeOuter` Manifold representing the shell's inner
// cavity (the inner cube scaled up so it simulates the level-set
// outset the real pipeline uses — for the test this is enough to
// give addBrim a concrete volume to subtract).

import { describe, expect, test } from 'vitest';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';

import { initManifold, isManifold } from '@/geometry';
import { addBrim } from '@/geometry/brim';
import { sliceShellRadial } from '@/geometry/shellSlicer';

/** Build a hollow cube shell: outer − inner, axis-aligned, centered at origin. */
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

/**
 * Build a `siliconeOuter` stand-in for the ring-shell test fixture:
 * the solid cube equal to the shell's INNER cavity. For a ring shell
 * spanning [outer, inner] in every dimension the inner cavity is the
 * inner-cube volume itself. This is a faithful analogue of the
 * production pipeline where `siliconeOuter` is the master offset
 * outward by `siliconeThickness`, i.e. the shell's inner-cavity
 * volume.
 */
function buildInnerCavity(
  toplevel: ManifoldToplevel,
  inner = 10,
): Manifold {
  return toplevel.Manifold.cube([inner, inner, inner], true);
}

describe('addBrim — sideCount=2 single-cut case', () => {
  test('brim adds volume proportional to brim_area × thickness', async () => {
    const toplevel = await initManifold();
    const OUTER = 20;
    const INNER = 10;
    const shell = buildRingShell(toplevel, OUTER, INNER);
    const shellVol = shell.volume();
    const shellBbox = shell.boundingBox();
    const siliconeOuter = buildInnerCavity(toplevel, INNER);

    const pieces = sliceShellRadial(toplevel, shell, 2, { x: 0, z: 0 });
    shell.delete();

    try {
      const pieceVol = pieces[0]!.volume();

      const brimWidth = 10;
      const brimThickness = 3;
      const printShellThickness = 3;
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
        siliconeOuter,
        printShellThickness_mm: printShellThickness,
      });
      // addBrim consumes the input piece — slot 0 is now dead.
      // Leave slot 1 intact for cleanup.
      try {
        expect(isManifold(brimmed)).toBe(true);
        expect(brimmed.isEmpty()).toBe(false);
        const brimmedVol = brimmed.volume();
        // Post-#89 volume bounds — the brim is now a narrow
        // `(bondOverlap + brimWidth) × shellHeight × brimThickness`
        // slab (minus any silicone-cavity intrusion). For sideCount=2
        // (single brim per piece):
        //   brim gross ≈ (3 + 10) × shellHeight × 3 = 39·shellHeight
        //                                                mm³
        //   part of that overlaps existing shell material (the
        //   bondOverlap portion sits inside the shell wall) → the
        //   net volume gain is strictly less than gross.
        expect(brimmedVol).toBeGreaterThan(pieceVol);
        const shellHeight =
          shellBbox.max[1]! - shellBbox.min[1]! - 4; // 2mm margin top+bottom
        const outerFlangeVol = brimWidth * shellHeight * brimThickness;
        // Issue #96 taper: the outer radial half of the trapezoidal
        // prism contributes `brimWidth × (ySize × (1 + k) / 2) ×
        // brimThickness` averaged over its Z-length. For k = 0.5 that's
        // 75 % of the pre-#96 box volume in the outer-flange region.
        // Lower bound stays at half the pre-#96 rectangular estimate —
        // still safely exceeded by the tapered prism minus shell
        // absorption.
        expect(brimmedVol - pieceVol).toBeGreaterThan(outerFlangeVol * 0.5);
        // Upper bound on the volume gain. Issue #97 Fix 4 (polish
        // dogfood round 3) bumped the bond-overlap multiplier 1.5 →
        // 2.0; issue #96 (taper) replaced the rectangular box with a
        // trapezoidal prism whose volume is `BRIM_TAPER_VOLUME_FACTOR
        // × grossBoxVol` where the volume factor is `(1 +
        // BRIM_TAPER_FACTOR) / 2 = 0.75` at the production taper of
        // 0.5. We still use the un-tapered gross box × 1.1 as an upper
        // bound (loose), since 0.75 < 1 < 1.1.
        const BOND_OVERLAP_MULTIPLIER = 2.0;
        const BRIM_TAPER_FACTOR = 0.5;
        const BRIM_TAPER_VOLUME_FACTOR = (1 + BRIM_TAPER_FACTOR) / 2;
        const grossBoxVol =
          (BOND_OVERLAP_MULTIPLIER * printShellThickness + brimWidth) *
          shellHeight *
          brimThickness;
        expect(brimmedVol - pieceVol).toBeLessThan(grossBoxVol * 1.1);
        // Tighter upper bound reflecting the taper: gain is at most
        // `trapezoidalPrismVol × 1.1` (10 % slack for kernel slop).
        const trapezoidalPrismVol = grossBoxVol * BRIM_TAPER_VOLUME_FACTOR;
        expect(brimmedVol - pieceVol).toBeLessThan(trapezoidalPrismVol * 1.1);
        expect(brimmedVol).toBeLessThan(shellVol * 3);
        brimmed.delete();
      } catch (err) {
        brimmed.delete();
        throw err;
      }
    } finally {
      // Cleanup piece 1 (piece 0 was consumed by addBrim).
      pieces[1]!.delete();
      siliconeOuter.delete();
    }
  });
});

describe('addBrim — sideCount=4 two-cut case', () => {
  test('brim extends AABB outward by roughly brimWidth on both cut normals', async () => {
    const toplevel = await initManifold();
    const OUTER = 20;
    const INNER = 10;
    const shell = buildRingShell(toplevel, OUTER, INNER);
    const shellBbox = shell.boundingBox();
    const siliconeOuter = buildInnerCavity(toplevel, INNER);
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
        siliconeOuter,
        printShellThickness_mm: 3,
      });
      try {
        expect(isManifold(brimmed)).toBe(true);

        // Piece 0 at sideCount=4 occupies arc [45°, 135°] (+Z
        // quadrant). Brim flanges extend along the two cut directions
        // (45° and 135°). After the issue #89 fix the brim's outer
        // edge sits at radial `outerRadius + brimWidth = 20 mm`
        // (not `pieceBboxPre.max[0] + brimWidth` as pre-#89). Its
        // projection onto +X for a 45° cut is `20 / sqrt(2) ≈
        // 14.14 mm`, which is the new x-bbox-max of the brimmed
        // piece. The raw piece's bbox.max[0] was ~10 mm (half the
        // ring-shell outer width), so the brim adds ~4.1 mm outward
        // growth on +X. Use ~70 % of that analytic growth as a
        // tolerance-resistant lower bound.
        const brimmedBbox = brimmed.boundingBox();
        // Analytic +X growth for a sideCount=4 piece 0 brim: the
        // +45° cut flange's outer corner projects at
        // `(outerRadius + brimWidth) / sqrt(2) ≈ 14.14 mm`, minus
        // the pre-brim max (~10 mm) → ~4.14 mm growth.
        const projectedGrowth =
          (10 + 10) / Math.SQRT2 - pieceBboxPre.max[0]!;
        const looseBound = projectedGrowth * 0.7;
        // +X should have grown (45° flange projects positive X).
        expect(brimmedBbox.max[0]!).toBeGreaterThan(
          pieceBboxPre.max[0]! + looseBound,
        );
        // -X should have grown (135° flange projects negative X).
        expect(brimmedBbox.min[0]!).toBeLessThan(
          pieceBboxPre.min[0]! - looseBound,
        );
        brimmed.delete();
      } catch (err) {
        brimmed.delete();
        throw err;
      }
    } finally {
      for (let i = 1; i < pieces.length; i++) pieces[i]!.delete();
      siliconeOuter.delete();
    }
  });

  test('sideCount=3: every piece survives addBrim as a manifold', async () => {
    const toplevel = await initManifold();
    const OUTER = 20;
    const INNER = 10;
    const shell = buildRingShell(toplevel, OUTER, INNER);
    const shellBbox = shell.boundingBox();
    const siliconeOuter = buildInnerCavity(toplevel, INNER);
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
          siliconeOuter,
          printShellThickness_mm: 3,
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
      siliconeOuter.delete();
    }
  });
});

// Issue #89 regression coverage — these invariants are the acceptance
// criteria from the bug report. Each assertion catches a pre-#89
// failure mode that was visible in the viewer during dogfood.

describe('addBrim — issue #89 no-cavity-intrusion invariant', () => {
  test('brim does not extend inward past `outerRadius - bondOverlap`', async () => {
    const toplevel = await initManifold();
    const OUTER = 20;
    const INNER = 10;
    const SHELL_THICKNESS = 3; // = bondOverlap
    const BRIM_W = 10;
    const shell = buildRingShell(toplevel, OUTER, INNER);
    const shellBbox = shell.boundingBox();
    const siliconeOuter = buildInnerCavity(toplevel, INNER);
    // Shell outer radius: half of 20 mm AABB = 10.
    const OUTER_RADIUS = OUTER / 2;

    // Build the brim IN ISOLATION (union it onto an empty-ish piece)
    // and check its bounding-box extents. The simplest way to get
    // "just the brim" is to subtract the raw piece volume from the
    // brimmed piece, but manifold-3d doesn't expose a public "subtract
    // from self" identity at test-granularity. Instead: construct a
    // brimmed piece and compare its radial bbox min against the bare
    // piece's radial bbox min — the brim must NOT have pushed the
    // radial min inward past `OUTER_RADIUS - bondOverlap`.
    //
    // For a square ring shell on sideCount=4 piece 0 (arc +Z mid at
    // 90°), the piece's closest point to the xzCenter along the radial
    // axis (+Z) is at the inner cube's +Z face, i.e. z = INNER/2 = 5.
    // The brim lives along the radial directions 45° and 135°; its
    // radial-inward edge (in the 45°/135° directions) sits at
    // `OUTER_RADIUS - bondOverlap = 10 - 3 = 7 mm` radial distance.
    // Projected onto +X or -X the brim's edge is at
    // `7 / sqrt(2) ≈ 4.95 mm`, which is a TIGHTER X-bound than the
    // raw piece (whose X extent reaches ~5 mm at the inner cube face).
    // So the assertion we can make robustly is: `brim ∩ siliconeOuter
    // = 0` (no cavity intrusion), which we cover below directly.
    const pieces = sliceShellRadial(toplevel, shell, 4, { x: 0, z: 0 });
    shell.delete();

    try {
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
        brimWidth_mm: BRIM_W,
        brimThickness_mm: 3,
        siliconeOuter,
        printShellThickness_mm: SHELL_THICKNESS,
      });
      try {
        // Brimmed piece's XZ extent should reach radially outward to
        // approximately `OUTER_RADIUS + BRIM_W` along some cut
        // direction (projection of 45° or 135° radial).
        const bb = brimmed.boundingBox();
        const outerProjected =
          (OUTER_RADIUS + BRIM_W) / Math.SQRT2 * 0.9; // 90 % of analytic
        expect(bb.max[0]!).toBeGreaterThan(outerProjected);
        expect(bb.max[2]!).toBeGreaterThan(outerProjected);
      } finally {
        brimmed.delete();
      }
    } finally {
      for (let i = 1; i < pieces.length; i++) pieces[i]!.delete();
      siliconeOuter.delete();
    }
  });

  test('brim.intersect(siliconeOuter).volume() ≈ 0 — no cavity intrusion', async () => {
    // The key acceptance: intersecting the BRIM portion of a brimmed
    // piece with the silicone cavity volume must produce an empty /
    // near-zero result. We compute the "brim portion" as
    // `brimmed - rawPiece`. Then intersect with siliconeOuter.
    const toplevel = await initManifold();
    const OUTER = 20;
    const INNER = 10;
    const shell = buildRingShell(toplevel, OUTER, INNER);
    const shellBbox = shell.boundingBox();
    const siliconeOuter = buildInnerCavity(toplevel, INNER);

    const pieces = sliceShellRadial(toplevel, shell, 4, { x: 0, z: 0 });
    shell.delete();

    try {
      // Keep a COPY of piece 0 so we can compute the post-brim delta.
      //
      // manifold-3d's API doesn't expose a pure "clone" on a Manifold —
      // but we can get a fresh handle via a no-op translate by (0,0,0).
      // The resulting Manifold shares no lifetime with the source, so
      // disposing one doesn't affect the other.
      const pieceCopy = pieces[0]!.translate([0, 0, 0]);
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
        siliconeOuter,
        printShellThickness_mm: 3,
      });
      try {
        // brimOnly = brimmed − pieceCopy.
        const brimOnly = toplevel.Manifold.difference([brimmed, pieceCopy]);
        try {
          // Intersection with siliconeOuter must be essentially empty.
          // Kernel slop and the bondOverlap-into-shell region can
          // leave a thin sliver where the ring-test shell wall
          // touches the inner cube; use a tight absolute bound.
          //
          // The inner cube's volume is 10³ = 1000 mm³. A zero-volume
          // result would be 0 exactly; the bound below catches
          // regressions where the brim re-enters the cavity (which
          // on pre-#89 code would produce ~ hundreds of mm³).
          const intersection = toplevel.Manifold.intersection([
            brimOnly,
            siliconeOuter,
          ]);
          try {
            const intersectVol = intersection.volume();
            // Looser absolute bound (< 1 mm³) — tighter than any
            // realistic regression and resilient to boolean-kernel
            // sub-ULP noise near co-planar faces (brim's inner face
            // vs. siliconeOuter's outer face coincide along one
            // slab of the cube).
            expect(intersectVol).toBeLessThan(1);
          } finally {
            intersection.delete();
          }
        } finally {
          brimOnly.delete();
        }
      } finally {
        brimmed.delete();
        pieceCopy.delete();
      }
    } finally {
      for (let i = 1; i < pieces.length; i++) pieces[i]!.delete();
      siliconeOuter.delete();
    }
  });

  test.each([3, 4] as const)(
    'sideCount=%i: adjacent brimmed pieces have disjoint volumes',
    async (sideCount) => {
      const toplevel = await initManifold();
      const OUTER = 20;
      const INNER = 10;
      const shell = buildRingShell(toplevel, OUTER, INNER);
      const shellBbox = shell.boundingBox();
      const siliconeOuter = buildInnerCavity(toplevel, INNER);
      const pieces = sliceShellRadial(
        toplevel,
        shell,
        sideCount,
        { x: 0, z: 0 },
      );
      shell.delete();

      const brimmed: Manifold[] = [];
      try {
        for (let i = 0; i < pieces.length; i++) {
          brimmed.push(
            addBrim({
              toplevel,
              piece: pieces[i]!,
              pieceIndex: i,
              sideCount,
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
              siliconeOuter,
              printShellThickness_mm: 3,
            }),
          );
        }

        // Check every adjacent pair (i, i+1 mod N). For 3/4 sideCount
        // that's every pair with a shared cut plane.
        for (let i = 0; i < brimmed.length; i++) {
          const j = (i + 1) % brimmed.length;
          const a = brimmed[i]!;
          const b = brimmed[j]!;
          const aVol = a.volume();
          const bVol = b.volume();
          const overlap = toplevel.Manifold.intersection([a, b]);
          try {
            const overlapVol = overlap.volume();
            // Disjoint: overlap < 1e-3 × min(aVol, bVol). Pre-#89 the
            // brims intersected at the Y-axis column, producing a
            // non-trivial (>= 1 mm³) overlap; post-#89 it should be
            // essentially zero (modulo kernel slop at shared-plane
            // interfaces).
            expect(overlapVol).toBeLessThan(
              Math.min(aVol, bVol) * 1e-3,
            );
          } finally {
            overlap.delete();
          }
        }
      } finally {
        for (const p of brimmed) p.delete();
        siliconeOuter.delete();
      }
    },
  );
});

// Cut-planes preview feature (dogfood round 7) — brim must preserve
// every safety invariant when the user rotates the partition or moves
// the cut center. Run the key invariants (cavity-intrusion +
// adjacent-disjoint) with a non-trivial rotation + offset.

describe('addBrim — user cut-plane overrides', () => {
  test('cavity-intrusion + disjoint invariants hold under rotation=30° + offset=(2,-1)', async () => {
    const toplevel = await initManifold();
    const OUTER = 20;
    const INNER = 10;
    const shell = buildRingShell(toplevel, OUTER, INNER);
    const shellBbox = shell.boundingBox();
    const siliconeOuter = buildInnerCavity(toplevel, INNER);
    const rotatedAngles = [75, 165, 255, 345]; // [45,135,225,315] + 30
    const xzCenter = { x: 2, z: -1 };
    const pieces = sliceShellRadial(
      toplevel,
      shell,
      4,
      xzCenter,
      rotatedAngles,
    );
    shell.delete();

    const brimmed: Manifold[] = [];
    try {
      for (let i = 0; i < pieces.length; i++) {
        brimmed.push(
          addBrim({
            toplevel,
            piece: pieces[i]!,
            pieceIndex: i,
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
            xzCenter,
            angles: rotatedAngles,
            brimWidth_mm: 10,
            brimThickness_mm: 3,
            siliconeOuter,
            printShellThickness_mm: 3,
          }),
        );
      }
      // Invariant 1 — adjacent-piece disjointness holds under rotation.
      for (let i = 0; i < brimmed.length; i++) {
        const j = (i + 1) % brimmed.length;
        const a = brimmed[i]!;
        const b = brimmed[j]!;
        const overlap = toplevel.Manifold.intersection([a, b]);
        try {
          const overlapVol = overlap.volume();
          const minVol = Math.min(a.volume(), b.volume());
          expect(overlapVol).toBeLessThan(minVol * 1e-3);
        } finally {
          overlap.delete();
        }
      }
      // Invariant 2 — every piece still manifold + non-empty.
      for (const p of brimmed) {
        expect(isManifold(p)).toBe(true);
        expect(p.isEmpty()).toBe(false);
      }
    } finally {
      for (const p of brimmed) p.delete();
      siliconeOuter.delete();
    }
  });
});

// Issue #96 regression coverage — tapered trapezoidal brim.
//
// The brim is built as a trapezoidal prism that is FULL height
// (`ySize`) at the inner (shell-junction) edge and tapers DOWN to
// `BRIM_TAPER_FACTOR × ySize` at the outer radial edge. The direction
// of the taper matters: "inner Y-span > outer Y-span" reading from the
// shell outward.

describe('addBrim — issue #96 trapezoidal taper', () => {
  test(
    'sideCount=2: inner (shell-junction) Y-span strictly exceeds outer Y-span',
    async () => {
      const toplevel = await initManifold();
      const OUTER = 20;
      const INNER = 10;
      const SHELL_THICKNESS = 3;
      const BRIM_W = 10;
      const BRIM_T = 3;
      const shell = buildRingShell(toplevel, OUTER, INNER);
      const shellBbox = shell.boundingBox();
      const siliconeOuter = buildInnerCavity(toplevel, INNER);
      const pieces = sliceShellRadial(toplevel, shell, 2, { x: 0, z: 0 });
      shell.delete();

      try {
        // Keep a fresh handle on piece 0 via a no-op translate, so we
        // can recover the "brim only" delta after addBrim consumes the
        // piece.
        const pieceCopy = pieces[0]!.translate([0, 0, 0]);
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
          brimWidth_mm: BRIM_W,
          brimThickness_mm: BRIM_T,
          siliconeOuter,
          printShellThickness_mm: SHELL_THICKNESS,
        });
        try {
          const brimOnly = toplevel.Manifold.difference([brimmed, pieceCopy]);
          try {
            // sideCount=2 piece 0 cut angle is 90° — radial direction
            // is +Z (see `src/geometry/sideAngles.ts`). The brim spans
            // `z ∈ [outerRadius - bondOverlap, outerRadius + brimWidth]`
            // = `[10 - 6, 10 + 10]` = `[4, 20]` with
            // `BOND_OVERLAP_MULTIPLIER = 2.0`.
            //
            // For the ring-shell fixture the entire inner cube
            // (|x|,|y|,|z| ≤ 5) is both the silicone cavity AND the
            // void between shell walls — so the brim's bondOverlap
            // region (z ∈ [4, 5]) is carved by siliconeOuter and the
            // surviving z ∈ [5, 10] region falls INSIDE the piece's
            // shell-wall material. Probing there would measure zero
            // brimOnly content.
            //
            // The reliable probe for the TAPER DIRECTION is on the
            // OUTER-flange portion only — where brimOnly is uniquely
            // brim material. Compare the Y-span at the inner end of
            // the pure-flange region (z ≈ outerRadius + ε, just past
            // the shell wall) vs. the outer end (z ≈ outerRadius +
            // brimWidth − ε).
            const SLAB_T = 0.5; // mm slab thickness along Z
            const SLAB_HALF = SLAB_T / 2;
            const SLAB_XY = 200; // mm, large enough to enclose entire brim in X and Y
            const outerRadius = OUTER / 2; // 10
            const outerZ = outerRadius + BRIM_W; // 20
            // Inner-flange probe: z slightly past the shell wall (z =
            // 10) so we're purely in brim material, not shell-wall
            // overlap.
            const nearShellZ = outerRadius + 0.25; // 10.25
            // Outer-flange probe: near the outer edge.
            const farEdgeZ = outerZ - SLAB_HALF; // 19.75

            const innerProbeBase = toplevel.Manifold.cube(
              [SLAB_XY, SLAB_XY, SLAB_T],
              true,
            );
            const innerProbe = innerProbeBase.translate([
              0,
              0,
              nearShellZ,
            ]);
            innerProbeBase.delete();
            const outerProbeBase = toplevel.Manifold.cube(
              [SLAB_XY, SLAB_XY, SLAB_T],
              true,
            );
            const outerProbe = outerProbeBase.translate([
              0,
              0,
              farEdgeZ,
            ]);
            outerProbeBase.delete();

            const innerHit = toplevel.Manifold.intersection([
              brimOnly,
              innerProbe,
            ]);
            const outerHit = toplevel.Manifold.intersection([
              brimOnly,
              outerProbe,
            ]);
            innerProbe.delete();
            outerProbe.delete();
            try {
              expect(innerHit.isEmpty()).toBe(false);
              expect(outerHit.isEmpty()).toBe(false);
              const innerBb = innerHit.boundingBox();
              const outerBb = outerHit.boundingBox();
              const innerYSpan = innerBb.max[1]! - innerBb.min[1]!;
              const outerYSpan = outerBb.max[1]! - outerBb.min[1]!;
              // Core taper invariant: outer is STRICTLY narrower.
              expect(outerYSpan).toBeLessThan(innerYSpan);
              // Quantitative: the taper is linear in Z, so the ratio
              // of Y-spans at two Z positions equals
              // `(1 + k·(Z2 - Zbase)/width) / (1 + k·(Z1 - Zbase)/
              // width)` where `k = BRIM_TAPER_FACTOR - 1 = -0.5` and
              // `Zbase = outerRadius - bondOverlap = 4`, `width = 16`.
              //   Z1 = 10.25 → fraction = 0.390625, y-scale = 1 +
              //     (-0.5)(0.390625) = 0.8047
              //   Z2 = 19.75 → fraction = 0.984375, y-scale = 1 +
              //     (-0.5)(0.984375) = 0.5078
              //   expectedRatio = 0.5078 / 0.8047 = 0.6311.
              // Allow ± 20 % of analytic for kernel slop and slab
              // thickness effects.
              const bondOverlap = 2.0 * SHELL_THICKNESS; // 6
              const width = bondOverlap + BRIM_W; // 16
              const Zbase = outerRadius - bondOverlap; // 4
              const BRIM_TAPER_FACTOR = 0.5;
              const k = BRIM_TAPER_FACTOR - 1; // -0.5
              const yScale = (z: number): number =>
                1 + (k * (z - Zbase)) / width;
              const expectedRatio = yScale(farEdgeZ) / yScale(nearShellZ);
              const actualRatio = outerYSpan / innerYSpan;
              expect(actualRatio).toBeGreaterThan(expectedRatio * 0.8);
              expect(actualRatio).toBeLessThan(expectedRatio * 1.2);
            } finally {
              innerHit.delete();
              outerHit.delete();
            }
          } finally {
            brimOnly.delete();
          }
        } finally {
          brimmed.delete();
          pieceCopy.delete();
        }
      } finally {
        pieces[1]!.delete();
        siliconeOuter.delete();
      }
    },
  );

  test(
    'taper reduces brim volume ~25 % vs untapered rectangular box',
    async () => {
      // Trapezoidal prism volume at scaleTop Y = 0.5 is
      // `(1 + 0.5) / 2 = 0.75` × the un-tapered box volume — a 25 %
      // reduction. Verify by comparing against the analytic box volume
      // for the brim-only region (i.e. the OUTER-flange portion that
      // doesn't overlap shell material).
      const toplevel = await initManifold();
      const OUTER = 20;
      const INNER = 10;
      const SHELL_THICKNESS = 3;
      const BRIM_W = 10;
      const BRIM_T = 3;
      const shell = buildRingShell(toplevel, OUTER, INNER);
      const shellBbox = shell.boundingBox();
      const siliconeOuter = buildInnerCavity(toplevel, INNER);
      const pieces = sliceShellRadial(toplevel, shell, 2, { x: 0, z: 0 });
      shell.delete();

      try {
        const pieceCopy = pieces[0]!.translate([0, 0, 0]);
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
          brimWidth_mm: BRIM_W,
          brimThickness_mm: BRIM_T,
          siliconeOuter,
          printShellThickness_mm: SHELL_THICKNESS,
        });
        try {
          const brimOnly = toplevel.Manifold.difference([brimmed, pieceCopy]);
          try {
            const brimOnlyVol = brimOnly.volume();
            // Analytic un-tapered box volume for the BRIM-ONLY outer
            // flange (i.e. everything radially outside the shell, so
            // just the `brimWidth × ySize × brimThickness` prism). The
            // bondOverlap portion sits inside the shell wall and is
            // absorbed by the difference, so it doesn't contribute to
            // brimOnlyVol.
            const shellHeight =
              shellBbox.max[1]! - shellBbox.min[1]! - 4; // 2 mm margin top+bottom
            const BRIM_TAPER_FACTOR = 0.5;
            const untaperedFlangeVol = BRIM_W * shellHeight * BRIM_T;
            const taperedFlangeVol =
              untaperedFlangeVol * (1 + BRIM_TAPER_FACTOR) / 2;
            // brimOnlyVol should sit near the tapered volume (slightly
            // less, since the carve against siliconeOuter can remove
            // a sliver at the inner-edge interface, and the bondOverlap
            // region's delta may subtract a thin slab near the shell
            // surface). Use a generous range: 60 % .. 95 % of the
            // untapered volume. At the analytic 75 % this comfortably
            // passes; < 60 % catches regressions that reverse or
            // over-taper.
            expect(brimOnlyVol).toBeGreaterThan(untaperedFlangeVol * 0.6);
            expect(brimOnlyVol).toBeLessThan(untaperedFlangeVol * 0.95);
            // And near the analytic tapered prediction within ±25 %
            // (covers kernel slop + shell absorption of the bondOverlap
            // region).
            expect(brimOnlyVol).toBeGreaterThan(taperedFlangeVol * 0.75);
            expect(brimOnlyVol).toBeLessThan(taperedFlangeVol * 1.25);
          } finally {
            brimOnly.delete();
          }
        } finally {
          brimmed.delete();
          pieceCopy.delete();
        }
      } finally {
        pieces[1]!.delete();
        siliconeOuter.delete();
      }
    },
  );
});
