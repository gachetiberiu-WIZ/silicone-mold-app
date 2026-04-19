// tests/geometry/volume.test.ts
//
// Smoke test for `meshVolume()` against the `unit-cube` fixture. The cube
// has known volume 1.0 mm³ by construction (edge length 1). Graceful-skip
// when the fixture isn't yet committed — PR #8 (test-engineer, parallel)
// will land it eventually.
//
// This is the first real geometry test that exercises the full chain:
//   STL buffer → STLLoader → bufferGeometryToManifold → Manifold.volume().
// If this goes green the stack (manifold-3d + three.js + fixtures + matcher)
// is proven end-to-end.

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { fixtureExists, fixturePaths } from '@fixtures/meshes/loader';
import { isManifold, loadStl, meshVolume } from '@/geometry';

describe('meshVolume — unit-cube', () => {
  test.skipIf(!fixtureExists('unit-cube'))(
    'computes 1.0 mm³ within 1e-4',
    async () => {
      const { stl } = fixturePaths('unit-cube');
      const buf = readFileSync(stl);
      // Copy into a fresh ArrayBuffer — Node's Buffer.buffer is shared with
      // the pool and may contain unrelated bytes at offsets beyond byteLength.
      const ab = buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
      );

      const { manifold } = await loadStl(ab);

      try {
        expect(isManifold(manifold)).toBe(true);
        expect(meshVolume(manifold)).toBeCloseTo(1.0, 4);
      } finally {
        manifold.delete();
      }
    },
  );
});
