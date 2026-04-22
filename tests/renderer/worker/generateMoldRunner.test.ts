// tests/renderer/worker/generateMoldRunner.test.ts
//
// @vitest-environment happy-dom
//
// Unit tests for `generateMoldRunner` — the renderer-side host for the
// `generateMold.worker.ts` web worker (issue #77). Drives the runner
// with a mock Worker so the contract (message shapes, cancellation,
// phase forwarding, error translation, Manifold reconstruction) is
// pinned without a real WASM init.
//
// Coverage:
//   - Happy path: postMessage request, phase forwarding, terminal
//     response re-hydrated to a `MoldGenerationResult`.
//   - Cancel: handle.cancel() terminates the worker + stops forwarding.
//   - Error path: `{ok:false, error, stack}` → promise rejects with an
//     Error carrying the worker's message.
//   - Crash path: worker `error` event → promise rejects with a
//     runner-prefixed message.
//   - Worker-ready ping: never forwarded to onPhase.

import { Matrix4 } from 'three';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { Manifold } from 'manifold-3d';
import { DEFAULT_PARAMETERS } from '@/renderer/state/parameters';

// Mock the geometry adapter's Manifold re-ingest so we don't spin up
// the real manifold-3d WASM runtime for these unit tests. Each
// serialized mesh maps to a distinguishable fake Manifold.
vi.mock('@/geometry/adapters', () => {
  let idCounter = 0;
  return {
    bufferGeometryToManifold: vi.fn(async () => {
      const id = ++idCounter;
      return {
        __fakeManifoldId: id,
        delete: vi.fn<() => void>(),
      } as unknown as Manifold;
    }),
  };
});

import { runGenerate } from '@/renderer/worker/generateMoldRunner';
import type {
  GenerateMoldRequest,
  GenerateMoldResponse,
  PhaseUpdate,
} from '@/workers/generateMold.worker';

/**
 * Minimal Worker mock — captures posted messages, exposes hooks to
 * synthesise worker-originated messages + errors, and tracks
 * `terminate()` invocations.
 *
 * The real `Worker.addEventListener('message', fn)` is typed for
 * `MessageEvent<unknown>`; we loosen to `any` in the mock so tests can
 * post typed `PhaseUpdate | GenerateMoldResponse` values directly.
 */
class MockWorker {
  readonly posted: Array<{
    data: GenerateMoldRequest;
    transfer: Transferable[];
  }> = [];
  readonly terminated: boolean[] = [];
  private messageListeners = new Set<(ev: MessageEvent) => void>();
  private errorListeners = new Set<(ev: ErrorEvent) => void>();

  addEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: (ev: Event) => void,
  ): void {
    if (type === 'message') {
      this.messageListeners.add(listener as (ev: MessageEvent) => void);
    } else if (type === 'error') {
      this.errorListeners.add(listener as (ev: ErrorEvent) => void);
    }
  }

  postMessage(
    data: GenerateMoldRequest,
    transfer: Transferable[] = [],
  ): void {
    this.posted.push({ data, transfer });
  }

  terminate(): void {
    this.terminated.push(true);
  }

  /** Synthesise a worker-originated message. */
  emit(data: PhaseUpdate | GenerateMoldResponse): void {
    const ev = new MessageEvent('message', { data });
    for (const listener of this.messageListeners) {
      listener(ev);
    }
  }

  /** Synthesise a worker crash. */
  emitError(message: string): void {
    const ev = new ErrorEvent('error', { message });
    for (const listener of this.errorListeners) {
      listener(ev);
    }
  }
}

/** Distinguishable but minimal Manifold stand-in for the master arg. */
function fakeMaster(): Manifold {
  return {
    getMesh: () => ({
      numProp: 3,
      vertProperties: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      triVerts: new Uint32Array([0, 1, 2]),
    }),
    delete: vi.fn<() => void>(),
  } as unknown as Manifold;
}

