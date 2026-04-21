// tests/renderer/scene/silicone.test.ts
//
// Unit tests for the silicone-preview scene module (`src/renderer/scene/
// silicone.ts`). Wave-A (issue #69) scope: single silicone mesh (the
// horizontal halves + mating keys are gone). Pins:
//
//   1. `setSilicone` places exactly ONE Mesh child under the silicone
//      group, with the expected material properties.
//   2. `setSilicone` replaces a previous mesh atomically — old mesh
//      disposed, old Manifold `.delete()`'d, new mesh installed.
//   3. `setSilicone` carries the mesh at world origin (no inherited
//      group transform — the generator bakes the viewport transform
//      into the Manifold, so double-applying would mis-align it).
//   4. A "Generate × 3" sequence never accumulates meshes or Manifold
//      handles: at every step exactly one mesh + one cached Manifold.
//   5. `clearSilicone` removes the mesh, disposes GPU resources, and
//      calls `.delete()` on the cached Manifold.
//   6. `setExplodedView(true)` lifts `mesh.y` toward `+offset`;
//      `setExplodedView(false)` returns it to y=0. Offset = max(30,
//      0.2 * bboxHeight_mm).
//   7. `setSilicone` returns a bbox from the mesh (consumed by camera
//      re-frame logic).

import { DoubleSide, MeshStandardMaterial, type Group, type Mesh } from 'three';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { createScene } from '@/renderer/scene/index';
import { initManifold } from '@/geometry/initManifold';
import {
  SILICONE_MANIFOLD_KEY,
  clearSilicone,
  hasSilicone,
  setExplodedView,
  setSilicone,
} from '@/renderer/scene/silicone';

let toplevel: ManifoldToplevel;

beforeAll(async () => {
  toplevel = await initManifold();
});

function getSiliconeGroup(scene: ReturnType<typeof createScene>): Group {
  const grp = scene.children.find(
    (c) => c.userData['tag'] === 'silicone',
  ) as Group | undefined;
  if (!grp) throw new Error('silicone group missing from scene skeleton');
  return grp;
}

/**
 * Build a silicone Manifold: a 20×20×20 box at origin. Combined with the
 * floor-branch offset logic (max(30, 0.2 * bboxHeight)) this gives a
 * clean 30 mm exploded-view target.
 */
function makeSilicone(): { silicone: Manifold } {
  const silicone = toplevel.Manifold.cube([20, 20, 20], true);
  return { silicone };
}

/**
 * Build a silicone Manifold with bbox height 400 mm → 0.2 * 400 = 80 mm,
 * comfortably above the 30 mm floor. Pins the bbox-fraction branch.
 */
function makeTallSilicone(): { silicone: Manifold } {
  const silicone = toplevel.Manifold.cube([30, 400, 30], true);
  return { silicone };
}

