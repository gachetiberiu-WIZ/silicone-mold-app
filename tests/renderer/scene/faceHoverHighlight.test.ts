// tests/renderer/scene/faceHoverHighlight.test.ts
//
// @vitest-environment happy-dom
//
// Unit tests for issue #67 face-pick hover highlight + coplanar flood-
// fill. The coplanar flood-fill helper is exported from
// `layFlatController.ts` for direct testing — same pattern as the
// `computeWorldBoxTight` helper in `layFlat.ts`.
//
// The controller-integration assertions drive the lay-flat controller
// through its public API (enable / disable / getHoverOverlay) plus a
// synthetic pointermove dispatched on the canvas. We don't exercise the
// three-mesh-bvh raycast here — the picking module's own test covers that
// path — but we DO assert the hover-overlay lifecycle:
//
//   1. Coplanar flood-fill on a flat quad (2 coplanar triangles) returns
//      both triangles.
//   2. Flood-fill on a cube seed returns the 2 triangles of the hit face
//      only (5 other faces share vertices but NOT normals).
//   3. Flood-fill terminates on sharp edges (normal beyond 2° tolerance).
//   4. Flood-fill on a single isolated triangle returns just the seed.
//   5. Hover overlay starts hidden + geometry empty.
//   6. `enable()` without a master is a no-op; overlay stays hidden.
//   7. On picking-mode exit, the overlay is fully disposed (geometry +
//      material) and removed from the scene.
//   8. The `#viewport.is-picking` CSS class is added on enable, removed
//      on disable.

import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
} from 'three';
import { beforeEach, describe, expect, test } from 'vitest';

import {
  coplanarFloodFill,
  createLayFlatController,
  LAY_FLAT_WIDGETS_TAG,
} from '@/renderer/scene/layFlatController';

/**
 * Build a minimal non-indexed BufferGeometry for a flat quad (2 coplanar
 * triangles sharing one edge), lying on the XZ plane. Vertices are the
 * standard CCW winding so `Vector3.cross` gives `(0, 1, 0)` — i.e. the
 * face normal points up.
 */
function flatQuadGeometry(): BufferGeometry {
  const g = new BufferGeometry();
  // Tri 0: (0,0,0), (1,0,0), (1,0,1)
  // Tri 1: (0,0,0), (1,0,1), (0,0,1)
  const verts = new Float32Array([
    0, 0, 0, 1, 0, 0, 1, 0, 1,
    0, 0, 0, 1, 0, 1, 0, 0, 1,
  ]);
  g.setAttribute('position', new BufferAttribute(verts, 3));
  return g;
}

/**
 * Build a non-indexed BufferGeometry for an L-shape: two coplanar tris
 * forming a square, plus one orthogonal triangle attached on the +Z edge
 * rotating 90° upward (shares the edge (1,0,1)-(0,0,1) but with a different
 * normal). The flood-fill seeded on tri 0 must NOT cross into the
 * orthogonal tri.
 */
function lShapeGeometry(): BufferGeometry {
  const g = new BufferGeometry();
  const verts = new Float32Array([
    // Tri 0: quad half on XZ plane, normal +Y
    0, 0, 0, 1, 0, 0, 1, 0, 1,
    // Tri 1: other quad half on XZ plane, shares edge (0,0,0)-(1,0,1)
    0, 0, 0, 1, 0, 1, 0, 0, 1,
    // Tri 2: orthogonal wall rising at z=1, normal -Z (or +Z depending
    // on winding). Shares the edge (0,0,1)-(1,0,1) with tri 1. Normal
    // perpendicular to +Y — flood-fill must reject it.
    0, 0, 1, 1, 0, 1, 0.5, 1, 1,
  ]);
  g.setAttribute('position', new BufferAttribute(verts, 3));
  return g;
}

/**
 * Build a cube via 12 triangles (6 faces × 2 tris). Each face has its own
 * normal; flood-fill from the seed face must return exactly 2 triangles
 * (the two tris of that face) — NOT the cube's other faces, even though
 * they share vertices at the cube's 8 corners.
 */
