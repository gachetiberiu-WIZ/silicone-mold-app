/**
 * Shared IPC contracts between Electron main, preload, and renderer.
 *
 * DO NOT duplicate these types elsewhere. Any new IPC channel starts here.
 *
 * Each channel is keyed by its string id. The tuple is [requestArgs, responseValue].
 * Consumers derive helper types (Handlers / Bridge) below.
 */

export interface OpenStlRequest {
  multi?: boolean;
}

export interface OpenStlResponse {
  canceled: boolean;
  paths: string[];
}

export interface SaveStlRequest {
  /**
   * Raw bytes of the STL file. ArrayBuffer transfers efficiently over the
   * structured-clone IPC channel.
   */
  data: ArrayBuffer;
  suggestedName: string;
}

export interface SaveStlResponse {
  canceled: boolean;
  path?: string;
}

/**
 * The canonical channel → (args, result) map. All other IPC-related types
 * derive from this so a new channel only has to be added here.
 */
export type IpcContracts = {
  'app:get-version': {
    args: [];
    result: string;
  };
  'file:open-stl': {
    args: [OpenStlRequest];
    result: OpenStlResponse;
  };
  'file:save-stl': {
    args: [SaveStlRequest];
    result: SaveStlResponse;
  };
};

export type IpcChannel = keyof IpcContracts;

/**
 * Renderer-facing bridge type. What `window.api` looks like after preload has
 * wired everything up. Methods are strongly typed; there is no escape hatch.
 */
export interface ApiBridge {
  getVersion: () => Promise<IpcContracts['app:get-version']['result']>;
  openStl: (
    request: OpenStlRequest,
  ) => Promise<IpcContracts['file:open-stl']['result']>;
  saveStl: (
    request: SaveStlRequest,
  ) => Promise<IpcContracts['file:save-stl']['result']>;
}
