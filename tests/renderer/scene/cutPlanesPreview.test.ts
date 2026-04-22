// tests/renderer/scene/cutPlanesPreview.test.ts
//
// @vitest-environment happy-dom
//
// Unit tests for the cut-planes preview scene module. Coverage:
//
//   1. `attach()` places a `cut-planes-preview` group in the scene with
//      N child planes (one per SIDE_CUT_ANGLES[sideCount] entry).
//   2. Rotation from the store flows onto the anchor's `rotation.y`.
//   3. Center-offset from the store translates the anchor relative to
//      the master's XZ center.
//   4. `objectChange` on the gizmo (simulated by writing to the anchor
//      then firing the event directly) pushes to the store's
//      setCenterOffset + setRotation.
//   5. Y-axis lock: manually setting `anchor.rotation.x = 0.5` then
//      ticking `onFrame()` snaps it back to 0. Same for `position.y`.
//   6. `detach()` removes the preview group and clears the child
//      planes.
//   7. `rebuild()` swaps the plane count when sideCount changes.
//   8. `setVisible(false)` hides the root.

import {
  Box3,
  PerspectiveCamera,
  Scene,
  Vector3,
} from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { beforeEach, describe, expect, test } from 'vitest';

import {
  CUT_PLANES_ANCHOR_TAG,
  CUT_PLANES_PREVIEW_TAG,
  createCutPlanesPreview,
} from '@/renderer/scene/cutPlanesPreview';
import { SIDE_CUT_ANGLES } from '@/geometry/sideAngles';
import { createCutOverridesStore } from '@/renderer/state/cutOverrides';

/**
 * Minimal OrbitControls stand-in — TransformControls only needs
 * `.enabled` to flip on drag. Scene tests don't actually drive the
 * gizmo, so this is sufficient.
 */
function makeMockControls(): OrbitControls {
  const obj = {
    enabled: true,
  };
  return obj as unknown as OrbitControls;
}

/**
 * Build a dummy master bbox — 20 × 30 × 40 mm box centered on origin.
 * XZ center = (0, 0); Y center = 15; max XZ radius = hypot(10, 20) ≈ 22.36.
 */
function makeMasterBbox(): Box3 {
  return new Box3(
    new Vector3(-10, 0, -20),
    new Vector3(10, 30, 20),
  );
}

function makeHarness(sideCount: 2 | 3 | 4 = 4) {
  const scene = new Scene();
  const camera = new PerspectiveCamera(50, 1, 0.1, 1000);
  const controls = makeMockControls();
  const canvas = document.createElement('canvas');
  const store = createCutOverridesStore();
  let sc: 2 | 3 | 4 = sideCount;

  const preview = createCutPlanesPreview({
    scene,
    camera,
    controls,
    canvas,
    getMasterBbox: () => makeMasterBbox(),
    getShellHeight: () => 30,
    getSideCount: () => sc,
    cutOverridesStore: store,
  });

  return {
    scene,
    camera,
    controls,
    canvas,
    store,
    preview,
    setSideCount: (n: 2 | 3 | 4) => {
      sc = n;
    },
  };
}

function findPreviewRoot(scene: Scene) {
  return scene.children.find(
    (c) => c.userData['tag'] === CUT_PLANES_PREVIEW_TAG,
  );
}

function findAnchor(scene: Scene) {
  const root = findPreviewRoot(scene);
  if (!root) return null;
  return root.children.find(
    (c) => c.userData['tag'] === CUT_PLANES_ANCHOR_TAG,
  );
}

function getPlaneMeshes(scene: Scene) {
  const anchor = findAnchor(scene);
  if (!anchor) return [];
  // All children of the anchor that are not the anchor tag itself.
  return anchor.children.filter((c) => c.userData['tag'] !== CUT_PLANES_ANCHOR_TAG);
}

describe('createCutPlanesPreview — attach / scene graph', () => {
  test('attach() adds a tagged root + anchor with N plane children', () => {
    const h = makeHarness(4);
    h.preview.attach();

    const root = findPreviewRoot(h.scene);
    expect(root).toBeTruthy();
    const anchor = findAnchor(h.scene);
    expect(anchor).toBeTruthy();

    const planes = getPlaneMeshes(h.scene);
    expect(planes.length).toBe(SIDE_CUT_ANGLES[4].length);
  });

  test('attach() then detach() is idempotent', () => {
    const h = makeHarness();
    h.preview.attach();
    h.preview.attach(); // idempotent
    expect(findPreviewRoot(h.scene)).toBeTruthy();
    h.preview.detach();
    h.preview.detach(); // idempotent
    expect(findPreviewRoot(h.scene)).toBeUndefined();
  });

  test('detach() removes the preview group from the scene', () => {
    const h = makeHarness();
    h.preview.attach();
    expect(findPreviewRoot(h.scene)).toBeTruthy();
    h.preview.detach();
    expect(findPreviewRoot(h.scene)).toBeUndefined();
  });
});

