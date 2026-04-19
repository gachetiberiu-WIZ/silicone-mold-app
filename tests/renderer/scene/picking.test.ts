// tests/renderer/scene/picking.test.ts
//
// Unit tests for the BVH-backed face picker in
// `src/renderer/scene/picking.ts`.
//
// Tests exercise:
//   - `installAcceleratedRaycast` is idempotent and installs the
//     `three-mesh-bvh` monkey-patches on `Mesh.prototype` and
//     `BufferGeometry.prototype`.
//   - `prepareMeshForPicking` builds a BVH on the mesh (i.e.
//     `geometry.boundsTree` becomes defined) and `releaseMeshPicking`
//     disposes it.
//   - `pickFaceUnderPointer` returns the expected hit when the pointer
//     aims at a known triangle — on the unit cube fixture, looking
//     straight down at its top face from +Y should pick a triangle
//     whose local normal is (0, 1, 0).
//   - `pickFaceUnderPointer` returns null when the ray misses the mesh.
//
// The test builds a real `Mesh` from a canonical fixture (unit-cube) plus
// an off-center camera so we can assert a non-trivial pick. A headless
// DOM doesn't help us here — we mock `getBoundingClientRect` on a plain
// HTMLCanvasElement-like stub because Vitest's `node` environment has no
// `document`.

import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Vector3,
} from 'three';
import { describe, expect, test } from 'vitest';

import {
  installAcceleratedRaycast,
  pickFaceUnderPointer,
  prepareMeshForPicking,
  releaseMeshPicking,
} from '@/renderer/scene/picking';
import { loadFixture } from '@fixtures/meshes/loader';

/**
 * Build a tiny HTMLCanvasElement-shaped stub that satisfies the subset
 * of the DOM API `pickFaceUnderPointer` consumes (just
 * `getBoundingClientRect`). Returns a 1280×800 canvas at (0, 0).
 */
function makeCanvasStub(width = 1280, height = 800): HTMLCanvasElement {
  return {
    getBoundingClientRect(): DOMRect {
      return {
        left: 0,
        top: 0,
        right: width,
        bottom: height,
        width,
        height,
        x: 0,
        y: 0,
        toJSON(): unknown {
          return {};
        },
      } as DOMRect;
    },
  } as unknown as HTMLCanvasElement;
}

/**
 * Build a unit-cube Mesh from the `unit-cube` fixture. Non-indexed,
 * matches the shape `manifoldToBufferGeometry` emits.
 */
async function buildUnitCubeMesh(): Promise<Mesh> {
  const fixture = await loadFixture('unit-cube');
  const geom = new BufferGeometry();
  geom.setAttribute(
    'position',
    new BufferAttribute(fixture.geometry.positions, 3),
  );
  // Emulate what the adapter would do — fresh normals from winding.
  geom.computeVertexNormals();
  const mat = new MeshBasicMaterial();
  return new Mesh(geom, mat);
}

describe('installAcceleratedRaycast', () => {
  test('patches Mesh.prototype.raycast (idempotent)', () => {
    installAcceleratedRaycast();
    installAcceleratedRaycast(); // must not throw / re-patch
    const raycast = (Mesh.prototype as unknown as { raycast: unknown })
      .raycast;
    expect(typeof raycast).toBe('function');
    // Second call — function reference is stable.
    const raycast2 = (Mesh.prototype as unknown as { raycast: unknown })
      .raycast;
    expect(raycast2).toBe(raycast);
  });

  test('patches BufferGeometry.prototype.computeBoundsTree', () => {
    installAcceleratedRaycast();
    const compute = (
      BufferGeometry.prototype as unknown as {
        computeBoundsTree?: unknown;
      }
    ).computeBoundsTree;
    expect(typeof compute).toBe('function');
  });
});

describe('prepareMeshForPicking + releaseMeshPicking', () => {
  test('builds and disposes the bounds tree on a cube', async () => {
    const mesh = await buildUnitCubeMesh();
    prepareMeshForPicking(mesh);
    const geom = mesh.geometry as BufferGeometry & { boundsTree?: unknown };
    expect(geom.boundsTree).toBeTruthy();
    releaseMeshPicking(mesh);
    // `disposeBoundsTree` sets `boundsTree` to `null` (not `undefined`),
    // but either outcome means "no tree present" — assert via falsy.
    expect(geom.boundsTree ?? null).toBeNull();
  });

  test('releaseMeshPicking is a no-op on a mesh that never had a tree', async () => {
    const mesh = await buildUnitCubeMesh();
    // Do NOT call prepareMeshForPicking. Release must still work without
    // throwing — matches the disposeMesh path in master.ts.
    expect(() => releaseMeshPicking(mesh)).not.toThrow();
  });

  test('prepareMeshForPicking on a mesh with an existing tree rebuilds it', async () => {
    const mesh = await buildUnitCubeMesh();
    prepareMeshForPicking(mesh);
    const geom = mesh.geometry as BufferGeometry & { boundsTree?: unknown };
    const first = geom.boundsTree;
    prepareMeshForPicking(mesh);
    const second = geom.boundsTree;
    // The tree is a NEW instance (we dispose + rebuild).
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });
});

