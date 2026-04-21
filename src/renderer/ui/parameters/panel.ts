// src/renderer/ui/parameters/panel.ts
//
// The right-sidebar mold-parameter form. Binds the `ParametersStore` to a
// stack of NumberField + SelectField instances, wires the "Reset to
// defaults" button, and keeps length fields in sync with the topbar's
// mm/inches toggle via the `units-changed` CustomEvent.
//
// Wave-A scope (issue #69) drops the sprue / vent / ventCount /
// registrationKeyStyle fields from the form. The remaining four rows —
// wall, base, sideCount, draft — match the new single-silicone pipeline.
//
// This panel is mount-once, destroy-on-app-shutdown. It owns no geometry
// state — downstream consumers (Phase 3c+) will read from the store the
// panel was constructed with.
//
// Layout (plain DOM, no framework):
//
//   <aside class="sidebar">
//     <h2 class="sidebar__title">Mold parameters</h2>
//     <form class="sidebar__form">
//       <NumberField wall />
//       <NumberField base />
//       <SelectField sideCount />
//       <NumberField draft />
//     </form>
//     <button class="sidebar__reset" />
//   </aside>

import { getUnitSystem, t, type UnitSystem } from '../../i18n';
import {
  DEFAULT_PARAMETERS,
  NUMERIC_CONSTRAINTS,
  SIDE_COUNT_OPTIONS,
  type MoldParameters,
  type ParametersStore,
} from '../../state/parameters';
import {
  createNumberField,
  createSelectField,
  type NumberFieldHandle,
  type SelectFieldHandle,
} from './field';

export interface ParameterPanelApi {
  /** Detach the panel + listeners. */
  destroy(): void;
}

/**
 * Mount the parameter panel into `container`. The container is expected to
 * be the `<aside id="sidebar">` element already present in `index.html`.
 * We append into it rather than replacing the children, so any error
 * fallback content in the HTML stays visible if the mount fails.
 */
