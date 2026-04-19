# ADR 001 — Desktop Platform / Runtime

- **Status:** Proposed (pending user approval at Phase 0 gate)
- **Date:** 2026-04-18
- **Deciders:** Lead architect (me) in consultation with the user

## Context

We need a runtime to host a Windows-first desktop app with:

- A Three.js (WebGL2) 3D viewport.
- Heavy local file I/O: STL import (often 100 k–1 M triangles), **multi-file STL export** (every mold part — base, sides, cap — as its own STL).
- CSG-heavy geometry compute via `manifold-3d` (WASM).
- pnpm + TypeScript toolchain.
- Single-developer / small-audience distribution. Not Microsoft Store at v1.
- CI + a Windows code-signing story so SmartScreen doesn't block first-run users.

User guardrails (locked 2026-04-18): Windows-only v1, **rule out Rust/Tauri**, **rule out Python**.

## Options considered

| # | Option | Status |
|---|---|---|
| 1 | Electron + Three.js | **Selected** |
| 2 | Pure browser / PWA | Rejected (see Consequences) |
| 3 | Tauri + Three.js | Ruled out by user guardrail |
| 4 | Python + PyQt + VTK/Open3D | Ruled out by user guardrail |

### Electron + Three.js

- **Versions (2026):** Electron 40 (stable Jan, EOL Jun 30 2026), 41 (Mar), 42 (May), 43 (Jun 30). New major every ~8 weeks; support = latest 3 majors (effective ~4-month window per major).
- **Installer size:** 80–150 MB NSIS compressed; realistic installed size 120–350 MB.
- **Filesystem UX:** First-class native dialogs (`dialog.showOpenDialog`, `showSaveDialog`), multi-file and directory selection trivial, no sandbox friction, streams and arbitrary paths.
- **Code signing (Windows):** Azure Trusted Signing ~$9.99/month = cheapest path as of 2026 for eligible individual devs (US/Canada + 3-yr history). Alternative: EV cert $300–700/yr + HSM/USB token. **SmartScreen reputation still builds over 2–6 weeks** regardless of cert class since Mar 2024.
- **Auto-update:** `electron-updater` (part of `electron-builder`) — GitHub Releases / S3 / generic HTTPS backends, delta updates via NSIS diffs.
- **Geometry libs:** `manifold-3d` WASM runs identically in Node main or Chromium renderer; heavy ops can move to a worker thread.
- **Testing:** Playwright Electron (`_electron.launch`) — actively maintained; near-parity with web-Playwright for DOM; native-menu/tray/OS-dialog paths need IPC-stubbing. Vitest + jsdom for renderer unit tests.
- **Known Windows gotchas:** NSIS antivirus false positives (mitigated by signing), `MAX_PATH` 260-char limit unless long paths enabled, `perMachine` + `selectPerMachineByDefault` known UAC bypass bug (use per-user one-click default for single-user tool).
- **Resources:** 150–300 MB idle RAM, ~1–2 s cold start.

### Pure browser / PWA

