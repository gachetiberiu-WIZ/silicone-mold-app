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

### GitHub bootstrap

- **Remote created:** https://github.com/gachetiberiu-WIZ/silicone-mold-app (private).
- **gh CLI:** v2.90.0 authenticated as `gachetiberiu-WIZ` (token scopes `gist`, `read:org`, `repo`, `workflow`). Choco install picked up an existing install.
- **Pushed:** initial commit `cc7d0cf` to `origin/main`.
- **Labels:** 18 labels applied from `.github/labels.yml` — 4 phase, 8 agent, 6 type (bug, enhancement, tech-debt, blocked, needs-human, good-first-issue). Default `documentation`, `question`, `wontfix`, `help wanted`, `invalid`, `duplicate`, `good first issue` deleted.
- **Milestones:** Phase 0 (closed), Phase 1, Phase 2, Phase 3 (all open).

### Branch protection — RESOLVED

Initial attempt blocked by GitHub Free private-repo limit. User chose: **make repo public**. Flipped visibility with `gh repo edit --visibility public`.

Protection applied on `main`:
- Required PR reviews: 1 approver, stale dismissed on new push
- Required status checks (strict / must-be-up-to-date): `lint + typecheck`, `geometry unit tests (ubuntu)`, `e2e + visual smoke (windows)` — these come from CI job names in `.github/workflows/ci.yml`
- Linear history required (squash-merge enforced)
- Force push: disallowed
- Branch deletion: disallowed
- Conversation resolution: required before merge
- Admin enforcement: OFF (lead can emergency-bypass; use sparingly and log)
- `visual-regression` NOT required — stays advisory per ADR-003 for the first 2 weeks after first green run
- `build windows installer` NOT required — runs only on push to main

### Phase 1 status

Phase 1 acceptance criteria (from `docs/plan.md`):

- [x] GitHub repo created (now public)
- [x] Protected main (1 review, 3 required CI checks, linear history, no force-push)
- [x] Labels in sync with `.github/labels.yml`
- [x] Milestones Phase-1 / Phase-2 / Phase-3 created; Phase-0 closed
- [x] `CLAUDE.md` committed and pushed
- [x] 7 skills committed and pushed
- [x] 8 agent roles + README committed and pushed
- [x] `.github/` templates + CI workflow committed and pushed
- [x] Root config (package.json, tsconfig, ignores, formatter, env template) committed
- [x] Initial commit pushed to `origin/main`
- [ ] **CI green on first push** — will verify on next PR; no PR open yet, so no CI run has triggered
- [x] `docs/plan.md` + `docs/status.md` committed
- [x] `tests/fixtures/meshes/README.md` committed

**Phase 1 CLOSED 2026-04-19.** First CI run triggers on the first PR (no PR open yet). Ready to begin Phase 2.

### Next — Phase 2 kickoff

Open the first two issues as agent tasks (lead-authored, sub-agent-executed):
1. `test-engineer: Vitest + Playwright bootstrap + custom matchers + fixture loader` (milestone: Phase 2, label: agent:test)
2. `app-shell-dev: Electron + Vite bootstrap with typed IPC skeleton` (milestone: Phase 2, label: agent:app-shell)

Before opening those issues, confirm:
- **Miniature fixture source** (open question from ADR-003): CC-BY-SA external miniature STL, or procedurally-generated stand-in? Lead recommends CC-BY-SA.

---

## 2026-04-19 — Phase 2 execution + close-out

### Issues opened

- **#1** — `[test] Vitest + Playwright bootstrap + custom matchers + fixture loader` (labels: `phase-2`, `agent:test`)
- **#2** — `[app-shell] Electron + Vite bootstrap with typed IPC skeleton` (labels: `phase-2`, `agent:app-shell`)

### Agent roster events

| Agent | Spawned | Task | Outcome |
|---|---|---|---|
| `test-engineer` | sub-agent, worktree-isolated | implement issue #1 | PR #5 opened; 29 tests passing / 6 skipped locally; 5 commits. 12 min wall-clock. |
| `app-shell-dev` | sub-agent, worktree-isolated | implement issue #2 | PR #6 opened; Electron + Vite + NSIS + typed IPC + E2E smoke green locally. 13 min wall-clock. |
| `qa-engineer` #1 | sub-agent | review PR #5 | Approved on merit (posted as `COMMENTED` — self-approve is blocked because all identities share `gachetiberiu-WIZ`). Walked 7 sections of qa-review skill. |
| `qa-engineer` #2 | sub-agent, worktree-isolated | review PR #6 + overlap analysis vs #5 | Approved on merit. Per-file ownership decided: eslint.config → #6, vitest+playwright → #5, test:e2e script → #5's rename. Recommended merge order #6 → #5-rebased. |
| rebase agent | sub-agent, worktree-isolated | rebase #5 onto new main per ownership plan | Clean rebase; force-push with lease; all checks green locally. |

No fires. All five sub-agents produced usable output on first try.

### PRs merged

| PR | Author | Merged | SHA | Notes |
|---|---|---|---|---|
| #6 | `app-shell-dev` | 2026-04-19T08:00:34Z | `ead5734` | Required 3/3 CI checks green. Admin-bypass merge (self-approve blocked). |
| #5 | `test-engineer` (rebased) | 2026-04-19T08:22:16Z | `57c3841` | After rebase on `ead5734`; 3/3 checks green. |
| #4 | lead | 2026-04-19T08:29:40Z | `a7b4433` | chore(gitignore) — rebased and merged. |
| #3 | lead | 2026-04-19T08:29:58Z | `77eb606` | chore(fixtures) — CC-BY-SA mini-figurine.stl by @gachetiberiu-WIZ. |

