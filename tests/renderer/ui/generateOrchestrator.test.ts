// tests/renderer/ui/generateOrchestrator.test.ts
//
// @vitest-environment happy-dom
//
// Race-condition + ownership unit tests for the Generate-mold orchestrator.
// Wave E + F (issue #84) updates the mock shape from `{silicone,
// printShell, basePart}` to `{silicone, shellPieces: Manifold[],
// basePart}` — the shell is radially sliced into N pieces with brim
// flanges. The topbar's "Print shell" readout is backed by
// `totalShellVolume_mm3` (sum of per-piece volumes).
//
// Coverage:
//
//   - Happy path: volumes pushed, silicone + every shell piece + base
//     slab disposed (or handed off to the scene sink), busy cleared,
//     success hook fired.
//   - Staleness: mid-flight `LAY_FLAT_COMMITTED_EVENT` bumps the epoch;
//     the stale resolve drops every Manifold and skips the topbar push.
//   - Scene sink: silicone + shell-pieces hand-off transfers ownership;
//     sink rejection surfaces via button.setError without a double-
//     dispose.
//   - Pre-flight: missing master / missing view transform surface errors
//     without raising busy.

import type { Manifold } from 'manifold-3d';
import { Matrix4 } from 'three';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { MoldGenerationResult } from '@/geometry/generateMold';
import { LAY_FLAT_COMMITTED_EVENT } from '@/renderer/scene/layFlatController';
import { __resetGenerateEpochForTests, getGenerateEpoch } from '@/renderer/ui/generateEpoch';
import { attachGenerateInvalidation } from '@/renderer/ui/generateInvalidation';
import {
  createGenerateOrchestrator,
  type GenerateOrchestratorDeps,
} from '@/renderer/ui/generateOrchestrator';
import {
  DEFAULT_PARAMETERS,
  type MoldParameters,
} from '@/renderer/state/parameters';

/**
 * Build a hand-resolvable promise so the test can interleave the
 * orchestrator's await with an invalidation event.
 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeMocks() {
  const topbar = {
    setSiliconeVolume: vi.fn<(v: number | null) => void>(),
    setResinVolume: vi.fn<(v: number | null) => void>(),
    setPrintShellVolume: vi.fn<(v: number | null) => void>(),
    setBaseSlabVolume: vi.fn<(v: number | null) => void>(),
  };
  const button = {
    setBusy: vi.fn<(v: boolean) => void>(),
    setError: vi.fn<(v: string | null) => void>(),
    setEnabled: vi.fn<(v: boolean) => void>(),
  };
  return { topbar, button };
}

/**
 * Sentinel values the stale test asserts were NEVER pushed to the topbar.
 * Large, distinctive numbers so failure messages are unambiguous.
 */
const STALE_SILICONE_MM3 = 319_914;
const STALE_RESIN_MM3 = 127_452;
const STALE_PRINT_SHELL_MM3 = 455_000;
const STALE_BASE_SLAB_MM3 = 88_888;

/**
 * A fake Manifold whose only exercised methods are `.delete()` and
 * `.isEmpty()`. `isEmpty` defaults to `false` (the common case); the
 * degenerate-slab tests override it per call site.
 */
function fakeManifold(isEmpty = false): Manifold {
  return {
    delete: vi.fn<() => void>(),
    isEmpty: vi.fn<() => boolean>(() => isEmpty),
  } as unknown as Manifold;
}

/**
 * Build a minimal-but-complete Wave-C `MoldGenerationResult` populated
 * with spy-`.delete()` Manifolds. Every path of the orchestrator calls
 * `.delete()` on each one (happy, stale, error) or hands them off to the
 * scene sink, so the mock must supply a `.delete` spy on EVERY Manifold.
 */
function makeResult(sideCount = 4): MoldGenerationResult {
  const shellPieces = Array.from({ length: sideCount }, () => fakeManifold());
  const perPieceVol = STALE_PRINT_SHELL_MM3 / sideCount;
  return {
    silicone: fakeManifold(),
    shellPieces,
    basePart: fakeManifold(),
    siliconeVolume_mm3: STALE_SILICONE_MM3,
    resinVolume_mm3: STALE_RESIN_MM3,
    shellPiecesVolume_mm3: shellPieces.map(() => perPieceVol),
    totalShellVolume_mm3: STALE_PRINT_SHELL_MM3,
    baseSlabVolume_mm3: STALE_BASE_SLAB_MM3,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  __resetGenerateEpochForTests();
});

