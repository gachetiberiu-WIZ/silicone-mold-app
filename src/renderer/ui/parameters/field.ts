// src/renderer/ui/parameters/field.ts
//
// Factory functions that produce the two flavours of parameter input used in
// the right sidebar:
//
//   * NumberField  — numeric input with optional unit suffix, inline error,
//                    and clamp-on-blur semantics. Lengths are unit-aware
//                    (mm / inches); non-length fields (angle, count) use a
//                    `unitSymbol` string rendered next to the input
//                    regardless of the active unit system.
//   * SelectField  — <select> wrapper for `sideCount` (2/3/4) and any
//                    future enum-valued fields.
//
// There is no component framework. The factories return a plain
// `{ element, setValue, setError, destroy, ... }` handle; the sidebar
// panel composes them into a form.
//
// Validation policy
// -----------------
// The sidebar must NOT prevent typing out-of-range values — doing so makes
// the input feel broken when users try to retype a value (e.g. to change
// "8.5" into "12.5" they momentarily need "8" or "1" in the box). Instead
// we surface the range as a visible error the moment the user finishes
// typing a bad value, and on blur we silently clamp to the nearest legal
// value. This matches the UX convention documented in issue #31.

import { t } from '../../i18n';
import type { UnitSystem } from '../../i18n';

/** Length unit category — lengths follow the mm/inches toggle; everything else doesn't. */
export type NumberFieldKind = 'length' | 'angle' | 'count';

export interface NumberFieldConfig {
  /** Stable DOM id, also used as testid suffix. */
  id: string;
  /** Translated label (already passed through i18n). */
  label: string;
  /** Valid range in the INTERNAL unit — mm for lengths, degrees for angles, integer count otherwise. */
  min: number;
  max: number;
  /** Keyboard step. */
  step: number;
  /** Whether values must be integer. No current Wave-A field uses this, but
   *  the factory still honours it for future integer-valued parameters. */
  integer: boolean;
  /** Tells the formatter whether to bridge mm ↔ inches. */
  kind: NumberFieldKind;
  /**
   * Unit suffix displayed next to the input. For 'length' fields this is
   * `null` — the panel driver updates the suffix from the active unit
   * system. For 'angle' we always show `°`. For 'count' we omit the suffix.
   */
  unitSymbol: string | null;
  /** Initial value in the INTERNAL unit (mm for lengths, deg for angle, int for count). */
  initial: number;
  /** Callback fired when the user has committed a legal value (on blur / change). */
  onCommit(internalValue: number): void;
}

export interface NumberFieldHandle {
  /** The outermost <div> wrapping label + input + error. */
  readonly element: HTMLDivElement;
  /**
   * Programmatically set the value. Used (a) when the topbar flips units
   * so length fields redisplay, and (b) when the user clicks "Reset to
   * defaults". The value is in the internal unit; the field renders it
   * through the configured formatter.
   */
  setValue(internalValue: number): void;
  /** Display (or clear) an inline error message. */
  setError(message: string | null): void;
  /** For length fields only: switch the displayed unit system. */
  setUnitSystem(unit: UnitSystem): void;
  /** Detach listeners. */
  destroy(): void;
}

export interface SelectFieldOption<V extends string> {
  /** Stable value, e.g. "asymmetric-hemi" or "4". */
  value: V;
  /** Translated label. */
  label: string;
}

export interface SelectFieldConfig<V extends string> {
  id: string;
  label: string;
  options: ReadonlyArray<SelectFieldOption<V>>;
  initial: V;
  onChange(value: V): void;
}

export interface SelectFieldHandle<V extends string> {
  readonly element: HTMLDivElement;
  setValue(value: V): void;
  destroy(): void;
}

// ----------------------------------------------------------------------------
// Formatting bridge
//
// We intentionally import `formatLength` / `parseLength` only for the length
// branch so Vitest tests of angle/count fields don't need the units toggle.
// `kind === 'angle' | 'count'` uses the raw internal number for display.
// ----------------------------------------------------------------------------

