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
    wallThickness_mm: NumberFieldHandle;
    baseThickness_mm: NumberFieldHandle;
    sideCount: SelectFieldHandle<string>;
    draftAngle_deg: NumberFieldHandle;
  } = {
    wallThickness_mm: createNumberField({
      id: 'wallThickness',
      label: t('parameters.wall'),
      kind: 'length',
      unitSymbol: null,
      min: NUMERIC_CONSTRAINTS.wallThickness_mm.min,
      max: NUMERIC_CONSTRAINTS.wallThickness_mm.max,
      step: NUMERIC_CONSTRAINTS.wallThickness_mm.step,
      integer: NUMERIC_CONSTRAINTS.wallThickness_mm.integer,
      initial: DEFAULT_PARAMETERS.wallThickness_mm,
      onCommit: (value) => store.update({ wallThickness_mm: value }),
    }),
    baseThickness_mm: createNumberField({
      id: 'baseThickness',
      label: t('parameters.base'),
      kind: 'length',
      unitSymbol: null,
      min: NUMERIC_CONSTRAINTS.baseThickness_mm.min,
      max: NUMERIC_CONSTRAINTS.baseThickness_mm.max,
      step: NUMERIC_CONSTRAINTS.baseThickness_mm.step,
      integer: NUMERIC_CONSTRAINTS.baseThickness_mm.integer,
      initial: DEFAULT_PARAMETERS.baseThickness_mm,
      onCommit: (value) => store.update({ baseThickness_mm: value }),
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
  form.appendChild(handles.wallThickness_mm.element);
  form.appendChild(handles.baseThickness_mm.element);
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
    handles.wallThickness_mm.setValue(p.wallThickness_mm);
    handles.baseThickness_mm.setValue(p.baseThickness_mm);
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
    handles.wallThickness_mm.setUnitSystem(unit);
    handles.baseThickness_mm.setUnitSystem(unit);
  }

  return {
    destroy(): void {
      document.removeEventListener('units-changed', onUnitsChanged);
      unsubscribeStore();
      handles.wallThickness_mm.destroy();
      handles.baseThickness_mm.destroy();
      handles.sideCount.destroy();
      handles.draftAngle_deg.destroy();
      resetBtn.remove();
      title.remove();
      form.remove();
    },
  };
}

export { type MoldParameters };
