// src/renderer/ui/dimensions/panel.ts
//
// The right-sidebar "Dimensions" section (issue #79). Sits ABOVE the
// MOLD PARAMETERS form. Lets the user:
//
//   - see the loaded STL's current (scaled) size in mm/in,
//   - edit a uniform scale % (10–1000 %, default 100),
//   - edit per-axis width/height/depth in mm/in,
//   - toggle "Constrain proportions" (Photoshop-style link chain),
//   - reset to native STL size.
//
// Data flow: all edits land on a `DimensionsStore`. The main entrypoint
// subscribes to that store and pushes `scale` into the Master group via
// `viewport.setMasterScale(...)`. The panel does NOT touch the scene
// graph directly.
//
// Internal unit: mm. The field infrastructure (`createNumberField`) flips
// display units on `units-changed`. The Width/Height/Depth inputs are
// driven by `nativeBbox × scale[axis]` — so when the user types a mm
// value, we derive the scale factor as `typedMm / nativeMm` and call
// `store.update({ scaleX/Y/Z })` (through `applyAxisEdit` to honour the
// constrain flag).
//
// Edge case — no master loaded: the panel renders with inputs disabled
// and the "Current size" line reads the i18n `dimensions.noMaster`
// placeholder. As soon as a master loads (signalled by the entrypoint via
// `onMasterReady()`), the inputs enable and populate with the STL's
// native dimensions at 100 %.

import { Vector3, type Box3 } from 'three';

import { getUnitSystem, t, type UnitSystem } from '../../i18n';
import {
  applyAxisEdit,
  applyUniformScale,
  AXIS_SCALE_MAX,
  AXIS_SCALE_MIN,
  DEFAULT_DIMENSIONS,
  derivePercentScale,
  SCALE_PERCENT_MAX,
  SCALE_PERCENT_MIN,
  type DimensionAxis,
  type Dimensions,
  type DimensionsStore,
} from '../../state/dimensions';
import { formatLength, parseLength } from '../formatters';

/** Clamp helper — same semantics as the field layer's clamp-on-blur. */
function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

export interface DimensionsPanelOptions {
  /**
   * Return the currently-loaded master's native (pre-transform) AABB, or
   * `null` if no master is loaded. Invoked on every re-render. Typically
   * `() => viewport.getNativeBbox()`.
   */
  getNativeBbox: () => Box3 | null;
}

export interface DimensionsPanelApi {
  /** Detach the panel + listeners. */
  destroy(): void;
  /**
   * Force a re-render. Called by the entrypoint after a new STL loads —
   * the store is reset to defaults at the same point, so this is mainly
   * to pick up the new native bbox for the mm readouts.
   */
  refresh(): void;
}

/**
 * Mount the Dimensions panel into `container`. Appends — does NOT replace
 * existing children. The caller owns the container; typical wiring is:
 *
 *   const panel = mountDimensionsPanel(sidebarEl, dimensionsStore, { ... });
 *   sidebarEl.prepend(panel.element)  // optional: move to top
 *
 * The returned API includes a `refresh()` hook for "new STL loaded"
 * transitions — the entrypoint calls it after `viewport.setMaster` so the
 * mm readouts reflect the new native bbox.
 */
