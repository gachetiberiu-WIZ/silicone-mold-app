// tests/canonical-stl.ts
//
// Canonical binary-STL serialiser + SHA-256 hasher, per ADR-003 §A.
//
// Why: raw-bytes STL hashing is non-deterministic across platforms even when
// the underlying geometry kernel (manifold-3d) is deterministic — mesh index
// order, triangle winding, and normals can round-trip through different
// orderings. Canonicalisation collapses these degrees of freedom so a hash
// comparison genuinely reflects a geometry change.
//
// Canonicalisation pipeline:
//   1. Collect triangles as [v0, v1, v2] vertex triples in mm.
//   2. Quantise every float coordinate to 1e-5 mm (ADR-003 tolerance) by
//      `Math.round(v * 1e5) / 1e5`.
//   3. Within each triangle, rotate the 3-cycle of vertices so the smallest
//      vertex (lex order on [x, y, z]) comes first. This preserves winding.
//   4. Re-derive the face normal from `(v1 - v0) x (v2 - v0)`, normalised.
//      Attempt to preserve the original winding direction (we never flip).
//   5. Sort the triangle list by the lex-order of its (v0, v1, v2) tuple.
//   6. Serialise as little-endian binary STL (80-byte zero header, uint32
//      triangle count, then 50 bytes per triangle).
//   7. SHA-256 the resulting byte stream.
//
// Accepted input shapes (duck-typed so this module doesn't depend on three or
// manifold at import time — handy for CI and for the fixture loader's own
// tests):
//   - `{ positions: ArrayLike<number> }` — flat float array, length = 9*N.
//   - `{ index: ArrayLike<number>, positions: ArrayLike<number> }` — indexed.
//   - `{ vertices: number[][], triangles: number[][] }` — manifold-style mesh.
//   - `{ vertProperties, triVerts }` — manifold-3d's `Mesh` object; only the
//      first three properties per vertex are treated as position.

import { createHash } from 'node:crypto';

const QUANT_MM = 1e-5;

export interface CanonicalMeshInput {
  /** Flat Float32/Float64/Array of xyz coordinates; length must be a multiple of 3. */
  positions?: ArrayLike<number>;
  /** Optional triangle index buffer; length must be a multiple of 3. */
  index?: ArrayLike<number> | null;
  /** manifold-3d-style per-vertex property stride. Defaults to 3 when `vertProperties` present. */
  numProp?: number;
  /** manifold-3d `Mesh.vertProperties`: flat, stride = numProp. */
  vertProperties?: ArrayLike<number>;
  /** manifold-3d `Mesh.triVerts`: flat triangle vertex indices. */
  triVerts?: ArrayLike<number>;
  /** nested-array style used by some helpers. */
  vertices?: ReadonlyArray<ReadonlyArray<number>>;
  triangles?: ReadonlyArray<ReadonlyArray<number>>;
}

type Vec3 = readonly [number, number, number];

/** Quantise a coordinate to `QUANT_MM` mm. */
function q(x: number): number {
  // `+ 0` collapses -0 -> 0 so the hash is stable across sign-of-zero noise.
  return Math.round(x / QUANT_MM) * QUANT_MM + 0;
}

function quantizeVec(v: Vec3): Vec3 {
  return [q(v[0]), q(v[1]), q(v[2])];
}

function lexCmp(a: Vec3, b: Vec3): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  if (a[2] !== b[2]) return a[2] < b[2] ? -1 : 1;
  return 0;
}

