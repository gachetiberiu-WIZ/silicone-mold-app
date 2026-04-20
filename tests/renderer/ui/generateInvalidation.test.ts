// tests/renderer/ui/generateInvalidation.test.ts
//
// @vitest-environment happy-dom
//
// Unit test for `attachGenerateInvalidation` — the wire between the
// lay-flat controller's `LAY_FLAT_COMMITTED_EVENT` stream and the topbar
// silicone/resin readouts + Generate-mold button (issue #40).
//
// AC: "Unit test: stale-invalidation wiring — mock a lay-flat commit
// event and assert `setSiliconeVolume(null)` was called."
//
// We mock both sides (topbar + generateButton) with vitest `vi.fn()`
// spies, attach the listener, dispatch the event, and assert:
//   - event detail=true  → button.setEnabled(true)  + both volumes → null
//   - event detail=false → button.setEnabled(false) + both volumes → null
//   - error is cleared on every transition
//   - unsubscribe detaches the listener
//   - non-boolean detail is a safe no-op

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { LAY_FLAT_COMMITTED_EVENT } from '@/renderer/scene/layFlatController';
import {
  __resetGenerateEpochForTests,
  getGenerateEpoch,
} from '@/renderer/ui/generateEpoch';
import {
  attachGenerateInvalidation,
  type InvalidationGenerateButton,
  type InvalidationTopbar,
} from '@/renderer/ui/generateInvalidation';

function makeMocks(): {
  topbar: InvalidationTopbar & {
    setSiliconeVolume: ReturnType<typeof vi.fn>;
    setResinVolume: ReturnType<typeof vi.fn>;
  };
  generateButton: InvalidationGenerateButton & {
    setEnabled: ReturnType<typeof vi.fn>;
    setError: ReturnType<typeof vi.fn>;
  };
} {
  const topbar = {
    setSiliconeVolume: vi.fn<(v: number | null) => void>(),
    setResinVolume: vi.fn<(v: number | null) => void>(),
  };
  const generateButton = {
    setEnabled: vi.fn<(v: boolean) => void>(),
    setError: vi.fn<(v: string | null) => void>(),
  };
  return { topbar, generateButton };
}

function dispatchCommittedEvent(detail: unknown): void {
  document.dispatchEvent(
    new CustomEvent(LAY_FLAT_COMMITTED_EVENT, { detail }),
  );
}

/**
 * Per-test detach registry. `attachGenerateInvalidation` binds listeners
 * to `document`, which is a shared singleton across tests in the same
 * happy-dom environment. `document.body.innerHTML=''` in `beforeEach`
 * only wipes DOM children — document-level event listeners leak across
 * tests, which would double-count epoch bumps in the epoch-centric tests.
 * We register each test's attach and detach them all in `afterEach`.
 */
const pendingDetaches: Array<() => void> = [];

function attachAndTrack(
  ...args: Parameters<typeof attachGenerateInvalidation>
): ReturnType<typeof attachGenerateInvalidation> {
  const detach = attachGenerateInvalidation(...args);
  pendingDetaches.push(detach);
  return detach;
}

beforeEach(() => {
  // Each test starts from a blank document so no listeners leak.
  document.body.innerHTML = '';
  __resetGenerateEpochForTests();
});

afterEach(() => {
  // Detach everything registered during the test so document-level
  // listeners don't accumulate across tests.
  while (pendingDetaches.length > 0) {
    const detach = pendingDetaches.pop();
    detach?.();
  }
});

describe('attachGenerateInvalidation — commit (detail=true)', () => {
  test('enables the button and invalidates silicone + resin readouts', () => {
    const { topbar, generateButton } = makeMocks();
    attachAndTrack(topbar, generateButton);

    dispatchCommittedEvent(true);

    expect(generateButton.setEnabled).toHaveBeenCalledWith(true);
    expect(topbar.setSiliconeVolume).toHaveBeenCalledWith(null);
    expect(topbar.setResinVolume).toHaveBeenCalledWith(null);
    expect(generateButton.setError).toHaveBeenCalledWith(null);
  });
});

describe('attachGenerateInvalidation — reset / master-load (detail=false)', () => {
  test('disables the button and invalidates silicone + resin readouts', () => {
    const { topbar, generateButton } = makeMocks();
    attachAndTrack(topbar, generateButton);

    dispatchCommittedEvent(false);

    expect(generateButton.setEnabled).toHaveBeenCalledWith(false);
    expect(topbar.setSiliconeVolume).toHaveBeenCalledWith(null);
    expect(topbar.setResinVolume).toHaveBeenCalledWith(null);
    expect(generateButton.setError).toHaveBeenCalledWith(null);
  });
});

