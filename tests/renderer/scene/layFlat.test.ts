// tests/renderer/scene/layFlat.test.ts
//
// Unit tests for the lay-flat pure-math helpers in
// `src/renderer/scene/layFlat.ts`. These tests cover every acceptance
// criterion from issue #32 that is expressible in node-only geometry:
//
//   1. `quaternionToAlignFaceDown((0,1,0))` sends +Y to −Y (flip).
//   2. `quaternionToAlignFaceDown((1,0,0))` sends +X to −Y.
//   3. `quaternionToAlignFaceDown((0,-1,0))` is (≈) identity.
//   4. `recenterGroup` on a rotated group produces a world-space bbox
//      with `min.y === 0` and `center.xz ≈ 0` — i.e. it honours the
//      same "on-the-bed + xz-centered" contract `setMaster` does, but
//      under a non-trivial group rotation.
//   5. `resetOrientation` restores identity + re-applies auto-center.
//   6. BufferGeometry position buffer is UNCHANGED after lay-flat
//      rotation (the critical invariant from PR #29).
//   7. `localNormalToWorld` applies the group's rotation correctly.
//
// The tests use a tiny synthetic Mesh (a 2×1×1 box) rather than the real
// STL loader — we only care about the geometry math here, not the STL
// round-trip. A separate `master.test.ts` covers the setMaster path.

