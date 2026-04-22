import { contextBridge, ipcRenderer } from 'electron';
import type {
  ApiBridge,
  ExportMoldPartsRequest,
  OpenStlRequest,
  SaveStlRequest,
} from '../../shared/ipc-contracts';

/**
 * The single, typed surface that renderer code can see. Every call must go
 * through `window.api.*`. Raw `ipcRenderer` is NOT exposed.
 *
 * ArrayBuffer roundtrip: Electron's `ipcRenderer.invoke` uses structured
 * clone for payloads. `openStl` returns an `OpenStlResponse` whose success
 * variant carries a plain `ArrayBuffer`; the main process allocates and
 * transfers a standalone ArrayBuffer (see src/main/ipc.ts) so the renderer
 * receives a clean, exact-sized instance here — no slicing needed.
 *
 * `exportMoldParts` is the inverse direction (issue #91): the renderer
 * hands the main process a batch of STL ArrayBuffers, the main process
 * pops a folder picker and writes each file under the chosen directory.
 */
const api: ApiBridge = {
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  openStl: (request: OpenStlRequest) =>
    ipcRenderer.invoke('file:open-stl', request),
  saveStl: (request: SaveStlRequest) =>
    ipcRenderer.invoke('file:save-stl', request),
  exportMoldParts: (request: ExportMoldPartsRequest) =>
    ipcRenderer.invoke('file:export-mold-parts', request),
};

contextBridge.exposeInMainWorld('api', api);