describe('generateOrchestrator — happy path', () => {
  test('pushes volumes to the topbar and disposes both Manifolds on success', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<MoldGenerationResult>();
    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: () => d.promise,
      topbar,
      button,
      logger: { error: () => {} },
    });

    const runPromise = orchestrator.run();

    expect(button.setBusy).toHaveBeenCalledWith(true);
    expect(button.setError).toHaveBeenCalledWith(null);
    expect(topbar.setSiliconeVolume).toHaveBeenNthCalledWith(1, null);
    expect(topbar.setResinVolume).toHaveBeenNthCalledWith(1, null);
    expect(topbar.setPrintShellVolume).toHaveBeenNthCalledWith(1, null);

    const result = makeResult();
    d.resolve(result);
    await runPromise;

    expect(topbar.setSiliconeVolume).toHaveBeenCalledWith(STALE_SILICONE_MM3);
    expect(topbar.setResinVolume).toHaveBeenCalledWith(STALE_RESIN_MM3);
    expect(topbar.setPrintShellVolume).toHaveBeenCalledWith(STALE_PRINT_SHELL_MM3);
    expect(topbar.setBaseSlabVolume).toHaveBeenCalledWith(STALE_BASE_SLAB_MM3);
    // Volume-only path (no scene sink): every Manifold is .delete()'d.
    expect(result.silicone.delete).toHaveBeenCalledTimes(1);
    for (const p of result.shellPieces) {
      expect(p.delete).toHaveBeenCalledTimes(1);
    }
    expect(result.basePart.delete).toHaveBeenCalledTimes(1);
    expect(button.setBusy).toHaveBeenLastCalledWith(false);
  });
});

describe('generateOrchestrator — onGenerateSuccess hook', () => {
  test('fires onGenerateSuccess on the happy path (volume-only, no scene sink)', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<MoldGenerationResult>();
    const onGenerateSuccess = vi.fn<() => void>();
    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: () => d.promise,
      topbar,
      button,
      onGenerateSuccess,
      logger: { error: () => {} },
    });

    const runPromise = orchestrator.run();
    d.resolve(makeResult());
    await runPromise;

    expect(onGenerateSuccess).toHaveBeenCalledTimes(1);
  });

  test('fires onGenerateSuccess on the happy path (with scene sinks)', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<MoldGenerationResult>();
    const sceneSetSilicone = vi
      .fn<(payload: { silicone: Manifold }) => Promise<unknown>>()
      .mockResolvedValue({ bbox: null });
    const sceneSetPrintableParts = vi
      .fn<(parts: { shellPieces: readonly Manifold[]; basePart: Manifold; xzCenter?: { x: number; z: number } }) => Promise<unknown>>()
      .mockResolvedValue({ bbox: null });
    const onGenerateSuccess = vi.fn<() => void>();

    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: () => d.promise,
      topbar,
      button,
      scene: {
        setSilicone: sceneSetSilicone,
        setPrintableParts: sceneSetPrintableParts,
      },
      onGenerateSuccess,
      logger: { error: () => {} },
    });

    const runPromise = orchestrator.run();
    d.resolve(makeResult());
    await runPromise;

    expect(sceneSetSilicone).toHaveBeenCalledTimes(1);
    expect(sceneSetPrintableParts).toHaveBeenCalledTimes(1);
    expect(onGenerateSuccess).toHaveBeenCalledTimes(1);
  });

  test('does NOT fire onGenerateSuccess on stale-drop', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<MoldGenerationResult>();
    const onGenerateSuccess = vi.fn<() => void>();
    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: () => d.promise,
      topbar,
      button,
      onGenerateSuccess,
      logger: { error: () => {} },
    });

    const runPromise = orchestrator.run();
    const { bumpGenerateEpoch } = await import('@/renderer/ui/generateEpoch');
    bumpGenerateEpoch();
    d.resolve(makeResult());
    await runPromise;

    expect(onGenerateSuccess).not.toHaveBeenCalled();
  });

  test('does NOT fire onGenerateSuccess when generate rejects', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const onGenerateSuccess = vi.fn<() => void>();
    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: () => Promise.reject(new Error('boom')),
      topbar,
      button,
      onGenerateSuccess,
      logger: { error: () => {} },
    });

    await orchestrator.run();

    expect(onGenerateSuccess).not.toHaveBeenCalled();
  });

  test('does NOT fire onGenerateSuccess when silicone sink rejects', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<MoldGenerationResult>();
    const sceneSetSilicone = vi
      .fn<(payload: { silicone: Manifold }) => Promise<unknown>>()
      .mockRejectedValue(new Error('silicone adapter boom'));
    const onGenerateSuccess = vi.fn<() => void>();

    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: () => d.promise,
      topbar,
      button,
      scene: { setSilicone: sceneSetSilicone },
      onGenerateSuccess,
      logger: { error: () => {} },
    });

    const runPromise = orchestrator.run();
    d.resolve(makeResult());
    await runPromise;

    expect(onGenerateSuccess).not.toHaveBeenCalled();
    expect(button.setError).toHaveBeenLastCalledWith('silicone adapter boom');
  });

  test('does NOT fire onGenerateSuccess when print-shell sink rejects', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<MoldGenerationResult>();
    const sceneSetSilicone = vi
      .fn<(payload: { silicone: Manifold }) => Promise<unknown>>()
      .mockResolvedValue({ bbox: null });
    const sceneSetPrintableParts = vi
      .fn<(parts: { shellPieces: readonly Manifold[]; basePart: Manifold; xzCenter?: { x: number; z: number } }) => Promise<unknown>>()
      .mockRejectedValue(new Error('print-shell adapter boom'));
    const onGenerateSuccess = vi.fn<() => void>();

    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: () => d.promise,
      topbar,
      button,
      scene: {
        setSilicone: sceneSetSilicone,
        setPrintableParts: sceneSetPrintableParts,
      },
      onGenerateSuccess,
      logger: { error: () => {} },
    });

    const runPromise = orchestrator.run();
    d.resolve(makeResult());
    await runPromise;

    expect(onGenerateSuccess).not.toHaveBeenCalled();
    expect(button.setError).toHaveBeenLastCalledWith('print-shell adapter boom');
  });

  test('hook is optional — absence does not throw on the happy path', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<MoldGenerationResult>();
    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: () => d.promise,
      topbar,
      button,
      logger: { error: () => {} },
    });

    const runPromise = orchestrator.run();
    d.resolve(makeResult());
    await expect(runPromise).resolves.toBeUndefined();
  });
});

