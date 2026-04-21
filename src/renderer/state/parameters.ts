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
// draft angle — stay in this commit; `siliconeThickness_mm` is renamed to
// `siliconeThickness_mm` and `printShellThickness_mm` to `printShellThickness_mm`
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
  /**
   * Silicone layer thickness in mm. Post-#69 range 1–15, default 5.
   * Replaces the pre-#69 `wallThickness_mm` (range 6–25, default 10).
   */
  siliconeThickness_mm: number;
  /**
   * Printed-shell thickness in mm. Post-#69 range 2–30, default 8.
   * Replaces the pre-#69 `baseThickness_mm` (range 2–15, default 5).
   * The field governs the printed-box wall thickness today; when Wave C
   * lands the surface-conforming shell, this will remain the
   * thickness parameter for the new shell geometry.
   */
  printShellThickness_mm: number;
  /**
   * Base-slab thickness in mm (Wave D, issue #82). The printable base slab
   * that sits under the print shell extrudes downward by this much from
   * `master.min.y`. Range 5–15 mm, default 8 mm.
   */
  baseSlabThickness_mm: number;
  /**
   * Base-slab overhang in mm (Wave D, issue #82). Controls how far the
   * slab sticks out past the print shell's outer footprint. Range 2–10 mm,
   * default 5 mm.
   */
  baseSlabOverhang_mm: number;
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
 * Defaults post-Wave-B rename (issue #69). The user widened the usable
 * range for the silicone layer (thinner silicone prints now that the
 * surface-conforming strategy hugs the master) and the print shell
 * (thicker shell for user mechanical clamps).
 */
export const DEFAULT_PARAMETERS: Readonly<MoldParameters> = Object.freeze({
  siliconeThickness_mm: 5,
  printShellThickness_mm: 8,
  baseSlabThickness_mm: 8,
  baseSlabOverhang_mm: 5,
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
    | 'siliconeThickness_mm'
    | 'printShellThickness_mm'
    | 'baseSlabThickness_mm'
    | 'baseSlabOverhang_mm'
    | 'draftAngle_deg'
  >, NumericConstraint>
> = Object.freeze({
  siliconeThickness_mm: { min: 1, max: 15, step: 0.5, integer: false },
  printShellThickness_mm: { min: 2, max: 30, step: 0.5, integer: false },
  baseSlabThickness_mm: { min: 5, max: 15, step: 0.5, integer: false },
  baseSlabOverhang_mm: { min: 2, max: 10, step: 0.5, integer: false },
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
    a.siliconeThickness_mm === b.siliconeThickness_mm &&
    a.printShellThickness_mm === b.printShellThickness_mm &&
    a.baseSlabThickness_mm === b.baseSlabThickness_mm &&
    a.baseSlabOverhang_mm === b.baseSlabOverhang_mm &&
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
