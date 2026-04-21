// src/renderer/state/parameters.ts
//
// The single source of truth for mold-generation parameters selected by the
// user in the right sidebar. This module is pure state — no DOM, no i18n,
// no geometry.
//
// Wave-A scope (issue #69) drops the sprue, vent, vent-count, and
// registration-key fields entirely — they belonged to the two-halves-in-box
// strategy that's been replaced by rigid-shell + silicone-glove. The
// remaining four fields — wall thickness, base thickness, side count,
// draft angle — stay in this commit; `wallThickness_mm` is renamed to
// `siliconeThickness_mm` and `baseThickness_mm` to `printShellThickness_mm`
// in a follow-up commit on the same branch so the rename is reviewable
// independently from the deletion.
//
// Design notes
// ------------
//
// * Units policy. Every length field is stored in millimetres, with the
//   `-_mm` suffix on the key making the unit load-bearing at the call site
//   (the sidebar form converts to / from inches purely at the display
//   boundary — see `src/renderer/ui/formatters.ts`). Angles are always
//   degrees.
//
// * Listener semantics. `subscribe(fn)` returns an unsubscribe callable.
//   Listeners fire synchronously inside `update()` / `reset()` after the
//   internal object is replaced. The listener receives the new readonly
//   snapshot; mutating it has no effect on the store (the reference is
//   frozen via `Object.freeze`).
//
// * Validation. Ranges live next to the defaults so the panel can render
//   "Out of range (min–max)" error messages and clamp on blur without
//   importing a schema library.

export interface MoldParameters {
  /** Silicone wall thickness in mm. */
  wallThickness_mm: number;
  /** Printed base plate thickness in mm. */
  baseThickness_mm: number;
  /** Number of printed side walls: 2, 3, or 4. */
  sideCount: 2 | 3 | 4;
  /** Draft angle in degrees. Always unit-agnostic. */
  draftAngle_deg: number;
}

/**
 * Numeric constraint per field. Step is used by the input's `step` attribute
 * for keyboard arrows. All numbers are mm for lengths, degrees for angles.
 */
export interface NumericConstraint {
  min: number;
  max: number;
  step: number;
  integer: boolean;
}

/**
 * Defaults for the Wave-A parameter set. `wallThickness_mm` + `baseThickness_mm`
 * keep their pre-#69 ranges and defaults in this commit; the follow-up
 * Wave-B rename commit shifts them to the new range (silicone 1–15
 * default 5, print-shell 2–30 default 8).
 */
export const DEFAULT_PARAMETERS: Readonly<MoldParameters> = Object.freeze({
  wallThickness_mm: 10,
  baseThickness_mm: 5,
  sideCount: 4,
  draftAngle_deg: 0,
});

/**
 * Numeric constraints for the validators + clamp-on-blur behaviour.
 * Kept alongside the defaults so a single edit here updates both the UI
 * form validation and any downstream consumer that wants to know the
 * legal range.
 */
export const NUMERIC_CONSTRAINTS: Readonly<
  Record<keyof Pick<MoldParameters,
    | 'wallThickness_mm'
    | 'baseThickness_mm'
    | 'draftAngle_deg'
  >, NumericConstraint>
> = Object.freeze({
  wallThickness_mm: { min: 6, max: 25, step: 0.5, integer: false },
  baseThickness_mm: { min: 2, max: 15, step: 0.5, integer: false },
  draftAngle_deg: { min: 0, max: 3, step: 0.5, integer: false },
});

/** Allowed enum values for `sideCount`. */
export const SIDE_COUNT_OPTIONS: ReadonlyArray<2 | 3 | 4> = Object.freeze([
  2, 3, 4,
]);

export type ParametersListener = (
  parameters: Readonly<MoldParameters>,
) => void;

export interface ParametersStore {
  /** Current snapshot. Frozen — mutating it is a no-op. */
  get(): Readonly<MoldParameters>;
  /**
   * Merge a partial patch into the store. Listeners fire synchronously
   * with the new frozen snapshot. Values are trusted — range clamping is
   * the UI layer's responsibility (clamp-on-blur).
   */
  update(patch: Partial<MoldParameters>): void;
  /** Reset every field to its default. Listeners fire. */
  reset(): void;
  /**
   * Subscribe to state changes. Returns an unsubscribe callable. Same
   * listener added twice is de-duplicated (Set semantics).
   */
  subscribe(listener: ParametersListener): () => void;
  /**
   * Whether every field currently equals its default. Used by the panel
   * to disable the "Reset to defaults" button when there is nothing to
   * reset.
   */
  isAtDefaults(): boolean;
}

/**
 * Strict key-by-key equality for parameter snapshots. We intentionally
 * don't import a deep-equal library — the shape is small, flat, and made
 * of primitives, so triple-equals suffices.
 */
function equals(a: MoldParameters, b: MoldParameters): boolean {
  return (
    a.wallThickness_mm === b.wallThickness_mm &&
    a.baseThickness_mm === b.baseThickness_mm &&
    a.sideCount === b.sideCount &&
    a.draftAngle_deg === b.draftAngle_deg
  );
}

/**
 * Construct a parameters store. `initial` is shallow-merged over the
 * defaults. Useful for tests; the app wires `createParametersStore()`
 * with no argument.
 */
export function createParametersStore(
  initial?: Partial<MoldParameters>,
): ParametersStore {
  let current: Readonly<MoldParameters> = Object.freeze({
    ...DEFAULT_PARAMETERS,
    ...(initial ?? {}),
  });
  const listeners = new Set<ParametersListener>();

  const notify = (): void => {
    for (const listener of listeners) {
      try {
        listener(current);
      } catch (err) {
        // A single bad subscriber should not break the store for others.
        console.error('[parameters] listener threw:', err);
      }
    }
  };

  return {
    get(): Readonly<MoldParameters> {
      return current;
    },
    update(patch: Partial<MoldParameters>): void {
      const next = Object.freeze({ ...current, ...patch }) as Readonly<MoldParameters>;
      if (equals(current, next)) return;
      current = next;
      notify();
    },
    reset(): void {
      const next = Object.freeze({ ...DEFAULT_PARAMETERS });
      if (equals(current, next)) return;
      current = next;
      notify();
    },
    subscribe(listener: ParametersListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isAtDefaults(): boolean {
      return equals(current, DEFAULT_PARAMETERS);
    },
  };
}