describe('generateOrchestrator — mid-flight LAY_FLAT_COMMITTED_EVENT race', () => {
  test('invalidation bumps epoch; stale resolve drops result WITHOUT overwriting topbar', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<MoldGenerationResult>();
    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: () => d.promise,
      topbar,
      button,
      logger: { error: () => {} },
    });

    const detach = attachGenerateInvalidation(topbar, button);

    const epochAtStart = getGenerateEpoch();
    const runPromise = orchestrator.run();

    expect(getGenerateEpoch()).toBe(epochAtStart + 1);

    const siliconeCallsBefore = topbar.setSiliconeVolume.mock.calls.length;
    const resinCallsBefore = topbar.setResinVolume.mock.calls.length;
    const printShellCallsBefore = topbar.setPrintShellVolume.mock.calls.length;

    document.dispatchEvent(new CustomEvent(LAY_FLAT_COMMITTED_EVENT, { detail: true }));

    expect(getGenerateEpoch()).toBe(epochAtStart + 2);
    expect(topbar.setSiliconeVolume).toHaveBeenNthCalledWith(siliconeCallsBefore + 1, null);
    expect(topbar.setResinVolume).toHaveBeenNthCalledWith(resinCallsBefore + 1, null);
    expect(topbar.setPrintShellVolume).toHaveBeenNthCalledWith(printShellCallsBefore + 1, null);

    const result = makeResult();
    d.resolve(result);
    await runPromise;

    const siliconeArgs = topbar.setSiliconeVolume.mock.calls.map((c) => c[0]);
    const resinArgs = topbar.setResinVolume.mock.calls.map((c) => c[0]);
    const printShellArgs = topbar.setPrintShellVolume.mock.calls.map((c) => c[0]);
    expect(siliconeArgs, `setSiliconeVolume args: ${JSON.stringify(siliconeArgs)}`).not.toContain(
      STALE_SILICONE_MM3,
    );
    expect(resinArgs, `setResinVolume args: ${JSON.stringify(resinArgs)}`).not.toContain(
      STALE_RESIN_MM3,
    );
    expect(
      printShellArgs,
      `setPrintShellVolume args: ${JSON.stringify(printShellArgs)}`,
    ).not.toContain(STALE_PRINT_SHELL_MM3);
    for (const v of siliconeArgs) expect(v).toBeNull();
    for (const v of resinArgs) expect(v).toBeNull();
    for (const v of printShellArgs) expect(v).toBeNull();

    // Every Manifold was .delete()'d on the stale-drop path.
    expect(result.silicone.delete).toHaveBeenCalledTimes(1);
    for (const p of result.shellPieces) {
      expect(p.delete).toHaveBeenCalledTimes(1);
    }
    expect(result.basePart.delete).toHaveBeenCalledTimes(1);

    const busyArgs = button.setBusy.mock.calls.map((c) => c[0]);
    expect(busyArgs, `setBusy args: ${JSON.stringify(busyArgs)}`).toEqual([true]);

    detach();
  });

  test('invalidation bumps epoch even when generate rejects (stale error is swallowed)', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<MoldGenerationResult>();
    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: () => d.promise,
      topbar,
      button,
      logger: { error: () => {} },
    });
    const detach = attachGenerateInvalidation(topbar, button);

    const runPromise = orchestrator.run();

    const errorCallsBefore = button.setError.mock.calls.length;

    document.dispatchEvent(new CustomEvent(LAY_FLAT_COMMITTED_EVENT, { detail: false }));

    d.reject(new Error('boom from a superseded run'));
    await runPromise;

    const errorArgsAfter = button.setError.mock.calls.slice(errorCallsBefore).map((c) => c[0]);
    for (const v of errorArgsAfter) {
      expect(v).toBeNull();
    }

    detach();
  });
});