function cubeGeometry(): BufferGeometry {
  const g = new BufferGeometry();
  // Unit cube, corner-aligned at origin.
  // Face +Y (top, tri 0 + 1): y=1 plane
  // Face -Y (bottom, tri 2 + 3)
  // Face +X, -X, +Z, -Z
  const verts = new Float32Array([
    // Top (+Y)
    0, 1, 0, 1, 1, 0, 1, 1, 1,
    0, 1, 0, 1, 1, 1, 0, 1, 1,
    // Bottom (-Y)
    0, 0, 0, 1, 0, 1, 1, 0, 0,
    0, 0, 0, 0, 0, 1, 1, 0, 1,
    // +X
    1, 0, 0, 1, 0, 1, 1, 1, 1,
    1, 0, 0, 1, 1, 1, 1, 1, 0,
    // -X
    0, 0, 0, 0, 1, 1, 0, 0, 1,
    0, 0, 0, 0, 1, 0, 0, 1, 1,
    // +Z
    0, 0, 1, 1, 0, 1, 1, 1, 1,
    0, 0, 1, 1, 1, 1, 0, 1, 1,
    // -Z
    0, 0, 0, 1, 1, 0, 1, 0, 0,
    0, 0, 0, 0, 1, 0, 1, 1, 0,
  ]);
  g.setAttribute('position', new BufferAttribute(verts, 3));
  return g;
}

describe('coplanarFloodFill — pure helper', () => {
  test('flat quad (2 coplanar tris sharing an edge) → both tris returned', () => {
    const g = flatQuadGeometry();
    const { triangles } = coplanarFloodFill(g, 0);
    expect(triangles.sort()).toEqual([0, 1]);
  });

  test('flat quad, seed from the other triangle → same result (symmetry)', () => {
    const g = flatQuadGeometry();
    const { triangles } = coplanarFloodFill(g, 1);
    expect(triangles.sort()).toEqual([0, 1]);
  });

  test('L-shape: flood-fill stops at the 90° edge', () => {
    const g = lShapeGeometry();
    const { triangles } = coplanarFloodFill(g, 0);
    // Tris 0 and 1 share the +Y normal; tri 2 is perpendicular.
    expect(triangles.sort()).toEqual([0, 1]);
    expect(triangles).not.toContain(2);
  });

  test('cube: flood-fill returns the 2 tris of the seeded face only', () => {
    const g = cubeGeometry();
    // Seed from the top face (tri 0). Flood must NOT cross into any of
    // the other 5 faces even though they share corner vertices.
    const { triangles } = coplanarFloodFill(g, 0);
    expect(triangles.sort()).toEqual([0, 1]);
  });

  test('cube: flood from each face returns exactly that face', () => {
    const g = cubeGeometry();
    for (const seed of [0, 2, 4, 6, 8, 10]) {
      const { triangles } = coplanarFloodFill(g, seed);
      expect(triangles.length).toBe(2);
      // Both returned tris should be within the same 2-tri pair.
      expect(triangles.sort()).toEqual([seed, seed + 1]);
    }
  });

  test('out-of-range seed returns empty', () => {
    const g = flatQuadGeometry();
    expect(coplanarFloodFill(g, -1).triangles).toEqual([]);
    expect(coplanarFloodFill(g, 999).triangles).toEqual([]);
  });

  test('adjacency cache is memoised on the geometry userData', () => {
    const g = flatQuadGeometry();
    coplanarFloodFill(g, 0);
    // After the first flood-fill, the adjacency map should live on the
    // geometry's userData so subsequent hovers skip the rebuild. We
    // assert the cache is present rather than its internals.
    const ud = (g as unknown as { userData: Record<string, unknown> })
      .userData;
    expect(ud['__layFlatAdjacency']).toBeDefined();
  });
});

// -- Controller-level assertions --------------------------------------------
//
// These drive the full lay-flat controller with a fabricated scene + mesh.
// We don't exercise the BVH raycast here (no real Chromium canvas), but
// we DO verify the hover-overlay lifecycle around `enable`/`disable` and
// the viewport DOM-class toggling.

beforeEach(() => {
  document.body.innerHTML = '';
});

function buildScene(): {
  scene: Scene;
  mesh: Mesh;
  canvas: HTMLCanvasElement;
  viewportEl: HTMLDivElement;
  camera: PerspectiveCamera;
  // OrbitControls is unused in the tests below — we only need a handle
  // with the right shape. A plain empty object satisfies the type because
  // `createLayFlatController` only touches `controls.update()` inside the
  // RAF loop, which none of these tests reach.
  controls: { update: () => void; dispose: () => void };
} {
  const scene = new Scene();

  // Minimal scene skeleton — the lay-flat controller looks for a group
  // tagged 'widgets' in the scene.children. Match the production scene
  // factory's output closely enough for the controller to find it.
  const widgets = new Group();
  widgets.userData['tag'] = 'widgets';
  scene.add(widgets);

  const master = new Group();
  master.userData['tag'] = 'master';
  scene.add(master);

  const geom = flatQuadGeometry();
  const mat = new MeshBasicMaterial();
  const mesh = new Mesh(geom, mat);
  mesh.userData['tag'] = 'master-mesh';
  master.add(mesh);

  const viewportEl = document.createElement('div');
  viewportEl.id = 'viewport';
  const canvas = document.createElement('canvas');
  viewportEl.appendChild(canvas);
  document.body.appendChild(viewportEl);

  const camera = new PerspectiveCamera();
  const controls = {
    update: () => {
      /* no-op */
    },
    dispose: () => {
      /* no-op */
    },
  };

  return { scene, mesh, canvas, viewportEl, camera, controls };
}