import { formatLength, parseLength } from '../formatters';

/** Convert an internal value to input-box text for the current unit system. */
function renderValue(
  internalValue: number,
  kind: NumberFieldKind,
  unitSystem: UnitSystem,
  integer: boolean,
): string {
  if (!Number.isFinite(internalValue)) return '';
  if (kind === 'length') return formatLength(internalValue, unitSystem);
  if (integer) return String(Math.round(internalValue));
  // Angle: always degrees, one decimal place.
  return internalValue.toFixed(1);
}

/** Parse input-box text into an internal-unit value, or NaN on failure. */
function parseValue(
  text: string,
  kind: NumberFieldKind,
  unitSystem: UnitSystem,
  integer: boolean,
): number {
  if (kind === 'length') return parseLength(text, unitSystem);
  const trimmed = text.trim().replace(',', '.');
  if (trimmed === '') return Number.NaN;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return Number.NaN;
  if (integer) return Math.trunc(n);
  return n;
}

/** True when `internalValue` is inside the legal `[min, max]` range. */
function inRange(internalValue: number, min: number, max: number): boolean {
  return (
    Number.isFinite(internalValue) &&
    internalValue >= min &&
    internalValue <= max
  );
}

/** Clamp `n` into `[min, max]`, returning `min` when `n` is non-finite. */
function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/**
 * Build a numeric field. The returned element renders:
 *
 *   <div class="param-field">
 *     <label for="..."><span>label</span><span class="param-field__unit"/></label>
 *     <input type="number" ... />
 *     <small class="param-field__error" role="alert" hidden>...</small>
 *   </div>
 */
export function createNumberField(
  config: NumberFieldConfig,
): NumberFieldHandle {
  const {
    id,
    label,
    min,
    max,
    step,
    integer,
    kind,
    unitSymbol,
    initial,
    onCommit,
  } = config;

  const wrap = document.createElement('div');
  wrap.className = 'param-field';
  wrap.dataset['testid'] = `param-field-${id}`;

  const labelRow = document.createElement('div');
  labelRow.className = 'param-field__label';

  const labelEl = document.createElement('label');
  labelEl.setAttribute('for', id);
  labelEl.textContent = label;

  const unitEl = document.createElement('span');
  unitEl.className = 'param-field__unit';
  // Unit label is managed by `setUnitSystem` for length fields; the initial
  // text is whatever the caller passes in unitSymbol (or 'mm' for lengths;
  // the panel will override post-construction via setUnitSystem).
  unitEl.textContent =
    unitSymbol ?? (kind === 'length' ? t('units.mm') : '');

  labelRow.appendChild(labelEl);
  labelRow.appendChild(unitEl);
  wrap.appendChild(labelRow);

  const input = document.createElement('input');
  input.type = 'number';
  input.id = id;
  input.className = 'param-field__input';
  input.dataset['testid'] = `param-input-${id}`;
  input.step = String(step);
  // We don't set min/max as HTML attributes — doing so would let the input
  // clamp on arrow-key step and silently change the value in ways the user
  // didn't request. Validation lives in JS per the issue's clamp-on-blur rule.
  input.inputMode = integer ? 'numeric' : 'decimal';

  let unitSystem: UnitSystem = kind === 'length' ? 'mm' : 'mm';
  // ^ sentinel — mm is the default; the panel resets this via setUnitSystem
  // on mount so the field matches the topbar toggle.

  let internalValue = initial;
  input.value = renderValue(internalValue, kind, unitSystem, integer);

  wrap.appendChild(input);

  const error = document.createElement('small');
  error.className = 'param-field__error';
  error.dataset['testid'] = `param-error-${id}`;
  error.setAttribute('role', 'alert');
  error.hidden = true;
  wrap.appendChild(error);

  function setError(message: string | null): void {
    if (message === null) {
      error.hidden = true;
      error.textContent = '';
      input.removeAttribute('aria-invalid');
    } else {
      error.hidden = false;
      error.textContent = message;
      input.setAttribute('aria-invalid', 'true');
    }
  }

  function validateLive(): void {
    const parsed = parseValue(input.value, kind, unitSystem, integer);
    if (inRange(parsed, min, max)) {
      setError(null);
    } else {
      // Build the range message in DISPLAY units so the user sees what they
      // actually typed in. `formatLength` handles mm ↔ inches; angle/count
      // simply render the raw number.
      setError(buildRangeMessage(min, max, kind, unitSystem, integer));
    }
  }

  function commitClamped(): void {
    const parsed = parseValue(input.value, kind, unitSystem, integer);
    const clamped = clamp(parsed, min, max);
    // Normalise integer fields.
    const normalised = integer ? Math.round(clamped) : clamped;
    internalValue = normalised;
    input.value = renderValue(internalValue, kind, unitSystem, integer);
    setError(null);
    onCommit(internalValue);
  }

  input.addEventListener('input', () => {
    validateLive();
  });
  input.addEventListener('blur', () => {
    commitClamped();
  });
  // Also commit on `change` — covers the keyboard-arrow step case where the
  // input fires `change` without `blur`.
  input.addEventListener('change', () => {
    commitClamped();
  });

  return {
    element: wrap,
    setValue(value: number): void {
      internalValue = value;
      input.value = renderValue(internalValue, kind, unitSystem, integer);
      setError(null);
    },
    setError(message: string | null): void {
      setError(message);
    },
    setUnitSystem(unit: UnitSystem): void {
      if (kind !== 'length') return;
      unitSystem = unit;
      unitEl.textContent = unit === 'in' ? t('units.in') : t('units.mm');
      // Re-render the CURRENT internal value in the new unit. The internal
      // mm value is unchanged, so there's no precision loss.
      input.value = renderValue(internalValue, kind, unitSystem, integer);
      // If the field was showing a stale error, refresh it in the new unit.
      validateLive();
    },
    destroy(): void {
      // Event listeners are attached via anonymous fns, but since we never
      // re-use the same input we just detach the whole element. If the
      // panel replaces the sidebar at runtime (post-v1), wire an
      // AbortController here.
      wrap.remove();
    },
  };
}

