// tests/fixtures/meshes/loader.ts
//
// Canonical-mesh fixture loader for the test suite. Reads `<name>.stl` + its
// `<name>.json` sidecar from this directory, parses the binary STL, and
// returns both a three.js-compatible `BufferGeometry`-shaped POJO and the
// raw triangle/vertex data for geometry-kernel consumption. The loader is
// deliberately three- and manifold-independent at import time so the fixture
// contract can be validated in isolation.
//
// Contract asserted against the sidecar:
//   - sidecar must exist and parse as JSON
//   - `meta.triCount` must match the parsed triangle count
//
// Graceful-skip helper `fixtureExists(name)` is exported for use with
// `test.skipIf(!fixtureExists('mini-figurine'))` when the underlying STL has
// not yet been committed (licence-pending fixtures).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));

export interface FixtureMeta {
  name: string;
  triCount: number;
  volume_mm3: number;
  surfaceArea_mm2?: number;
  boundingBoxMin: [number, number, number];
  boundingBoxMax: [number, number, number];
  isManifold?: boolean;
  source: string;
  license: string;
  [extra: string]: unknown;
}

export interface LoadedFixture {
  /** `BufferGeometry`-shaped POJO: non-indexed, 9 floats per triangle, with derived normals. */
  geometry: {
    positions: Float32Array;
    normals: Float32Array;
    triCount: number;
  };
  /** Lightweight mesh placeholder: the raw arrays ready for manifold-3d's `Mesh` constructor. */
  manifold: {
    numProp: 3;
    vertProperties: Float32Array;
    triVerts: Uint32Array;
  };
  meta: FixtureMeta;
}

export function fixturePaths(name: string): { stl: string; json: string } {
  return {
    stl: join(FIXTURE_DIR, `${name}.stl`),
    json: join(FIXTURE_DIR, `${name}.json`),
  };
}

/** True only if both the `.stl` and `.json` sidecar are present on disk. */
export function fixtureExists(name: string): boolean {
  const { stl, json } = fixturePaths(name);
  return existsSync(stl) && existsSync(json);
}

function parseBinaryStl(buf: Buffer): {
  positions: Float32Array;
  normals: Float32Array;
  triCount: number;
} {
  if (buf.length < 84) {
    throw new Error(`STL too short: ${buf.length} bytes`);
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const triCount = view.getUint32(80, true);
  const expected = 84 + triCount * 50;
  if (buf.length !== expected) {
    throw new Error(
      `STL length mismatch: header says ${triCount} triangles (expect ${expected} bytes), file is ${buf.length} bytes`,
    );
  }
  const positions = new Float32Array(triCount * 9);
  const normals = new Float32Array(triCount * 9);
  let off = 84;
  for (let t = 0; t < triCount; t++) {
    const nx = view.getFloat32(off, true);
    const ny = view.getFloat32(off + 4, true);
    const nz = view.getFloat32(off + 8, true);
    off += 12;
    for (let v = 0; v < 3; v++) {
      const px = view.getFloat32(off, true);
      const py = view.getFloat32(off + 4, true);
      const pz = view.getFloat32(off + 8, true);
      off += 12;
      const base = t * 9 + v * 3;
      positions[base] = px;
      positions[base + 1] = py;
      positions[base + 2] = pz;
      normals[base] = nx;
      normals[base + 1] = ny;
      normals[base + 2] = nz;
    }
    off += 2; // attribute byte count
  }
  return { positions, normals, triCount };
}

/**
 * Load a mesh fixture and its sidecar. Throws if the fixture is missing —
 * call `fixtureExists(name)` first (or `test.skipIf(!fixtureExists(...))`)
 * to gate tests on licence-pending assets like `mini-figurine`.
 */
export async function loadFixture(name: string): Promise<LoadedFixture> {
  const { stl, json } = fixturePaths(name);
  if (!existsSync(stl)) {
    throw new Error(
      `Fixture '${name}': STL file not found at ${stl}. Use fixtureExists('${name}') to gate.`,
    );
  }
  if (!existsSync(json)) {
    throw new Error(
      `Fixture '${name}': sidecar JSON not found at ${json}. Every fixture requires a sidecar per tests/fixtures/meshes/README.md.`,
    );
  }

  const stlBuf = readFileSync(stl);
  const meta = JSON.parse(readFileSync(json, 'utf8')) as FixtureMeta;
  const { positions, normals, triCount } = parseBinaryStl(stlBuf);

  if (meta.triCount !== triCount) {
    throw new Error(
      `Fixture '${name}' triangle-count mismatch: sidecar says ${meta.triCount}, parsed STL has ${triCount}. Regenerate the fixture or fix the sidecar.`,
    );
  }

  // Build a deduplicated vertex buffer for the manifold-3d-shaped view.
  // Fixtures are small (≤ 50k tri) so the O(N) dedup via string key is fine.
  const vertIndex = new Map<string, number>();
  const vertsFlat: number[] = [];
  const triVerts = new Uint32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    for (let v = 0; v < 3; v++) {
      const base = t * 9 + v * 3;
      const x = positions[base]!;
      const y = positions[base + 1]!;
      const z = positions[base + 2]!;
      const key = `${x},${y},${z}`;
      let idx = vertIndex.get(key);
      if (idx === undefined) {
        idx = vertsFlat.length / 3;
        vertsFlat.push(x, y, z);
        vertIndex.set(key, idx);
      }
      triVerts[t * 3 + v] = idx;
    }
  }

  return {
    geometry: { positions, normals, triCount },
    manifold: {
      numProp: 3,
      vertProperties: new Float32Array(vertsFlat),
      triVerts,
    },
    meta,
  };
}