describe('attachGenerateInvalidation — unsubscribe', () => {
  test('returned detach function removes the listener', () => {
    const { topbar, generateButton } = makeMocks();
    const detach = attachGenerateInvalidation(topbar, generateButton);

    detach();

    dispatchCommittedEvent(true);
    expect(generateButton.setEnabled).not.toHaveBeenCalled();
    expect(topbar.setSiliconeVolume).not.toHaveBeenCalled();
    expect(topbar.setResinVolume).not.toHaveBeenCalled();
  });
});

describe('attachGenerateInvalidation — defensive edges', () => {
  test('non-boolean detail is a safe no-op', () => {
    const { topbar, generateButton } = makeMocks();
    attachAndTrack(topbar, generateButton);

    dispatchCommittedEvent('nope');
    dispatchCommittedEvent(undefined);
    dispatchCommittedEvent({ bogus: true });

    expect(generateButton.setEnabled).not.toHaveBeenCalled();
    expect(topbar.setSiliconeVolume).not.toHaveBeenCalled();
    expect(topbar.setResinVolume).not.toHaveBeenCalled();
    expect(generateButton.setError).not.toHaveBeenCalled();
  });

  test('multiple transitions fire independent invalidations', () => {
    const { topbar, generateButton } = makeMocks();
    attachAndTrack(topbar, generateButton);

    dispatchCommittedEvent(true);
    dispatchCommittedEvent(false);
    dispatchCommittedEvent(true);

    expect(generateButton.setEnabled).toHaveBeenCalledTimes(3);
    expect(topbar.setSiliconeVolume).toHaveBeenCalledTimes(3);
    expect(topbar.setResinVolume).toHaveBeenCalledTimes(3);
    expect(topbar.setSiliconeVolume).toHaveBeenNthCalledWith(1, null);
    expect(topbar.setSiliconeVolume).toHaveBeenNthCalledWith(2, null);
    expect(topbar.setSiliconeVolume).toHaveBeenNthCalledWith(3, null);
  });
});

describe('attachGenerateInvalidation — epoch bump (QA blocker 2)', () => {
  test('bumps the shared generate-epoch on every valid commit event', () => {
    const { topbar, generateButton } = makeMocks();
    attachAndTrack(topbar, generateButton);

    // `beforeEach` resets the counter to 0 and `afterEach` detaches all
    // listeners from prior tests — so the starting epoch is deterministic.
    const startEpoch = getGenerateEpoch();

    dispatchCommittedEvent(true);
    expect(getGenerateEpoch()).toBe(startEpoch + 1);

    dispatchCommittedEvent(false);
    expect(getGenerateEpoch()).toBe(startEpoch + 2);

    dispatchCommittedEvent(true);
    expect(getGenerateEpoch()).toBe(startEpoch + 3);
  });

  test('non-boolean detail does NOT bump the epoch', () => {
    const { topbar, generateButton } = makeMocks();
    attachAndTrack(topbar, generateButton);

    const startEpoch = getGenerateEpoch();
    dispatchCommittedEvent('nope');
    dispatchCommittedEvent(undefined);
    dispatchCommittedEvent({ bogus: true });

    expect(getGenerateEpoch()).toBe(startEpoch);
  });

  test('custom `bumpEpoch` option is called instead of the default', () => {
    const { topbar, generateButton } = makeMocks();
    const bumpEpoch = vi.fn<() => number>().mockReturnValue(42);
    attachAndTrack(topbar, generateButton, { bumpEpoch });

    const startEpoch = getGenerateEpoch();
    dispatchCommittedEvent(true);

    expect(bumpEpoch).toHaveBeenCalledTimes(1);
    // The shared counter is NOT touched when the override is used.
    expect(getGenerateEpoch()).toBe(startEpoch);
  });
});

describe('attachGenerateInvalidation — clearSilicone hook (issue #47)', () => {
  test('calls clearSilicone on every valid commit event', () => {
    const { topbar, generateButton } = makeMocks();
    const clearSilicone = vi.fn<() => void>();
    attachAndTrack(topbar, generateButton, { clearSilicone });

    dispatchCommittedEvent(true);
    expect(clearSilicone).toHaveBeenCalledTimes(1);

    dispatchCommittedEvent(false);
    expect(clearSilicone).toHaveBeenCalledTimes(2);

    dispatchCommittedEvent(true);
    expect(clearSilicone).toHaveBeenCalledTimes(3);
  });

  test('does NOT call clearSilicone on non-boolean detail', () => {
    const { topbar, generateButton } = makeMocks();
    const clearSilicone = vi.fn<() => void>();
    attachAndTrack(topbar, generateButton, { clearSilicone });

    dispatchCommittedEvent('nope');
    dispatchCommittedEvent(undefined);
    dispatchCommittedEvent({ bogus: true });

    expect(clearSilicone).not.toHaveBeenCalled();
  });

  test('clearSilicone is optional — absence does not throw', () => {
    const { topbar, generateButton } = makeMocks();
    attachAndTrack(topbar, generateButton);
    expect(() => dispatchCommittedEvent(true)).not.toThrow();
  });
});

