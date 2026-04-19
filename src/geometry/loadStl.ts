// src/geometry/loadStl.ts
//
// STL ingestion path. Parses an `ArrayBuffer` of binary or ASCII STL via
// three.js's `STLLoader`, strips/regenerates normals, and hands off to the
// manifold-3d adapter for the Manifold representation. The master is not
// centred or scaled — load faithfully per issue #9 non-goals.

import type { BufferGeometry } from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import type { Manifold } from 'manifold-3d';
import { bufferGeometryToManifold } from './adapters';

/**
 * Result shape for `loadStl`. `geometry` is ready for Three rendering + BVH
 * construction; `manifold` is the compute representation for Boolean / offset
 * / volume. Callers must `.delete()` the manifold when done.
 */
export interface LoadedStl {
  geometry: BufferGeometry;
  manifold: Manifold;
}

/**
 * Parse a binary or ASCII STL buffer and produce a paired
 * `(BufferGeometry, Manifold)`.
 *
 * Behaviour:
 * - Uses three.js `STLLoader.parse` for the BufferGeometry side (handles both
 *   ASCII and binary automatically).
 * - Drops any normal attribute the loader attached — STL's stored face
 *   normals are historically unreliable — and re-derives smooth vertex
 *   normals from triangle winding via `computeVertexNormals()`.
 * - Delegates manifold construction to `bufferGeometryToManifold`, which
 *   ensures the single WASM instance is initialised and surfaces a tri-count
 *   delta warning if manifold-3d repairs non-manifold input.
 *
 * @param buffer Binary or ASCII STL contents as an `ArrayBuffer`.
 * @throws If the STL fails to parse or contains no geometry.
 */
export async function loadStl(buffer: ArrayBuffer): Promise<LoadedStl> {
  const loader = new STLLoader();
  const parsed = loader.parse(buffer);

  // Strip the STL's stored face normals; they are per-triangle and often
  // wrong in real-world files. We want vertex normals from winding.
  if (parsed.hasAttribute('normal')) {
    parsed.deleteAttribute('normal');
  }
  parsed.computeVertexNormals();

  if (!parsed.hasAttribute('position') || parsed.getAttribute('position').count === 0) {
    throw new Error('loadStl: parsed STL has no vertices');
  }

  const manifold = await bufferGeometryToManifold(parsed);
  return { geometry: parsed, manifold };
}
