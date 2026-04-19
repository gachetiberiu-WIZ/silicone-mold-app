// tests/visual/scene-rotated-mini-figurine.spec.ts
//
// Visual regression: mini-figurine loaded as master, rotated by a
// known quaternion, recentered, and re-framed. Snapshots the
// post-rotation scene.
//
// This golden is advisory for the first 2 weeks per ADR-003 §B (visual
// regression gating policy). The test is pinned to a synthetic rotation
// (not a live BVH-driven pick) so the output is deterministic across
// SwiftShader runs — live picking hits floating-point raycast drift
// which makes the pick coordinate non-deterministic at sub-millimetre
// scales.
//
// We reach the Master group through `window.__testHooks.scene` (exposed
// by `viewport.ts` under BUILD_TIME_TEST) and mutate its quaternion
// directly. The post-rotation auto-center + camera re-frame is driven
// by the existing `viewport.setMaster` → `frameToBox3` pipeline; for
// the rotation-compose specifically we reuse the master group's own
// `Quaternion` instance (reading Three.js types off the scene graph
// instead of importing the module inside the page — bare-specifier
// imports like `import 'three'` inside `page.evaluate` do not resolve
// in Chromium's page context and would hard-fail this spec).

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

    // Load the master via the public test-hook API (same path as
    // `scene-with-mini-figurine.spec.ts`).
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

    // Apply a synthetic lay-flat: 90° rotation around +X. We reach the
    // Master group by scanning `scene.children` for the `userData.tag`
    // marker (set by `createScene()` / honoured by `setMaster`).
    //
    // The key trick: to avoid `import 'three'` (bare specifiers don't
    // resolve in Chromium's page context), we read Three.js types off
    // the scene graph itself. `group.quaternion` is a Three `Quaternion`
    // instance — `.constructor` gets us the class so we can allocate
    // a fresh rotation without importing the module. Likewise for
    // `Vector3` via `camera.position.constructor`.
    await page.evaluate(() => {
      type QuaternionLike = {
        setFromAxisAngle: (axis: unknown, angle: number) => unknown;
      };
      type QuaternionCtor = new () => QuaternionLike;
      type Vec3Like = { x: number; y: number; z: number };
      type Vec3Ctor = new (x?: number, y?: number, z?: number) => Vec3Like;
      type GroupLike = {
        userData?: Record<string, unknown>;
        quaternion: {
          constructor: QuaternionCtor;
          copy: (q: unknown) => unknown;
          setFromAxisAngle: (axis: unknown, angle: number) => unknown;
        };
        position: {
          constructor: Vec3Ctor;
          set: (x: number, y: number, z: number) => void;
        };
        updateMatrixWorld: (force: boolean) => void;
      };
      type MeshLike = {
        userData?: Record<string, unknown>;
        type?: string;
        geometry: {
          getAttribute: (
            n: string,
          ) => { count: number; array: ArrayLike<number> };
        };
        matrixWorld: { elements: ArrayLike<number> };
        updateWorldMatrix: (parents: boolean, children: boolean) => void;
      };
      type ControlsLike = {
        target: { set: (x: number, y: number, z: number) => void };
        update: () => void;
      };
      type CameraLike = {
        position: {
          set: (x: number, y: number, z: number) => void;
        };
        up: { set: (x: number, y: number, z: number) => void };
        lookAt: (x: number, y: number, z: number) => void;
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
      const foundMesh = mesh as MeshLike;

      // Pull the Three constructors off existing scene-graph instances so we
      // don't have to import the module inside the page (bare specifiers
      // don't resolve in the browser).
      const QuatCtor = group.quaternion.constructor;
      const Vec3Ctor = group.position.constructor;

      const xAxis = new Vec3Ctor(1, 0, 0);
      const q = new QuatCtor();
      q.setFromAxisAngle(xAxis, Math.PI / 2);
      group.quaternion.copy(q);

      // Zero the position, update world, compute tight world bbox by
      // walking the mesh's vertex buffer, then re-center so min.y = 0 and
      // xz-center = 0. Tight vertex walk (not the conservative corner
      // transform of `Box3.setFromObject`) matches the runtime lay-flat
      // recenter path.
      group.position.set(0, 0, 0);
      group.updateMatrixWorld(true);
      foundMesh.updateWorldMatrix(true, false);

      const e = foundMesh.matrixWorld.elements;
      const attr = foundMesh.geometry.getAttribute('position');
      const arr = attr.array;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let i = 0; i < attr.count; i++) {
        const lx = arr[i * 3]!;
        const ly = arr[i * 3 + 1]!;
        const lz = arr[i * 3 + 2]!;
        const wx = e[0]! * lx + e[4]! * ly + e[8]! * lz + e[12]!;
        const wy = e[1]! * lx + e[5]! * ly + e[9]! * lz + e[13]!;
        const wz = e[2]! * lx + e[6]! * ly + e[10]! * lz + e[14]!;
        if (wx < minX) minX = wx;
        if (wx > maxX) maxX = wx;
        if (wy < minY) minY = wy;
        if (wy > maxY) maxY = wy;
        if (wz < minZ) minZ = wz;
        if (wz > maxZ) maxZ = wz;
      }
      const cx = (minX + maxX) / 2;
      const cz = (minZ + maxZ) / 2;
      group.position.set(-cx, -minY, -cz);
      group.updateMatrixWorld(true);
      foundMesh.updateWorldMatrix(true, false);

      // Re-frame the camera to the post-recenter world AABB. We recompute
      // the bbox after the translation so the numbers are accurate.
      const e2 = foundMesh.matrixWorld.elements;
      minX = Infinity;
      maxX = -Infinity;
      minY = Infinity;
      maxY = -Infinity;
      minZ = Infinity;
      maxZ = -Infinity;
      for (let i = 0; i < attr.count; i++) {
        const lx = arr[i * 3]!;
        const ly = arr[i * 3 + 1]!;
        const lz = arr[i * 3 + 2]!;
        const wx = e2[0]! * lx + e2[4]! * ly + e2[8]! * lz + e2[12]!;
        const wy = e2[1]! * lx + e2[5]! * ly + e2[9]! * lz + e2[13]!;
        const wz = e2[2]! * lx + e2[6]! * ly + e2[10]! * lz + e2[14]!;
        if (wx < minX) minX = wx;
        if (wx > maxX) maxX = wx;
        if (wy < minY) minY = wy;
        if (wy > maxY) maxY = wy;
        if (wz < minZ) minZ = wz;
        if (wz > maxZ) maxZ = wz;
      }
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      const centerZ = (minZ + maxZ) / 2;
      const sizeX = maxX - minX;
      const sizeY = maxY - minY;
      const sizeZ = maxZ - minZ;
      const maxDim = Math.max(sizeX, sizeY, sizeZ, 1e-3);
      const fovRad = (45 * Math.PI) / 180;
      const distance = (maxDim / 2 / Math.tan(fovRad / 2)) * 1.4;
      // Normalised (1,1,1) direction. √3 ≈ 1.7320508.
      const invSqrt3 = 1 / Math.sqrt(3);
      vp.camera.position.set(
        centerX + distance * invSqrt3,
        centerY + distance * invSqrt3,
        centerZ + distance * invSqrt3,
      );
      vp.camera.up.set(0, 1, 0);
      vp.camera.lookAt(centerX, centerY, centerZ);
      vp.camera.updateProjectionMatrix();
      vp.camera.updateMatrixWorld();
      vp.controls.target.set(centerX, centerY, centerZ);
      vp.controls.update();
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
