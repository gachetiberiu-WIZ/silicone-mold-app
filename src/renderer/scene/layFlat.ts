// src/renderer/scene/layFlat.ts
//
// Pure math + scene-graph helpers for the "Place on face" (lay-flat)
// interaction. This module deliberately owns zero rendering state,
// zero pointer bookkeeping, and zero DOM bindings — the controller in
// `layFlatController.ts` consumes these primitives.
//
// The critical invariant (locked by PR #29, reinforced by issue #32):
//
//   Viewport-level transforms mutate the Master GROUP only. We NEVER
//   touch `BufferGeometry.attributes.position` or the paired `Manifold`.
//   Downstream booleans / offsets / STL export therefore keep the user's
//   original STL-faithful coordinates, regardless of how the user has
//   rotated or re-centered the mesh for display.
//
// Two responsibilities:
//
//   1. `quaternionToAlignFaceDown(worldNormal)` — compute the rotation
//      that maps a given (world-space) face normal to `(0, -1, 0)`, i.e.
//      the face pointing at the print bed.
//   2. `recenterGroup(group, mesh)` — given a Master group whose
//      quaternion may have been composed with lay-flat rotations,
//      re-derive the world-space AABB of its child mesh and translate
//      the group so the mesh sits on Y=0 (lowest point) and centered
//      on X=0/Z=0. This is the same contract the original `setMaster`
//      auto-center pass satisfied (issue #25), now applicable on every
//      rotation tick.
//
// `resetOrientation(group, mesh)` is a thin convenience: snap the
// quaternion back to identity and re-apply recentering. The caller is
// responsible for re-framing the camera afterwards (see viewport.ts).

import { Box3, Quaternion, Vector3, type Mesh, type Object3D } from 'three';

/**
 * Compute the quaternion that rotates `worldNormal` to align with the
 * downward world axis `(0, -1, 0)`. This is what "lay this face on the
 * bed" means geometrically.
 *
 * Edge case — normal already points down:
 *   `setFromUnitVectors((0,-1,0), (0,-1,0))` returns an identity
 *   quaternion (dot = 1). No rotation applied. Test asserts this.
 *
 * Edge case — normal points up (opposite to target):
 *   `setFromUnitVectors` picks a stable axis perpendicular to the input
 *   (it tries X first, falls back to Y), so the 180° flip is well-defined
 *   around X-axis for a `(0,1,0) → (0,-1,0)` input. Either X-axis or
 *   Z-axis flip is acceptable — the face ends up down either way. Test
 *   pins the behaviour regardless of which axis Three picks.
 *
 * The input does not need to be pre-normalised; we normalise defensively.
 */
export function quaternionToAlignFaceDown(worldNormal: Vector3): Quaternion {
  const from = worldNormal.clone().normalize();
  const to = new Vector3(0, -1, 0);
  return new Quaternion().setFromUnitVectors(from, to);
}

/**
 * Translate `group` so that the world-space AABB of its `mesh` child
 * satisfies the auto-center-on-bed contract:
 *   - mesh's bbox.min.y === 0  (lowest face sits on the print bed)
 *   - mesh's bbox.center.x === 0 (centered on world X)
 *   - mesh's bbox.center.z === 0 (centered on world Z)
 *
 * This is the same math `setMaster` runs on load, extracted here so the
 * lay-flat controller can re-apply it after rotating the group (which
 * in general leaves the mesh floating above / below / off-center
 * relative to the bed).
 *
 * Implementation notes:
 *
 *   - We reset `group.position` to zero FIRST, then `updateMatrixWorld`,
 *     then compute the world-space bbox. This gives us the bbox of the
 *     rotation-only transform — any previous translation would otherwise
 *     contaminate the result.
 *   - `Box3.setFromObject(mesh)` walks the child's geometry and transforms
 *     its local bounding sphere / AABB into world space. That's exactly
 *     what we need after a quaternion mutation: the vertex buffer is
 *     untouched, but the world-space footprint has changed.
 *   - Returns the offset applied (post-rotation, pre-translation) as a
 *     fresh `Vector3` so callers can derive the world-space bbox without
 *     a second scan.
 */
export function recenterGroup(group: Object3D, mesh: Mesh): Vector3 {
  // Wipe the group's translation so the bbox below reflects only the
  // current rotation. If we skipped this, a previous offset would shift
  // the bbox and `offset` would accumulate over successive lay-flats.
  group.position.set(0, 0, 0);
  group.updateMatrixWorld(true);

  // World-space bbox under the current rotation.
  const worldBbox = new Box3().setFromObject(mesh);
  const center = new Vector3();
  worldBbox.getCenter(center);

  const offset = new Vector3(-center.x, -worldBbox.min.y, -center.z);
  group.position.set(offset.x, offset.y, offset.z);
  group.updateMatrixWorld(true);

  return offset;
}

/**
 * Restore the Master group to its pre-lay-flat state: identity rotation,
 * followed by an auto-center pass. Equivalent to "Reset orientation" in
 * the UI. The returned offset is the same one `setMaster` would have
 * applied on initial load — the STL-faithful vertex buffer guarantees
 * the result is identical.
 */
export function resetOrientation(group: Object3D, mesh: Mesh): Vector3 {
  group.quaternion.identity();
  return recenterGroup(group, mesh);
}

/**
 * Transform a mesh-LOCAL face normal into world space.
 *
 * `intersection.face.normal` from three-mesh-bvh is in the mesh's LOCAL
 * frame (the untouched BufferGeometry coords). For the lay-flat math
 * to work correctly after repeated rotations, we need the same normal
 * expressed in WORLD frame — which means applying the mesh's world
 * normal matrix (inverse-transpose of the world matrix's 3x3 upper
 * block) to the local normal.
 *
 * For a pure-rotation + translation transform (which is what the Master
 * group carries) the normal matrix equals the rotation part directly,
 * so this is cheap. We still go through the full normal-matrix path
 * because the scene-graph API makes no contract that the group's
 * transform will stay rotation-only — e.g. a future mirror feature
 * would introduce a reflection and the normal matrix would need to
 * invert the sign.
 */
export function localNormalToWorld(mesh: Mesh, localNormal: Vector3): Vector3 {
  // Ensure the mesh's world matrix is current before reading it. Callers
  // that mutate `group.quaternion` AND immediately compute a normal need
  // this or they get a stale normal matrix.
  mesh.updateMatrixWorld(true);

  const worldNormal = localNormal.clone();
  // Extract the 3x3 rotation/scale/shear part of the world matrix and
  // apply its inverse-transpose to the normal. Three.js provides
  // `Vector3.transformDirection(matrix4)` which does exactly that and
  // re-normalises — what we want here.
  worldNormal.transformDirection(mesh.matrixWorld);
  return worldNormal.normalize();
}
