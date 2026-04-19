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

import { Box3, Matrix3, Quaternion, Vector3, type Mesh, type Object3D } from 'three';

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
 *   - We walk the mesh's vertex buffer and transform each vertex by the
 *     mesh's `matrixWorld` to compute a **tight** world-space AABB.
 *     `Box3.setFromObject(mesh)` (without `precise=true`) would instead
 *     copy the geometry's local AABB and transform its 8 corners — which
 *     for an arbitrary rotation over-estimates the bbox, leaving
 *     `min.y` lower than the true minimum of the rotated vertex set. On
 *     the mini-figurine fixture (~70 mm tall, organic), that conservative
 *     path puts the mesh floating ~16 mm above the bed after lay-flat
 *     instead of resting on Y=0 — the blocker on PR #34's first round.
 *     We intentionally avoid `Box3.setFromObject(mesh, true)` (the
 *     `precise` flag) because the per-vertex walk here is simpler and
 *     gives the same result without relying on that opt-in flag.
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

  // Tight world-space bbox under the current rotation — vertex walk,
  // not the conservative corner-transform path `Box3.setFromObject`
  // uses by default.
  const worldBbox = computeWorldBoxTight(mesh);
  const center = new Vector3();
  worldBbox.getCenter(center);

  const offset = new Vector3(-center.x, -worldBbox.min.y, -center.z);
  group.position.set(offset.x, offset.y, offset.z);
  group.updateMatrixWorld(true);

  return offset;
}

/**
 * Compute the tight world-space AABB of a mesh by walking its position
 * buffer and transforming each vertex through `mesh.matrixWorld`.
 *
 * This is what `Box3.setFromObject(mesh, true)` (the `precise` flag)
 * does internally, but we implement it here so we don't rely on callers
 * remembering to set that flag — `recenterGroup` needs a tight bbox
 * or the mesh ends up floating after lay-flat (see comment in
 * `recenterGroup`).
 *
 * Returns an empty `Box3` if the mesh has no geometry / no position
 * attribute — callers should be tolerant of that shape (none of the
 * current call sites hit it).
 */
export function computeWorldBoxTight(mesh: Mesh): Box3 {
  const box = new Box3();
  const geometry = mesh.geometry;
  if (!geometry) return box;
  const positionAttribute = geometry.getAttribute('position');
  if (!positionAttribute) return box;

  // Ensure the world matrix reflects any pending transform changes. We
  // update the ancestor chain (not just the mesh) because the mesh's
  // matrixWorld is the product of group.matrixWorld × mesh.matrixLocal.
  mesh.updateWorldMatrix(true, false);

  const v = new Vector3();
  const count = positionAttribute.count;
  for (let i = 0; i < count; i++) {
    v.fromBufferAttribute(positionAttribute, i);
    v.applyMatrix4(mesh.matrixWorld);
    box.expandByPoint(v);
  }
  return box;
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
 * We use `Matrix3.getNormalMatrix(matrix4)`, which gives the true
 * inverse-transpose. The naive alternative — `Vector3.transformDirection`
 * — only re-applies the world matrix's 3x3 block and re-normalises. That
 * is mathematically correct for rotations (orthonormal matrices are
 * self-inverse-transpose modulo sign) and for uniform scale, but gives
 * the wrong answer under non-uniform scale: a local normal `(1, 1, 0)/√2`
 * on a mesh scaled `(2, 1, 0.5)` should transform to `(1, 2, 0)/√5`
 * via the normal matrix, but `transformDirection` yields `(2, 1, 0)/√5`.
 *
 * The Master group today only carries rotation + translation, so both
 * paths produce the same result in production. We still use the full
 * normal-matrix path so v2 additions (mirror, non-uniform display scale)
 * don't silently regress. The non-uniform-scale regression test in
 * `layFlat.test.ts` pins this invariant.
 */
export function localNormalToWorld(mesh: Mesh, localNormal: Vector3): Vector3 {
  // Ensure the mesh's world matrix is current before reading it. Callers
  // that mutate `group.quaternion` AND immediately compute a normal need
  // this or they get a stale normal matrix.
  mesh.updateMatrixWorld(true);

  // `getNormalMatrix` computes the inverse-transpose of the 3x3 upper-left
  // block of the supplied 4x4. Mutating `normalMatrix` here is cheap — it
  // sits on the stack frame for this call only.
  const normalMatrix = new Matrix3().getNormalMatrix(mesh.matrixWorld);
  const worldNormal = localNormal.clone().applyMatrix3(normalMatrix);
  return worldNormal.normalize();
}
