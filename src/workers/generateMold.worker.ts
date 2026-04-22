// src/workers/generateMold.worker.ts
//
// Dedicated web worker that runs the `generateSiliconeShell` pipeline off
// the renderer's main thread (issue #77). Pre-#77, a Generate run held the
// main thread for 5-10 s on a small master and 20-35 s on a large one —
// the UI froze, users couldn't rotate the viewport, and the cancel path
// amounted to "wait for it to finish, then ignore the result". This
// worker moves the entire pipeline (SDF build + two `Manifold.levelSet`
// passes + boolean carve + radial slice + brims + base slab) behind a
// `postMessage` boundary so the renderer stays responsive.
//
// Contract (see `src/renderer/worker/generateMoldRunner.ts` for the host
// side):
//
//   IN  (`GenerateMoldRequest`):
//     - masterPosition: Float32Array — master's BufferGeometry.position
//       (non-indexed triangle soup; 9 floats per triangle).
//     - masterIndex:    Uint32Array  — optional index buffer; when
//       provided, `masterPosition` is the de-duplicated vertex pool.
//       A zero-length Uint32Array means "non-indexed triangle soup".
//     - viewTransform:  number[16]   — column-major Matrix4 elements
//       (WebGL convention; `three.Matrix4.elements` passes through
//       verbatim, same as in `generateMold.ts::threeMatrixToManifoldMat4`).
//     - parameters:     MoldParameters — current mold parameters.
//
//   OUT (`GenerateMoldResponse`):
//     One or more `{type:'phase', key}` messages fired as the pipeline
//     walks silicone → shell → slicing → brims → slab. Then exactly ONE
//     terminal message:
//       - `{ok:true, silicone, shellPieces[], basePart, siliconeVolume_mm3,
//          resinVolume_mm3, shellPiecesVolume_mm3[], totalShellVolume_mm3,
//          baseSlabVolume_mm3, phaseTimings}` on success. Each mesh
//       payload is `{positions: Float32Array, indices: Uint32Array}` —
//       positions are the vertex properties (3 floats per vertex),
//       indices reference them (3 per triangle). All Float32/Uint32
//       buffers are transferable and the worker posts them with a
//       transfer list so they're moved (zero-copy) to the renderer.
//     - `{ok:false, error, stack?}` on any thrown error.
//
// Manifold lifecycle inside this worker:
//
//   - The master Manifold is built via `new toplevel.Manifold(mesh)` from
//     the incoming positions/indices. Disposed BEFORE the final post.
//   - `generateSiliconeShell` returns fresh Manifolds (silicone, N shell
//     pieces, basePart). The worker serializes each via the mesh adapter,
//     then `.delete()`s ALL of them before posting the response — no
//     Manifold handles cross the worker boundary. Matches the ownership
//     comment block in `generateMold.ts::MoldGenerationResult`.
//
// WASM loading:
//
//   Relies on Vite's `{type:'module'}` Worker loader, which lets
//   `manifold-3d`'s Emscripten ESM glue resolve its sibling .wasm asset
//   via the bundled `new URL(..., import.meta.url)` plumbing. No special
//   handling needed here beyond calling `initManifold()` — the
//   module-scope memoisation in `src/geometry/initManifold.ts` means the
//   worker's first Generate pays the ~200-500 ms WASM init once, every
//   subsequent Generate (same worker) is warm.
//
// Error handling:
//
//   Any throw — from `initManifold`, master ingest, `generateSiliconeShell`,
//   or the mesh serialisation — is caught and posted as an
//   `{ok:false, error, stack}` message. The worker does NOT re-throw
//   (that would trigger the `error` event handler on the renderer side
//   with no context about the request).

/// <reference lib="webworker" />

import type { MoldParameters } from '@/renderer/state/parameters';
import { initManifold } from '@/geometry/initManifold';
import { generateSiliconeShell } from '@/geometry/generateMold';
import type { Manifold } from 'manifold-3d';
import { Matrix4 } from 'three';

/**
 * Serialised mesh payload — what the worker produces for each Manifold
 * and what the renderer re-ingests (or renders directly). `positions` is
 * the flat vertex-properties array (3 floats per vertex); `indices`
 * references triangles (3 `Uint32` indices per triangle). Both arrays are
 * transferable.
 */
export interface SerializedMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/**
 * Payload posted from the renderer to the worker to kick off a generate.
 */
export interface GenerateMoldRequest {
  /**
   * Master's BufferGeometry.position data. If `masterIndex` is provided
   * (length > 0), this is the de-duplicated vertex pool; otherwise it is
   * a non-indexed triangle soup (9 floats per triangle, STLLoader output
   * shape).
   */
  masterPosition: Float32Array;
  /**
   * Master's BufferGeometry.index data. Zero-length Uint32Array signals
   * "non-indexed" — the worker falls back to the same soup-to-manifold
   * path the `adapters.ts` helper uses.
   */
  masterIndex: Uint32Array;
  /** `three.Matrix4.elements` as a 16-element column-major number array. */
  viewTransform: number[];
  parameters: MoldParameters;
}

