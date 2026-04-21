// src/renderer/ui/topbar.ts
//
// Plain-DOM topbar component. Renders (left → right):
//
//   [ App name + version ]  [ Open STL ]
//   [ Master: ...  Silicone: ...  Print shell: ...  Base slab: ...  Resin: ...  [mm|in] ]
//
// The volume section surfaces five readouts:
//
//   - "Master" — the loaded STL's watertight volume. Resets only on a new
//     STL load (orientation-agnostic; invariant under rigid transform).
//   - "Silicone" — volume of the silicone body, populated by a successful
//     `generateSiliconeShell` call. Stale after any orientation change
//     (lay-flat commit, reset orientation) or new STL load.
//   - "Print shell" — volume of the rigid surface-conforming print shell
//     produced by Wave C (issue #72). Staleness rules match "Silicone".
//   - "Base slab" — volume of the printable base slab (with step-pocket
//     interlock plug) produced by Wave D (issue #82). Staleness rules
//     match "Silicone".
//   - "Resin" — resin pour volume, equal to the master's volume (Wave A
//     stripped the sprue + vent channel contributions).
//
// Exposes a small imperative API:
//   - `setVolume(mm3)` / `setMasterVolume(mm3)` — master-volume readout.
//     `setVolume` is preserved as an alias of `setMasterVolume` so existing
//     call-sites and tests that use the original name keep working.
//   - `setSiliconeVolume(mm3)` — silicone readout.
//   - `setPrintShellVolume(mm3)` — print-shell readout.
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
   * Set the computed print-shell volume in mm³ (Wave C, issue #72). Pass
   * `null` for the placeholder. Same staleness semantics as
   * `setSiliconeVolume`.
   */
  setPrintShellVolume(mm3: number | null): void;
  /**
   * Set the computed base-slab volume in mm³ (Wave D, issue #82). Pass
   * `null` for the placeholder. Same staleness semantics as
   * `setSiliconeVolume`.
   */
  setBaseSlabVolume(mm3: number | null): void;
  /**
   * Set the resin pour volume in mm³. Pass `null` for the placeholder.
   * Same staleness semantics as `setSiliconeVolume`.
   */
  setResinVolume(mm3: number | null): void;
  /**
   * Flip the "stale" muted-display state for the silicone + print-shell +
   * resin readouts (issue #64 — Option A). When true, all three generated
   * readouts render in italic + reduced opacity so the user sees that the
   * displayed volumes are for a prior parameter set. Master volume is NOT
   * muted — it is invariant under parameter change. Called by `main.ts`
   * when the parameters store fires a change event after a successful
   * generate.
   */
  setVolumesStale(stale: boolean): void;
  /** Read the current "stale" flag for the volume readouts (useful for tests). */
  isVolumesStale(): boolean;
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
  // Four readouts side-by-side. Each is an independent `.topbar__volume`
  // wrap so we can toggle them individually and the existing CSS keeps
  // the spacing consistent. The master readout retains its legacy
  // `data-testid="volume-readout"` / `"volume-value"` ids so existing
  // visual + unit tests keep passing.
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
  const printShell = createVolumeReadout(
    'topbar.volumePrintShell',
    'print-shell-volume-readout',
    'print-shell-volume-value',
  );
  const baseSlab = createVolumeReadout(
    'topbar.volumeBaseSlab',
    'base-slab-volume-readout',
    'base-slab-volume-value',
  );
  const resin = createVolumeReadout(
    'topbar.volumeResin',
    'resin-volume-readout',
    'resin-volume-value',
  );

  right.appendChild(master.wrap);
  right.appendChild(silicone.wrap);
  right.appendChild(printShell.wrap);
  right.appendChild(baseSlab.wrap);
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
  let currentPrintShell: number | null = null;
  let currentBaseSlab: number | null = null;
  let currentResin: number | null = null;
  let currentUnits: UnitSystem = getUnitSystem();
  // Issue #64 — "stale" flag for silicone / print-shell / resin. When
  // true, all three readouts carry `is-stale` (italic + 50 % opacity via
  // CSS). Master readout is never stale — it's invariant under parameter
  // change.
  let volumesStale = false;

  const STALE_CLASS = 'is-stale';
  function applyStaleClass(): void {
    if (volumesStale) {
      silicone.wrap.classList.add(STALE_CLASS);
      printShell.wrap.classList.add(STALE_CLASS);
      baseSlab.wrap.classList.add(STALE_CLASS);
      resin.wrap.classList.add(STALE_CLASS);
    } else {
      silicone.wrap.classList.remove(STALE_CLASS);
      printShell.wrap.classList.remove(STALE_CLASS);
      baseSlab.wrap.classList.remove(STALE_CLASS);
      resin.wrap.classList.remove(STALE_CLASS);
    }
  }

  const toggle: UnitsToggleApi = mountUnitsToggle(togglePanel);

  function renderAll(): void {
    // Master uses the default "No master loaded" placeholder — a null value
    // genuinely means no STL is open. Silicone / print-shell / resin use
    // "Click Generate" because they are null whenever the user hasn't run
    // Generate yet, regardless of master state.
    master.valueEl.textContent = formatVolume(currentMaster, currentUnits);
    silicone.valueEl.textContent = formatVolume(
      currentSilicone,
      currentUnits,
      'volume.notGenerated',
    );
    printShell.valueEl.textContent = formatVolume(
      currentPrintShell,
      currentUnits,
      'volume.notGenerated',
    );
    baseSlab.valueEl.textContent = formatVolume(
      currentBaseSlab,
      currentUnits,
      'volume.notGenerated',
    );
    resin.valueEl.textContent = formatVolume(
      currentResin,
      currentUnits,
      'volume.notGenerated',
    );
  }

  // Listen for unit changes fired by the toggle (or by another component)
  // and re-render all readouts so their unit labels stay in sync.
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
        'volume.notGenerated',
      );
    },
    setPrintShellVolume(mm3: number | null): void {
      currentPrintShell = mm3;
      printShell.valueEl.textContent = formatVolume(
        currentPrintShell,
        currentUnits,
        'volume.notGenerated',
      );
    },
    setBaseSlabVolume(mm3: number | null): void {
      currentBaseSlab = mm3;
      baseSlab.valueEl.textContent = formatVolume(
        currentBaseSlab,
        currentUnits,
        'volume.notGenerated',
      );
    },
    setResinVolume(mm3: number | null): void {
      currentResin = mm3;
      resin.valueEl.textContent = formatVolume(
        currentResin,
        currentUnits,
        'volume.notGenerated',
      );
    },
    setVolumesStale(next: boolean): void {
      if (volumesStale === next) return;
      volumesStale = next;
      applyStaleClass();
    },
    isVolumesStale(): boolean {
      return volumesStale;
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
