# Project Plan — Silicone Mold App

Milestones, acceptance criteria, rough sequencing. This is a living document — update when a milestone closes or scope changes; never retroactively rewrite history (use the status log for that).

Milestones map 1:1 to the four phases. GitHub milestones mirror this file.

---

## Phase 0 — Research & Architecture — **CLOSED 2026-04-18**

**Goal:** lock four decisions before any code is written.

**Deliverables — all committed:**
- [x] `docs/research/molding-techniques.md`
- [x] `docs/adr/001-platform.md` (Electron)
- [x] `docs/adr/002-geometry-stack.md` (manifold-3d + three-mesh-bvh)
- [x] `docs/adr/003-testing.md` (Vitest + Playwright; Linux goldens; Windows E2E)
- [x] User approval at the gate; mold scope narrowed to two-halves-in-box only

---

## Phase 1 — Project skeleton — **IN PROGRESS**

**Goal:** empty repo is ready for feature work — tooling, conventions, CI, skills, agent roster all scaffolded.

### Acceptance criteria

- [ ] GitHub repo created, protected `main`, labels in sync with `.github/labels.yml`.
- [ ] Milestones Phase-1 / Phase-2 / Phase-3 exist with 1:1 mapping.
- [ ] `CLAUDE.md` in place at repo root.
- [ ] `.claude/skills/` has all 7 skills: mesh-operations, mold-generator, three-js-viewer, desktop-app-shell, testing-3d, qa-review, github-workflow.
- [ ] `docs/agents/` has all 8 role definitions plus a README index.
- [ ] `.github/` has PR template, issue templates (agent-task, bug, feature), labels.yml, workflows/ci.yml.
- [ ] Root config: `package.json` (pnpm 10.33), `tsconfig.json`, `.gitignore`, `.editorconfig`, `.nvmrc`, `.prettierrc.json`, `.env.example`.
- [ ] Initial commit created locally; first push to GitHub on repo creation.
- [ ] CI runs green on first push (even if all jobs are mostly no-op with no source yet).
- [ ] `docs/plan.md` and `docs/status.md` committed.
- [ ] `tests/fixtures/meshes/` exists with a README declaring fixture contract (fixtures themselves land in Phase 2 with the test infra).

### Tasks to open as issues once repo exists

- `[feat] repo bootstrap — protected main + labels + milestones`
- `[feat] CI green on bootstrap (lint + typecheck + empty test pass)`
- `[feat] test-engineer: scaffolding for Vitest + Playwright + custom matchers`
- `[feat] test-engineer: fixture loader + miniature source decision`

### Open blockers

- **GitHub MCP access** — currently not exposed in the session. Options: restart Claude Code, install gh CLI via elevated PowerShell, or user creates the repo manually. Until resolved, work stays local-only.
- **Code-signing identity** — not needed until first release build. Decide by end of Phase 2 at latest.
- **Miniature fixture source** — test-engineer opens an issue once it's spawned; lead decides CC-BY-SA STL vs. procedural stand-in.

---

## Phase 2 — Agent roster operations

**Goal:** prove the issue → branch → PR → QA → merge loop works end-to-end with a non-trivial task, via at least two different agents.

### Acceptance criteria

- [ ] Test infrastructure fully working: Vitest custom matchers, fixture loader, STL canonicalisation + SHA-256, Playwright + Electron launch, visual-regression baselines captured.
- [ ] Canonical mesh fixtures committed: `unit-cube.stl`, `unit-sphere-icos-3.stl`, `torus-32x16.stl`, `mini-figurine.stl` (each with `.json` sidecar).
- [ ] At least one merged PR from `geometry-dev` (smoke: `meshVolume(cube) === 1`).
- [ ] At least one merged PR from `app-shell-dev` (smoke: Electron launches, renderer shows a placeholder scene, IPC round-trips `app:get-version`).
- [ ] `qa-engineer` has reviewed and approved all PRs. No rubber-stamps.
- [ ] Visual regression has captured goldens for at least 2 canonical scenes.
- [ ] `build-installer` CI job produces a signed (or deliberately-unsigned dev) Windows installer.
- [ ] Hire/fire log in `docs/status.md` has at least one entry per active agent.

### Tasks to open as issues

