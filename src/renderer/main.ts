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

// Issue #77 — the renderer no longer calls `generateSiliconeShell`
// directly. The pipeline runs in a dedicated web worker (see
// `./worker/generateMoldRunner.ts`); the runner's `generateMoldViaWorker`
// matches the orchestrator's `generate` signature 1:1 so the orchestrator
// stays oblivious to the transport. `cancelCurrentWorkerRun` hangs off
// every staleness path so a new STL / parameter change / orientation
// commit kills the in-flight worker instead of letting it burn cycles
// on a stale run.
import {
  generateMoldViaWorker,
  cancelCurrentWorkerRun,
} from './worker/generateMoldRunner';
import {
  LAY_FLAT_ACTIVE_EVENT,
  LAY_FLAT_COMMITTED_EVENT,
} from './scene/layFlatController';
import { getMasterManifold } from './scene/master';
import { mount, type MountedViewport } from './scene/viewport';
import { initI18n, t } from './i18n';
import {
  createCutOverridesStore,
  type CutOverridesStore,
} from './state/cutOverrides';
import {
  createDimensionsStore,
  type DimensionsStore,
} from './state/dimensions';
import {
  createParametersStore,
  type ParametersStore,
} from './state/parameters';
import {
  mountDimensionsPanel,
  type DimensionsPanelApi,
} from './ui/dimensions/panel';
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
  type GenerateOrchestratorApiWithExport,
} from './ui/generateOrchestrator';
import {
  mountCutOverridesReadout,
  type CutOverridesReadoutApi,
} from './ui/cutOverridesReadout';
import { mountExportStlButton, type ExportStlApi } from './ui/exportStl';
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
import {
  mountGenerateStatus,
  type GenerateStatusApi,
} from './ui/generateStatus';

let topbar: TopbarApi | null = null;
let viewport: MountedViewport | null = null;
let parametersStore: ParametersStore | null = null;
let parameterPanel: ParameterPanelApi | null = null;
let cutOverridesStore: CutOverridesStore | null = null;
let dimensionsStore: DimensionsStore | null = null;
let dimensionsPanel: DimensionsPanelApi | null = null;
let placeOnFace: PlaceOnFaceToggleApi | null = null;
let explodedView: ExplodedViewToggleApi | null = null;
let printablePartsToggle: PrintablePartsToggleApi | null = null;
let generateButton: GenerateButtonApi | null = null;
let generateOrchestrator: GenerateOrchestratorApiWithExport | null = null;
let generateStatus: GenerateStatusApi | null = null;
let exportStl: ExportStlApi | null = null;
let cutOverridesReadout: CutOverridesReadoutApi | null = null;

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

    // Export STL button (issue #91). Mounts here so its placement sits
    // alongside the other toolbar affordances (exploded-view, printable-
    // parts). Wire-up happens in `mountParameters()` AFTER the
    // orchestrator is constructed — we need `orchestrator.
    // getCurrentExportables` for the click handler and
    // `orchestrator.onStateChange` for the enable/disable plumbing.
    // Starts disabled; the state subscription flips it.
    exportStl = mountExportStlButton(center, {
      getExportables: () => generateOrchestrator?.getCurrentExportables() ?? null,
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
    if (exportStl) hooks['exportStl'] = exportStl;
    w.__testHooks = hooks;
  }
}

