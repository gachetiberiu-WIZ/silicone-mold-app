// src/geometry/index.ts
//
// Public surface of the geometry module. Downstream code (renderer, main,
// future mold-generator) imports from `@/geometry` only — never from the
// individual files — so we can refactor internals without touching call
// sites.
//
// Per the `mesh-operations` skill, the manifold-3d kernel init is a module-
// level one-shot; we re-export `initManifold` so the app shell can preload
// at startup (ADR-002 §"WASM packaging").

export { initManifold } from './initManifold';
export {
  bufferGeometryToManifold,
  bufferGeometryToManifoldWithRepair,
  manifoldToBufferGeometry,
  isManifold,
  type BufferGeometryToManifoldResult,
} from './adapters';
export { loadStl, type LoadedStl } from './loadStl';
export { meshVolume } from './volume';
export {
  generateSiliconeShell,
  InvalidParametersError,
  type MoldGenerationResult,
} from './generateMold';
export { SIDE_CUT_ANGLES } from './sideAngles';
export { CIRCULAR_SEGMENTS, verticalCylinder } from './primitives';
