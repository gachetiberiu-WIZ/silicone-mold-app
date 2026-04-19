// tests/fixtures/meshes/generate.ts
//
// Procedural generator for canonical mesh fixtures. Emits byte-identical
// binary STLs + matching JSON sidecars on every invocation, regardless of
// Node version or host platform.
//
// Covered fixtures (per issue #8):
//   - unit-cube.stl              (12 tri,   1×1×1 mm cube centered at origin)
//   - unit-sphere-icos-3.stl     (1280 tri, radius-1 mm icosphere subdivision 3)
//   - torus-32x16.stl            (1024 tri, R=1 mm, r=0.3 mm, 32 radial × 16 tubular)
//
// Determinism contract:
//   1. Mesh topology is produced from a fixed construction sequence — no
//      Math.random, no floating-point summation order drift (we build
//      vertex tables index-by-index).
//   2. Triangle bytes pass through `canonicalStlBytes` from
//      `tests/canonical-stl.ts`, which quantises to 1e-5 mm, rotates the
//      in-triangle vertex cycle so the lex-smallest vertex is first,
//      sorts triangles by their canonical key, and re-derives normals.
//   3. Sidecar JSON values (volume, surface area, bounding box) are rounded
//      to stable precision before serialisation so round-trip jitter doesn't
//      leak into `git diff`.
//
// Invocation:
//   - `pnpm test:fixtures-regen` runs `regen.test.ts` with `REGEN_FIXTURES=1`,
//     which calls `regenerateAllFixtures()` before the verification pass.
//   - Tests can also call `generateFixtureBytes(name)` directly to compare
//     on-disk bytes against freshly-computed bytes without writing to disk.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalStlBytes } from '../../canonical-stl';

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));

// Sidecar JSON uses fixed numeric precision so the serialised file is
// byte-stable across regenerations. Volume/area get 6 fractional digits;
// bounding box gets 6. These are well below ADR-003 §"Units, tolerances"
// engineering tolerances so they don't impact assertion semantics.
const SIDECAR_NUM_DIGITS = 6;

// --------------------------------------------------------------------------
// Shared math helpers
// --------------------------------------------------------------------------

export type Vec3 = readonly [number, number, number];
export interface RawMesh {
  /** Flat xyz coordinates, length = 3 * vertexCount. */
  vertices: Float64Array;
  /** Triangle vertex indices, length = 3 * triCount. */
  triangles: Uint32Array;
}

function roundTo(x: number, digits: number): number {
  const scale = 10 ** digits;
  // `+ 0` collapses -0 to 0 so JSON.stringify yields "0" rather than "-0".
  return Math.round(x * scale) / scale + 0;
}

