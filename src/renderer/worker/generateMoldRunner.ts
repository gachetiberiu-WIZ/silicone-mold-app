// src/renderer/worker/generateMoldRunner.ts
//
// Renderer-side host for the `generateMold.worker.ts` web worker (issue
// #77). Wraps the `postMessage` boundary behind a promise-shaped facade
// that matches the orchestrator's `generate(master, parameters,
// viewTransform, onPhase)` signature — the orchestrator is oblivious to
// whether the work runs in-process or in a worker.
//
// Lifecycle model
// ---------------
//
// One worker per Generate run. `runGenerate()` spins up a fresh `Worker`
// instance every call, and disposes it (via `terminate()`) on
// completion — success OR failure. Rationale:
//
//   1. Cancel is just `worker.terminate()` — no in-flight cooperation,
//      no "is this phase a cancel checkpoint" bookkeeping.
//   2. The WASM init cost (~200-500 ms) is paid on the FIRST run of a
//      session. Subsequent runs cold-start their worker again — yes,
//      that pays the WASM init again, but measurements on the figurine
//      put this at ~300 ms on top of a ~3-10 s generate budget (<10 %
//      overhead). Trade accepted: we get a zero-state-leak cancel model
//      in exchange. If this ever shows up in a profile, switch to a
//      pooled worker with explicit cancel tokens (follow-up issue).
//   3. A stray error or corrupted Emscripten heap inside the worker
//      never poisons a future run — the next `runGenerate()` gets a
//      clean worker from scratch.
//
// Ownership discipline
// --------------------
//
// The worker emits serialised mesh payloads (`{positions, indices}`) via
// transferable ArrayBuffers. This module re-hydrates each payload into a
// `Manifold` on the main thread via the existing
// `bufferGeometryToManifold` adapter — cheap (~1-10 ms per piece for our
// output mesh sizes, far below the savings of not running the SDF +
// levelSet + booleans on the main thread). The resulting Manifolds are
// handed back as a standard `MoldGenerationResult`, so every downstream
// consumer (orchestrator, scene sinks, export) works without change.
//
// Host-side Manifolds are owned by the caller per the `MoldGenerationResult`
// contract — the runner does NOT retain references after `runGenerate()`
// resolves.
//
// Error paths
// -----------
//
// - Worker posts `{ok:false, error, stack}` → the promise rejects with
//   an Error carrying the original message + stack.
// - Worker crashes (uncaught exception in an async path that we miss) →
//   the Worker's `error` event handler fires → the promise rejects with
//   `Error(event.message)`.
// - Cancel is NOT a rejection. Calling `cancel()` terminates the worker
//   and resolves the runner's promise to never — it's fire-and-forget.
//   The orchestrator owns staleness via its epoch check; cancellation
//   just stops the worker from wasting cycles.

import type { Matrix4 } from 'three';
import type { Manifold } from 'manifold-3d';
import { BufferAttribute, BufferGeometry } from 'three';

import type { MoldParameters } from '@/renderer/state/parameters';
import type {
  GeneratePhase,
  MoldGenerationResult,
  OnGeneratePhase,
} from '@/geometry/generateMold';
import { bufferGeometryToManifold } from '@/geometry/adapters';
import type {
  GenerateMoldRequest,
  GenerateMoldResponse,
  PhaseUpdate,
  SerializedMesh,
} from '@/workers/generateMold.worker';

/**
 * Extract positions + indices from a master `Manifold` as transferable
 * buffers. Pre-#77 the generator pulled this mesh internally via
 * `manifold.getMesh()`; for the worker path we do the same on the host
 * side, ship the buffers, and let the worker reconstruct the Manifold.
 *
 * Uses the fact that `manifold.getMesh()` already returns a pair of
 * views we can copy into fresh owned TypedArrays (so the subsequent
 * Manifold-scoped heap slice doesn't invalidate what we transfer).
 */
