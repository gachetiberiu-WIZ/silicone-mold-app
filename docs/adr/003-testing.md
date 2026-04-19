# ADR 003 — Testing Strategy

- **Status:** Proposed (pending user approval at Phase 0 gate)
- **Date:** 2026-04-18
- **Depends on:** ADR-001 (Electron), ADR-002 (manifold-3d — deterministic engine enables hash-based snapshots)

## Context

Automated coverage is needed at three layers for a Windows-first Electron + Three.js app with mesh geometry (Boolean, offset, volume):

- **A. Geometry unit tests** — numerical tolerances against canonical fixture meshes (cube, sphere, torus, real miniature STL).
- **B. Viewport visual regression** — golden-screenshot comparison of Three.js scenes.
- **C. End-to-end user flow** — import → configure → generate → export.

CI runs on GitHub Actions; target OS is Windows but Linux runners are cheaper and faster for non-OS-dependent layers.

## Decisions

### A. Unit test runner → **Vitest** (not Jest)

- Vitest 3.x native ESM + TS, Jest-compatible `expect`, built-in snapshot + `.toMatchFileSnapshot`, workspace mode, first-class worker threads. Most TS + pnpm projects migrated off Jest through 2024–2025.
- Jest's ESM story remains rough in 2026; migration tax is not worth paying.
- `node --test` lacks snapshot ergonomics — rejected.

**Float-tolerance helper:** ship a small `toEqualWithTolerance(actual, expected, {abs, rel})` custom matcher via `expect.extend`. Reason: `toBeCloseTo` takes decimal-places, not absolute or relative ε, which is awkward for volumes in mm³ spanning 10⁰–10⁶.

**Example assertions:**

```ts
expect(meshVolume(geom)).toBeCloseTo(1.0, 4);                       // unit cube
expect(bbox.min.toArray()).toEqualWithTolerance([-0.5,-0.5,-0.5], {abs:1e-6});
expect(geom.index.count / 3).toBe(12);                              // tri count
expect(await manifold.isManifold()).toBe(true);                     // watertight
```

**STL snapshot via canonicalised SHA-256:** sort triangles, re-derive normals from vertex winding, round floats to 1e-5 mm, serialise little-endian binary STL, hash. Commit the hex digest under `__snapshots__/*.sha256`. Raw-bytes hashing across platforms is brittle — canonicalisation is essential.

manifold-3d is **deterministic across platforms** given identical inputs (per upstream guarantees + its adoption in Blender/OpenSCAD). This is the key property that makes hash snapshots viable in CI.

### B. Visual regression → **Playwright `toHaveScreenshot`** on Linux with SwiftShader

