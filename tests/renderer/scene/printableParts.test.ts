// tests/renderer/scene/printableParts.test.ts
//
// Unit tests for the printable-parts scene module. Post-Wave-E (issue
// #84) this module manages N+1 meshes under the printable-parts group:
//   - N shell pieces (shell-piece-0 .. shell-piece-{N-1})
//     Each piece translates RADIALLY outward from the master's XZ
//     center on explode. Direction is piece-specific (derived from the
//     piece's own AABB centroid vs. the provided `xzCenter`).
//   - base-slab   (lifts -Y on explode, unchanged from Wave D).
//
// Both sets are installed via `setPrintableParts(scene, {shellPieces,
// basePart, xzCenter?})` and removed via `clearPrintableParts`. The
// toggle flips all N+1 together.
//
// Pins:
//
//   1. `setPrintableParts` places N Mesh children (one per shell
//      piece) + 1 slab mesh under the group with the expected gray
//      opaque material and the expected tags.
//   2. Installed group starts `visible=true` regardless of prior
//      state.
//   3. `setPrintableParts` atomically replaces prior meshes — every
//      old mesh disposed, every old Manifold `.delete()`'d, new set
//      installed.
//   4. Generate × 3 never accumulates meshes or cached handles.
//   5. `clearPrintableParts` removes every mesh + disposes GPU +
//      deletes every cached Manifold.
//   6. `setPrintablePartsVisible(true/false)` flips group.visible
//      (and therefore every mesh's visibility in a single operation).
//   7. `setPrintablePartsExplodedView(true)` while visible animates
//      every shell piece RADIALLY and the slab -Y in parallel;
//      `false` collapses all to origin.
//   8. While hidden, `setPrintablePartsExplodedView` does NOT start a
//      tween (perf: no wasted per-frame work).
//   9. `arePrintablePartsVisible` + `isPrintableExplodedIdle` report
//      correctly through every state transition.
//  10. Radial exploded direction for each shell piece is derived from
//      its own world-AABB centroid vs. the master's XZ center.