describe('layFlatController — hover overlay lifecycle', () => {
  test('overlay starts hidden with empty geometry', () => {
    const { scene, mesh, canvas, camera, controls } = buildScene();
    const controller = createLayFlatController({
      scene,
      camera,
       
      controls: controls as any,
      canvas,
      getMasterMesh: () => mesh,
    });

    const overlay = controller.getHoverOverlay();
    expect(overlay.visible).toBe(false);
    // Geometry exists but has zero position entries.
    const pos = overlay.geometry.getAttribute('position');
    expect(pos.count).toBe(0);

    controller.dispose();
  });

  test('enable(): adds `.is-picking` to the viewport element + canvas cursor', () => {
    const { scene, mesh, canvas, viewportEl, camera, controls } = buildScene();
    const controller = createLayFlatController({
      scene,
      camera,
       
      controls: controls as any,
      canvas,
      getMasterMesh: () => mesh,
    });

    expect(viewportEl.classList.contains('is-picking')).toBe(false);
    controller.enable();
    expect(viewportEl.classList.contains('is-picking')).toBe(true);
    expect(canvas.style.cursor).toBe('crosshair');

    controller.dispose();
  });

  test('disable(): removes `.is-picking` and canvas cursor resets', () => {
    const { scene, mesh, canvas, viewportEl, camera, controls } = buildScene();
    const controller = createLayFlatController({
      scene,
      camera,
       
      controls: controls as any,
      canvas,
      getMasterMesh: () => mesh,
    });

    controller.enable();
    expect(viewportEl.classList.contains('is-picking')).toBe(true);

    controller.disable();
    expect(viewportEl.classList.contains('is-picking')).toBe(false);
    expect(canvas.style.cursor).toBe('');

    controller.dispose();
  });

  test('enable() is a no-op when no master is loaded → overlay stays hidden', () => {
    const { scene, canvas, camera, controls } = buildScene();
    const controller = createLayFlatController({
      scene,
      camera,
       
      controls: controls as any,
      canvas,
      getMasterMesh: () => null,
    });

    controller.enable();
    expect(controller.isActive()).toBe(false);
    expect(controller.getHoverOverlay().visible).toBe(false);

    controller.dispose();
  });

  test('dispose() disposes overlay geometry + material (no GPU leak)', () => {
    const { scene, mesh, canvas, camera, controls } = buildScene();
    const controller = createLayFlatController({
      scene,
      camera,
       
      controls: controls as any,
      canvas,
      getMasterMesh: () => mesh,
    });

    const overlay = controller.getHoverOverlay();
    const geom = overlay.geometry;
    const mat = overlay.material as MeshBasicMaterial;

    let geomDisposed = false;
    let matDisposed = false;
    const origGeomDispose = geom.dispose.bind(geom);
    geom.dispose = () => {
      geomDisposed = true;
      origGeomDispose();
    };
    const origMatDispose = mat.dispose.bind(mat);
    mat.dispose = () => {
      matDisposed = true;
      origMatDispose();
    };

    controller.dispose();
    expect(geomDisposed).toBe(true);
    expect(matDisposed).toBe(true);
  });

  test('widget group is attached under the scene `widgets` group', () => {
    const { scene, mesh, canvas, camera, controls } = buildScene();
    const controller = createLayFlatController({
      scene,
      camera,
       
      controls: controls as any,
      canvas,
      getMasterMesh: () => mesh,
    });

    const widgetsGroup = scene.children.find(
      (c) => c.userData['tag'] === 'widgets',
    ) as Group;
    expect(widgetsGroup).toBeDefined();
    const layFlatWidgets = widgetsGroup.children.find(
      (c) => c.userData['tag'] === LAY_FLAT_WIDGETS_TAG,
    );
    expect(layFlatWidgets).toBeDefined();

    // Hover overlay is a child of the lay-flat widgets group.
    const overlay = controller.getHoverOverlay();
    expect(overlay.parent).toBe(layFlatWidgets);

    controller.dispose();
    // After dispose, the widgets group is detached from its parent.
    expect(layFlatWidgets?.parent).toBeNull();
  });
});