import {
  BoxGeometry,
  Box3,
  Group,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { describe, expect, test } from 'vitest';

import {
  localNormalToWorld,
  quaternionToAlignFaceDown,
  recenterGroup,
  resetOrientation,
} from '@/renderer/scene/layFlat';

/**
 * Build a Group with a box mesh as its child, placed at a known offset
 * inside the group so the child has a non-trivial world-space bbox under
 * both identity and rotated group orientations. Mimics the scene-graph
 * structure `setMaster` builds (Master group → mesh).
 */
function buildGroupWithBox(): { group: Group; mesh: Mesh } {
  const group = new Group();
  // 2 mm wide, 1 mm tall, 1 mm deep. Default-centered on origin.
  const geom = new BoxGeometry(2, 1, 1);
  const mat = new MeshBasicMaterial();
  const mesh = new Mesh(geom, mat);
  group.add(mesh);
  return { group, mesh };
}

/** Apply `q` to `v` and return a fresh Vector3 — avoids mutating input. */
function rotate(v: Vector3, q: Quaternion): Vector3 {
  return v.clone().applyQuaternion(q);
}

describe('quaternionToAlignFaceDown', () => {
  test('sends +Y normal to -Y (face-up → face-down flip)', () => {
    const q = quaternionToAlignFaceDown(new Vector3(0, 1, 0));
    const rotated = rotate(new Vector3(0, 1, 0), q);
    // The rotated normal must be (0, -1, 0) within tolerance. Three picks
    // either an X-flip or Z-flip as the rotation axis; either is valid —
    // both produce the same result on the input normal.
    expect({ x: rotated.x, y: rotated.y, z: rotated.z }).toEqualWithTolerance(
      { x: 0, y: -1, z: 0 },
      { abs: 1e-6 },
    );
  });

  test('sends +X normal to -Y', () => {
    const q = quaternionToAlignFaceDown(new Vector3(1, 0, 0));
    const rotated = rotate(new Vector3(1, 0, 0), q);
    expect({ x: rotated.x, y: rotated.y, z: rotated.z }).toEqualWithTolerance(
      { x: 0, y: -1, z: 0 },
      { abs: 1e-6 },
    );
  });

  test('sends -Y (already down) to itself — quaternion is ≈ identity', () => {
    const q = quaternionToAlignFaceDown(new Vector3(0, -1, 0));
    // Identity quaternion has w=1, x=y=z=0. Three's setFromUnitVectors
    // short-circuits to identity when the dot product ≈ 1.
    expect({ x: q.x, y: q.y, z: q.z, w: q.w }).toEqualWithTolerance(
      { x: 0, y: 0, z: 0, w: 1 },
      { abs: 1e-6 },
    );
  });

  test('normalises a non-unit input before computing', () => {
    // A non-unit +Y should still produce the same flip — the helper
    // must normalise internally.
    const q = quaternionToAlignFaceDown(new Vector3(0, 17.4, 0));
    const rotated = rotate(new Vector3(0, 1, 0), q);
    expect(rotated.y).toEqualWithTolerance(-1, { abs: 1e-6 });
  });

  test('sends an oblique (1,1,1)/√3 normal to -Y', () => {
    const n = new Vector3(1, 1, 1).normalize();
    const q = quaternionToAlignFaceDown(n);
    const rotated = rotate(n, q);
    expect({ x: rotated.x, y: rotated.y, z: rotated.z }).toEqualWithTolerance(
      { x: 0, y: -1, z: 0 },
      { abs: 1e-6 },
    );
  });
});

describe('recenterGroup', () => {
  test('on identity rotation, offsets so min.y = 0 and xz-center = 0', () => {
    const { group, mesh } = buildGroupWithBox();
    // Box is 2×1×1 centered at origin → AABB (-1,-0.5,-0.5)–(1,0.5,0.5).
    // Expected offset: (0, 0.5, 0) → min.y becomes 0.
    const offset = recenterGroup(group, mesh);
    expect({ x: offset.x, y: offset.y, z: offset.z }).toEqualWithTolerance(
      { x: 0, y: 0.5, z: 0 },
      { abs: 1e-6 },
    );
    const worldBbox = new Box3().setFromObject(mesh);
    expect(worldBbox.min.y).toEqualWithTolerance(0, { abs: 1e-6 });
    const worldCenter = new Vector3();
    worldBbox.getCenter(worldCenter);
    expect(worldCenter.x).toEqualWithTolerance(0, { abs: 1e-6 });
    expect(worldCenter.z).toEqualWithTolerance(0, { abs: 1e-6 });
  });

  test('on a non-identity rotation, re-centers the rotated bbox', () => {
    const { group, mesh } = buildGroupWithBox();
    // Rotate 90° around +X so the box's original +Y face ends up at +Z.
    // The 2×1×1 box becomes a 2×1×1 block with extents:
    //   x: [-1, 1], y: [-0.5, 0.5] (was -0.5..0.5 on z), z: [-0.5, 0.5].
    group.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);

    const offset = recenterGroup(group, mesh);
    // Under this rotation, min.y is the lower bound on the new Y extent,
    // which is -0.5. So offset.y must be +0.5 to bring min.y to 0.
    expect(offset.y).toEqualWithTolerance(0.5, { abs: 1e-6 });

    // World-space bbox after recenter must satisfy the on-the-bed
    // contract, regardless of rotation.
    const worldBbox = new Box3().setFromObject(mesh);
    expect(worldBbox.min.y).toEqualWithTolerance(0, { abs: 1e-6 });
    const worldCenter = new Vector3();
    worldBbox.getCenter(worldCenter);
    expect(worldCenter.x).toEqualWithTolerance(0, { abs: 1e-6 });
    expect(worldCenter.z).toEqualWithTolerance(0, { abs: 1e-6 });
  });

  test('handles a composed rotation (two lay-flats chained)', () => {
    const { group, mesh } = buildGroupWithBox();
    // Compose two quaternions: first flip +Y → -Y, then (on top) rotate
    // 45° around +Z. `premultiply` is the composition order the
    // controller uses — verify recenter works under it.
    const qFlip = quaternionToAlignFaceDown(new Vector3(0, 1, 0));
    const q45 = new Quaternion().setFromAxisAngle(
      new Vector3(0, 0, 1),
      Math.PI / 4,
    );
    group.quaternion.copy(qFlip);
    group.quaternion.premultiply(q45);

    recenterGroup(group, mesh);
    const worldBbox = new Box3().setFromObject(mesh);
    expect(worldBbox.min.y).toEqualWithTolerance(0, { abs: 1e-6 });
  });
});

describe('resetOrientation', () => {
  test('restores identity quaternion and re-applies auto-center', () => {
    const { group, mesh } = buildGroupWithBox();
    // Start from a rotated + re-centered state.
    group.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 3);
    recenterGroup(group, mesh);
    // Sanity: under non-identity rotation the offset is non-zero in Y.
    expect(group.position.y).not.toEqualWithTolerance(0.5, { abs: 1e-6 });

    resetOrientation(group, mesh);
    // Identity rotation restores the 2×1×1 box's natural AABB, so the
    // offset collapses to (0, 0.5, 0) — same as the very first
    // `recenterGroup` call in the identity-rotation test.
    expect({ x: group.position.x, y: group.position.y, z: group.position.z })
      .toEqualWithTolerance({ x: 0, y: 0.5, z: 0 }, { abs: 1e-6 });
    // Quaternion is exactly identity.
    expect({
      x: group.quaternion.x,
      y: group.quaternion.y,
      z: group.quaternion.z,
      w: group.quaternion.w,
    }).toEqualWithTolerance({ x: 0, y: 0, z: 0, w: 1 }, { abs: 1e-12 });
  });
});

