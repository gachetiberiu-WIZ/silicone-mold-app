// tests/renderer/scene/silicone.test.ts
//
// Unit tests for the silicone-preview scene module (`src/renderer/scene/
// silicone.ts`, issue #47). Pins:
//
//   1. `setSilicone` places two Mesh children under the silicone group,
//      each with the expected material properties (color, transparent,
//      opacity, DoubleSide, depthWrite=false).
//   2. `setSilicone` replaces a previous pair atomically — old meshes
//      disposed, old Manifolds `.delete()`'d, new pair installed.
//   3. `setSilicone` carries the halves at world origin (no inherited
//      group transform — the generator bakes the viewport transform
//      into the Manifolds, so double-applying would mis-align them).
//   4. A "Generate × 3" sequence never accumulates meshes or Manifold
//      handles: at every step exactly two meshes + two cached Manifolds.
//   5. `clearSilicone` removes both meshes, disposes GPU resources, and
//      calls `.delete()` on both cached Manifolds.
//   6. `setExplodedView(true)` moves `upperMesh.y` toward `+offset` and
//      `lowerMesh.y` toward `-offset`; `setExplodedView(false)` returns
//      both to y=0. Offset = max(30, 0.2 * bboxHeight_mm).
//   7. `setSilicone` returns a bbox that is the union of the two halves
//      (consumed by camera re-frame logic).
//
// We don't run a real `generateSiliconeShell` — that requires the WASM
// kernel + takes ~1-3 s per fixture. Instead we build small Manifolds
// directly via `manifold-3d`'s JS API (unit cubes translated into
// upper/lower half-spaces) and hand them to `setSilicone`. This
// exercises the full adapter + scene-graph path deterministically in
// < 100 ms.

import { DoubleSide, MeshStandardMaterial, type Group, type Mesh } from 'three';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { createScene } from '@/renderer/scene/index';
import { initManifold } from '@/geometry/initManifold';
import {
  SILICONE_UPPER_MANIFOLD_KEY,
  SILICONE_LOWER_MANIFOLD_KEY,
  clearSilicone,
  hasSilicone,
  setExplodedView,
  setSilicone,
} from '@/renderer/scene/silicone';

let toplevel: ManifoldToplevel;

beforeAll(async () => {
  toplevel = await initManifold();
});

/**
 * Locate the silicone group in a freshly-built scene. Throws on
 * mis-wired skeleton (which would be a regression in `scene/index.ts`).
 */
function getSiliconeGroup(scene: ReturnType<typeof createScene>): Group {
  const grp = scene.children.find(
    (c) => c.userData['tag'] === 'silicone',
  ) as Group | undefined;
  if (!grp) throw new Error('silicone group missing from scene skeleton');
  return grp;
}

/**
 * Build a pair of half-Manifolds: a 20×10×20 upper box (Y>0) and a
 * 20×10×20 lower box (Y<0). They form a plausible "silicone halves"
 * shape with a combined bbox height of 20 mm — so the exploded offset
 * math kicks into the FLOOR branch (max(30, 0.2 * 20) = 30).
 */
function makeHalves(): { upper: Manifold; lower: Manifold } {
  // `Manifold.cube([x,y,z], true)` centers at origin; translate up/down.
  const upper = toplevel.Manifold.cube([20, 10, 20], true).translate([0, 5, 0]);
  const lower = toplevel.Manifold.cube([20, 10, 20], true).translate([0, -5, 0]);
  return { upper, lower };
}

/**
 * Build a tall pair — 40 mm upper + 40 mm lower → combined height 80 mm
 * → `0.2 * 80 = 16 mm` which is below the 30 mm floor. Offset stays 30.
 * Used to pin the floor-branch behaviour explicitly.
 */
function makeTallHalves(): { upper: Manifold; lower: Manifold } {
  const upper = toplevel.Manifold.cube([30, 40, 30], true).translate([0, 20, 0]);
  const lower = toplevel.Manifold.cube([30, 40, 30], true).translate([0, -20, 0]);
  return { upper, lower };
}

/**
 * Build a VERY tall pair — 200 mm upper + 200 mm lower → combined
 * height 400 mm → `0.2 * 400 = 80 mm` which is ABOVE the 30 mm floor.
 * Offset resolves to 80. Pins the bbox-fraction branch.
 */