describe('setSilicone — basic install', () => {
  test('places exactly one Mesh child under the silicone group', async () => {
    const scene = createScene();
    const payload = makeSilicone();

    const result = await setSilicone(scene, payload);

    const group = getSiliconeGroup(scene);
    const meshChildren = group.children.filter((c) => (c as Mesh).isMesh);
    expect(meshChildren.length).toBe(1);
    expect(meshChildren[0]).toBe(result.mesh);
  });

  test('installs the expected material on the mesh', async () => {
    const scene = createScene();
    const payload = makeSilicone();

    const { mesh } = await setSilicone(scene, payload);

    const mat = mesh.material as MeshStandardMaterial;
    expect(mat).toBeInstanceOf(MeshStandardMaterial);
    expect(mat.color.getHex()).toBe(0x4a9eff);
    expect(mat.transparent).toBe(true);
    expect(mat.opacity).toBeCloseTo(0.35, 5);
    expect(mat.side).toBe(DoubleSide);
    expect(mat.depthWrite).toBe(false);
    expect(mat.roughness).toBeCloseTo(0.6, 5);
    expect(mat.metalness).toBeCloseTo(0.0, 5);
  });

  test('mesh renders at world origin (no group-level transform)', async () => {
    const scene = createScene();
    const payload = makeSilicone();

    await setSilicone(scene, payload);

    const group = getSiliconeGroup(scene);
    expect(group.position.x).toBe(0);
    expect(group.position.y).toBe(0);
    expect(group.position.z).toBe(0);
    expect(group.quaternion.x).toBe(0);
    expect(group.quaternion.y).toBe(0);
    expect(group.quaternion.z).toBe(0);
    expect(group.quaternion.w).toBe(1);
    expect(group.scale.x).toBe(1);
    expect(group.scale.y).toBe(1);
    expect(group.scale.z).toBe(1);
  });

  test('returned bbox reflects the silicone body', async () => {
    const scene = createScene();
    const payload = makeSilicone();

    const { bbox } = await setSilicone(scene, payload);

    // 20×20×20 cube centred at origin → bbox X/Y/Z ∈ [-10, 10].
    expect(bbox.min.x).toBeCloseTo(-10, 4);
    expect(bbox.min.y).toBeCloseTo(-10, 4);
    expect(bbox.min.z).toBeCloseTo(-10, 4);
    expect(bbox.max.x).toBeCloseTo(10, 4);
    expect(bbox.max.y).toBeCloseTo(10, 4);
    expect(bbox.max.z).toBeCloseTo(10, 4);
  });

  test('caches the Manifold on the group userData for later disposal', async () => {
    const scene = createScene();
    const payload = makeSilicone();

    await setSilicone(scene, payload);

    const group = getSiliconeGroup(scene);
    expect(group.userData[SILICONE_MANIFOLD_KEY]).toBe(payload.silicone);
  });

  test('hasSilicone reports true after setSilicone', async () => {
    const scene = createScene();
    expect(hasSilicone(scene)).toBe(false);
    await setSilicone(scene, makeSilicone());
    expect(hasSilicone(scene)).toBe(true);
  });
});

describe('setSilicone — replacement (no accumulation)', () => {
  test('second setSilicone replaces the first mesh, does not accumulate', async () => {
    const scene = createScene();
    const first = makeSilicone();
    await setSilicone(scene, first);

    // Wrap the Manifold's `.delete()` AFTER install so we can spy on the
    // eviction call triggered by the next setSilicone.
    const firstDelete = vi.fn(first.silicone.delete.bind(first.silicone));
    first.silicone.delete = firstDelete;

    const second = makeSilicone();
    await setSilicone(scene, second);

    const group = getSiliconeGroup(scene);
    const meshChildren = group.children.filter((c) => (c as Mesh).isMesh);
    expect(meshChildren.length).toBe(1);

    // Previous Manifold was released.
    expect(firstDelete).toHaveBeenCalledTimes(1);

    // New Manifold is cached.
    expect(group.userData[SILICONE_MANIFOLD_KEY]).toBe(second.silicone);
  });

  test('generate × 3 leaves exactly one mesh + one cached Manifold', async () => {
    const scene = createScene();
    const group = getSiliconeGroup(scene);

    for (let i = 0; i < 3; i++) {
      await setSilicone(scene, makeSilicone());
      const meshes = group.children.filter((c) => (c as Mesh).isMesh);
      expect(meshes.length).toBe(1);
      expect(group.userData[SILICONE_MANIFOLD_KEY]).toBeDefined();
    }
  });
});

describe('clearSilicone', () => {
  test('removes the mesh, disposes GPU resources, and deletes the cached Manifold', async () => {
    const scene = createScene();
    const payload = makeSilicone();
    const siliconeDelete = vi.fn(payload.silicone.delete.bind(payload.silicone));
    payload.silicone.delete = siliconeDelete;

    const { mesh } = await setSilicone(scene, payload);

    const geomDispose = vi.spyOn(mesh.geometry, 'dispose');
    const matDispose = vi.spyOn(
      mesh.material as MeshStandardMaterial,
      'dispose',
    );

    clearSilicone(scene);

    const group = getSiliconeGroup(scene);
    const meshes = group.children.filter((c) => (c as Mesh).isMesh);
    expect(meshes.length).toBe(0);

    expect(geomDispose).toHaveBeenCalledTimes(1);
    expect(matDispose).toHaveBeenCalledTimes(1);
    expect(siliconeDelete).toHaveBeenCalledTimes(1);

    expect(group.userData[SILICONE_MANIFOLD_KEY]).toBeUndefined();
    expect(hasSilicone(scene)).toBe(false);
  });

  test('is idempotent on an empty scene (no silicone installed)', () => {
    const scene = createScene();
    expect(() => clearSilicone(scene)).not.toThrow();
    expect(() => clearSilicone(scene)).not.toThrow();
    expect(hasSilicone(scene)).toBe(false);
  });

  test('is idempotent after a successful install + clear (double-clear)', async () => {
    const scene = createScene();
    await setSilicone(scene, makeSilicone());
    clearSilicone(scene);
    expect(() => clearSilicone(scene)).not.toThrow();
  });
});

