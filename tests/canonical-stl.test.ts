// tests/canonical-stl.test.ts
//
// Tests for the canonical-STL pipeline:
//   - SHA-256 determinism on two successive runs with the same input.
//   - Triangle reordering doesn't change the hash.
//   - Vertex-cycle rotation within a triangle doesn't change the hash.
//   - Coordinate jitter below the 1e-5 quantisation floor doesn't change the hash.
//   - Coordinate change above the quantisation floor *does* change the hash.
//   - Fixture-driven path: `unit-cube` loads + hashes deterministically if
//     the fixture is committed (skipped otherwise per issue #1 AC).

import { describe, expect, test } from 'vitest';
import { canonicalStlBytes, stlSha256 } from './canonical-stl';
import { fixtureExists, loadFixture } from './fixtures/meshes/loader';

/**
 * Synthetic unit-cube (1×1×1 mm centered at the origin) as a flat-positions
 * mesh: 12 triangles, 36 vertices, 9 floats per triangle. Built by hand so
 * the canonical-STL tests don't depend on fixture availability.
 */
function makeUnitCube(): { positions: Float32Array } {
  // 8 corners.
  const v = [
    [-0.5, -0.5, -0.5], // 0
    [0.5, -0.5, -0.5], // 1
    [0.5, 0.5, -0.5], // 2
    [-0.5, 0.5, -0.5], // 3
    [-0.5, -0.5, 0.5], // 4
    [0.5, -0.5, 0.5], // 5
    [0.5, 0.5, 0.5], // 6
    [-0.5, 0.5, 0.5], // 7
  ];
  // Outward-facing triangles.
  const tris: number[][] = [
    // -Z face
    [0, 2, 1],
    [0, 3, 2],
    // +Z face
    [4, 5, 6],
    [4, 6, 7],
    // -Y face
    [0, 1, 5],
    [0, 5, 4],
    // +Y face
    [3, 7, 6],
    [3, 6, 2],
    // -X face
    [0, 4, 7],
    [0, 7, 3],
    // +X face
    [1, 2, 6],
    [1, 6, 5],
  ];
  const positions = new Float32Array(tris.length * 9);
  for (let t = 0; t < tris.length; t++) {
    for (let j = 0; j < 3; j++) {
      const vert = v[tris[t]![j]!]!;
      const o = t * 9 + j * 3;
      positions[o] = vert[0]!;
      positions[o + 1] = vert[1]!;
      positions[o + 2] = vert[2]!;
    }
  }
  return { positions };
}

describe('canonicalStlBytes + stlSha256', () => {
  test('hash is deterministic across two successive runs', () => {
    const cube = makeUnitCube();
    const h1 = stlSha256(cube);
    const h2 = stlSha256(cube);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  test('canonical bytes are identical across two runs', () => {
    const cube = makeUnitCube();
    const b1 = canonicalStlBytes(cube);
    const b2 = canonicalStlBytes(cube);
    expect(b1.length).toBe(b2.length);
    expect(Buffer.from(b1).equals(Buffer.from(b2))).toBe(true);
  });

  test('hash is invariant under triangle reordering', () => {
    const cube = makeUnitCube();
    const reversed = new Float32Array(cube.positions.length);
    const triCount = cube.positions.length / 9;
    for (let t = 0; t < triCount; t++) {
      const src = (triCount - 1 - t) * 9;
      const dst = t * 9;
      for (let k = 0; k < 9; k++) reversed[dst + k] = cube.positions[src + k]!;
    }
    expect(stlSha256({ positions: reversed })).toBe(stlSha256(cube));
  });

  test('hash is invariant under within-triangle vertex rotation', () => {
    const cube = makeUnitCube();
    const rotated = new Float32Array(cube.positions.length);
    const triCount = cube.positions.length / 9;
    for (let t = 0; t < triCount; t++) {
      const o = t * 9;
      // (v0, v1, v2) -> (v1, v2, v0) — same winding, rotated cycle.
      const src = cube.positions;
      rotated[o] = src[o + 3]!;
      rotated[o + 1] = src[o + 4]!;
      rotated[o + 2] = src[o + 5]!;
      rotated[o + 3] = src[o + 6]!;
      rotated[o + 4] = src[o + 7]!;
      rotated[o + 5] = src[o + 8]!;
      rotated[o + 6] = src[o]!;
      rotated[o + 7] = src[o + 1]!;
      rotated[o + 8] = src[o + 2]!;
    }
    expect(stlSha256({ positions: rotated })).toBe(stlSha256(cube));
  });

  test('sub-quantisation jitter does not change the hash', () => {
    const cube = makeUnitCube();
    const jittered = new Float32Array(cube.positions.length);
    for (let i = 0; i < cube.positions.length; i++) {
      // 1e-7 is well below the 1e-5 quantisation floor.
      jittered[i] = cube.positions[i]! + 1e-7;
    }
    expect(stlSha256({ positions: jittered })).toBe(stlSha256(cube));
  });

  test('above-quantisation change does flip the hash', () => {
    const cube = makeUnitCube();
    const shifted = new Float32Array(cube.positions);
    shifted[0] = shifted[0]! + 0.01; // 1e-2 mm shift, well above 1e-5.
    expect(stlSha256({ positions: shifted })).not.toBe(stlSha256(cube));
  });

  test('accepts manifold-style { vertProperties, triVerts } input', () => {
    const vertProperties = new Float32Array([
      -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
    ]);
    const triVerts = new Uint32Array([0, 2, 1, 0, 3, 2]);
    const h = stlSha256({ vertProperties, triVerts, numProp: 3 });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('canonicalStlBytes + stlSha256 — fixture path', () => {
  test.skipIf(!fixtureExists('unit-cube'))(
    'unit-cube fixture hash is deterministic across two loads',
    async () => {
      const f1 = await loadFixture('unit-cube');
      const f2 = await loadFixture('unit-cube');
      const h1 = stlSha256({
        vertProperties: f1.manifold.vertProperties,
        triVerts: f1.manifold.triVerts,
        numProp: 3,
      });
      const h2 = stlSha256({
        vertProperties: f2.manifold.vertProperties,
        triVerts: f2.manifold.triVerts,
        numProp: 3,
      });
      expect(h1).toBe(h2);
    },
  );
});