describe('generateOrchestrator — scene hand-off', () => {
  test('happy path with scene sink: silicone is handed off, orchestrator does NOT .delete()', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<MoldGenerationResult>();
    const sceneSetSilicone = vi
      .fn<(payload: { silicone: Manifold }) => Promise<{ bbox: unknown }>>()
      .mockResolvedValue({ bbox: { min: [0, 0, 0], max: [1, 1, 1] } });
    const onSiliconeInstalled = vi.fn<(result: unknown) => void>();

    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: () => d.promise,
      topbar,
      button,
      scene: { setSilicone: sceneSetSilicone },
      onSiliconeInstalled,
      logger: { error: () => {} },
    });

    const runPromise = orchestrator.run();
    const result = makeResult();
    d.resolve(result);
    await runPromise;

    expect(sceneSetSilicone).toHaveBeenCalledTimes(1);
    expect(sceneSetSilicone).toHaveBeenCalledWith({
      silicone: result.silicone,
    });
    // Ownership transferred → orchestrator does NOT .delete() silicone.
    expect(result.silicone.delete).not.toHaveBeenCalled();
    // No printable-parts sink → orchestrator disposes BOTH print-shell
    // and base-slab (Wave D).
    for (const p of result.shellPieces) {
      expect(p.delete).toHaveBeenCalledTimes(1);
    }
    expect(result.basePart.delete).toHaveBeenCalledTimes(1);
    expect(onSiliconeInstalled).toHaveBeenCalledTimes(1);
    expect(onSiliconeInstalled).toHaveBeenCalledWith({
      bbox: { min: [0, 0, 0], max: [1, 1, 1] },
    });
    expect(topbar.setSiliconeVolume).toHaveBeenCalledWith(STALE_SILICONE_MM3);
    expect(topbar.setResinVolume).toHaveBeenCalledWith(STALE_RESIN_MM3);
    expect(topbar.setPrintShellVolume).toHaveBeenCalledWith(STALE_PRINT_SHELL_MM3);
    expect(topbar.setBaseSlabVolume).toHaveBeenCalledWith(STALE_BASE_SLAB_MM3);
  });

  test('stale drop still .delete()s every Manifold even with scene sink wired', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<MoldGenerationResult>();
    const sceneSetSilicone =
      vi.fn<(payload: { silicone: Manifold }) => Promise<unknown>>();

    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: () => d.promise,
      topbar,
      button,
      scene: { setSilicone: sceneSetSilicone },
      logger: { error: () => {} },
    });

    const runPromise = orchestrator.run();

    const { bumpGenerateEpoch } = await import('@/renderer/ui/generateEpoch');
    bumpGenerateEpoch();

    const result = makeResult();
    d.resolve(result);
    await runPromise;

    expect(result.silicone.delete).toHaveBeenCalledTimes(1);
    for (const p of result.shellPieces) {
      expect(p.delete).toHaveBeenCalledTimes(1);
    }
    expect(result.basePart.delete).toHaveBeenCalledTimes(1);
    expect(sceneSetSilicone).not.toHaveBeenCalled();
  });

  test('scene.setSilicone rejection surfaces via button.setError', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<MoldGenerationResult>();
    const sceneSetSilicone = vi
      .fn<(payload: { silicone: Manifold }) => Promise<unknown>>()
      .mockRejectedValue(new Error('adapter boom'));

    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: () => d.promise,
      topbar,
      button,
      scene: { setSilicone: sceneSetSilicone },
      logger: { error: () => {} },
    });

    const runPromise = orchestrator.run();
    d.resolve(makeResult());
    await runPromise;

    expect(button.setError).toHaveBeenLastCalledWith('adapter boom');
    expect(button.setBusy).toHaveBeenLastCalledWith(false);
  });
});

describe('generateOrchestrator — pre-flight failures', () => {
  test('missing master surfaces an error without raising busy', async () => {
    const { topbar, button } = makeMocks();
    const orchestrator = createGenerateOrchestrator({
      getMaster: () => null,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: () => {
        throw new Error('generate should not be called');
      },
      topbar,
      button,
      logger: { error: () => {} },
    });

    await orchestrator.run();

    expect(button.setError).toHaveBeenCalledWith('No master mesh loaded');
    expect(button.setBusy).not.toHaveBeenCalled();
    expect(topbar.setSiliconeVolume).not.toHaveBeenCalled();
  });

  test('missing view transform surfaces an error without raising busy', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => null,
      generate: () => {
        throw new Error('generate should not be called');
      },
      topbar,
      button,
      logger: { error: () => {} },
    });

    await orchestrator.run();

    expect(button.setError).toHaveBeenCalledWith('Master group missing from scene');
    expect(button.setBusy).not.toHaveBeenCalled();
  });
});