/**
 * Phase update message the worker posts at each heavy-step boundary
 * BEFORE the work begins — mirrors `generateMold.ts::GeneratePhase`.
 * Non-terminal; multiple of these may arrive before the final
 * `{ok:true|false}` response.
 */
export interface PhaseUpdate {
  type: 'phase';
  key: string;
}

/**
 * Terminal response shape. `ok:true` on success, `ok:false` on error.
 * The message is distinguished from phase updates via the `ok`
 * discriminator (phase updates use a `type` key that `ok`-shaped
 * responses never have).
 */
export type GenerateMoldResponse =
  | {
      ok: true;
      silicone: SerializedMesh;
      shellPieces: SerializedMesh[];
      basePart: SerializedMesh;
      siliconeVolume_mm3: number;
      resinVolume_mm3: number;
      shellPiecesVolume_mm3: number[];
      totalShellVolume_mm3: number;
      baseSlabVolume_mm3: number;
      phaseTimings: Record<string, number>;
    }
  | {
      ok: false;
      error: string;
      stack?: string;
    };

/**
 * Serialise a Manifold to `{positions, indices}`. Positions are the
 * Manifold's `vertProperties` (3 floats per vertex); indices are its
 * `triVerts`. The output arrays are freshly allocated Float32 / Uint32
 * buffers so the caller can transfer them without concern for Emscripten
 * heap slice aliasing.
 */
function serializeManifold(manifold: Manifold): SerializedMesh {
  const mesh = manifold.getMesh();
  const numVerts = mesh.vertProperties.length / mesh.numProp;
  const positions = new Float32Array(numVerts * 3);
  if (mesh.numProp === 3) {
    // Hot path — no channel stripping needed. Copy verbatim.
    positions.set(mesh.vertProperties);
  } else {
    // Defensive: strip any extra channels (colour, UV) down to x/y/z.
    for (let v = 0; v < numVerts; v++) {
      const base = v * mesh.numProp;
      positions[v * 3] = mesh.vertProperties[base]!;
      positions[v * 3 + 1] = mesh.vertProperties[base + 1]!;
      positions[v * 3 + 2] = mesh.vertProperties[base + 2]!;
    }
  }
  // `triVerts` from manifold-3d is a Uint32Array-compatible TypedArray
  // but the getMesh() handle may be a view into the WASM heap. Copy into
  // a fresh owned buffer so the later `.delete()` doesn't invalidate it.
  const indices = new Uint32Array(mesh.triVerts.length);
  indices.set(mesh.triVerts);
  return { positions, indices };
}

/**
 * Post a phase update to the renderer. Phase updates carry no
 * Transferables.
 */
function postPhase(key: string): void {
  const msg: PhaseUpdate = { type: 'phase', key };
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
}

/**
 * Post the terminal response. On success, transfers every mesh's
 * ArrayBuffer so the payload arrives zero-copy on the renderer. On
 * failure, no transfer list is needed.
 */
function postResponse(
  response: GenerateMoldResponse,
  transferables: Transferable[],
): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(
    response,
    transferables,
  );
}

/**
 * Build the master Manifold from the incoming positions/indices buffers.
 * Separate from the generate call so errors here surface with a specific
 * label on the error path.
 */
async function buildMasterManifold(
  masterPosition: Float32Array,
  masterIndex: Uint32Array,
): Promise<Manifold> {
  const toplevel = await initManifold();
  if (masterIndex.length > 0) {
    // Indexed input — positions are pre-de-duplicated, triVerts
    // references them. Fast path.
    const mesh = new toplevel.Mesh({
      numProp: 3,
      vertProperties: masterPosition,
      triVerts: masterIndex,
    });
    return new toplevel.Manifold(mesh);
  }
  // Non-indexed triangle soup. De-duplicate by exact float key. Mirrors
  // `adapters.ts::bufferGeometryToManifoldMesh`'s soup path so the
  // worker output is identical to the pre-#77 in-process behaviour.
  const triCount = masterPosition.length / 9;
  const vertIndex = new Map<string, number>();
  const vertsFlat: number[] = [];
  const triVerts = new Uint32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    for (let v = 0; v < 3; v++) {
      const srcBase = t * 9 + v * 3;
      const x = masterPosition[srcBase]!;
      const y = masterPosition[srcBase + 1]!;
      const z = masterPosition[srcBase + 2]!;
      const key = `${x},${y},${z}`;
      let idx = vertIndex.get(key);
      if (idx === undefined) {
        idx = vertsFlat.length / 3;
        vertsFlat.push(x, y, z);
        vertIndex.set(key, idx);
      }
      triVerts[t * 3 + v] = idx;
    }
  }
  const mesh = new toplevel.Mesh({
    numProp: 3,
    vertProperties: new Float32Array(vertsFlat),
    triVerts,
  });
  return new toplevel.Manifold(mesh);
}

