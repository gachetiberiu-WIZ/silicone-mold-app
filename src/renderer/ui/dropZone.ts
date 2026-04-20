// src/renderer/ui/dropZone.ts
//
// Window-scoped STL drag-and-drop handler (issue #27).
//
// Responsibilities:
//   - Attach `dragenter` / `dragover` / `dragleave` / `drop` listeners to
//     the provided target element.
//   - On drop, validate the payload and hand a single `ArrayBuffer` back
//     to the caller via `onDrop`. Surface any validation failure via
//     `onError(code, localisedMessage)` so the caller can route it through
//     the shared error-toast channel.
//   - Apply / remove the `.dropzone--active` class on the target element
//     during a drag, wrapping a `dragenter`/`dragleave` counter so nested
//     children (the Three.js canvas, sidebar inputs) don't flicker the
//     outline off mid-drag.
//
// Security-critical constraints (see CLAUDE.md + docs/adr/001-platform.md):
//   - The renderer MUST NOT read `file.path` or use any Node `fs` API. This
//     module deliberately uses the HTML5 `File.arrayBuffer()` API, which
//     returns the bytes without ever exposing the host filesystem path.
//   - There is no new IPC channel — the dropped buffer reuses the same
//     in-renderer code path the Open-STL dialog hands its buffer to.
//
// Validation (all fail fast; no state change on error):
//   1. Zero files → no-op. `DataTransfer.files` may be empty for directory
//      drops on some browsers; we treat that as "not a valid drop" rather
//      than an explicit error to avoid a noisy toast on accidental drags.
//   2. More than one file → `multiple-files` error.
//   3. Extension not `.stl` (case-insensitive) → `wrong-extension` error.
//   4. File size > `OPEN_STL_MAX_BYTES` → `file-too-large` error.
//
// The buffer is only read (via `file.arrayBuffer()`) after all validations
// pass — oversized files don't get allocated just to be rejected.

import { OPEN_STL_MAX_BYTES } from '@shared/ipc-contracts';
import { t } from '../i18n';

/**
 * Discriminated error codes. Kept as string literals so the caller can
 * switch exhaustively and the type checker will flag a missing case when
 * a new validation rule is added.
 */
export type DropZoneErrorCode =
  | 'multiple-files'
  | 'wrong-extension'
  | 'file-too-large'
  | 'read-failed';

export interface DropZoneCallbacks {
  /**
   * Fired when a validated single `.stl` file has been read into memory.
   * The `name` is the file basename (no path, since we never see one).
   */
  onDrop(buffer: ArrayBuffer, name: string): void | Promise<void>;
  /**
   * Fired when validation rejects the drop. `code` is stable for tests;
   * `message` is the already-localised copy ready for the user-facing
   * error channel.
   */
  onError(code: DropZoneErrorCode, message: string): void;
}

export interface DropZoneApi {
  /** Detach every listener and clear any lingering `.dropzone--active`. */
  destroy(): void;
}

/** Resolved i18n message for a given error code. */
function messageFor(code: DropZoneErrorCode): string {
  switch (code) {
    case 'multiple-files':
      return t('errors.singleFile');
    case 'wrong-extension':
      return t('errors.stlOnly');
    case 'file-too-large':
      return t('errors.fileTooLarge');
    case 'read-failed':
      return t('errors.readFailed');
    default: {
      const exhaustive: never = code;
      return String(exhaustive);
    }
  }
}

/** Case-insensitive `.stl` extension check on the file name. */
function isStlFile(file: File): boolean {
  return file.name.toLowerCase().endsWith('.stl');
}

/**
 * Wire the drop-zone onto `target`. All listeners are bound with
 * `preventDefault()` so the browser's default "navigate to file://…"
 * behaviour cannot fire — that would otherwise replace the renderer
 * document and crash the Electron window.
 *
 * `onDrop` is awaited (if it returns a promise) so async errors bubble
 * into this module's `try/catch` and surface through `onError` rather
 * than escaping as an unhandled rejection.
 */
export function attachDropZone(
  target: HTMLElement,
  callbacks: DropZoneCallbacks,
): DropZoneApi {
  // Nested `dragenter`/`dragleave` fire for every child element the cursor
  // crosses over. Tracking the depth keeps the outline on for the entire
  // drag and only removes it when the cursor truly leaves the window.
  let dragDepth = 0;

  const setActive = (active: boolean): void => {
    if (active) {
      target.classList.add('dropzone--active');
    } else {
      target.classList.remove('dropzone--active');
    }
  };

  const onDragEnter = (event: DragEvent): void => {
    // Only react to drags that carry files — ignore text/in-page drags.
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    dragDepth += 1;
    if (dragDepth === 1) setActive(true);
  };

  const onDragOver = (event: DragEvent): void => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    // preventDefault is REQUIRED on dragover to mark this element as a
    // valid drop target; without it the subsequent `drop` event never
    // fires. See HTML Living Standard §6.8.4.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  const onDragLeave = (event: DragEvent): void => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setActive(false);
  };

  const onDrop = async (event: DragEvent): Promise<void> => {
    // Always prevent the default regardless of validation outcome: if the
    // browser navigates to `file://…` we lose the entire app window.
    event.preventDefault();
    dragDepth = 0;
    setActive(false);

    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) {
      // Directory drop (no File entries) or a spurious empty drop. No
      // error toast — it would be noisy for a user-visible "nothing
      // happened" outcome.
      return;
    }

    if (files.length > 1) {
      callbacks.onError('multiple-files', messageFor('multiple-files'));
      return;
    }

    const file = files[0];
    if (!file) return;

    if (!isStlFile(file)) {
      callbacks.onError('wrong-extension', messageFor('wrong-extension'));
      return;
    }

    if (file.size > OPEN_STL_MAX_BYTES) {
      callbacks.onError('file-too-large', messageFor('file-too-large'));
      return;
    }

    try {
      const buffer = await file.arrayBuffer();
      await callbacks.onDrop(buffer, file.name);
    } catch (err) {
      console.error('[drop-zone] failed to read dropped file:', err);
      callbacks.onError('read-failed', messageFor('read-failed'));
    }
  };

  // The `drop` handler is async but EventListener expects a `void`-returning
  // function. Wrap it so the returned Promise is fired-and-forgotten (errors
  // inside `onDrop` are already caught and routed through `onError`).
  const onDropListener = (ev: Event): void => {
    void onDrop(ev as DragEvent);
  };

  target.addEventListener('dragenter', onDragEnter);
  target.addEventListener('dragover', onDragOver);
  target.addEventListener('dragleave', onDragLeave);
  target.addEventListener('drop', onDropListener);

  return {
    destroy(): void {
      target.removeEventListener('dragenter', onDragEnter);
      target.removeEventListener('dragover', onDragOver);
      target.removeEventListener('dragleave', onDragLeave);
      target.removeEventListener('drop', onDropListener);
      dragDepth = 0;
      setActive(false);
    },
  };
}
