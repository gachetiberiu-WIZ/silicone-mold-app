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
  // `enable()` also wires an `addEventListener('change', …)` handler for
  // hover-cache invalidation on orbit (issue #80 dogfood) so we implement
  // a trivial on/off subscription too — nothing in this test asserts on
  // its firing, but enable() needs it callable.
  const controls = {
    target: new Vector3(),
    update() {},
    addEventListener() {},
    removeEventListener() {},
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
   * pointerdown + pointerup pair at the canvas centre. The camera is
   * positioned straight above the box (set up in `buildHarness`) so a
   * centred ray hits the +Y face, which the controller's commit logic
   * picks + rotates onto the bed.
   *
   * The controller now uses `pointerdown`/`pointerup` instead of `click`
   * (issue #80 dogfood — Chromium drops `click` after ~5 px of pointer
   * travel, which was silently losing commits on hand-tremor). A zero-
   * travel pointerdown→pointerup pair is always within the drag
   * threshold (10 px post-#94) so it always commits.
   */
  function drivePickAndCommit(): void {
    const { controller, canvas } = harness!;
    controller.enable();
    const down = new Event('pointerdown', { bubbles: true });
    Object.assign(down, { clientX: 100, clientY: 100, button: 0 });
    canvas.dispatchEvent(down);
    // Dispatch pointerup on the canvas so it bubbles up to our window-scoped
    // listener. `ev.target` resolves to the canvas on the bubble path, which
    // is what the controller's "up landed on canvas" guard checks for.
    const up = new Event('pointerup', { bubbles: true });
    Object.assign(up, { clientX: 100, clientY: 100, button: 0 });
    canvas.dispatchEvent(up);
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

/**
 * Dispatch a stationary pointerdown → pointerup pair at the canvas centre,
 * mirroring the commit flow the production controller now listens for
 * (issue #80 dogfood — click was replaced with pointerdown/pointerup +
 * drag-threshold gate).
 */
function pointerDownUp(canvas: HTMLCanvasElement): void {
  const down = new Event('pointerdown', { bubbles: true });
  Object.assign(down, { clientX: 100, clientY: 100, button: 0 });
  canvas.dispatchEvent(down);
  const up = new Event('pointerup', { bubbles: true });
  Object.assign(up, { clientX: 100, clientY: 100, button: 0 });
  canvas.dispatchEvent(up);
}

describe('LAY_FLAT_COMMITTED_EVENT — reset path', () => {
  test('reset() after a commit fires the event with detail=false', () => {
    const { controller } = harness!;
    // Drive the initial commit first (outside the capture so it doesn't
    // pollute the assertion).
    controller.enable();
    pointerDownUp(harness!.canvas);
    expect(controller.isCommitted()).toBe(true);

    const details = captureCommittedDetails(() => {
      controller.reset();
    });
    expect(details).toEqual([false]);
    expect(controller.isCommitted()).toBe(false);
  });
});

describe('LAY_FLAT_COMMITTED_EVENT — click-vs-drag gate (issue #80 dogfood)', () => {
  /**
   * These tests pin the new pointerdown/pointerup commit semantics that
   * replaced the old `click` listener. The controller used to listen for
   * `click`, which Chromium suppresses whenever the pointer moves more
   * than ~5 CSS px between down and up — any hand-tremor during a click
   * silently dropped the commit. We now listen for pointerdown + pointerup
   * ourselves and gate the commit on a 15 px travel threshold (widened
   * from 10 px after repeat high-DPI + precision-pad regressions), so we
   * own the click-vs-drag decision instead of relying on Chromium's
   * heuristic.
   */
  function dispatchDown(canvas: HTMLCanvasElement, x: number, y: number): void {
    const ev = new Event('pointerdown', { bubbles: true });
    Object.assign(ev, { clientX: x, clientY: y, button: 0 });
    canvas.dispatchEvent(ev);
  }
  function dispatchUp(
    target: EventTarget,
    x: number,
    y: number,
    button = 0,
  ): void {
    const ev = new Event('pointerup', { bubbles: true });
    Object.assign(ev, { clientX: x, clientY: y, button });
    target.dispatchEvent(ev);
  }

  test('zero-travel pointerdown → pointerup commits the face', () => {
    const { controller, canvas } = harness!;
    controller.enable();
    dispatchDown(canvas, 100, 100);
    dispatchUp(canvas, 100, 100);
    expect(controller.isCommitted()).toBe(true);
  });

  test('small (<15 px) travel still commits — matches Chromium click behaviour', () => {
    const { controller, canvas } = harness!;
    controller.enable();
    dispatchDown(canvas, 100, 100);
    // 3 px diagonal travel — hypot(3, 0) = 3, well under the 15 px threshold.
    dispatchUp(canvas, 103, 100);
    expect(controller.isCommitted()).toBe(true);
  });

  test('travel > 15 px (drag) does NOT commit', () => {
    const { controller, canvas } = harness!;
    controller.enable();
    dispatchDown(canvas, 100, 100);
    // 25 px horizontal travel — clearly past the 15 px gate.
    dispatchUp(canvas, 125, 100);
    expect(controller.isCommitted()).toBe(false);
    // Controller stays in picking mode on a drag (only commits auto-exit).
    expect(controller.isActive()).toBe(true);
  });

  test('non-primary pointerdown (right button) does not arm the gate', () => {
    const { controller, canvas } = harness!;
    controller.enable();
    // Right-button down → should NOT arm. A subsequent left pointerup with
    // zero travel would therefore be a no-op.
    const down = new Event('pointerdown', { bubbles: true });
    Object.assign(down, { clientX: 100, clientY: 100, button: 2 });
    canvas.dispatchEvent(down);
    dispatchUp(canvas, 100, 100, 0);
    expect(controller.isCommitted()).toBe(false);
  });

  test('pointerdown off-canvas is ignored', () => {
    const { controller, canvas } = harness!;
    controller.enable();
    // Fabricate a pointerdown that never reaches the canvas's listener
    // by dispatching on body (bubble phase goes child→parent, so body →
    // html → document → window; the canvas's own listener is never
    // invoked). `downArmed` therefore stays false and the subsequent
    // pointerup hits the `!downArmed` short-circuit.
    const down = new Event('pointerdown', { bubbles: true });
    Object.assign(down, { clientX: 100, clientY: 100, button: 0 });
    document.body.dispatchEvent(down);
    dispatchUp(canvas, 100, 100);
    expect(controller.isCommitted()).toBe(false);
  });

  test('native click event commits independently of pointerup gate', () => {
    // The controller attaches a `click` listener as a second commit path.
    // This test dispatches ONLY a `click` event (no pointer* events) and
    // asserts it commits — so the path is independent of the pointerdown/
    // up state machine. Rationale: a Chromium / Electron / pointer-capture
    // combination can silently drop our pointerup handler; the click
    // event is a belt-and-braces second route.
    const { controller, canvas } = harness!;
    controller.enable();
    const click = new Event('click', { bubbles: true });
    Object.assign(click, { clientX: 100, clientY: 100, button: 0 });
    canvas.dispatchEvent(click);
    expect(controller.isCommitted()).toBe(true);
  });
});

describe('LAY_FLAT_COMMITTED_EVENT — notifyMasterReset path', () => {
  test('notifyMasterReset after a commit fires the event with detail=false', () => {
    const { controller } = harness!;
    controller.enable();
    pointerDownUp(harness!.canvas);
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
    pointerDownUp(harness!.canvas);
    controller.notifyMasterReset();
    expect(controller.isCommitted()).toBe(false);

    const details = captureCommittedDetails(() => {
      controller.notifyMasterReset();
    });
    expect(details).toEqual([]);
  });
});
