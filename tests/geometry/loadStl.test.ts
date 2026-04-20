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
import { initManifold, isManifold, loadStl, manifoldToBufferGeometry } from '@/geometry';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { Mesh, MeshBasicMaterial } from 'three';

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

  // Issue #64 — `loadStl` surfaces a `repairedTriCount` so the UI layer
  // can fire a notice-level toast when manifold-3d silently repairs
  // non-manifold input. For the mini-figurine fixture the known delta
  // (observed during the 2026-04-20 dogfood session) is 42 triangles.
  // We assert `repairedTriCount > 0` rather than the exact count so a
  // future fixture re-export (or a manifold-3d bump) that changes the
  // delta doesn't break this test — the contract under test is
  // "positive when repair happened", not the specific number.
  test.skipIf(!fixtureExists('mini-figurine'))(
    'surfaces a positive repairedTriCount for the non-manifold mini-figurine',
    async () => {
      const { stl } = fixturePaths('mini-figurine');
      const buf = readFileSync(stl);
      const ab = buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
      );

      const { manifold, repairedTriCount } = await loadStl(ab);
      try {
        expect(typeof repairedTriCount).toBe('number');
        expect(Number.isFinite(repairedTriCount)).toBe(true);
        expect(repairedTriCount).toBeGreaterThan(0);
      } finally {
        manifold.delete();
      }
    },
  );
});

describe('loadStl — repairedTriCount == 0 for watertight input', () => {
  // A manifold-3d-constructed cube re-exported to STL is guaranteed
  // watertight by definition. Round-tripping through STL + loadStl must
  // produce `repairedTriCount === 0` — no repair happens on already-
  // manifold input. Guards against the AC "NO toast fires when the STL
  // was already watertight (delta === 0)".
  test('repairedTriCount is 0 when the input is already a valid 2-manifold', async () => {
    const toplevel = await initManifold();
    const cube = toplevel.Manifold.cube([10, 10, 10], true);
    try {
      const bg = await manifoldToBufferGeometry(cube);
      // Synthesise a binary STL buffer from the Manifold-derived geometry
      // so the adapter sees the exact same (vertex-deduped) mesh on the
      // way back in — watertight by construction.
      const exporter = new STLExporter();
      const mesh = new Mesh(bg, new MeshBasicMaterial());
      const stlString = exporter.parse(mesh, { binary: true }) as unknown as DataView;
      const ab = stlString.buffer.slice(
        stlString.byteOffset,
        stlString.byteOffset + stlString.byteLength,
      ) as ArrayBuffer;

      const loaded = await loadStl(ab);
      try {
        expect(loaded.repairedTriCount).toBe(0);
        expect(isManifold(loaded.manifold)).toBe(true);
      } finally {
        loaded.manifold.delete();
      }
    } finally {
      cube.delete();
    }
  });
});