function serializeMaster(master: Manifold): {
  positions: Float32Array;
  indices: Uint32Array;
} {
  const mesh = master.getMesh();
  const numVerts = mesh.vertProperties.length / mesh.numProp;
  const positions = new Float32Array(numVerts * 3);
  if (mesh.numProp === 3) {
    positions.set(mesh.vertProperties);
  } else {
    for (let v = 0; v < numVerts; v++) {
      const base = v * mesh.numProp;
      positions[v * 3] = mesh.vertProperties[base]!;
      positions[v * 3 + 1] = mesh.vertProperties[base + 1]!;
      positions[v * 3 + 2] = mesh.vertProperties[base + 2]!;
    }
  }
  const indices = new Uint32Array(mesh.triVerts.length);
  indices.set(mesh.triVerts);
  return { positions, indices };
}

/**
 * Convert a `SerializedMesh` from the worker into a Three.js
 * `BufferGeometry`. Used as a stepping stone into
 * `bufferGeometryToManifold` on the main thread, but also exposed for
 * any future caller that wants the raw render-side geometry without
 * going through Manifold.
 */
function serializedMeshToBufferGeometry(mesh: SerializedMesh): BufferGeometry {
  // The worker emits indexed geometry — positions are de-duplicated,
  // indices reference them. Preserve that shape rather than re-expanding
  // into triangle soup: the Manifold construction path handles indexed
  // geometry on a fast path (see `adapters.ts::bufferGeometryToManifoldMesh`).
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  geometry.setIndex(new BufferAttribute(mesh.indices, 1));
  return geometry;
}

/**
 * Re-hydrate a single serialised mesh into a `Manifold` on the main
 * thread. Thin wrapper around `bufferGeometryToManifold` that disposes
 * the intermediate BufferGeometry so memory settles predictably.
 */
async function serializedMeshToManifold(
  mesh: SerializedMesh,
): Promise<Manifold> {
  const geometry = serializedMeshToBufferGeometry(mesh);
  try {
    return await bufferGeometryToManifold(geometry);
  } finally {
    geometry.dispose();
  }
}

/**
 * Imperative handle returned by `runGenerate`. `promise` resolves to the
 * host-side `MoldGenerationResult` on success, rejects on error. `cancel`
 * terminates the worker and leaves `promise` pending forever — the
 * orchestrator gates on its own epoch, so a cancelled run never lands in
 * the happy path.
 */
export interface GenerateRunHandle {
  promise: Promise<MoldGenerationResult>;
  cancel(): void;
}

/**
 * Construct the worker URL via Vite's `new URL(..., import.meta.url)`
 * pattern — Vite rewrites this at build-time to point at the emitted
 * chunk for the worker module. At dev-time it points at the TS source
 * and Vite handles transpilation + module resolution transparently.
 *
 * Extracted into a helper so tests that stub workers (and any future
 * non-Vite context) can swap it out via dependency injection on the
 * `runGenerate` options param.
 */
function defaultWorkerFactory(): Worker {
  // The `{type:'module'}` flag is essential: manifold-3d's Emscripten
  // glue relies on `import.meta.url` to locate its sibling .wasm asset,
  // which is only available in a module-type worker. A classic script
  // worker would fail at WASM fetch with a "import.meta is undefined"
  // error.
  return new Worker(
    new URL('../../workers/generateMold.worker.ts', import.meta.url),
    { type: 'module' },
  );
}

/**
 * Dependencies injected into `runGenerate`. Split from the positional
 * args so the orchestrator can close over a single function-shape while
 * tests can override `workerFactory` to inject a Worker mock.
 */
export interface GenerateMoldRunnerDeps {
  /**
   * Factory that creates a fresh `Worker` per run. Defaults to the
   * Vite-bundled worker module URL. Unit tests (which need to exercise
   * the runner without a real WASM worker) inject a mock that speaks
   * the same `postMessage` contract.
   */
  workerFactory?: () => Worker;
  /**
   * Timeout (ms) after which the initial `worker-ready` ping is
   * considered failed. If the worker doesn't post its ready signal
   * within this window, the runner logs a diagnostic error — a
   * common symptom of a missing CSP `worker-src` directive or a
   * WASM load failure in the worker.
   *
   * Defaults to 10_000 ms. Set to 0 to disable the diagnostic.
   */
  readyTimeoutMs?: number;
}

