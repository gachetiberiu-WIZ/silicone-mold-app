// tests/geometry/loadStl.test.ts
//
// End-to-end load path for a real-world master STL. The `mini-figurine`
// fixture is committed (see chore/fixture-mini-figurine merge), so we run
// without a skipIf. Asserts:
//
//   1. BufferGeometry bounding box matches the sidecar metadata within 1e-3 mm
//      (STL coordinates are stored as float32 — bbox should round-trip cleanly
//      well inside millimetre precision).
//   2. The Manifold is watertight per `isManifold()`.
//   3. The Manifold's tri count is non-zero (sanity).
//
// If manifold-3d repaired the input, `bufferGeometryToManifold` already
// `console.warn`-ed the tri-count delta — we don't fail the test on repair,
// that's expected behaviour for non-manifold Thingiverse-style inputs.

import { readFileSync } from 'node:fs';
import type { Box3 } from 'three';
import { Vector3 } from 'three';
import { describe, expect, test } from 'vitest';
import {
  fixtureExists,
  fixturePaths,
  loadFixture,
} from '@fixtures/meshes/loader';
import { isManifold, loadStl } from '@/geometry';

describe('loadStl — mini-figurine', () => {
  // mini-figurine is committed. Belt + braces: skip cleanly if an operator
  // has somehow wiped the fixture so we never get a hard-to-diagnose failure.
  test.skipIf(!fixtureExists('mini-figurine'))(
    'loads real-world master with manifold watertightness and correct bbox',
    async () => {
      const { stl } = fixturePaths('mini-figurine');
      const buf = readFileSync(stl);
      const ab = buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
      );

      const fixture = await loadFixture('mini-figurine');
      const { geometry, manifold } = await loadStl(ab);

      try {
        // Bounding box on the three.js side.
        geometry.computeBoundingBox();
        const bbox = geometry.boundingBox!;
        const min = bbox.min;
        const max = bbox.max;

        const [emnX, emnY, emnZ] = fixture.meta.boundingBoxMin;
        const [emxX, emxY, emxZ] = fixture.meta.boundingBoxMax;

        expect({ x: min.x, y: min.y, z: min.z }).toEqualWithTolerance(
          { x: emnX, y: emnY, z: emnZ },
          { abs: 1e-3 },
        );
        expect({ x: max.x, y: max.y, z: max.z }).toEqualWithTolerance(
          { x: emxX, y: emxY, z: emxZ },
          { abs: 1e-3 },
        );

        // Sanity: bbox is non-degenerate.
        const size = new Vector3();
        (bbox as Box3).getSize(size);
        expect(size.x).toBeGreaterThan(0);
        expect(size.y).toBeGreaterThan(0);
        expect(size.z).toBeGreaterThan(0);

        // Manifold watertightness.
        expect(isManifold(manifold)).toBe(true);
        expect(manifold.numTri()).toBeGreaterThan(0);
      } finally {
        manifold.delete();
      }
    },
  );
});