/**
 * Main worker message handler. Expects exactly one `GenerateMoldRequest`
 * per worker instance — the renderer-side runner creates a fresh worker
 * per Generate run (see `generateMoldRunner.ts`) so the cancel path is a
 * clean `worker.terminate()` with no in-flight ambiguity.
 */
(self as unknown as DedicatedWorkerGlobalScope).addEventListener(
  'message',
  (event: MessageEvent<GenerateMoldRequest>) => {
    void handleRequest(event.data);
  },
);

async function handleRequest(request: GenerateMoldRequest): Promise<void> {
  const t0 = performance.now();
  const phaseTimings: Record<string, number> = {};
  const phaseStart: Record<string, number> = {};

  let master: Manifold | undefined;
  let silicone: Manifold | undefined;
  let shellPieces: Manifold[] | undefined;
  let basePart: Manifold | undefined;

  try {
    // Materialise the master on the worker side. The renderer may have
    // held its own master Manifold, but we never ship Manifolds across
    // the boundary — positions+indices are the source of truth here.
    master = await buildMasterManifold(
      request.masterPosition,
      request.masterIndex,
    );
    phaseTimings['masterIngest_ms'] = performance.now() - t0;

    // Re-hydrate the viewTransform as a `three.Matrix4`. The generator
    // uses `Matrix4.elements` directly, so a fresh `Matrix4().fromArray(
    // elements)` round-trips losslessly.
    const viewTransform = new Matrix4().fromArray(request.viewTransform);

    const onPhase = (key: string): void => {
      // Record per-phase wall-clock so the renderer has insight into
      // where the time went (same as the in-process pipeline's
      // `[generateSiliconeShell] step timings` log).
      phaseStart[key] = performance.now();
      postPhase(key);
    };

    const tGenerateStart = performance.now();
    const result = await generateSiliconeShell(
      master,
      request.parameters,
      viewTransform,
      onPhase,
    );
    phaseTimings['generate_ms'] = performance.now() - tGenerateStart;

    silicone = result.silicone;
    shellPieces = [...result.shellPieces];
    basePart = result.basePart;

    // Serialise every output Manifold, then dispose them here before
    // posting back — no WASM handles leak outside this worker.
    const tSerializeStart = performance.now();
    const siliconeMesh = serializeManifold(silicone);
    const shellMeshes = shellPieces.map((p) => serializeManifold(p));
    const basePartMesh = serializeManifold(basePart);
    phaseTimings['serialize_ms'] = performance.now() - tSerializeStart;

    // Build the transfer list — every Float32/Uint32 buffer moves
    // zero-copy to the renderer. Order doesn't matter for correctness.
    const transferables: Transferable[] = [
      siliconeMesh.positions.buffer,
      siliconeMesh.indices.buffer,
      basePartMesh.positions.buffer,
      basePartMesh.indices.buffer,
    ];
    for (const sm of shellMeshes) {
      transferables.push(sm.positions.buffer, sm.indices.buffer);
    }

    phaseTimings['total_ms'] = performance.now() - t0;

    const response: GenerateMoldResponse = {
      ok: true,
      silicone: siliconeMesh,
      shellPieces: shellMeshes,
      basePart: basePartMesh,
      siliconeVolume_mm3: result.siliconeVolume_mm3,
      resinVolume_mm3: result.resinVolume_mm3,
      shellPiecesVolume_mm3: [...result.shellPiecesVolume_mm3],
      totalShellVolume_mm3: result.totalShellVolume_mm3,
      baseSlabVolume_mm3: result.baseSlabVolume_mm3,
      phaseTimings,
    };

    // Dispose WASM handles BEFORE posting so the message loop isn't
    // bogged down holding heap memory while the host is unpacking.
    silicone.delete();
    silicone = undefined;
    for (const p of shellPieces) p.delete();
    shellPieces = undefined;
    basePart.delete();
    basePart = undefined;
    master.delete();
    master = undefined;

    postResponse(response, transferables);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    // Defence-in-depth: release every successfully-allocated Manifold
    // on the error path so the worker terminates with no WASM leaks.
    if (silicone) try { silicone.delete(); } catch { /* already dead */ }
    if (shellPieces) {
      for (const p of shellPieces) {
        if (p) try { p.delete(); } catch { /* already dead */ }
      }
    }
    if (basePart) try { basePart.delete(); } catch { /* already dead */ }
    if (master) try { master.delete(); } catch { /* already dead */ }

    const response: GenerateMoldResponse = stack
      ? { ok: false, error: message, stack }
      : { ok: false, error: message };
    postResponse(response, []);
  }
}

// Signal to the renderer that the worker module has loaded and the
// message handler is live. Useful for diagnosing "worker didn't boot"
// (e.g. missing CSP for workers) during dev — the runner can log a
// timeout if this never arrives. Not required on the happy path.
(self as unknown as DedicatedWorkerGlobalScope).postMessage({
  type: 'phase',
  key: 'worker-ready',
} satisfies PhaseUpdate);

// Keep a "module has evaluated" side-effect export so Vite's dependency
// graph treats this file as a true ESM module. No default export — the
// worker is consumed via `new Worker(url, {type:'module'})`.
export {};
