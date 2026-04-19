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

/**
 * Typed error codes surfaced from `file:open-stl`.
 *
 * Kept small and string-literal so the renderer can exhaustively switch on it
 * to pick a localised message. When adding a new variant, update every
 * consumer — the TS compiler will flag missing cases.
 */
export type OpenStlError = 'file-too-large' | 'read-failed';

/**
 * Discriminated-union return type for `file:open-stl`.
 *
 * Narrowing rules (critical — the renderer relies on these):
 * - `result.canceled === true` → user closed the native dialog, no other
 *   fields are present.
 * - `result.canceled === false && 'error' in result` → the main process
 *   selected a file but failed to honour the request (e.g. oversized).
 * - `result.canceled === false && !('error' in result)` → success; `name`
 *   (basename) and `buffer` (ArrayBuffer of file bytes) are guaranteed.
 *
 * The `buffer: ArrayBuffer` shape transfers across the Electron IPC boundary
 * via structured clone — the receiver sees a fresh ArrayBuffer, not a
 * SharedArrayBuffer or a Node Buffer.
 */
export type OpenStlResponse =
  | { canceled: true }
  | { canceled: false; name: string; buffer: ArrayBuffer }
  | { canceled: false; error: OpenStlError };

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

/**
 * Hard upper bound on STL file size accepted by `file:open-stl`, in bytes.
 *
 * Aligned with the security guidance in CLAUDE.md and the desktop-app-shell
 * skill: "Reject files > 500 MB without explicit user override." Main-process
 * code `stat`s the file before reading it to avoid allocating a half-gig
 * buffer just to refuse it.
 */
export const OPEN_STL_MAX_BYTES = 500 * 1024 * 1024;
