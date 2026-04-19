// tests/geometry/adapters.test.ts
//
// Unit-level tests for the BufferGeometry ↔ Manifold adapter layer and
// `isManifold()` predicate. Uses manifold-3d primitive constructors so the
// tests don't depend on any fixture being present.

import { BufferAttribute, BufferGeometry } from 'three';
import { describe, expect, test } from 'vitest';
import {
  bufferGeometryToManifold,
  initManifold,
  isManifold,
  manifoldToBufferGeometry,
  meshVolume,
} from '@/geometry';

describe('adapters — primitive round-trip', () => {
  test('manifold-3d cube → BufferGeometry preserves volume', async () => {
    const toplevel = await initManifold();
    // Origin-centred 1×1×1 cube built via Manifold constructor so we don't
    // depend on any fixture. Volume is exactly 1 mm³.
    const cube = toplevel.Manifold.cube([1, 1, 1], true);
    try {
      expect(isManifold(cube)).toBe(true);
      expect(meshVolume(cube)).toBeCloseTo(1.0, 6);

      const bg = await manifoldToBufferGeometry(cube);
      expect(bg.getAttribute('position')).toBeDefined();
      expect(bg.getAttribute('normal')).toBeDefined();
      // 12 triangles × 3 verts × 3 floats = 108. Manifold may decompose the
      // six faces into more than two triangles if it ever changes its
      // triangulation, so we assert a lower bound rather than exact equality.
      expect(bg.getAttribute('position').count).toBeGreaterThanOrEqual(36);
    } finally {
      cube.delete();
    }
  });

  test('BufferGeometry → Manifold via bufferGeometryToManifold round-trips', async () => {
    const toplevel = await initManifold();
    const original = toplevel.Manifold.cube([2, 2, 2], true);
    try {
      const bg = await manifoldToBufferGeometry(original);
      const roundTripped = await bufferGeometryToManifold(bg);
      try {
        expect(isManifold(roundTripped)).toBe(true);
        // 2×2×2 cube = 8 mm³.
        expect(meshVolume(roundTripped)).toBeCloseTo(8.0, 4);
      } finally {
        roundTripped.delete();
      }
    } finally {
      original.delete();
    }
  });

  test('bufferGeometryToManifold handles indexed geometry', async () => {
    // Hand-built indexed unit cube centred at origin. Positions are shared
    // across triangles via the index buffer, so this exercises the indexed
    // code path in `bufferGeometryToManifold` (the STL-loader path is
    // non-indexed).
    // Windings: CCW when viewed from outside, i.e. right-handed outward
    // normals. Volume must come out as 1.0 mm³.
    const positions = new Float32Array([
      -0.5, -0.5, -0.5, // 0
       0.5, -0.5, -0.5, // 1
       0.5,  0.5, -0.5, // 2
      -0.5,  0.5, -0.5, // 3
      -0.5, -0.5,  0.5, // 4
       0.5, -0.5,  0.5, // 5
       0.5,  0.5,  0.5, // 6
      -0.5,  0.5,  0.5, // 7
    ]);
    const indices = new Uint32Array([
      // -Z face (normal -Z, CCW viewed from -Z)
      0, 2, 1,  0, 3, 2,
      // +Z face
      4, 5, 6,  4, 6, 7,
      // -Y face
      0, 1, 5,  0, 5, 4,
      // +Y face
      3, 7, 6,  3, 6, 2,
      // -X face
      0, 4, 7,  0, 7, 3,
      // +X face
      1, 2, 6,  1, 6, 5,
    ]);
    const bg = new BufferGeometry();
    bg.setAttribute('position', new BufferAttribute(positions, 3));
    bg.setIndex(new BufferAttribute(indices, 1));

    const m = await bufferGeometryToManifold(bg);
    try {
      expect(isManifold(m)).toBe(true);
      expect(meshVolume(m)).toBeCloseTo(1.0, 5);
    } finally {
      m.delete();
    }
  });

  test('bufferGeometryToManifold throws on missing position attribute', async () => {
    const bg = new BufferGeometry();
    await expect(bufferGeometryToManifold(bg)).rejects.toThrow(/position/);
  });
});

describe('initManifold — idempotency', () => {
  test('repeated calls return the same toplevel handle', async () => {
    const a = await initManifold();
    const b = await initManifold();
    expect(a).toBe(b);
  });
});
