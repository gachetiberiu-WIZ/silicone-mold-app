// tests/renderer/scene/printableParts.test.ts
//
// Unit tests for the printable-parts scene module (Wave C, issue #72).
// Post-Wave-C this module manages a SINGLE surface-conforming print-shell
// mesh (the rectangular-box N-side radial split is gone). Mirrors the
// `silicone.test.ts` shape so conventions stay in sync.
//
// Pins:
//
//   1. `setPrintableParts` places 1 Mesh child under the group with the
//      expected gray opaque material (color, roughness, metalness,
//      transparent=false).
//   2. Installed group starts `visible=true` regardless of prior state
//      (default ON, issue #67 carry-forward).
//   3. `setPrintableParts` atomically replaces a previous mesh — old
//      mesh disposed, old Manifold `.delete()`'d, new mesh installed.
//   4. Generate × 3 never accumulates meshes or cached handles.
//   5. `clearPrintableParts` removes the mesh + disposes GPU + deletes
//      the cached Manifold.
//   6. `setPrintablePartsVisible(true/false)` flips group.visible.
//   7. `setPrintablePartsExplodedView(true)` while visible animates the
//      mesh to +Y; `false` collapses to origin.
//   8. While hidden, `setPrintablePartsExplodedView` does NOT start a
//      tween (perf: no wasted per-frame work).
//   9. `arePrintablePartsVisible` + `isPrintableExplodedIdle` report
//      correctly through every state transition.
//
// We don't run a real `generateSiliconeShell` — we build small cubes
// directly and hand them as fake print shells to exercise the full
// adapter + scene-graph path deterministically in < 100 ms.

import { MeshStandardMaterial, type Group, type Mesh } from 'three';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { initManifold } from '@/geometry/initManifold';
import { createScene } from '@/renderer/scene/index';
import {
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
 * Build a plausible print-shell Manifold for testing. A hollow-ish cube
 * stand-in — just a cube at origin with Y ∈ [-30, 30] → bbox height 60 →
 * exploded offset defaults to `max(40, 0.25 * 60) = 40 mm`.
 */
function makePrintShell(): { printShell: Manifold } {
  return {
    printShell: toplevel.Manifold.cube([40, 60, 40], true),
  };
}

describe('setPrintableParts — basic install', () => {
  test('places one print-shell Mesh under the printable-parts group', async () => {
    const scene = createScene();
    const parts = makePrintShell();

    const result = await setPrintableParts(scene, parts);

    const group = getGroup(scene);
    const meshChildren = group.children.filter((c) => (c as Mesh).isMesh);
    expect(meshChildren.length).toBe(1);

    expect(result.mesh).toBe(meshChildren[0]);
    expect(result.mesh.userData['tag']).toBe('print-shell');
  });

  test('installs the opaque gray material on the mesh', async () => {
    const scene = createScene();
    const parts = makePrintShell();

    const { mesh } = await setPrintableParts(scene, parts);

    const mat = mesh.material as MeshStandardMaterial;
    expect(mat).toBeInstanceOf(MeshStandardMaterial);
    expect(mat.color.getHex()).toBe(0xb8b8b8);
    expect(mat.roughness).toBeCloseTo(0.8, 5);
    expect(mat.metalness).toBeCloseTo(0.0, 5);
    // Opaque: transparent=false (default when not set), opacity=1.
    expect(mat.transparent).toBe(false);
    expect(mat.opacity).toBeCloseTo(1, 5);
  });

  test('group starts VISIBLE after install (issue #67 carry-forward)', async () => {
    const scene = createScene();
    const group = getGroup(scene);

    // Pre-install: the scene factory sets visible=false (no parts yet).
    expect(group.visible).toBe(false);

    await setPrintableParts(scene, makePrintShell());
    expect(group.visible).toBe(true);
    expect(arePrintablePartsVisible(scene)).toBe(true);
  });

  test('caches the print-shell Manifold on the group userData', async () => {
    const scene = createScene();
    const parts = makePrintShell();

    await setPrintableParts(scene, parts);

    const group = getGroup(scene);
    expect(group.userData[PRINT_SHELL_MANIFOLD_KEY]).toBe(parts.printShell);
  });

  test('hasPrintableParts reports true after setPrintableParts', async () => {
    const scene = createScene();
    expect(hasPrintableParts(scene)).toBe(false);
    await setPrintableParts(scene, makePrintShell());
    expect(hasPrintableParts(scene)).toBe(true);
  });
});

describe('setPrintableParts — replacement (no accumulation)', () => {
  test('second setPrintableParts replaces the first; prior Manifold disposed', async () => {
    const scene = createScene();
    const first = makePrintShell();
    const deleteSpy = vi.fn(first.printShell.delete.bind(first.printShell));
    first.printShell.delete = deleteSpy;

    await setPrintableParts(scene, first);

    const second = makePrintShell();
    await setPrintableParts(scene, second);

    const group = getGroup(scene);
    const meshes = group.children.filter((c) => (c as Mesh).isMesh);
    expect(meshes.length).toBe(1);

    // Prior Manifold .delete()'d exactly once.
    expect(deleteSpy).toHaveBeenCalledTimes(1);

    // New Manifold cached.
    expect(group.userData[PRINT_SHELL_MANIFOLD_KEY]).toBe(second.printShell);
  });

  test('generate × 3 leaves exactly one mesh + one cached Manifold', async () => {
    const scene = createScene();
    const group = getGroup(scene);

    for (let i = 0; i < 3; i++) {
      await setPrintableParts(scene, makePrintShell());
      const meshes = group.children.filter((c) => (c as Mesh).isMesh);
      expect(meshes.length).toBe(1);
      expect(group.userData[PRINT_SHELL_MANIFOLD_KEY]).toBeDefined();
    }
  });

  test('replacement resets visibility to true (default ON)', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makePrintShell());
    // User flipped the toggle off in-between.
    setPrintablePartsVisible(scene, false);
    expect(arePrintablePartsVisible(scene)).toBe(false);

    await setPrintableParts(scene, makePrintShell());
    // Fresh install re-shows — the default-ON semantic applies to every
    // install, not just the first one.
    expect(arePrintablePartsVisible(scene)).toBe(true);
  });
});

