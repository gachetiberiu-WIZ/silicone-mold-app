// tests/renderer/ui/generateOrchestrator.test.ts
//
// @vitest-environment happy-dom
//
// Race-condition unit test for the Generate-mold orchestrator (QA follow-up
// on PR #41, blocker 2). Drives the exact sequence that the in-flight
// staleness guard must protect against:
//
//   1. `orchestrator.run()` starts — captures `epoch = bumpGenerateEpoch()`,
//      flips the button busy, clears the topbar, and awaits a generator
//      promise that we hand-control with a deferred.
//   2. WHILE the promise is still pending, fire
//      `LAY_FLAT_COMMITTED_EVENT` — the `attachGenerateInvalidation`
//      listener MUST bump the shared epoch. This is the exact bug QA
//      flagged: the listener was nulling the topbar but not bumping, so
//      the stale resolve overwrote the null with the positive value.
//   3. Resolve the deferred with a successful `SiliconeShellResult`.
//   4. Assert the topbar was NEVER handed the stale positive value, the
//      two half-Manifolds were still `.delete()`'d (no WASM leak), the
//      error was NOT shown (stale error is swallowed), and `setBusy(false)`
//      did NOT fire on the finally (a later run — real or conceptual —
//      owns busy).
//
// The orchestrator is fully injectable: we mock the generator as a
// deferred promise, mock the topbar + button with `vi.fn()` spies, and
// drive the epoch bump via the real `attachGenerateInvalidation` listener
// so the test catches the full wired-up behaviour, not just the
// orchestrator in isolation.

import type { Manifold } from 'manifold-3d';
import { Matrix4 } from 'three';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { SiliconeShellResult } from '@/geometry/generateMold';
import { LAY_FLAT_COMMITTED_EVENT } from '@/renderer/scene/layFlatController';
import {
  __resetGenerateEpochForTests,
  getGenerateEpoch,
} from '@/renderer/ui/generateEpoch';
import { attachGenerateInvalidation } from '@/renderer/ui/generateInvalidation';
import { createGenerateOrchestrator } from '@/renderer/ui/generateOrchestrator';
import { DEFAULT_PARAMETERS } from '@/renderer/state/parameters';

/**
 * Build a hand-resolvable promise so the test can interleave the
 * orchestrator's await with an invalidation event. Returns the promise
 * + the `resolve` / `reject` callbacks.
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
  };
  const button = {
    setBusy: vi.fn<(v: boolean) => void>(),
    setError: vi.fn<(v: string | null) => void>(),
    // Satisfy the `InvalidationGenerateButton` surface that
    // `attachGenerateInvalidation` expects. Not relevant to the
    // orchestrator itself.
    setEnabled: vi.fn<(v: boolean) => void>(),
  };
  return { topbar, button };
}

/**
 * Sentinel value the stale test asserts was NEVER pushed to the topbar.
 * A large, distinctive number so failure messages are unambiguous.
 */
const STALE_SILICONE_MM3 = 319_914;
const STALE_RESIN_MM3 = 127_452;

function makeResult(): SiliconeShellResult {
  // We only care about `.delete()` being called — the actual Manifold
  // shape isn't exercised. Spy the delete so the test can assert it.
  const upperDelete = vi.fn<() => void>();
  const lowerDelete = vi.fn<() => void>();
  const upper = { delete: upperDelete } as unknown as Manifold;
  const lower = { delete: lowerDelete } as unknown as Manifold;
  return {
    siliconeUpperHalf: upper,
    siliconeLowerHalf: lower,
    siliconeVolume_mm3: STALE_SILICONE_MM3,
    resinVolume_mm3: STALE_RESIN_MM3,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  __resetGenerateEpochForTests();
});

describe('generateOrchestrator — happy path', () => {
  test('pushes volumes to the topbar and disposes halves on success', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<SiliconeShellResult>();
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

    // Start-of-run contract: busy=true, topbar cleared to null, error cleared.
    expect(button.setBusy).toHaveBeenCalledWith(true);
    expect(button.setError).toHaveBeenCalledWith(null);
    expect(topbar.setSiliconeVolume).toHaveBeenNthCalledWith(1, null);
    expect(topbar.setResinVolume).toHaveBeenNthCalledWith(1, null);

    const result = makeResult();
    d.resolve(result);
    await runPromise;

    // End-of-run contract: volumes pushed, halves disposed, busy cleared.
    expect(topbar.setSiliconeVolume).toHaveBeenCalledWith(STALE_SILICONE_MM3);
    expect(topbar.setResinVolume).toHaveBeenCalledWith(STALE_RESIN_MM3);
    expect(result.siliconeUpperHalf.delete).toHaveBeenCalledTimes(1);
    expect(result.siliconeLowerHalf.delete).toHaveBeenCalledTimes(1);
    expect(button.setBusy).toHaveBeenLastCalledWith(false);
  });
});

