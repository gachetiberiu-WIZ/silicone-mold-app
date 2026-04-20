// tests/renderer/scene/gizmos.test.ts
//
// Scene-graph invariants for the origin gizmos (grid + world axes).
//
// Pins the fix for issue #26 ("z-fighting between axes and grid at
// origin"): the axes sit EXACTLY at y=0 (so they occlude correctly
// behind meshes sitting on the print bed) and the grid sits a hair
// below y=0 (so the depth buffer never ties the two coplanar line
// sets at the origin).
//
// These are pure scene-graph assertions — no WebGL context is spun
// up. Runs under Vitest's `node` environment via happy-dom, same as
// the rest of `tests/renderer/scene/`.

import { AxesHelper, GridHelper } from 'three';
import { describe, expect, test } from 'vitest';

import { createOriginGizmos } from '@/renderer/scene/gizmos';

describe('createOriginGizmos — origin grid + world axes (issue #26)', () => {
  test('returns a Group tagged `origin-gizmos`', () => {
    const group = createOriginGizmos();
    expect(group.userData['tag']).toBe('origin-gizmos');
  });

  test('contains exactly one world AxesHelper tagged `world-axes`', () => {
    const group = createOriginGizmos();
    const axesChildren = group.children.filter(
      (c) => c instanceof AxesHelper,
    );
    expect(axesChildren).toHaveLength(1);
    expect(axesChildren[0]!.userData['tag']).toBe('world-axes');
  });

  test('contains a major GridHelper with a minor GridHelper child', () => {
    const group = createOriginGizmos();
    const major = group.children.find(
      (c): c is GridHelper =>
        c instanceof GridHelper && c.userData['tag'] === 'grid-major',
    );
    expect(major, 'major grid missing').toBeDefined();
    const minor = major!.children.find(
      (c): c is GridHelper =>
        c instanceof GridHelper && c.userData['tag'] === 'grid-minor',
    );
    expect(minor, 'minor grid missing').toBeDefined();
  });

  test('world axes sit exactly at y=0 (so meshes on the bed occlude them)', () => {
    const group = createOriginGizmos();
    const axes = group.children.find(
      (c): c is AxesHelper => c instanceof AxesHelper,
    );
    expect(axes).toBeDefined();
    // Axes anchor at the origin — position is the default (0, 0, 0).
    expect(axes!.position.y).toBe(0);
    expect(axes!.position.x).toBe(0);
    expect(axes!.position.z).toBe(0);
  });

  test('major grid sits below y=0 to avoid z-fighting with axes', () => {
    const group = createOriginGizmos();
    const major = group.children.find(
      (c): c is GridHelper =>
        c instanceof GridHelper && c.userData['tag'] === 'grid-major',
    );
    expect(major).toBeDefined();
    // Nudge must be strictly below zero — sign matters for the fix.
    expect(major!.position.y).toBeLessThan(0);
    // And imperceptibly small — no visible gap under meshes on the bed
    // (acceptance criterion #3 on issue #26). 0.1 mm is our upper bound;
    // current value is 0.01 mm.
    expect(Math.abs(major!.position.y)).toBeLessThan(0.1);
  });

  test('minor grid sits below the major grid (local offset)', () => {
    const group = createOriginGizmos();
    const major = group.children.find(
      (c): c is GridHelper =>
        c instanceof GridHelper && c.userData['tag'] === 'grid-major',
    );
    const minor = major!.children.find(
      (c): c is GridHelper =>
        c instanceof GridHelper && c.userData['tag'] === 'grid-minor',
    );
    expect(minor!.position.y).toBeLessThan(0);
  });
});
