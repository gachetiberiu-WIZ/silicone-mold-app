/**
 * Renderer entry point.
 *
 * Boots i18n, mounts the topbar (owns the Open STL button + master /
 * silicone / resin volume readouts + mm/inches toggle), hydrates the
 * version string via the typed IPC bridge, mounts the Three.js viewport
 * into `#viewport`, and wires:
 *
 *   Open STL → `window.api.openStl()` → `viewport.setMaster(buffer)`
 *            → `topbar.setMasterVolume(volume_mm3)`.
 *   Generate → `generateSiliconeShell(master, parameters, viewTransform)`
 *            → `topbar.setSiliconeVolume + setResinVolume`.
 *
 * Stale-invalidation (issue #40): the silicone + resin readouts reset to
 * the `null` placeholder on any of:
 *   - new STL load,
 *   - lay-flat commit (orientation changed),
 *   - reset orientation (orientation changed).
 * Master volume is invariant under rigid transform → resets only on new
 * STL load.
 *
 * The `window.api` surface is declared in ./types.d.ts (picked up via the
 * tsconfig include).
 */

import { Matrix4 } from 'three';

import { generateSiliconeShell } from '@/geometry/generateMold';
import { LAY_FLAT_ACTIVE_EVENT } from './scene/layFlatController';
import { getMasterManifold } from './scene/master';
import { mount, type MountedViewport } from './scene/viewport';
import { initI18n } from './i18n';
import {
  createParametersStore,
  type ParametersStore,
} from './state/parameters';
import {
  mountGenerateButton,
  type GenerateButtonApi,
} from './ui/generateButton';
import { attachGenerateInvalidation } from './ui/generateInvalidation';
import {
  mountParameterPanel,
  type ParameterPanelApi,
} from './ui/parameters/panel';
import { mountTopbar, type TopbarApi } from './ui/topbar';
import {
  mountPlaceOnFaceToggle,
  type PlaceOnFaceToggleApi,
} from './ui/placeOnFaceToggle';

