// src/renderer/scene/moldBaseOffset.ts
//
// Issue #87 dogfood fix (Fix 2): lift the whole mold assembly UP by
// `baseSlabThickness_mm` after Generate so the base slab sits ON the
// print bed (world Y=0) instead of below it.
//
// Pre-fix geometry: `scene/master.ts` auto-centers the master on
// `y=0` (mesh.min.y == 0), and `buildBaseSlab` extrudes the slab
// DOWN from master.min.y by baseSlabThickness. So after Generate
// the slab lived at `y ∈ [-baseSlabThickness, 0]`, entirely below
// the visual floor plane — invisible from every standard camera
// angle unless the user orbited under the bed.
//
// Real mold-making: you print the slab, the shell drops over the
// plug on top of the slab, the master sits inside, silicone pours
// in. The slab is the BOTTOM of the printable stack, so `Y=0`
// should be its underside (the print bed), not the master's
// underside.
//
// Fix: after every successful Generate, translate the master group
// + silicone group + printable-parts group UP by
// `baseSlabThickness_mm`. The master's lay-flat invariant
// ("mesh.min.y == 0 in world frame") is NOT violated — we only
// move it while a mold is in the scene, and every staleness signal
// (commit, reset orientation, new STL) tears the mold down AND
// clears this offset in one sweep.
//
// Implementation shape:
//
//   applyMoldBaseOffset(scene, offsetY):
//     - Stash the offset on the master group's userData so subsequent
//       `setMasterScale` calls (which call `recenterGroup` and write
//       an absolute position) can re-apply it.
//     - Add `offsetY` to each of master / silicone / printableParts
//       group Y positions.
//
//   clearMoldBaseOffset(scene):
//     - Remove the userData stash.
//     - Subtract the stored offset from every group's Y position.
//
// Re-application contract: `recenterGroup` (in `layFlat.ts`) writes
// `group.position.y = -bbox.min.y`. To play nicely with this
// module, `recenterGroup` callers that run while a mold is active
// should re-apply the offset after recenter. In v1 the only caller
// that runs "with a mold active" is `setMasterScale` via a
// dimensions change — BUT the dimensions-store subscription flips
// the mold to "stale" and does NOT clear the scene-side mold. We
// therefore need to snap the master group back to +offset after
// recenter. Instead of threading this everywhere, we stash the
// offset and expose a helper `reapplyMoldBaseOffsetToMaster` that
// `viewport.setMasterScale` calls after `recenterGroup`.

import type { Group, Scene } from 'three';

/** `userData` key on the master group where the active offset lives. */
export const MOLD_BASE_OFFSET_KEY = 'moldBaseOffsetY';

function findGroupByTag(scene: Scene, tag: string): Group | null {
  for (const child of scene.children) {
    if (child.userData['tag'] === tag) {
      return child as Group;
    }
  }
  return null;
}

/**
 * Read the current mold-base offset in mm, or 0 if no mold is
 * currently generated. Non-throwing — callers can treat the absence
 * of a master group as "no offset active".
 */
export function getMoldBaseOffset(scene: Scene): number {
  const master = findGroupByTag(scene, 'master');
  if (!master) return 0;
  const stored = master.userData[MOLD_BASE_OFFSET_KEY];
  return typeof stored === 'number' && Number.isFinite(stored) ? stored : 0;
}

/**
 * Lift the mold assembly by `offsetY` mm. Idempotent w.r.t. a
 * previously-applied offset — the new offset replaces the old one
 * atomically (previous offset subtracted, new offset added).
 *
 * Zero / negative / non-finite offsets are treated as "clear the
 * offset"; prefer `clearMoldBaseOffset` for readability at call
 * sites.
 */
export function applyMoldBaseOffset(scene: Scene, offsetY: number): void {
  if (!Number.isFinite(offsetY) || offsetY <= 0) {
    clearMoldBaseOffset(scene);
    return;
  }
  const master = findGroupByTag(scene, 'master');
  const silicone = findGroupByTag(scene, 'silicone');
  const printableParts = findGroupByTag(scene, 'printableParts');

  const prev = getMoldBaseOffset(scene);
  const delta = offsetY - prev;
  if (delta === 0) return;

  if (master) {
    master.position.y += delta;
    master.userData[MOLD_BASE_OFFSET_KEY] = offsetY;
    master.updateMatrixWorld(true);
  }
  if (silicone) silicone.position.y += delta;
  if (printableParts) printableParts.position.y += delta;
}

/**
 * Restore the mold assembly's Y positions to their pre-offset rest
 * state. Idempotent — safe to call when no offset is active. Invoked
 * on every staleness signal (commit, reset, new STL).
 */
export function clearMoldBaseOffset(scene: Scene): void {
  const master = findGroupByTag(scene, 'master');
  const silicone = findGroupByTag(scene, 'silicone');
  const printableParts = findGroupByTag(scene, 'printableParts');

  const prev = master
    ? (master.userData[MOLD_BASE_OFFSET_KEY] as number | undefined)
    : undefined;
  if (!prev || !Number.isFinite(prev) || prev === 0) {
    // No offset to clear. Defensively wipe the userData slot anyway
    // in case a stray non-zero value was left behind.
    if (master) delete master.userData[MOLD_BASE_OFFSET_KEY];
    return;
  }

  if (master) {
    master.position.y -= prev;
    delete master.userData[MOLD_BASE_OFFSET_KEY];
    master.updateMatrixWorld(true);
  }
  if (silicone) silicone.position.y -= prev;
  if (printableParts) printableParts.position.y -= prev;
}

/**
 * After `recenterGroup` has clobbered the master group's Y position
 * (e.g. after a dimensions-panel scale change or lay-flat commit),
 * re-apply whatever mold-base offset was active. Safe to call on a
 * scene with no offset in play — falls through to a no-op. Needed
 * because `recenterGroup` writes `position.y` ABSOLUTELY and would
 * otherwise snap the master back to Y=0 while the mold is still
 * visible.
 *
 * Note: v1 only calls this from `viewport.setMasterScale` — lay-flat
 * commit fires an invalidation that clears the mold entirely, which
 * also clears the offset, so the re-apply isn't needed on that path.
 */
export function reapplyMoldBaseOffsetToMaster(scene: Scene): void {
  const master = findGroupByTag(scene, 'master');
  if (!master) return;
  const stored = master.userData[MOLD_BASE_OFFSET_KEY];
  if (typeof stored !== 'number' || !Number.isFinite(stored) || stored <= 0) {
    return;
  }
  master.position.y += stored;
  master.updateMatrixWorld(true);
}