export function mountDimensionsPanel(
  container: HTMLElement,
  store: DimensionsStore,
  options: DimensionsPanelOptions,
): DimensionsPanelApi {
  const { getNativeBbox } = options;

  const section = document.createElement('section');
  section.className = 'sidebar__section dimensions-panel';
  section.dataset['testid'] = 'dimensions-panel';
  container.appendChild(section);

  // ---- Title --------------------------------------------------------------
  const title = document.createElement('h2');
  title.className = 'sidebar__title';
  title.textContent = t('dimensions.title');
  section.appendChild(title);

  // ---- Current size readout ----------------------------------------------
  const currentSize = document.createElement('div');
  currentSize.className = 'dimensions-panel__current';
  currentSize.dataset['testid'] = 'dimensions-current';
  section.appendChild(currentSize);

  // ---- Scale % field ------------------------------------------------------
  const percentRow = createPercentRow((typed) => {
    const clamped = clamp(typed, SCALE_PERCENT_MIN, SCALE_PERCENT_MAX);
    const next = applyUniformScale(store.get(), clamped / 100);
    store.update(next);
  });
  section.appendChild(percentRow.element);

  // ---- Axis fields --------------------------------------------------------
  const widthRow = createAxisRow({
    id: 'dimensions-width',
    labelKey: 'dimensions.width',
    onCommit: (typedMm) => commitAxis('scaleX', typedMm),
  });
  const heightRow = createAxisRow({
    id: 'dimensions-height',
    labelKey: 'dimensions.height',
    onCommit: (typedMm) => commitAxis('scaleY', typedMm),
  });
  const depthRow = createAxisRow({
    id: 'dimensions-depth',
    labelKey: 'dimensions.depth',
    onCommit: (typedMm) => commitAxis('scaleZ', typedMm),
  });
  section.appendChild(widthRow.element);
  section.appendChild(heightRow.element);
  section.appendChild(depthRow.element);

  // ---- Constrain checkbox -------------------------------------------------
  const constrainLabel = document.createElement('label');
  constrainLabel.className = 'dimensions-panel__constrain';
  const constrainInput = document.createElement('input');
  constrainInput.type = 'checkbox';
  constrainInput.dataset['testid'] = 'dimensions-constrain';
  constrainInput.checked = store.get().constrainProportions;
  constrainLabel.appendChild(constrainInput);
  const constrainText = document.createElement('span');
  constrainText.textContent = t('dimensions.constrainProportions');
  constrainLabel.appendChild(constrainText);
  section.appendChild(constrainLabel);

  constrainInput.addEventListener('change', () => {
    store.update({ constrainProportions: constrainInput.checked });
  });

  // ---- Reset button -------------------------------------------------------
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'dimensions-panel__reset';
  resetBtn.dataset['testid'] = 'dimensions-reset';
  resetBtn.textContent = t('dimensions.resetSize');
  resetBtn.addEventListener('click', () => {
    store.reset();
  });
  section.appendChild(resetBtn);

  // ---- Units tracking ----------------------------------------------------
  let unitSystem: UnitSystem = getUnitSystem();
  const onUnitsChanged = (ev: Event): void => {
    const detail = (ev as CustomEvent<UnitSystem>).detail;
    if (detail === 'mm' || detail === 'in') {
      unitSystem = detail;
      widthRow.setUnitSystem(detail);
      heightRow.setUnitSystem(detail);
      depthRow.setUnitSystem(detail);
      render();
    }
  };
  document.addEventListener('units-changed', onUnitsChanged);
  widthRow.setUnitSystem(unitSystem);
  heightRow.setUnitSystem(unitSystem);
  depthRow.setUnitSystem(unitSystem);

  // ---- Store subscription -------------------------------------------------
  const unsubscribe = store.subscribe(() => {
    render();
  });

  // Initial render.
  render();

  // ---- Helpers ------------------------------------------------------------

  /**
   * Commit an axis edit. Typed value arrives in mm (parsed by the field
   * layer out of whatever display unit is active). We convert to a scale
   * factor using the native bbox, clamp to [AXIS_SCALE_MIN, AXIS_SCALE_MAX],
   * and dispatch through `applyAxisEdit` so the constrain-proportions
   * flag drives the ratio propagation.
   */
  function commitAxis(axis: DimensionAxis, typedMm: number): void {
    const bbox = getNativeBbox();
    if (!bbox) {
      render();
      return;
    }
    const size = new Vector3();
    bbox.getSize(size);
    const nativeMm =
      axis === 'scaleX' ? size.x : axis === 'scaleY' ? size.y : size.z;
    if (!Number.isFinite(nativeMm) || nativeMm <= 0) {
      render();
      return;
    }

    const rawScale = typedMm / nativeMm;
    const clampedScale = clamp(rawScale, AXIS_SCALE_MIN, AXIS_SCALE_MAX);
    const next = applyAxisEdit(store.get(), axis, clampedScale);
    // After constrain-on ratio propagation the other two axes can end up
    // outside [AXIS_SCALE_MIN, AXIS_SCALE_MAX]. If that happens, we damp
    // the ratio so the most-extreme axis lands exactly at its bound —
    // guarantees the user can't push the scene into a "hidden mesh" state
    // via the constrain chain.
    const sanitised = clampProportional(next);
    store.update(sanitised);
  }

  /**
   * Render the current-size line + push the current-store values into
   * every field so display mm values match `nativeBbox × scale[axis]`.
   */
  function render(): void {
    const bbox = getNativeBbox();
    const d = store.get();

    constrainInput.checked = d.constrainProportions;
    resetBtn.disabled = store.isAtDefaults();

    if (!bbox) {
      currentSize.textContent = t('dimensions.noMaster');
      setFieldsDisabled(true);
      // Percent field still carries a default; axis fields show blank so
      // the user doesn't read stale mm values during the "no master" window.
      percentRow.setValue(derivePercentScale(d));
      widthRow.setValue(null);
      heightRow.setValue(null);
      depthRow.setValue(null);
      return;
    }

    setFieldsDisabled(false);

    const size = new Vector3();
    bbox.getSize(size);
    const widthMm = size.x * d.scaleX;
    const heightMm = size.y * d.scaleY;
    const depthMm = size.z * d.scaleZ;

    currentSize.textContent = formatCurrentSize(
      widthMm,
      heightMm,
      depthMm,
      unitSystem,
    );

    percentRow.setValue(derivePercentScale(d));
    widthRow.setValue(widthMm);
    heightRow.setValue(heightMm);
    depthRow.setValue(depthMm);
  }

  function setFieldsDisabled(disabled: boolean): void {
    percentRow.setDisabled(disabled);
    widthRow.setDisabled(disabled);
    heightRow.setDisabled(disabled);
    depthRow.setDisabled(disabled);
    constrainInput.disabled = disabled;
    if (disabled) resetBtn.disabled = true;
  }

  return {
    destroy(): void {
      document.removeEventListener('units-changed', onUnitsChanged);
      unsubscribe();
      percentRow.destroy();
      widthRow.destroy();
      heightRow.destroy();
      depthRow.destroy();
      section.remove();
    },
    refresh(): void {
      render();
    },
  };
}