- **Bundle:** 2–4 MB first-load gzipped (Three.js ~600 KB + app + manifold-3d WASM ~700 KB–1 MB gz). URL distribution; optional installable PWA adds Start Menu shortcut.
- **Filesystem UX:** File System Access API (Chromium 86+ — Edge/Chrome). **Multi-file export is the pain point**: `showSaveFilePicker` is single-file, so the v1 UX must be "pick an output folder once via `showDirectoryPicker`, write N STLs into it." Acceptable but worse than native save-as per file.
- **OPFS:** Origin Private File System for scratch workspace; Chromium gives up to 60 % of disk per origin in 2026.
- **Signing:** N/A for the app; HTTPS cert via Let's Encrypt is free. No SmartScreen warning path — browser handles it.
- **Auto-update:** ServiceWorker; push a deployment, next-load picks it up.
- **Testing:** Best-in-class. Playwright in headed Chromium, full trace/video, no "experimental" caveats.
- **File Handling API:** PWA can register as OS handler for `.stl` on Chromium desktop; `window.launchQueue` delivers `FileSystemFileHandle`s. Narrows the UX gap with Electron but doesn't close it.
- **Limitations:** Chromium-only (Firefox/Safari don't support FSA), single-file save UX, session-scoped permissions unless user persists, no native-process access.

### Tauri + Three.js (ruled out)

Would have given a ~5–15 MB installer (uses WebView2), 30–50 MB idle RAM, Rust backend. Dual-language toolchain. Declining on user preference, not on technical grounds.

### Python + PyQt + VTK/Open3D (ruled out)

Richest native 3D toolbox (VTK, Open3D, trimesh, CadQuery), mature Windows packaging (PyInstaller/briefcase). Moves us off JS/TS ecosystem, loses Three.js, no web-reuse path. Declining on user preference.

## Decision

**Electron + Three.js.**

### Why

1. **Multi-file STL export is a core v1 feature.** Native `dialog.showSaveDialog` per-part or "Export All to chosen folder" both work naturally in Electron. PWA forces "pick one folder then we write N files into it" — a meaningfully worse UX for a tool where the user is evaluating mold parts one at a time and may want to re-export just one.
2. **Desktop-class expectations for a CAD-adjacent tool.** Users coming from Blender/Fusion/PrusaSlicer expect native file dialogs, drag-drop of paths, "Open Recent", and no browser chrome. Electron delivers this default-on.
3. **Future headroom for native integration.** Slicer hand-off (shell-out to PrusaSlicer/Cura CLI), STL repair tools (admesh, meshlab-server), USB/serial hooks — all off-limits in a PWA. Not v1 features, but v2 scope is realistic.
4. **Signing cost is low ($120/yr Azure Trusted Signing)** relative to the UX win.
5. **Windows-only v1 aligns with Electron's strengths** — we don't pay the "Electron is bloat for a web app" critique because we're genuinely leveraging native integration.

### Trade-offs accepted

- **Maintenance overhead:** Electron major every ~8 weeks; we'll track latest-3-majors and plan a bump cycle roughly monthly.
- **Installer size (80–150 MB)** — acceptable for desktop tooling; users are accustomed to this from Blender (~400 MB), Fusion, OrcaSlicer (~80 MB).
- **Higher RAM baseline (400 MB realistic)** — acceptable given users run this alongside slicers/editors.
- **First-run SmartScreen warning period** — 2–6 weeks of "unknown publisher"; we'll submit the signed binary to Microsoft manually on first release to shorten this.

### Explicitly rejected: PWA

- Multi-file export UX regression is the deal-breaker at v1.
- Chromium-only is fine, but committing to PWA also commits to the "we're a website" mental model — wrong frame for a desktop tool.
- Update-on-reload is nice, but autoupdater via `electron-updater` is a solved problem, not a meaningful burden.

### Why the trade-off is surfaced, not silenced

Per the user's working rule, the PWA path is genuinely cheaper at v1 (zero signing, zero installer, zero release pipeline). If the user's actual priority is **ship-fastest v0.1 and iterate**, PWA wins and this ADR should be flipped. Flagged at the Phase 0 gate.

## Consequences

**Positive**
- Native file dialogs and multi-file export "just work."
- Testing via Playwright Electron is usable from day 1.
- Future native-integration paths stay open.
- Single-language (TypeScript) codebase end-to-end.

**Negative**
- Code-signing setup required before first public build (~$120/yr, ~1 day of setup).
- Electron major upgrades every 8 weeks — risk of breaking changes in `electron-builder`, preload context isolation, or the updater pipeline.
- CI must install Electron + Playwright + signing credentials on Windows runners — more complex than a pure-web pipeline.
- Installer size + first-run SmartScreen period may friction the first 100 users.

**Neutral**
- Commits us to Chromium's WebGL2/WebGPU support as the 3D runtime (same as PWA would).
- Lock in on `manifold-3d` WASM as the geometry kernel (same in both options).

## Open questions surfaced for user decision at gate

1. **Code-signing identity situation?** Individual (Azure Trusted Signing requires US/Canada + 3-yr verifiable history), sole trader/company, or neither? This gates first-week install UX. If signing isn't viable at v1, we ship unsigned and accept the SmartScreen friction.
2. **Auto-update at v1 or defer to v1.1?** Electron can ship without auto-update; we'd just version bump and have users re-download. Saves 1–2 days of setup.
3. **Per-user vs. per-machine install default?** Recommend **per-user one-click** (no UAC) — right call for a single-user tool.
4. **Electron major cadence handling?** Adopt "stay on N-1 stable" (i.e. one major behind current) to get battle-tested builds, or "chase latest"? Recommend **N-1 stable**.

## References

- [Electron Release Schedule](https://releases.electronjs.org/schedule)
- [Electron Code Signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)
- [Azure Trusted Signing pricing](https://azure.microsoft.com/en-us/pricing/details/trusted-signing/)
- [Authenticode in 2025 — Azure Trusted Signing (textslashplain.com)](https://textslashplain.com/2025/03/12/authenticode-in-2025-azure-trusted-signing/)
- [electron-builder NSIS docs](https://www.electron.build/nsis.html)
- [Playwright Electron docs](https://playwright.dev/docs/api/class-electron)
- [File System Access API (Chrome docs)](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)
- [caniuse: File System Access API](https://caniuse.com/native-filesystem-api)
- [manifold-3d on npm](https://www.npmjs.com/package/manifold-3d)
- [NSIS AV false-positive tracking — electron-builder #6334](https://github.com/electron-userland/electron-builder/issues/6334)
