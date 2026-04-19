// src/renderer/ui/topbar.ts
//
// Plain-DOM topbar component. Renders:
//
//   [ App name + version ]  [ Open STL (disabled) ]  [ Volume: ... ]  [ mm | in ]
//
// The "Open STL" button is intentionally disabled — issue #16 will enable it
// in a follow-up PR. A disabled-state E2E smoke test depends on this.
//
// Exposes a small imperative API:
//   - `setVolume(mm3)` — called later by the STL-loaded callback.
//   - `setUnits(u)`    — programmatic override (keeps toggle + formatter in sync).
//   - `getUnits()`     — read the active unit system.
//
// No framework; the component lifetime is the window lifetime.

import { t, getUnitSystem, type UnitSystem } from '../i18n';
import { formatVolume } from './formatters';
import { mountUnitsToggle, type UnitsToggleApi } from './unitsToggle';

export interface TopbarApi {
  /** Set the master-mesh volume in mm³. Pass `null` to show the empty state. */
  setVolume(mm3: number | null): void;
  /** Programmatically flip the unit system. Mirrors the toggle buttons. */
  setUnits(unit: UnitSystem): void;
  /** Read current unit system. */
  getUnits(): UnitSystem;
}

interface TopbarOptions {
  /**
   * Optional version string (e.g. "0.0.0"). Rendered as a muted suffix next
   * to the app name. If omitted, the caller can set it later by mutating
   * the `[data-testid="app-version"]` element directly — which is how
   * `main.ts` currently hydrates it asynchronously via IPC.
   */
  version?: string;
}

/**
 * Mount the topbar into `container`, replacing any existing children.
 * The container is typically the `<header>` element already present in
 * `index.html` — we want to preserve the body/viewport layout.
 */
export function mountTopbar(
  container: HTMLElement,
  options: TopbarOptions = {},
): TopbarApi {
  container.textContent = '';
  container.classList.add('topbar');

  // ---- Left: app name + version --------------------------------------------
  const left = document.createElement('div');
  left.className = 'topbar__left';

  const appName = document.createElement('h1');
  appName.className = 'topbar__app-name';
  appName.textContent = t('topbar.appName');
  left.appendChild(appName);

  const version = document.createElement('span');
  version.className = 'topbar__version';
  version.dataset['testid'] = 'app-version';
  version.textContent = options.version ? `v${options.version}` : 'v…';
  left.appendChild(version);

  // ---- Center: Open STL (still disabled in this PR) ------------------------
  const center = document.createElement('div');
  center.className = 'topbar__center';

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'topbar__open-btn';
  openBtn.dataset['testid'] = 'open-stl-btn';
  openBtn.textContent = t('topbar.open');
  // DO NOT enable this — issue #16 owns enabling it. The E2E smoke test
  // asserts `toBeDisabled()`. Flipping it here will break CI.
  openBtn.disabled = true;
  center.appendChild(openBtn);

  // ---- Right: volume readout + units toggle --------------------------------
  const right = document.createElement('div');
  right.className = 'topbar__right';

  const volumeWrap = document.createElement('div');
  volumeWrap.className = 'topbar__volume';
  volumeWrap.dataset['testid'] = 'volume-readout';

  const volumeLabel = document.createElement('span');
  volumeLabel.className = 'topbar__volume-label';
  volumeLabel.textContent = t('volume.label') + ':';
  volumeWrap.appendChild(volumeLabel);

  const volumeValue = document.createElement('span');
  volumeValue.className = 'topbar__volume-value';
  volumeValue.dataset['testid'] = 'volume-value';
  volumeWrap.appendChild(volumeValue);

  right.appendChild(volumeWrap);

  const togglePanel = document.createElement('div');
  togglePanel.className = 'topbar__units';
  right.appendChild(togglePanel);

  container.appendChild(left);
  container.appendChild(center);
  container.appendChild(right);

  // ---- State + rendering ---------------------------------------------------
  let currentVolume: number | null = null;
  let currentUnits: UnitSystem = getUnitSystem();

  const toggle: UnitsToggleApi = mountUnitsToggle(togglePanel);

  function renderVolume(): void {
    volumeValue.textContent = formatVolume(currentVolume, currentUnits);
  }

  // Listen for unit changes fired by the toggle (or by another component)
  // and re-render the volume so the unit label stays in sync.
  document.addEventListener('units-changed', (ev) => {
    const detail = (ev as CustomEvent<UnitSystem>).detail;
    if (detail === 'mm' || detail === 'in') {
      currentUnits = detail;
      renderVolume();
    }
  });

  renderVolume();

  return {
    setVolume(mm3: number | null): void {
      currentVolume = mm3;
      renderVolume();
    },
    setUnits(unit: UnitSystem): void {
      toggle.setUnits(unit);
      currentUnits = unit;
      renderVolume();
    },
    getUnits(): UnitSystem {
      return currentUnits;
    },
  };
}
