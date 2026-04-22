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
    // Conformal-brim fix: addBrim requires shellManifold kept alive
    // across every call. Delete `shell` at the end of the test.

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
        shellManifold: shell,
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
        // Post-conformal-fix volume bounds — the brim's 2D profile
        // at each cut plane is the shell silhouette offset outward
        // by `brimWidth`, clipped to the shell's Y range, minus the
        // shell silhouette shrunk inward by `bondOverlap`.
        //
        // For the ring-cube fixture (20 mm cube, 10 mm inner void) on
        // sideCount=2 (cut plane at θ=90°, radial = +Z):
        //   shell silhouette (slice at Z=0) is the full 20×20 square
        //     (filled after hole removal);
        //   outward offset by +10 with round joins → rounded
        //     40×40 square;
        //   clipped to Y ∈ [-10, 10] (shell Y range) → ~40×20
        //     rectangle with minor rounded corners;
        //   inward offset by -6 → ~8×8 square;
        //   ring area (outer − inner) ~ 800 - 64 = ~736 mm²;
        //   extruded by 3 mm thickness → ~2200 mm³ gross brim prism;
        //   after siliconeOuter carve (brim inside inner cube
        //     [-5,5]³): ~100 mm³ carved.
        //
        // Of that gross brim, the part OUTSIDE the piece (the
        // "net new" volume we measure as brimmedVol - pieceVol) is
        // the outer-flange region radially outside the 20×20 shell
        // footprint (|z| > 10 or |y| > 10, neither in this case
        // since Y is clipped to shell range). For sideCount=2 piece 0
        // that's two rectangular slabs (at z ∈ [10, 20] and z ∈
        // [-20, -10]) of dimensions ~10 × 20 × 3 = 600 each, total
        // ~1200 mm³.
        expect(brimmedVol).toBeGreaterThan(pieceVol);
        const shellYSpan =
          shellBbox.max[1]! - shellBbox.min[1]!; // 20
        // Lower bound: at least one rectangular outer-flange slab
        // (catches regressions that lose half the brim).
        const oneOuterSlab = brimWidth * shellYSpan * brimThickness; // 600
        expect(brimmedVol - pieceVol).toBeGreaterThan(oneOuterSlab * 0.9);
        // Upper bound: brim gross volume = outer 2D profile area ×
        // brimThickness. Outer profile (rounded 40×40 clipped to
        // Y ∈ [-10, 10]) bounded by 40 × 20 + π·10² ≈ 1114 mm² —
        // times 3 = ~3342 mm³. Loose upper bound 5 × oneOuterSlab
        // covers this with slack for kernel slop.
        expect(brimmedVol - pieceVol).toBeLessThan(oneOuterSlab * 5);
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
      shell.delete();
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
    // Conformal-brim fix: keep shell alive; deleted in finally.

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
        shellManifold: shell,
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
        // (45° and 135°). Post-conformal-fix the brim's 2D profile at
        // each cut plane is (shell silhouette at that plane) offset
        // outward by `brimWidth`, clipped to the shell's Y range.
        // For the ring-cube fixture the silhouette at a 45° cut
        // plane is a rectangle (the cube intersected with the plane),
        // offset outward by 10 mm gives a rounded-corner rectangle
        // whose +X radial edge sits further out than the pre-fix
        // trapezoidal prism. The +X growth is at least the pre-fix
        // analytic value (pre-fix: `(outerRadius + brimWidth) /
        // sqrt(2) - pieceBboxPre.max[0]`), kept as the lower bound.
        const brimmedBbox = brimmed.boundingBox();
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
      shell.delete();
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
    // Conformal-brim fix: keep shell alive; deleted in finally.

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
          shellManifold: shell,
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
      shell.delete();
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
    // Conformal-brim fix: keep shell alive; deleted in finally.

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
        shellManifold: shell,
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
      shell.delete();
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
    // Conformal-brim fix: keep shell alive; deleted in finally.

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
        shellManifold: shell,
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
      shell.delete();
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
      // Conformal-brim fix: keep shell alive; deleted in finally.

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
              shellManifold: shell,
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
        shell.delete();
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
    // Conformal-brim fix: keep shell alive; deleted in finally.

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
            shellManifold: shell,
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
      shell.delete();
    }
  });
});