describe('generateOrchestrator — mid-flight LAY_FLAT_COMMITTED_EVENT race (QA blocker 2)', () => {
  test(
    'invalidation bumps epoch; stale resolve drops result WITHOUT overwriting topbar',
    async () => {
      const { topbar, button } = makeMocks();
      const master = {} as Manifold;
      const d = deferred<SiliconeShellResult>();
      const orchestrator = createGenerateOrchestrator({
        getMaster: () => master,
        getParameters: () => DEFAULT_PARAMETERS,
        getViewTransform: () => new Matrix4(),
        generate: () => d.promise,
        topbar,
        button,
        logger: { error: () => {} },
      });

      // Attach the REAL invalidation wire — this is what makes the test
      // catch the missing-epoch-bump bug. Using the real listener (rather
      // than manually bumping) guarantees we exercise the same code path
      // the running app does.
      const detach = attachGenerateInvalidation(topbar, button);

      const epochAtStart = getGenerateEpoch();
      const runPromise = orchestrator.run();

      // Orchestrator's bump-on-start: epoch incremented by exactly one.
      expect(getGenerateEpoch()).toBe(epochAtStart + 1);

      // Snapshot how many times each method was called BEFORE the
      // invalidation so we can diff after.
      const siliconeCallsBefore = topbar.setSiliconeVolume.mock.calls.length;
      const resinCallsBefore = topbar.setResinVolume.mock.calls.length;

      // Fire the commit event — user committed a new face mid-flight.
      // The invalidation listener MUST bump the epoch so the pending
      // resolve below sees it as stale.
      document.dispatchEvent(
        new CustomEvent(LAY_FLAT_COMMITTED_EVENT, { detail: true }),
      );

      // Invalidation contract: epoch bumped again (now start+2), topbar
      // nulled by the listener.
      expect(getGenerateEpoch()).toBe(epochAtStart + 2);
      expect(topbar.setSiliconeVolume).toHaveBeenNthCalledWith(
        siliconeCallsBefore + 1,
        null,
      );
      expect(topbar.setResinVolume).toHaveBeenNthCalledWith(
        resinCallsBefore + 1,
        null,
      );

      // Now resolve the deferred. The orchestrator's staleness guard must
      // drop this result on the floor.
      const result = makeResult();
      d.resolve(result);
      await runPromise;

      // Assertion 1: the topbar was NEVER pushed the stale positive value.
      // Every call to setSiliconeVolume must have been with `null`.
      const siliconeArgs = topbar.setSiliconeVolume.mock.calls.map((c) => c[0]);
      const resinArgs = topbar.setResinVolume.mock.calls.map((c) => c[0]);
      expect(
        siliconeArgs,
        `setSiliconeVolume args: ${JSON.stringify(siliconeArgs)}`,
      ).not.toContain(STALE_SILICONE_MM3);
      expect(
        resinArgs,
        `setResinVolume args: ${JSON.stringify(resinArgs)}`,
      ).not.toContain(STALE_RESIN_MM3);
      // Positive form: the only values seen by the topbar were `null`.
      for (const v of siliconeArgs) expect(v).toBeNull();
      for (const v of resinArgs) expect(v).toBeNull();

      // Assertion 2: both half-Manifolds were still `.delete()`'d so no
      // WASM heap leak on the dropped path.
      expect(result.siliconeUpperHalf.delete).toHaveBeenCalledTimes(1);
      expect(result.siliconeLowerHalf.delete).toHaveBeenCalledTimes(1);

      // Assertion 3: `setBusy(false)` did NOT fire on the finally of the
      // stale run. A later run (real or conceptual) owns the busy flag.
      // `setBusy(true)` was called once at start; `setBusy(false)` must
      // never have been called.
      const busyArgs = button.setBusy.mock.calls.map((c) => c[0]);
      expect(
        busyArgs,
        `setBusy args: ${JSON.stringify(busyArgs)}`,
      ).toEqual([true]);

      detach();
    },
  );

  test('invalidation bumps epoch even when generate rejects (stale error is swallowed)', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<SiliconeShellResult>();
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

    // Snapshot setError calls before the invalidation so we can tell
    // apart the start-of-run `setError(null)` from any stale error.
    const errorCallsBefore = button.setError.mock.calls.length;

    document.dispatchEvent(
      new CustomEvent(LAY_FLAT_COMMITTED_EVENT, { detail: false }),
    );

    d.reject(new Error('boom from a superseded run'));
    await runPromise;

    // The invalidation listener calls `setError(null)` once (clearing any
    // prior error). The stale rejection must NOT surface as a new call
    // with the error message.
    const errorArgsAfter = button.setError.mock.calls
      .slice(errorCallsBefore)
      .map((c) => c[0]);
    for (const v of errorArgsAfter) {
      expect(v).toBeNull();
    }

    detach();
  });
});