describe('generateOrchestrator — error path', () => {
  test('live rejection surfaces error and clears busy', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: () => Promise.reject(new Error('silicone too thin')),
      topbar,
      button,
      logger: { error: () => {} },
    });

    await orchestrator.run();

    expect(button.setError).toHaveBeenLastCalledWith('silicone too thin');
    expect(button.setBusy).toHaveBeenLastCalledWith(false);
    const siliconeArgs = topbar.setSiliconeVolume.mock.calls.map((c) => c[0]);
    for (const v of siliconeArgs) expect(v).toBeNull();
  });
});

describe('generateOrchestrator — print-shell + base-slab disposal', () => {
  // The orchestrator is the sole owner of the print shell AND the base
  // slab (Wave D, issue #82) when the scene sink doesn't supply
  // `setPrintableParts`. Every path that sees a `MoldGenerationResult`
  // without the sink MUST `.delete()` both, or we leak WASM heap.

  test('happy path (volume-only) disposes the print shell + base slab', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<MoldGenerationResult>();
    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: () => d.promise,
      topbar,
      button,
      logger: { error: () => {} },
    });

    const runPromise = orchestrator.run();
    const result = makeResult();
    d.resolve(result);
    await runPromise;

    for (const p of result.shellPieces) {
      expect(p.delete).toHaveBeenCalledTimes(1);
    }
    expect(result.basePart.delete).toHaveBeenCalledTimes(1);
  });

  test('happy path with only setSilicone sink still disposes the print shell + base slab', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<MoldGenerationResult>();
    const sceneSetSilicone = vi
      .fn<(payload: { silicone: Manifold }) => Promise<unknown>>()
      .mockResolvedValue({ bbox: { min: [0, 0, 0], max: [1, 1, 1] } });

    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: () => d.promise,
      topbar,
      button,
      scene: { setSilicone: sceneSetSilicone },
      logger: { error: () => {} },
    });

    const runPromise = orchestrator.run();
    const result = makeResult();
    d.resolve(result);
    await runPromise;

    expect(result.silicone.delete).not.toHaveBeenCalled();
    for (const p of result.shellPieces) {
      expect(p.delete).toHaveBeenCalledTimes(1);
    }
    expect(result.basePart.delete).toHaveBeenCalledTimes(1);
  });

  test('stale-drop path disposes silicone AND the print shell AND the base slab', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<MoldGenerationResult>();
    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: () => d.promise,
      topbar,
      button,
      logger: { error: () => {} },
    });

    const runPromise = orchestrator.run();

    const { bumpGenerateEpoch } = await import('@/renderer/ui/generateEpoch');
    bumpGenerateEpoch();

    const result = makeResult();
    d.resolve(result);
    await runPromise;

    expect(result.silicone.delete).toHaveBeenCalledTimes(1);
    for (const p of result.shellPieces) {
      expect(p.delete).toHaveBeenCalledTimes(1);
    }
    expect(result.basePart.delete).toHaveBeenCalledTimes(1);
  });

  test('happy path with BOTH scene sinks hands off every Manifold', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<MoldGenerationResult>();
    const sceneSetSilicone = vi
      .fn<(payload: { silicone: Manifold }) => Promise<unknown>>()
      .mockResolvedValue({ bbox: { min: [0, 0, 0], max: [1, 1, 1] } });
    const sceneSetPrintableParts = vi
      .fn<(parts: { shellPieces: readonly Manifold[]; basePart: Manifold; xzCenter?: { x: number; z: number } }) => Promise<unknown>>()
      .mockResolvedValue({ bbox: { min: [0, 0, 0], max: [1, 1, 1] } });

    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: () => d.promise,
      topbar,
      button,
      scene: {
        setSilicone: sceneSetSilicone,
        setPrintableParts: sceneSetPrintableParts,
      },
      logger: { error: () => {} },
    });

    const runPromise = orchestrator.run();
    const result = makeResult();
    d.resolve(result);
    await runPromise;

    expect(sceneSetSilicone).toHaveBeenCalledTimes(1);
    expect(result.silicone.delete).not.toHaveBeenCalled();

    expect(sceneSetPrintableParts).toHaveBeenCalledTimes(1);
    expect(sceneSetPrintableParts).toHaveBeenCalledWith({
      shellPieces: result.shellPieces,
      basePart: result.basePart,
      // Issue #87 Fix 2: orchestrator forwards the slab thickness
      // through to the scene sink so the viewport can lift the
      // assembly.
      baseSlabThickness_mm: DEFAULT_PARAMETERS.baseSlabThickness_mm,
    });
    for (const p of result.shellPieces) {
      expect(p.delete).not.toHaveBeenCalled();
    }
    expect(result.basePart.delete).not.toHaveBeenCalled();
  });

  test('print-shell sink rejection surfaces via button.setError', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<MoldGenerationResult>();
    const sceneSetSilicone = vi
      .fn<(payload: { silicone: Manifold }) => Promise<unknown>>()
      .mockResolvedValue({ bbox: { min: [0, 0, 0], max: [1, 1, 1] } });
    const sceneSetPrintableParts = vi
      .fn<(parts: { shellPieces: readonly Manifold[]; basePart: Manifold; xzCenter?: { x: number; z: number } }) => Promise<unknown>>()
      .mockRejectedValue(new Error('print-shell adapter boom'));

    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: () => d.promise,
      topbar,
      button,
      scene: {
        setSilicone: sceneSetSilicone,
        setPrintableParts: sceneSetPrintableParts,
      },
      logger: { error: () => {} },
    });

    const runPromise = orchestrator.run();
    d.resolve(makeResult());
    await runPromise;

    expect(sceneSetSilicone).toHaveBeenCalledTimes(1);
    expect(sceneSetPrintableParts).toHaveBeenCalledTimes(1);
    expect(button.setError).toHaveBeenLastCalledWith('print-shell adapter boom');
    expect(button.setBusy).toHaveBeenLastCalledWith(false);
  });
});

