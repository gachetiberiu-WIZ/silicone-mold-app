import { app, ipcMain } from 'electron';
import type {
  IpcContracts,
  OpenStlRequest,
  SaveStlRequest,
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
      return showOpenStl(request ?? {});
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