/** Rotate (v0,v1,v2) so the lex-smallest vertex is first. Preserves winding. */
function canonicaliseTriangle(t: readonly [Vec3, Vec3, Vec3]): [Vec3, Vec3, Vec3] {
  const [a, b, c] = t;
  const cmpAB = lexCmp(a, b);
  const cmpAC = lexCmp(a, c);
  if (cmpAB <= 0 && cmpAC <= 0) return [a, b, c];
  const cmpBC = lexCmp(b, c);
  if (cmpBC <= 0) return [b, c, a];
  return [c, a, b];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalise(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len === 0) return [0, 0, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}

function deriveNormal(t: readonly [Vec3, Vec3, Vec3]): Vec3 {
  return normalise(cross(sub(t[1], t[0]), sub(t[2], t[0])));
}

function triKey(t: readonly [Vec3, Vec3, Vec3]): string {
  // A plain string key sorts by lex-order of concatenated vertex coords;
  // sufficient for the canonical ordering since all values are already
  // quantised and thus have bounded precision.
  return (
    `${t[0][0]},${t[0][1]},${t[0][2]}|` +
    `${t[1][0]},${t[1][1]},${t[1][2]}|` +
    `${t[2][0]},${t[2][1]},${t[2][2]}`
  );
}

/** Extract triangles from any supported input shape. */
function extractTriangles(mesh: CanonicalMeshInput): Array<[Vec3, Vec3, Vec3]> {
  // Shape 1: nested arrays (easiest).
  if (mesh.vertices && mesh.triangles) {
    const verts = mesh.vertices;
    return mesh.triangles.map((tri) => {
      const [i0, i1, i2] = [tri[0]!, tri[1]!, tri[2]!];
      return [
        [verts[i0]![0]!, verts[i0]![1]!, verts[i0]![2]!],
        [verts[i1]![0]!, verts[i1]![1]!, verts[i1]![2]!],
        [verts[i2]![0]!, verts[i2]![1]!, verts[i2]![2]!],
      ];
    });
  }

  // Shape 2: manifold-3d `Mesh` { vertProperties, triVerts, numProp }.
  if (mesh.vertProperties && mesh.triVerts) {
    const vp = mesh.vertProperties;
    const tv = mesh.triVerts;
    const stride = mesh.numProp ?? 3;
    const triCount = tv.length / 3;
    const out: Array<[Vec3, Vec3, Vec3]> = [];
    for (let t = 0; t < triCount; t++) {
      const i0 = tv[t * 3]! * stride;
      const i1 = tv[t * 3 + 1]! * stride;
      const i2 = tv[t * 3 + 2]! * stride;
      out.push([
        [vp[i0]!, vp[i0 + 1]!, vp[i0 + 2]!],
        [vp[i1]!, vp[i1 + 1]!, vp[i1 + 2]!],
        [vp[i2]!, vp[i2 + 1]!, vp[i2 + 2]!],
      ]);
    }
    return out;
  }

  // Shape 3: flat positions, optional index.
  if (mesh.positions) {
    const pos = mesh.positions;
    const idx = mesh.index;
    if (idx) {
      const triCount = idx.length / 3;
      const out: Array<[Vec3, Vec3, Vec3]> = [];
      for (let t = 0; t < triCount; t++) {
        const i0 = idx[t * 3]! * 3;
        const i1 = idx[t * 3 + 1]! * 3;
        const i2 = idx[t * 3 + 2]! * 3;
        out.push([
          [pos[i0]!, pos[i0 + 1]!, pos[i0 + 2]!],
          [pos[i1]!, pos[i1 + 1]!, pos[i1 + 2]!],
          [pos[i2]!, pos[i2 + 1]!, pos[i2 + 2]!],
        ]);
      }
      return out;
    }
    // Non-indexed: 9 floats per triangle.
    const triCount = pos.length / 9;
    const out: Array<[Vec3, Vec3, Vec3]> = [];
    for (let t = 0; t < triCount; t++) {
      const o = t * 9;
      out.push([
        [pos[o]!, pos[o + 1]!, pos[o + 2]!],
        [pos[o + 3]!, pos[o + 4]!, pos[o + 5]!],
        [pos[o + 6]!, pos[o + 7]!, pos[o + 8]!],
      ]);
    }
    return out;
  }

  throw new TypeError(
    'canonicalStlBytes: unrecognised mesh input shape; expected `{positions}`, `{vertices, triangles}`, or `{vertProperties, triVerts}`.',
  );
}

/**
 * Produce the canonical binary-STL byte stream for a mesh.
 * Deterministic across Node versions and platforms.
 */
export function canonicalStlBytes(mesh: CanonicalMeshInput): Uint8Array {
  const raw = extractTriangles(mesh);
  const canonical = raw.map((tri) => {
    const quantised: [Vec3, Vec3, Vec3] = [
      quantizeVec(tri[0]),
      quantizeVec(tri[1]),
      quantizeVec(tri[2]),
    ];
    return canonicaliseTriangle(quantised);
  });

  canonical.sort((a, b) => {
    const ka = triKey(a);
    const kb = triKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  // Binary STL: 80-byte header (zeroed) + uint32 triCount + 50 bytes per tri.
  const triCount = canonical.length;
  const buf = new ArrayBuffer(80 + 4 + triCount * 50);
  const view = new DataView(buf);
  // Header stays all zeros.
  view.setUint32(80, triCount, true);

  let off = 84;
  for (const tri of canonical) {
    const n = deriveNormal(tri);
    view.setFloat32(off, n[0], true);
    view.setFloat32(off + 4, n[1], true);
    view.setFloat32(off + 8, n[2], true);
    off += 12;
    for (const v of tri) {
      view.setFloat32(off, v[0], true);
      view.setFloat32(off + 4, v[1], true);
      view.setFloat32(off + 8, v[2], true);
      off += 12;
    }
    view.setUint16(off, 0, true); // attribute byte count, conventionally zero.
    off += 2;
  }

  return new Uint8Array(buf);
}

/** SHA-256 hex digest of the canonical STL bytes. */
export function stlSha256(mesh: CanonicalMeshInput): string {
  const bytes = canonicalStlBytes(mesh);
  return createHash('sha256').update(bytes).digest('hex');
}
