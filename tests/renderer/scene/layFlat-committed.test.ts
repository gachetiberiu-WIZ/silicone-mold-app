// tests/renderer/scene/layFlat-committed.test.ts
//
// @vitest-environment happy-dom
//
// Pins the `LAY_FLAT_COMMITTED_EVENT` contract (issue #36). This event is
// the signal the Generate-mold button (`src/renderer/ui/generateButton.ts`)
// subscribes to for its enable/disable state. The contract:
//
//   - Fires with `{ detail: true }` after a successful `commit(pick, mesh)`.
//   - Fires with `{ detail: false }` after `reset()` IF it was previously true.
//   - Fires with `{ detail: false }` after `notifyMasterReset()` IF it was true.
//   - Does NOT fire on transitions that don't change the flag (e.g. calling
//     `reset()` on a non-committed controller, or `notifyMasterReset()` on
//     a pristine one).
//
// The commit path is the tricky one: `layFlatController.commit` is not
// exported, so we drive the full pipeline — `enable()` → synthetic click
// over a face in the canvas — just like the E2E spec does, but in a
// happy-dom + real Three.js + real three-mesh-bvh stack. No WebGL context
// is required because the controller's raycast path goes through the
// BVH, which is CPU-only.
//
// happy-dom caveat: `HTMLCanvasElement.getBoundingClientRect()` in happy-dom
// returns a zero-size rect by default, which `pickFaceUnderPointer` correctly
// rejects. We monkey-patch `getBoundingClientRect` on the canvas instance so
// the test has a meaningful viewport.

import {
  BoxGeometry,
  Mesh,
  MeshBasicMaterial,
  Group,
  PerspectiveCamera,
  Scene,
  Vector3,
} from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  createLayFlatController,
  LAY_FLAT_COMMITTED_EVENT,
  type LayFlatController,
} from '@/renderer/scene/layFlatController';
import { prepareMeshForPicking } from '@/renderer/scene/picking';

/**
 * Build the minimal scene + controller harness. We can't use the real
 * `createScene()` because it constructs WebGL-specific gizmos whose
 * materials reference patterns happy-dom can't evaluate; but the
 * controller itself only needs a `Scene` with a `widgets` Group to
 * attach hover overlays to, plus camera/controls/canvas/getMasterMesh.
 */
function buildHarness(): {
  scene: Scene;
  camera: PerspectiveCamera;
  controls: OrbitControls;
  canvas: HTMLCanvasElement;
  group: Group;
  mesh: Mesh;
  controller: LayFlatController;
  dispose: () => void;
} {
  const scene = new Scene();

  // Widgets group — `createLayFlatController` looks for a child with
  // `userData.tag === 'widgets'`. Without it the controller silently
  // attaches widgets to the scene root; the behaviour under test doesn't
  // care, but we include it for parity with production scene-build order.
  const widgets = new Group();
  widgets.userData['tag'] = 'widgets';
  scene.add(widgets);

  // Master group + mesh. A 2×2×2 box centered on origin, BVH-prepared for
  // picking. Large enough that a ray from the top of the scene hits it
  // reliably at any canvas-centre click.
  const group = new Group();
  group.userData['tag'] = 'master';
  scene.add(group);
  const geom = new BoxGeometry(2, 2, 2);
  const mesh = new Mesh(geom, new MeshBasicMaterial());
  group.add(mesh);
  prepareMeshForPicking(mesh);

  // Camera positioned directly above the box looking down. A click at the
  // canvas centre is a ray straight down, hitting the top (+Y) face.
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 10, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();

  // Minimal controls stub — the controller's commit/reset path calls
  // `frameToBox3(camera, controls, box)`, which expects `controls.target`
  // to be a Three `Vector3` (so it can `.copy(center)`) plus an `update()`.
  // A real `OrbitControls` is overkill; we give it a real Vector3 target
  // and a no-op update. Nothing in this test asserts on the camera state.
  const controls = {
    target: new Vector3(),
    update() {},
  } as unknown as OrbitControls;

  // Canvas — happy-dom provides HTMLCanvasElement but `getBoundingClientRect`
  // returns zeros. Override to give the viewport a 200×200 footprint so
  // `pickFaceUnderPointer` has non-degenerate NDC math.
  const canvas = document.createElement('canvas');
  canvas.width = 200;
  canvas.height = 200;
  document.body.appendChild(canvas);
  Object.defineProperty(canvas, 'getBoundingClientRect', {
    value: () => ({
      left: 0,
      top: 0,
      right: 200,
      bottom: 200,
      width: 200,
      height: 200,
      x: 0,
      y: 0,
      toJSON() {
        return {};
      },
    }),
  });

  const controller = createLayFlatController({
    scene,
    camera,
    controls,
    canvas,
    getMasterMesh: () => mesh,
  });

  return {
    scene,
    camera,
    controls,
    canvas,
    group,
    mesh,
    controller,
    dispose: () => {
      controller.dispose();
      canvas.remove();
    },
  };
}