describe('BufferGeometry position buffer — lay-flat invariant', () => {
  test('rotation + recenter leaves `mesh.geometry.attributes.position` UNCHANGED', () => {
    // The critical invariant from PR #29, restated as issue #32's ninth AC:
    // "mesh.geometry.attributes.position values UNCHANGED before and after
    // lay-flat (proven by test walking the buffer)."
    const { group, mesh } = buildGroupWithBox();
    const posAttr = mesh.geometry.getAttribute('position');
    const before = Float32Array.from(posAttr.array as ArrayLike<number>);

    // Simulate a full lay-flat: compose a rotation, recenter.
    group.quaternion.premultiply(
      quaternionToAlignFaceDown(new Vector3(1, 0, 0)),
    );
    recenterGroup(group, mesh);

    // And a second one (compose chaining).
    group.quaternion.premultiply(
      quaternionToAlignFaceDown(new Vector3(0, 0, 1)),
    );
    recenterGroup(group, mesh);

    // Finally a reset.
    resetOrientation(group, mesh);

    const after = Float32Array.from(posAttr.array as ArrayLike<number>);
    // Walk the buffer element-by-element. ANY drift in the array would
    // mean the code accidentally mutated the geometry.
    expect(after.length).toBe(before.length);
    for (let i = 0; i < before.length; i++) {
      // Exact equality: not a tolerance compare. The vertex buffer must
      // be bit-identical — nothing is supposed to touch it.
      expect(after[i]).toBe(before[i]);
    }
  });
});

describe('localNormalToWorld', () => {
  test('returns the same normal when the group is identity', () => {
    const { group, mesh } = buildGroupWithBox();
    group.updateMatrixWorld(true);
    const worldN = localNormalToWorld(mesh, new Vector3(1, 0, 0));
    expect({ x: worldN.x, y: worldN.y, z: worldN.z }).toEqualWithTolerance(
      { x: 1, y: 0, z: 0 },
      { abs: 1e-6 },
    );
  });

  test('applies the group rotation correctly', () => {
    const { group, mesh } = buildGroupWithBox();
    // Rotate the group 90° around +Z — local +X maps to world +Y.
    group.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
    group.updateMatrixWorld(true);
    const worldN = localNormalToWorld(mesh, new Vector3(1, 0, 0));
    expect({ x: worldN.x, y: worldN.y, z: worldN.z }).toEqualWithTolerance(
      { x: 0, y: 1, z: 0 },
      { abs: 1e-6 },
    );
  });

  test('ignores a pure translation on the group (normals are direction-only)', () => {
    const { group, mesh } = buildGroupWithBox();
    group.position.set(100, 200, 300);
    group.updateMatrixWorld(true);
    const worldN = localNormalToWorld(mesh, new Vector3(0, 1, 0));
    expect({ x: worldN.x, y: worldN.y, z: worldN.z }).toEqualWithTolerance(
      { x: 0, y: 1, z: 0 },
      { abs: 1e-6 },
    );
  });
});

describe('issue #32 AC — `quaternionToAlignFaceDown` edge cases', () => {
  // Dedicated block mirroring the exact wording of the AC checklist so
  // qa-engineer can map each test to its acceptance bullet at a glance.

  test('AC: `quaternionToAlignFaceDown(new Vector3(0, 1, 0))` rotates (0,1,0) → (0,-1,0)', () => {
    const q = quaternionToAlignFaceDown(new Vector3(0, 1, 0));
    const out = rotate(new Vector3(0, 1, 0), q);
    expect(out.y).toEqualWithTolerance(-1, { abs: 1e-6 });
    // And the orthogonal components remain zero (the rotation axis lies in XZ).
    expect(Math.abs(out.x) + Math.abs(out.z)).toBeLessThan(1e-6);
  });

  test('AC: `quaternionToAlignFaceDown(new Vector3(1, 0, 0))` rotates X → -Y', () => {
    const q = quaternionToAlignFaceDown(new Vector3(1, 0, 0));
    const out = rotate(new Vector3(1, 0, 0), q);
    expect({ x: out.x, y: out.y, z: out.z }).toEqualWithTolerance(
      { x: 0, y: -1, z: 0 },
      { abs: 1e-6 },
    );
  });

  test('AC: `quaternionToAlignFaceDown(new Vector3(0, -1, 0))` is ≈ identity', () => {
    const q = quaternionToAlignFaceDown(new Vector3(0, -1, 0));
    // |q - identity| in quaternion space under tolerance.
    expect(q.w).toEqualWithTolerance(1, { abs: 1e-6 });
    expect(Math.hypot(q.x, q.y, q.z)).toBeLessThan(1e-6);
  });
});