describe('generateOrchestrator — progress status (issue #87 Fix 1)', () => {
  test('forwards every onPhase call through status.setPhase with translated labels', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const status = {
      setPhase: vi.fn<(label: string | null) => void>(),
    };
    const translatePhase = vi.fn<(key: string) => string>((k) => `label:${k}`);

    // Fake generate that walks through each phase, awaiting onPhase.
    const generate = async (
      _m: Manifold,
      _p: MoldParameters,
      _t: Matrix4,
      onPhase?: (k: string) => void | Promise<void>,
    ): Promise<MoldGenerationResult> => {
      if (onPhase) {
        await onPhase('silicone');
        await onPhase('shell');
        await onPhase('slicing');
        await onPhase('brims');
        await onPhase('slab');
      }
      return makeResult();
    };

    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: generate as GenerateOrchestratorDeps['generate'],
      topbar,
      button,
      status,
      translatePhase,
      logger: { error: () => {} },
    });

    await orchestrator.run();

    // Every phase translated + forwarded through the sink.
    expect(translatePhase).toHaveBeenCalledWith('silicone');
    expect(translatePhase).toHaveBeenCalledWith('shell');
    expect(translatePhase).toHaveBeenCalledWith('slicing');
    expect(translatePhase).toHaveBeenCalledWith('brims');
    expect(translatePhase).toHaveBeenCalledWith('slab');
    expect(status.setPhase).toHaveBeenCalledWith('label:silicone');
    expect(status.setPhase).toHaveBeenCalledWith('label:shell');
    expect(status.setPhase).toHaveBeenCalledWith('label:slicing');
    expect(status.setPhase).toHaveBeenCalledWith('label:brims');
    expect(status.setPhase).toHaveBeenCalledWith('label:slab');
    // Final setPhase(null) fires on the happy-path terminal branch.
    expect(status.setPhase).toHaveBeenLastCalledWith(null);
  });

  test('setPhase(null) fires on generate rejection', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const status = {
      setPhase: vi.fn<(label: string | null) => void>(),
    };
    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: () => Promise.reject(new Error('boom')),
      topbar,
      button,
      status,
      logger: { error: () => {} },
    });

    await orchestrator.run();

    expect(status.setPhase).toHaveBeenLastCalledWith(null);
  });

  test('setPhase(null) fires on stale-drop', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<MoldGenerationResult>();
    const status = {
      setPhase: vi.fn<(label: string | null) => void>(),
    };
    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: () => d.promise,
      topbar,
      button,
      status,
      logger: { error: () => {} },
    });

    const runPromise = orchestrator.run();
    const { bumpGenerateEpoch } = await import('@/renderer/ui/generateEpoch');
    bumpGenerateEpoch(); // make current run stale
    d.resolve(makeResult());
    await runPromise;

    expect(status.setPhase).toHaveBeenLastCalledWith(null);
  });

  test('generate runs without onPhase when status is not wired', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const capturedOnPhase = vi.fn();

    const generate = (
      _m: Manifold,
      _p: MoldParameters,
      _t: Matrix4,
      onPhase?: (k: string) => void | Promise<void>,
    ): Promise<MoldGenerationResult> => {
      capturedOnPhase(onPhase);
      return Promise.resolve(makeResult());
    };

    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: generate as GenerateOrchestratorDeps['generate'],
      topbar,
      button,
      logger: { error: () => {} },
    });

    await orchestrator.run();

    expect(capturedOnPhase).toHaveBeenCalledWith(undefined);
  });
});