/**
 * Fire a `generateSiliconeShell` run in a dedicated worker and return a
 * handle for the result + cancellation.
 *
 * @param master Master Manifold owned by the caller. The runner reads
 *   its mesh (does NOT transfer ownership) so the scene's cache of the
 *   master stays valid.
 * @param parameters Mold parameters snapshot. Structurally cloned over
 *   the postMessage boundary; freezing the snapshot upstream is not
 *   necessary.
 * @param viewTransform Master group's world matrix. Flattened via
 *   `Matrix4.elements.slice()` so the worker re-hydrates it locally.
 * @param onPhase Optional progress callback. Fired with the phase key
 *   each time the worker posts a `{type:'phase', key}` message. Awaited
 *   by the runner so orchestrator-side RAF yield plumbing works
 *   transparently (same contract as the in-process generator).
 * @param deps Injectable dependencies (test seam).
 */
export function runGenerate(
  master: Manifold,
  parameters: MoldParameters,
  viewTransform: Matrix4,
  onPhase?: OnGeneratePhase,
  deps: GenerateMoldRunnerDeps = {},
): GenerateRunHandle {
  const { workerFactory = defaultWorkerFactory, readyTimeoutMs = 10_000 } =
    deps;

  const worker = workerFactory();
  let cancelled = false;
  let readyTimerId: ReturnType<typeof setTimeout> | null = null;
  let workerReady = false;

  if (readyTimeoutMs > 0) {
    readyTimerId = setTimeout(() => {
      if (!workerReady && !cancelled) {
        console.error(
          '[generateMoldRunner] worker did not signal ready within ' +
            `${readyTimeoutMs} ms — check CSP worker-src directive ` +
            'and manifold-3d WASM load.',
        );
      }
    }, readyTimeoutMs);
  }

  const promise = new Promise<MoldGenerationResult>((resolve, reject) => {
    // Buffer phase promises so a slow onPhase handler doesn't let a later
    // phase overtake it. We chain them sequentially on a single await
    // chain — mirrors the generator's own "await the callback" contract.
    let phaseChain: Promise<void> = Promise.resolve();

    worker.addEventListener(
      'message',
      (event: MessageEvent<PhaseUpdate | GenerateMoldResponse>) => {
        const data = event.data;
        if ('type' in data && data.type === 'phase') {
          if (data.key === 'worker-ready') {
            workerReady = true;
            if (readyTimerId !== null) {
              clearTimeout(readyTimerId);
              readyTimerId = null;
            }
            return;
          }
          if (onPhase) {
            // The worker only emits `GeneratePhase` keys beyond the
            // special `worker-ready` sentinel filtered above — safe to
            // cast. An out-of-band string would be caller error on the
            // worker side, not a runtime risk worth rejecting for.
            const key = data.key as GeneratePhase;
            phaseChain = phaseChain.then(() => Promise.resolve(onPhase(key)));
          }
          return;
        }
        // Terminal response. Handle ok/error.
        const response = data as GenerateMoldResponse;
        if (readyTimerId !== null) {
          clearTimeout(readyTimerId);
          readyTimerId = null;
        }
        void handleTerminal(response).then(
          (res) => {
            worker.terminate();
            resolve(res);
          },
          (err) => {
            worker.terminate();
            reject(err);
          },
        );
      },
    );

    worker.addEventListener('error', (event) => {
      if (readyTimerId !== null) {
        clearTimeout(readyTimerId);
        readyTimerId = null;
      }
      // `ErrorEvent.message` is undefined for some Chromium failures
      // (CSP blocks, WASM load errors) — fall back to a generic label.
      const message =
        (event as ErrorEvent).message ||
        'generateMold worker crashed without an error message';
      worker.terminate();
      reject(new Error(`[generateMoldRunner] worker error: ${message}`));
    });

    worker.addEventListener('messageerror', (event) => {
      worker.terminate();
      reject(
        new Error(
          `[generateMoldRunner] worker messageerror: ${String(event)}`,
        ),
      );
    });

    // Serialise the master + dispatch. We transfer the master
    // buffers (positions + index) — but these were freshly allocated
    // above inside `serializeMaster`, so the caller's Manifold is not
    // impacted.
    const masterSerialised = serializeMaster(master);
    const request: GenerateMoldRequest = {
      masterPosition: masterSerialised.positions,
      masterIndex: masterSerialised.indices,
      viewTransform: Array.from(viewTransform.elements),
      parameters,
    };
    worker.postMessage(request, [
      masterSerialised.positions.buffer,
      masterSerialised.indices.buffer,
    ]);
  });

  return {
    promise,
    cancel(): void {
      if (cancelled) return;
      cancelled = true;
      if (readyTimerId !== null) {
        clearTimeout(readyTimerId);
        readyTimerId = null;
      }
      worker.terminate();
    },
  };
}