describe('createCutPlanesPreview — store → anchor sync', () => {
  test('setRotation(30) → anchor rotation.y = 30 × π/180', () => {
    const h = makeHarness();
    h.preview.attach();

    h.store.setRotation(30);
    const anchor = findAnchor(h.scene)!;
    const expected = (30 * Math.PI) / 180;
    expect((anchor as unknown as { rotation: { y: number } }).rotation.y).toBeCloseTo(
      expected,
      6,
    );
  });

  test('setCenterOffset(5, -3) → anchor position reflects master xzCenter + offset', () => {
    const h = makeHarness();
    h.preview.attach();

    h.store.setCenterOffset(5, -3);
    const anchor = findAnchor(h.scene)!;
    const pos = (anchor as unknown as {
      position: { x: number; y: number; z: number };
    }).position;
    // master bbox = centered on origin, Y in [0, 30] → yCenter = 15.
    expect(pos.x).toBeCloseTo(5, 6);
    expect(pos.y).toBeCloseTo(15, 6);
    expect(pos.z).toBeCloseTo(-3, 6);
  });
});

describe('createCutPlanesPreview — gizmo → store (simulated objectChange)', () => {
  test('writing to the anchor then firing objectChange pushes to the store', () => {
    const h = makeHarness();
    h.preview.attach();
    // Find the anchor and mutate its position/rotation as the gizmo
    // would. Then locate a TransformControls on the scene and fire the
    // `objectChange` event on it.
    const anchor = findAnchor(h.scene)!;
    (anchor as unknown as {
      position: { x: number; z: number };
    }).position.x = 2;
    (anchor as unknown as {
      position: { x: number; z: number };
    }).position.z = -4;
    (anchor as unknown as {
      rotation: { y: number };
    }).rotation.y = Math.PI / 4; // 45 deg

    // TransformControls helpers are added as scene children. Grab the
    // first helper whose controls exists and dispatch objectChange on
    // that controls instance. We walk up via the helper's .controls
    // (the back-reference TransformControls sets on its helper).
    const translate = scanForTransformControls(h.scene);
    expect(translate).toBeTruthy();
    translate!.dispatchEvent({ type: 'objectChange' });

    const snap = h.store.get();
    expect(snap.rotation_deg).toBeCloseTo(45, 4);
    expect(snap.centerOffset_mm.x).toBeCloseTo(2, 6);
    expect(snap.centerOffset_mm.z).toBeCloseTo(-4, 6);
  });
});

describe('createCutPlanesPreview — axis-lock defense on onFrame()', () => {
  test('onFrame() forces anchor.position.y back to yCenter', () => {
    const h = makeHarness();
    h.preview.attach();
    const anchor = findAnchor(h.scene)! as unknown as {
      position: { y: number };
      rotation: { x: number; y: number; z: number };
    };
    anchor.position.y = 77;
    h.preview.onFrame();
    // yCenter of master bbox Y∈[0,30] = 15.
    expect(anchor.position.y).toBe(15);
  });

  test('onFrame() zeros X and Z rotation', () => {
    const h = makeHarness();
    h.preview.attach();
    const anchor = findAnchor(h.scene)! as unknown as {
      rotation: { x: number; y: number; z: number };
    };
    anchor.rotation.x = 0.5;
    anchor.rotation.z = -0.25;
    h.preview.onFrame();
    expect(anchor.rotation.x).toBe(0);
    expect(anchor.rotation.z).toBe(0);
  });

  test('onFrame() does NOT touch rotation.y (that is the user-driven axis)', () => {
    const h = makeHarness();
    h.preview.attach();
    h.store.setRotation(90);
    const anchor = findAnchor(h.scene)! as unknown as {
      rotation: { y: number };
    };
    const before = anchor.rotation.y;
    h.preview.onFrame();
    expect(anchor.rotation.y).toBe(before);
  });
});

describe('createCutPlanesPreview — rebuild on sideCount change', () => {
  test('rebuild() swaps the plane count when sideCount changes', () => {
    const h = makeHarness(4);
    h.preview.attach();
    expect(getPlaneMeshes(h.scene).length).toBe(4);

    h.setSideCount(3);
    h.preview.rebuild();
    expect(getPlaneMeshes(h.scene).length).toBe(3);

    h.setSideCount(2);
    h.preview.rebuild();
    expect(getPlaneMeshes(h.scene).length).toBe(2);
  });
});

describe('createCutPlanesPreview — setVisible / isVisible', () => {
  test('setVisible(false) hides the root; isVisible returns false', () => {
    const h = makeHarness();
    h.preview.attach();
    expect(h.preview.isVisible()).toBe(true);
    h.preview.setVisible(false);
    expect(h.preview.isVisible()).toBe(false);
  });

  test('isVisible() returns false when not attached', () => {
    const h = makeHarness();
    expect(h.preview.isVisible()).toBe(false);
  });
});

/**
 * Walk the scene graph and find a TransformControls helper that carries
 * a `.controls` back-reference to an actual TransformControls instance.
 * Used by the objectChange test to dispatch the synthetic event.
 */
function scanForTransformControls(
  scene: Scene,
): { dispatchEvent: (e: { type: string }) => void } | null {
  type MaybeHelper = { children?: unknown[]; controls?: { dispatchEvent?: unknown } };
  const queue: MaybeHelper[] = [scene as unknown as MaybeHelper];
  while (queue.length > 0) {
    const item = queue.shift()!;
    if (item && item.controls && typeof item.controls.dispatchEvent === 'function') {
      return item.controls as { dispatchEvent: (e: { type: string }) => void };
    }
    if (Array.isArray(item.children)) {
      for (const child of item.children) {
        queue.push(child as MaybeHelper);
      }
    }
  }
  return null;
}

beforeEach(() => {
  document.body.innerHTML = '';
});