function vSub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function vCross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function vDot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function vLen(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function vNorm(v: Vec3): Vec3 {
  const L = vLen(v);
  if (L === 0) return [0, 0, 0];
  return [v[0] / L, v[1] / L, v[2] / L];
}

function triAt(mesh: RawMesh, t: number): [Vec3, Vec3, Vec3] {
  const i0 = mesh.triangles[t * 3]! * 3;
  const i1 = mesh.triangles[t * 3 + 1]! * 3;
  const i2 = mesh.triangles[t * 3 + 2]! * 3;
  return [
    [mesh.vertices[i0]!, mesh.vertices[i0 + 1]!, mesh.vertices[i0 + 2]!],
    [mesh.vertices[i1]!, mesh.vertices[i1 + 1]!, mesh.vertices[i1 + 2]!],
    [mesh.vertices[i2]!, mesh.vertices[i2 + 1]!, mesh.vertices[i2 + 2]!],
  ];
}

/**
 * Signed volume via the divergence theorem (sum of (v0 · (v1 × v2)) / 6 over
 * triangles with outward-facing winding). Returns absolute value so winding
 * conventions don't flip the sign.
 */
export function meshVolume(mesh: RawMesh): number {
  const triCount = mesh.triangles.length / 3;
  let sixV = 0;
  for (let t = 0; t < triCount; t++) {
    const [a, b, c] = triAt(mesh, t);
    sixV += vDot(a, vCross(b, c));
  }
  return Math.abs(sixV) / 6;
}

/** Total surface area: sum of (|AB × AC| / 2) over triangles. */
export function meshSurfaceArea(mesh: RawMesh): number {
  const triCount = mesh.triangles.length / 3;
  let area = 0;
  for (let t = 0; t < triCount; t++) {
    const [a, b, c] = triAt(mesh, t);
    area += vLen(vCross(vSub(b, a), vSub(c, a))) / 2;
  }
  return area;
}

/** AABB in mm as [min, max]. */
export function meshBoundingBox(mesh: RawMesh): { min: Vec3; max: Vec3 } {
  const vc = mesh.vertices.length / 3;
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < vc; i++) {
    const x = mesh.vertices[i * 3]!;
    const y = mesh.vertices[i * 3 + 1]!;
    const z = mesh.vertices[i * 3 + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/**
 * Closed-mesh check: every undirected edge must appear in exactly two
 * triangles, with each direction used once (consistent winding). Returns
 * true when the mesh is watertight AND manifold (no T-junctions, no
 * non-manifold edges).
 */
export function isWatertightManifold(mesh: RawMesh): boolean {
  const triCount = mesh.triangles.length / 3;
  // Map<"min,max", { forward: count, backward: count }>
  const edges = new Map<string, { fwd: number; bwd: number }>();
  for (let t = 0; t < triCount; t++) {
    const a = mesh.triangles[t * 3]!;
    const b = mesh.triangles[t * 3 + 1]!;
    const c = mesh.triangles[t * 3 + 2]!;
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const lo = Math.min(u, v);
      const hi = Math.max(u, v);
      const key = `${lo},${hi}`;
      const rec = edges.get(key) ?? { fwd: 0, bwd: 0 };
      if (u < v) rec.fwd++;
      else rec.bwd++;
      edges.set(key, rec);
    }
  }
  for (const [, rec] of edges) {
    // Exactly one triangle on each side of each edge.
    if (rec.fwd !== 1 || rec.bwd !== 1) return false;
  }
  return true;
}

// --------------------------------------------------------------------------
// unit-cube — 1×1×1 mm centered at origin, 12 triangles
// --------------------------------------------------------------------------

function buildUnitCube(): RawMesh {
  // prettier-ignore
  const vertices = new Float64Array([
    -0.5, -0.5, -0.5, // 0
     0.5, -0.5, -0.5, // 1
     0.5,  0.5, -0.5, // 2
    -0.5,  0.5, -0.5, // 3
    -0.5, -0.5,  0.5, // 4
     0.5, -0.5,  0.5, // 5
     0.5,  0.5,  0.5, // 6
    -0.5,  0.5,  0.5, // 7
  ]);
  // prettier-ignore
  const triangles = new Uint32Array([
    // -Z face
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
  return { vertices, triangles };
}

// --------------------------------------------------------------------------
// unit-sphere-icos-3 — icosphere subdivision 3, radius 1 mm, centered origin
// --------------------------------------------------------------------------

function buildIcosphere(subdivisions: number, radius: number): RawMesh {
  // Icosahedron: 12 vertices built from the golden-ratio rectangle pattern.
  // Stored as [x, y, z] triples before normalisation.
  const t = (1 + Math.sqrt(5)) / 2;
  const rawVerts: Vec3[] = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ];
  // Normalise to unit sphere, then scale to radius. Subdivision pushes new
  // midpoint vertices onto the same array, so `verts` stays the single
  // source-of-truth vertex table throughout the build.
  const verts: Vec3[] = rawVerts.map((v) => {
    const n = vNorm(v);
    return [n[0] * radius, n[1] * radius, n[2] * radius];
  });
  // Base 20 triangles — all wound outward (right-hand rule).
  let tris: Array<[number, number, number]> = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];

  for (let s = 0; s < subdivisions; s++) {
    const midpointCache = new Map<string, number>();
    const next: Array<[number, number, number]> = [];

    const getMid = (a: number, b: number): number => {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const key = `${lo},${hi}`;
      const cached = midpointCache.get(key);
      if (cached !== undefined) return cached;
      const va = verts[a]!;
      const vb = verts[b]!;
      const mx = (va[0] + vb[0]) / 2;
      const my = (va[1] + vb[1]) / 2;
      const mz = (va[2] + vb[2]) / 2;
      const n = vNorm([mx, my, mz]);
      const idx = verts.length;
      verts.push([n[0] * radius, n[1] * radius, n[2] * radius]);
      midpointCache.set(key, idx);
      return idx;
    };

    for (const [a, b, c] of tris) {
      const ab = getMid(a, b);
      const bc = getMid(b, c);
      const ca = getMid(c, a);
      next.push([a, ab, ca]);
      next.push([b, bc, ab]);
      next.push([c, ca, bc]);
      next.push([ab, bc, ca]);
    }
    tris = next;
  }

  const vertices = new Float64Array(verts.length * 3);
  for (let i = 0; i < verts.length; i++) {
    vertices[i * 3] = verts[i]![0];
    vertices[i * 3 + 1] = verts[i]![1];
    vertices[i * 3 + 2] = verts[i]![2];
  }
  const triangles = new Uint32Array(tris.length * 3);
  for (let i = 0; i < tris.length; i++) {
    triangles[i * 3] = tris[i]![0];
    triangles[i * 3 + 1] = tris[i]![1];
    triangles[i * 3 + 2] = tris[i]![2];
  }
  return { vertices, triangles };
}

// --------------------------------------------------------------------------
// torus-32x16 — R=1, r=0.3, 32 radial × 16 tubular, 1024 triangles
// --------------------------------------------------------------------------

function buildTorus(
  majorSegments: number,
  minorSegments: number,
  majorRadius: number,
  minorRadius: number,
): RawMesh {
  // Vertex grid: (majorSegments × minorSegments), no duplicated seam rings.
  // Parametrised: u ∈ [0, 2π), v ∈ [0, 2π).
  // Position:
  //   x = (R + r·cos v)·cos u
  //   y = (R + r·cos v)·sin u
  //   z = r·sin v
  //
  // Triangle winding is outward (consistent with divergence-theorem sign).
  const vertexCount = majorSegments * minorSegments;
  const vertices = new Float64Array(vertexCount * 3);
  const TAU = 2 * Math.PI;

  for (let i = 0; i < majorSegments; i++) {
    const u = (i / majorSegments) * TAU;
    const cu = Math.cos(u);
    const su = Math.sin(u);
    for (let j = 0; j < minorSegments; j++) {
      const v = (j / minorSegments) * TAU;
      const cv = Math.cos(v);
      const sv = Math.sin(v);
      const ringR = majorRadius + minorRadius * cv;
      const idx = (i * minorSegments + j) * 3;
      vertices[idx] = ringR * cu;
      vertices[idx + 1] = ringR * su;
      vertices[idx + 2] = minorRadius * sv;
    }
  }

  // Two triangles per quad, 32×16 = 512 quads → 1024 triangles.
  const triCount = majorSegments * minorSegments * 2;
  const triangles = new Uint32Array(triCount * 3);
  let t = 0;
  const vIdx = (i: number, j: number): number =>
    (i % majorSegments) * minorSegments + (j % minorSegments);

  for (let i = 0; i < majorSegments; i++) {
    for (let j = 0; j < minorSegments; j++) {
      const a = vIdx(i, j);
      const b = vIdx(i + 1, j);
      const c = vIdx(i + 1, j + 1);
      const d = vIdx(i, j + 1);
      // Quad (a, b, c, d) with outward winding.
      triangles[t * 3] = a;
      triangles[t * 3 + 1] = b;
      triangles[t * 3 + 2] = c;
      t++;
      triangles[t * 3] = a;
      triangles[t * 3 + 1] = c;
      triangles[t * 3 + 2] = d;
      t++;
    }
  }
  return { vertices, triangles };
}

// --------------------------------------------------------------------------
// Descriptors + regeneration entrypoint
// --------------------------------------------------------------------------

export interface FixtureDescriptor {
  name: string;
  expectedTriCount: number;
  build(): RawMesh;
  /** Extra sidecar fields merged on top of the computed ones. */
  extraMeta: Record<string, unknown>;
}

export const FIXTURES: readonly FixtureDescriptor[] = [
  {
    name: 'unit-cube',
    expectedTriCount: 12,
    build: buildUnitCube,
    extraMeta: {
      source: 'procedurally generated via tests/fixtures/meshes/generate.ts',
      license: 'public-domain',
      notes: '1×1×1 mm cube centered at origin. Exact volume = 1.0 mm³.',
    },
  },
  {
    name: 'unit-sphere-icos-3',
    expectedTriCount: 1280,
    build: () => buildIcosphere(3, 1),
    extraMeta: {
      source: 'procedurally generated via tests/fixtures/meshes/generate.ts',
      license: 'public-domain',
      notes:
        'Icosahedron subdivided 3 times, vertices projected onto radius-1 sphere. Tessellated volume is a lower bound on the true sphere volume (4/3·π ≈ 4.18879).',
    },
  },
  {
    name: 'torus-32x16',
    expectedTriCount: 1024,
    build: () => buildTorus(32, 16, 1, 0.3),
    extraMeta: {
      source: 'procedurally generated via tests/fixtures/meshes/generate.ts',
      license: 'public-domain',
      notes:
        'Genus-1 torus. Major radius R=1, minor radius r=0.3. 32 radial × 16 tubular segments. True volume = 2·π²·R·r² ≈ 1.77653.',
    },
  },
];

export interface FixtureBundle {
  name: string;
  stlBytes: Uint8Array;
  sidecar: Record<string, unknown>;
  sidecarJson: string;
  mesh: RawMesh;
}

function buildSidecar(
  desc: FixtureDescriptor,
  mesh: RawMesh,
): Record<string, unknown> {
  const bbox = meshBoundingBox(mesh);
  const volume = meshVolume(mesh);
  const area = meshSurfaceArea(mesh);
  const manifold = isWatertightManifold(mesh);

  // Stable key order — sidecar JSON is diffed literally in code review.
  return {
    name: desc.name,
    triCount: mesh.triangles.length / 3,
    volume_mm3: roundTo(volume, SIDECAR_NUM_DIGITS),
    surfaceArea_mm2: roundTo(area, SIDECAR_NUM_DIGITS),
    boundingBoxMin: [
      roundTo(bbox.min[0], SIDECAR_NUM_DIGITS),
      roundTo(bbox.min[1], SIDECAR_NUM_DIGITS),
      roundTo(bbox.min[2], SIDECAR_NUM_DIGITS),
    ],
    boundingBoxMax: [
      roundTo(bbox.max[0], SIDECAR_NUM_DIGITS),
      roundTo(bbox.max[1], SIDECAR_NUM_DIGITS),
      roundTo(bbox.max[2], SIDECAR_NUM_DIGITS),
    ],
    isManifold: manifold,
    ...desc.extraMeta,
  };
}

/** Build a fixture in memory without touching disk. */
export function generateFixtureBundle(desc: FixtureDescriptor): FixtureBundle {
  const mesh = desc.build();
  if (mesh.triangles.length / 3 !== desc.expectedTriCount) {
    throw new Error(
      `generate: ${desc.name} produced ${mesh.triangles.length / 3} triangles, expected ${desc.expectedTriCount}`,
    );
  }
  const stlBytes = canonicalStlBytes({
    vertProperties: mesh.vertices,
    triVerts: mesh.triangles,
    numProp: 3,
  });
  const sidecar = buildSidecar(desc, mesh);
  // Trailing newline keeps editors + POSIX tools happy and matches
  // mini-figurine.json.
  const sidecarJson = JSON.stringify(sidecar, null, 2) + '\n';
  return { name: desc.name, stlBytes, sidecar, sidecarJson, mesh };
}

/** Generate all three fixtures; returns bundles without writing to disk. */
export function generateAllFixtureBundles(): FixtureBundle[] {
  return FIXTURES.map(generateFixtureBundle);
}

/** Regenerate and write every fixture STL + sidecar JSON to disk. */
export function regenerateAllFixtures(outDir: string = FIXTURE_DIR): string[] {
  const written: string[] = [];
  for (const bundle of generateAllFixtureBundles()) {
    const stlPath = join(outDir, `${bundle.name}.stl`);
    const jsonPath = join(outDir, `${bundle.name}.json`);
    writeFileSync(stlPath, bundle.stlBytes);
    writeFileSync(jsonPath, bundle.sidecarJson);
    written.push(stlPath, jsonPath);
  }
  return written;
}

// Direct-invocation entrypoint: `node --experimental-strip-types generate.ts`
// or equivalent. Not used by the test runner — tests import the functions
// above — but available for manual regeneration.
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const written = regenerateAllFixtures();
  for (const p of written) console.log(`wrote ${p}`);
}