// ----------------------------------------------------------------------------
// Row factories
//
// We deliberately don't use `createNumberField` from ../parameters/field.ts
// for the Dimensions rows: its clamp-on-blur semantics are designed around
// a fixed internal unit + fixed bounds, which works for the parameters
// form but doesn't fit the Dimensions panel — here the "bounds" on each
// axis input depend on the LIVE native bbox, which the field doesn't know
// about. Keeping the field-layer contract stable is worth a small amount
// of duplication here.
// ----------------------------------------------------------------------------

interface PercentRow {
  element: HTMLDivElement;
  setValue(percent: number): void;
  setDisabled(disabled: boolean): void;
  destroy(): void;
}

function createPercentRow(onCommit: (percent: number) => void): PercentRow {
  const wrap = document.createElement('div');
  wrap.className = 'param-field dimensions-panel__row';
  wrap.dataset['testid'] = 'dimensions-percent-row';

  const labelRow = document.createElement('div');
  labelRow.className = 'param-field__label';
  const labelEl = document.createElement('label');
  labelEl.textContent = t('dimensions.scalePercent');
  labelEl.setAttribute('for', 'dimensions-percent');
  labelRow.appendChild(labelEl);
  const unitEl = document.createElement('span');
  unitEl.className = 'param-field__unit';
  unitEl.textContent = '%';
  labelRow.appendChild(unitEl);
  wrap.appendChild(labelRow);

  const input = document.createElement('input');
  input.type = 'number';
  input.id = 'dimensions-percent';
  input.className = 'param-field__input';
  input.dataset['testid'] = 'dimensions-percent-input';
  input.step = '1';
  input.inputMode = 'decimal';
  input.value = '100.0';
  wrap.appendChild(input);

  const commit = (): void => {
    const text = input.value.trim().replace(',', '.');
    const n = Number(text);
    if (!Number.isFinite(n)) return;
    const clamped = clamp(n, SCALE_PERCENT_MIN, SCALE_PERCENT_MAX);
    input.value = clamped.toFixed(1);
    onCommit(clamped);
  };

  input.addEventListener('change', commit);
  input.addEventListener('blur', commit);

  return {
    element: wrap,
    setValue(percent: number): void {
      // Keep the input box in sync with the store-derived percent. Skip
      // while the input is focused so we don't clobber an in-progress
      // edit mid-keystroke.
      if (document.activeElement === input) return;
      if (!Number.isFinite(percent)) {
        input.value = '';
        return;
      }
      input.value = percent.toFixed(1);
    },
    setDisabled(disabled: boolean): void {
      input.disabled = disabled;
    },
    destroy(): void {
      wrap.remove();
    },
  };
}