export function mountParameterPanel(
  container: HTMLElement,
  store: ParametersStore,
): ParameterPanelApi {
  container.textContent = '';
  container.classList.add('sidebar');

  // ---- Title -----------------------------------------------------------------
  const title = document.createElement('h2');
  title.className = 'sidebar__title';
  title.textContent = t('parameters.title');
  container.appendChild(title);

  // ---- Form -----------------------------------------------------------------
  const form = document.createElement('form');
  form.className = 'sidebar__form';
  // Form is never submitted — it's just a semantic group wrapper. Prevent
  // the default browser submit-on-Enter so a keyboard user doesn't reload
  // the page or trigger an unexpected side-effect.
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
  });
  container.appendChild(form);

  const handles: {
    siliconeThickness_mm: NumberFieldHandle;
    printShellThickness_mm: NumberFieldHandle;
    baseSlabThickness_mm: NumberFieldHandle;
    baseSlabOverhang_mm: NumberFieldHandle;
    sideCount: SelectFieldHandle<string>;
    draftAngle_deg: NumberFieldHandle;
  } = {
    siliconeThickness_mm: createNumberField({
      id: 'siliconeThickness',
      label: t('parameters.siliconeThickness'),
      kind: 'length',
      unitSymbol: null,
      min: NUMERIC_CONSTRAINTS.siliconeThickness_mm.min,
      max: NUMERIC_CONSTRAINTS.siliconeThickness_mm.max,
      step: NUMERIC_CONSTRAINTS.siliconeThickness_mm.step,
      integer: NUMERIC_CONSTRAINTS.siliconeThickness_mm.integer,
      initial: DEFAULT_PARAMETERS.siliconeThickness_mm,
      onCommit: (value) => store.update({ siliconeThickness_mm: value }),
    }),
    printShellThickness_mm: createNumberField({
      id: 'printShellThickness',
      label: t('parameters.printShell'),
      kind: 'length',
      unitSymbol: null,
      min: NUMERIC_CONSTRAINTS.printShellThickness_mm.min,
      max: NUMERIC_CONSTRAINTS.printShellThickness_mm.max,
      step: NUMERIC_CONSTRAINTS.printShellThickness_mm.step,
      integer: NUMERIC_CONSTRAINTS.printShellThickness_mm.integer,
      initial: DEFAULT_PARAMETERS.printShellThickness_mm,
      onCommit: (value) => store.update({ printShellThickness_mm: value }),
    }),
    baseSlabThickness_mm: createNumberField({
      id: 'baseSlabThickness',
      label: t('parameters.baseSlabThickness'),
      kind: 'length',
      unitSymbol: null,
      min: NUMERIC_CONSTRAINTS.baseSlabThickness_mm.min,
      max: NUMERIC_CONSTRAINTS.baseSlabThickness_mm.max,
      step: NUMERIC_CONSTRAINTS.baseSlabThickness_mm.step,
      integer: NUMERIC_CONSTRAINTS.baseSlabThickness_mm.integer,
      initial: DEFAULT_PARAMETERS.baseSlabThickness_mm,
      onCommit: (value) => store.update({ baseSlabThickness_mm: value }),
    }),
    baseSlabOverhang_mm: createNumberField({
      id: 'baseSlabOverhang',
      label: t('parameters.baseSlabOverhang'),
      kind: 'length',
      unitSymbol: null,
      min: NUMERIC_CONSTRAINTS.baseSlabOverhang_mm.min,
      max: NUMERIC_CONSTRAINTS.baseSlabOverhang_mm.max,
      step: NUMERIC_CONSTRAINTS.baseSlabOverhang_mm.step,
      integer: NUMERIC_CONSTRAINTS.baseSlabOverhang_mm.integer,
      initial: DEFAULT_PARAMETERS.baseSlabOverhang_mm,
      onCommit: (value) => store.update({ baseSlabOverhang_mm: value }),
    }),
    sideCount: createSelectField<string>({
      id: 'sideCount',
      label: t('parameters.sideCount'),
      options: SIDE_COUNT_OPTIONS.map((n) => ({
        value: String(n),
        label: String(n),
      })),
      initial: String(DEFAULT_PARAMETERS.sideCount),
      onChange: (value) => {
        const n = Number(value);
        if (n === 2 || n === 3 || n === 4) {
          store.update({ sideCount: n });
        }
      },
    }),
    draftAngle_deg: createNumberField({
      id: 'draftAngle',
      label: t('parameters.draft'),
      kind: 'angle',
      unitSymbol: t('units.deg'),
      min: NUMERIC_CONSTRAINTS.draftAngle_deg.min,
      max: NUMERIC_CONSTRAINTS.draftAngle_deg.max,
      step: NUMERIC_CONSTRAINTS.draftAngle_deg.step,
      integer: NUMERIC_CONSTRAINTS.draftAngle_deg.integer,
      initial: DEFAULT_PARAMETERS.draftAngle_deg,
      onCommit: (value) => store.update({ draftAngle_deg: value }),
    }),
  };

  // Append in spec-order. This is also tab order since the DOM is authoritative.
  form.appendChild(handles.siliconeThickness_mm.element);
  form.appendChild(handles.printShellThickness_mm.element);
  form.appendChild(handles.baseSlabThickness_mm.element);
  form.appendChild(handles.baseSlabOverhang_mm.element);
  form.appendChild(handles.sideCount.element);
  form.appendChild(handles.draftAngle_deg.element);

  // ---- Reset-to-defaults button ---------------------------------------------
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'sidebar__reset';
  resetBtn.dataset['testid'] = 'param-reset';
  resetBtn.textContent = t('parameters.reset');
  resetBtn.addEventListener('click', () => {
    store.reset();
  });
  container.appendChild(resetBtn);

  // Initial disabled state. The store subscription below keeps it in sync.
  resetBtn.disabled = store.isAtDefaults();

  // ---- Wire: store → fields ------------------------------------------------
  // When the store changes, push the new values into every field so the
  // UI reflects external updates (e.g. programmatic reset).
  const unsubscribeStore = store.subscribe((p) => {
    handles.siliconeThickness_mm.setValue(p.siliconeThickness_mm);
    handles.printShellThickness_mm.setValue(p.printShellThickness_mm);
    handles.baseSlabThickness_mm.setValue(p.baseSlabThickness_mm);
    handles.baseSlabOverhang_mm.setValue(p.baseSlabOverhang_mm);
    handles.sideCount.setValue(String(p.sideCount));
    handles.draftAngle_deg.setValue(p.draftAngle_deg);
    resetBtn.disabled = store.isAtDefaults();
  });

  // ---- Wire: units toggle → length fields ----------------------------------
  // Initialise the display unit on mount so length fields show the persisted
  // unit (e.g. if the user shipped the app with "in" selected last session).
  const initialUnit = getUnitSystem();
  applyUnitToLengths(initialUnit);

  const onUnitsChanged = (ev: Event): void => {
    const detail = (ev as CustomEvent<UnitSystem>).detail;
    if (detail === 'mm' || detail === 'in') {
      applyUnitToLengths(detail);
    }
  };
  document.addEventListener('units-changed', onUnitsChanged);

  function applyUnitToLengths(unit: UnitSystem): void {
    handles.siliconeThickness_mm.setUnitSystem(unit);
    handles.printShellThickness_mm.setUnitSystem(unit);
    handles.baseSlabThickness_mm.setUnitSystem(unit);
    handles.baseSlabOverhang_mm.setUnitSystem(unit);
  }

  return {
    destroy(): void {
      document.removeEventListener('units-changed', onUnitsChanged);
      unsubscribeStore();
      handles.siliconeThickness_mm.destroy();
      handles.printShellThickness_mm.destroy();
      handles.baseSlabThickness_mm.destroy();
      handles.baseSlabOverhang_mm.destroy();
      handles.sideCount.destroy();
      handles.draftAngle_deg.destroy();
      resetBtn.remove();
      title.remove();
      form.remove();
    },
  };
}

export { type MoldParameters };
