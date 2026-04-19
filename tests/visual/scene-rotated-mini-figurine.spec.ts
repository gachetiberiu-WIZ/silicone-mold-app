// tests/visual/scene-rotated-mini-figurine.spec.ts
//
// Visual regression: mini-figurine loaded as master, rotated by a
// known quaternion via the viewport test-hook, and re-centered via
// `resetOrientation`-inverse semantics (we don't call `reset` — we
// apply a rotation and a recenter). Snapshots the post-rotation
// scene.
//
// This golden is advisory for the first 2 weeks per ADR-003 §B (visual
// regression gating policy). The test is pinned to a synthetic rotation
// (not a live BVH-driven pick) so the output is deterministic across
// SwiftShader runs — live picking hits floating-point raycast drift
// which makes the pick coordinate non-deterministic at sub-millimetre
// scales.

import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RENDERER_URL = 'http://localhost:5174/?test=1';
const FIXTURE_PATH = resolve(
  __dirname,
  '..',
  'fixtures',
  'meshes',
  'mini-figurine.stl',
);

test.describe('visual — scene with rotated master (lay-flat)', () => {
  test('renders mini-figurine after a synthetic 90°X rotation + recenter', async ({
    page,
  }) => {
    await page.clock.install({ time: new Date('2026-04-18T00:00:00Z') });

    await page.addInitScript(() => {
      (window as unknown as { api: Record<string, unknown> }).api = {
        getVersion: () => Promise.resolve('0.0.0'),
        openStl: () => Promise.resolve({ canceled: true }),
        saveStl: () => Promise.resolve({ canceled: true }),
      };
    });

    await page.goto(RENDERER_URL);

    await page.waitForFunction(
      () => {
        const hooks = (
          window as unknown as {
            __testHooks?: { viewportReady?: boolean };
          }
        ).__testHooks;
        if (hooks?.viewportReady) return true;
        const container = document.getElementById('viewport');
        return !!container?.querySelector('canvas');
      },
      undefined,
      { timeout: 10_000 },
    );

    const fixtureBytes = readFileSync(FIXTURE_PATH);
    const byteArray = Array.from(fixtureBytes);

    // Load the master.
    await page.evaluate(async (bytes: number[]) => {
      const u8 = new Uint8Array(bytes);
      const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      const hooks = (
        window as unknown as {
          __testHooks?: {
            viewport?: { setMaster: (buf: ArrayBuffer) => Promise<unknown> };
          };
        }
      ).__testHooks;
      if (!hooks?.viewport) {
        throw new Error('viewport test hook missing');
      }
      await hooks.viewport.setMaster(ab);
    }, byteArray);

    // Apply a synthetic lay-flat: rotate the master group 90° around +X
    // via a pure Quaternion (avoids live-pick nondeterminism) and call
    // the viewport's resetOrientation-adjacent path. Actually, the
    // cleanest + deterministic sequence is:
    //   1. Set group.quaternion to a fixed rotation.
    //   2. Re-apply auto-center (we can call recenterGroup indirectly by
    //      triggering a re-frame via the viewport's camera helper, but the
    //      viewport doesn't expose that — instead, we read the internals
    //      through the test-hook scene reference and do it manually).
    //
    // We keep this minimal: rotate + recenter + re-frame the camera at
    // the new world AABB.
    await page.evaluate(() => {
      type ThreeNS = {
        Quaternion: new () => { setFromAxisAngle: (axis: unknown, angle: number) => void };
        Vector3: new (x?: number, y?: number, z?: number) => unknown;
        Box3: new () => { setFromObject: (o: unknown) => { min: { y: number }; getCenter: (out: unknown) => unknown } };
      };
      type GroupLike = {
        userData?: Record<string, unknown>;
        quaternion: {
          copy: (q: unknown) => void;
          setFromAxisAngle: (axis: unknown, angle: number) => void;
        };
        position: { set: (x: number, y: number, z: number) => void };
        updateMatrixWorld: (force: boolean) => void;
        children: Array<{ updateMatrixWorld: (f: boolean) => void }>;
      };
      type MeshLike = {
        userData?: Record<string, unknown>;
        type?: string;
        updateMatrixWorld: (f: boolean) => void;
      };
      type ControlsLike = { target: { copy: (v: unknown) => void }; update: () => void };
      type CameraLike = {
        position: { copy: (v: unknown) => void; addScaledVector: (v: unknown, s: number) => void };
        lookAt: (x: unknown, y?: number, z?: number) => void;
        up: { set: (x: number, y: number, z: number) => void };
        updateProjectionMatrix: () => void;
        updateMatrixWorld: () => void;
      };
      type ViewportHooks = {
        scene?: {
          traverse: (cb: (o: MeshLike) => void) => void;
          children: GroupLike[];
        };
        viewport?: { controls: ControlsLike; camera: CameraLike };
      };

      const hooks = (window as unknown as { __testHooks?: ViewportHooks })
        .__testHooks;
      const scene = hooks?.scene;
      const vp = hooks?.viewport;
      if (!scene || !vp) throw new Error('hooks missing');

      // Find the master group + mesh.
      const group = scene.children.find(
        (c) => c.userData?.['tag'] === 'master',
      );
      if (!group) throw new Error('master group missing');
      let mesh: MeshLike | null = null;
      scene.traverse((o) => {
        if (o.userData?.['tag'] === 'master' && o.type === 'Mesh') mesh = o;
      });
      if (!mesh) throw new Error('master mesh missing');

      // Dynamically grab the module's Three constructors via a small probe:
      // every loaded mesh carries `.geometry` which in turn has a
      // `.constructor` that is Three's `BufferGeometry`. Walk back to
      // `BufferGeometry.prototype.constructor` to find the nearest module
      // reference. That's brittle — simpler to import via dynamic import.
      return import('three').then((THREE) => {
        const T = THREE as unknown as ThreeNS;
        const q = new T.Quaternion();
        q.setFromAxisAngle(new T.Vector3(1, 0, 0), Math.PI / 2);
        group.quaternion.copy(q);
        // Zero the position, update world, read bbox, re-center so min.y = 0.
        group.position.set(0, 0, 0);
        group.updateMatrixWorld(true);

        const box = new T.Box3().setFromObject(mesh as unknown as object);
        const center = new T.Vector3();
        (box as unknown as { getCenter: (out: unknown) => unknown }).getCenter(
          center,
        );
        const cx = (center as unknown as { x: number; y: number; z: number }).x;
        const cz = (center as unknown as { x: number; y: number; z: number }).z;
        const minY = box.min.y;
        group.position.set(-cx, -minY, -cz);
        group.updateMatrixWorld(true);

        // Re-frame the camera to the new world AABB.
        const box2 = new T.Box3().setFromObject(mesh as unknown as object);
        const center2 = new T.Vector3();
        (box2 as unknown as { getCenter: (out: unknown) => unknown }).getCenter(
          center2,
        );
        const size = new T.Vector3();
        (box2 as unknown as { getSize: (out: unknown) => unknown }).getSize(
          size,
        );
        const s = size as unknown as { x: number; y: number; z: number };
        const maxDim = Math.max(s.x, s.y, s.z, 1e-3);
        const fovRad = (45 * Math.PI) / 180;
        const distance = (maxDim / 2 / Math.tan(fovRad / 2)) * 1.4;
        const dir = new T.Vector3(1, 1, 1);
        (dir as unknown as { normalize: () => unknown }).normalize();
        vp.camera.position.copy(center2);
        vp.camera.position.addScaledVector(dir, distance);
        vp.camera.up.set(0, 1, 0);
        vp.camera.lookAt(center2);
        vp.camera.updateProjectionMatrix();
        vp.camera.updateMatrixWorld();
        vp.controls.target.copy(center2);
        vp.controls.update();
      });
    });

    await page.clock.runFor(100);

    await expect(page).toHaveScreenshot('scene-rotated-mini-figurine.png', {
      maxDiffPixelRatio: 0.01,
      threshold: 0.15,
      animations: 'disabled',
      fullPage: false,
    });
  });
});
