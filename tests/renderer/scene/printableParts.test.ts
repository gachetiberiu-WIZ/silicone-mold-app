// tests/renderer/scene/printableParts.test.ts
//
// Unit tests for the printable-parts scene module (`src/renderer/scene/
// printableParts.ts`, issue #62). Mirrors the `silicone.test.ts` shape
// so conventions stay in sync. Pins:
//
//   1. `setPrintableParts` places 1+N+1 Mesh children under the group,
//      each with the expected gray opaque material (color, roughness,
//      metalness, transparent=false).
//   2. Installed group starts `visible=false` regardless of prior state
//      (default OFF per issue #62).
//   3. `setPrintableParts` atomically replaces a previous set — old
//      meshes disposed, old Manifolds `.delete()`'d, new set installed.
//   4. Generate × 3 never accumulates meshes or cached handles.
//   5. `clearPrintableParts` removes all meshes + disposes GPU + deletes
//      every cached Manifold.
//   6. `setPrintablePartsVisible(true/false)` flips group.visible.
//   7. `setPrintablePartsExplodedView(true)` while visible animates base
//      toward -Y, topCap toward +Y, sides radially outward; `false`
//      collapses to origin.
//   8. While hidden, `setPrintablePartsExplodedView` does NOT start a
//      tween (perf AC: no wasted per-frame work).
//   9. `arePrintablePartsVisible` + `isPrintableExplodedIdle` report
//      correctly through every state transition.
//
// We don't run a real `generateSiliconeShell` — we build small cubes
// directly and hand them as fake "printable parts" to exercise the
// full adapter + scene-graph path deterministically in < 100 ms.

import { MeshStandardMaterial, type Group, type Mesh } from 'three';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { initManifold } from '@/geometry/initManifold';
import { createScene } from '@/renderer/scene/index';
import {
  PRINTABLE_BASE_MANIFOLD_KEY,
  PRINTABLE_SIDES_MANIFOLDS_KEY,
  PRINTABLE_TOP_CAP_MANIFOLD_KEY,
  arePrintablePartsVisible,
  clearPrintableParts,
  hasPrintableParts,
  isPrintableExplodedIdle,
  setPrintableParts,
  setPrintablePartsExplodedView,
  setPrintablePartsVisible,
} from '@/renderer/scene/printableParts';

let toplevel: ManifoldToplevel;

beforeAll(async () => {
  toplevel = await initManifold();
});

/** Get the printable-parts group from a fresh scene. */
function getGroup(scene: ReturnType<typeof createScene>): Group {
  const grp = scene.children.find(
    (c) => c.userData['tag'] === 'printableParts',
  ) as Group | undefined;
  if (!grp) throw new Error('printable-parts group missing from scene skeleton');
  return grp;
}

/**
 * Build a plausible printable-parts set for testing:
 *   - base:   40×5×40 slab at y = -40 (floor below silicone)
 *   - sides:  4 × narrow walls at the ring, Y in [-30, 30]
 *   - topCap: 40×5×40 slab at y = +40 (ceiling above silicone)
 *
 * The combined bbox Y-extent is 80 mm → 0.2*80 = 16 → exploded offset
 * defaults to floor (30 mm) which puts the base at y=-30, topCap at
 * y=+30 when fully exploded.
 */
function makePrintableSet(sideCount: 2 | 3 | 4 = 4): {
  base: Manifold;
  sides: Manifold[];
  topCap: Manifold;
} {
  const base = toplevel.Manifold.cube([40, 5, 40], true).translate([0, -40, 0]);
  const topCap = toplevel.Manifold.cube([40, 5, 40], true).translate([0, 40, 0]);

  // 4 sides — place at +X, -X, +Z, -Z positions (radial pattern). For
  // sideCount=3 we rotate 120° between each; sideCount=2 is +X and -X.
  const sides: Manifold[] = [];
  if (sideCount === 4) {
    sides.push(toplevel.Manifold.cube([5, 60, 40], true).translate([20, 0, 0]));
    sides.push(toplevel.Manifold.cube([5, 60, 40], true).translate([-20, 0, 0]));
    sides.push(toplevel.Manifold.cube([40, 60, 5], true).translate([0, 0, 20]));
    sides.push(toplevel.Manifold.cube([40, 60, 5], true).translate([0, 0, -20]));
  } else if (sideCount === 3) {
    // 120° rotated rectangular walls — cheap approximation. We only
    // need distinct XZ centroids for the radial-direction test.
    sides.push(toplevel.Manifold.cube([5, 60, 40], true).translate([20, 0, 0]));
    sides.push(toplevel.Manifold.cube([40, 60, 5], true).translate([-10, 0, 17]));
    sides.push(toplevel.Manifold.cube([40, 60, 5], true).translate([-10, 0, -17]));
  } else {
    sides.push(toplevel.Manifold.cube([5, 60, 40], true).translate([20, 0, 0]));
    sides.push(toplevel.Manifold.cube([5, 60, 40], true).translate([-20, 0, 0]));
  }
  return { base, sides, topCap };
}