function makeVeryTallHalves(): { upper: Manifold; lower: Manifold } {
  const upper = toplevel.Manifold.cube([30, 200, 30], true).translate([0, 100, 0]);
  const lower = toplevel.Manifold.cube([30, 200, 30], true).translate([0, -100, 0]);
  return { upper, lower };
}

describe('setSilicone — basic install', () => {
  test('places two Mesh children under the silicone group', async () => {
    const scene = createScene();
    const halves = makeHalves();

    const result = await setSilicone(scene, halves);

    const group = getSiliconeGroup(scene);
    const meshChildren = group.children.filter((c) => (c as Mesh).isMesh);
    expect(meshChildren.length).toBe(2);

    // The returned meshes are exactly the two children — no duplication.
    expect(meshChildren).toContain(result.upperMesh);
    expect(meshChildren).toContain(result.lowerMesh);
  });

  test('installs the expected material on each mesh', async () => {
    const scene = createScene();
    const halves = makeHalves();

    const { upperMesh, lowerMesh } = await setSilicone(scene, halves);

    for (const mesh of [upperMesh, lowerMesh]) {
      const mat = mesh.material as MeshStandardMaterial;
      expect(mat).toBeInstanceOf(MeshStandardMaterial);
      expect(mat.color.getHex()).toBe(0x4a9eff);
      expect(mat.transparent).toBe(true);
      expect(mat.opacity).toBeCloseTo(0.35, 5);
      expect(mat.side).toBe(DoubleSide);
      expect(mat.depthWrite).toBe(false);
      expect(mat.roughness).toBeCloseTo(0.6, 5);
      expect(mat.metalness).toBeCloseTo(0.0, 5);
    }
  });

  test('halves render at world origin (no group-level transform)', async () => {
    const scene = createScene();
    const halves = makeHalves();

    await setSilicone(scene, halves);

    const group = getSiliconeGroup(scene);
    // Group position must be identity: the generator applies the view
    // transform internally, so doubling it here would mis-align the
    // halves with the visible master.
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

  test('returned bbox is the union of both halves', async () => {
    const scene = createScene();
    const halves = makeHalves();

    const { bbox } = await setSilicone(scene, halves);

    // Upper: Y in [0, 10], Lower: Y in [-10, 0]. Both extend X/Z ±10.
    // Union should be X∈[-10,10], Y∈[-10,10], Z∈[-10,10].
    expect(bbox.min.x).toBeCloseTo(-10, 4);
    expect(bbox.min.y).toBeCloseTo(-10, 4);
    expect(bbox.min.z).toBeCloseTo(-10, 4);
    expect(bbox.max.x).toBeCloseTo(10, 4);
    expect(bbox.max.y).toBeCloseTo(10, 4);
    expect(bbox.max.z).toBeCloseTo(10, 4);
  });

  test('caches both Manifolds on the group userData for later disposal', async () => {
    const scene = createScene();
    const halves = makeHalves();

    await setSilicone(scene, halves);

    const group = getSiliconeGroup(scene);
    expect(group.userData[SILICONE_UPPER_MANIFOLD_KEY]).toBe(halves.upper);
    expect(group.userData[SILICONE_LOWER_MANIFOLD_KEY]).toBe(halves.lower);
  });

  test('hasSilicone reports true after setSilicone', async () => {
    const scene = createScene();
    expect(hasSilicone(scene)).toBe(false);
    await setSilicone(scene, makeHalves());
    expect(hasSilicone(scene)).toBe(true);
  });
});

describe('setSilicone — replacement (no accumulation)', () => {
  test('second setSilicone replaces the first pair, does not accumulate', async () => {
    const scene = createScene();
    const first = makeHalves();
    await setSilicone(scene, first);

    // Spy the dispose path: replace the old Manifolds' `.delete()` with a
    // stub so we can observe the eviction. We have to wrap AFTER install
    // because the cache receives the real handles pre-replacement.
    const firstUpperDelete = vi.fn(first.upper.delete.bind(first.upper));
    const firstLowerDelete = vi.fn(first.lower.delete.bind(first.lower));
    first.upper.delete = firstUpperDelete;
    first.lower.delete = firstLowerDelete;

    const second = makeHalves();
    await setSilicone(scene, second);

    const group = getSiliconeGroup(scene);
    const meshChildren = group.children.filter((c) => (c as Mesh).isMesh);
    expect(meshChildren.length).toBe(2);

    // Previous Manifolds were released.
    expect(firstUpperDelete).toHaveBeenCalledTimes(1);
    expect(firstLowerDelete).toHaveBeenCalledTimes(1);

    // New Manifolds are cached.
    expect(group.userData[SILICONE_UPPER_MANIFOLD_KEY]).toBe(second.upper);
    expect(group.userData[SILICONE_LOWER_MANIFOLD_KEY]).toBe(second.lower);
  });

  test('generate × 3 leaves exactly two meshes + two cached Manifolds', async () => {
    const scene = createScene();
    const group = getSiliconeGroup(scene);

    for (let i = 0; i < 3; i++) {
      await setSilicone(scene, makeHalves());
      const meshes = group.children.filter((c) => (c as Mesh).isMesh);
      expect(meshes.length).toBe(2);
      expect(group.userData[SILICONE_UPPER_MANIFOLD_KEY]).toBeDefined();
      expect(group.userData[SILICONE_LOWER_MANIFOLD_KEY]).toBeDefined();
    }
  });
});

describe('clearSilicone', () => {
  test('removes meshes, disposes GPU resources, and deletes cached Manifolds', async () => {
    const scene = createScene();
    const halves = makeHalves();
    const upperDelete = vi.fn(halves.upper.delete.bind(halves.upper));
    const lowerDelete = vi.fn(halves.lower.delete.bind(halves.lower));
    halves.upper.delete = upperDelete;
    halves.lower.delete = lowerDelete;

    const { upperMesh, lowerMesh } = await setSilicone(scene, halves);

    // Snapshot the geometry + material dispose paths as spies BEFORE
    // clear, so we can confirm the teardown fires the right disposers.
    const upperGeomDispose = vi.spyOn(upperMesh.geometry, 'dispose');
    const lowerGeomDispose = vi.spyOn(lowerMesh.geometry, 'dispose');
    const upperMatDispose = vi.spyOn(
      upperMesh.material as MeshStandardMaterial,
      'dispose',
    );
    const lowerMatDispose = vi.spyOn(
      lowerMesh.material as MeshStandardMaterial,
      'dispose',
    );

    clearSilicone(scene);

    const group = getSiliconeGroup(scene);
    const meshes = group.children.filter((c) => (c as Mesh).isMesh);
    expect(meshes.length).toBe(0);

    expect(upperGeomDispose).toHaveBeenCalledTimes(1);
    expect(lowerGeomDispose).toHaveBeenCalledTimes(1);
    expect(upperMatDispose).toHaveBeenCalledTimes(1);
    expect(lowerMatDispose).toHaveBeenCalledTimes(1);
    expect(upperDelete).toHaveBeenCalledTimes(1);
    expect(lowerDelete).toHaveBeenCalledTimes(1);

    // Cached Manifold slots are cleared.
    expect(group.userData[SILICONE_UPPER_MANIFOLD_KEY]).toBeUndefined();
    expect(group.userData[SILICONE_LOWER_MANIFOLD_KEY]).toBeUndefined();
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
    await setSilicone(scene, makeHalves());
    clearSilicone(scene);
    // Second clear must not throw even though the cached slots are gone.
    expect(() => clearSilicone(scene)).not.toThrow();
  });
});

describe('setExplodedView', () => {
  test('fraction=1 places upper at +offset, lower at −offset; floor branch', async () => {
    const scene = createScene();
    await setSilicone(scene, makeHalves());
    const group = getSiliconeGroup(scene);
    const upperMesh = group.children.find(
      (c) => c.userData['tag'] === 'silicone-upper',
    ) as Mesh;
    const lowerMesh = group.children.find(
      (c) => c.userData['tag'] === 'silicone-lower',
    ) as Mesh;

    // makeHalves has bbox height 20 → 0.2*20 = 4, floor = 30 → offset=30.
    setExplodedView(scene, true);
    advanceRaf(300); // past the 250 ms tween.

    expect(upperMesh.position.y).toBeCloseTo(30, 4);
    expect(lowerMesh.position.y).toBeCloseTo(-30, 4);

    setExplodedView(scene, false);
    advanceRaf(300);

    expect(upperMesh.position.y).toBeCloseTo(0, 4);
    expect(lowerMesh.position.y).toBeCloseTo(0, 4);
  });

  test('offset honours bbox-fraction branch when 0.2 * height > 30 mm', async () => {
    const scene = createScene();
    await setSilicone(scene, makeVeryTallHalves());
    const group = getSiliconeGroup(scene);
    const upperMesh = group.children.find(
      (c) => c.userData['tag'] === 'silicone-upper',
    ) as Mesh;
    const lowerMesh = group.children.find(
      (c) => c.userData['tag'] === 'silicone-lower',
    ) as Mesh;

    // makeVeryTallHalves: Y in [-200, 200] → height 400 → 0.2*400 = 80.
    setExplodedView(scene, true);
    advanceRaf(300);

    expect(upperMesh.position.y).toBeCloseTo(80, 4);
    expect(lowerMesh.position.y).toBeCloseTo(-80, 4);
  });

  test('offset uses the 30 mm floor when 0.2 * height < 30', async () => {
    const scene = createScene();
    await setSilicone(scene, makeTallHalves());
    const group = getSiliconeGroup(scene);
    const upperMesh = group.children.find(
      (c) => c.userData['tag'] === 'silicone-upper',
    ) as Mesh;
    const lowerMesh = group.children.find(
      (c) => c.userData['tag'] === 'silicone-lower',
    ) as Mesh;

    // makeTallHalves: Y in [-40, 40] → height 80 → 0.2*80 = 16 → floor = 30.
    setExplodedView(scene, true);
    advanceRaf(300);

    expect(upperMesh.position.y).toBeCloseTo(30, 4);
    expect(lowerMesh.position.y).toBeCloseTo(-30, 4);
  });

  test('no-op when no silicone is installed (defence-in-depth)', () => {
    const scene = createScene();
    expect(() => setExplodedView(scene, true)).not.toThrow();
    expect(() => setExplodedView(scene, false)).not.toThrow();
  });

  test('a fresh setSilicone resets to collapsed (fraction=0) even after exploded', async () => {
    const scene = createScene();
    await setSilicone(scene, makeHalves());
    setExplodedView(scene, true);
    advanceRaf(300);

    // Install a new pair.
    await setSilicone(scene, makeHalves());
    const group = getSiliconeGroup(scene);
    const upperMesh = group.children.find(
      (c) => c.userData['tag'] === 'silicone-upper',
    ) as Mesh;
    const lowerMesh = group.children.find(
      (c) => c.userData['tag'] === 'silicone-lower',
    ) as Mesh;

    // New halves start collapsed (y=0) without a manual setExplodedView(false).
    // `toBeCloseTo` accepts both +0 and -0 since -0 × offset rounds to -0 on
    // the initial applyFraction(0) call.
    expect(upperMesh.position.y).toBeCloseTo(0, 6);
    expect(lowerMesh.position.y).toBeCloseTo(0, 6);
  });
});

// -- Fake RAF helpers --------------------------------------------------------
//
// The tween inside silicone.ts uses `requestAnimationFrame` + `performance.now`
// directly. Vitest's default `node` environment supplies real implementations
// — but they rely on wall-clock ms which makes the 250 ms tween test flaky.
// We monkey-patch both so the test can advance time deterministically.

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
 * callbacks at the end. The tween inside `silicone.ts` schedules itself
 * recursively; we drain the callback queue in a loop so the test sees
 * the final frame even if the tween re-schedules mid-step.
 */
function advanceRaf(ms: number): void {
  fakeNow += ms;
  // Drain up to 100 nested RAF schedules — the tween only recurses per
  // frame, so 100 is far more than enough for any 250 ms animation.
  for (let i = 0; i < 100; i++) {
    const pending = [...rafCallbacks];
    if (pending.length === 0) return;
    rafCallbacks.clear();
    for (const [, cb] of pending) cb(fakeNow);
  }
}
