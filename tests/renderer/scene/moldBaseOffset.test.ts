// tests/renderer/scene/moldBaseOffset.test.ts
//
// Unit tests for the mold-base offset helper (issue #87 Fix 2). Pins:
//
//   1. Fresh scene → `getMoldBaseOffset` returns 0.
//   2. `applyMoldBaseOffset(scene, 8)` shifts master / silicone /
//      printableParts groups by +8 on Y.
//   3. Second `applyMoldBaseOffset(scene, 12)` replaces the offset
//      atomically (net +12 from pre-apply rest, not +20).
//   4. `clearMoldBaseOffset` restores groups to their pre-apply
//      positions; `getMoldBaseOffset` returns 0 afterward.
//   5. `reapplyMoldBaseOffsetToMaster` adds the stored offset to the
//      master group's current Y (simulating `recenterGroup` having
//      just clobbered it to 0).
//   6. Non-finite / negative / zero offsets → clear.
//   7. Idempotent on a scene with no offset active.

import { describe, expect, test } from 'vitest';

import { createScene } from '@/renderer/scene/index';
import {
  applyMoldBaseOffset,
  clearMoldBaseOffset,
  getMoldBaseOffset,
  MOLD_BASE_OFFSET_KEY,
  reapplyMoldBaseOffsetToMaster,
} from '@/renderer/scene/moldBaseOffset';

function getGroup(
  scene: ReturnType<typeof createScene>,
  tag: string,
): { position: { x: number; y: number; z: number }; userData: Record<string, unknown> } {
  const g = scene.children.find((c) => c.userData['tag'] === tag);
  if (!g) throw new Error(`group ${tag} missing from scene`);
  return g as unknown as {
    position: { x: number; y: number; z: number };
    userData: Record<string, unknown>;
  };
}

describe('moldBaseOffset — fresh scene', () => {
  test('getMoldBaseOffset returns 0 before any apply', () => {
    const scene = createScene();
    expect(getMoldBaseOffset(scene)).toBe(0);
  });

  test('clearMoldBaseOffset is a no-op on a fresh scene', () => {
    const scene = createScene();
    expect(() => clearMoldBaseOffset(scene)).not.toThrow();
    expect(getMoldBaseOffset(scene)).toBe(0);
  });
});

describe('moldBaseOffset — apply', () => {
  test('applies offset to master + silicone + printableParts groups', () => {
    const scene = createScene();
    // Simulate master-load auto-center: master.y = 5 (master.min.y = -5).
    getGroup(scene, 'master').position.y = 5;

    applyMoldBaseOffset(scene, 8);

    expect(getGroup(scene, 'master').position.y).toBeCloseTo(13, 6);
    expect(getGroup(scene, 'silicone').position.y).toBeCloseTo(8, 6);
    expect(getGroup(scene, 'printableParts').position.y).toBeCloseTo(8, 6);
    expect(getMoldBaseOffset(scene)).toBe(8);
    expect(getGroup(scene, 'master').userData[MOLD_BASE_OFFSET_KEY]).toBe(8);
  });

  test('a second apply replaces the offset atomically (no stacking)', () => {
    const scene = createScene();
    getGroup(scene, 'master').position.y = 5;

    applyMoldBaseOffset(scene, 8);
    applyMoldBaseOffset(scene, 12);

    // master starts at 5, was lifted to 13, then net +4 to 17.
    expect(getGroup(scene, 'master').position.y).toBeCloseTo(17, 6);
    expect(getGroup(scene, 'silicone').position.y).toBeCloseTo(12, 6);
    expect(getGroup(scene, 'printableParts').position.y).toBeCloseTo(12, 6);
    expect(getMoldBaseOffset(scene)).toBe(12);
  });

  test('a re-apply with the same offset is a no-op', () => {
    const scene = createScene();
    getGroup(scene, 'master').position.y = 5;

    applyMoldBaseOffset(scene, 8);
    applyMoldBaseOffset(scene, 8);

    expect(getGroup(scene, 'master').position.y).toBeCloseTo(13, 6);
    expect(getGroup(scene, 'silicone').position.y).toBeCloseTo(8, 6);
    expect(getMoldBaseOffset(scene)).toBe(8);
  });
});

describe('moldBaseOffset — clear', () => {
  test('clearMoldBaseOffset restores pre-apply positions', () => {
    const scene = createScene();
    getGroup(scene, 'master').position.y = 5;

    applyMoldBaseOffset(scene, 8);
    clearMoldBaseOffset(scene);

    expect(getGroup(scene, 'master').position.y).toBeCloseTo(5, 6);
    expect(getGroup(scene, 'silicone').position.y).toBeCloseTo(0, 6);
    expect(getGroup(scene, 'printableParts').position.y).toBeCloseTo(0, 6);
    expect(getMoldBaseOffset(scene)).toBe(0);
    expect(
      getGroup(scene, 'master').userData[MOLD_BASE_OFFSET_KEY],
    ).toBeUndefined();
  });

  test('clearMoldBaseOffset is idempotent after a single apply', () => {
    const scene = createScene();
    getGroup(scene, 'master').position.y = 5;
    applyMoldBaseOffset(scene, 8);
    clearMoldBaseOffset(scene);
    expect(() => clearMoldBaseOffset(scene)).not.toThrow();
    expect(getMoldBaseOffset(scene)).toBe(0);
  });
});

describe('moldBaseOffset — reapply after recenter', () => {
  test('reapplyMoldBaseOffsetToMaster adds stored offset to current Y', () => {
    const scene = createScene();
    // Pretend a generate just happened.
    getGroup(scene, 'master').position.y = 5;
    applyMoldBaseOffset(scene, 8);
    expect(getGroup(scene, 'master').position.y).toBeCloseTo(13, 6);

    // Simulate `recenterGroup` clobbering position.y back to 5
    // (e.g. after a dimensions-panel scale change).
    getGroup(scene, 'master').position.y = 5;

    reapplyMoldBaseOffsetToMaster(scene);

    expect(getGroup(scene, 'master').position.y).toBeCloseTo(13, 6);
    // silicone + printableParts were NOT re-touched — they still sit
    // at the initial offset (no recenter runs against them).
    expect(getGroup(scene, 'silicone').position.y).toBeCloseTo(8, 6);
  });

  test('reapplyMoldBaseOffsetToMaster is a no-op when no offset stored', () => {
    const scene = createScene();
    getGroup(scene, 'master').position.y = 5;
    reapplyMoldBaseOffsetToMaster(scene);
    expect(getGroup(scene, 'master').position.y).toBeCloseTo(5, 6);
  });
});

describe('moldBaseOffset — degenerate inputs', () => {
  test('non-finite offset is treated as clear', () => {
    const scene = createScene();
    applyMoldBaseOffset(scene, 8);
    applyMoldBaseOffset(scene, Number.NaN);
    expect(getMoldBaseOffset(scene)).toBe(0);
  });

  test('negative offset is treated as clear', () => {
    const scene = createScene();
    applyMoldBaseOffset(scene, 8);
    applyMoldBaseOffset(scene, -3);
    expect(getMoldBaseOffset(scene)).toBe(0);
  });

  test('zero offset is treated as clear', () => {
    const scene = createScene();
    applyMoldBaseOffset(scene, 8);
    applyMoldBaseOffset(scene, 0);
    expect(getMoldBaseOffset(scene)).toBe(0);
  });
});