describe('setPrintableParts — basic install', () => {
  test('places 1 + N + 1 Mesh children under the printable-parts group', async () => {
    const scene = createScene();
    const parts = makePrintableSet(4);

    const result = await setPrintableParts(scene, parts);

    const group = getGroup(scene);
    const meshChildren = group.children.filter((c) => (c as Mesh).isMesh);
    expect(meshChildren.length).toBe(6); // 1 base + 4 sides + 1 topCap

    expect(result.baseMesh).toBe(meshChildren[0]);
    expect(result.topCapMesh).toBe(meshChildren[meshChildren.length - 1]);
    expect(result.sideMeshes).toHaveLength(4);
  });

  test('installs the expected opaque gray material on every mesh', async () => {
    const scene = createScene();
    const parts = makePrintableSet(4);

    const { baseMesh, sideMeshes, topCapMesh } = await setPrintableParts(scene, parts);

    for (const mesh of [baseMesh, topCapMesh, ...sideMeshes]) {
      const mat = mesh.material as MeshStandardMaterial;
      expect(mat).toBeInstanceOf(MeshStandardMaterial);
      expect(mat.color.getHex()).toBe(0xb8b8b8);
      expect(mat.roughness).toBeCloseTo(0.8, 5);
      expect(mat.metalness).toBeCloseTo(0.0, 5);
      // Opaque: transparent=false (default when not set), opacity=1.
      expect(mat.transparent).toBe(false);
      expect(mat.opacity).toBeCloseTo(1, 5);
    }
  });

  test('shares one material instance across all parts (one dispose target)', async () => {
    const scene = createScene();
    const parts = makePrintableSet(4);

    const { baseMesh, sideMeshes, topCapMesh } = await setPrintableParts(scene, parts);

    const expected = baseMesh.material;
    for (const mesh of [topCapMesh, ...sideMeshes]) {
      expect(mesh.material).toBe(expected);
    }
  });

  test('group starts hidden (visible=false, default OFF per issue #62)', async () => {
    const scene = createScene();
    const group = getGroup(scene);

    // Pre-install: the scene factory sets visible=false.
    expect(group.visible).toBe(false);

    await setPrintableParts(scene, makePrintableSet(4));
    // Post-install: still hidden.
    expect(group.visible).toBe(false);
    expect(arePrintablePartsVisible(scene)).toBe(false);
  });

  test('caches every input Manifold on the group userData', async () => {
    const scene = createScene();
    const parts = makePrintableSet(4);

    await setPrintableParts(scene, parts);

    const group = getGroup(scene);
    expect(group.userData[PRINTABLE_BASE_MANIFOLD_KEY]).toBe(parts.base);
    expect(group.userData[PRINTABLE_TOP_CAP_MANIFOLD_KEY]).toBe(parts.topCap);
    const cachedSides = group.userData[PRINTABLE_SIDES_MANIFOLDS_KEY] as
      | Manifold[]
      | undefined;
    expect(cachedSides).toHaveLength(4);
    // Reference equality: the cached array elements ARE the input Manifolds.
    for (let i = 0; i < parts.sides.length; i++) {
      expect(cachedSides?.[i]).toBe(parts.sides[i]);
    }
  });

  test('hasPrintableParts reports true after setPrintableParts', async () => {
    const scene = createScene();
    expect(hasPrintableParts(scene)).toBe(false);
    await setPrintableParts(scene, makePrintableSet(4));
    expect(hasPrintableParts(scene)).toBe(true);
  });

  test('supports sideCount=2, 3, and 4', async () => {
    for (const sideCount of [2, 3, 4] as const) {
      const scene = createScene();
      const parts = makePrintableSet(sideCount);
      const result = await setPrintableParts(scene, parts);
      expect(result.sideMeshes).toHaveLength(sideCount);

      const group = getGroup(scene);
      const meshes = group.children.filter((c) => (c as Mesh).isMesh);
      // 1 base + sideCount sides + 1 topCap
      expect(meshes.length).toBe(sideCount + 2);
    }
  });
});