import { MeshStandardMaterial, type Group, type Mesh } from 'three';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { initManifold } from '@/geometry/initManifold';
import { createScene } from '@/renderer/scene/index';
import {
  BASE_SLAB_MANIFOLD_KEY,
  SHELL_PIECES_MANIFOLD_KEY,
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
 * Build N plausible shell pieces + a base-slab Manifold for testing.
 * Each shell piece is a small cube placed at an offset from origin so
 * the radial-explode direction is well-defined and distinct per piece.
 *
 * Piece positions (XZ centers):
 *   N=4: (+R,+R), (-R,+R), (-R,-R), (+R,-R) — one per quadrant.
 *   N=3: three 120°-spaced points on a circle of radius R.
 *   N=2: (+R, 0) and (-R, 0).
 *
 * Each piece has a Y span of 60 mm and its own radial offset of R mm.
 * The base slab is a flat wide cube at origin.
 */
function makeParts(
  sideCount: 2 | 3 | 4 = 4,
  R = 20,
): { shellPieces: Manifold[]; basePart: Manifold; xzCenter: { x: number; z: number } } {
  const shellPieces: Manifold[] = [];
  for (let i = 0; i < sideCount; i++) {
    const angleDeg =
      sideCount === 2
        ? i === 0
          ? 0
          : 180
        : sideCount === 3
          ? i * 120
          : i * 90 + 45;
    const angleRad = angleDeg * (Math.PI / 180);
    const cx = R * Math.cos(angleRad);
    const cz = R * Math.sin(angleRad);
    const cube = toplevel.Manifold.cube([10, 60, 10], true);
    const placed = cube.translate([cx, 0, cz]);
    cube.delete();
    shellPieces.push(placed);
  }
  return {
    shellPieces,
    basePart: toplevel.Manifold.cube([50, 10, 50], true),
    xzCenter: { x: 0, z: 0 },
  };
}

describe('setPrintableParts — basic install', () => {
  test('places N shell-piece meshes + 1 base-slab mesh under the group', async () => {
    const scene = createScene();
    const parts = makeParts(4);

    const result = await setPrintableParts(scene, parts);

    const group = getGroup(scene);
    const meshChildren = group.children.filter((c) => (c as Mesh).isMesh);
    expect(meshChildren.length).toBe(5); // 4 pieces + 1 slab

    for (let i = 0; i < 4; i++) {
      const tagged = meshChildren.find(
        (c) => c.userData['tag'] === `shell-piece-${i}`,
      );
      expect(tagged).toBeTruthy();
    }
    const slabTagged = meshChildren.find(
      (c) => c.userData['tag'] === 'base-slab-mesh',
    );
    expect(slabTagged).toBeTruthy();
    expect(result.shellMeshes.length).toBe(4);
    expect(result.slabMesh).toBe(slabTagged);
  });

  test('N+1 mesh contract holds for sideCount 2 and 3 as well', async () => {
    for (const sideCount of [2, 3] as const) {
      const scene = createScene();
      const parts = makeParts(sideCount);
      await setPrintableParts(scene, parts);
      const group = getGroup(scene);
      const meshCount = group.children.filter((c) => (c as Mesh).isMesh).length;
      expect(meshCount).toBe(sideCount + 1);
    }
  });

  test('installs opaque gray material on every mesh', async () => {
    const scene = createScene();
    const parts = makeParts(4);

    const { shellMeshes, slabMesh } = await setPrintableParts(scene, parts);

    for (const mesh of [...shellMeshes, slabMesh]) {
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

    await setPrintableParts(scene, makeParts(4));
    expect(group.visible).toBe(true);
    expect(arePrintablePartsVisible(scene)).toBe(true);
  });

  test('caches every Manifold on the group userData', async () => {
    const scene = createScene();
    const parts = makeParts(4);

    await setPrintableParts(scene, parts);

    const group = getGroup(scene);
    const cachedPieces = group.userData[SHELL_PIECES_MANIFOLD_KEY] as Manifold[];
    expect(cachedPieces).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      expect(cachedPieces[i]).toBe(parts.shellPieces[i]);
    }
    expect(group.userData[BASE_SLAB_MANIFOLD_KEY]).toBe(parts.basePart);
  });

  test('hasPrintableParts reports true after setPrintableParts', async () => {
    const scene = createScene();
    expect(hasPrintableParts(scene)).toBe(false);
    await setPrintableParts(scene, makeParts(4));
    expect(hasPrintableParts(scene)).toBe(true);
  });
});

describe('setPrintableParts — replacement (no accumulation)', () => {
  test('second setPrintableParts replaces the first; every prior Manifold disposed', async () => {
    const scene = createScene();
    const first = makeParts(4);
    const pieceSpies = first.shellPieces.map((p) => {
      const spy = vi.fn(p.delete.bind(p));
      p.delete = spy;
      return spy;
    });
    const slabSpy = vi.fn(first.basePart.delete.bind(first.basePart));
    first.basePart.delete = slabSpy;

    await setPrintableParts(scene, first);

    const second = makeParts(4);
    await setPrintableParts(scene, second);

    const group = getGroup(scene);
    const meshes = group.children.filter((c) => (c as Mesh).isMesh);
    expect(meshes.length).toBe(5);

    for (const spy of pieceSpies) expect(spy).toHaveBeenCalledTimes(1);
    expect(slabSpy).toHaveBeenCalledTimes(1);

    const cachedPieces = group.userData[SHELL_PIECES_MANIFOLD_KEY] as Manifold[];
    for (let i = 0; i < 4; i++) {
      expect(cachedPieces[i]).toBe(second.shellPieces[i]);
    }
    expect(group.userData[BASE_SLAB_MANIFOLD_KEY]).toBe(second.basePart);
  });

  test('generate × 3 leaves exactly N+1 meshes + cached Manifolds', async () => {
    const scene = createScene();
    const group = getGroup(scene);

    for (let i = 0; i < 3; i++) {
      await setPrintableParts(scene, makeParts(4));
      const meshes = group.children.filter((c) => (c as Mesh).isMesh);
      expect(meshes.length).toBe(5);
      const cachedPieces = group.userData[SHELL_PIECES_MANIFOLD_KEY] as
        | Manifold[]
        | undefined;
      expect(cachedPieces?.length).toBe(4);
      expect(group.userData[BASE_SLAB_MANIFOLD_KEY]).toBeDefined();
    }
  });

  test('replacement resets visibility to true (default ON)', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makeParts(4));
    setPrintablePartsVisible(scene, false);
    expect(arePrintablePartsVisible(scene)).toBe(false);

    await setPrintableParts(scene, makeParts(4));
    expect(arePrintablePartsVisible(scene)).toBe(true);
  });
});

