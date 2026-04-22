## Goal

Ship the missing v1 feature: **STL export.** The app generates a complete mold geometry (base slab + N shell pieces with brims + silicone) but has no way to save it as printable files. Without this, the app is demo-only.

## Scope — single PR

### UI

Add an **Export STL** button in the topbar, positioned between the unit toggle and the right edge (or as a new right-section element — agent's call, but match existing visual language).

- Disabled when no generate has happened (hasPrintableParts === false).
- Disabled during busy (generateButton.isBusy()).
- Disabled when stale (generateButton.isStale()) — force re-generate first so files match on-screen geometry.
- On click: open a folder picker, write files, show success toast with path.

### IPC — new channel `file:export-mold-parts`

Add to `shared/ipc-contracts.ts`:

```ts
export interface ExportMoldPartsRequest {
  /**
   * Per-part binary STL blob plus the filename it should be written as
   * (no path component — main process places them under the user-picked
   * folder). One entry per printable part; caller provides them in the
   * order they should be written.
   */
  files: Array<{ data: ArrayBuffer; filename: string }>;
}

export type ExportMoldPartsResponse =
  | { canceled: true }
  | { canceled: false; folder: string; written: string[] }
  | { canceled: false; error: 'write-failed'; folder?: string; written: string[] };
```

Add the channel to `IpcContracts` and `ApiBridge`.

### Main process handler

In `src/main/ipc.ts`:

- Register `file:export-mold-parts`.
- Pop `dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })`.
- For each `file` in `request.files`:
  - Validate `filename` — no path separators, no absolute paths, no `..`, no reserved Windows names (CON, PRN, AUX, etc.). Reject with `write-failed` if invalid.
  - Write `Buffer.from(file.data)` to `path.join(selectedFolder, file.filename)`.
  - On per-file write failure, STOP, return `{canceled: false, error: 'write-failed', folder, written}` with the list written so far.
- On success: `{canceled: false, folder, written}`.

### Preload bridge

Extend `src/preload/index.ts` with `exportMoldParts` wrapping the new channel.

### Renderer — new module `src/renderer/ui/exportStl.ts`

```ts
export interface ExportStlApi {
  setEnabled(enabled: boolean): void;
  destroy(): void;
}
export function mountExportStlButton(
  container: HTMLElement,
  options: {
    getExportables: () => { basePart: Manifold | null; shellPieces: Manifold[] } | null;
    onSuccess: (folder: string, count: number) => void;
    onError: (message: string) => void;
  },
): ExportStlApi;
```

On click:
1. Disable the button (in-flight guard).
2. Get current parts via `getExportables()`. Bail with error toast if null.
3. For each Manifold (`basePart`, then `shellPieces[0..N-1]`):
   - Convert to `BufferGeometry` via existing `manifoldToBufferGeometry`.
   - Convert to binary STL via `STLExporter` (from `three/examples/jsm/exporters/STLExporter`).
   - Collect into `files: Array<{data: ArrayBuffer, filename: string}>`.
4. Filenames (deterministic):
   - `base-slab.stl`
   - `shell-piece-0.stl` through `shell-piece-{N-1}.stl`
5. Call `window.api.exportMoldParts({files})`.
6. Show success toast: "Exported {N+1} files to {folder}".
7. On error: show error toast with the generic message; on partial-success (`written < files.length`), message includes how many were written.
8. Re-enable the button.

### Orchestrator wiring

`src/renderer/ui/generateOrchestrator.ts` exposes a handle for getting the current exportable parts (Manifolds held by the orchestrator post-generate). The new export module reads from this handle.

Alternatively: orchestrator pushes the Manifolds into an export-state slice on generate-success, and the button reads from there. Agent picks whichever matches existing state patterns.

### i18n

New keys under `export.*` in `src/renderer/i18n/en.json`:
- `export.button` = "Export STL"
- `export.successToast` (with `{count}` and `{folder}` placeholders) = "Exported {count} files to {folder}"
- `export.errorToast` = "Failed to export STL"
- `export.partialToast` (with `{written}`, `{total}`, `{folder}`) = "Exported {written} of {total} files to {folder} before error"
- `export.disabledTooltip` = "Generate a mold first to export"
- `export.staleTooltip` = "Regenerate before exporting (parameters changed)"

### Tests

- `tests/renderer/ui/exportStl.test.ts` — button enable/disable logic, click handler wiring, error paths.
- `tests/main/ipc.test.ts` (if it exists; else a new one) — validate `file:export-mold-parts` rejects path traversal, reserved names, and writes the correct number of files.
- `tests/e2e/stl-export-roundtrip.spec.ts` — open STL → commit face → Generate → click Export → verify files exist on disk → verify they're non-empty binary STLs (first 80 bytes + tri count header). Use a temp directory via Playwright's `testInfo.outputDir`.

### Validation (security)

- Filename must match `/^[A-Za-z0-9._-]+\.stl$/i` (no paths, no reserved chars). Anything else → reject with `write-failed`.
- Absolute paths or `..` in filename → reject.
- Writes never leave the user-picked folder.

### Visual regression

Likely affected: topbar screenshots (new button). Use the one-shot workflow pattern.

## Acceptance

- [ ] Export button renders in the topbar, disabled pre-generate, enabled post-generate (not stale, not busy).
- [ ] Clicking the button opens a native folder picker.
- [ ] After folder selection, the app writes: `base-slab.stl`, `shell-piece-0.stl`, …, `shell-piece-{N-1}.stl` — one per printable part.
- [ ] Each written file is a valid binary STL (header + triangle count + 50 bytes per triangle).
- [ ] On cancel (user closes the picker), no files are written and no toast appears.
- [ ] On write error partway through, toast reports "exported X of Y files"; the successful writes stay on disk.
- [ ] Filename validation blocks path traversal + reserved names (unit test).
- [ ] Silicone is NOT exported (it's cast, not printed). If the user wants to export silicone for reference/simulation later, that's a follow-up.
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e && pnpm test:visual` all green.
- [ ] `.github/workflows/` at final HEAD = `ci.yml` only.
- [ ] i18n coverage — no hardcoded English in renderer.

## Out of scope

- ASCII STL export (binary only per CLAUDE.md tolerances spec).
- Export silicone STL (printable parts only for v1).
- Export a combined / multi-material STL.
- Per-file save dialogs (folder-picker is one-and-done).
- Auto-populating a filename prefix from the loaded STL's name (follow-up if user wants it).
- Opening the folder in the OS file explorer after success (follow-up).
- 3MF / OBJ / STEP formats.
- #76, #77, #78, #81, #86 follow-ups.

## Effort

~1 day. Single PR.

## Agent

`agent:app-shell` (main-process IPC) + `agent:frontend` (UI + renderer code). Single agent handles both since the surface is small.

## Files — expected diff

**Create:**
- `src/renderer/ui/exportStl.ts` — button + click handler.
- `tests/renderer/ui/exportStl.test.ts`.
- `tests/e2e/stl-export-roundtrip.spec.ts`.
- Possibly `tests/main/ipc-exportMoldParts.test.ts` if main-process unit tests exist.

**Modify:**
- `shared/ipc-contracts.ts` — new `file:export-mold-parts` channel + request/response + bridge.
- `src/preload/index.ts` — `exportMoldParts` method.
- `src/main/ipc.ts` — handler + validation.
- `src/renderer/main.ts` — mount `mountExportStlButton`; wire orchestrator → exportables.
- `src/renderer/ui/generateOrchestrator.ts` — expose current exportable parts.
- `src/renderer/ui/topbar.ts` — layout accommodates new button.
- `src/renderer/i18n/en.json` — new keys.

**Transient:**
- `.github/workflows/update-linux-goldens.yml`.

## Follow-ups (not this PR)

- Export silicone as a reference STL (separate button / dropdown).
- Remember the last-used export folder.
- Auto-prefix filenames with the loaded master's filename.
- "Open folder after export" button in the success toast.
- 3MF / OBJ export.
- #76, #77, #78, #81, #86.
