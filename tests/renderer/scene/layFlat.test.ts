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
  BufferAttribute,
  BufferGeometry,
  Box3,
  Group,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { describe, expect, test } from 'vitest';

import {
  computeWorldBoxTight,
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

describe('localNormalToWorld — non-uniform scale regression', () => {
  // QA follow-up from PR #34 round 1: pin the invariant that a local
  // normal transformed under a non-uniform-scale parent returns the TRUE
  // world normal (inverse-transpose), not the forward-transform. The
  // Master group in production today only carries rotation + translation,
  // but a future mirror / display-scale feature would regress silently
  // without this test.

  test('applies the inverse-transpose (normal matrix) under non-uniform parent scale', () => {
    // Build a mesh with a diagonal face normal (1, 1, 0)/√2 — picked
    // because the correct and incorrect results differ clearly under
    // `scale.set(2, 1, 0.5)`.
    const group = new Group();
    group.scale.set(2, 1, 0.5);
    const geom = new BoxGeometry(1, 1, 1);
    const mesh = new Mesh(geom, new MeshBasicMaterial());
    group.add(mesh);
    group.updateMatrixWorld(true);

    const localNormal = new Vector3(1, 1, 0).normalize();
    const worldN = localNormalToWorld(mesh, localNormal);

    // Under scale (sx, sy, sz), the inverse-transpose is diag(1/sx, 1/sy, 1/sz),
    // so local (1,1,0)/√2 → (1/2, 1, 0) → normalised (1, 2, 0)/√5.
    // The naive `transformDirection` path would give (2, 1, 0)/√5 instead.
    const invSqrt5 = 1 / Math.sqrt(5);
    expect({ x: worldN.x, y: worldN.y, z: worldN.z }).toEqualWithTolerance(
      { x: 1 * invSqrt5, y: 2 * invSqrt5, z: 0 },
      { abs: 1e-6 },
    );
    // Unit length.
    expect(Math.hypot(worldN.x, worldN.y, worldN.z)).toEqualWithTolerance(
      1,
      { abs: 1e-6 },
    );
  });

  test('still correct under pure rotation (regression — rotation-only must not change)', () => {
    // Safety net: the fix (switch to full normal matrix) must not
    // regress the rotation-only path. Same 90°-Z rotation as the
    // existing `localNormalToWorld` test, but asserted alongside the
    // non-uniform-scale case so both branches are covered in one spot.
    const group = new Group();
    group.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
    const geom = new BoxGeometry(1, 1, 1);
    const mesh = new Mesh(geom, new MeshBasicMaterial());
    group.add(mesh);
    group.updateMatrixWorld(true);

    const worldN = localNormalToWorld(mesh, new Vector3(1, 0, 0));
    expect({ x: worldN.x, y: worldN.y, z: worldN.z }).toEqualWithTolerance(
      { x: 0, y: 1, z: 0 },
      { abs: 1e-6 },
    );
  });
});

describe('computeWorldBoxTight', () => {
  // This helper is the fix for PR #34's windows-e2e blocker: the old
  // `recenterGroup` used `Box3.setFromObject(mesh)` which — without the
  // `precise=true` flag — transforms the geometry's local AABB's 8 corners
  // and unions them. For a non-axis-aligned rotation that over-estimates
  // the world bbox, leaving the mesh floating above Y=0 after recenter.
  // `computeWorldBoxTight` walks vertices directly, giving the tight bbox.

  test('matches the conservative box for axis-aligned rotations (180° around X)', () => {
    // A 180° X-axis rotation maps (x, y, z) → (x, -y, -z). The tight bbox
    // and the conservative corner-transform bbox are identical in this
    // case (the AABB corners are themselves the extrema), so both paths
    // must agree.
    const { group, mesh } = buildGroupWithBox();
    group.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI);
    group.updateMatrixWorld(true);

    const tight = computeWorldBoxTight(mesh);
    const conservative = new Box3().setFromObject(mesh);

    expect(tight.min.x).toEqualWithTolerance(conservative.min.x, { abs: 1e-6 });
    expect(tight.min.y).toEqualWithTolerance(conservative.min.y, { abs: 1e-6 });
    expect(tight.min.z).toEqualWithTolerance(conservative.min.z, { abs: 1e-6 });
    expect(tight.max.x).toEqualWithTolerance(conservative.max.x, { abs: 1e-6 });
    expect(tight.max.y).toEqualWithTolerance(conservative.max.y, { abs: 1e-6 });
    expect(tight.max.z).toEqualWithTolerance(conservative.max.z, { abs: 1e-6 });
  });

  test('is TIGHTER than Box3.setFromObject for an off-diagonal mesh under arbitrary rotation', () => {
    // Reproduces the PR #34 blocker mechanism: a mesh whose vertex set
    // does NOT coincide with its AABB corners (a tetrahedron is the
    // minimal example), rotated by an off-axis angle. The conservative
    // bbox over-estimates; the tight bbox is strictly smaller.
    const group = new Group();
    const geom = new BufferGeometry();
    // Tetrahedron with vertices inside the unit cube but not at corners.
    // AABB corners = ±0.5, but no vertex sits AT (±0.5, ±0.5, ±0.5).
    const verts = new Float32Array([
      // Triangle 1
      0.5, 0.0, 0.0,
      0.0, 0.5, 0.0,
      0.0, 0.0, 0.5,
      // Triangle 2
      0.5, 0.0, 0.0,
      0.0, 0.0, 0.5,
      0.0, -0.5, 0.0,
      // Triangle 3
      0.0, 0.5, 0.0,
      -0.5, 0.0, 0.0,
      0.0, 0.0, 0.5,
      // Triangle 4
      -0.5, 0.0, 0.0,
      0.0, -0.5, 0.0,
      0.0, 0.0, 0.5,
    ]);
    geom.setAttribute('position', new BufferAttribute(verts, 3));
    geom.computeBoundingBox();
    const mesh = new Mesh(geom, new MeshBasicMaterial());
    group.add(mesh);
    // 45° rotation around Y — off-axis, so the conservative 8-corner
    // transform over-estimates the rotated-vertex bbox.
    group.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 4);
    group.updateMatrixWorld(true);

    const tight = computeWorldBoxTight(mesh);
    const conservative = new Box3().setFromObject(mesh);

    // Tight must be contained within conservative, and STRICTLY smaller
    // in at least one extent (the X or Z axis for a Y-rotation).
    expect(tight.min.x).toBeGreaterThanOrEqual(conservative.min.x - 1e-9);
    expect(tight.max.x).toBeLessThanOrEqual(conservative.max.x + 1e-9);
    expect(tight.min.z).toBeGreaterThanOrEqual(conservative.min.z - 1e-9);
    expect(tight.max.z).toBeLessThanOrEqual(conservative.max.z + 1e-9);
    const tightXSize = tight.max.x - tight.min.x;
    const conservativeXSize = conservative.max.x - conservative.min.x;
    expect(tightXSize).toBeLessThan(conservativeXSize);
  });

  test('returns empty Box3 on a mesh with no position attribute', () => {
    const mesh = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
    const box = computeWorldBoxTight(mesh);
    expect(box.isEmpty()).toBe(true);
  });
});

