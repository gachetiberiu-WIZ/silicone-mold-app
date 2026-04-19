// src/renderer/ui/topbar.ts
//
// Plain-DOM topbar component. Renders (left → right):
//
//   [ App name + version ]  [ Open STL ]
//   [ Master: ...  Silicone: ...  Resin: ...  [mm|in] ]
//
// The volume section surfaces three readouts (issue #40):
//
//   - "Master" — the loaded STL's watertight volume. Resets only on a new
//     STL load (orientation-agnostic; invariant under rigid transform).
//   - "Silicone" — combined volume of both silicone halves, populated by
//     a successful `generateSiliconeShell` call. Stale after any orientation
//     change (lay-flat commit, reset orientation) or new STL load.
//   - "Resin" — resin pour volume, equal to the master's volume at Phase
//     3c wave 2 (sprue/vent channel contributions land in Phase 3d/e).
//     Staleness rules match "Silicone".
//
// Exposes a small imperative API:
//   - `setVolume(mm3)` / `setMasterVolume(mm3)` — master-volume readout.
//     `setVolume` is preserved as an alias of `setMasterVolume` so existing
//     call-sites and tests that use the original name keep working.
//   - `setSiliconeVolume(mm3)` — silicone readout.
//   - `setResinVolume(mm3)` — resin readout.
//   - `setUnits(u)` / `getUnits()` — as before.
//
// No framework; the component lifetime is the window lifetime.

import { t, getUnitSystem, type UnitSystem } from '../i18n';
import { formatVolume } from './formatters';
import { mountUnitsToggle, type UnitsToggleApi } from './unitsToggle';

export interface TopbarApi {
  /**
   * Set the master-mesh volume in mm³. Pass `null` to show the empty state.
   * Kept as an alias for `setMasterVolume` — existing callers (and tests)
   * rely on the shorter name.
   */
  setVolume(mm3: number | null): void;
  /** Semantic alias of `setVolume` — preferred for new call-sites. */
  setMasterVolume(mm3: number | null): void;
  /**
   * Set the computed silicone-shell volume in mm³. Pass `null` to show the
   * "no master loaded" placeholder — use this to invalidate a previous
   * generate result (e.g. after the user re-orients the part).
   */
  setSiliconeVolume(mm3: number | null): void;
  /**
   * Set the resin pour volume in mm³. Pass `null` for the placeholder.
   * Same staleness semantics as `setSiliconeVolume`.
   */
  setResinVolume(mm3: number | null): void;
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
 * Internal helper — build a single "{label}: {value}" readout node. Returns
 * the wrapper plus the value span so the caller can update text on state
 * changes without re-querying the DOM.
 */
function createVolumeReadout(
  labelKey: string,
  testidWrap: string,
  testidValue: string,
): { wrap: HTMLDivElement; valueEl: HTMLSpanElement } {
  const wrap = document.createElement('div');
  wrap.className = 'topbar__volume';
  wrap.dataset['testid'] = testidWrap;

  const labelEl = document.createElement('span');
  labelEl.className = 'topbar__volume-label';
  labelEl.textContent = t(labelKey) + ':';
  wrap.appendChild(labelEl);

  const valueEl = document.createElement('span');
  valueEl.className = 'topbar__volume-value';
  valueEl.dataset['testid'] = testidValue;
  wrap.appendChild(valueEl);

  return { wrap, valueEl };
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

  // ---- Center: Open STL (enabled by main.ts once IPC is wired) ------------
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

  // ---- Right: volume readouts + units toggle -------------------------------
  //
  // Three readouts side-by-side (issue #40). Each is an independent
  // `.topbar__volume` wrap so we can toggle them individually and the
  // existing CSS keeps the spacing consistent. The original single readout
  // used `data-testid="volume-readout"` / `"volume-value"`; we keep those
  // ids on the MASTER readout so existing tests (topbar-units visual spec,
  // E2E load-stl flow) continue to pass.
  const right = document.createElement('div');
  right.className = 'topbar__right';

  const master = createVolumeReadout(
    'topbar.volumeMaster',
    'volume-readout',
    'volume-value',
  );
  const silicone = createVolumeReadout(
    'topbar.volumeSilicone',
    'silicone-volume-readout',
    'silicone-volume-value',
  );
  const resin = createVolumeReadout(
    'topbar.volumeResin',
    'resin-volume-readout',
    'resin-volume-value',
  );

  right.appendChild(master.wrap);
  right.appendChild(silicone.wrap);
  right.appendChild(resin.wrap);

  const togglePanel = document.createElement('div');
  togglePanel.className = 'topbar__units';
  right.appendChild(togglePanel);

  container.appendChild(left);
  container.appendChild(center);
  container.appendChild(right);

  // ---- State + rendering ---------------------------------------------------
  let currentMaster: number | null = null;
  let currentSilicone: number | null = null;
  let currentResin: number | null = null;
  let currentUnits: UnitSystem = getUnitSystem();

  const toggle: UnitsToggleApi = mountUnitsToggle(togglePanel);

  function renderAll(): void {
    master.valueEl.textContent = formatVolume(currentMaster, currentUnits);
    silicone.valueEl.textContent = formatVolume(currentSilicone, currentUnits);
    resin.valueEl.textContent = formatVolume(currentResin, currentUnits);
  }

  // Listen for unit changes fired by the toggle (or by another component)
  // and re-render all three readouts so their unit labels stay in sync.
  document.addEventListener('units-changed', (ev) => {
    const detail = (ev as CustomEvent<UnitSystem>).detail;
    if (detail === 'mm' || detail === 'in') {
      currentUnits = detail;
      renderAll();
    }
  });

  renderAll();

  const setMaster = (mm3: number | null): void => {
    currentMaster = mm3;
    master.valueEl.textContent = formatVolume(currentMaster, currentUnits);
  };

  return {
    setVolume: setMaster,
    setMasterVolume: setMaster,
    setSiliconeVolume(mm3: number | null): void {
      currentSilicone = mm3;
      silicone.valueEl.textContent = formatVolume(
        currentSilicone,
        currentUnits,
      );
    },
    setResinVolume(mm3: number | null): void {
      currentResin = mm3;
      resin.valueEl.textContent = formatVolume(currentResin, currentUnits);
    },
    setUnits(unit: UnitSystem): void {
      toggle.setUnits(unit);
      currentUnits = unit;
      renderAll();
    },
    getUnits(): UnitSystem {
      return currentUnits;
    },
  };
}