function mountViewport(): void {
  const container = document.getElementById('viewport');
  if (!container) {
    console.error('Missing #viewport container — renderer HTML is out of date.');
    return;
  }
  // PR B: cut-overrides store + parametersStore are created here (ahead
  // of `mountParameters`) so the viewport can wire the cut-planes
  // preview during construction. The parametersStore's `sideCount` is
  // what `getSideCount` reads from, so the viewport needs a live
  // reference at mount time. Both stores remain exposed on the test
  // hooks surface from `mountParameters` further down.
  cutOverridesStore = createCutOverridesStore();
  parametersStore = createParametersStore();
  const cStore = cutOverridesStore;
  const pStore = parametersStore;
  viewport = mount(container, {
    cutOverridesStore: cStore,
    getSideCount: () => pStore.get().sideCount,
    onCutPreviewDragRelease: () => {
      // Drag released: if a generate has previously happened, flip
      // the button to a stale state. The same stale-marker treatment
      // that the parameters-store subscription applies.
      if (generateButton && generateButton.isGenerated() && !generateButton.isBusy()) {
        generateButton.setStale(true);
        topbar?.setVolumesStale(true);
        generateOrchestrator?.invalidateExportables();
      }
    },
  });
  // Issue #87 Fix 1: progress-banner lives inside the viewport
  // container so it positions relative to the canvas, not the
  // window. Mounted after the viewport so the canvas is already in
  // the DOM and the banner appends after it (z-order naturally
  // places it above). Hidden by default until the orchestrator
  // fires its first `setPhase`.
  generateStatus = mountGenerateStatus(container);
  if (process.env.NODE_ENV === 'test') {
    const w = window as unknown as {
      __testHooks?: Record<string, unknown>;
    };
    const hooks = (w.__testHooks ??= {});
    hooks['generateStatus'] = generateStatus;
    hooks['cutOverrides'] = cutOverridesStore;
  }
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
  const leftContainer = document.getElementById('sidebar-left');
  if (!leftContainer) {
    console.error(
      'Missing #sidebar-left container — renderer HTML is out of date.',
    );
    return;
  }
  // PR B: `parametersStore` is created inside `mountViewport` so the
  // viewport can wire the cut-planes preview's `getSideCount` reader
  // at mount time. Guard here in case someone calls mountParameters
  // without mountViewport (test bundles).
  if (!parametersStore) parametersStore = createParametersStore();
  dimensionsStore = createDimensionsStore();
  // Panel mounts first because `mountParameterPanel` does `container.textContent = ''`
  // to wipe any pre-mount HTML fallback. Mounting the generate-block before
  // the panel would have it clobbered.
  parameterPanel = mountParameterPanel(container, parametersStore);

  // Mount the Dimensions panel (issue #79) into the DEDICATED LEFT sidebar
  // (issue #80 dogfood feedback — users wanted size controls visually
  // separated from the generate flow). The left pane owns ONLY this panel
  // for now; the right pane keeps Generate + MOLD PARAMETERS + Reset.
  if (viewport) {
    const vp = viewport;
    const dStore = dimensionsStore;
    dimensionsPanel = mountDimensionsPanel(leftContainer, dStore, {
      getNativeBbox: () => vp.getNativeBbox(),
    });

    // Subscribe to the dimensions store → push every change through to
    // the Master group's scale. The viewport re-runs `recenterGroup` and
    // re-frames the camera inside `setMasterScale`.
    dStore.subscribe((d) => {
      vp.setMasterScale({ sx: d.scaleX, sy: d.scaleY, sz: d.scaleZ });
    });
  }

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

  // PR B — cut-overrides readout + reset icon. Mounted inside the
  // generate-block element so it sits directly beneath the Generate
  // button. Renders as "Cut: 0°, (0.0, 0.0) mm" plus a reset icon.
  if (cutOverridesStore) {
    cutOverridesReadout = mountCutOverridesReadout(
      generateButton.element,
      cutOverridesStore,
    );
  }

  // Build the orchestrator now that every dep is mounted. The orchestrator
  // owns the `setBusy → await → staleness-check → topbar-push` cycle and
  // is injectable so the race-condition unit test can drive the full
  // flow without booting the renderer entrypoint.
  if (topbar && generateButton && parametersStore && viewport) {
    const vp = viewport;
    const pStore = parametersStore;
    const tbar = topbar;
    const btn = generateButton;
    const statusApi = generateStatus;
    const coStore = cutOverridesStore;
    generateOrchestrator = createGenerateOrchestrator({
      getMaster: () => getMasterManifold(vp.scene),
      getParameters: () => pStore.get(),
      ...(coStore
        ? {
            getCutOverrides: () => coStore.get(),
            isCutOverridesAtDefaults: () => coStore.isAtDefaults(),
          }
        : {}),
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
      // Issue #77 — offload to a web worker. The runner keeps the
      // `(master, parameters, viewTransform, onPhase?) => Promise<...>`
      // shape so the orchestrator doesn't know it's talking to a worker.
      generate: generateMoldViaWorker,
      topbar: tbar,
      button: btn,
      // Issue #47: hand the generated halves to the scene's silicone
      // module on the happy path INSTEAD of `.delete()`-ing them. The
      // viewport's `setSilicone` also re-frames the camera to the
      // master+silicone union, so the user sees the full result
      // without a manual zoom-out.
      //
      // Issue #62 + #72: hand the surface-conforming print shell to the
      // scene's printable-parts module. Ownership transfers on success;
      // the orchestrator's stale-drop + error paths still `.delete()` it
      // because the scene never received it in those cases.
      scene: {
        setSilicone: (payload) => vp.setSilicone(payload),
        setPrintableParts: (parts) => vp.setPrintableParts(parts),
      },
      // Issue #87 Fix 1 — progress banner sink. Wired only when the
      // status module successfully mounted (guards test bundles that
      // skip the viewport). `translatePhase` routes the phase key
      // through i18n so the banner label honours the locale.
      ...(statusApi
        ? {
            status: {
              setPhase: (label: string | null) => statusApi.setPhase(label),
            },
            translatePhase: (key: string) => t('status.phase.' + key),
          }
        : {}),
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
        // PR B — generate kicked off with silicone installed. Printable
        // parts are about to get installed too (they render on top of the
        // cut-planes preview). Detach the preview so the gizmo doesn't
        // clutter the generated-mold view. The next orientation commit
        // (after the user resets + picks a new face) re-attaches.
        viewport?.cutPlanesPreview?.detach();
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
      // Issue #93 — surface a blue notice-toast post-generate when the
      // base slab came out degenerate (zero footprint for the committed
      // orientation). The orchestrator fires this once per successful
      // run on the happy-path terminal branch only; stale-drops + error
      // paths skip it. `translateWarning` routes the i18n key through
      // `t()` so the string honours locale.
      showNotice: (message: string) => showNotice(message),
      translateWarning: (key: string) => t(key),
    });

    // Issue #91 — wire the Export STL button's enabled flag to the
    // orchestrator's export-state stream. The stream fires on every
    // busy start/end and every invalidation, so the button tracks
    // `hasExportables && !isBusy` without polling. The initial state
    // fires synchronously inside `onStateChange` (replay pattern), so
    // the button sets itself to `enabled=false` at boot without a
    // flicker.
    if (exportStl) {
      const exportBtn = exportStl;
      generateOrchestrator.onStateChange((state) => {
        const canExport = state.hasExportables && !state.isBusy;
        exportBtn.setEnabled(canExport);
        // Disabled reason flips to "stale" only when Generate has run at
        // least once AND the result is invalidated (button says "Click
        // Generate to update" alongside). Pre-first-generate keeps the
        // default disabled tooltip.
        if (canExport) {
          exportBtn.setTooltip('none');
        } else if (btn.isGenerated() && btn.isStale()) {
          exportBtn.setTooltip('stale');
        } else {
          exportBtn.setTooltip('disabled');
        }
      });
    }
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
  //
  // Issue #91 — the Export STL button must ALSO go disabled on the
  // same signal. `invalidateExportables()` clears the orchestrator's
  // captured Manifold refs, which fires the export-state subscription
  // → button re-renders as disabled with the "stale" tooltip.
  if (parametersStore && topbar && generateButton) {
    const tbar = topbar;
    const btn = generateButton;
    let lastSideCount: 2 | 3 | 4 = parametersStore.get().sideCount;
    parametersStore.subscribe((params) => {
      if (btn.isGenerated() && !btn.isBusy()) {
        btn.setStale(true);
        tbar.setVolumesStale(true);
        generateOrchestrator?.invalidateExportables();
      }
      // PR B: sideCount change → rebuild the cut-planes preview so
      // the plane count matches. Guard via a cached last value so
      // unrelated parameter edits don't burn a rebuild.
      if (params.sideCount !== lastSideCount) {
        lastSideCount = params.sideCount;
        viewport?.cutPlanesPreview?.rebuild();
      }
      // Issue #77 — also kill any in-flight worker when parameters
      // change while a generate is busy. The orchestrator's epoch check
      // already drops stale results, but letting the worker keep
      // running burns a CPU core and delays the next fresh run's WASM
      // init. Terminate early. Safe when no worker is live (no-op).
      cancelCurrentWorkerRun();
    });
  }

  // PR B — subscribe to the cut-overrides store so changes (programmatic
  // or via the gizmo drag) mark the generate button stale ONLY when a
  // generate has previously happened. Pre-first-generate edits should
  // NOT flip the hint — the button is still in its initial "ready"
  // state and the user is just exploring the gizmo.
  if (cutOverridesStore && topbar && generateButton) {
    const tbar = topbar;
    const btn = generateButton;
    cutOverridesStore.subscribe(() => {
      if (btn.isGenerated() && !btn.isBusy()) {
        btn.setStale(true);
        tbar.setVolumesStale(true);
        generateOrchestrator?.invalidateExportables();
      }
    });
  }

  // Issue #79 — same staleness semantics for dimension edits. Any scale
  // change invalidates the previously-generated silicone + print-shell
  // volumes the same way a parameter change does. Issue #91 — also
  // clears the Export STL button (see comment above).
  if (dimensionsStore && topbar && generateButton) {
    const tbar = topbar;
    const btn = generateButton;
    dimensionsStore.subscribe(() => {
      if (btn.isGenerated() && !btn.isBusy()) {
        btn.setStale(true);
        tbar.setVolumesStale(true);
        generateOrchestrator?.invalidateExportables();
      }
      // Issue #77 — kill any in-flight worker on dimension changes.
      // See the parametersStore subscribe above for the rationale.
      cancelCurrentWorkerRun();
    });
  }

  // PR B — cut-planes preview attach/detach. Listens directly to the
  // LAY_FLAT_COMMITTED_EVENT (separate from `attachGenerateInvalidation`
  // which handles staleness + silicone clears). Policy:
  //   - attach when orientation is COMMITTED true + no printable parts
  //     are currently visible;
  //   - detach when orientation goes FALSE (reset, new master), or when
  //     printable parts become visible (the cut planes would clash with
  //     the generated shell pieces).
  if (viewport) {
    const vp = viewport;
    const updateCutPreviewVisibility = () => {
      const cpp = vp.cutPlanesPreview;
      if (!cpp) return;
      const shouldAttach =
        vp.isOrientationCommitted() && !vp.hasPrintableParts();
      if (shouldAttach) cpp.attach();
      else cpp.detach();
    };
    document.addEventListener(LAY_FLAT_COMMITTED_EVENT, () => {
      updateCutPreviewVisibility();
    });
    // Also re-evaluate on parameters change (sideCount changed → rebuild
    // + make sure it's attached in the right state).
    parametersStore?.subscribe(() => {
      if (vp.cutPlanesPreview?.isVisible()) {
        // Already attached, rebuild handled elsewhere.
      } else {
        updateCutPreviewVisibility();
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
        // Issue #77 — abort any in-flight Generate worker before we
        // clear the scene. A new-STL load, orientation commit, or
        // reset invalidates any pending result, and we'd rather stop
        // the worker now than let it post back into a dead scene.
        cancelCurrentWorkerRun();
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
        // Issue #91 — every printable-parts teardown also invalidates
        // the Export STL button. The scene module has just disposed the
        // cached Manifolds, so the orchestrator's held references are
        // now pointing at freed WASM memory; drop them before any
        // user click can hand them to the geometry adapter.
        generateOrchestrator?.invalidateExportables();
      },
    });
  }

  if (process.env.NODE_ENV === 'test') {
    const w = window as unknown as {
      __testHooks?: Record<string, unknown>;
    };
    const hooks = (w.__testHooks ??= {});
    hooks['parameters'] = parametersStore;
    if (dimensionsStore) hooks['dimensions'] = dimensionsStore;
    if (generateButton) hooks['generateButton'] = generateButton;
  }
  // Silence unused-var lint for the panel handles — we need the reference
  // to prevent early GC of its listeners, and to give future shutdown
  // hooks a place to call destroy().
  void parameterPanel;
  void dimensionsPanel;
  void cutOverridesReadout;
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
  // Issue #79 — reset the Dimensions store on every new master load so
  // the scale controls start at 100 % and the axis readouts show the
  // new STL's native bbox. `setMaster` already resets `group.scale` to
  // (1,1,1) at the scene-graph layer; this keeps the UI store aligned.
  // `refresh()` re-renders the panel so the new `nativeBbox` feeds the
  // mm readouts even when the store was already at defaults (no-op
  // reset case).
  if (dimensionsStore) dimensionsStore.reset();
  if (dimensionsPanel) dimensionsPanel.refresh();
  // Bump the shared generate-epoch so any in-flight run against the
  // previous master drops its result on resolve. `notifyMasterReset`
  // only fires a committed-event when a commit was previously live, so
  // the invalidation listener covers only the "had-commit → new-STL"
  // path. Bumping here covers the first-load / no-prior-commit path too.
  bumpGenerateEpoch();
  // Issue #77 — also kill any in-flight generate worker. The epoch bump
  // above makes the pipeline's resolved result get dropped on arrival,
  // but the worker would still burn a CPU core computing that doomed
  // result. Terminating it here frees the thread immediately. Safe when
  // no worker is live (no-op). Covers the first-load + no-prior-commit
  // path the invalidation listener misses (that listener only fires on
  // the `LAY_FLAT_COMMITTED_EVENT` stream).
  cancelCurrentWorkerRun();
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
  // Issue #91 — the clear above disposed the cached Manifolds, so the
  // orchestrator's exportables refs (if any) are now stale. Drop them
  // before they can be handed out. The lay-flat controller's
  // `notifyMasterReset` also fires the invalidation event which hits
  // the `clearPrintableParts` callback in `attachGenerateInvalidation`;
  // doing it here covers the first-load + no-prior-commit case.
  generateOrchestrator?.invalidateExportables();
  // Reset the exploded-view UI mirror on every new master load — the
  // fresh master starts collapsed.
  explodedViewActive = false;
  if (topbar) {
    topbar.setMasterVolume(result.volume_mm3);
    // Any previously-populated silicone / print-shell / resin values are
    // for the OLD master and must be cleared. The lay-flat controller's
    // `notifyMasterReset` will also fire a committed-event that clears
    // them, but only when a commit was previously live — belt-and-
    // braces here covers the first-load case and any defensive UI state.
    topbar.setSiliconeVolume(null);
    topbar.setResinVolume(null);
    topbar.setPrintShellVolume(null);
    topbar.setBaseSlabVolume(null);
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
