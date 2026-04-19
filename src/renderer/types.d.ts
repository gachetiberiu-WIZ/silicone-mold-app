import type { ApiBridge } from '../../shared/ipc-contracts';

declare global {
  interface Window {
    /**
     * The typed IPC bridge exposed by preload via
     * `contextBridge.exposeInMainWorld('api', …)`.
     *
     * Calling a method that is not on ApiBridge (e.g. `window.api.nope()`)
     * is a TypeScript error.
     */
    readonly api: ApiBridge;
  }
}

export {};
