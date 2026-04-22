// src/renderer/state/cutOverrides.ts
//
// State slice for the cut-planes preview gizmo (dogfood round 7).
//
// Mirrors the `parameters.ts` store pattern:
//   - frozen snapshot as the canonical truth
//   - subscribe(fn) returns an unsubscribe, listeners receive the snapshot
//   - synchronous notification, dedup via no-op when values unchanged
//
// Two fields:
//   - `rotation_deg`    : cut-plane rotation around the vertical axis,
//                         normalised to [0, 360), default 0.
//   - `centerOffset_mm` : XZ offset applied to the master's bbox XZ
//                         center before rotating the cut-plane set.
//                         Default `{x: 0, z: 0}`.
//
// Defaults are a no-op — `isAtDefaults()` returns `true`, and the
// orchestrator skips threading the optional `cutRotation_deg` +
// `cutCenterOffset_mm` fields into the `MoldParameters` payload so
// callers that never touch the cut-planes gizmo see PR-A's original
// behaviour unchanged (empty object merges).

/** Canonical shape of the cut-overrides store. */
export interface CutOverrides {
  /** Rotation in degrees around the vertical axis, normalised to [0, 360). */
  rotation_deg: number;
  /** Center-offset in mm, XZ plane (Y-up viewer, Y is vertical). */
  centerOffset_mm: { x: number; z: number };
}

/** Default cut-overrides — both fields at zero means "no override". */
export const DEFAULT_CUT_OVERRIDES: Readonly<CutOverrides> = Object.freeze({
  rotation_deg: 0,
  centerOffset_mm: Object.freeze({ x: 0, z: 0 }),
}) as Readonly<CutOverrides>;

export type CutOverridesListener = (value: Readonly<CutOverrides>) => void;

export interface CutOverridesStore {
  /** Current snapshot. Frozen — mutating has no effect. */
  get(): Readonly<CutOverrides>;
  /** Set the rotation (degrees). Auto-normalised into [0, 360). */
  setRotation(deg: number): void;
  /** Set the XZ center offset. */
  setCenterOffset(x: number, z: number): void;
  /** Reset both fields to defaults. Listeners fire iff anything actually changed. */
  reset(): void;
  /** Subscribe to changes; returns an unsubscribe callable. */
  subscribe(listener: CutOverridesListener): () => void;
  /** Whether every field currently equals its default. */
  isAtDefaults(): boolean;
}

/**
 * Normalise a degree value into [0, 360). Treats non-finite / NaN as 0
 * (defensive — the UI layer never feeds NaN, but the gizmo callback
 * might once three.js quaternion decomposition has rounding drift).
 */
function normaliseDegrees(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const mod = ((deg % 360) + 360) % 360;
  // The `% 360` above preserves 0 correctly but returns 360 for inputs
  // like -0. Collapse that to the canonical 0 so equality checks behave.
  return mod === 360 ? 0 : mod;
}

/** Guard float inputs: NaN / non-finite collapse to 0. */
function sanitiseFiniteNumber(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

function equals(a: CutOverrides, b: CutOverrides): boolean {
  return (
    a.rotation_deg === b.rotation_deg &&
    a.centerOffset_mm.x === b.centerOffset_mm.x &&
    a.centerOffset_mm.z === b.centerOffset_mm.z
  );
}

/**
 * Build a cut-overrides store. Returns a handle with get/set/reset/
 * subscribe/isAtDefaults — same API surface as `parametersStore`.
 */
export function createCutOverridesStore(): CutOverridesStore {
  let current: Readonly<CutOverrides> = DEFAULT_CUT_OVERRIDES;
  const listeners = new Set<CutOverridesListener>();

  const notify = (): void => {
    for (const listener of listeners) {
      try {
        listener(current);
      } catch (err) {
        // A single bad subscriber shouldn't break the store for others.
        console.error('[cutOverrides] listener threw:', err);
      }
    }
  };

  const commit = (next: CutOverrides): void => {
    const frozen = Object.freeze({
      rotation_deg: next.rotation_deg,
      centerOffset_mm: Object.freeze({
        x: next.centerOffset_mm.x,
        z: next.centerOffset_mm.z,
      }),
    }) as Readonly<CutOverrides>;
    if (equals(current, frozen)) return;
    current = frozen;
    notify();
  };

  return {
    get(): Readonly<CutOverrides> {
      return current;
    },
    setRotation(deg: number): void {
      const normalised = normaliseDegrees(deg);
      commit({
        rotation_deg: normalised,
        centerOffset_mm: {
          x: current.centerOffset_mm.x,
          z: current.centerOffset_mm.z,
        },
      });
    },
    setCenterOffset(x: number, z: number): void {
      commit({
        rotation_deg: current.rotation_deg,
        centerOffset_mm: {
          x: sanitiseFiniteNumber(x),
          z: sanitiseFiniteNumber(z),
        },
      });
    },
    reset(): void {
      commit({
        rotation_deg: DEFAULT_CUT_OVERRIDES.rotation_deg,
        centerOffset_mm: {
          x: DEFAULT_CUT_OVERRIDES.centerOffset_mm.x,
          z: DEFAULT_CUT_OVERRIDES.centerOffset_mm.z,
        },
      });
    },
    subscribe(listener: CutOverridesListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isAtDefaults(): boolean {
      return equals(current, DEFAULT_CUT_OVERRIDES);
    },
  };
}
