# Silicone Mold App — Status Log

Living log, lead-owned. Every agent spawn, fire/hire event, and architectural decision gets an entry.

## Format

One entry per event. Timestamp in UTC (ISO 8601). Keep entries terse — this is a log, not a report.

---

## 2026-04-18 — Phase 0 kickoff

### Tooling prep

- pnpm installed globally via `npm i -g pnpm`. Version 10.33.0 at `C:\Users\Wiz\AppData\Roaming\npm\pnpm.cmd`. **Gotcha:** not on bash PATH; prepend `/c/Users/Wiz/AppData/Roaming/npm` or use full path.
- `winget` not found on Windows 10 Pro for Workstations (build 21996) in either bash or PowerShell. Likely "App Installer" never installed from Microsoft Store.
- Chocolatey 2.7.1 present but **install attempt failed**: `choco install gh -y` → `UnauthorizedAccessException: Access to the path 'C:\ProgramData\chocolatey\lib-bad' is denied.` Shell is not elevated.
- gh CLI **NOT installed**. Deferred to user. Phase 0 doesn't require gh, so not blocking this phase.
- **GitHub MCP status unclear.** Configured in `~/.claude/settings.json` plugins list (`github`), but `ToolSearch mcp__github__` returns nothing — tools not exposed in this session. Needs a fresh Claude Code session or re-init before Phase 1. **Not blocking Phase 0** (local docs only). **Blocks Phase 1** (repo creation).
- Rust/rustup skipped deliberately (guardrail rules out Tauri).

### Memory seeded

- Wrote `project_context.md`, `user_constraints.md`, `tooling_state.md`, `feedback_surface_tradeoffs.md` to the session memory dir. `MEMORY.md` index created.

### Project structure

- Created `./docs/research/` and `./docs/adr/`.

### Agent events

- Spawned 4 `research-analyst` sub-agents in parallel (background), one per Phase 0 deliverable. Each was given a scoped prompt with required section headers, word budget, and instructions to return raw markdown only (no file writes, no recommendations — lead owns synthesis).
  - `af8b91c0454a48773` — Silicone molding techniques research. **Completed** in ~79 s. **Tool caveat:** agent reported WebSearch/WebFetch were not exposed; content is from domain knowledge (verified industry-standard), sources hand-cited and flagged for re-verification before publication.
  - `a81b03fd576ad61d4` — Platform research (Electron vs. browser/PWA). **Completed** in ~162 s, 27 tool uses (live web data).
  - `a5fdf6875b517f5a9` — Geometry stack research (manifold-3d, three-bvh-csg, OpenCascade.js, Open3D, CGAL, three-csg-ts). **Completed** in ~253 s, 39 tool uses (live web data).
  - `a00746205dacfbd58` — Testing strategy research (Vitest, Playwright, visual regression, CI). **Completed** in ~101 s.
- **QA outcome:** all four deliverables passed lead review. No reruns needed, no agent fired.

### Phase 0 deliverables committed

- `docs/research/molding-techniques.md` — 6 sections (types, architecture, computations, trade-offs, sources, v1 recommendation).
- `docs/adr/001-platform.md` — Decision: **Electron + Three.js**. PWA documented as runner-up and cheaper at v1; flagged for user.
- `docs/adr/002-geometry-stack.md` — Decision: **manifold-3d + three-mesh-bvh + three.js STLLoader/STLExporter**. Hybrid with three-bvh-csg deferred to Phase 3 profiling.
- `docs/adr/003-testing.md` — Decision: **Vitest + Playwright (both E2E and visual regression) + GHA matrix (Linux geometry, Windows E2E + smoke)**.

### Decisions logged