describe('issue #32 AC #12 — recenterGroup on arbitrary rotation (tight bbox)', () => {
  // Direct regression for the windows-e2e blocker: after recenterGroup
  // on a group with an arbitrary rotation, the TRUE (vertex-walk) world
  // min.y of the mesh must be ≈ 0 within 1e-4 mm — same tolerance the
  // E2E spec uses on the real mini-figurine.

  test('arbitrary rotation → vertex-walk world min.y is 0 within 1e-4 mm', () => {
    const { group, mesh } = buildGroupWithBox();
    // Compose two rotations that do NOT align with the AABB — this is
    // the regime where the old `Box3.setFromObject` path left the mesh
    // floating above zero.
    const q1 = new Quaternion().setFromAxisAngle(
      new Vector3(1, 0, 0),
      Math.PI / 3,
    );
    const q2 = new Quaternion().setFromAxisAngle(
      new Vector3(0, 1, 1).normalize(),
      Math.PI / 5,
    );
    group.quaternion.copy(q1).premultiply(q2);

    recenterGroup(group, mesh);

    // Walk the vertex buffer exactly like the E2E spec does and verify
    // the minimum world-space Y is 0.
    const tight = computeWorldBoxTight(mesh);
    expect(tight.min.y).toEqualWithTolerance(0, { abs: 1e-4 });
  });
});