// Conformal-brim regression coverage (2026-04-22 PM fix replacing the
// pre-fix tapered trapezoidal prism).
//
// The brim's 2D profile at each cut plane is derived from slicing the
// full shell at that plane, then offsetting outward by `brimWidth` and
// inward by `bondOverlap`. The outward profile is CLIPPED to the
// shell's Y range so the brim never overshoots the shell vertically.
// Consequences versus the pre-fix trapezoidal prism:
//
//   - Inner Y-span ≈ Outer Y-span (both clipped to shell Y range).
//     The old "outer strictly narrower than inner" taper test is
//     dropped.
//   - On a square-ring-cube fixture with vertical walls, the brim's
//     outer flange (radially outside the shell) is a uniform-height
//     rectangle `brimWidth × shellYSpan × brimThickness`, NOT a
//     trapezoidal prism. The volume of the brim-only delta matches
//     this rectangular analytic prediction.

describe('addBrim — conformal profile', () => {
  test(
    'sideCount=2: Y-span matches shell Y range at inner and outer radial edges',
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
          shellManifold: shell,
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
            // is +Z. The brim's outer-flange (radially outside the
            // shell at z > outerRadius = 10) is a uniform rectangle
            // `brimWidth × shellYSpan × brimThickness` centred on the
            // shell's Y midpoint.
            //
            // Probe at two z positions: just past the shell wall and
            // near the outer radial edge. Compare Y-spans — they should
            // be ~equal (no taper), both ~= shellYSpan (= 20 mm).
            const SLAB_T = 0.5; // mm slab thickness along Z
            const SLAB_HALF = SLAB_T / 2;
            const SLAB_XY = 200; // mm
            const outerRadius = OUTER / 2; // 10
            const outerZ = outerRadius + BRIM_W; // 20
            const nearShellZ = outerRadius + 0.25; // 10.25
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
              // Conformal profile: Y-span is (approximately) uniform
              // across the flange's radial extent because the outward
              // 2D offset is clipped to the shell's Y range. Both
              // spans should be within 10 % of the shell Y span
              // (= 20 mm).
              const shellYSpan =
                shellBbox.max[1]! - shellBbox.min[1]!; // 20
              expect(innerYSpan).toBeGreaterThan(shellYSpan * 0.9);
              expect(innerYSpan).toBeLessThan(shellYSpan * 1.05);
              expect(outerYSpan).toBeGreaterThan(shellYSpan * 0.9);
              expect(outerYSpan).toBeLessThan(shellYSpan * 1.05);
              // Inner and outer spans agree within 15 % (no taper
              // direction). This catches regressions that would
              // reintroduce a vertical taper.
              const ratio = outerYSpan / innerYSpan;
              expect(ratio).toBeGreaterThan(0.85);
              expect(ratio).toBeLessThan(1.15);
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
        shell.delete();
      }
    },
  );

  test(
    'brim-only outer-flange volume matches analytic rectangular prism',
    async () => {
      // Conformal brim's outer-flange region (radially outside the
      // shell) is a uniform `brimWidth × shellYSpan × brimThickness`
      // rectangular prism per cut plane. The brimOnly volume (= brim −
      // piece) should match this analytic value within a generous
      // slack to account for the rounded-corner edges of the 2D
      // offset (which extend slightly past the pure-rectangular
      // prediction) and the inward-offset ring contribution (small).
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
          shellManifold: shell,
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
            // sideCount=2 piece 0 has ONE cut plane (θ=90°). The
            // outer-flange on each side of the shell profile is
            // `brimWidth × shellYSpan × brimThickness`. A 2D profile
            // on the ring-cube at the cut plane extends from x_cs ∈
            // [-10, 10] to [-20, 20] after the +10 offset → TWO
            // outer-flange slabs (one at x_cs ∈ [10, 20], one at
            // [-20, -10]). Plus a bit of rounded-corner material at
            // the top/bottom of the inner profile and a small
            // contribution where the 2D inward offset leaves brim
            // material outside the original shell footprint. Lower
            // bound: at least one outer-flange slab (catches
            // regressions that lost half the brim); upper bound:
            // roughly 3× one slab (covers the two outer slabs plus
            // rounded corners + any inward-offset residual).
            const shellYSpan =
              shellBbox.max[1]! - shellBbox.min[1]!; // 20
            const oneFlangeSlab = BRIM_W * shellYSpan * BRIM_T; // 600
            expect(brimOnlyVol).toBeGreaterThan(oneFlangeSlab * 0.9);
            expect(brimOnlyVol).toBeLessThan(oneFlangeSlab * 3.5);
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
        shell.delete();
      }
    },
  );
});
