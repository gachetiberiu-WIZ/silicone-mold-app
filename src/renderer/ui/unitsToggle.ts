// src/renderer/ui/unitsToggle.ts
//
// Tiny internal helper used by the topbar. Renders a two-segment button
// group ("mm" | "in"), persists the selection through the shared i18n
// module (which owns `localStorage.units` + the `units-changed` event).
//
// Kept separate from `topbar.ts` so it can be unit-tested or reused
// without dragging in the full topbar layout.

import { getUnitSystem, setUnitSystem, t, type UnitSystem } from '../i18n';

export interface UnitsToggleApi {
  /** Set the active unit (also persists + broadcasts the event). */
  setUnits(unit: UnitSystem): void;
  /** Current unit. */
  getUnits(): UnitSystem;
  /** Remove DOM listeners if the toggle is unmounted (unused today, tidy). */
  destroy(): void;
}

/**
 * Mount a segmented mm/inches toggle into `host`. Returns an API the
 * parent topbar can use to read or override the selection.
 */
export function mountUnitsToggle(host: HTMLElement): UnitsToggleApi {
  const root = document.createElement('div');
  root.className = 'units-toggle';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', t('units.mm') + ' / ' + t('units.in'));
  root.dataset['testid'] = 'units-toggle';

  const mmBtn = document.createElement('button');
  mmBtn.type = 'button';
  mmBtn.textContent = t('units.mm');
  mmBtn.dataset['testid'] = 'units-toggle-mm';
  mmBtn.dataset['unit'] = 'mm';

  const inBtn = document.createElement('button');
  inBtn.type = 'button';
  inBtn.textContent = t('units.in');
  inBtn.dataset['testid'] = 'units-toggle-in';
  inBtn.dataset['unit'] = 'in';

  root.appendChild(mmBtn);
  root.appendChild(inBtn);
  host.appendChild(root);

  let current: UnitSystem = getUnitSystem();

  function sync(): void {
    mmBtn.setAttribute('aria-pressed', current === 'mm' ? 'true' : 'false');
    inBtn.setAttribute('aria-pressed', current === 'in' ? 'true' : 'false');
    mmBtn.classList.toggle('is-active', current === 'mm');
    inBtn.classList.toggle('is-active', current === 'in');
  }

  function choose(unit: UnitSystem): void {
    if (unit === current) return;
    current = unit;
    setUnitSystem(unit);
    sync();
  }

  mmBtn.addEventListener('click', () => choose('mm'));
  inBtn.addEventListener('click', () => choose('in'));

  // Listen for external changes (e.g. tests or other components).
  const onExternal = (ev: Event): void => {
    const detail = (ev as CustomEvent<UnitSystem>).detail;
    if ((detail === 'mm' || detail === 'in') && detail !== current) {
      current = detail;
      sync();
    }
  };
  document.addEventListener('units-changed', onExternal);

  sync();

  return {
    setUnits(unit: UnitSystem): void {
      choose(unit);
    },
    getUnits(): UnitSystem {
      return current;
    },
    destroy(): void {
      document.removeEventListener('units-changed', onExternal);
      root.remove();
    },
  };
}