interface AxisRow {
  element: HTMLDivElement;
  setValue(mm: number | null): void;
  setUnitSystem(unit: UnitSystem): void;
  setDisabled(disabled: boolean): void;
  destroy(): void;
}

interface AxisRowConfig {
  id: string;
  labelKey: string;
  onCommit(mm: number): void;
}

function createAxisRow(config: AxisRowConfig): AxisRow {
  const { id, labelKey, onCommit } = config;

  const wrap = document.createElement('div');
  wrap.className = 'param-field dimensions-panel__row';
  wrap.dataset['testid'] = `${id}-row`;

  const labelRow = document.createElement('div');
  labelRow.className = 'param-field__label';
  const labelEl = document.createElement('label');
  labelEl.textContent = t(labelKey);
  labelEl.setAttribute('for', id);
  labelRow.appendChild(labelEl);
  const unitEl = document.createElement('span');
  unitEl.className = 'param-field__unit';
  unitEl.textContent = t('units.mm');
  labelRow.appendChild(unitEl);
  wrap.appendChild(labelRow);

  const input = document.createElement('input');
  input.type = 'number';
  input.id = id;
  input.className = 'param-field__input';
  input.dataset['testid'] = `${id}-input`;
  input.step = '0.1';
  input.inputMode = 'decimal';
  wrap.appendChild(input);

  let unitSystem: UnitSystem = 'mm';

  const commit = (): void => {
    const mm = parseLength(input.value, unitSystem);
    if (!Number.isFinite(mm) || mm <= 0) return;
    onCommit(mm);
  };

  input.addEventListener('change', commit);
  input.addEventListener('blur', commit);

  return {
    element: wrap,
    setValue(mm: number | null): void {
      if (document.activeElement === input) return;
      if (mm === null || !Number.isFinite(mm)) {
        input.value = '';
        return;
      }
      input.value = formatLength(mm, unitSystem);
    },
    setUnitSystem(unit: UnitSystem): void {
      unitSystem = unit;
      unitEl.textContent = unit === 'in' ? t('units.in') : t('units.mm');
    },
    setDisabled(disabled: boolean): void {
      input.disabled = disabled;
    },
    destroy(): void {
      wrap.remove();
    },
  };
}

/**
 * Format the "Current size: X Y Z mm/in" line. Live-updated on every store
 * change + on units flips.
 */
function formatCurrentSize(
  widthMm: number,
  heightMm: number,
  depthMm: number,
  unitSystem: UnitSystem,
): string {
  const unitLabel = unitSystem === 'in' ? t('units.in') : t('units.mm');
  const x = formatLength(widthMm, unitSystem);
  const y = formatLength(heightMm, unitSystem);
  const z = formatLength(depthMm, unitSystem);
  return `${t('dimensions.currentSize')}: X ${x}  Y ${y}  Z ${z} ${unitLabel}`;
}

/**
 * After a constrain-on ratio propagation the other two axes can drift
 * outside [AXIS_SCALE_MIN, AXIS_SCALE_MAX]. If any axis is out of range
 * we damp ALL three by the same factor so the most-extreme axis lands
 * exactly at its bound. Preserves the aspect ratio while keeping the
 * scene inside the valid envelope.
 */
function clampProportional(d: Dimensions): Dimensions {
  const axes: DimensionAxis[] = ['scaleX', 'scaleY', 'scaleZ'];
  let ratio = 1;
  for (const a of axes) {
    const v = d[a];
    if (v > AXIS_SCALE_MAX) {
      const localRatio = AXIS_SCALE_MAX / v;
      if (localRatio < ratio) ratio = localRatio;
    } else if (v < AXIS_SCALE_MIN) {
      const localRatio = AXIS_SCALE_MIN / v;
      if (localRatio > ratio) ratio = localRatio;
    }
  }
  if (ratio === 1) return d;
  return {
    ...d,
    scaleX: d.scaleX * ratio,
    scaleY: d.scaleY * ratio,
    scaleZ: d.scaleZ * ratio,
  };
}

export { DEFAULT_DIMENSIONS };
