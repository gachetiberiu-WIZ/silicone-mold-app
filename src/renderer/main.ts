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

import { generateSiliconeShell } from '@/geometry/generateMold';
import { LAY_FLAT_ACTIVE_EVENT } from './scene/layFlatController';
import { getMasterManifold } from './scene/master';
import { mount, type MountedViewport } from './scene/viewport';
import { initI18n, t } from './i18n';
import {
  createParametersStore,
  type ParametersStore,
} from './state/parameters';
import { attachDropZone } from './ui/dropZone';
import { clear as clearErrorToast, showError, showNotice } from './ui/errorToast';
import { bumpGenerateEpoch } from './ui/generateEpoch';
import {
  mountGenerateButton,
  type GenerateButtonApi,
} from './ui/generateButton';
import { attachGenerateInvalidation } from './ui/generateInvalidation';
import {
  createGenerateOrchestrator,
  type GenerateOrchestratorApi,
} from './ui/generateOrchestrator';
import {
  mountParameterPanel,
  type ParameterPanelApi,
} from './ui/parameters/panel';
import { mountTopbar, type TopbarApi } from './ui/topbar';
import {
  mountPlaceOnFaceToggle,
  type PlaceOnFaceToggleApi,
} from './ui/placeOnFaceToggle';
import {
  mountExplodedViewToggle,
  type ExplodedViewToggleApi,
} from './ui/explodedViewToggle';
import {
  mountPrintablePartsToggle,
  type PrintablePartsToggleApi,
} from './ui/printablePartsToggle';

let topbar: TopbarApi | null = null;
let viewport: MountedViewport | null = null;
let parametersStore: ParametersStore | null = null;
let parameterPanel: ParameterPanelApi | null = null;
let placeOnFace: PlaceOnFaceToggleApi | null = null;
let explodedView: ExplodedViewToggleApi | null = null;
let printablePartsToggle: PrintablePartsToggleApi | null = null;
let generateButton: GenerateButtonApi | null = null;
let generateOrchestrator: GenerateOrchestratorApi | null = null;

/**
 * Canonical "is the exploded view currently ON" flag at the UI layer
 * (issue #62). Used to apply the exploded state to printable parts at
 * the moment the user toggles their visibility ON — `scene/printableParts.ts`
 * short-circuits its tween while hidden, so when the group becomes
 * visible we replay the current exploded state to catch parts up.
 */
