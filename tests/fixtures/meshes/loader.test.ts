// tests/fixtures/meshes/loader.test.ts
//
// Loader contract tests. Every fixture that is committed to the repo gets
// its sidecar checked — `meta.triCount` must match the parsed STL. Fixtures
// that are *not yet* committed (licence pending, e.g. `mini-figurine`) are
// skipped gracefully per issue #1 AC.

import { describe, expect, test } from 'vitest';
import { fixtureExists, loadFixture } from './loader';

const CANDIDATES = [
  'unit-cube',
  'unit-sphere-icos-3',
  'torus-32x16',
  'mini-figurine',
];

describe('fixture loader', () => {
  test('fixtureExists returns false for an obviously-missing name', () => {
    expect(fixtureExists('does-not-exist-sentinel')).toBe(false);
  });

  for (const name of CANDIDATES) {
    // Gracefully skip when the fixture isn't present yet (licence-pending
    // mini-figurine, procedurally-generated-later cube/sphere/torus).
    test.skipIf(!fixtureExists(name))(
      `${name}: sidecar triCount matches parsed STL`,
      async () => {
        const f = await loadFixture(name);
        expect(f.meta.name).toBe(name);
        expect(f.meta.triCount).toBe(f.geometry.triCount);
        expect(f.geometry.positions.length).toBe(f.geometry.triCount * 9);
        expect(f.geometry.normals.length).toBe(f.geometry.triCount * 9);
        // Bounding-box sanity: min[i] <= max[i] on every axis.
        for (let i = 0; i < 3; i++) {
          expect(f.meta.boundingBoxMin[i]!).toBeLessThanOrEqual(
            f.meta.boundingBoxMax[i]!,
          );
        }
        // Manifold-shaped view is well-formed.
        expect(f.manifold.numProp).toBe(3);
        expect(f.manifold.vertProperties.length % 3).toBe(0);
        expect(f.manifold.triVerts.length).toBe(f.geometry.triCount * 3);
      },
    );
  }
});
