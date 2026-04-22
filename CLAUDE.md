# CLAUDE.md — Silicone Mold App

Instructions for Claude Code sessions working in this repo. Read this first.

## What this app is

Desktop app (Electron + Three.js, Windows-first) that takes a 3D master STL (miniature, figurine, object) and generates a silicone-glove mold wrapped in a rigid 3D-printed shell. Computes silicone volume, resin pour volume, and print-shell volume. Exports binary STL.

**v1 scope (redirected 2026-04-20 after dogfood; feature-complete 2026-04-22):** rigid-shell + silicone-glove mold strategy. Pipeline:

1. Surface-conforming silicone offset around the master (`manifold-3d` levelSet).
2. Surface-conforming print shell around the silicone, open-top pour edge, bottom cut at master base.
3. Printed base slab (2D footprint extrusion) with 45° step-pocket interlock between slab and shell.
4. Radial slicing of the shell into 2/3/4 side pieces; user rotates + translates the cut-plane partition via a scene gizmo before Generate (cut-plane preview feature).
5. Conformal brim flange on each cut face — inner edge hugs the shell silhouette at every Y (sliced at the cut plane + 2D outward offset), outer edge sits `brimWidth_mm` (default 10) further out radially.

STL export of silicone (single piece), base slab, and N shell pieces. mm default, inches toggle. Sleeve+shell variations, multi-part (3–5), brush-on, and cut molds are explicitly out of scope — do not add them without user approval. Sprue, vent channels, and registration-key stamping were removed in Wave A and stay removed unless the user re-prioritises them after printing a physical mold.

## Architecture at a glance

| Layer | Tech | Why |
|---|---|---|
| App shell | Electron (latest-3-majors policy) | Native file dialogs, multi-file STL export, desktop UX, future native integration. See [docs/adr/001-platform.md](docs/adr/001-platform.md). |
| Renderer / UI | Three.js + TypeScript, Vite-bundled | Standard 3D viewport. |
| Geometry kernel | `manifold-3d` (WASM, Apache-2.0) | Booleans + offset (LevelSet) + volume + slice. Deterministic across platforms. |
| Interactive picking | `three-mesh-bvh` | Raycast picking + parting-plane clipped-edges preview. |
| STL I/O | `three/examples/jsm/loaders/STLLoader` + `STLExporter` | ASCII + binary round-trip. |
| Unit tests | Vitest 3 | Native ESM/TS. `toEqualWithTolerance` custom matcher for geometry. |
| E2E + visual regression | Playwright (Electron launch + Chromium) | Official Electron support; `toHaveScreenshot` for goldens. |
| CI | GitHub Actions | ubuntu-latest for geometry + visual goldens (SwiftShader); windows-latest for E2E + smoke. |
| i18n | `i18next` | English only ships at v1, but all user-visible strings go through i18n from day 1. |

Full decisions in [docs/adr/](docs/adr/). Do not silently override.

## Orchestration model

The lead architect (Opus) delegates feature work to named Sonnet sub-agents. Lead never writes feature code unless integration demands it. Agent roster under [docs/agents/](docs/agents/).

**Task flow (non-negotiable):**

1. Lead writes a GitHub issue with spec (inputs, outputs, acceptance tests).
2. Lead spawns the appropriate sub-agent with a scoped prompt referencing the issue, the relevant skill file under [.claude/skills/](.claude/skills/), and test fixtures.
3. Agent works on a feature branch `feat/<area>-<short-desc>`, opens a PR, links the issue.
4. `qa-engineer` sub-agent reviews against acceptance criteria (see [.claude/skills/qa-review/SKILL.md](.claude/skills/qa-review/SKILL.md)).
5. Lead merges only after QA passes and CI is green.
6. Lead updates [docs/status.md](docs/status.md) with hire/fire events, merges, blockers.

**Hire/fire policy:** any agent whose PRs fail QA twice in a row is retired for that task category and replaced. Log the event in `status.md`.

## Commit / PR rules