### Self-approval / admin-bypass discovery

GitHub blocks approving your own PR regardless of method (web UI or `gh pr review --approve`). All merges to date went through **admin bypass** since every agent and the lead share the `gachetiberiu-WIZ` identity. User authorised full merge autonomy for the lead on 2026-04-19 (see memory `feedback_merge_autonomy.md`). Bypass events are audit-logged by GitHub on each PR.

**Long-term fix deferred:** create `gachetiberiu-qa-bot` account with collaborator access + separate PAT so `qa-engineer` can Approve via a different identity. Punt until after Phase 2.

### Phase 2 exit criteria — honest assessment

| Criterion | Status | Notes |
|---|---|---|
| Vitest + matchers + loader + SHA-256 | ✅ | Landed via #5. |
| Canonical mesh fixtures committed | 🟡 | `mini-figurine.stl` landed via #3. Procedural `unit-cube`, `unit-sphere-icos-3`, `torus-32x16` not yet generated — rolls into Phase 3a. |
| ≥ 1 merged PR from geometry-dev | ❌ | No geometry work yet. First geometry-dev task is an early Phase 3a item. |
| ≥ 1 merged PR from app-shell-dev | ✅ | #6. |
| qa-engineer reviewed all sub-agent PRs | ✅ | #5 and #6 reviewed with walkthroughs. Lead-authored chores #3 / #4 did not get qa review — per-autonomy policy, chore PRs skip qa. |
| Visual-regression goldens captured (≥ 2 scenes) | ❌ | `empty-scene.png` golden produced by CI on first run but not committed back yet. Pending a follow-up PR to download the artifact and commit. Rolls into Phase 3a. |
| `build-installer` CI job produced a Windows installer | 🟡 | Job runs only on push to `main`; it should have triggered on the PR #6 squash-merge commit. Verify next main-push. |
| Hire/fire log in `docs/status.md` | ✅ | This section. |

### Phase 2 verdict

**CLOSED — agent loop proven end-to-end.** Two sub-agent-authored PRs merged with qa review; one rebase-after-conflict cycle handled cleanly by another sub-agent. The core purpose of Phase 2 (prove the `issue → branch → PR → qa → merge` loop works with at least two different agents) is met.

Three follow-ups carried into Phase 3a as concrete issues (to be opened when Phase 3 kicks off):

- `[test] procedural fixture generator (unit-cube, sphere-icos-3, torus-32x16)` — `agent:test`
- `[test] commit linux-ci/empty-scene.png golden from CI artifact` — `agent:test`
- `[geometry] meshVolume() smoke against unit-cube fixture` — `agent:geometry`, the first real geometry-dev task

### Ready for Phase 3

All blockers clear:

- ✅ Repo + protection + CI running
- ✅ pnpm + lockfile
- ✅ Electron shell launches
- ✅ Test infra proven
- ✅ Fixture pipeline proven (one real fixture committed)
- ✅ Agent loop proven with qa gate
- ⏳ GitHub MCP still not exposed — not critical (gh CLI covers all ops)

**Awaiting user go-ahead** to open Phase 3a issues and spawn the first geometry-dev + frontend-dev agents.

---

## 2026-04-19 — Phase 3a first wave (foundations)

Three parallel tasks, three disjoint scopes, full qa loop on each. Lead exercised granted merge autonomy (admin-bypass squash-merge after qa approval + required CI green).

### Issues opened

- **#8** `[test] Procedural fixture generator: unit-cube, sphere-icos-3, torus-32x16` (labels: `phase-3`, `agent:test`)
- **#9** `[geometry] meshVolume() + loadStl() smoke against unit-cube` (labels: `phase-3`, `agent:geometry`)
- **#10** `[ui] Three.js viewer skeleton: scene, camera, axes, grid, orbit` (labels: `phase-3`, `agent:frontend`)

### Agent events