let explodedViewActive = false;

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

    // Exploded-view toggle (issue #47, extended in #62). Sits next to
    // Place-on-face. Stays disabled until `generateOrchestrator`
    // successfully installs silicone into the scene — we flip
    // enabled=true inside the orchestrator's `onSiliconeInstalled` hook
    // (wired in `mountParameters`). Every staleness transition also
    // flips enabled=false (wired in `attachGenerateInvalidation` + the
    // loadMasterFromBuffer path).
    //
    // Issue #62 — fan-out: the toggle now animates BOTH scene modules
    // (silicone + printable). Each module owns its own tween (per-
    // module design choice; see PR body). When parts aren't currently
    // visible, `setPrintablePartsExplodedView` short-circuits — no
    // wasted RAF work.
    explodedView = mountExplodedViewToggle(center, {
      onToggle(active) {
        if (!viewport) return;
        explodedViewActive = active;
        viewport.setExplodedView(active);
        viewport.setPrintablePartsExplodedView(active);
      },
    });

    // Show-printable-parts toggle (issue #62). Sits next to the
    // exploded-view toggle. Default OFF — user opts in to see parts.
    // Flipping ON applies the CURRENT exploded-view state so if the
    // user has already exploded silicone and then flips printable-parts
    // on, the parts enter the scene at their exploded positions (not
    // collapsed at origin) — matches the "same assembly, decoupled
    // visibility" UX the issue describes.
    printablePartsToggle = mountPrintablePartsToggle(center, {
      onToggle(active) {
        if (!viewport) return;
        viewport.setPrintablePartsVisible(active);
        if (active) {
          // Replay the current exploded state for the newly-visible
          // parts. When hidden, the scene module snaps positions to
          // the targetFraction on every explodedView flip, so by the
          // time the group turns visible it's already at the right
          // place — calling this again is a no-op tween but stays
          // defensive in case a future change alters that invariant.
          viewport.setPrintablePartsExplodedView(explodedViewActive);
        }
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
    if (explodedView) hooks['explodedView'] = explodedView;
    if (printablePartsToggle) hooks['printablePartsToggle'] = printablePartsToggle;
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
      if (!generateOrchestrator) {
        console.error('[generate] orchestrator not initialised yet');
        return;
      }
      void generateOrchestrator.run();
    },
  });
  container.prepend(generateButton.element);

  // Build the orchestrator now that every dep is mounted. The orchestrator
  // owns the `setBusy → await → staleness-check → topbar-push` cycle and
  // is injectable so the race-condition unit test can drive the full
  // flow without booting the renderer entrypoint.
  if (topbar && generateButton && parametersStore && viewport) {
    const vp = viewport;
    const pStore = parametersStore;
    const tbar = topbar;
    const btn = generateButton;
    generateOrchestrator = createGenerateOrchestrator({
      getMaster: () => getMasterManifold(vp.scene),
      getParameters: () => pStore.get(),
      getViewTransform: () => {
        const masterGroup = vp.scene.children.find(
          (c) => c.userData['tag'] === 'master',
        );
        if (!masterGroup) return null;
        // Ensure the world matrix reflects the current transform — most
        // of the app keeps it up to date, but belt-and-braces.
        masterGroup.updateMatrixWorld(true);
        return masterGroup.matrixWorld.clone();
      },
      generate: generateSiliconeShell,
      topbar: tbar,
      button: btn,
      // Issue #47: hand the generated halves to the scene's silicone
      // module on the happy path INSTEAD of `.delete()`-ing them. The
      // viewport's `setSilicone` also re-frames the camera to the
      // master+silicone union, so the user sees the full result
      // without a manual zoom-out.
      //
      // Issue #62: also hand the printable-box parts to the scene's
      // printable-parts module. Ownership transfers on success; the
      // orchestrator's stale-drop + error paths still `.delete()` them
      // because the scene never received them in those cases.
      scene: {
        setSilicone: (payload) => vp.setSilicone(payload),
        setPrintableParts: (parts) => vp.setPrintableParts(parts),
      },
      onSiliconeInstalled() {
        // Silicone is in the scene → the exploded-view toggle can be
        // used. Start collapsed (setActive(false)) because every fresh
        // generate resets the state — the scene module installs the
        // mesh with currentFraction = 0. The UI-layer `explodedViewActive`
        // flag also resets: a new generate cycle starts collapsed.
        explodedViewActive = false;
        if (explodedView) {
          explodedView.setActive(false);
          explodedView.setEnabled(true);
        }
        // Printable-parts are installed too (the orchestrator hands
        // them off after the silicone hand-off completes — see
        // `setPrintableParts` in the scene deps above). Issue #67 —
        // the scene module now starts the group VISIBLE by default
        // (Wave-4's default-OFF caused dogfood confusion: users
        // clicked "Generate mold" and the mold box stayed hidden).
        // So the toolbar toggle enables AND starts PRESSED, mirroring
        // the scene's default-ON visibility state.
        if (printablePartsToggle) {
          printablePartsToggle.setEnabled(true);
          printablePartsToggle.setActive(true);
        }
      },
      // Issue #64 — on every successful generate, flip the Generate
      // button's hint to "Generated — click to re-run..." and clear
      // the topbar stale-mute state. Both reset on the next staleness
      // signal (orientation commit, reset, new STL) via the
      // invalidation listener below, and on the next parameters-store
      // change via the subscription further down.
      onGenerateSuccess() {
        btn.setGenerated(true);
        tbar.setVolumesStale(false);
      },
    });
  }

  // Issue #64 — subscribe to the parameters store so a tweak AFTER a
  // successful generate flips the topbar silicone/resin readouts to
  // their muted "stale" state AND flips the Generate hint to
  // "Parameters changed. Click Generate to update.". The gate on
  // `isGenerated()` is essential: pre-first-generate tweaks are the
  // common case and must NOT mute the "Click Generate" placeholder
  // (the readouts are already null). The next successful generate
  // resets both flags via `onGenerateSuccess` above; every staleness
  // signal resets them via `attachGenerateInvalidation` below.
  if (parametersStore && topbar && generateButton) {
    const tbar = topbar;
    const btn = generateButton;
    parametersStore.subscribe(() => {
      if (btn.isGenerated() && !btn.isBusy()) {
        btn.setStale(true);
        tbar.setVolumesStale(true);
      }
    });
  }

  // Subscribe to orientation-committed transitions. The controller fires
  // true after a Place-on-face commit, false after Reset orientation, and
  // false when a new master is loaded. `attachGenerateInvalidation`:
  //   - drives `setEnabled` off the event detail so the button's state is
  //     always the controller's truth,
  //   - invalidates silicone + resin readouts (orientation change → any
  //     previously-computed volumes are stale for the new frame),
  //   - clears any lingering error message from a prior failed attempt,
  //   - bumps the shared generate-epoch counter so any in-flight
  //     `generateSiliconeShell` promise drops its result on resolve,
  //   - tears down the silicone preview + disposes paired Manifolds
  //     (issue #47 — silicone lifetime matches the volume-readout
  //     lifetime, so every staleness signal clears both).
  // See `src/renderer/ui/generateInvalidation.ts` for the full semantics.
  if (topbar && generateButton && viewport) {
    const vp = viewport;
    const tbar = topbar;
    attachGenerateInvalidation(topbar, generateButton, {
      clearSilicone: () => {
        vp.clearSilicone();
        // Keep the exploded-view toggle's enabled state in lock-step with
        // whether silicone is in the scene. Also force the pressed state
        // off so a stale "exploded" flag doesn't carry over to the next
        // generate cycle.
        if (explodedView) {
          explodedView.setEnabled(false);
        }
        // Reset the UI-layer `explodedViewActive` mirror so the next
        // successful Generate starts from a known-collapsed state.
        explodedViewActive = false;
        // Issue #64 — any staleness signal clears the muted "stale"
        // state on the topbar readouts too. The invalidation listener
        // has already nulled the silicone + resin numbers, so muting
        // them would be wrong once they revert to the "Click Generate"
        // placeholder.
        tbar.setVolumesStale(false);
      },
      clearPrintableParts: () => {
        // Issue #62: printable-parts lifetime matches the silicone
        // lifetime. Every staleness signal that clears silicone also
        // clears printable parts, and the toolbar toggle reverts to
        // disabled + off.
        vp.clearPrintableParts();
        if (printablePartsToggle) {
          printablePartsToggle.setEnabled(false);
        }
      },
    });
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
 * Shared post-load plumbing used by both the Open-STL dialog flow and the
 * drag-drop-STL flow (issue #27). Given a raw STL `ArrayBuffer`, hands it
 * to the viewport and then runs the identical stale-invalidation sweep:
 *
 *   - bumps the generate-epoch (drops any in-flight generate result),
 *   - pushes the new master volume + nulls silicone / resin readouts,
 *   - clears any residual generate-error + busy state,
 *   - re-enables + resets the Place-on-face toggle,
 *   - flips the Generate-block hint to "orient first".
 *
 * Errors bubble up — callers decide whether to surface them via the
 * shared error-toast channel (`showError`) or swallow them.
 */
async function loadMasterFromBuffer(buffer: ArrayBuffer): Promise<void> {
  if (!viewport) {
    throw new Error('viewport not mounted yet');
  }
  const result = await viewport.setMaster(buffer);
  // Bump the shared generate-epoch so any in-flight run against the
  // previous master drops its result on resolve. `notifyMasterReset`
  // only fires a committed-event when a commit was previously live, so
  // the invalidation listener covers only the "had-commit → new-STL"
  // path. Bumping here covers the first-load / no-prior-commit path too.
  bumpGenerateEpoch();
  // Issue #47: any silicone preview attached to the PREVIOUS master is
  // stale. Tear it down + release the cached half-Manifolds. Idempotent
  // and safe on a first-load with no silicone installed. The
  // `notifyMasterReset` path fires a committed-event (→ listener does
  // the same) only when a commit was previously live; covering both
  // paths here makes first-load-with-stale-silicone-from-prior-master
  // safe as well.
  viewport.clearSilicone();
  // Issue #62 parallel of the above: any printable-parts preview
  // attached to the PREVIOUS master is stale. Same idempotent safety.
  viewport.clearPrintableParts();
  // Reset the exploded-view UI mirror on every new master load — the
  // fresh master starts collapsed.
  explodedViewActive = false;
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
  // Silicone is gone → exploded-view toggle goes back to disabled + off.
  if (explodedView) {
    explodedView.setEnabled(false);
  }
  // Printable parts are gone too → same disabled + off state for the
  // show-printable-parts toggle.
  if (printablePartsToggle) {
    printablePartsToggle.setEnabled(false);
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
  // A successful load supersedes any lingering error banner (e.g. the
  // user hit "file too large" and then picked a valid file).
  clearErrorToast();
  // Issue #64 — if manifold-3d silently repaired non-manifold input,
  // surface the tri-count delta as a discreet notice-level toast. We
  // fire AFTER `clearErrorToast()` so a prior error doesn't immediately
  // get replaced by the notice (the clear nukes whatever was showing;
  // `showNotice` then owns the slot for the usual auto-dismiss window).
  // Zero delta → STL was already watertight → no toast.
  if (result.repairedTriCount > 0) {
    showNotice(
      t('notice.masterRepaired', { removed: result.repairedTriCount }),
    );
  }
}

/**
 * Open the native STL file dialog, stream the bytes back over IPC, and
 * hand the buffer to the shared post-load path. User-visible errors are
 * surfaced via the consolidated error-toast channel (shared with the
 * drag-drop flow, issue #27).
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
      // Typed error variant from the main process. Route each through the
      // shared error-toast channel; the switch stays exhaustive so future
      // variants will surface a compile error here until localised.
      switch (response.error) {
        case 'file-too-large':
          console.error(
            '[open-stl] selected STL exceeds the 500 MB size limit',
          );
          showError(t('errors.fileTooLarge'));
          break;
        case 'read-failed':
          console.error('[open-stl] failed to read selected STL file');
          showError(t('errors.readFailed'));
          break;
        default: {
          const exhaustive: never = response.error;
          console.error('[open-stl] unknown error variant:', exhaustive);
        }
      }
      return;
    }

    // Success path — `response.buffer` is an ArrayBuffer of the STL bytes
    // (see shared/ipc-contracts.ts, structured-cloned across IPC). Hand
    // it to the shared post-load path so Open-STL and drag-drop stay in
    // lock-step on state resets.
    await loadMasterFromBuffer(response.buffer);
  } catch (err) {
    console.error('[open-stl] unexpected error during load:', err);
    showError(t('errors.readFailed'));
  } finally {
    button.disabled = false;
  }
}

/**
 * Wire the window-scoped drag-and-drop handler (issue #27). The target is
 * the top-level `<div id="app">` wrapper so a drop anywhere inside the
 * window is caught (viewport, sidebar, topbar). The handler goes through
 * the HTML5 `File.arrayBuffer()` API — NOT `file.path` or any Node fs
 * API — so the renderer's `contextIsolation` + `sandbox` boundary is
 * preserved.
 *
 * Successful drops hit the same `loadMasterFromBuffer` path as the Open
 * STL dialog, guaranteeing identical post-load state (epoch bump, stale
 * invalidation, orientation reset, hint flip). Validation failures
 * surface via the shared error toast.
 */
function wireDropZone(): void {
  const app = document.getElementById('app');
  if (!app) {
    console.error('wireDropZone: #app container not found in DOM');
    return;
  }
  attachDropZone(app, {
    async onDrop(buffer) {
      try {
        await loadMasterFromBuffer(buffer);
      } catch (err) {
        console.error('[drop-stl] failed to load dropped STL:', err);
        showError(t('errors.readFailed'));
      }
    },
    onError(_code, message) {
      showError(message);
    },
  });
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
  wireDropZone();
  void hydrateVersion();
});