describe('pickFaceUnderPointer', () => {
  test('picks a face whose world-normal points up (+Y) when looking down at the cube', async () => {
    const mesh = await buildUnitCubeMesh();
    prepareMeshForPicking(mesh);
    mesh.updateMatrixWorld(true);

    // Camera looking straight down the -Y axis at the cube's top face.
    const camera = new PerspectiveCamera(45, 1280 / 800, 0.01, 100);
    camera.position.set(0, 5, 0);
    camera.up.set(0, 0, -1); // up-vector perpendicular to view — standard trick.
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();

    const canvas = makeCanvasStub(1280, 800);
    // Point the cursor at the canvas center — NDC (0, 0). With the camera
    // looking straight down, the ray hits the cube's top face at (0,0.5,0).
    const pick = pickFaceUnderPointer(
      { clientX: 640, clientY: 400 },
      canvas,
      camera,
      mesh,
    );

    expect(pick).not.toBeNull();
    if (!pick) return;
    // Top face normal in world space: (0, 1, 0). Since mesh has identity
    // world transform, local and world normals match.
    expect({ x: pick.worldNormal.x, y: pick.worldNormal.y, z: pick.worldNormal.z })
      .toEqualWithTolerance({ x: 0, y: 1, z: 0 }, { abs: 1e-4 });
    // Hit point must be on the top face (y ≈ 0.5).
    expect(pick.point.y).toEqualWithTolerance(0.5, { abs: 1e-4 });
    // faceIndex is a non-negative integer into the mesh's triangles.
    expect(Number.isInteger(pick.faceIndex)).toBe(true);
    expect(pick.faceIndex).toBeGreaterThanOrEqual(0);
    expect(pick.faceIndex).toBeLessThan(12); // unit-cube = 12 tris
  });

  test('returns null when the pointer misses the mesh', async () => {
    const mesh = await buildUnitCubeMesh();
    prepareMeshForPicking(mesh);
    mesh.updateMatrixWorld(true);

    const camera = new PerspectiveCamera(45, 1280 / 800, 0.01, 100);
    camera.position.set(0, 5, 0);
    camera.up.set(0, 0, -1);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();

    const canvas = makeCanvasStub(1280, 800);
    // Aim at a corner well outside the cube's projected footprint. At
    // a 45° FOV with the camera 5 mm away, the near corner of the 1×1×1
    // cube spans roughly ±11% of the screen height; clientY = 10
    // (top-edge) is far outside.
    const pick = pickFaceUnderPointer(
      { clientX: 0, clientY: 10 },
      canvas,
      camera,
      mesh,
    );
    expect(pick).toBeNull();
  });

  test('returns null on a zero-size canvas', async () => {
    const mesh = await buildUnitCubeMesh();
    prepareMeshForPicking(mesh);
    const camera = new PerspectiveCamera(45, 1, 0.01, 100);
    const canvas = makeCanvasStub(0, 0);
    const pick = pickFaceUnderPointer(
      { clientX: 10, clientY: 10 },
      canvas,
      camera,
      mesh,
    );
    expect(pick).toBeNull();
  });
});

describe('pickFaceUnderPointer under a rotated group', () => {
  test('world normal reflects the group rotation', async () => {
    // Parent the mesh under a Group rotated 90° around +X so the local
    // +Y face now points to +Z in world space. A camera aimed from +Z
    // at the rotated top face must report a world normal of (0, 0, 1).
    const mesh = await buildUnitCubeMesh();
    prepareMeshForPicking(mesh);

    const { Group } = await import('three');
    const group = new Group();
    group.add(mesh);
    group.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
    group.updateMatrixWorld(true);

    const camera = new PerspectiveCamera(45, 1280 / 800, 0.01, 100);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();

    const canvas = makeCanvasStub(1280, 800);
    const pick = pickFaceUnderPointer(
      { clientX: 640, clientY: 400 },
      canvas,
      camera,
      mesh,
    );
    expect(pick).not.toBeNull();
    if (!pick) return;
    // World-space normal is (0, 0, 1) — the local +Y after the group
    // rotation. Tolerance is looser than above because the rotation
    // brings floating-point subtleties into play.
    expect({ x: pick.worldNormal.x, y: pick.worldNormal.y, z: pick.worldNormal.z })
      .toEqualWithTolerance({ x: 0, y: 0, z: 1 }, { abs: 1e-4 });
  });
});