describe('setPrintableParts — replacement (no accumulation)', () => {
  test('second setPrintableParts replaces the first set; prior Manifolds disposed', async () => {
    const scene = createScene();
    const first = makePrintableSet(4);
    // Wrap the delete spies BEFORE install so the cached ref is captured.
    const baseDelete = vi.fn(first.base.delete.bind(first.base));
    const topCapDelete = vi.fn(first.topCap.delete.bind(first.topCap));
    const sideDeletes = first.sides.map((s) => vi.fn(s.delete.bind(s)));
    first.base.delete = baseDelete;
    first.topCap.delete = topCapDelete;
    for (let i = 0; i < first.sides.length; i++) {
      first.sides[i]!.delete = sideDeletes[i]!;
    }

    await setPrintableParts(scene, first);

    const second = makePrintableSet(4);
    await setPrintableParts(scene, second);

    const group = getGroup(scene);
    const meshes = group.children.filter((c) => (c as Mesh).isMesh);
    expect(meshes.length).toBe(6);

    // Prior Manifolds all .delete()'d exactly once.
    expect(baseDelete).toHaveBeenCalledTimes(1);
    expect(topCapDelete).toHaveBeenCalledTimes(1);
    for (const sd of sideDeletes) expect(sd).toHaveBeenCalledTimes(1);

    // New Manifolds cached.
    expect(group.userData[PRINTABLE_BASE_MANIFOLD_KEY]).toBe(second.base);
    expect(group.userData[PRINTABLE_TOP_CAP_MANIFOLD_KEY]).toBe(second.topCap);
  });

  test('generate × 3 leaves exactly N+2 meshes + N+2 cached Manifolds', async () => {
    const scene = createScene();
    const group = getGroup(scene);

    for (let i = 0; i < 3; i++) {
      await setPrintableParts(scene, makePrintableSet(4));
      const meshes = group.children.filter((c) => (c as Mesh).isMesh);
      expect(meshes.length).toBe(6);
      expect(group.userData[PRINTABLE_BASE_MANIFOLD_KEY]).toBeDefined();
      expect(group.userData[PRINTABLE_TOP_CAP_MANIFOLD_KEY]).toBeDefined();
      const cachedSides = group.userData[PRINTABLE_SIDES_MANIFOLDS_KEY] as
        | Manifold[]
        | undefined;
      expect(cachedSides).toHaveLength(4);
    }
  });

  test('replacement resets visibility to false even if prior set was shown', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makePrintableSet(4));
    setPrintablePartsVisible(scene, true);
    expect(arePrintablePartsVisible(scene)).toBe(true);

    await setPrintableParts(scene, makePrintableSet(4));
    // Fresh install re-hides.
    expect(arePrintablePartsVisible(scene)).toBe(false);
  });
});

