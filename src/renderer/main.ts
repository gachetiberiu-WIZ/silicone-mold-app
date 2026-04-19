/**
 * Renderer entry point.
 *
 * Boots i18n, mounts the topbar (owns the Open STL button + volume readout
 * + mm/inches toggle), hydrates the version string via the typed IPC
 * bridge, mounts the Three.js viewport into `#viewport`, and wires the
 * Open STL button → `window.api.openStl()` → `viewport.setMaster(buffer)`
 * → `topbar.setVolume(volume_mm3)`.
 *
 * The `window.api` surface is declared in ./types.d.ts (picked up via the
 * tsconfig include).
 */

import { mount, type MountedViewport } from './scene/viewport';
import { initI18n } from './i18n';
import {
  createParametersStore,
  type ParametersStore,
} from './state/parameters';
import {
  mountParameterPanel,
  type ParameterPanelApi,
} from './ui/parameters/panel';
import { mountTopbar, type TopbarApi } from './ui/topbar';

let topbar: TopbarApi | null = null;
let viewport: MountedViewport | null = null;
let parametersStore: ParametersStore | null = null;
let parameterPanel: ParameterPanelApi | null = null;

async function hydrateVersion(): Promise<void> {
  // The topbar owns the `[data-testid="app-version"]` element now; keep
  // the existing hydration behaviour so the E2E smoke test still passes.
  const el = document.querySelector<HTMLSpanElement>('[data-testid="app-version"]');
  if (!el) return;
  try {
    const version = await window.api.getVersion();
    el.textContent = `v${version}`;
  } catch (err) {
    console.error('Failed to fetch app version', err);
    el.textContent = 'v?';
  }
}

function mountUi(): void {
  const header = document.querySelector<HTMLElement>('header[data-testid="topbar"]');
  if (!header) {
    console.error('Missing <header data-testid="topbar"> — renderer HTML is out of date.');
    return;
  }
  topbar = mountTopbar(header);

  // Expose on the test-hook surface so visual specs can drive the UI
  // deterministically (set a known volume, flip units) without clicking.
  if (process.env.NODE_ENV === 'test') {
    const w = window as unknown as {
      __testHooks?: Record<string, unknown>;
    };
    const hooks = w.__testHooks ?? {};
    hooks['topbar'] = topbar;
    w.__testHooks = hooks;
  }
}

function mountViewport(): void {
  const container = document.getElementById('viewport');
  if (!container) {
    console.error('Missing #viewport container — renderer HTML is out of date.');
    return;
  }
  viewport = mount(container);
}

/**
 * Create the parameters store and mount the right-sidebar panel. Called
 * after i18n init so all labels resolve. The store is the single source of
 * truth that Phase 3c's mold generator will read from.
 *
 * Exposed on `window.__testHooks.parameters` under `NODE_ENV === 'test'` so
 * visual + E2E specs can drive or inspect state without clicking fields.
 */
function mountParameters(): void {
  const container = document.getElementById('sidebar');
  if (!container) {
    console.error(
      'Missing #sidebar container — renderer HTML is out of date.',
    );
    return;
  }
  parametersStore = createParametersStore();
  parameterPanel = mountParameterPanel(container, parametersStore);

  if (process.env.NODE_ENV === 'test') {
    const w = window as unknown as {
      __testHooks?: Record<string, unknown>;
    };
    const hooks = (w.__testHooks ??= {});
    hooks['parameters'] = parametersStore;
  }
  // Silence unused-var lint for the panel handle — we need the reference
  // to prevent early GC of its listeners, and to give future shutdown
  // hooks a place to call destroy().
  void parameterPanel;
}

/**
 * Open the native STL file dialog, stream the bytes back over IPC, and
 * hand the buffer to the viewport. Updates the topbar volume readout on
 * success. Logs errors to console — a user-visible toast is later work
 * (see issue #16 scope).
 *
 * Re-entrancy: while an open is in flight, the Open STL button is
 * disabled so a double-click doesn't stack two loads. Once the flow
 * resolves (success, cancel, or error) the button is re-enabled.
 */
async function handleOpenStl(button: HTMLButtonElement): Promise<void> {
  if (!viewport) {
    console.error('handleOpenStl: viewport not mounted yet');
    return;
  }
  button.disabled = true;
  try {
    const response = await window.api.openStl({});
    if (response.canceled) {
      // User dismissed the dialog — nothing to do.
      return;
    }
    if ('error' in response) {
      // Typed error variant from the main process. Only `file-too-large`
      // exists at the moment; switch handles future additions exhaustively.
      switch (response.error) {
        case 'file-too-large':
          console.error(
            '[open-stl] selected STL exceeds the 500 MB size limit',
          );
          break;
        case 'read-failed':
          console.error('[open-stl] failed to read selected STL file');
          break;
        default: {
          const exhaustive: never = response.error;
          console.error('[open-stl] unknown error variant:', exhaustive);
        }
      }
      return;
    }

    // Success path — `response.buffer` is an ArrayBuffer of the STL bytes
    // (see shared/ipc-contracts.ts, structured-cloned across IPC). Hand it
    // to the viewport; that module owns STL parsing, scene-swap, and
    // camera framing. The returned volume_mm3 is the watertight manifold
    // volume; feed it straight to the topbar.
    const result = await viewport.setMaster(response.buffer);
    if (topbar) {
      topbar.setVolume(result.volume_mm3);
    }
  } catch (err) {
    console.error('[open-stl] unexpected error during load:', err);
  } finally {
    button.disabled = false;
  }
}

/**
 * Enable the Open STL button (the topbar mounts it disabled by default,
 * as required by the smoke test that ran before this PR enabled it) and
 * attach the click handler.
 */
function wireOpenStlButton(): void {
  const btn = document.querySelector<HTMLButtonElement>(
    '[data-testid="open-stl-btn"]',
  );
  if (!btn) {
    console.error('wireOpenStlButton: Open STL button not found in DOM');
    return;
  }
  btn.disabled = false;
  btn.addEventListener('click', () => {
    void handleOpenStl(btn);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initI18n();
  mountUi();
  mountViewport();
  mountParameters();
  wireOpenStlButton();
  void hydrateVersion();
});
