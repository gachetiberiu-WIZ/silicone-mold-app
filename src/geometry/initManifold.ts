// src/geometry/initManifold.ts
//
// One-shot loader for the manifold-3d WASM kernel. Per ADR-002 §"WASM
// packaging" manifold-3d must be preloaded once — async init latency is
// ~200–500 ms and we never want that on the Generate hot path.
//
// We memoise the `ManifoldToplevel` promise at module scope, so every
// import/call inside the process shares a single WASM instance. The first
// caller pays init; every subsequent caller awaits the same resolved handle.
//
// This file is the ONLY place that should call `Module()` + `setup()`.
// Everything else in `src/geometry/` calls `await initManifold()` and
// destructures the toplevel handles it needs.

import Module, { type ManifoldToplevel } from 'manifold-3d';

let manifoldPromise: Promise<ManifoldToplevel> | undefined;

/**
 * Returns the initialised `ManifoldToplevel` handle. Idempotent — the WASM
 * module is fetched + compiled + `setup()`-ed exactly once per process.
 *
 * Rationale: per the `mesh-operations` skill the kernel is "async init —
 * load once at app start". Module-scope memoisation is the simplest way to
 * enforce that without threading a singleton through every call site.
 */
export function initManifold(): Promise<ManifoldToplevel> {
  if (!manifoldPromise) {
    manifoldPromise = Module().then((mod) => {
      mod.setup();
      return mod;
    });
  }
  return manifoldPromise;
}

/**
 * Test-only escape hatch: forget the cached init so a unit test can simulate
 * a cold start. Do not call from production code paths.
 *
 * @internal
 */
export function __resetManifoldForTests(): void {
  manifoldPromise = undefined;
}