describe('attachGenerateInvalidation — generated/stale reset (issue #64)', () => {
  // Staleness signals (orientation commit, reset, new STL load) must
  // clear the Generate button's `generated` + `stale` flags so the hint
  // falls back to the base "Ready to generate" / "Orient first" /
  // "Load STL" selector. Without this, a "Generated — click to re-run..."
  // hint could linger after the user committed a new face, which would
  // confuse the state machine.
  test('calls setGenerated(false) + setStale(false) on every valid commit event', () => {
    const topbar = {
      setSiliconeVolume: vi.fn<(v: number | null) => void>(),
      setResinVolume: vi.fn<(v: number | null) => void>(),
    };
    const generateButton = {
      setEnabled: vi.fn<(v: boolean) => void>(),
      setError: vi.fn<(v: string | null) => void>(),
      setGenerated: vi.fn<(v: boolean) => void>(),
      setStale: vi.fn<(v: boolean) => void>(),
    };
    attachAndTrack(topbar, generateButton);

    dispatchCommittedEvent(true);

    expect(generateButton.setGenerated).toHaveBeenCalledWith(false);
    expect(generateButton.setStale).toHaveBeenCalledWith(false);

    dispatchCommittedEvent(false);

    expect(generateButton.setGenerated).toHaveBeenCalledTimes(2);
    expect(generateButton.setStale).toHaveBeenCalledTimes(2);
  });

  test('does NOT call setGenerated / setStale on non-boolean detail', () => {
    const topbar = {
      setSiliconeVolume: vi.fn<(v: number | null) => void>(),
      setResinVolume: vi.fn<(v: number | null) => void>(),
    };
    const generateButton = {
      setEnabled: vi.fn<(v: boolean) => void>(),
      setError: vi.fn<(v: string | null) => void>(),
      setGenerated: vi.fn<(v: boolean) => void>(),
      setStale: vi.fn<(v: boolean) => void>(),
    };
    attachAndTrack(topbar, generateButton);

    dispatchCommittedEvent('nope');
    dispatchCommittedEvent(undefined);

    expect(generateButton.setGenerated).not.toHaveBeenCalled();
    expect(generateButton.setStale).not.toHaveBeenCalled();
  });

  test('setGenerated / setStale are optional — absence does not throw (legacy button mocks)', () => {
    // Pre-#64 `InvalidationGenerateButton` implementations don't have
    // these methods. The listener must guard-call them so existing
    // unit tests (and any future call site that only stubs the minimal
    // surface) don't blow up.
    const { topbar, generateButton } = makeMocks();
    attachAndTrack(topbar, generateButton);
    expect(() => dispatchCommittedEvent(true)).not.toThrow();
  });
});

describe('attachGenerateInvalidation — clearPrintableParts hook (issue #62)', () => {
  test('calls clearPrintableParts on every valid commit event', () => {
    const { topbar, generateButton } = makeMocks();
    const clearPrintableParts = vi.fn<() => void>();
    attachAndTrack(topbar, generateButton, { clearPrintableParts });

    dispatchCommittedEvent(true);
    expect(clearPrintableParts).toHaveBeenCalledTimes(1);

    dispatchCommittedEvent(false);
    expect(clearPrintableParts).toHaveBeenCalledTimes(2);
  });

  test('does NOT call clearPrintableParts on non-boolean detail', () => {
    const { topbar, generateButton } = makeMocks();
    const clearPrintableParts = vi.fn<() => void>();
    attachAndTrack(topbar, generateButton, { clearPrintableParts });

    dispatchCommittedEvent('nope');
    expect(clearPrintableParts).not.toHaveBeenCalled();
  });

  test('clearPrintableParts is called alongside clearSilicone when both supplied', () => {
    // Verifies the issue #62 AC that the two cleanup paths fire as a
    // single atomic step from the invalidation listener's perspective.
    const { topbar, generateButton } = makeMocks();
    const clearSilicone = vi.fn<() => void>();
    const clearPrintableParts = vi.fn<() => void>();
    attachAndTrack(topbar, generateButton, {
      clearSilicone,
      clearPrintableParts,
    });

    dispatchCommittedEvent(true);

    expect(clearSilicone).toHaveBeenCalledTimes(1);
    expect(clearPrintableParts).toHaveBeenCalledTimes(1);
  });

  test('clearPrintableParts is optional — absence does not throw', () => {
    const { topbar, generateButton } = makeMocks();
    attachAndTrack(topbar, generateButton);
    expect(() => dispatchCommittedEvent(true)).not.toThrow();
  });
});