describe('setExplodedView', () => {
  test('fraction=1 lifts the mesh to +offset; floor branch', async () => {
    const scene = createScene();
    await setSilicone(scene, makeSilicone());
    const group = getSiliconeGroup(scene);
    const mesh = group.children.find(
      (c) => c.userData['tag'] === 'silicone-body',
    ) as Mesh;

    // 20×20×20 bbox height 20 → 0.2*20 = 4; floor = 30 → offset = 30.
    setExplodedView(scene, true);
    advanceRaf(300); // past the 250 ms tween.

    expect(mesh.position.y).toBeCloseTo(30, 4);

    setExplodedView(scene, false);
    advanceRaf(300);

    expect(mesh.position.y).toBeCloseTo(0, 4);
  });

  test('offset honours bbox-fraction branch when 0.2 * height > 30 mm', async () => {
    const scene = createScene();
    await setSilicone(scene, makeTallSilicone());
    const group = getSiliconeGroup(scene);
    const mesh = group.children.find(
      (c) => c.userData['tag'] === 'silicone-body',
    ) as Mesh;

    // 400 mm Y-extent → 0.2*400 = 80 (above floor 30).
    setExplodedView(scene, true);
    advanceRaf(300);

    expect(mesh.position.y).toBeCloseTo(80, 4);
  });

  test('no-op when no silicone is installed (defence-in-depth)', () => {
    const scene = createScene();
    expect(() => setExplodedView(scene, true)).not.toThrow();
    expect(() => setExplodedView(scene, false)).not.toThrow();
  });

  test('a fresh setSilicone resets to collapsed (fraction=0) even after exploded', async () => {
    const scene = createScene();
    await setSilicone(scene, makeSilicone());
    setExplodedView(scene, true);
    advanceRaf(300);

    // Install a new Manifold.
    await setSilicone(scene, makeSilicone());
    const group = getSiliconeGroup(scene);
    const mesh = group.children.find(
      (c) => c.userData['tag'] === 'silicone-body',
    ) as Mesh;

    expect(mesh.position.y).toBeCloseTo(0, 6);
  });
});

// -- Fake RAF helpers --------------------------------------------------------

let rafCallbacks: Map<number, FrameRequestCallback>;
let rafCounter: number;
let fakeNow: number;
let originalRaf: typeof globalThis.requestAnimationFrame;
let originalCancel: typeof globalThis.cancelAnimationFrame;
let originalNow: typeof performance.now;

beforeEach(() => {
  rafCallbacks = new Map();
  rafCounter = 1;
  fakeNow = 0;
  originalRaf = globalThis.requestAnimationFrame;
  originalCancel = globalThis.cancelAnimationFrame;
  originalNow = performance.now.bind(performance);

  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
    const id = rafCounter++;
    rafCallbacks.set(id, cb);
    return id;
  }) as typeof globalThis.requestAnimationFrame;

  globalThis.cancelAnimationFrame = ((id: number): void => {
    rafCallbacks.delete(id);
  }) as typeof globalThis.cancelAnimationFrame;

  performance.now = () => fakeNow;
});

afterEach(() => {
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCancel;
  performance.now = originalNow;
});

/**
 * Advance the fake clock by `ms` milliseconds, firing any pending RAF
 * callbacks at the end.
 */
function advanceRaf(ms: number): void {
  fakeNow += ms;
  for (let i = 0; i < 100; i++) {
    const pending = [...rafCallbacks];
    if (pending.length === 0) return;
    rafCallbacks.clear();
    for (const [, cb] of pending) cb(fakeNow);
  }
}
