// src/renderer/ui/exportStl.ts
//
// "Export STL" toolbar button (issue #91). Wraps the
// `file:export-mold-parts` IPC channel with a thin DOM surface:
//
//   <button class="export-stl__btn" />
//
// Click flow:
//   1. Disable the button + flip the label to "Exporting…" (in-flight
//      guard — even if main.ts's state-sync path lags a frame).
//   2. Read the current exportables via `getExportables()`. Null →
//      error toast, bail.
//   3. For each Manifold (basePart, then shellPieces[0..N-1]):
//        - manifoldToBufferGeometry → BufferGeometry
//        - STLExporter.parse(mesh, {binary:true}) → DataView
//        - slice the underlying ArrayBuffer to the DataView's window so
//          the IPC payload contains ONLY the STL bytes.
//      Caller does NOT dispose the Manifolds — they belong to the scene
//      sink via the orchestrator (see generateOrchestrator.ts).
//   4. Filenames (deterministic): `base-slab.stl`, `shell-piece-0.stl`,
//      …, `shell-piece-{N-1}.stl`.
//   5. Invoke `window.api.exportMoldParts({files})`.
//   6. Cancel → no toast (user dismissed intentionally).
//      Success → success toast `{count, folder}`.
//      Error with `written < total` → partial-success toast.
//      Error with `written === 0` → generic error toast.
//   7. Re-enable the button.
//
// i18n:
//   - export.button           — visible label
//   - export.exporting        — busy label while IPC is in flight
//   - export.successToast     — success message with {{count}} + {{folder}}
//   - export.errorToast       — generic failure
//   - export.partialToast     — partial success with {{written}}, {{total}},
//                               {{folder}}
//   - export.noParts          — error toast when getExportables() is null
//                               (defensive — the caller should gate the
//                               button before click)
//   - export.disabledTooltip  — tooltip when disabled (pre-generate)
//   - export.staleTooltip     — tooltip when stale (re-generate first)
//
// Manifold lifetime: the orchestrator captured these references AFTER
// the scene sink accepted ownership. This module treats them as read-
// only borrowed references — no `.delete()` calls anywhere in this
// file. The next `clearPrintableParts` (on commit / reset / new STL)
// disposes them; the next successful Generate replaces them.

import { Mesh, MeshBasicMaterial } from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import type { Manifold } from 'manifold-3d';

import { manifoldToBufferGeometry } from '@/geometry/adapters';
import { t } from '../i18n';
import { showError, showNotice } from './errorToast';

/** Imperative handle returned by `mountExportStlButton`. */
export interface ExportStlApi {
  /** Flip enabled state. No-op while a click is in flight. */
  setEnabled(enabled: boolean): void;
  /**
   * Update the tooltip reason shown on hover. Distinct from
   * `setEnabled`: the button can be disabled with either a "no parts
   * yet" or a "parameters stale" tooltip, picked by the caller.
   */
  setTooltip(reason: 'none' | 'disabled' | 'stale'): void;
  /** Detach from the DOM + release listeners. */
  destroy(): void;
}

/** Callback surface supplied by `main.ts`. */
export interface ExportStlOptions {
  /**
   * Read the current Manifolds eligible for STL export. Returns `null`
   * when no successful generate has landed (or the last one was
   * invalidated). The module calls this exactly once per click and
   * bails with an error toast if it's null.
   */
  getExportables: () =>
    | { basePart: Manifold; shellPieces: readonly Manifold[] }
    | null;
  /**
   * Override the IPC bridge. Tests inject a mock so the unit spec
   * doesn't have to round-trip through Electron. Defaults to
   * `window.api.exportMoldParts` at call time.
   */
  exportMoldParts?: (typeof window)['api']['exportMoldParts'];
}

/**
 * Convert a Manifold to a binary STL ArrayBuffer. Extracted so the
 * click handler stays linear and tests can cover this conversion path
 * in isolation if needed in the future.
 *
 * Why slice the DataView window: `STLExporter.parse(..., {binary:true})`
 * returns a `DataView` whose `buffer` may be a larger allocator pool
 * (Node / Vite bundling of three.js). The IPC call structured-clones
 * the ENTIRE ArrayBuffer — slicing to the DataView's window means we
 * only ship the STL bytes, not any unrelated bytes that happened to
 * share the allocator.
 */