describe('clearPrintableParts', () => {
  test('removes every mesh, disposes GPU, and deletes every cached Manifold', async () => {
    const scene = createScene();
    const parts = makeParts(4);
    const pieceSpies = parts.shellPieces.map((p) => {
      const spy = vi.fn(p.delete.bind(p));
      p.delete = spy;
      return spy;
    });
    const slabSpy = vi.fn(parts.basePart.delete.bind(parts.basePart));
    parts.basePart.delete = slabSpy;

    const { shellMeshes, slabMesh } = await setPrintableParts(scene, parts);

    const pieceDisposes = shellMeshes.map((m) => ({
      geom: vi.spyOn(m.geometry, 'dispose'),
      mat: vi.spyOn(m.material as MeshStandardMaterial, 'dispose'),
    }));
    const slabGeomDispose = vi.spyOn(slabMesh.geometry, 'dispose');
    const slabMatDispose = vi.spyOn(
      slabMesh.material as MeshStandardMaterial,
      'dispose',
    );

    clearPrintableParts(scene);

    const group = getGroup(scene);
    const meshes = group.children.filter((c) => (c as Mesh).isMesh);
    expect(meshes.length).toBe(0);

    for (const d of pieceDisposes) {
      expect(d.geom).toHaveBeenCalledTimes(1);
      expect(d.mat).toHaveBeenCalledTimes(1);
    }
    expect(slabGeomDispose).toHaveBeenCalledTimes(1);
    expect(slabMatDispose).toHaveBeenCalledTimes(1);
    for (const spy of pieceSpies) expect(spy).toHaveBeenCalledTimes(1);
    expect(slabSpy).toHaveBeenCalledTimes(1);

    expect(group.userData[SHELL_PIECES_MANIFOLD_KEY]).toBeUndefined();
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
    await setPrintableParts(scene, makeParts(4));
    clearPrintableParts(scene);
    expect(() => clearPrintableParts(scene)).not.toThrow();
  });
});