describe('clearPrintableParts', () => {
  test('removes meshes, disposes GPU resources, and deletes every cached Manifold', async () => {
    const scene = createScene();
    const parts = makePrintableSet(4);
    const baseDelete = vi.fn(parts.base.delete.bind(parts.base));
    const topCapDelete = vi.fn(parts.topCap.delete.bind(parts.topCap));
    const sideDeletes = parts.sides.map((s) => vi.fn(s.delete.bind(s)));
    parts.base.delete = baseDelete;
    parts.topCap.delete = topCapDelete;
    for (let i = 0; i < parts.sides.length; i++) {
      parts.sides[i]!.delete = sideDeletes[i]!;
    }

    const { baseMesh, sideMeshes, topCapMesh } = await setPrintableParts(scene, parts);

    // Spy the GPU dispose paths.
    const baseGeomDispose = vi.spyOn(baseMesh.geometry, 'dispose');
    const topCapGeomDispose = vi.spyOn(topCapMesh.geometry, 'dispose');
    const sideGeomDisposes = sideMeshes.map((m) =>
      vi.spyOn(m.geometry, 'dispose'),
    );
    // Shared material — expect ONE dispose call regardless of N parts.
    const matDispose = vi.spyOn(
      baseMesh.material as MeshStandardMaterial,
      'dispose',
    );

    clearPrintableParts(scene);

    const group = getGroup(scene);
    const meshes = group.children.filter((c) => (c as Mesh).isMesh);
    expect(meshes.length).toBe(0);

    expect(baseGeomDispose).toHaveBeenCalledTimes(1);
    expect(topCapGeomDispose).toHaveBeenCalledTimes(1);
    for (const d of sideGeomDisposes) expect(d).toHaveBeenCalledTimes(1);
    // Shared material disposed ONCE (not once per mesh).
    expect(matDispose).toHaveBeenCalledTimes(1);

    expect(baseDelete).toHaveBeenCalledTimes(1);
    expect(topCapDelete).toHaveBeenCalledTimes(1);
    for (const sd of sideDeletes) expect(sd).toHaveBeenCalledTimes(1);

    expect(group.userData[PRINTABLE_BASE_MANIFOLD_KEY]).toBeUndefined();
    expect(group.userData[PRINTABLE_TOP_CAP_MANIFOLD_KEY]).toBeUndefined();
    expect(group.userData[PRINTABLE_SIDES_MANIFOLDS_KEY]).toBeUndefined();
    expect(hasPrintableParts(scene)).toBe(false);
  });

  test('is idempotent on an empty scene', () => {
    const scene = createScene();
    expect(() => clearPrintableParts(scene)).not.toThrow();
    expect(() => clearPrintableParts(scene)).not.toThrow();
    expect(hasPrintableParts(scene)).toBe(false);
  });

  test('is idempotent after install + clear (double-clear)', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makePrintableSet(4));
    clearPrintableParts(scene);
    expect(() => clearPrintableParts(scene)).not.toThrow();
  });
});

describe('setPrintablePartsVisible', () => {
  test('flips group.visible true/false', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makePrintableSet(4));
    const group = getGroup(scene);

    setPrintablePartsVisible(scene, true);
    expect(group.visible).toBe(true);
    expect(arePrintablePartsVisible(scene)).toBe(true);

    setPrintablePartsVisible(scene, false);
    expect(group.visible).toBe(false);
    expect(arePrintablePartsVisible(scene)).toBe(false);
  });

  test('is a no-op when no parts installed', () => {
    const scene = createScene();
    expect(() => setPrintablePartsVisible(scene, true)).not.toThrow();
    expect(arePrintablePartsVisible(scene)).toBe(false);
  });
});

