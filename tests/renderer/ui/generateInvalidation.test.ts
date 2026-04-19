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

import { beforeEach, describe, expect, test, vi } from 'vitest';

import { LAY_FLAT_COMMITTED_EVENT } from '@/renderer/scene/layFlatController';
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

beforeEach(() => {
  // Each test starts from a blank document so no listeners leak.
  document.body.innerHTML = '';
});

describe('attachGenerateInvalidation — commit (detail=true)', () => {
  test('enables the button and invalidates silicone + resin readouts', () => {
    const { topbar, generateButton } = makeMocks();
    attachGenerateInvalidation(topbar, generateButton);

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
    attachGenerateInvalidation(topbar, generateButton);

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
    attachGenerateInvalidation(topbar, generateButton);

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
    attachGenerateInvalidation(topbar, generateButton);

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
