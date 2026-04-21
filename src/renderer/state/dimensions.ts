// src/renderer/state/dimensions.ts
//
// The single source of truth for the "Dimensions" sidebar section (issue
// #79). Stores the per-axis scale multipliers the user has applied to the
// loaded master STL, plus the "constrain proportions" checkbox state.
//
// Scope (issue #79): this is NON-destructive scaling. The scale is
// applied at the Master-group transform (`masterGroup.scale.set(sx, sy, sz)`)
// — never baked into `BufferGeometry`. The master's native bbox lives in
// scene state (see `scene/master.ts::getNativeBbox`), so user-visible mm
// readouts in the panel are derived as `nativeBbox × scale[axis]`.
//
// Design notes
// ------------
//
// * Scale-only, no rotation / translation. Those live on the Master group
//   too but are owned by the lay-flat controller (rotation) and the
//   auto-center pass (translation). This slice only covers per-axis
//   scale.
//
// * Constrain-on ratio semantics (Photoshop parity). Editing one axis with
//   constrain ON recomputes the ratio `newVal / oldVal` and scales ALL
//   three axes by that same factor. With constrain OFF only the edited
//   axis changes. Toggling constrain ON after a non-uniform edit
//   preserves the current (non-uniform) ratio — subsequent edits scale
//   the whole tuple proportionally.
//
// * Listener semantics match the parameters store exactly: `subscribe(fn)`
//   returns an unsubscribe callable; listeners fire synchronously after
//   the frozen snapshot is replaced; a listener that throws does NOT break
//   sibling listeners.
//
// * Validation is the UI layer's job. This file only owns pure state +
//   reducers. The sidebar panel applies the 10 %–1000 % uniform-scale cap
//   + derived per-axis bounds at the input edge and calls `update()` with
//   already-clamped values.

/** Percent-scale bounds for the uniform "Scale %" field, per issue #79. */
export const SCALE_PERCENT_MIN = 10;
export const SCALE_PERCENT_MAX = 1000;

/** Per-axis scale multiplier bounds derived from the percent bounds. */
export const AXIS_SCALE_MIN = SCALE_PERCENT_MIN / 100;
export const AXIS_SCALE_MAX = SCALE_PERCENT_MAX / 100;

export interface Dimensions {
  /** Per-axis scale applied to the master group. 1 = native size. */
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  /**
   * When true, editing one axis propagates the implied ratio to the other
   * two axes (Photoshop-style). When false, only the edited axis changes.
   */
  constrainProportions: boolean;
}

/**
 * Defaults: native size (1× scale on every axis), constrain proportions ON.
 * `Object.freeze` mirrors the parameters store pattern so downstream code
 * can hand the reference back to consumers without worrying about mutation.
 */
export const DEFAULT_DIMENSIONS: Readonly<Dimensions> = Object.freeze({
  scaleX: 1,
  scaleY: 1,
  scaleZ: 1,
  constrainProportions: true,
});

export type DimensionsListener = (
  dimensions: Readonly<Dimensions>,
) => void;

export interface DimensionsStore {
  /** Current snapshot. Frozen — mutating it is a no-op. */
  get(): Readonly<Dimensions>;
  /**
   * Merge a partial patch into the store. Listeners fire synchronously
   * with the new frozen snapshot. Values are trusted — clamping is the
   * UI layer's responsibility.
   */
  update(patch: Partial<Dimensions>): void;
  /** Reset every field to its default. Listeners fire. */
  reset(): void;
  /**
   * Subscribe to state changes. Returns an unsubscribe callable. Same
   * listener added twice is de-duplicated (Set semantics).
   */
  subscribe(listener: DimensionsListener): () => void;
  /** Whether every field currently equals its default. */
  isAtDefaults(): boolean;
}

/**
 * Which axis on a `Dimensions` snapshot is being edited. Used by
 * `applyAxisEdit` to locate the old value for ratio computation.
 */
export type DimensionAxis = 'scaleX' | 'scaleY' | 'scaleZ';