describe('clearPrintableParts', () => {
  test('removes the mesh, disposes GPU, and deletes the cached Manifold', async () => {
    const scene = createScene();
    const parts = makePrintShell();
    const deleteSpy = vi.fn(parts.printShell.delete.bind(parts.printShell));
    parts.printShell.delete = deleteSpy;

    const { mesh } = await setPrintableParts(scene, parts);

    const geomDispose = vi.spyOn(mesh.geometry, 'dispose');
    const matDispose = vi.spyOn(
      mesh.material as MeshStandardMaterial,
      'dispose',
    );

    clearPrintableParts(scene);

    const group = getGroup(scene);
    const meshes = group.children.filter((c) => (c as Mesh).isMesh);
    expect(meshes.length).toBe(0);

    expect(geomDispose).toHaveBeenCalledTimes(1);
    expect(matDispose).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledTimes(1);

    expect(group.userData[PRINT_SHELL_MANIFOLD_KEY]).toBeUndefined();
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
    await setPrintableParts(scene, makePrintShell());
    clearPrintableParts(scene);
    expect(() => clearPrintableParts(scene)).not.toThrow();
  });
});

describe('setPrintablePartsVisible', () => {
  test('flips group.visible true/false', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makePrintShell());
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
  test('while visible, exploded=true lifts mesh to +Y; false collapses', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makePrintShell());
    setPrintablePartsVisible(scene, true);

    const group = getGroup(scene);
    const mesh = group.children.find(
      (c) => c.userData['tag'] === 'print-shell',
    ) as Mesh;

    setPrintablePartsExplodedView(scene, true);
    advanceRaf(300); // past the 250 ms tween

    // makePrintShell(): bbox Y ∈ [-30, 30] → height 60 → 0.25*60 = 15 →
    // floor 40 → offset = 40 mm.
    expect(mesh.position.y).toBeCloseTo(40, 3);
    expect(mesh.position.x).toBeCloseTo(0, 4);
    expect(mesh.position.z).toBeCloseTo(0, 4);

    // Idle after tween completes.
    expect(isPrintableExplodedIdle(scene)).toBe(true);

    // Collapse back.
    setPrintablePartsExplodedView(scene, false);
    advanceRaf(300);

    expect(mesh.position.y).toBeCloseTo(0, 3);
  });

  test('while hidden, exploded state is applied WITHOUT starting a tween (perf)', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makePrintShell());
    // Force hide so we exercise the "exploded-while-hidden" short-circuit.
    setPrintablePartsVisible(scene, false);

    setPrintablePartsExplodedView(scene, true);

    // Idle — no RAF scheduled because no visible tween is worth running.
    expect(isPrintableExplodedIdle(scene)).toBe(true);

    const group = getGroup(scene);
    const mesh = group.children.find(
      (c) => c.userData['tag'] === 'print-shell',
    ) as Mesh;

    // Position snapped to the exploded target — when visible again, mesh
    // appears at the right place.
    expect(mesh.position.y).toBeCloseTo(40, 3);
  });

  test('hiding mid-tween cancels the RAF loop (no wasted frame work)', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makePrintShell());
    setPrintablePartsVisible(scene, true);

    setPrintablePartsExplodedView(scene, true);
    expect(isPrintableExplodedIdle(scene)).toBe(false);

    // Advance a bit into the tween.
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

  test('fresh setPrintableParts resets position to collapsed even after exploded', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makePrintShell());
    setPrintablePartsVisible(scene, true);
    setPrintablePartsExplodedView(scene, true);
    advanceRaf(300);

    // Install a new shell — position should reset to 0.
    await setPrintableParts(scene, makePrintShell());
    const group = getGroup(scene);
    const mesh = group.children.find(
      (c) => c.userData['tag'] === 'print-shell',
    ) as Mesh;

    expect(mesh.position.y).toBeCloseTo(0, 4);
  });
});

describe('isPrintableExplodedIdle — state machine', () => {
  test('returns true when no parts installed', () => {
    const scene = createScene();
    expect(isPrintableExplodedIdle(scene)).toBe(true);
  });

  test('returns true when parts installed but never exploded', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makePrintShell());
    expect(isPrintableExplodedIdle(scene)).toBe(true);
  });

  test('returns false while tween is in flight, true after', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makePrintShell());
    setPrintablePartsVisible(scene, true);

    setPrintablePartsExplodedView(scene, true);
    expect(isPrintableExplodedIdle(scene)).toBe(false);

    advanceRaf(300);
    expect(isPrintableExplodedIdle(scene)).toBe(true);
  });

  test('returns true when group is hidden even if target fraction is 1', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makePrintShell());
    setPrintablePartsVisible(scene, false);
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