- Branches: `feat/<area>-<short-desc>` / `fix/...` / `chore/...`. Never commit to `main` directly.
- One issue → one branch → one PR.
- PR template (`.github/pull_request_template.md`) requires: linked issue, acceptance-criteria checklist, test results, screenshots/GIFs for UI, QA sign-off line.
- Conventional-commit style for subjects (`feat(geometry): compute parting plane`, `fix(viewport): ...`, `test(...)`, `chore(...)`, `docs(...)`).
- No `--no-verify`, no `--amend` on pushed commits, no force-push to `main`.
- CI must be green: lint, typecheck, unit, geometry regression, E2E (windows-latest), build artifact. See [.github/workflows/ci.yml](.github/workflows/ci.yml).

## Testing requirements (gate for merge)

- **Every geometry operation** has a unit test with tolerance assertions against at least one canonical fixture (cube / sphere / torus / mini-figurine).
- **Every user flow** that spans import → configure → generate → export has an E2E test.
- **Every viewport state** worth snapshotting has one golden screenshot (Playwright `toHaveScreenshot`).
- STL snapshots use canonicalised-SHA-256 (sort triangles, re-derive normals, round floats to 1e-5 mm, little-endian binary) — not raw bytes.
- Visual regression is **advisory for the first 2 weeks** after first green run, then required.
- Coverage: 70% lines on the geometry module from day 1. No enforced threshold on UI yet.

## Definition of done

A PR is done when **all** of:

- [ ] Linked to a GitHub issue with acceptance criteria.
- [ ] Acceptance-criteria checklist in the PR body is fully ticked.
- [ ] CI is green (lint, typecheck, unit, geometry, E2E, build).
- [ ] `qa-engineer` has left an approving review.
- [ ] If UI-touching: at least one screenshot or GIF in the PR body.
- [ ] If user-visible strings: wired through i18n, no hardcoded English in component trees.
- [ ] No new secrets in the diff; any new env vars documented in `.env.example`.
- [ ] `docs/status.md` updated if this PR completes a milestone or changes scope.

## Units, tolerances, conventions

- **Units**: mm internal everywhere. Inches is a display-layer conversion. No mixed-unit math inside geometry code.
- **Coordinate system**: Three.js default (Y-up). Axis gizmo always on in the viewport. Origin grid at z=0 (but Y-up means XZ plane — handle in viewer).
- **Numerical tolerances**: absolute 1e-6 mm for vertex coincidence; relative 1e-4 for volume comparisons; 1e-5 mm quantisation before STL canonical hashing.
- **Mesh sizes**: target interactive on up to 500 k tri. Above that, degrade gracefully (show a progress bar; offload to worker).

## Security & safety

- Never commit secrets. `.env.example` documents required vars; real `.env` is gitignored.
- Electron: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` on renderer; all IPC through a typed preload-exposed bridge.
- STL parsing: never trust file contents. Bound tri count. Reject files > 500 MB without explicit user override.
- Auto-updater: signed-only; no unsigned update paths in v1.

## Things you (an agent session) should do BEFORE coding

1. Read this file end-to-end.
2. Read [docs/plan.md](docs/plan.md) and [docs/status.md](docs/status.md) for current milestone and open work.
3. Read the skill file that matches your task (e.g. `.claude/skills/geometry/SKILL.md` for mesh work).
4. Read the linked GitHub issue and its acceptance criteria.
5. Check out a feature branch. Do not work on `main`.

## Things you should never do without explicit user approval

- Add a new mold strategy (sleeve, multi-part, brush-on, cut).
- Pull in a new geometry library (we locked `manifold-3d` + `three-mesh-bvh`).
- Switch the platform (we locked Electron).
- Add a database, server backend, or account system.
- Add telemetry or analytics.
- Install Rust, Python, Tauri, PyQt, or any tool outside the approved stack.
- Merge your own PR or anyone else's without QA + green CI.
- Skip hooks, force-push, or amend pushed commits.

## Skills index

See [.claude/skills/](.claude/skills/). The seven live skills are:

- `mesh-operations` — load, boolean, offset, volume, watertight check.
- `mold-generator` — base/sides/caps from master + parameters.
- `three-js-viewer` — viewport conventions, gizmos, units, picking.
- `desktop-app-shell` — Electron runtime patterns, IPC, file dialogs.
- `testing-3d` — tolerances, canonical fixtures, regression fixtures.
- `qa-review` — PR review checklist.
- `github-workflow` — branch/PR/issue conventions for all agents.