/**
 * Capture every `LAY_FLAT_COMMITTED_EVENT` dispatched on `document`
 * during the callback. Returns an array of the `detail` booleans.
 */
function captureCommittedDetails(
  run: () => void,
): boolean[] {
  const details: boolean[] = [];
  const handler = (ev: Event): void => {
    details.push((ev as CustomEvent<boolean>).detail);
  };
  document.addEventListener(LAY_FLAT_COMMITTED_EVENT, handler);
  try {
    run();
  } finally {
    document.removeEventListener(LAY_FLAT_COMMITTED_EVENT, handler);
  }
  return details;
}

let harness: ReturnType<typeof buildHarness> | null = null;

beforeEach(() => {
  harness = buildHarness();
});
afterEach(() => {
  harness?.dispose();
  harness = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('LAY_FLAT_COMMITTED_EVENT — initial + idempotent state', () => {
  test('isCommitted() returns false on a fresh controller (before any commit)', () => {
    const { controller } = harness!;
    expect(controller.isCommitted()).toBe(false);
  });

  test('reset() on a non-committed controller does NOT fire the event', () => {
    const { controller } = harness!;
    const details = captureCommittedDetails(() => {
      controller.reset();
    });
    expect(details).toEqual([]);
    expect(controller.isCommitted()).toBe(false);
  });

  test('notifyMasterReset() on a pristine controller does NOT fire the event', () => {
    const { controller } = harness!;
    const details = captureCommittedDetails(() => {
      controller.notifyMasterReset();
    });
    expect(details).toEqual([]);
    expect(controller.isCommitted()).toBe(false);
  });
});

describe('LAY_FLAT_COMMITTED_EVENT — commit path', () => {
  /**
   * Drive a commit through the public API: enable picking mode, dispatch a
   * click at the canvas centre. The camera is positioned straight above the
   * box (set up in `buildHarness`) so a centred ray hits the +Y face, which
   * the controller's commit logic picks + rotates onto the bed.
   */
  function drivePickAndCommit(): void {
    const { controller, canvas } = harness!;
    controller.enable();
    const click = new Event('click', { bubbles: true });
    // PointerEvent constructor isn't fully implemented in happy-dom; the
    // controller only reads `.clientX`/`.clientY`/`.button`, so assign
    // them directly onto the Event.
    Object.assign(click, { clientX: 100, clientY: 100, button: 0 });
    canvas.dispatchEvent(click);
  }

  test('commit fires the event with detail=true', () => {
    const { controller } = harness!;
    const details = captureCommittedDetails(() => {
      drivePickAndCommit();
    });
    expect(details).toContain(true);
    expect(details[details.length - 1]).toBe(true);
    expect(controller.isCommitted()).toBe(true);
  });

  test('a second commit does NOT re-fire the event (committed is idempotent)', () => {
    const { controller } = harness!;
    drivePickAndCommit();
    expect(controller.isCommitted()).toBe(true);

    const details = captureCommittedDetails(() => {
      drivePickAndCommit();
    });
    // `commit()` only emits when the flag TRANSITIONS false→true. A second
    // commit (already true) is silent on this event.
    expect(details).toEqual([]);
    expect(controller.isCommitted()).toBe(true);
  });
});

describe('LAY_FLAT_COMMITTED_EVENT — reset path', () => {
  test('reset() after a commit fires the event with detail=false', () => {
    const { controller } = harness!;
    // Drive the initial commit first (outside the capture so it doesn't
    // pollute the assertion).
    controller.enable();
    const click = new Event('click');
    Object.assign(click, { clientX: 100, clientY: 100, button: 0 });
    harness!.canvas.dispatchEvent(click);
    expect(controller.isCommitted()).toBe(true);

    const details = captureCommittedDetails(() => {
      controller.reset();
    });
    expect(details).toEqual([false]);
    expect(controller.isCommitted()).toBe(false);
  });
});

describe('LAY_FLAT_COMMITTED_EVENT — notifyMasterReset path', () => {
  test('notifyMasterReset after a commit fires the event with detail=false', () => {
    const { controller } = harness!;
    controller.enable();
    const click = new Event('click');
    Object.assign(click, { clientX: 100, clientY: 100, button: 0 });
    harness!.canvas.dispatchEvent(click);
    expect(controller.isCommitted()).toBe(true);

    const details = captureCommittedDetails(() => {
      controller.notifyMasterReset();
    });
    expect(details).toEqual([false]);
    expect(controller.isCommitted()).toBe(false);
  });

  test('notifyMasterReset after another notifyMasterReset is silent (already false)', () => {
    const { controller } = harness!;
    // Commit → clear → clear again.
    controller.enable();
    const click = new Event('click');
    Object.assign(click, { clientX: 100, clientY: 100, button: 0 });
    harness!.canvas.dispatchEvent(click);
    controller.notifyMasterReset();
    expect(controller.isCommitted()).toBe(false);

    const details = captureCommittedDetails(() => {
      controller.notifyMasterReset();
    });
    expect(details).toEqual([]);
  });
});
