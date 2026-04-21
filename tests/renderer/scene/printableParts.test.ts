// tests/renderer/scene/printableParts.test.ts
//
// Unit tests for the printable-parts scene module. Post-Wave-D (issue
// #82) this module manages TWO meshes under the printable-parts group:
//   - print-shell (lifts +Y on explode)
//   - base-slab   (lifts -Y on explode)
//
// Both are installed via `setPrintableParts(scene, {printShell, basePart})`
// and removed via `clearPrintableParts`. The toggle flips BOTH together.
//
// Pins:
//
//   1. `setPrintableParts` places 2 Mesh children under the group with
//      the expected gray opaque material (color, roughness, metalness,
//      transparent=false) and the expected tags.
//   2. Installed group starts `visible=true` regardless of prior state.
//   3. `setPrintableParts` atomically replaces prior meshes — both old
//      meshes disposed, both old Manifolds `.delete()`'d, new pair
//      installed.
//   4. Generate × 3 never accumulates meshes or cached handles.
//   5. `clearPrintableParts` removes both meshes + disposes GPU +
//      deletes both cached Manifolds.
//   6. `setPrintablePartsVisible(true/false)` flips group.visible (and
//      therefore both meshes' visibility in a single operation).
//   7. `setPrintablePartsExplodedView(true)` while visible animates the
//      shell mesh to +Y AND the slab mesh to -Y in parallel; `false`
//      collapses both to origin.
//   8. While hidden, `setPrintablePartsExplodedView` does NOT start a
//      tween (perf: no wasted per-frame work).
//   9. `arePrintablePartsVisible` + `isPrintableExplodedIdle` report
//      correctly through every state transition.
//
// Fake Manifolds: we build small cubes directly via manifold-3d and
// hand them as fakes — the real generator output doesn't matter for
// scene-graph contract tests.

import { MeshStandardMaterial, type Group, type Mesh } from 'three';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { initManifold } from '@/geometry/initManifold';
import { createScene } from '@/renderer/scene/index';
import {
  BASE_SLAB_MANIFOLD_KEY,
  PRINT_SHELL_MANIFOLD_KEY,
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
 * Build plausible print-shell + base-slab Manifolds for testing. Print
 * shell is a cube at origin with Y ∈ [-30, 30] → bbox height 60 →
 * shell exploded offset defaults to `max(40, 0.25 * 60) = 40 mm`.
 * Base slab is a flat shorter cube at Y ∈ [-5, 5] → height 10 → slab
 * exploded offset defaults to `max(30, 0.2 * 10) = 30 mm` (magnitude;
 * direction is -Y).
 */
function makeParts(): { printShell: Manifold; basePart: Manifold } {
  return {
    printShell: toplevel.Manifold.cube([40, 60, 40], true),
    basePart: toplevel.Manifold.cube([50, 10, 50], true),
  };
}

describe('setPrintableParts — basic install', () => {
  test('places one print-shell Mesh and one base-slab Mesh under the group', async () => {
    const scene = createScene();
    const parts = makeParts();

    const result = await setPrintableParts(scene, parts);

    const group = getGroup(scene);
    const meshChildren = group.children.filter((c) => (c as Mesh).isMesh);
    expect(meshChildren.length).toBe(2);

    const shellTagged = meshChildren.find(
      (c) => c.userData['tag'] === 'print-shell',
    );
    const slabTagged = meshChildren.find(
      (c) => c.userData['tag'] === 'base-slab-mesh',
    );
    expect(shellTagged).toBeTruthy();
    expect(slabTagged).toBeTruthy();
    expect(result.shellMesh).toBe(shellTagged);
    expect(result.slabMesh).toBe(slabTagged);
  });

  test('installs opaque gray material on both meshes', async () => {
    const scene = createScene();
    const parts = makeParts();

    const { shellMesh, slabMesh } = await setPrintableParts(scene, parts);

    for (const mesh of [shellMesh, slabMesh]) {
      const mat = mesh.material as MeshStandardMaterial;
      expect(mat).toBeInstanceOf(MeshStandardMaterial);
      expect(mat.color.getHex()).toBe(0xb8b8b8);
      expect(mat.roughness).toBeCloseTo(0.8, 5);
      expect(mat.metalness).toBeCloseTo(0.0, 5);
      expect(mat.transparent).toBe(false);
      expect(mat.opacity).toBeCloseTo(1, 5);
    }
  });

  test('group starts VISIBLE after install (issue #67 carry-forward)', async () => {
    const scene = createScene();
    const group = getGroup(scene);

    expect(group.visible).toBe(false);

    await setPrintableParts(scene, makeParts());
    expect(group.visible).toBe(true);
    expect(arePrintablePartsVisible(scene)).toBe(true);
  });

  test('caches both Manifolds on the group userData', async () => {
    const scene = createScene();
    const parts = makeParts();

    await setPrintableParts(scene, parts);

    const group = getGroup(scene);
    expect(group.userData[PRINT_SHELL_MANIFOLD_KEY]).toBe(parts.printShell);
    expect(group.userData[BASE_SLAB_MANIFOLD_KEY]).toBe(parts.basePart);
  });

  test('hasPrintableParts reports true after setPrintableParts', async () => {
    const scene = createScene();
    expect(hasPrintableParts(scene)).toBe(false);
    await setPrintableParts(scene, makeParts());
    expect(hasPrintableParts(scene)).toBe(true);
  });
});

describe('setPrintableParts — replacement (no accumulation)', () => {
  test('second setPrintableParts replaces the first; both prior Manifolds disposed', async () => {
    const scene = createScene();
    const first = makeParts();
    const shellSpy = vi.fn(first.printShell.delete.bind(first.printShell));
    const slabSpy = vi.fn(first.basePart.delete.bind(first.basePart));
    first.printShell.delete = shellSpy;
    first.basePart.delete = slabSpy;

    await setPrintableParts(scene, first);

    const second = makeParts();
    await setPrintableParts(scene, second);

    const group = getGroup(scene);
    const meshes = group.children.filter((c) => (c as Mesh).isMesh);
    expect(meshes.length).toBe(2);

    expect(shellSpy).toHaveBeenCalledTimes(1);
    expect(slabSpy).toHaveBeenCalledTimes(1);

    expect(group.userData[PRINT_SHELL_MANIFOLD_KEY]).toBe(second.printShell);
    expect(group.userData[BASE_SLAB_MANIFOLD_KEY]).toBe(second.basePart);
  });

  test('generate × 3 leaves exactly two meshes + two cached Manifolds', async () => {
    const scene = createScene();
    const group = getGroup(scene);

    for (let i = 0; i < 3; i++) {
      await setPrintableParts(scene, makeParts());
      const meshes = group.children.filter((c) => (c as Mesh).isMesh);
      expect(meshes.length).toBe(2);
      expect(group.userData[PRINT_SHELL_MANIFOLD_KEY]).toBeDefined();
      expect(group.userData[BASE_SLAB_MANIFOLD_KEY]).toBeDefined();
    }
  });

  test('replacement resets visibility to true (default ON)', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makeParts());
    setPrintablePartsVisible(scene, false);
    expect(arePrintablePartsVisible(scene)).toBe(false);

    await setPrintableParts(scene, makeParts());
    expect(arePrintablePartsVisible(scene)).toBe(true);
  });
});