function buildSerialisedMesh(vertexCount = 3): {
  positions: Float32Array;
  indices: Uint32Array;
} {
  const positions = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount * 3; i++) positions[i] = i;
  const indices = new Uint32Array([0, 1, 2]);
  return { positions, indices };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runGenerate — happy path', () => {
  test('posts a GenerateMoldRequest with the master mesh, transform, and parameters', async () => {
    const worker = new MockWorker();
    const viewTransform = new Matrix4().makeTranslation(1, 2, 3);

    const handle = runGenerate(
      fakeMaster(),
      DEFAULT_PARAMETERS,
      viewTransform,
      undefined,
      { workerFactory: () => worker as unknown as Worker, readyTimeoutMs: 0 },
    );

    // Runner posts synchronously on construction.
    expect(worker.posted).toHaveLength(1);
    const sent = worker.posted[0]!;
    expect(sent.data.parameters).toStrictEqual(DEFAULT_PARAMETERS);
    expect(sent.data.viewTransform).toEqual(
      Array.from(viewTransform.elements),
    );
    expect(sent.data.masterPosition).toBeInstanceOf(Float32Array);
    expect(sent.data.masterIndex).toBeInstanceOf(Uint32Array);
    // Transfer list carries both buffers so the post is zero-copy.
    expect(sent.transfer).toHaveLength(2);

    // Resolve the promise so the test exits cleanly.
    const response: GenerateMoldResponse = {
      ok: true,
      silicone: buildSerialisedMesh(),
      shellPieces: [buildSerialisedMesh(), buildSerialisedMesh()],
      basePart: buildSerialisedMesh(),
      siliconeVolume_mm3: 100,
      resinVolume_mm3: 50,
      shellPiecesVolume_mm3: [10, 20],
      totalShellVolume_mm3: 30,
      baseSlabVolume_mm3: 40,
      phaseTimings: { total_ms: 1000 },
    };
    worker.emit(response);
    const result = await handle.promise;

    expect(result.siliconeVolume_mm3).toBe(100);
    expect(result.resinVolume_mm3).toBe(50);
    expect(result.shellPieces).toHaveLength(2);
    expect(result.totalShellVolume_mm3).toBe(30);
    expect(result.baseSlabVolume_mm3).toBe(40);
    // Worker torn down post-resolve.
    expect(worker.terminated).toHaveLength(1);
  });

  test('forwards phase updates to onPhase in order', async () => {
    const worker = new MockWorker();
    const phases: string[] = [];
    const onPhase = vi.fn<(k: string) => void>((k) => {
      phases.push(k);
    });

    const handle = runGenerate(
      fakeMaster(),
      DEFAULT_PARAMETERS,
      new Matrix4(),
      onPhase as never,
      { workerFactory: () => worker as unknown as Worker, readyTimeoutMs: 0 },
    );

    worker.emit({ type: 'phase', key: 'worker-ready' });
    worker.emit({ type: 'phase', key: 'silicone' });
    worker.emit({ type: 'phase', key: 'shell' });
    worker.emit({ type: 'phase', key: 'slab' });

    // Phase forwarding is chained on a promise — flush microtasks.
    // Each phase costs two `.then` hops (chain continuation +
    // onPhase resolve), so flush generously.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // `worker-ready` is the runner's internal ping and MUST NOT surface
    // as a phase.
    expect(phases).toEqual(['silicone', 'shell', 'slab']);

    // Resolve the run so the harness cleans up.
    worker.emit({
      ok: true,
      silicone: buildSerialisedMesh(),
      shellPieces: [],
      basePart: buildSerialisedMesh(),
      siliconeVolume_mm3: 0,
      resinVolume_mm3: 0,
      shellPiecesVolume_mm3: [],
      totalShellVolume_mm3: 0,
      baseSlabVolume_mm3: 0,
      phaseTimings: {},
    });
    await handle.promise;
  });
});

describe('runGenerate — cancel', () => {
  test('cancel() terminates the worker', () => {
    const worker = new MockWorker();
    const handle = runGenerate(
      fakeMaster(),
      DEFAULT_PARAMETERS,
      new Matrix4(),
      undefined,
      { workerFactory: () => worker as unknown as Worker, readyTimeoutMs: 0 },
    );

    handle.cancel();

    expect(worker.terminated).toHaveLength(1);
  });

  test('double-cancel is a no-op', () => {
    const worker = new MockWorker();
    const handle = runGenerate(
      fakeMaster(),
      DEFAULT_PARAMETERS,
      new Matrix4(),
      undefined,
      { workerFactory: () => worker as unknown as Worker, readyTimeoutMs: 0 },
    );

    handle.cancel();
    handle.cancel();

    expect(worker.terminated).toHaveLength(1);
  });
});

describe('runGenerate — error paths', () => {
  test('ok:false response rejects promise with worker error message', async () => {
    const worker = new MockWorker();
    const handle = runGenerate(
      fakeMaster(),
      DEFAULT_PARAMETERS,
      new Matrix4(),
      undefined,
      { workerFactory: () => worker as unknown as Worker, readyTimeoutMs: 0 },
    );

    worker.emit({
      ok: false,
      error: 'levelSet blew up',
      stack: 'Error: levelSet blew up\n  at foo',
    });

    await expect(handle.promise).rejects.toThrow('levelSet blew up');
    // Worker torn down on the error branch too.
    expect(worker.terminated).toHaveLength(1);
  });

  test('worker error event rejects with runner-prefixed message', async () => {
    const worker = new MockWorker();
    const handle = runGenerate(
      fakeMaster(),
      DEFAULT_PARAMETERS,
      new Matrix4(),
      undefined,
      { workerFactory: () => worker as unknown as Worker, readyTimeoutMs: 0 },
    );

    worker.emitError('wasm load failed');

    await expect(handle.promise).rejects.toThrow(/worker error/);
    await expect(handle.promise).rejects.toThrow(/wasm load failed/);
  });
});
