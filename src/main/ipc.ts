import { app, ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import {
  OPEN_STL_MAX_BYTES,
  type IpcContracts,
  type OpenStlRequest,
  type OpenStlResponse,
  type SaveStlRequest,
} from '../../shared/ipc-contracts';
import { showOpenStl, showSaveStl } from './dialogs';

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