/**
 * Pure reducer: given the current snapshot, compute the next snapshot for
 * an axis edit. Exposed for unit testing + reuse from the panel.
 *
 * Constrain ON: compute `ratio = newValue / oldValue` and multiply all
 * three axes by it. Preserves the current (possibly non-uniform) aspect
 * ratio — matching Photoshop's "link chain" behaviour.
 *
 * Constrain OFF: update only the edited axis, leave the other two alone.
 *
 * Edge cases:
 *   - `oldValue` is 0 or non-finite: the ratio would be NaN / Infinity.
 *     We short-circuit to "only the edited axis changes" (constrain
 *     effectively OFF for this edit) so the store never enters a
 *     pathological state. The UI layer should already prevent this by
 *     clamping inputs to `[AXIS_SCALE_MIN, AXIS_SCALE_MAX]`, but guard
 *     defensively here.
 *   - `newValue` non-finite: treat as a no-op.
 */
export function applyAxisEdit(
  current: Readonly<Dimensions>,
  axis: DimensionAxis,
  newValue: number,
): Dimensions {
  if (!Number.isFinite(newValue)) return { ...current };

  const oldValue = current[axis];
  const next: Dimensions = { ...current };
  next[axis] = newValue;

  if (!current.constrainProportions) return next;
  if (!Number.isFinite(oldValue) || oldValue === 0) return next;

  const ratio = newValue / oldValue;
  if (!Number.isFinite(ratio) || ratio === 0) return next;

  // Multiply all three axes by ratio. The edited axis ends up at
  // oldValue × ratio === newValue (identical up to FP round-off, which
  // we accept — the store is the source of truth, not the input box).
  next.scaleX = current.scaleX * ratio;
  next.scaleY = current.scaleY * ratio;
  next.scaleZ = current.scaleZ * ratio;
  return next;
}

/**
 * Pure reducer for the uniform-percent edit (the `Scale %` input).
 * Writes the same multiplier to all three axes regardless of the
 * constrain flag — uniform scale by definition. Keeps `constrainProportions`
 * untouched.
 */
export function applyUniformScale(
  current: Readonly<Dimensions>,
  scale: number,
): Dimensions {
  if (!Number.isFinite(scale)) return { ...current };
  return {
    ...current,
    scaleX: scale,
    scaleY: scale,
    scaleZ: scale,
  };
}

/**
 * Derive a "percent" readout from the current per-axis scale. When the
 * scale is uniform this is trivially `scaleX × 100`. When non-uniform,
 * we use the geometric mean (cube-root of the volume ratio) as the
 * issue's fallback — it matches the volume change the user would see
 * in the generated mold, which is the most useful single-number summary.
 */
export function derivePercentScale(
  dimensions: Readonly<Dimensions>,
): number {
  const { scaleX, scaleY, scaleZ } = dimensions;
  const product = Math.abs(scaleX * scaleY * scaleZ);
  if (!Number.isFinite(product) || product <= 0) return 100;
  return Math.cbrt(product) * 100;
}

/** Strict key-by-key equality for dimension snapshots. */
function equals(a: Dimensions, b: Dimensions): boolean {
  return (
    a.scaleX === b.scaleX &&
    a.scaleY === b.scaleY &&
    a.scaleZ === b.scaleZ &&
    a.constrainProportions === b.constrainProportions
  );
}

/**
 * Construct a dimensions store. `initial` is shallow-merged over the
 * defaults. Matches `createParametersStore` shape byte-for-byte so the
 * main entrypoint wires both the same way.
 */
export function createDimensionsStore(
  initial?: Partial<Dimensions>,
): DimensionsStore {
  let current: Readonly<Dimensions> = Object.freeze({
    ...DEFAULT_DIMENSIONS,
    ...(initial ?? {}),
  });
  const listeners = new Set<DimensionsListener>();

  const notify = (): void => {
    for (const listener of listeners) {
      try {
        listener(current);
      } catch (err) {
        // A single bad subscriber should not break the store for others.
        console.error('[dimensions] listener threw:', err);
      }
    }
  };

  return {
    get(): Readonly<Dimensions> {
      return current;
    },
    update(patch: Partial<Dimensions>): void {
      const next = Object.freeze({ ...current, ...patch }) as Readonly<Dimensions>;
      if (equals(current, next)) return;
      current = next;
      notify();
    },
    reset(): void {
      const next = Object.freeze({ ...DEFAULT_DIMENSIONS });
      if (equals(current, next)) return;
      current = next;
      notify();
    },
    subscribe(listener: DimensionsListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isAtDefaults(): boolean {
      return equals(current, DEFAULT_DIMENSIONS);
    },
  };
}