describe('generateOrchestrator — scene hand-off (issue #47)', () => {
  test('happy path with scene sink: halves are handed off, orchestrator does NOT .delete()', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<SiliconeShellResult>();
    const sceneSetSilicone = vi.fn<
      (halves: { upper: Manifold; lower: Manifold }) => Promise<{ bbox: unknown }>
    >().mockResolvedValue({ bbox: { min: [0, 0, 0], max: [1, 1, 1] } });
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

    // Scene sink was handed both Manifolds.
    expect(sceneSetSilicone).toHaveBeenCalledTimes(1);
    expect(sceneSetSilicone).toHaveBeenCalledWith({
      upper: result.siliconeUpperHalf,
      lower: result.siliconeLowerHalf,
    });
    // Ownership transferred → orchestrator does NOT .delete().
    expect(result.siliconeUpperHalf.delete).not.toHaveBeenCalled();
    expect(result.siliconeLowerHalf.delete).not.toHaveBeenCalled();
    // Camera re-frame hook fired once with the setSilicone result.
    expect(onSiliconeInstalled).toHaveBeenCalledTimes(1);
    expect(onSiliconeInstalled).toHaveBeenCalledWith({
      bbox: { min: [0, 0, 0], max: [1, 1, 1] },
    });
    // Volumes still push to the topbar on the happy path.
    expect(topbar.setSiliconeVolume).toHaveBeenCalledWith(STALE_SILICONE_MM3);
    expect(topbar.setResinVolume).toHaveBeenCalledWith(STALE_RESIN_MM3);
  });

  test('stale drop still .delete()s the halves even with scene sink wired', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<SiliconeShellResult>();
    const sceneSetSilicone = vi.fn<
      (halves: { upper: Manifold; lower: Manifold }) => Promise<unknown>
    >();

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

    // Force staleness by bumping the shared epoch externally — same
    // technique `attachGenerateInvalidation` uses in production.
    const { bumpGenerateEpoch } = await import(
      '@/renderer/ui/generateEpoch'
    );
    bumpGenerateEpoch();

    const result = makeResult();
    d.resolve(result);
    await runPromise;

    // Staleness drop: halves were .delete()'d and the scene sink was
    // never called (ownership never transferred).
    expect(result.siliconeUpperHalf.delete).toHaveBeenCalledTimes(1);
    expect(result.siliconeLowerHalf.delete).toHaveBeenCalledTimes(1);
    expect(sceneSetSilicone).not.toHaveBeenCalled();
  });

  test('scene.setSilicone rejection surfaces via button.setError', async () => {
    const { topbar, button } = makeMocks();
    const master = {} as Manifold;
    const d = deferred<SiliconeShellResult>();
    // Scene sink REJECTS (geometry-adapter failure). Per the ownership
    // contract, the sink is responsible for having already disposed
    // both half-Manifolds before throwing.
    const sceneSetSilicone = vi.fn<
      (halves: { upper: Manifold; lower: Manifold }) => Promise<unknown>
    >().mockRejectedValue(new Error('adapter boom'));

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
    // Busy cleared on the finally-block.
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

    expect(button.setError).toHaveBeenCalledWith(
      'Master group missing from scene',
    );
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
      generate: () => Promise.reject(new Error('wall thickness too small')),
      topbar,
      button,
      logger: { error: () => {} },
    });

    await orchestrator.run();

    expect(button.setError).toHaveBeenLastCalledWith('wall thickness too small');
    expect(button.setBusy).toHaveBeenLastCalledWith(false);
    // Topbar silicone/resin never populated.
    const siliconeArgs = topbar.setSiliconeVolume.mock.calls.map((c) => c[0]);
    for (const v of siliconeArgs) expect(v).toBeNull();
  });
});
