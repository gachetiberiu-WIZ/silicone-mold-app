// src/renderer/ui/generateEpoch.ts
//
// Shared monotonic counter used to drop stale `generateSiliconeShell` results
// that outlive the inputs they were computed from (issue #40, QA follow-up on
// PR #41).
//
// Two sites bump the counter:
//
//   1. The orchestrator itself (`generateOrchestrator.ts`) at the start of
//      every run — a double-click / rapid re-generate supersedes the earlier
//      run.
//   2. Any *invalidation* trigger that changes the generator's inputs while a
//      run is already in flight. The canonical path is the
//      `LAY_FLAT_COMMITTED_EVENT` listener in `generateInvalidation.ts`
//      (orientation change) and the new-STL-load path in `main.ts`
//      (fresh master).
//
// The bug QA caught: the invalidation listener nulls the topbar readouts but
// did NOT bump the epoch. So if the user committed another face mid-flight
// without clicking Generate again, the first run's resolve still matched
// `epoch === currentEpoch` and overwrote the null placeholder with stale
// numbers. Bumping from the listener closes that race.
//
// The counter is a plain module-level variable behind accessor functions so
// callers cannot accidentally mutate it directly. Tests reset it with
// `__resetGenerateEpochForTests()`.

let currentEpoch = 0;

/**
 * Read the current epoch value. Orchestrator captures this at start-of-run
 * and compares it at resolve-time to detect staleness.
 */
export function getGenerateEpoch(): number {
  return currentEpoch;
}

/**
 * Increment the epoch and return the new value. Callers that start a new run
 * or invalidate an in-flight run both use this — the new value represents
 * "everything with an epoch less than this is stale".
 */
export function bumpGenerateEpoch(): number {
  currentEpoch += 1;
  return currentEpoch;
}

/**
 * Test-only helper: reset the counter to 0 between tests so suite ordering
 * doesn't leak state. Not exported through the public `ui` barrel.
 */
export function __resetGenerateEpochForTests(): void {
  currentEpoch = 0;
}