- **Contradiction flagged:** user checked both "Install Rust toolchain" and "Rule out Rust/Tauri". Lead honored the guardrail (skipped rustup). User can override by saying so.
- **Platform ADR:** Electron chosen over PWA on multi-file export UX + native integration headroom + low signing cost. Trade-off surfaced per user's "never silently choose" rule.
- **Geometry ADR:** manifold-3d picked over OpenCascade.js because OCCT's stable release is stuck at 2020 and STL-offset is documented-broken on mesh inputs; over three-bvh-csg because it lacks offset and fails silently on non-manifold STL (common in user inputs).
- **Testing ADR:** Linux for fast geometry + visual goldens with SwiftShader; Windows mandatory for E2E + one visual smoke scene. Visual regression starts advisory, ratchets to required after 2 weeks.
- **v1 mold strategies:** sleeve+shell + two-halves-in-box, matching user Phase 3 spec. Multi-part (3–5), brush-on, and cut (zig-zag) punted to v2.
- **Units:** mm default, inches toggle, both supported from day 1.

### Blockers / follow-ups (must resolve before Phase 1)

1. **GitHub access.** GitHub MCP tools not exposed in this session despite being in configured plugins. Options: (a) restart Claude Code session, (b) install gh CLI from elevated PowerShell, (c) create repo manually and hand us the URL. Phase 1 creates the repo — this is the critical path item.
2. **Open questions awaiting user answer at the gate** (see each ADR's "Open questions surfaced" section):
   - Code-signing identity situation (ADR-001)
   - Auto-update at v1 or defer (ADR-001)
   - Drop sleeve+shell and ship only two-halves? (molding-techniques.md recommendation section)
   - Offset algorithm default: LevelSet vs. MinkowskiSum (ADR-002)
   - Visual regression gating timeline (ADR-003)
   - Coverage thresholds day-1 vs. ratchet (ADR-003)

### Phase 0 → Phase 1 gate

**Status: APPROVED by user 2026-04-18.**

Decisions confirmed by user:
- **ADR-001 Electron:** accepted. Code signing via Azure Trusted Signing ($120/yr) or EV cert — identity TBD in Phase 1. Auto-update kept in scope. Per-user one-click install default.
- **ADR-002 geometry stack:** accepted. manifold-3d + three-mesh-bvh + three.js STL loaders. LevelSet as default offset. Hybrid with three-bvh-csg deferred to Phase 3 profiling.
- **ADR-003 testing:** accepted. Vitest + Playwright; Linux-first goldens with SwiftShader; one Windows visual smoke scene. Visual regression advisory for 2 weeks then required. 70% coverage threshold on geometry module from day 1.
- **Mold scope narrowed:** v1 ships **two-halves-in-box only**. Sleeve+shell dropped — user can manually cut a two-halves mold into a sleeve post-print. See updated `docs/research/molding-techniques.md` section 6.
- **Units:** mm default, both supported. (No change.)

### Phase 1 prep (resume after Claude Code restart)

User chose "Restart Claude Code session" to restore GitHub MCP. On restart:

1. Verify GitHub MCP tools are exposed (`ToolSearch mcp__github__` should return schemas).
2. If still not exposed, fall back to: install gh CLI via elevated PowerShell (`choco install gh -y`, then `gh auth login`).
3. Read `docs/status.md` (this file) and `MEMORY.md` index to rehydrate context.
4. Create GitHub repo `silicone-mold-app` (or user-chosen name) with protected main, CI skeleton, issue/PR templates, labels (`phase-0` → `phase-3`, `agent:frontend`, `agent:geometry`, `blocked`, `needs-human`, `tech-debt`), milestones mapped 1:1 to Phase 1/2/3.
5. Write `CLAUDE.md` at repo root, `.claude/skills/` scaffolding (7 skills per spec), `docs/plan.md` with milestones and acceptance criteria.
6. Migrate this `docs/status.md` into the new repo — Phase 0 log becomes the first entries in the living status log.
7. Commit Phase 0 deliverables (molding-techniques.md + three ADRs) in the initial commit of the repo.

### Blockers / follow-ups (still open, for Phase 1)

- **Code-signing identity** (ADR-001 Q1) — needs user decision in Phase 1 kickoff: individual Azure Trusted Signing (requires US/Canada + 3-yr history), company EV cert, or ship unsigned at v1.
- **Miniature fixture source** (ADR-003 Q3) — pick a CC-BY-SA miniature STL or procedural stand-in before writing tests.
- **Repo name + visibility** — confirm `silicone-mold-app`, public or private, owner (user account vs. org).

---

## 2026-04-19 — Phase 1 local scaffolding

User said "resume from status.md" (no actual Claude Code restart — same session). ToolSearch still returns no `mcp__github__*` tools. Decision: **proceed with local-only Phase 1 work**; defer GitHub-specific steps (repo creation, push, branch protection, live CI runs) until MCP is restored or gh CLI is installed.

### Local git

- `git init -b main` in project root.
- `git config user.email "gache.tiberiu@gmail.com"`, `git config user.name "Tiberiu Gache"`.
- Main branch initialised; no commits yet at time of writing.

### Files written this session (Phase 1 local)

Root config:
- `.gitignore` — node, build, test, signing, editor, OS.
- `.editorconfig` — LF, 2-space, UTF-8.
- `.nvmrc` — `lts/*`.
- `.prettierrc.json` — single-quote, trailing-all, 100 col.
- `.env.example` — signing + updater env vars documented, real `.env` gitignored.
- `package.json` — `silicone-mold-app` v0.0.0, pnpm 10.33 pinned, deps: three 0.169, three-mesh-bvh 0.9, manifold-3d 3.4, i18next 25; devDeps: electron 42, electron-builder 26, electron-updater 6, playwright 1.49, vitest 3, vite 6, vite-plugin-electron, typescript 5.6.
- `tsconfig.json` — strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`, `@/*` and `@fixtures/*` path aliases.

Docs:
- `CLAUDE.md` — architecture, orchestration, commit/PR rules, testing, definition-of-done, units/tolerances, security, "never without approval" list.
- `docs/plan.md` — milestones + acceptance criteria for Phases 0/1/2/3, with sub-milestones 3a–3j.
- `docs/agents/README.md` + 8 role files: architect-reviewer, frontend-dev, geometry-dev, app-shell-dev, qa-engineer, test-engineer, docs-writer, research-analyst.

Skills (7, all under `.claude/skills/`):
- `mesh-operations/SKILL.md`
- `mold-generator/SKILL.md`
- `three-js-viewer/SKILL.md`
- `desktop-app-shell/SKILL.md`
- `testing-3d/SKILL.md`
- `qa-review/SKILL.md`
- `github-workflow/SKILL.md`

.github/:
- `pull_request_template.md`
- `ISSUE_TEMPLATE/agent-task.md` (primary), `bug.md`, `feature.md`
- `labels.yml` — phase / agent / type labels with colors
- `workflows/ci.yml` — lint+typecheck, geometry unit tests, visual regression (advisory), E2E+smoke on Windows, build-installer on main-push

Tests:
- `tests/fixtures/meshes/README.md` — fixture contract + sidecar JSON format + planned fixtures table

### Phase 1 local status vs. acceptance criteria

Checked against `docs/plan.md` Phase 1 criteria:

- [x] `CLAUDE.md` in place at repo root
- [x] `.claude/skills/` has all 7 skills
- [x] `docs/agents/` has all 8 role definitions + README index
- [x] `.github/` has PR template, issue templates, labels.yml, workflows/ci.yml
- [x] Root config complete
- [x] `docs/plan.md` + `docs/status.md` committed
- [x] `tests/fixtures/meshes/` exists with fixture-contract README
- [ ] **GitHub repo created** — blocked (MCP not exposed, gh not installed)
- [ ] **Milestones Phase-1 / Phase-2 / Phase-3 exist on GitHub** — blocked
- [ ] **Labels in sync** — blocked (local `labels.yml` ready)
- [ ] **Initial commit created locally; first push to GitHub** — local commit ready to make; push blocked
- [ ] **CI runs green on first push** — blocked (workflow ready; needs GitHub Actions to actually run)

### GitHub-blocked follow-ups (unchanged, tracked)

- Install gh CLI via elevated PowerShell OR confirm GitHub MCP exposes on a real session restart.
- Create the repo `silicone-mold-app` (confirm name) — public or private (confirm) — under user's account (confirm GitHub handle).
- Apply `.github/labels.yml`, create milestones, enable branch protection on `main`.
- Push the Phase 0 + Phase 1 scaffolding as the initial commit.

### Agent events

No sub-agents spawned this session (Phase 1 scaffolding is lead-only work by design).