let topbar: TopbarApi | null = null;
let viewport: MountedViewport | null = null;
let parametersStore: ParametersStore | null = null;
let parameterPanel: ParameterPanelApi | null = null;
let placeOnFace: PlaceOnFaceToggleApi | null = null;
let generateButton: GenerateButtonApi | null = null;

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

  // Mount the "Place on face" + "Reset orientation" buttons inside the
  // topbar center slot (next to Open STL). The topbar builds that slot
  // as a flex row, so appending here flows naturally.
  const center = header.querySelector<HTMLElement>('.topbar__center');
  if (center) {
    placeOnFace = mountPlaceOnFaceToggle(center, {
      onToggle(active) {
        if (!viewport) return;
        if (active) viewport.enableFacePicking();
        else viewport.disableFacePicking();
      },
      onReset() {
        if (!viewport) return;
        viewport.resetOrientation();
      },
    });

    // Mirror viewport-side state transitions (auto-exit-on-commit,
    // Escape-key exit) back into the toggle button so its pressed state
    // never drifts from the controller's truth.
    document.addEventListener(LAY_FLAT_ACTIVE_EVENT, (ev) => {
      const detail = (ev as CustomEvent<boolean>).detail;
      if (typeof detail === 'boolean' && placeOnFace) {
        placeOnFace.setActive(detail);
      }
    });
  }

  // Expose on the test-hook surface so visual specs can drive the UI
  // deterministically (set a known volume, flip units) without clicking.
  if (process.env.NODE_ENV === 'test') {
    const w = window as unknown as {
      __testHooks?: Record<string, unknown>;
    };
    const hooks = w.__testHooks ?? {};
    hooks['topbar'] = topbar;
    if (placeOnFace) hooks['placeOnFace'] = placeOnFace;
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
  // Panel mounts first because `mountParameterPanel` does `container.textContent = ''`
  // to wipe any pre-mount HTML fallback. Mounting the generate-block before
  // the panel would have it clobbered.
  parameterPanel = mountParameterPanel(container, parametersStore);

  // Mount the Generate-mold block and move it to the TOP of the sidebar
  // (issue #36: "at the TOP of the right sidebar, above the parameter
  // form"). `appendChild` followed by `prepend` gives us idempotent top-
  // insertion regardless of how many children `mountParameterPanel` added.
  generateButton = mountGenerateButton(container, {
    onGenerate() {
      // Phase 3c wave 2 (issue #40): fire-and-forget the async generation;
      // the button's own busy-state handles re-entrancy. We keep the
      // trailing `[generate] requested` console line so the existing
      // `generate-gate.spec.ts` assertion stays green without changes.
      const masterGroup = viewport?.scene.children.find(
        (c) => c.userData['tag'] === 'master',
      );
      const q = masterGroup?.quaternion;
      console.log('[generate] requested', {
        quaternion: q ? [q.x, q.y, q.z, q.w] : null,
        parameters: parametersStore?.get() ?? null,
      });
      void handleGenerate();
    },
  });
  container.prepend(generateButton.element);

  // Subscribe to orientation-committed transitions. The controller fires
  // true after a Place-on-face commit, false after Reset orientation, and
  // false when a new master is loaded. `attachGenerateInvalidation`:
  //   - drives `setEnabled` off the event detail so the button's state is
  //     always the controller's truth,
  //   - invalidates silicone + resin readouts (orientation change → any
  //     previously-computed volumes are stale for the new frame),
  //   - clears any lingering error message from a prior failed attempt.
  // See `src/renderer/ui/generateInvalidation.ts` for the full semantics.
  if (topbar && generateButton) {
    attachGenerateInvalidation(topbar, generateButton);
  }

  if (process.env.NODE_ENV === 'test') {
    const w = window as unknown as {
      __testHooks?: Record<string, unknown>;
    };
    const hooks = (w.__testHooks ??= {});
    hooks['parameters'] = parametersStore;
    if (generateButton) hooks['generateButton'] = generateButton;
  }
  // Silence unused-var lint for the panel handle — we need the reference
  // to prevent early GC of its listeners, and to give future shutdown
  // hooks a place to call destroy().
  void parameterPanel;
}

/**
 * Monotonically-incrementing counter used to invalidate stale
 * generate-in-flight resolutions. If the user re-orients (committing a new
 * face) or loads a new STL while a generation is still resolving, the
 * promise's `.then` must be ignored because its inputs are now stale.
 *
 * We increment on: every Generate click (starts a new epoch). When the
 * promise resolves, we compare the epoch it was started under against the
 * current value; mismatch → drop the result on the floor.
 */
let generateEpoch = 0;

/**
 * Run one silicone-shell generation pass. Drives the busy / error states
 * on the Generate button, and pushes the result volumes to the topbar on
 * success. Does NOT dispose the returned half-Manifolds until they get
 * used downstream (Phase 3d's preview renderer) — we keep them alive on
 * `window.__latestSiliconeShell` for later waves, but this wave just needs
 * the volumes. To stay within the WASM-memory budget, we DO delete the
 * halves right after reading the numbers; re-generation reallocates them.
 *
 * Defence-in-depth: guards against missing viewport / manifold / topbar /
 * button so a mis-wired tick doesn't throw.
 */