describe('generateOrchestrator — degenerate-slab notice (issue #93)', () => {
  // Post-generate, when the committed orientation produces an empty /
  // zero-volume base slab (e.g. figurine top-face committed instead of
  // bottom — the Y-min slice is a zero-area cross-section), the
  // orchestrator surfaces a NOTICE-level toast via the injected
  // `showNotice` dep. Fires once per successful run on the happy-path
  // terminal branch only. Stale-drops + error paths skip it.

  /** Build a degenerate result: basePart.isEmpty() returns true + volume 0. */
  function makeDegenerateResult(): MoldGenerationResult {
    const result = makeResult();
    return {
      ...result,
      basePart: fakeManifold(/* isEmpty */ true),
      baseSlabVolume_mm3: 0,
    };
  }

  /**
   * Build a zero-volume-but-NON-empty result. Defence-in-depth check —
   * the orchestrator fires the notice when volume <= 0 too, not only
   * when isEmpty() is true.
   */
  function makeZeroVolumeNonEmptyResult(): MoldGenerationResult {
    const result = makeResult();
    return {
      ...result,
      basePart: fakeManifold(/* isEmpty */ false),
      baseSlabVolume_mm3: 0,
    };
  }

  test('fires showNotice when basePart.isEmpty() is true', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<MoldGenerationResult>();
    const showNotice = vi.fn<(msg: string) => void>();
    const translateWarning = vi.fn<(key: string) => string>(
      (k) => `translated:${k}`,
    );
    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: () => d.promise,
      topbar,
      button,
      showNotice,
      translateWarning,
      logger: { error: () => {} },
    });

    const runPromise = orchestrator.run();
    d.resolve(makeDegenerateResult());
    await runPromise;

    expect(translateWarning).toHaveBeenCalledWith('warnings.degenerateSlab');
    expect(showNotice).toHaveBeenCalledTimes(1);
    expect(showNotice).toHaveBeenCalledWith('translated:warnings.degenerateSlab');
  });

  test('fires showNotice when baseSlabVolume_mm3 <= 0 even if basePart is non-empty', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<MoldGenerationResult>();
    const showNotice = vi.fn<(msg: string) => void>();
    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: () => d.promise,
      topbar,
      button,
      showNotice,
      logger: { error: () => {} },
    });

    const runPromise = orchestrator.run();
    d.resolve(makeZeroVolumeNonEmptyResult());
    await runPromise;

    expect(showNotice).toHaveBeenCalledTimes(1);
    // No translateWarning passed → the raw key is forwarded.
    expect(showNotice).toHaveBeenCalledWith('warnings.degenerateSlab');
  });

  test('does NOT fire showNotice on the happy path (non-degenerate slab)', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<MoldGenerationResult>();
    const showNotice = vi.fn<(msg: string) => void>();
    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: () => d.promise,
      topbar,
      button,
      showNotice,
      logger: { error: () => {} },
    });

    const runPromise = orchestrator.run();
    d.resolve(makeResult()); // healthy default: isEmpty() false + volume > 0
    await runPromise;

    expect(showNotice).not.toHaveBeenCalled();
  });

  test('fires showNotice exactly ONCE per run (not on every internal hop)', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<MoldGenerationResult>();
    const showNotice = vi.fn<(msg: string) => void>();
    // Also wire the scene sinks so the orchestrator walks the full
    // hand-off path — which historically had multiple post-result
    // branches; the notice should still fire once.
    const sceneSetSilicone = vi
      .fn<(payload: { silicone: Manifold }) => Promise<unknown>>()
      .mockResolvedValue({ bbox: null });
    const sceneSetPrintableParts = vi
      .fn<(parts: {
        shellPieces: readonly Manifold[];
        basePart: Manifold;
        xzCenter?: { x: number; z: number };
      }) => Promise<unknown>>()
      .mockResolvedValue({ bbox: null });

    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: () => d.promise,
      topbar,
      button,
      scene: {
        setSilicone: sceneSetSilicone,
        setPrintableParts: sceneSetPrintableParts,
      },
      showNotice,
      logger: { error: () => {} },
    });

    const runPromise = orchestrator.run();
    d.resolve(makeDegenerateResult());
    await runPromise;

    expect(showNotice).toHaveBeenCalledTimes(1);
  });

  test('does NOT fire showNotice on stale-drop even if basePart is degenerate', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<MoldGenerationResult>();
    const showNotice = vi.fn<(msg: string) => void>();
    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: () => d.promise,
      topbar,
      button,
      showNotice,
      logger: { error: () => {} },
    });

    const runPromise = orchestrator.run();
    const { bumpGenerateEpoch } = await import('@/renderer/ui/generateEpoch');
    bumpGenerateEpoch(); // make the in-flight run stale
    d.resolve(makeDegenerateResult());
    await runPromise;

    expect(showNotice).not.toHaveBeenCalled();
  });

  test('does NOT fire showNotice when generate rejects', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const showNotice = vi.fn<(msg: string) => void>();
    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: () => Promise.reject(new Error('boom')),
      topbar,
      button,
      showNotice,
      logger: { error: () => {} },
    });

    await orchestrator.run();

    expect(showNotice).not.toHaveBeenCalled();
  });

  test('showNotice throwing is logged but does NOT break the run', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<MoldGenerationResult>();
    const showNotice = vi.fn<(msg: string) => void>(() => {
      throw new Error('toast sink boom');
    });
    const error = vi.fn<(...args: unknown[]) => void>();
    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: () => d.promise,
      topbar,
      button,
      showNotice,
      logger: { error },
    });

    const runPromise = orchestrator.run();
    d.resolve(makeDegenerateResult());
    await expect(runPromise).resolves.toBeUndefined();

    expect(showNotice).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
    // Busy still cleared on the terminal finally.
    expect(button.setBusy).toHaveBeenLastCalledWith(false);
  });

  test('optional showNotice — omitting it is a no-op even on degenerate slab', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<MoldGenerationResult>();
    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: () => d.promise,
      topbar,
      button,
      // showNotice intentionally omitted
      logger: { error: () => {} },
    });

    const runPromise = orchestrator.run();
    d.resolve(makeDegenerateResult());
    await expect(runPromise).resolves.toBeUndefined();
  });
});

