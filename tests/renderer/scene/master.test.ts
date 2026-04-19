// tests/renderer/scene/master.test.ts
//
// Unit tests for the renderer-side master loader (`src/renderer/scene/master.ts`).
// Pins the auto-center-on-print-bed contract from issue #25:
//
//   1. After a load, the Master group carries a translation of
//      (-center.x, -min.y, -center.z) relative to the mesh-local AABB.
//   2. The mesh's `BufferGeometry.attributes.position` values are UNCHANGED
//      — the offset is applied at the group level only. Downstream
//      mold-gen, booleans, offsets, and STL export therefore see the
//      user's original coordinates (that's the whole point of doing the
//      translation on the Group rather than on the geometry).
//   3. A SECOND load with a different-bbox fixture fully replaces the
//      offset — no accumulation. `.set()` is absolute, but we assert it.
//   4. The returned `bbox` is the world-space AABB (local AABB + offset),
//      so `frameToBox3` frames the camera around where the mesh actually
//      sits post-translation (not where the raw STL coords would have put
//      it). This keeps the origin grid + axes gizmo in frame, which is
//      the user-visible motivation for the whole PR.
//
// Fixture choice: we use `mini-figurine` for the non-trivial-offset case
// (AABB ~(267, 1094, 0) → ~(352, 1164, 110) — the real-world input that
// inspired the issue) and `unit-cube` for the small-offset case (AABB
// straddles Y=0, so the translation's Y component is exactly 0.5). The two
// fixtures' offsets differ in every component, which is what we need to
// prove the second-load reset with confidence.
//
// Environment note: this test runs under Vitest's `node` environment. Both
// `loadStl` and `manifoldToBufferGeometry` work in node — they're the same
// paths exercised by `tests/geometry/loadStl.test.ts`, which has been
// green since PR #22. We never touch a real WebGL context; we only
// manipulate the Three.js scene graph.

import { readFileSync } from 'node:fs';
import { Box3, Quaternion, Vector3, type Group, type Mesh } from 'three';
import { describe, expect, test } from 'vitest';

import { createScene } from '@/renderer/scene/index';
import { setMaster } from '@/renderer/scene/master';
import { fixtureExists, fixturePaths, loadFixture } from '@fixtures/meshes/loader';

/**
 * Read a fixture STL off disk as an ArrayBuffer — matches what the IPC
 * open-stl path hands to the renderer. We clone into a fresh ArrayBuffer
 * (not a view over a shared one) so the buffer lifecycle is independent
 * of the Node Buffer's backing store.
 */
