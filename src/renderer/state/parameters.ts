// src/renderer/state/parameters.ts
//
// The single source of truth for mold-generation parameters selected by the
// user in the right sidebar. This module is pure state — no DOM, no i18n,
// no geometry. The Phase 3c mold generator will consume `get()` at the
// moment the user presses the (not-yet-wired) Generate button.
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
// * No runtime dep for state management. The app's vanilla-TS posture
//   matches the topbar + units-toggle modules; introducing Zustand / Redux
//   for ~8 scalar fields would be disproportionate. If, during Phase 3d+,
//   the state graph grows beyond what a plain `Set<listener>` can serve,
//   we'll revisit via ADR.
//
// * Listener semantics. `subscribe(fn)` returns an unsubscribe callable.
//   Listeners fire synchronously inside `update()` / `reset()` after the
//   internal object is replaced. The listener receives the new readonly
//   snapshot; mutating it has no effect on the store (the reference is
//   frozen via `Object.freeze`).
//
// * Ranges from docs/research/molding-techniques.md §6 ("Recommendation
//   for v1 — APPROVED 2026-04-18"). The issue-body numeric table was
//   superseded per the agent clarification posted on #31: the research doc
//   is the authoritative source when the two disagree (and the issue's own
//   instruction says so verbatim). See PR body for details.
//
// * Validation. Ranges live next to the defaults so the panel can render
//   "Out of range (min–max)" error messages and clamp on blur without
//   importing a schema library.

export type RegistrationKeyStyle = 'asymmetric-hemi' | 'cone' | 'keyhole';

export interface MoldParameters {
  /** Silicone wall thickness in mm. */
  wallThickness_mm: number;
  /** Printed base plate thickness in mm. */
  baseThickness_mm: number;
  /** Number of printed side walls: 2, 3, or 4. */
  sideCount: 2 | 3 | 4;
  /** Resin pour-funnel diameter in mm. */
  sprueDiameter_mm: number;
  /** Air-escape vent diameter in mm. */
  ventDiameter_mm: number;
  /** Number of vent channels (auto-placement later). */
  ventCount: number;
  /** Registration-key shape for mating faces. */
  registrationKeyStyle: RegistrationKeyStyle;
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
  /** Integer-only flag (e.g. ventCount). */
  integer: boolean;
}

/**
 * Defaults APPROVED 2026-04-18 at the Phase-0 gate per
 * `docs/research/molding-techniques.md §6`. The issue-31 numeric table
 * conflicted with this doc; the research doc wins (the issue body says so
 * explicitly: "if a doc contradicts the table, the table is wrong").
 *
 * `ventCount` is not specified in the research doc; we keep the issue
 * table's default of 2 and range 0–8.
 */
export const DEFAULT_PARAMETERS: Readonly<MoldParameters> = Object.freeze({
  wallThickness_mm: 10,
  baseThickness_mm: 5,
  sideCount: 4,
  sprueDiameter_mm: 5,
  ventDiameter_mm: 1.5,
  ventCount: 2,
  registrationKeyStyle: 'asymmetric-hemi',
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
    | 'sprueDiameter_mm'
    | 'ventDiameter_mm'
    | 'ventCount'
    | 'draftAngle_deg'
  >, NumericConstraint>
> = Object.freeze({
  wallThickness_mm: { min: 6, max: 25, step: 0.5, integer: false },
  baseThickness_mm: { min: 2, max: 15, step: 0.5, integer: false },
  sprueDiameter_mm: { min: 3, max: 8, step: 0.5, integer: false },
  ventDiameter_mm: { min: 1, max: 3, step: 0.5, integer: false },
  ventCount: { min: 0, max: 8, step: 1, integer: true },
  draftAngle_deg: { min: 0, max: 3, step: 0.5, integer: false },
});

/** Allowed enum values for `sideCount`. */
export const SIDE_COUNT_OPTIONS: ReadonlyArray<2 | 3 | 4> = Object.freeze([
  2, 3, 4,
]);

/** Allowed enum values for `registrationKeyStyle`. */
export const KEY_STYLE_OPTIONS: ReadonlyArray<RegistrationKeyStyle> =
  Object.freeze(['asymmetric-hemi', 'cone', 'keyhole']);

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
    a.sprueDiameter_mm === b.sprueDiameter_mm &&
    a.ventDiameter_mm === b.ventDiameter_mm &&
    a.ventCount === b.ventCount &&
    a.registrationKeyStyle === b.registrationKeyStyle &&
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
        // Log and continue; this matches the behaviour of well-behaved
        // observable implementations.
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