describe('clearPrintableParts', () => {
  test('removes both meshes, disposes GPU, and deletes both cached Manifolds', async () => {
    const scene = createScene();
    const parts = makeParts();
    const shellSpy = vi.fn(parts.printShell.delete.bind(parts.printShell));
    const slabSpy = vi.fn(parts.basePart.delete.bind(parts.basePart));
    parts.printShell.delete = shellSpy;
    parts.basePart.delete = slabSpy;

    const { shellMesh, slabMesh } = await setPrintableParts(scene, parts);

    const shellGeomDispose = vi.spyOn(shellMesh.geometry, 'dispose');
    const shellMatDispose = vi.spyOn(
      shellMesh.material as MeshStandardMaterial,
      'dispose',
    );
    const slabGeomDispose = vi.spyOn(slabMesh.geometry, 'dispose');
    const slabMatDispose = vi.spyOn(
      slabMesh.material as MeshStandardMaterial,
      'dispose',
    );

    clearPrintableParts(scene);

    const group = getGroup(scene);
    const meshes = group.children.filter((c) => (c as Mesh).isMesh);
    expect(meshes.length).toBe(0);

    expect(shellGeomDispose).toHaveBeenCalledTimes(1);
    expect(shellMatDispose).toHaveBeenCalledTimes(1);
    expect(slabGeomDispose).toHaveBeenCalledTimes(1);
    expect(slabMatDispose).toHaveBeenCalledTimes(1);
    expect(shellSpy).toHaveBeenCalledTimes(1);
    expect(slabSpy).toHaveBeenCalledTimes(1);

    expect(group.userData[PRINT_SHELL_MANIFOLD_KEY]).toBeUndefined();
    expect(group.userData[BASE_SLAB_MANIFOLD_KEY]).toBeUndefined();
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
    await setPrintableParts(scene, makeParts());
    clearPrintableParts(scene);
    expect(() => clearPrintableParts(scene)).not.toThrow();
  });
});