describe('setPrintablePartsVisible', () => {
  test('flips group.visible true/false (hides every mesh)', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makeParts(4));
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
  test('while visible, exploded=true lifts each shell piece RADIALLY + drops slab -Y; false collapses', async () => {
    const scene = createScene();
    const parts = makeParts(4);
    await setPrintableParts(scene, parts);
    setPrintablePartsVisible(scene, true);

    const group = getGroup(scene);
    const pieceMeshes = [0, 1, 2, 3].map(
      (i) =>
        group.children.find(
          (c) => c.userData['tag'] === `shell-piece-${i}`,
        ) as Mesh,
    );
    const slabMesh = group.children.find(
      (c) => c.userData['tag'] === 'base-slab-mesh',
    ) as Mesh;

    setPrintablePartsExplodedView(scene, true);
    advanceRaf(300); // past the 250 ms tween

    // Every shell piece should have moved RADIALLY (non-zero XZ, zero
    // Y) away from origin. Check signs against the piece's original
    // quadrant: piece 0 at (+R,+R) → moves to (+dx, 0, +dz); piece 1
    // at (-R,+R) → (-dx, 0, +dz); etc.
    for (let i = 0; i < 4; i++) {
      const pos = (pieceMeshes[i] as Mesh).position;
      expect(pos.y).toBeCloseTo(0, 4);
      const angleDeg = i * 90 + 45;
      const expectedSignX = Math.sign(Math.cos(angleDeg * Math.PI / 180));
      const expectedSignZ = Math.sign(Math.sin(angleDeg * Math.PI / 180));
      // Offset magnitude defaults to `max(30, 0.3 * bboxHorizRadius)`
      // — for our 10mm cube offset by 20mm, horizRadius ≈ 25 so floor
      // 30 controls. Expect the resultant XZ norm to be ≥ 30 mm.
      const xzNorm = Math.sqrt(pos.x * pos.x + pos.z * pos.z);
      expect(xzNorm).toBeGreaterThan(25);
      // Direction sign matches the piece's original quadrant.
      if (expectedSignX !== 0) {
        expect(Math.sign(pos.x)).toBe(expectedSignX);
      }
      if (expectedSignZ !== 0) {
        expect(Math.sign(pos.z)).toBe(expectedSignZ);
      }
    }
    // Slab: Y ∈ [-5, 5] → 0.2 × 10 = 2, floor 30 → magnitude 30 → -30.
    expect(slabMesh.position.y).toBeCloseTo(-30, 3);
    expect(slabMesh.position.x).toBeCloseTo(0, 4);
    expect(slabMesh.position.z).toBeCloseTo(0, 4);

    expect(isPrintableExplodedIdle(scene)).toBe(true);

    setPrintablePartsExplodedView(scene, false);
    advanceRaf(300);

    for (const mesh of pieceMeshes) {
      expect(mesh.position.x).toBeCloseTo(0, 3);
      expect(mesh.position.y).toBeCloseTo(0, 3);
      expect(mesh.position.z).toBeCloseTo(0, 3);
    }
    expect(slabMesh.position.y).toBeCloseTo(0, 3);
  });

  test('while hidden, exploded state is applied WITHOUT starting a tween (perf)', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makeParts(4));
    setPrintablePartsVisible(scene, false);

    setPrintablePartsExplodedView(scene, true);

    expect(isPrintableExplodedIdle(scene)).toBe(true);

    const group = getGroup(scene);
    const pieceMeshes = [0, 1, 2, 3].map(
      (i) =>
        group.children.find(
          (c) => c.userData['tag'] === `shell-piece-${i}`,
        ) as Mesh,
    );
    const slabMesh = group.children.find(
      (c) => c.userData['tag'] === 'base-slab-mesh',
    ) as Mesh;

    // Every piece at its exploded target (non-zero XZ).
    for (const mesh of pieceMeshes) {
      const xzNorm = Math.sqrt(
        mesh.position.x * mesh.position.x + mesh.position.z * mesh.position.z,
      );
      expect(xzNorm).toBeGreaterThan(25);
    }
    expect(slabMesh.position.y).toBeCloseTo(-30, 3);
  });

  test('hiding mid-tween cancels RAF loops on every mesh', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makeParts(4));
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

  test('fresh setPrintableParts resets every position to collapsed even after exploded', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makeParts(4));
    setPrintablePartsVisible(scene, true);
    setPrintablePartsExplodedView(scene, true);
    advanceRaf(300);

    await setPrintableParts(scene, makeParts(4));
    const group = getGroup(scene);
    const pieceMeshes = [0, 1, 2, 3].map(
      (i) =>
        group.children.find(
          (c) => c.userData['tag'] === `shell-piece-${i}`,
        ) as Mesh,
    );
    const slabMesh = group.children.find(
      (c) => c.userData['tag'] === 'base-slab-mesh',
    ) as Mesh;

    for (const mesh of pieceMeshes) {
      expect(mesh.position.x).toBeCloseTo(0, 4);
      expect(mesh.position.y).toBeCloseTo(0, 4);
      expect(mesh.position.z).toBeCloseTo(0, 4);
    }
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
    await setPrintableParts(scene, makeParts(4));
    expect(isPrintableExplodedIdle(scene)).toBe(true);
  });

  test('returns false while any tween is in flight; true only when ALL settle', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makeParts(4));
    setPrintablePartsVisible(scene, true);

    setPrintablePartsExplodedView(scene, true);
    expect(isPrintableExplodedIdle(scene)).toBe(false);

    advanceRaf(300);
    expect(isPrintableExplodedIdle(scene)).toBe(true);
  });

  test('returns true when group is hidden even if target fraction is 1', async () => {
    const scene = createScene();
    await setPrintableParts(scene, makeParts(4));
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
