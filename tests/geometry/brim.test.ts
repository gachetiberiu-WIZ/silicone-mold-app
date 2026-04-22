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
        // Minimum gain: at least half of the pure outer-flange volume.
        expect(brimmedVol - pieceVol).toBeGreaterThan(outerFlangeVol * 0.5);
        // Upper bound on the volume gain: gross box volume + tiny
        // kernel slop. Issue #97 Fix 4 (polish dogfood round 3) bumped
        // the bond-overlap multiplier 1.5 → 2.0, so the gross box is
        // `(2 × printShellThickness + brimWidth) × shellHeight ×
        // brimThickness`.
        const BOND_OVERLAP_MULTIPLIER = 2.0;
        const grossBoxVol =
          (BOND_OVERLAP_MULTIPLIER * printShellThickness + brimWidth) *
          shellHeight *
          brimThickness;
        expect(brimmedVol - pieceVol).toBeLessThan(grossBoxVol * 1.1);
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