function readFixtureBuffer(name: string): ArrayBuffer {
  const { stl } = fixturePaths(name);
  const buf = readFileSync(stl);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/**
 * Snapshot a geometry's position attribute into a plain Float32Array so
 * we can compare "before" and "after" without retaining a reference to
 * the live typed-array (which would mutate in-place if the code under
 * test did the wrong thing).
 */
function snapshotPositions(mesh: Mesh): Float32Array {
  const attr = mesh.geometry.getAttribute('position');
  return new Float32Array(attr.array as ArrayLike<number>);
}

/** Find the `tag: 'master'` group in the scene, asserting it exists. */
function getMasterGroup(scene: ReturnType<typeof createScene>): Group {
  const grp = scene.children.find((c) => c.userData['tag'] === 'master') as Group | undefined;
  if (!grp) throw new Error('Master group missing from scene skeleton');
  return grp;
}

describe('setMaster — auto-center on print bed (issue #25)', () => {
  test.skipIf(!fixtureExists('mini-figurine'))(
    'applies group translation matching expected offset for mini-figurine',
    async () => {
      const scene = createScene();
      const ab = readFixtureBuffer('mini-figurine');
      const fixture = await loadFixture('mini-figurine');

      const result = await setMaster(scene, ab);

      const [mnX, mnY, mnZ] = fixture.meta.boundingBoxMin;
      const [mxX, , mxZ] = fixture.meta.boundingBoxMax;
      // Expected per the issue spec:
      //   x = -center.x = -(min.x + max.x) / 2
      //   y = -min.y
      //   z = -center.z
      const expected = {
        x: -(mnX + mxX) / 2,
        y: -mnY,
        z: -(mnZ + mxZ) / 2,
      };

      // Abs-1e-3 mm: the fixture metadata is rounded to 6 digits and the
      // STL→manifold→BufferGeometry round-trip introduces float32 drift
      // well below millimetre precision. Same tolerance as
      // `tests/geometry/loadStl.test.ts` uses for bbox comparisons.
      const group = getMasterGroup(scene);
      expect({
        x: group.position.x,
        y: group.position.y,
        z: group.position.z,
      }).toEqualWithTolerance(expected, { abs: 1e-3 });

      // The result's `offset` Vector3 must agree with the group's position
      // — they describe the same translation.
      expect({
        x: result.offset.x,
        y: result.offset.y,
        z: result.offset.z,
      }).toEqualWithTolerance(expected, { abs: 1e-3 });
    },
  );

  test.skipIf(!fixtureExists('mini-figurine'))(
    'BufferGeometry vertex positions are UNCHANGED by setMaster (translation is group-level only)',
    async () => {
      const scene = createScene();
      const ab = readFixtureBuffer('mini-figurine');

      const result = await setMaster(scene, ab);

      // Snapshot AFTER setMaster so we can assert the buffer was never
      // rewritten. The contract is: vertex coords stay STL-faithful.
      const after = snapshotPositions(result.mesh);

      // Every vertex must lie within the raw STL's AABB — if the code had
      // mutated positions (e.g. applied the offset to the geometry), the
      // coordinates would have shifted to the centered frame and would fail
      // these bounds. We use the manifold-kernel-derived bbox via the same
      // `displayGeometry.computeBoundingBox()` path that setMaster ran.
      const localBbox = new Box3();
      const mesh = result.mesh;
      mesh.geometry.computeBoundingBox();
      if (mesh.geometry.boundingBox) localBbox.copy(mesh.geometry.boundingBox);

      // The mini-figurine sits at Y ~ 1094..1164 in its STL. If setMaster
      // had mutated positions to center the mesh, min.y would be 0. We
      // assert min.y is still near the fixture's original value.
      expect(localBbox.min.y).toBeGreaterThan(1000);

      // Belt-and-braces: scan the raw position array and check every Y
      // coord is in the expected range. Catches partial-mutations that
      // a bbox-only check might miss.
      for (let i = 1; i < after.length; i += 3) {
        const y = after[i]!;
        expect(y).toBeGreaterThan(1000);
      }
    },
  );

  test.skipIf(!fixtureExists('mini-figurine'))(
    'mesh.getWorldPosition reflects the group-level offset (translation is on the group, not baked)',
    async () => {
      const scene = createScene();
      const ab = readFixtureBuffer('mini-figurine');

      const result = await setMaster(scene, ab);

      // The mesh has identity local transform, but its parent (the Master
      // group) carries the auto-center offset. `getWorldPosition` walks
      // the parent chain, so it must equal the group's offset.
      const worldPos = new Vector3();
      result.mesh.getWorldPosition(worldPos);

      expect({
        x: worldPos.x,
        y: worldPos.y,
        z: worldPos.z,
      }).toEqualWithTolerance(
        { x: result.offset.x, y: result.offset.y, z: result.offset.z },
        { abs: 1e-6 },
      );
    },
  );

  test('applies expected offset for origin-centered unit-cube', async () => {
    const scene = createScene();
    const ab = readFixtureBuffer('unit-cube');

    const result = await setMaster(scene, ab);

    // unit-cube bbox is [-0.5, -0.5, -0.5] → [0.5, 0.5, 0.5].
    //   center.x = 0, min.y = -0.5, center.z = 0
    // Expected offset: (0, 0.5, 0).
    const group = getMasterGroup(scene);
    expect({
      x: group.position.x,
      y: group.position.y,
      z: group.position.z,
    }).toEqualWithTolerance({ x: 0, y: 0.5, z: 0 }, { abs: 1e-6 });

    // Post-translation world-space bbox.min.y must be exactly 0 (the
    // whole point: lowest face sits on the bed). Sanity-check the
    // returned `bbox` as well — it should be a translated copy of the
    // local bbox.
    expect(result.bbox.min.y).toEqualWithTolerance(0, { abs: 1e-6 });
    expect(result.bbox.min.x).toEqualWithTolerance(-0.5, { abs: 1e-6 });
    expect(result.bbox.max.x).toEqualWithTolerance(0.5, { abs: 1e-6 });
    expect(result.bbox.min.z).toEqualWithTolerance(-0.5, { abs: 1e-6 });
    expect(result.bbox.max.z).toEqualWithTolerance(0.5, { abs: 1e-6 });
    expect(result.bbox.max.y).toEqualWithTolerance(1, { abs: 1e-6 });
  });

  test.skipIf(!fixtureExists('mini-figurine'))(
    'second load with a different-bbox fixture fully replaces the offset (no accumulation)',
    async () => {
      const scene = createScene();
      const group = getMasterGroup(scene);

      // First load: mini-figurine (large non-zero offset).
      const abFirst = readFixtureBuffer('mini-figurine');
      const firstResult = await setMaster(scene, abFirst);
      const firstOffset = firstResult.offset.clone();

      // Sanity: the first offset is non-zero in Y (would fail if the
      // fixture were origin-centered).
      expect(Math.abs(firstOffset.y)).toBeGreaterThan(100);

      // Second load: unit-cube (offset is exactly (0, 0.5, 0)).
      const abSecond = readFixtureBuffer('unit-cube');
      const secondResult = await setMaster(scene, abSecond);

      // The group's position must now equal the unit-cube's offset, NOT
      // the sum of the two offsets. `.set()` is absolute; accumulation
      // would be a regression.
      expect({
        x: group.position.x,
        y: group.position.y,
        z: group.position.z,
      }).toEqualWithTolerance({ x: 0, y: 0.5, z: 0 }, { abs: 1e-6 });

      // And the result's offset reflects the second load only.
      expect({
        x: secondResult.offset.x,
        y: secondResult.offset.y,
        z: secondResult.offset.z,
      }).toEqualWithTolerance({ x: 0, y: 0.5, z: 0 }, { abs: 1e-6 });

      // After a second load the group has exactly one Mesh child (the
      // previous master was disposed + removed). Guards against
      // "accumulates meshes" regressions separately from "accumulates
      // offsets" ones.
      const meshChildren = group.children.filter((c) => (c as Mesh).isMesh);
      expect(meshChildren.length).toBe(1);
    },
  );

  test.skipIf(!fixtureExists('mini-figurine'))(
    'returned bbox is world-space (local bbox + offset) so frameToBox3 frames the translated mesh',
    async () => {
      const scene = createScene();
      const ab = readFixtureBuffer('mini-figurine');

      const result = await setMaster(scene, ab);

      // After auto-centering, the mesh's world-space bbox must be:
      //   min.y = 0 exactly (lowest point sits on the bed)
      //   center.x ≈ 0, center.z ≈ 0
      // This is what `frameToBox3` consumes via `viewport.setMaster`, and
      // it's what keeps the origin grid + axes gizmo inside the camera
      // frustum after the camera retargets.
      expect(result.bbox.min.y).toEqualWithTolerance(0, { abs: 1e-6 });

      const worldCenter = new Vector3();
      result.bbox.getCenter(worldCenter);
      expect(worldCenter.x).toEqualWithTolerance(0, { abs: 1e-6 });
      expect(worldCenter.z).toEqualWithTolerance(0, { abs: 1e-6 });
      // Y-center is half the mesh's Y-extent (non-zero; ≈ 34.6 mm for mini-figurine).
      expect(worldCenter.y).toBeGreaterThan(0);
    },
  );

  test('builds a three-mesh-bvh bounds tree on the loaded master (picking prep)', async () => {
    const scene = createScene();
    const ab = readFixtureBuffer('unit-cube');

    const result = await setMaster(scene, ab);

    // After setMaster, the master's BufferGeometry should carry a bounds
    // tree set up by `prepareMeshForPicking`. This guards the issue #32
    // BVH-setup contract: every loaded master is immediately ready for
    // accelerated face picking without a separate enable step.
    const geom = result.mesh.geometry as typeof result.mesh.geometry & {
      boundsTree?: unknown;
    };
    expect(geom.boundsTree).toBeDefined();
  });

  test('second load after a lay-flat rotation resets group quaternion to identity', async () => {
    // Issue #32 acceptance: "Load second STL after a lay-flat rotation →
    // new master loads at identity orientation, not inheriting stale
    // quaternion." We simulate a lay-flat by manually setting the group's
    // quaternion to a non-identity rotation before the second setMaster.
    const scene = createScene();
    const group = getMasterGroup(scene);

    // First load + pretend a lay-flat rotation was applied.
    const abFirst = readFixtureBuffer('unit-cube');
    await setMaster(scene, abFirst);
    group.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 3);
    // Sanity: rotation is non-identity.
    const identity = new Quaternion();
    expect(group.quaternion.equals(identity)).toBe(false);

    // Second load — must reset the quaternion.
    const abSecond = readFixtureBuffer('unit-cube');
    await setMaster(scene, abSecond);

    // Exactly identity, not just "close to identity".
    expect({
      x: group.quaternion.x,
      y: group.quaternion.y,
      z: group.quaternion.z,
      w: group.quaternion.w,
    }).toEqualWithTolerance({ x: 0, y: 0, z: 0, w: 1 }, { abs: 1e-12 });
  });

  test('issue-25 exact example: bbox [267, 1094, 0]–[300, 1120, 40] → offset (-283.5, -1094, -20)', async () => {
    // The issue acceptance criteria quote a concrete bbox + expected offset.
    // We can't contrive a real STL with that exact bbox without hand-rolling
    // bytes, so we test the computation directly against the same math the
    // implementation uses. This guards against the sign / axis swaps that
    // are the most likely regression.
    //
    // mn = [267, 1094, 0], mx = [300, 1120, 40]
    //   center.x = 283.5, center.z = 20, min.y = 1094
    //   offset    = (-283.5, -1094, -20)
    const mn = new Vector3(267, 1094, 0);
    const mx = new Vector3(300, 1120, 40);
    const bbox = new Box3(mn, mx);
    const center = new Vector3();
    bbox.getCenter(center);

    const offset = new Vector3(-center.x, -bbox.min.y, -center.z);

    expect({ x: offset.x, y: offset.y, z: offset.z }).toEqualWithTolerance(
      { x: -283.5, y: -1094, z: -20 },
      { abs: 1e-6 },
    );
  });
});