describe('setPrintablePartsVisible', () => {
  test('flips group.visible true/false (hides both meshes)', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makeParts());
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
  test('while visible, exploded=true lifts shell +Y AND drops slab -Y; false collapses both', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makeParts());
    setPrintablePartsVisible(scene, true);

    const group = getGroup(scene);
    const shellMesh = group.children.find(
      (c) => c.userData['tag'] === 'print-shell',
    ) as Mesh;
    const slabMesh = group.children.find(
      (c) => c.userData['tag'] === 'base-slab-mesh',
    ) as Mesh;

    setPrintablePartsExplodedView(scene, true);
    advanceRaf(300); // past the 250 ms tween

    // makeParts(): shell bbox Y ∈ [-30, 30] → 0.25*60=15 → floor 40 → +40.
    expect(shellMesh.position.y).toBeCloseTo(40, 3);
    // slab bbox Y ∈ [-5, 5] → 0.2*10=2 → floor 30 → magnitude 30 → -30.
    expect(slabMesh.position.y).toBeCloseTo(-30, 3);
    expect(shellMesh.position.x).toBeCloseTo(0, 4);
    expect(slabMesh.position.x).toBeCloseTo(0, 4);

    expect(isPrintableExplodedIdle(scene)).toBe(true);

    setPrintablePartsExplodedView(scene, false);
    advanceRaf(300);

    expect(shellMesh.position.y).toBeCloseTo(0, 3);
    expect(slabMesh.position.y).toBeCloseTo(0, 3);
  });

  test('while hidden, exploded state is applied WITHOUT starting a tween (perf)', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makeParts());
    setPrintablePartsVisible(scene, false);

    setPrintablePartsExplodedView(scene, true);

    expect(isPrintableExplodedIdle(scene)).toBe(true);

    const group = getGroup(scene);
    const shellMesh = group.children.find(
      (c) => c.userData['tag'] === 'print-shell',
    ) as Mesh;
    const slabMesh = group.children.find(
      (c) => c.userData['tag'] === 'base-slab-mesh',
    ) as Mesh;

    expect(shellMesh.position.y).toBeCloseTo(40, 3);
    expect(slabMesh.position.y).toBeCloseTo(-30, 3);
  });

  test('hiding mid-tween cancels RAF loops on both meshes', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makeParts());
    setPrintablePartsVisible(scene, true);

    setPrintablePartsExplodedView(scene, true);
    expect(isPrintableExplodedIdle(scene)).toBe(false);

    advanceRaf(100);
    expect(isPrintableExplodedIdle(scene)).toBe(false);

    setPrintablePartsVisible(scene, false);
    expect(isPrintableExplodedIdle(scene)).toBe(true);
  });

  test('is a no-op when no parts installed', () => {
    const scene = createScene();
    expect(() => setPrintablePartsExplodedView(scene, true)).not.toThrow();
    expect(() => setPrintablePartsExplodedView(scene, false)).not.toThrow();
    expect(isPrintableExplodedIdle(scene)).toBe(true);
  });

  test('fresh setPrintableParts resets both positions to collapsed even after exploded', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makeParts());
    setPrintablePartsVisible(scene, true);
    setPrintablePartsExplodedView(scene, true);
    advanceRaf(300);

    await setPrintableParts(scene, makeParts());
    const group = getGroup(scene);
    const shellMesh = group.children.find(
      (c) => c.userData['tag'] === 'print-shell',
    ) as Mesh;
    const slabMesh = group.children.find(
      (c) => c.userData['tag'] === 'base-slab-mesh',
    ) as Mesh;

    expect(shellMesh.position.y).toBeCloseTo(0, 4);
    expect(slabMesh.position.y).toBeCloseTo(0, 4);
  });
});

describe('isPrintableExplodedIdle — state machine', () => {
  test('returns true when no parts installed', () => {
    const scene = createScene();
    expect(isPrintableExplodedIdle(scene)).toBe(true);
  });

  test('returns true when parts installed but never exploded', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makeParts());
    expect(isPrintableExplodedIdle(scene)).toBe(true);
  });

  test('returns false while either tween is in flight; true only when BOTH settle', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makeParts());
    setPrintablePartsVisible(scene, true);

    setPrintablePartsExplodedView(scene, true);
    expect(isPrintableExplodedIdle(scene)).toBe(false);

    advanceRaf(300);
    expect(isPrintableExplodedIdle(scene)).toBe(true);
  });

  test('returns true when group is hidden even if target fraction is 1', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makeParts());
    setPrintablePartsVisible(scene, false);
    setPrintablePartsExplodedView(scene, true);
    expect(isPrintableExplodedIdle(scene)).toBe(true);
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

function advanceRaf(ms: number): void {
  fakeNow += ms;
  for (let i = 0; i < 100; i++) {
    const pending = [...rafCallbacks];
    if (pending.length === 0) return;
    rafCallbacks.clear();
    for (const [, cb] of pending) cb(fakeNow);
  }
}