async function handleGenerate(): Promise<void> {
  if (!viewport) {
    console.error('[generate] viewport not mounted');
    return;
  }
  if (!generateButton) {
    console.error('[generate] generateButton not mounted');
    return;
  }
  if (!parametersStore) {
    console.error('[generate] parametersStore not mounted');
    return;
  }
  if (!topbar) {
    console.error('[generate] topbar not mounted');
    return;
  }

  // Defence-in-depth: the button is gated behind `isOrientationCommitted`
  // so this path should always have a master. Still, a null-check here
  // gives a clean user-facing error instead of an opaque TypeError if the
  // gate somehow slips.
  const master = getMasterManifold(viewport.scene);
  if (!master) {
    const msg = 'No master mesh loaded';
    console.error(`[generate] ${msg}`);
    generateButton.setError(msg);
    return;
  }

  // The Master group's world matrix encodes the user's committed
  // orientation (lay-flat rotation) + the auto-center offset. Pass it
  // straight to the generator; `generateSiliconeShell` applies this as
  // step 1 of its algorithm so the parting plane operates in the oriented
  // frame the user sees.
  const masterGroup = viewport.scene.children.find(
    (c) => c.userData['tag'] === 'master',
  );
  if (!masterGroup) {
    const msg = 'Master group missing from scene';
    console.error(`[generate] ${msg}`);
    generateButton.setError(msg);
    return;
  }
  // Ensure the world matrix reflects the current transform — most of the
  // app keeps it up to date, but belt-and-braces.
  masterGroup.updateMatrixWorld(true);
  const viewTransform = new Matrix4().copy(masterGroup.matrixWorld);

  const parameters = parametersStore.get();
  const epoch = ++generateEpoch;

  generateButton.setError(null);
  generateButton.setBusy(true);
  // Clear stale numbers immediately so the user doesn't see previous values
  // behind the "Generating…" label.
  topbar.setSiliconeVolume(null);
  topbar.setResinVolume(null);

  try {
    const result = await generateSiliconeShell(
      master,
      parameters,
      viewTransform,
    );

    // Staleness guard: if a later click / commit / reset bumped the epoch
    // while we were awaiting, drop the result. The later event already
    // cleared the topbar; re-pushing our numbers would be wrong.
    if (epoch !== generateEpoch) {
      // Free the WASM-heap allocations so they don't leak.
      result.siliconeUpperHalf.delete();
      result.siliconeLowerHalf.delete();
      return;
    }

    topbar.setSiliconeVolume(result.siliconeVolume_mm3);
    topbar.setResinVolume(result.resinVolume_mm3);

    // v1 doesn't render or export the halves — they were for volume
    // compute only. Release the WASM memory now that we've read the
    // numbers. Phase 3d will keep them alive for the preview renderer.
    result.siliconeUpperHalf.delete();
    result.siliconeLowerHalf.delete();
  } catch (err) {
    // If the user invalidated this run mid-flight, swallow — the topbar
    // and error state have already been managed by the committed-event
    // listener. Showing an error message from a superseded run would be
    // confusing.
    if (epoch !== generateEpoch) return;
    const message = err instanceof Error ? err.message : String(err);
    console.error('[generate] failed:', err);
    generateButton.setError(message);
  } finally {
    // Only release busy if this run is still current. An earlier,
    // superseded run must NOT un-busy a later, in-flight run.
    if (epoch === generateEpoch) {
      generateButton.setBusy(false);
    }
  }
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
      topbar.setMasterVolume(result.volume_mm3);
      // Any previously-populated silicone + resin values are for the OLD
      // master and must be cleared. The lay-flat controller's
      // `notifyMasterReset` will also fire a committed-event that clears
      // them, but only when a commit was previously live — belt-and-
      // braces here covers the first-load case and any defensive UI state.
      topbar.setSiliconeVolume(null);
      topbar.setResinVolume(null);
    }
    // Clear any residual error from a previous generate attempt.
    if (generateButton) {
      generateButton.setError(null);
      generateButton.setBusy(false);
    }
    // Enable the lay-flat controls now that a master is in the scene.
    // `setMaster` resets the master group to identity rotation, so the
    // toggle must read "not active" regardless of its previous state.
    if (placeOnFace) {
      placeOnFace.setEnabled(true);
      placeOnFace.setActive(false);
    }
    // Flip the Generate-block's hint from "Load an STL to begin." to
    // "Orient the part on its base...". The button stays disabled — the
    // LAY_FLAT_COMMITTED_EVENT subscription in `mountParameters()` will
    // re-enable it after a commit. `viewport.setMaster` already called
    // `layFlat.notifyMasterReset()`, which fires committed=false, so any
    // stale enabled state from a previous master is cleared.
    if (generateButton) {
      generateButton.setHasMaster(true);
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