describe('setPrintablePartsExplodedView — tween', () => {
  test('while visible, exploded=true animates base toward -Y, topCap toward +Y, sides radially', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makePrintableSet(4));
    setPrintablePartsVisible(scene, true);

    const group = getGroup(scene);
    const meshes = group.children.filter((c) => (c as Mesh).isMesh) as Mesh[];
    const baseMesh = meshes.find(
      (m) => m.userData['tag'] === 'printable-base',
    )!;
    const topCapMesh = meshes.find(
      (m) => m.userData['tag'] === 'printable-top-cap',
    )!;
    const sides = meshes.filter((m) =>
      String(m.userData['tag']).startsWith('printable-side-'),
    );

    setPrintablePartsExplodedView(scene, true);
    advanceRaf(300); // past the 250 ms tween

    // makePrintableSet(4): union bbox Y ∈ [-42.5, 42.5] → height 85 →
    // 0.2*85 = 17 → floor 30 → offset = 30 mm.
    expect(baseMesh.position.y).toBeCloseTo(-30, 3);
    expect(topCapMesh.position.y).toBeCloseTo(30, 3);

    // Each side radially outward: its XZ centroid ray, scaled to 30.
    // makePrintableSet(4): sides at ±X and ±Z, centered — each centroid
    // length = 20 mm → unit vector × 30 mm = (±30, 0, 0) or (0, 0, ±30).
    for (const side of sides) {
      const magnitude = Math.hypot(side.position.x, side.position.z);
      expect(magnitude).toBeCloseTo(30, 3);
      // Y stays at 0 — radial is XZ-only.
      expect(side.position.y).toBeCloseTo(0, 4);
    }

    // Idle after tween completes.
    expect(isPrintableExplodedIdle(scene)).toBe(true);

    // Collapse back.
    setPrintablePartsExplodedView(scene, false);
    advanceRaf(300);

    expect(baseMesh.position.y).toBeCloseTo(0, 3);
    expect(topCapMesh.position.y).toBeCloseTo(0, 3);
    for (const side of sides) {
      expect(side.position.x).toBeCloseTo(0, 3);
      expect(side.position.z).toBeCloseTo(0, 3);
    }
  });

  test('while hidden, exploded state is applied WITHOUT starting a tween (perf)', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makePrintableSet(4));
    // Group stays hidden (we don't call setPrintablePartsVisible(true)).

    setPrintablePartsExplodedView(scene, true);

    // Idle — no RAF scheduled because no visible tween is worth running.
    expect(isPrintableExplodedIdle(scene)).toBe(true);

    const group = getGroup(scene);
    const meshes = group.children.filter((c) => (c as Mesh).isMesh) as Mesh[];
    const baseMesh = meshes.find(
      (m) => m.userData['tag'] === 'printable-base',
    )!;
    const topCapMesh = meshes.find(
      (m) => m.userData['tag'] === 'printable-top-cap',
    )!;

    // Positions SHOULD be snapped to the exploded target — when the
    // group later becomes visible, parts appear at the right place.
    expect(baseMesh.position.y).toBeCloseTo(-30, 3);
    expect(topCapMesh.position.y).toBeCloseTo(30, 3);
  });

  test('hiding mid-tween cancels the RAF loop (no wasted frame work)', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makePrintableSet(4));
    setPrintablePartsVisible(scene, true);

    setPrintablePartsExplodedView(scene, true);
    // Idle=false — tween in flight.
    expect(isPrintableExplodedIdle(scene)).toBe(false);

    // Advance a bit into the tween — fraction ≈ 0.4 at 100ms.
    advanceRaf(100);
    expect(isPrintableExplodedIdle(scene)).toBe(false);

    // Hide the group. Tween cancels; idle flips true.
    setPrintablePartsVisible(scene, false);
    expect(isPrintableExplodedIdle(scene)).toBe(true);
  });

  test('is a no-op when no parts installed', () => {
    const scene = createScene();
    expect(() => setPrintablePartsExplodedView(scene, true)).not.toThrow();
    expect(() => setPrintablePartsExplodedView(scene, false)).not.toThrow();
    expect(isPrintableExplodedIdle(scene)).toBe(true);
  });

  test('fresh setPrintableParts resets positions to collapsed even after exploded', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makePrintableSet(4));
    setPrintablePartsVisible(scene, true);
    setPrintablePartsExplodedView(scene, true);
    advanceRaf(300);

    // Install a new set — positions should reset to 0.
    await setPrintableParts(scene, makePrintableSet(4));
    const group = getGroup(scene);
    const baseMesh = group.children.find(
      (c) => c.userData['tag'] === 'printable-base',
    ) as Mesh;
    const topCapMesh = group.children.find(
      (c) => c.userData['tag'] === 'printable-top-cap',
    ) as Mesh;

    expect(baseMesh.position.y).toBeCloseTo(0, 4);
    expect(topCapMesh.position.y).toBeCloseTo(0, 4);
  });
});

describe('isPrintableExplodedIdle — state machine', () => {
  test('returns true when no parts installed', () => {
    const scene = createScene();
    expect(isPrintableExplodedIdle(scene)).toBe(true);
  });

  test('returns true when parts installed but never exploded', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makePrintableSet(4));
    expect(isPrintableExplodedIdle(scene)).toBe(true);
  });

  test('returns false while tween is in flight, true after', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makePrintableSet(4));
    setPrintablePartsVisible(scene, true);

    setPrintablePartsExplodedView(scene, true);
    expect(isPrintableExplodedIdle(scene)).toBe(false);

    advanceRaf(300);
    expect(isPrintableExplodedIdle(scene)).toBe(true);
  });

  test('returns true when group is hidden even if target fraction is 1', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makePrintableSet(4));
    // Never show. Still "idle" from the tween's perspective.
    setPrintablePartsExplodedView(scene, true);
    expect(isPrintableExplodedIdle(scene)).toBe(true);
  });
});

// -- Fake RAF helpers --------------------------------------------------------
//
// Mirror of silicone.test.ts's fake RAF implementation so tests advance
// `performance.now()` deterministically and drain the RAF queue.

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

function advanceRaf(ms: number): void {
  fakeNow += ms;
  for (let i = 0; i < 100; i++) {
    const pending = [...rafCallbacks];
    if (pending.length === 0) return;
    rafCallbacks.clear();
    for (const [, cb] of pending) cb(fakeNow);
  }
}