- `[feat] app-shell-dev: Electron + Vite bootstrap renderer, typed IPC skeleton`
- `[feat] geometry-dev: meshVolume() against cube fixture`
- `[feat] geometry-dev: loadStl() + Manifold adapter`
- `[feat] test-engineer: STL canonicalisation + SHA-256 pipeline`
- `[feat] test-engineer: visual regression first goldens (empty scene, axes, grid)`
- `[feat] app-shell-dev: electron-builder NSIS installer in CI`

### Exit criteria

The loop is proven: a spec → agent → PR → QA → merge cycle takes < 1 day for a small task, and CI remains green.

---

## Phase 3 — v1 core features

**Goal:** ship v1 — user can import a master, pick parameters, generate mold parts, preview, export STLs, see volumes.

### User-facing acceptance criteria

- [ ] Import master STL (ASCII or binary, up to 500 MB, up to 10 M tri) via native Open dialog; display in viewport; show volume.
- [ ] UI for parameters: wall thickness, base plate thickness, side count (2/3/4), sprue diameter, vent diameter + count, registration key style, draft angle. Defaults per ADR-002 / molding-techniques.md.
- [ ] Interactive parting-plane picker with live clipped-edges preview (three-mesh-bvh).
- [ ] "Generate" button produces: printed base, 2/3/4 printed sides, printed top cap, displayed silicone volume, displayed resin pour volume.
- [ ] Exploded-view toggle animates parts outward.
- [ ] "Export All" saves each printable part as binary STL to a user-picked folder.
- [ ] Units toggle (mm / inches); mm default.
- [ ] Dark + light theme.
- [ ] Warning surfaced when manifold-3d repairs a non-manifold input (with tri-count delta).
- [ ] Signed NSIS installer produced by the `build-installer` CI job. (Signing identity configured — see open blocker.)
- [ ] App launches in < 2 s cold start on a mid-range Windows 11 machine; interactive at 60 fps on a 500 k-tri master.

### Engineering acceptance criteria

- [ ] All locked decisions honored — `manifold-3d` is the only CSG engine; Electron is the runtime; no new libraries added without a superseding ADR.
- [ ] Coverage ≥ 70 % on `src/geometry/**`; trend non-decreasing week-over-week.
- [ ] Visual regression flipped from advisory to required by week 3.
- [ ] Release builds are signed.
- [ ] Zero `TODO` / `FIXME` markers in code that ships to `main` without a linked issue.

### Phase 3 sub-milestones

- **3a — Viewport & import** (frontend-dev + geometry-dev): load STL, render, show volume, camera frame-on-load.
- **3b — Parameter UI** (frontend-dev): forms + i18n + units toggle.
- **3c — Mold generation — happy path** (geometry-dev): fixed parting plane (default horizontal), default params, produce base + 4 sides + cap for the mini-figurine fixture.
- **3d — Interactive parting plane** (frontend-dev + geometry-dev): user picks plane via gizmo; preview updates at 60 fps.
- **3e — Sprue + vents + registration keys** (geometry-dev): cap + key geometry; vent auto-placement at local high points.
- **3f — Export all** (app-shell-dev + geometry-dev): directory picker, N STL writes, success toast.
- **3g — Volumes panel** (frontend-dev): silicone + resin numbers with unit-aware formatting.
- **3h — Exploded view** (frontend-dev): toggle + animation.
- **3i — Packaging & signing** (app-shell-dev): NSIS installer, auto-update, signing integration.
- **3j — Polish** (multi-agent): dark/light parity, keyboard access, performance regressions.

### Exit criteria

A tagged `v1.0.0` release is published on GitHub with a signed installer. An unrelated user can install, import a 50 k-tri miniature, generate the mold parts, and export printable STLs in under 5 minutes.

---

## Post-v1 (not planned yet — placeholder)

- Multi-part molds (3–5 pieces with rigid mother-mold).
- Sleeve+shell as a distinct pipeline.
- Cross-platform (macOS + Linux).
- Brush-on mold workflow.
- Draft-angle application to the master mesh.
- Auto-parting-plane suggestion via silhouette analysis.
- Slicer hand-off (PrusaSlicer / OrcaSlicer CLI).

None of these are committed. Revisit after v1 ships.