- Golden PNGs committed under `__screenshots__/linux-ci/*.png`. One test scene per user-facing view (master loaded, generated mold with axes, exploded parts view, 4-angle turntable sprite-sheet).
- Deterministic WebGL via Chromium `--use-gl=swiftshader --enable-unsafe-swiftshader`.
- Per-renderer controls: `antialias: false`, `setPixelRatio(1)`, fixed 1280×800 viewport, freeze `performance.now` via Playwright `page.clock.install()`.
- Diff thresholds: `maxDiffPixelRatio: 0.01`, per-channel `threshold: 0.15`.
- **Gating policy:** advisory for the first 2 weeks (reports diffs but doesn't block merge). Ratchet to required once flake rate < 1 %.
- **Windows smoke only:** one visual-regression scene runs on `windows-latest` to catch Windows-specific ANGLE/font regressions. The rest lives on Linux for speed.

Rejected: Storybook+Chromatic/Loki (overkill for a single canvas-based viewport), odiff-bin (unnecessary — Playwright's built-in comparator is sufficient at our scale).

### C. End-to-end → **Playwright + `_electron.launch()`**

- `import { _electron as electron } from '@playwright/test'`; `electronApp = await electron.launch({ args: ['.'] })`; `page = await electronApp.firstWindow()`.
- **File dialog stubbing:** mock `dialog.showOpenDialog` in main via `electronApp.evaluate(({dialog}) => { dialog.showOpenDialog = async () => ({canceled:false, filePaths:['C:/fixtures/mini.stl']}) })`. Same pattern for `showSaveDialog` → write to `test-results/` temp path.
- **Test hooks:** expose `window.__testHooks = { parseComplete: Promise, generateComplete: Promise, readyForInput: Promise }` only when `process.env.NODE_ENV === 'test'` at build time. Stripped from production bundle via dead-code elimination. Never use arbitrary `waitForTimeout` — always hook.
- **Full-flow test shape:** launch → wait `readyForInput` → stub dialog → click Import → await `parseComplete` → click Generate → await `generateComplete` → click Export → assert exported STL canonical-SHA matches golden.

### D. CI matrix → **GHA, Windows mandatory + Linux fast-path**

| Job | Runner | Gates PR? |
|---|---|---|
| `lint` | ubuntu-latest | Yes |
| `typecheck` | ubuntu-latest | Yes |
| `geometry` (Vitest unit) | ubuntu-latest | Yes |
| `visual-regression` (Playwright goldens) | ubuntu-latest | Advisory for 2 weeks → Yes |
| `visual-smoke` (one Windows scene) | windows-latest | Yes |
| `e2e-electron` (Playwright Electron) | windows-latest | Yes |
| `build-installer` (electron-builder) | windows-latest | Yes (on `main` only) |

**Caching:** pnpm store via `actions/setup-node@v4 cache: 'pnpm'`; Playwright browsers cached at `~/.cache/ms-playwright` (Linux) and `~/AppData/Local/ms-playwright` (Windows) keyed on Playwright version. WASM (`manifold-3d/*.wasm`) cached under `node_modules/.cache`.

**Artifacts:** upload Playwright traces, failure screenshots, and generated STLs on failure only, 7-day retention. HTML report always, 3-day retention.

**Runtime budget:** < 12 min on Windows, < 5 min on Linux geometry-only job. Shard Playwright at 10+ min.

### E. Canonical fixture meshes

Committed under `tests/fixtures/meshes/` in the repo (Phase 1):

| File | Purpose | Size budget |
|---|---|---|
| `unit-cube.stl` | watertight primitive, trivial volume (1 mm³) | < 5 KB |
| `unit-sphere-icos-3.stl` | icosphere subdivision-3, deterministic tri count (1280 tri), known volume | < 20 KB |
| `torus-32x16.stl` | genus-1 topology, tests non-trivial Euler characteristic | < 80 KB |
| `mini-figurine.stl` | real miniature master, ≤ 50 k tri, CC-BY-SA license | < 200 KB |

All under git directly (no LFS); Windows CI runs clone-fast.

## Open questions surfaced for user at gate

1. **Visual regression gating start:** advisory for 2 weeks then required (recommended), or advisory indefinitely (nightly only)?
2. **Coverage thresholds:** enforce line coverage on geometry module from day 1 (recommend 70%), or ratchet up over first 3 months from 0?
3. **Miniature fixture sourcing:** commit a CC-BY-SA mini STL (requires attribution file) or a procedurally-generated stand-in (avoids licensing but less realistic)? Recommend CC-BY-SA — realism matters for snapshot regression.
4. **macOS runner:** skip until cross-platform milestone (recommended), or add a `macos-latest` smoke-only job now as future-proofing?
5. **Test-hook surface:** strip `window.__testHooks` in prod (recommend), or keep behind `--test` launch flag for customer-reproduction debugging?

## Consequences

**Positive**
- Single runner (Vitest) for all unit tests across main + renderer.
- Deterministic manifold-3d + canonicalised STL hashing gives cheap, reliable regression coverage.
- Playwright covers both E2E (Electron) and visual regression — one tool to learn.
- Linux-first goldens with SwiftShader keeps CI fast without sacrificing Windows fidelity (smoke job catches OS-specific regressions).

**Negative**
- Test hooks in bundle require dead-code-elimination discipline and one build-time flag.
- First 2 weeks of visual regression = flaky until goldens stabilise. Accept the advisory period.
- STL canonicalisation code is a small project in itself (~100 LoC). Acceptable vs. raw-bytes brittleness.
- Windows CI runners cost ~10× Linux per-minute — the budget-guarding matrix above is not optional.

**Not in scope at v1**
- Fuzz testing geometry ops on random meshes.
- Mutation testing.
- Property-based testing (Fast-Check) — reconsider at v1.1.
- Performance regression tests (only manual profiling at v1).

## References

- [Vitest docs](https://vitest.dev/)
- [Vitest vs Jest comparison](https://vitest.dev/guide/comparisons)
- [Playwright `toHaveScreenshot`](https://playwright.dev/docs/test-snapshots)
- [Playwright Electron class](https://playwright.dev/docs/api/class-electron)
- [Playwright `page.clock`](https://playwright.dev/docs/clock)
- [Chromium SwiftShader flags](https://www.chromium.org/developers/design-documents/gpu-accelerated-compositing-in-chrome/)
- [manifold-3d](https://github.com/elalish/manifold)
- [odiff-bin (alternative pixel diff)](https://github.com/dmtrKovalenko/odiff)
- [pixelmatch](https://github.com/mapbox/pixelmatch)
- [GitHub Actions hosted runners](https://docs.github.com/en/actions/using-github-hosted-runners/about-github-hosted-runners)
- [pnpm in CI](https://pnpm.io/continuous-integration#github-actions)
- [Playwright CI browsers cache](https://playwright.dev/docs/ci)
- [STL binary format](https://www.fabbers.com/tech/STL_Format)
- [v8-to-istanbul (coverage)](https://github.com/istanbuljs/v8-to-istanbul)
- [Electron Automated Testing](https://www.electronjs.org/docs/latest/tutorial/automated-testing)
