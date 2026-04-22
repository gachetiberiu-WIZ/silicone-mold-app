import { app, ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import {
  OPEN_STL_MAX_BYTES,
  type ExportMoldPartsRequest,
  type ExportMoldPartsResponse,
  type IpcContracts,
  type OpenStlRequest,
  type OpenStlResponse,
  type SaveStlRequest,
} from '../../shared/ipc-contracts';
import { showOpenFolder, showOpenStl, showSaveStl } from './dialogs';

/**
 * Registers every IPC handler exactly once. Call from app `whenReady`.
 *
 * Each handler is typed through IpcContracts so the signatures cannot drift
 * from the renderer's expectations without a compile error.
 */
export function registerIpcHandlers(): void {
  ipcMain.handle('app:get-version', async (): Promise<
    IpcContracts['app:get-version']['result']
  > => {
    return app.getVersion();
  });

  ipcMain.handle(
    'file:open-stl',
    async (
      _event,
      request: OpenStlRequest,
    ): Promise<IpcContracts['file:open-stl']['result']> => {
      return handleOpenStl(request ?? {});
    },
  );

  ipcMain.handle(
    'file:save-stl',
    async (
      _event,
      request: SaveStlRequest,
    ): Promise<IpcContracts['file:save-stl']['result']> => {
      return showSaveStl(request);
    },
  );

  ipcMain.handle(
    'file:export-mold-parts',
    async (
      _event,
      request: ExportMoldPartsRequest,
    ): Promise<IpcContracts['file:export-mold-parts']['result']> => {
      return handleExportMoldParts(request ?? { files: [] });
    },
  );
}

/**
 * Filename whitelist regex used by `handleExportMoldParts`. Only ASCII
 * letters / digits / `._-` followed by an `.stl` extension (case-
 * insensitive). Rejects path separators, drive letters, Unicode, spaces,
 * and anything that could resolve outside the user-picked folder.
 */
export const EXPORT_FILENAME_PATTERN = /^[A-Za-z0-9._-]+\.stl$/i;

/**
 * Reserved Windows device names the shell refuses to open regardless of
 * extension. Validated case-insensitively against the filename's basename
 * (before `.stl`) so `CON.stl` and `con.STL` both get rejected even
 * though they match `EXPORT_FILENAME_PATTERN`.
 */
const WINDOWS_RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

/**
 * Validate a proposed export filename. Exported for unit testing — the
 * renderer always supplies deterministic names (`base-slab.stl`,
 * `shell-piece-{i}.stl`), but the main process re-validates to keep the
 * trust boundary clean.
 *
 * Rejects:
 *   - anything failing `EXPORT_FILENAME_PATTERN` (path separators,
 *     absolute paths, `..`, spaces, control chars, wrong extension),
 *   - reserved Windows device names (CON / PRN / AUX / NUL / COM1-9 /
 *     LPT1-9), case-insensitive,
 *   - the literal `.` / `..` tokens even if they'd match the pattern
 *     (belt-and-braces — `.stl` requires a leading char so the pattern
 *     already rules these out, but be explicit).
 */
export function isValidExportFilename(name: string): boolean {
  if (typeof name !== 'string') return false;
  if (!EXPORT_FILENAME_PATTERN.test(name)) return false;
  // Extract the basename (without `.stl`) and check it isn't a reserved
  // Windows device name.
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  if (WINDOWS_RESERVED_NAMES.has(base.toUpperCase())) return false;
  return true;
}

/**
 * End-to-end Export-Mold-Parts flow (issue #91): folder picker → per-file
 * validation → sequential writes → typed response.
 *
 * Error handling:
 *   - User cancels the folder picker → `{canceled: true}`.
 *   - Empty request → treated as a successful no-op write (`written: []`).
 *   - Any filename fails validation → `{error: 'write-failed'}` with
 *     whatever was already written before reaching the bad entry. This
 *     mirrors the write-failure path so callers see a single "partial or
 *     total failure" codepath.
 *   - Write throws → stop at the failing entry, same shape as
 *     validation rejection.
 *
 * Buffer handling: `ArrayBuffer` comes across the IPC boundary as a
 * structured-cloned plain buffer. `Buffer.from(data)` wraps it without
 * copying, so the main process writes the exact bytes the renderer
 * serialised.
 */
async function handleExportMoldParts(
  request: ExportMoldPartsRequest,
): Promise<ExportMoldPartsResponse> {
  const dialogResult = await showOpenFolder();
  if (dialogResult.canceled || dialogResult.filePaths.length === 0) {
    return { canceled: true };
  }

  const folder = dialogResult.filePaths[0];
  if (typeof folder !== 'string' || folder.length === 0) {
    return { canceled: true };
  }

  const files = Array.isArray(request.files) ? request.files : [];
  const written: string[] = [];

  for (const file of files) {
    if (!file || typeof file !== 'object') {
      return { canceled: false, error: 'write-failed', folder, written };
    }
    if (!isValidExportFilename(file.filename)) {
      return { canceled: false, error: 'write-failed', folder, written };
    }
    if (!(file.data instanceof ArrayBuffer)) {
      return { canceled: false, error: 'write-failed', folder, written };
    }

    const targetPath = join(folder, file.filename);
    try {
      await fs.writeFile(targetPath, Buffer.from(file.data));
      written.push(file.filename);
    } catch (err) {
      console.error(
        `[export-mold-parts] failed to write ${file.filename}:`,
        err,
      );
      return { canceled: false, error: 'write-failed', folder, written };
    }
  }

  return { canceled: false, folder, written };
}

/**
 * End-to-end Open-STL flow: native dialog → bounded file read → ArrayBuffer
 * payload suitable for structured-clone transport to the renderer.
 *
 * Size policy: files larger than `OPEN_STL_MAX_BYTES` (500 MB) are rejected
 * based on the `fs.stat` size BEFORE any bytes are read into memory. This
 * prevents a malicious or broken file from forcing a half-gig allocation in
 * the main process.
 *
 * Error handling: anything other than an over-sized file (permission
 * denied, file disappeared between stat and read, etc.) surfaces as
 * `{ canceled: false, error: 'read-failed' }`. The renderer picks the
 * localised copy from the error code.
 */
async function handleOpenStl(
  request: OpenStlRequest,
): Promise<OpenStlResponse> {
  const dialogResult = await showOpenStl(request);
  if (dialogResult.canceled || dialogResult.filePaths.length === 0) {
    return { canceled: true };
  }

  // v1 `file:open-stl` is single-select only — even when `multi: true` is
  // passed, we surface the first path. Multi-select wiring is a later
  // concern and belongs to a follow-up issue.
  const path = dialogResult.filePaths[0];
  if (typeof path !== 'string' || path.length === 0) {
    return { canceled: true };
  }

  let size: number;
  try {
    const stats = await fs.stat(path);
    size = stats.size;
  } catch {
    return { canceled: false, error: 'read-failed' };
  }

  if (size > OPEN_STL_MAX_BYTES) {
    return { canceled: false, error: 'file-too-large' };
  }

  let fileBytes: Buffer;
  try {
    fileBytes = await fs.readFile(path);
  } catch {
    return { canceled: false, error: 'read-failed' };
  }

  // Produce a clean, standalone ArrayBuffer. Node's `Buffer` shares an
  // underlying allocator-pool ArrayBuffer that can be larger than the file
  // and may be typed as `ArrayBufferLike` (ArrayBuffer | SharedArrayBuffer).
  // Allocate a fresh ArrayBuffer of exactly `byteLength` bytes and copy in —
  // this both tightens the byte range and guarantees the renderer sees a
  // plain ArrayBuffer via structured clone.
  const buffer = new ArrayBuffer(fileBytes.byteLength);
  new Uint8Array(buffer).set(fileBytes);

  return {
    canceled: false,
    name: basename(path),
    buffer,
  };
}
