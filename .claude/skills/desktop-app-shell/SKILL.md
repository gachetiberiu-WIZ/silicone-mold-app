---
name: desktop-app-shell
description: Electron main/preload/renderer conventions — IPC bridge, file dialogs, window management, auto-updater, security flags. Use for any task that touches the Electron layer.
---

# desktop-app-shell skill

## When to invoke

Tasks that touch the Electron main process, preload script, IPC, native dialogs, window creation, app lifecycle, `electron-updater`, code signing, or the build configuration.

## Locked configuration

- Electron version: **track latest-3-majors; stay on N-1 stable** (one major behind current for battle-tested builds).
- Build tool: `electron-builder`. NSIS installer. Per-user one-click default (no UAC prompt for a single-user tool).
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` on every BrowserWindow's `webPreferences`.
- Preload exposes a typed IPC bridge via `contextBridge.exposeInMainWorld('api', …)`. No raw `ipcRenderer` in renderer code.
- Auto-updater: `electron-updater`, GitHub Releases target. Signed builds only.

## Process layout

```
main/            — Electron main process (Node)
  index.ts       — app lifecycle, BrowserWindow creation
  ipc.ts         — main-side IPC handlers, typed
  dialogs.ts     — showOpenDialog / showSaveDialog wrappers with test stubs
  updater.ts     — electron-updater setup
preload/
  index.ts       — contextBridge.exposeInMainWorld('api', typedBridge)
renderer/        — the Three.js app (Vite-built)
  …
shared/
  ipc-contracts.ts — shared TS types for IPC; DO NOT duplicate types in main/ or preload/
```

## IPC patterns

```ts
// shared/ipc-contracts.ts
export type IpcContracts = {
  'file:open-stl': (options: { multi?: boolean }) => { canceled: boolean; paths: string[] };
  'file:save-stl': (data: ArrayBuffer, suggestedName: string) => { canceled: boolean; path?: string };
  'app:get-version': () => string;
};

// preload/index.ts
contextBridge.exposeInMainWorld('api', {
  openStl: (opts) => ipcRenderer.invoke('file:open-stl', opts),
  saveStl: (data, name) => ipcRenderer.invoke('file:save-stl', data, name),
  getVersion: () => ipcRenderer.invoke('app:get-version'),
});

// renderer — typed through a declared window.api
const { canceled, paths } = await window.api.openStl({ multi: false });
```

## File dialogs + test stubs

```ts
// main/dialogs.ts
export async function showOpenStl(opts) {
  if (process.env.NODE_ENV === 'test' && globalThis.__testDialogStub) {
    return globalThis.__testDialogStub.showOpenDialog(opts);
  }
  return dialog.showOpenDialog({
    properties: ['openFile', ...(opts.multi ? ['multiSelections' as const] : [])],
    filters: [{ name: 'STL', extensions: ['stl'] }],
  });
}
```

Playwright tests replace `globalThis.__testDialogStub` via `electronApp.evaluate(...)` before triggering the UI action.

## Security requirements

- Never disable `contextIsolation` or enable `nodeIntegration` on any window, including diagnostic / debug windows.
- CSP in the renderer's `index.html`: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data:; style-src 'self' 'unsafe-inline'`.
- `'wasm-unsafe-eval'` permits WebAssembly compilation/instantiation (`WebAssembly.compile` / `WebAssembly.instantiate`); it is **distinct from** `'unsafe-eval'`, which additionally allows `eval()`, `new Function()`, and `setTimeout(string, ...)`. Only `'wasm-unsafe-eval'` is allowed in this repo — it is required for the locked `manifold-3d` WASM kernel (ADR-002). `'unsafe-eval'` must NEVER be added. If a future library claims to need `'unsafe-eval'`, replace the library; do not widen the CSP.
- STL file handling: bound tri count at parse time (reject > 10 M tri by default, 500 MB file size hard limit). Never trust normals — always re-derive.
- No remote code loading. All scripts bundled.
- Auto-updater: `requireCodeSigningCert: true`. Unsigned updates are rejected.

## Code signing

- Preferred: Azure Trusted Signing ($9.99/mo, US/Canada individuals with 3+yr history). Setup guide in `docs/signing.md` (create in Phase 3).
- Alternative: EV cert + HSM. Configure via `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD` env vars (see `.env.example`).
- At v1 launch: first 2–6 weeks have a SmartScreen "unknown publisher" warning even with signing. Submit the signed binary to Microsoft manually on first release to shorten.
- **Unsigned dev builds are allowed** locally and in PR CI — they just can't ship to users.

## Auto-updater UX

- Check on app start, debounced 24 h.
- Download in background; prompt user to restart to apply.
- No silent updates. No forced updates.
- Expose a "Check for updates" menu item.

## Anti-patterns

- Creating a second BrowserWindow with different security settings than the main window.
- Calling `ipcRenderer` directly from renderer code (must route through `window.api`).
- Reading/writing files from the renderer process (security boundary violation — goes through main).
- Shipping an unsigned installer to users "for the beta."
- Enabling `--inspect` in production builds.

## Testing

- Playwright `_electron.launch()` for all E2E. Fixture: `tests/e2e/fixtures/app.ts` exports the launch helper.
- Unit tests for main-process code use Vitest with a mock `electron` module.
- Coverage: instrument renderer via `page.coverage.startJSCoverage()`; instrument main via `NODE_V8_COVERAGE=./coverage/main`. Merge LCOV reports.