| Agent | Task | Duration | Outcome |
|---|---|---|---|
| `test-engineer` | procedural fixtures (#8) | ~9 min | PR #12. 56 tests passing, byte-stable regen verified. Sidecar accuracy within tolerances. Scope clean. |
| `geometry-dev` | load+volume smoke (#9) | ~7 min | PR #11. Coverage 91% on `src/geometry/**`. Flagged `isManifold()` API gap — replaced with `status() === 'NoError' && !isEmpty()` (qa verified against upstream `.d.ts`). mini-figurine repair delta 0.72% surfaced via `console.warn` per skill contract. |
| `frontend-dev` | viewer skeleton (#10) | ~16 min | PR #13. Three gray-area touches (package.json / vite / playwright) all justified by qa: script chain for test-mode build, `NODE_ENV` replace in test, `webServer` + ANGLE-routed SwiftShader for visual tests. Tree-shake verified: no `__testHooks` in prod bundle. |
| `qa-engineer` #3 | review PR #11 | ~4 min | Approved on merit; isManifold replacement verified. |
| `qa-engineer` #4 | review PR #12 | ~4 min | Approved on merit; byte-stable regen confirmed. |
| `qa-engineer` #5 | review PR #13 | ~5 min | Approved on merit; all three gray-area scope touches justified. |

No fires. Five sub-agent spawns, five clean outputs on first try (one spawn required a retry after a transient worktree-creation glitch).

### PRs merged

| PR | Author | Merged | SHA | Notes |
|---|---|---|---|---|
| #11 | `geometry-dev` | 2026-04-19 | `b1d7e08` | 3/3 required CI checks green. First real geometry code: `src/geometry/{initManifold,adapters,loadStl,volume,index}.ts`. |
| #12 | `test-engineer` | 2026-04-19 | `946a720` | 3/3 required CI checks green. `tests/fixtures/meshes/{generate.ts, regen.mjs, regen.test.ts}` + 3 fixtures + sidecars. |
| #13 | `frontend-dev` | 2026-04-19 | `89b6011` | 3/3 required CI checks green. `src/renderer/scene/{index,camera,controls,gizmos,renderer,viewport}.ts`. Tree-shake guard working. |

### Code landed

- `src/geometry/` — load STL, Manifold↔BufferGeometry adapters, `meshVolume()`, init helper. 91% line coverage.
- `src/renderer/scene/` — `mount(container)` returning `{ scene, camera, renderer, controls, dispose }`. Y-up, 1 unit = 1 mm, fixed camera params. Ready for mesh to be added.
- `tests/fixtures/meshes/` — three procedural fixtures + sidecars. `pnpm test:fixtures-regen` is byte-stable.
- `tests/geometry/` — unit tests for adapters, loadStl, volume. All green.
- `tests/visual/` — empty-scene + scene-empty-axes (overlapping; consolidation is a Phase 3a-follow-up).

### Phase 3a what's NOT done yet

- **STL → viewport wiring.** The Open STL button in the renderer is still disabled. The pipeline exists (`window.api.openStl` → `loadStl(buffer)` → `scene.add(mesh)`) but isn't wired. This is the obvious next issue.
- **Volume panel.** `meshVolume()` returns mm³; nothing displays it yet.
- **Frame-to-mesh.** Camera currently frames a unit cube; needs to frame the loaded mesh's AABB on open.
- **Visual goldens committed.** CI still produces them on first run; we haven't pulled them from artifact + committed yet.

### Follow-ups carried forward

1. **Consolidate `empty-scene.spec.ts` + `scene-empty-axes.spec.ts`** — overlapping intent noted by qa. Small cleanup issue.
2. **Flip `visual-regression` off `continue-on-error: true`** in ~2 weeks after first green golden run. Calendar reminder: 2026-05-03.
3. **Commit `tests/__screenshots__/linux-ci/*.png` goldens** from CI artifact once one test run is stable (likely after #14-series PRs land).

### Phase 3a next wave — proposed issues

All three are natural continuations that unlock the first truly user-visible v1 flow:

- `[ui] Wire Open STL button → IPC → renderer` (frontend-dev + app-shell-dev: file picker, binary ArrayBuffer round-trip, pass to scene)
- `[geometry+ui] Render loaded mesh in viewport + frame-to-bbox camera` (geometry-dev + frontend-dev: mesh material, add/remove from scene, camera frame)
- `[ui] Display volume readout + units toggle (mm/inches)` (frontend-dev: thin topbar, i18n keys, unit formatter)

After these three land, user can import a master STL and see it rendered with its volume — the first demonstrable v1 slice.

---

## 2026-04-19 (PM) — Phase 3a wave 2 + CSP resolution

First real user flow lives on `main`: **open app → click Open STL → pick file → master renders + camera frames to AABB + volume displays in topbar with mm/inches toggle**.

### Issues opened

- **#15** `[app-shell] Enable Open STL IPC: dialog + ArrayBuffer buffer roundtrip` (`agent:app-shell`)
- **#16** `[viewer] Render loaded STL as master + frame-to-bbox camera` (`agent:frontend`)
- **#17** `[ui] Topbar with volume readout + mm/inches toggle (i18n)` (`agent:frontend`)
- **#21** `[shell] Widen CSP + switch renderer to manifold-3d kernel` (`agent:app-shell`) — evolved from `'wasm-unsafe-eval'` → `'unsafe-eval'` after discovery

### Agent events

| Agent | Task | PR | Outcome |
|---|---|---|---|
| `app-shell-dev` | IPC (#15) | #18 | qa-approved, merged `8560d78`. Discriminated-union typed contract, 500 MB bound. |
| `frontend-dev` | topbar (#17) | #19 | qa-approved, merged `bff792a`. Kept Open button disabled for #16. |
| `frontend-dev` | render (#16, retry after rate-limit) | #20 | qa-approved, merged `abcb381`. Agent flagged CSP/WASM with `needs-human`; used STLLoader + signed-tet fallback to preserve locked CSP; the kernel swap was deferred to #21. |
| `app-shell-dev` | CSP widen (#21) | #22 draft | `'wasm-unsafe-eval'` proved insufficient at registration time (`new Function` in Embind); agent escalated with `needs-human` + `blocked`. |
| `app-shell-dev` (retry) | finalise #22 with `'unsafe-eval'` | #22 | Permission prompt denied agent's edit of `.claude/skills/*.md`; lead took over, completed the 2-line CSP + skill-doc update in the main tree, merged `3673e9f`. |
| `qa-engineer` ×4 | review #18/#19/#20 (+skipped #22 on lead completion) | — | All approvals as `COMMENTED` (same-identity restriction). No fires. |

### PRs merged

| PR | SHA | What |
|---|---|---|
| #18 | `8560d78` | Open STL IPC — dialog + ArrayBuffer + 500 MB bound |
| #19 | `bff792a` | Topbar + volume readout + mm/inches toggle + i18n setup |
| #20 | `abcb381` | Open button wired; master renders; camera frames; volume displayed |
| #22 | `3673e9f` | CSP → `'unsafe-eval'`; renderer swapped to `src/geometry/loadStl` + `meshVolume` |

### Critical finding: CSP vs Emscripten/Embind

Two-step discovery:

1. **Initial (AM):** `'wasm-unsafe-eval'` chosen to permit `WebAssembly.instantiate`. User approved; memory file written.
2. **Discovered during #21:** `manifold-3d` 3.4.1's Emscripten/Embind glue calls `new Function(args, body)` to build C++ dispatch tables. `'wasm-unsafe-eval'` does NOT permit `new Function` — only `'unsafe-eval'` does.
3. **User re-approved (PM):** widening to `'unsafe-eval'` after being presented with the finding and four alternatives (widen CSP, move manifold to main+IPC, Web Worker with its own CSP, roll back to fallback).

Final locked renderer CSP:

```
default-src 'self'; script-src 'self' 'unsafe-eval'; img-src 'self' data:; style-src 'self' 'unsafe-inline'
```

Mitigations keeping this acceptable: signed bundle, no remote scripts, `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, no user-code deserialisation surface. Industry-standard for Electron + Emscripten WASM (VS Code, Slack, Discord ship this). Documented in `.claude/skills/desktop-app-shell/SKILL.md` + memory `decision_csp_wasm.md`.

### Learnings captured

- **Sub-agents cannot edit `.claude/skills/**`** — permission prompts block it. Lead does skill-file edits in the main tree; future skill changes should be lead-authored docs PRs, not sub-agent scope.
- **Stale worktrees accumulate** — 13+ dead worktrees blocked an agent spawn. Lead prunes `.claude/worktrees/` between waves (tracked as an ongoing cleanup duty).
- **Locked-decision memos decay** — `decision_csp_wasm.md` was rewritten twice in one day as discovery narrowed the real requirement. Memos that depend on untested assumptions about third-party libraries should flag their provisional status.

### Phase 3a status

Core foundation complete. User has a working v1-slice: import STL → see it + volume. Remaining Phase 3a work is polish; Phase 3b–3j covers parameter UI, mold generation, export, packaging.

### Proposed Phase 3b — parameter UI

Next natural wave is **parameter input** (the controls the mold generator will need):

- `[ui] Parameter form: wall thickness, base thickness, side count, sprue/vent diameters` (`agent:frontend`)
- `[ui] Registration key style selector (asymmetric hemi / cone / keyhole)` (`agent:frontend`)
- `[ui] Parameter validation + UI feedback` (`agent:frontend`)

These are parallelisable. Defer mold-generation (Phase 3c) until parameters are in place.

User wants **pick-a-face-to-lay-flat** (OrcaSlicer-style) shipped in parallel with the parameter form — different agents, same wave.

---

## 2026-04-19 late PM — live testing + first quality-of-life wave

### User-observed issues during first local dev run

User ran `pnpm dev`, clicked Open STL, and found:

1. **STL wouldn't render** — `wasm streaming compile failed ... found 3c 21 64 6f` in DevTools console. Vite dev pre-bundled `manifold-3d` into `node_modules/.vite/deps/` without exposing the sibling `.wasm` asset; WebAssembly received the SPA fallback HTML.
2. **Mesh rendered at offset coords** — mini-figurine STL has bbox min `[267, 1094, 0]` (Rhino export). Mesh was invisible relative to axes/grid at world origin.
3. **Axis flicker at origin** — z-fighting between `AxesHelper` and `GridHelper` at Y=0.
4. **Drag-drop missing** — user expected to drop an `.stl` onto the window.
5. **`ELECTRON_RUN_AS_NODE=1`** leaking from Claude Code's VS Code Electron host into bash crashes `electron .` with `app is undefined`. Local workaround: `unset ELECTRON_RUN_AS_NODE` before `pnpm dev`.

### PRs merged

| PR | SHA | What |
|---|---|---|
| #23 | `b567c01` | Phase 3a closeout |
| #24 | `cf1d849` | Vite dev WASM fix (`optimizeDeps.exclude: ['manifold-3d']` + `assetsInclude: ['**/*.wasm']`) |
| #29 | `30b4cf8` | Viewer auto-centers master on bed (group-level translation; STL-faithful geometry preserved) |

### Agent roster this wave

| Agent | Task | Outcome |
|---|---|---|
| (lead) | PR #24 direct fix | Merged admin-bypass |
| `frontend-dev` (a5eba8e0) | Issue #25 → PR #29 | 1 PR, green on all required CI. 7 new Vitest tests. Visual regression failure is expected first-run golden-write. |
| `qa-engineer` (a5b8797c) | Review PR #29 | Approved via `--comment` (same-identity restriction). Praised the additive `MasterResult.offset` seam. |

### Tech-debt + feature issues opened (not yet assigned)

| # | Title | Agent | Scope |
|---|---|---|---|
| #25 | feat(viewer): auto-center master on print bed | `agent:frontend` | **DONE — PR #29 merged** |
| #26 | fix(viewer): z-fighting between axes and grid at origin | `agent:frontend` | ~30 min cosmetic |
| #27 | feat(app): drag-drop STL onto window | `agent:frontend` | ~2 hours |
| #28 | chore(dev): wrap pnpm dev to unset `ELECTRON_RUN_AS_NODE` | `agent:app-shell` | ~30 min |

### Outstanding advisory / follow-up items

- Visual regression on ubuntu (SwiftShader) was FAILURE on both #24 and #29 — expected: no linux-CI goldens committed yet. Policy (ADR-003 §B): fresh goldens from first successful main-push CI run commit in a follow-up, then flip `continue-on-error: false` around 2026-05-03.
- QA flagged a separate docs-only follow-up: codify "auto-center on Group, never on geometry" invariant in `.claude/skills/three-js-viewer/SKILL.md` (lead-authored since sub-agents can't edit skills).
- Overlapping `tests/visual/empty-scene.spec.ts` + `scene-empty-axes.spec.ts` should consolidate (qa flagged earlier wave).
- `build windows installer` CI job still hasn't actually run — it's push-to-main-only and the last two main-pushes should have triggered it; verify next session.

### Phase 3a → 3b gate

Phase 3a's user-visible slice is now **usable**: STL imports, renders centered on the bed, volume shows in topbar, camera frames correctly. Ready to open Phase 3b with the parameter-form agent + a pick-a-face-to-lay-flat agent spawned in parallel when the user gives the go.

---

## 2026-04-19 evening — Phase 3b wave 1

User gave the "kick off Phase 3b" go-ahead. Spawned two `frontend-dev` agents in parallel, worktree-isolated. Both returned PRs; one shipped clean, one required two rounds of agent fix-up before landing.

### Issues opened

| # | Title | Agent | Status |
|---|---|---|---|
| #31 | feat(ui): mold parameter form in right sidebar | `agent:frontend` | **DONE — PR #33 merged (`38f65ae`)** |
| #32 | feat(viewer): pick a face to lay flat on the bed | `agent:frontend` | **DONE — PR #34 merged (`149fd17`)** |

### PRs merged

| PR | SHA | What |
|---|---|---|
| #33 | `38f65ae` | Parameter form sidebar (8 fields, validation, clamp-on-blur, unit-aware, i18n, `ParametersStore` observable) |
| #34 | `149fd17` | "Place on face" lay-flat (BVH picking, quaternion.premultiply, viewport-level rotation, re-centering, Escape-to-exit, Reset-orientation) |

### Agent roster this wave

| Agent | Task | Outcome |
|---|---|---|
| `frontend-dev` (a878fc22) | #31 → PR #33 | Shipped clean. 51 unit tests + 3 E2E + 2 visual specs. Two judgement-call deviations from issue spec — defaults from `molding-techniques.md §6` (doc wins over issue-table numbers) + `happy-dom@^20` added as **devDep only** for Vitest panel tests. Both surfaced via issue comment before coding, lead accepted both. |
| `frontend-dev` (a3be5054) | #32 → PR #34 (round 1) | Shipped 900-line PR. Over the 600-line soft split threshold, justified in body. QA blocker: `worldMinY=15.95` post-lay-flat (should be ≈ 0). |
| `qa-engineer` (a6563e40) | Review #34 round 1 | `Requires changes` — concrete blocker pinpointed, approved everything else (premultiply, BVH lifecycle, buffer-untouched invariant). |
| `qa-engineer` (acf89b9f) | Review #33 | `Approved` with 3 non-blocking follow-ups. |
| `frontend-dev` (a89ad883) | Fix #34 round 2 | Root-caused bbox bug to `Box3.setFromObject` using conservative-corner transform vs tight vertex walk. Fixed `recenterGroup` via new `computeWorldBoxTight` helper. Also fixed visual spec's bad `import 'three'` inside `page.evaluate`. Hit Sonnet rate-limit mid-rebase of main into the branch; commits pushed but conflict resolution incomplete. |
| (lead) | Rebase + conflict resolution | Three files (`en.json`, `index.html`, `main.ts`) had PR #33 × PR #34 overlap. Resolved by hand: keep both top-level i18n keys, keep `#body` grid layout from PR #33, keep `.place-on-face` toggle styling from PR #34. Force-pushed. |
| `frontend-dev` (ab9836c2) | Fix #34 round 3 | New failure mode: E2E test now **timed out at 30 s** instead of assertion-failing. Agent bisected it to the `for 51804 expect().toBe()` loop in the buffer-unchanged check — ~2 ms per `expect` × 51k = 118 s wall-clock. Collapsed to a single-assertion first-mismatch search; runtime dropped from 118 s to ms. |

### Critical learnings captured

- **`Box3.setFromObject(mesh)` without `precise=true` uses local-bbox-corner transform, not vertex walk.** For arbitrary rotations this over-estimates the world AABB. If a lay-flat-ish feature depends on `min.y`, use `setFromObject(mesh, true)` or a hand-rolled vertex walk. (Documented in `layFlat.ts` alongside `computeWorldBoxTight`.)
- **`expect().toBe()` has ~2 ms of matcher overhead in Playwright.** Never loop-assert over 10k+ element arrays. Find-first-mismatch + single `expect` is the pattern.
- **Parallel frontend-devs touching `i18n/en.json` + `index.html` + `main.ts` will conflict.** The issue bodies explicitly flagged "whichever PR lands first wins, the other rebases" — but when the second PR also hits a QA-blocker round, the rebase timing compounds. Lead owned the rebase in the end; future parallel waves should preferentially target non-overlapping files.
- **Sonnet agent rate-limit mid-task** (reset 7pm local) cut off the first round-2 fix. Recovered by re-spawning after reset. Worth tracking cumulative rate-limit hits per wave as a health metric.

### User-driven product direction captured

Mid-wave, the user set a product direction for Phase 3c:

1. **Lay-flat orientation is a required setup step** — the user must commit a face before the mold-generate action is enabled.
2. **Mold generation is an explicit button**, not automatic. Greyed out until orientation is committed.
3. **"Mold type" picker is out** — single-strategy (two-halves-in-box) at v1 means there's nothing to pick. The "Generate mold" button IS the mold-type commitment.
4. The UX cue is a persistent "Please orient the part on its base" hint, not a blocking modal.

Recorded here because it resets the shape of Phase 3c.

### Outstanding advisory / follow-up items (cumulative, not new this wave)

- Visual regression on ubuntu (SwiftShader) was FAILURE on #24, #29, #33, #34 — still the no-linux-CI-goldens situation. Policy (ADR-003 §B): first-successful-main-push CI → commit artifact PNGs → flip `continue-on-error: false` around 2026-05-03.
- QA follow-ups from #33: (F1) Phase 3c integration point — `parametersStore` only exposed via `window.__testHooks.parameters`; add a proper import re-export when 3c needs it. (F2) Skip-to-viewport keyboard shortcut + light-theme parity deferred to 3j.
- QA follow-ups from #34: (F3) add regression test for `localNormalToWorld` under non-uniform scale (future mirror feature). (F4) the agent included Escape-exit + cursor-crosshair E2E in the fix wave, so those two AC bullets are now covered.
- "auto-center on Group, never on geometry" + "lay-flat rotation is group-level" invariants should be codified in `.claude/skills/three-js-viewer/SKILL.md` — lead-authored doc PR, since sub-agents can't edit skills.
- Overlapping `tests/visual/empty-scene.spec.ts` + `scene-empty-axes.spec.ts` — consolidate.
- `build windows installer` CI job has now run on main pushes (verify on next run) and continues to SKIP on PRs — intentional, it's a main-branch-only job.

### Phase 3b → 3c gate

Phase 3b delivered: parameter inputs are captured, lay-flat orientation is committable. Phase 3c ("Mold generation — happy path") can start. Suggested first-wave:

1. **[feat] Setup cue + disabled "Generate mold" button** (`agent:frontend`) — persistent hint ("Please orient the part on its base before generating the mold") + `#sidebar` button wired to a yet-unimplemented generator stub. Small scope, lands the UX gate without any geometry work.
2. **[feat] Happy-path mold generator** (`agent:geometry`) — consume `parametersStore` state + current `group.quaternion`, output base + sides + cap + sprue as Manifolds. No preview yet, no export — just produce the geometry in memory + surface silicone + resin pour volumes in the topbar alongside the master volume. Multi-issue, opens up Phase 3d/e/f.

---

## 2026-04-19 night — Phase 3c wave 1 + 2

User gave the "kick off Phase 3c" go-ahead. Mid-wave, surfaced a product direction: **mold generation is gated behind lay-flat orientation, triggered by an explicit button, and no mold-type picker at v1** (single-strategy means no branching). The wave split cleanly into two sub-waves:

- **Wave 1**: UX gate (button + "please orient" hint) + geometry primitive (`generateSiliconeShell`). Both shipped in parallel.
- **Wave 2**: Plumbing that wires them together — button triggers the primitive, volumes surface in the topbar, stale-invalidation on orientation change.

### Issues opened

| # | Title | Agent | Status |
|---|---|---|---|
| #36 | feat(ui): Generate-mold button + orientation-committed gate | `agent:frontend` | **DONE — PR #38 merged (`84f1307`)** |
| #37 | feat(geometry): silicone shell generator (halves + volumes) | `agent:geometry` | **DONE — PR #39 merged (`e6fe202`)** |
| #40 | feat(ui): wire Generate button to silicone-shell generator + topbar volumes | `agent:frontend` | **DONE — PR #41 merged (`783c805`)** |

### PRs merged

| PR | SHA | What |
|---|---|---|
| #38 | `84f1307` | Generate-mold button at top of sidebar, disabled until `LAY_FLAT_COMMITTED_EVENT` fires with `detail:true`, persistent three-state hint, console.log stub for onGenerate. |
| #39 | `e6fe202` | `generateSiliconeShell(master, parameters, viewTransform)` — `levelSet` shell (via three-mesh-bvh SDF) + boolean cavity + horizontal `splitByPlane` at post-transform bbox mid-Y. Master Manifold lifecycle refactored to cache on group.userData. |
| #41 | `783c805` | onGenerate calls `generateSiliconeShell`; topbar extended with Master + Silicone + Resin readouts; busy/error UX states on the button; shared `generateEpoch` module bumped on every invalidation (close the mid-flight race). |

### Agent roster this wave

| Agent | Task | Outcome |
|---|---|---|
| `frontend-dev` (a5663dd5) | #36 → PR #38 | Shipped clean, 1 QA round, approved. |
| `geometry-dev` (aeb32171) | #37 → PR #39 | Shipped clean. Declared 3 deviations (coarser `edgeLength`, 5 s operational gate vs 3 s target, Manifold-lifecycle Option A) — all justified. |
| `qa-engineer` (ac6e188b) | Review #38 | Approved — praised orthogonal `setEnabled`/`setHasMaster` state, no-master variant hint choice, empirical vertex-buffer-untouched assertion. |
| `qa-engineer` (af99824e) | Review #39 | Approved — verified all 8 ACs, Manifold-lifecycle clean (single eviction point, no WASM leak), volume invariants + non-identity transform test + wall-thickness floor all covered. |
| `frontend-dev` (af61d9bd) | #40 → PR #41 (round 1) | Shipped wired path + epoch counter for in-flight cancellation. CI red on a single E2E assertion + QA found a real latent race. |
| `qa-engineer` (ad38eec9) | Review #41 round 1 | `Requires changes` — **caught a real latent bug**: `attachGenerateInvalidation` nulled the topbar readouts but did NOT bump `generateEpoch`, so a mid-flight commit could let the first resolve still push stale volumes. Also flagged the E2E busy-state race — Playwright's polling missed the transient "Generating…" label on fast CI. |
| `frontend-dev` (ac7a2a20) | Fix #41 round 2 | Both blockers fixed cleanly — MutationObserver captures label transitions before click, `generateEpoch` extracted to shared module and bumped from the invalidation listener. Orchestrator extracted for testability; new race-condition unit test uses the REAL invalidation listener to prove the fix. |

### Critical learnings captured

- **Shared-module counter beats closure-scope counter when multiple sites need to increment.** The original PR put the epoch counter as a module-level variable in main.ts, only writable from `handleGenerate`. That silently miscompiled the race semantics: invalidation wiped the topbar but the in-flight resolve didn't know. Moving the counter to `generateEpoch.ts` with a `bumpGenerateEpoch()` exportable function is the right factoring for a multi-writer staleness guard.
- **Playwright's polling-based assertions race transient UI states.** `toHaveText("Generating…", { timeout: 2000 })` fails if the state lasts < the polling interval. MutationObserver capture before the trigger event is race-free because the observer fires on every DOM mutation, independent of Playwright's poll loop.
- **QA's value was concrete this wave.** The auto-generated tests would have missed the `generateEpoch` bug entirely — only a test that (a) uses the REAL invalidation listener, (b) uses a hand-resolvable deferred promise, catches it. QA caught the semantic hole and demanded that specific test shape. That's the kind of review no lint / type / happy-path test suite can substitute for.

### Mini-figurine-on-default-params numbers (for eyeball sanity)

After clicking Generate on the fixture with default parameters (wallThickness=10mm, baseThickness=5mm, sideCount=4):
- Master volume: 127 452 mm³ (≈ 127.5 cm³ — sensible for an 85×69×110 mm miniature)
- Silicone volume (both halves combined): 319 914 mm³ (≈ 2.51× master — sensible for a 10 mm wall at this scale)
- Resin volume: 127 452 mm³ (= master at this stage; sprue + vent channels add later in Phase 3d/e)
- Wall-clock: ~2.2 s local, ~3.4 s CI

### Outstanding advisory / follow-up items (cumulative)

- Visual-regression goldens still not committed — every new PR adds "first-run golden writes" to the advisory failures. Policy deadline is 2026-05-03; need a lead-owned PR to commit the artifact PNGs from a successful main-push CI run and flip `continue-on-error: false`.
- QA follow-ups from #38 (not filed as issues yet): document golden-regeneration step when the advisory window closes; consider `getMasterGroup(scene)` helper to stop duplicating the `'master'` tag literal.
- QA follow-ups from #39 (same): tighten `edgeLength` + SDF optimisation when printable silicone halves arrive (Phase 3d/e); harden the +X ray-parity SDF with majority-vote multi-ray when a failing real-world fixture surfaces.
- QA follow-ups from #41 (same): `setVolume` → `setMasterVolume` call-site sweep + alias removal; E2E `'No master loaded'` i18n hard-coupling helper; `#e06c75` → `--error-color` CSS token promotion; direct new-STL-load invalidation test.
- Lead-owned doc PR: codify "viewport-level Group transforms only, never geometry/manifold" invariant + "sticky shared counters for staleness guards" learning in `.claude/skills/three-js-viewer/SKILL.md`. Sub-agents can't edit skills.
- `minkowskiSum` in manifold-3d 3.4.1 is effectively unusable for masters above ~1 k tri (measured ~180 s on mini-figurine against any ball tessellation). Parked reference — we use `levelSet` instead.
- Master Manifold now lives on the scene graph; consider a tiny cleanup PR that exports `getMasterGroup` / `getMasterManifold` as a public API rather than walking scene.children for the `tag==='master'` literal.

### Phase 3c wave 1 + 2 → wave 3 gate

Phase 3c wave 1 + 2 delivered: the user can Open STL, orient, tweak parameters, and click Generate to get silicone + resin volumes in the topbar. All three volumes stale-invalidate correctly when orientation changes.

**Next logical wave for 3c (Phase 3d/3e tying together):**

1. **[feat] Viewport preview of generated silicone halves** (`agent:frontend` + `agent:geometry`) — render the two half-Manifolds as semi-transparent meshes in the scene, with an exploded-view toggle. Depends on keeping the halves alive after generate rather than `.delete()`-ing them (currently line 309-310 of main.ts).
2. **[feat] Printable-parts pipeline** (`agent:geometry`) — the rest of the `.claude/skills/mold-generator/SKILL.md` algorithm (steps 5-7): containment box → base + N sides + top cap, registration keys on parting line, sprue + vent channels. Large scope; split into 3-4 PRs.
3. **[feat] STL export of generated parts** (`agent:app-shell` + `agent:geometry`) — Phase 3f. Native save-dialog, multi-file export, canonicalised binary STLs.

Awaiting user go-ahead.

---

## 2026-04-20 → 2026-04-23 — v1 feature complete (rigid-shell + silicone-glove)

Phases 3d–3j collapsed into a single arc. Condensed log; commit history in git is authoritative.

### Strategy redirect (2026-04-20)

Dogfood of the two-halves-in-box build didn't match the user's mental model of how they actually hand-make molds. User supplied 7 annotated images + clarification messages. New spec (see [CLAUDE.md](../CLAUDE.md) v1 scope):

- Silicone is ONE surface-conforming piece around the master.
- Printed shell is ALSO surface-conforming (a second offset around the silicone), NOT a rectangular box.
- Shell sits on a 2D-footprint base slab with a 45° interlock.
- Shell is sliced radially into 2/3/4 pieces; each piece carries a brim flange.
- Sprue, vents, and horizontal silicone split removed.

User selected "Waves A + C only" first, then greenlit D/E/F after Wave C landed. Plan [`you-are-the-lead-transient-pearl.md`](../../../../Users/Wiz/.claude/plans/you-are-the-lead-transient-pearl.md).

### Shipped features (PRs in order)

| Wave | PR(s) | What |
|---|---|---|
| A | #69/#70 | strip sprue/vents/keys/silicone-split + rename thickness params |
| C | #72/#73 | surface-conforming print shell |
| perf | #75 | SDF cache + far-field skip |
| 3f-adjacent | #79/#80 | dimensions panel (scale/resize before Generate) |
| D | #82/#83 | base slab with step-pocket interlock |
| E+F | #84/#85 | radial slicing + brim flanges |
| polish | #87/#88 | progress banner + open-top silicone + base-slab visibility |
| fix | #89/#90 | brims don't intersect silicone cavity / each other |
| export | #91/#92 | save printable parts as binary STL |
| polish | #94/#95 | open shell pour channel + brim tightening + face-pick drag threshold |
| polish | #97/#98 | banner pre-freeze + face-pick + slab regression + brim bond 2x |
| docs | #101 | mesh-operations SKILL.md perf playbook |
| brim | #100 | taper brim at shell junction |
| fix | #99 | resin reflects viewTransform + degenerate-slab warning |
| perf | #103 | adaptive edgeLength for large masters |
| perf | #104 | generateMold off-thread via web worker |
| fix | #105 | face-pick pure-geometric canvas gate |
| polish | #106 | smooth shading + full-height brim flange |
| cut-planes | #108, #109 | plumb cut-rotation + center-offset through slicer/brim |
| cut-planes UI | (4eb3efc) | preview + drag gizmo |
| brim conformal | #110 | flange follows shell contour at cut plane |
| brim fix | #111 | raw shell-wall slice for bond region (fix top/bottom overhang) |
| brim fix | #112 | drop bond-region extrusion (fix interior shelves) |
| perf | #113 | cache cut-plane slices — mini-figurine 15 s → 7 s |
| docs | #114 | CLAUDE.md v1-scope rewrite |
| seal v1 | #115 | vertical top tube + tongue-and-groove seal (mid-height Y-step) |
| seal v2 | #116 | replace Y-step with full-height V-chevron seal |
| seal v3 | #117 | clip V-chevron to cut-face profile |
| seal v4 | #118 | pentagon tongue with bond-base (eliminate floating seal) |

All admin-bypass-merged by lead after qa approval + green CI (full-merge-autonomy policy).

### Open / pending

- **Dogfood pending:** user needs to run `pnpm dev`, drop `mini-figurine.stl`, commit a face, Generate, and confirm the pentagon tongue from #118 is bonded into its parent shell piece (no floating V beyond the brim).
- **Deferred until after first physical print:** registration keys on brim interface; draft-angle wire-through (parameter slider exists but doesn't affect geometry yet); camera reframe after the new shell shape ships.
- **Known CI flake:** visual regression on SwiftShader occasionally diffs ~0.02 pixel ratio from SwiftShader non-determinism — accepted; goldens regen via one-shot workflow when geometry genuinely changes.

### Resume pointer

Fresh-session kickoff prompt: **"resume mold program"**. Read [CLAUDE.md](../CLAUDE.md), this section, and memory file [resume_pointer_2026-04-23.md](../../../../Users/Wiz/.claude/projects/f--CLAUDE-CODE---AI-Silicone-mold-App/memory/resume_pointer_2026-04-23.md) — those three give the full picture.
