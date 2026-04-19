import { contextBridge, ipcRenderer } from 'electron';
import type {
  ApiBridge,
  OpenStlRequest,
  SaveStlRequest,
} from '../../shared/ipc-contracts';

/**
 * The single, typed surface that renderer code can see. Every call must go
 * through `window.api.*`. Raw `ipcRenderer` is NOT exposed.
 */
const api: ApiBridge = {
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  openStl: (request: OpenStlRequest) =>
    ipcRenderer.invoke('file:open-stl', request),
  saveStl: (request: SaveStlRequest) =>
    ipcRenderer.invoke('file:save-stl', request),
};

contextBridge.exposeInMainWorld('api', api);
