// src/geometry/volume.ts
//
// Volume computation. Thin wrapper over `Manifold.volume()` so that call
// sites don't spread the raw WASM API across the codebase and so we keep a
// single place to add validation / logging / caching later if profiling
// warrants it.

import type { Manifold } from 'manifold-3d';

/**
 * Returns the enclosed volume of a manifold in **mm³** (the app's internal
 * unit per ADR-003 §"Units, tolerances, conventions").
 *
 * The underlying `manifold.volume()` is only meaningful on a watertight
 * mesh. If you need a hard guarantee, gate your call on `isManifold(m)`
 * from `./adapters`. We deliberately do NOT throw here — callers doing
 * repeated measurements on intermediate, possibly-empty manifolds want a
 * fast path.
 */
export function meshVolume(manifold: Manifold): number {
  return manifold.volume();
}