describe('generateOrchestrator — cut overrides (PR B)', () => {
  test('does NOT merge cut fields when overrides are at defaults', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<MoldGenerationResult>();
    const generateSpy = vi
      .fn<
        (
          m: Manifold,
          p: MoldParameters,
          vt: Matrix4,
        ) => Promise<MoldGenerationResult>
      >()
      .mockReturnValue(d.promise);

    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      getCutOverrides: () => ({
        rotation_deg: 0,
        centerOffset_mm: { x: 0, z: 0 },
      }),
      isCutOverridesAtDefaults: () => true,
      generate: generateSpy,
      topbar,
      button,
      logger: { error: () => {} },
    });

    const runPromise = orchestrator.run();
    d.resolve(makeResult());
    await runPromise;

    expect(generateSpy).toHaveBeenCalledTimes(1);
    const [, paramsPassed] = generateSpy.mock.calls[0]!;
    expect(paramsPassed.cutRotation_deg).toBeUndefined();
    expect(paramsPassed.cutCenterOffset_mm).toBeUndefined();
  });

  test('merges cut fields into parameters when overrides are non-default', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<MoldGenerationResult>();
    const generateSpy = vi
      .fn<
        (
          m: Manifold,
          p: MoldParameters,
          vt: Matrix4,
        ) => Promise<MoldGenerationResult>
      >()
      .mockReturnValue(d.promise);

    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      getCutOverrides: () => ({
        rotation_deg: 45,
        centerOffset_mm: { x: 3, z: -2 },
      }),
      isCutOverridesAtDefaults: () => false,
      generate: generateSpy,
      topbar,
      button,
      logger: { error: () => {} },
    });

    const runPromise = orchestrator.run();
    d.resolve(makeResult());
    await runPromise;

    expect(generateSpy).toHaveBeenCalledTimes(1);
    const [, paramsPassed] = generateSpy.mock.calls[0]!;
    expect(paramsPassed.cutRotation_deg).toBe(45);
    expect(paramsPassed.cutCenterOffset_mm).toEqual({ x: 3, z: -2 });
  });

  test('omits cut fields when getCutOverrides is not wired', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<MoldGenerationResult>();
    const generateSpy = vi
      .fn<
        (
          m: Manifold,
          p: MoldParameters,
          vt: Matrix4,
        ) => Promise<MoldGenerationResult>
      >()
      .mockReturnValue(d.promise);

    const orchestrator = createGenerateOrchestrator({
      getMaster: () => master,
      getParameters: () => DEFAULT_PARAMETERS,
      getViewTransform: () => new Matrix4(),
      generate: generateSpy,
      topbar,
      button,
      logger: { error: () => {} },
    });

    const runPromise = orchestrator.run();
    d.resolve(makeResult());
    await runPromise;

    const [, paramsPassed] = generateSpy.mock.calls[0]!;
    expect(paramsPassed.cutRotation_deg).toBeUndefined();
    expect(paramsPassed.cutCenterOffset_mm).toBeUndefined();
  });
});
