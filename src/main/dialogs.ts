import { dialog, type OpenDialogOptions, type SaveDialogOptions } from 'electron';
import { promises as fs } from 'node:fs';
import type {
  OpenStlRequest,
  SaveStlRequest,
  SaveStlResponse,
} from '../../shared/ipc-contracts';

/**
 * Test-time dialog stub. Populated from Playwright via
 * `electronApp.evaluate((electron, stub) => { globalThis.__testDialogStub = stub; })`.
 *
 * Only honoured when NODE_ENV === 'test'.
 */
declare global {
  var __testDialogStub:
    | {
        showOpenDialog?: (
          opts: OpenDialogOptions,
        ) => Promise<{ canceled: boolean; filePaths: string[] }>;
        showSaveDialog?: (
          opts: SaveDialogOptions,
        ) => Promise<{ canceled: boolean; filePath?: string }>;
      }
    | undefined;
}

const isTest = (): boolean => process.env['NODE_ENV'] === 'test';

/**
 * Raw-dialog result for the Open-STL flow.
 *
 * Kept deliberately close to Electron's native `OpenDialogReturnValue` shape
 * so the ipc.ts handler — which layers file reads and size checks on top —
 * can stay thin.
 */
export interface OpenStlDialogResult {
  canceled: boolean;
  filePaths: string[];
}

export async function showOpenStl(
  request: OpenStlRequest,
): Promise<OpenStlDialogResult> {
  const options: OpenDialogOptions = {
    properties: request.multi
      ? ['openFile', 'multiSelections']
      : ['openFile'],
    filters: [{ name: 'STL', extensions: ['stl'] }],
  };

  if (isTest() && globalThis.__testDialogStub?.showOpenDialog) {
    const stubbed = await globalThis.__testDialogStub.showOpenDialog(options);
    return {
      canceled: stubbed.canceled,
      filePaths: stubbed.filePaths ?? [],
    };
  }

  const result = await dialog.showOpenDialog(options);
  return { canceled: result.canceled, filePaths: result.filePaths };
}

export async function showSaveStl(
  request: SaveStlRequest,
): Promise<SaveStlResponse> {
  const options: SaveDialogOptions = {
    defaultPath: request.suggestedName,
    filters: [{ name: 'STL', extensions: ['stl'] }],
  };

  let canceled: boolean;
  let filePath: string | undefined;

  if (isTest() && globalThis.__testDialogStub?.showSaveDialog) {
    const stubbed = await globalThis.__testDialogStub.showSaveDialog(options);
    canceled = stubbed.canceled;
    filePath = stubbed.filePath;
  } else {
    const result = await dialog.showSaveDialog(options);
    canceled = result.canceled;
    filePath = result.filePath;
  }

  if (canceled || !filePath) {
    return { canceled: true };
  }

  // Write the buffer. Convert ArrayBuffer → Buffer for node:fs.
  const buffer = Buffer.from(request.data);
  await fs.writeFile(filePath, buffer);
  return { canceled: false, path: filePath };
}