/**
 * Build a <select> field. Simpler than NumberField — no unit awareness, no
 * clamp-on-blur, no inline error (enums are always valid by construction).
 */
export function createSelectField<V extends string>(
  config: SelectFieldConfig<V>,
): SelectFieldHandle<V> {
  const { id, label, options, initial, onChange } = config;

  const wrap = document.createElement('div');
  wrap.className = 'param-field';
  wrap.dataset['testid'] = `param-field-${id}`;

  const labelRow = document.createElement('div');
  labelRow.className = 'param-field__label';
  const labelEl = document.createElement('label');
  labelEl.setAttribute('for', id);
  labelEl.textContent = label;
  labelRow.appendChild(labelEl);
  wrap.appendChild(labelRow);

  const select = document.createElement('select');
  select.id = id;
  select.className = 'param-field__select';
  select.dataset['testid'] = `param-input-${id}`;

  for (const opt of options) {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    select.appendChild(option);
  }
  select.value = initial;
  wrap.appendChild(select);

  select.addEventListener('change', () => {
    onChange(select.value as V);
  });

  return {
    element: wrap,
    setValue(value: V): void {
      select.value = value;
    },
    destroy(): void {
      wrap.remove();
    },
  };
}

/**
 * Build the user-visible "Out of range (min–max)" message in the active
 * display unit. Split out so both the live validator and the panel-level
 * driver can reuse it.
 */
function buildRangeMessage(
  minInternal: number,
  maxInternal: number,
  kind: NumberFieldKind,
  unitSystem: UnitSystem,
  integer: boolean,
): string {
  const minDisplay = renderValue(minInternal, kind, unitSystem, integer);
  const maxDisplay = renderValue(maxInternal, kind, unitSystem, integer);
  return t('parameters.invalid', { min: minDisplay, max: maxDisplay });
}