async function manifoldToBinaryStlBuffer(
  manifold: Manifold,
): Promise<ArrayBuffer> {
  const geometry = await manifoldToBufferGeometry(manifold);
  try {
    // `STLExporter` needs a real Mesh to crawl for the position buffer;
    // the material is ignored in binary mode but must be non-null.
    const mesh = new Mesh(geometry, new MeshBasicMaterial());
    const exporter = new STLExporter();
    const dv = exporter.parse(mesh, { binary: true }) as unknown as DataView;
    // `dv.buffer` is typed `ArrayBufferLike` (ArrayBuffer |
    // SharedArrayBuffer). Always copy into a fresh, tightly-sized
    // `ArrayBuffer` so the IPC structured-clone receives a plain,
    // exact-length buffer — same guarantee the main process makes for
    // the reverse direction in `file:open-stl`.
    const out = new ArrayBuffer(dv.byteLength);
    new Uint8Array(out).set(
      new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength),
    );
    return out;
  } finally {
    // The BufferGeometry is a transient copy of the Manifold's mesh —
    // it's not in the scene. Free its GPU-side buffers so repeated
    // exports don't accumulate.
    geometry.dispose();
  }
}

/**
 * Mount the Export STL button into `container`. Idempotent — call
 * `destroy()` first if you need to re-mount. Starts disabled; the
 * caller flips `setEnabled(true)` once a successful Generate is in
 * the scene and it isn't stale.
 */
export function mountExportStlButton(
  container: HTMLElement,
  options: ExportStlOptions,
): ExportStlApi {
  const { getExportables } = options;

  const root = document.createElement('div');
  root.className = 'export-stl';
  root.dataset['testid'] = 'export-stl';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'export-stl__btn';
  btn.dataset['testid'] = 'export-stl-btn';
  btn.textContent = t('export.button');
  btn.title = t('export.disabledTooltip');
  btn.disabled = true;
  root.appendChild(btn);
  container.appendChild(root);

  let enabled = false;
  let inFlight = false;
  let tooltipReason: 'none' | 'disabled' | 'stale' = 'disabled';

  function renderEnabled(): void {
    btn.disabled = !enabled || inFlight;
    btn.setAttribute('aria-disabled', btn.disabled ? 'true' : 'false');
  }

  function renderLabel(): void {
    btn.textContent = inFlight ? t('export.exporting') : t('export.button');
  }

  function renderTooltip(): void {
    if (tooltipReason === 'stale') {
      btn.title = t('export.staleTooltip');
    } else if (tooltipReason === 'disabled') {
      btn.title = t('export.disabledTooltip');
    } else {
      btn.title = '';
    }
  }

  async function handleClick(): Promise<void> {
    if (!enabled || inFlight) return;
    const parts = getExportables();
    if (!parts) {
      // Defensive: the button should be gated before click. If we got
      // here anyway, tell the user instead of silently failing.
      showError(t('export.noParts'));
      return;
    }
    inFlight = true;
    renderEnabled();
    renderLabel();

    try {
      // Build STL buffers in the deterministic order the issue spec
      // mandates: base slab first, then shell pieces by index.
      const files: Array<{ data: ArrayBuffer; filename: string }> = [];
      const basePartBuf = await manifoldToBinaryStlBuffer(parts.basePart);
      files.push({ data: basePartBuf, filename: 'base-slab.stl' });
      for (let i = 0; i < parts.shellPieces.length; i++) {
        const piece = parts.shellPieces[i];
        if (!piece) continue; // Defensive — sparse arrays shouldn't happen.
        const pieceBuf = await manifoldToBinaryStlBuffer(piece);
        files.push({ data: pieceBuf, filename: `shell-piece-${i}.stl` });
      }

      const api = options.exportMoldParts ?? window.api.exportMoldParts;
      const response = await api({ files });

      if (response.canceled) {
        // User dismissed the folder picker — no toast per the AC.
        return;
      }

      if ('error' in response) {
        if (response.written.length > 0 && response.folder) {
          showNotice(
            t('export.partialToast', {
              written: response.written.length,
              total: files.length,
              folder: response.folder,
            }),
          );
        } else {
          showError(t('export.errorToast'));
        }
        return;
      }

      showNotice(
        t('export.successToast', {
          count: response.written.length,
          folder: response.folder,
        }),
      );
    } catch (err) {
      console.error('[export] unexpected error while exporting STL:', err);
      showError(t('export.errorToast'));
    } finally {
      inFlight = false;
      renderEnabled();
      renderLabel();
    }
  }

  btn.addEventListener('click', () => {
    void handleClick();
  });

  renderEnabled();
  renderLabel();
  renderTooltip();

  return {
    setEnabled(next: boolean): void {
      if (enabled === next) return;
      enabled = next;
      renderEnabled();
    },
    setTooltip(reason: 'none' | 'disabled' | 'stale'): void {
      if (tooltipReason === reason) return;
      tooltipReason = reason;
      renderTooltip();
    },
    destroy(): void {
      root.remove();
    },
  };
}