/**
 * Post-success: reconstruct Manifolds on the main thread so the
 * existing orchestrator + scene sink + export plumbing all keep
 * working unchanged. Reconstruction is O(mesh triangles) and runs
 * off clean, pre-validated data — takes <10 ms per piece on
 * production-scale outputs.
 */
async function handleTerminal(
  response: GenerateMoldResponse,
): Promise<MoldGenerationResult> {
  if (!response.ok) {
    const err = new Error(response.error);
    if (response.stack) err.stack = response.stack;
    throw err;
  }
  const silicone = await serializedMeshToManifold(response.silicone);
  const shellPieces: Manifold[] = [];
  try {
    for (const sm of response.shellPieces) {
      shellPieces.push(await serializedMeshToManifold(sm));
    }
  } catch (err) {
    // Partial re-hydration — release what we've already built then
    // also release the silicone so the caller isn't stuck with a
    // half-formed result.
    for (const p of shellPieces) {
      try { p.delete(); } catch { /* already dead */ }
    }
    try { silicone.delete(); } catch { /* already dead */ }
    throw err;
  }
  let basePart: Manifold;
  try {
    basePart = await serializedMeshToManifold(response.basePart);
  } catch (err) {
    for (const p of shellPieces) {
      try { p.delete(); } catch { /* already dead */ }
    }
    try { silicone.delete(); } catch { /* already dead */ }
    throw err;
  }
  return {
    silicone,
    shellPieces,
    basePart,
    siliconeVolume_mm3: response.siliconeVolume_mm3,
    resinVolume_mm3: response.resinVolume_mm3,
    shellPiecesVolume_mm3: response.shellPiecesVolume_mm3,
    totalShellVolume_mm3: response.totalShellVolume_mm3,
    baseSlabVolume_mm3: response.baseSlabVolume_mm3,
  };
}

/**
 * Adapter that matches the orchestrator's `generate` parameter shape
 * (`(master, parameters, viewTransform, onPhase?) => Promise<MoldGenerationResult>`).
 * Call this from main.ts to wire the orchestrator through the worker
 * instead of the in-process `generateSiliconeShell` — all staleness +
 * cancel semantics match because the orchestrator gates on its own
 * epoch. The in-flight handle is tracked by this module scope so a
 * later `cancelCurrentRun()` can terminate it mid-flight.
 */
let currentHandle: GenerateRunHandle | null = null;

export function generateMoldViaWorker(
  master: Manifold,
  parameters: MoldParameters,
  viewTransform: Matrix4,
  onPhase?: OnGeneratePhase,
): Promise<MoldGenerationResult> {
  // If a previous run is still in flight (shouldn't normally happen —
  // the orchestrator serialises via its button's busy flag — but be
  // defensive) cancel it first so we don't burn two WASM workers.
  if (currentHandle) {
    currentHandle.cancel();
    currentHandle = null;
  }
  const handle = runGenerate(master, parameters, viewTransform, onPhase);
  currentHandle = handle;
  return handle.promise.finally(() => {
    if (currentHandle === handle) currentHandle = null;
  });
}

/**
 * Terminate the in-flight worker (if any). Called from main.ts's
 * staleness paths (new STL load, parameter change, orientation commit)
 * so a stale Generate no longer burns the worker thread. Safe to call
 * when no worker is running — no-op in that case.
 */
export function cancelCurrentWorkerRun(): void {
  if (currentHandle) {
    currentHandle.cancel();
    currentHandle = null;
  }
}
