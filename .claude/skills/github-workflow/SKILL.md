---
name: github-workflow
description: Branch naming, issue → branch → PR flow, conventional commits, label taxonomy, milestone discipline. Every agent working in this repo follows this.
---

# github-workflow skill

## When to invoke

Any agent about to: create an issue, create a branch, write a commit, open a PR, apply a label, assign a milestone, or review a PR. In short: always.

## Branch naming

```
feat/<area>-<short-desc>   — new capability
fix/<area>-<short-desc>    — bug fix
chore/<area>-<short-desc>  — tooling, deps, non-feature maintenance
docs/<area>-<short-desc>   — documentation-only changes
test/<area>-<short-desc>   — test-only changes
```

**Area:** `geometry`, `viewer`, `shell`, `ui`, `ci`, `build`, `deps`, `docs`, `tests`.
**Short-desc:** kebab-case, 2–5 words.

Examples: `feat/geometry-parting-plane`, `fix/viewer-camera-frame-on-load`, `chore/deps-bump-electron-42`.

Never commit to `main` directly. `main` is branch-protected; PRs only.

## Issue → branch → PR

1. **Lead opens an issue** using the `agent-task` template, fills inputs + outputs + acceptance criteria, applies labels (`phase-N`, `agent:<name>`), assigns a milestone.
2. **Agent** (prompted by the lead) reads the issue, creates the feature branch locally, commits work, pushes branch.
3. **Agent opens a PR** referencing the issue (`Closes #NN`), copies the acceptance-criteria checklist into the PR body, fills test results, adds screenshots if UI.
4. **qa-engineer** reviews using `.claude/skills/qa-review/SKILL.md`.
5. **Lead merges** (squash-merge preferred) after CI green + QA approval.
6. **Lead updates `docs/status.md`** if the merge closes a milestone or changes scope.

## Conventional commits

```
<type>(<scope>): <subject>

<body if helpful>
```

Types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `revert`.
Subjects: imperative, lowercase, no trailing period, ≤ 72 chars.

Examples:
```
feat(geometry): compute silicone wall via levelSet
fix(viewer): frame-on-load accounts for empty BVH
test(mold): snapshot base part for mini-figurine fixture
```

## Labels

See `.github/labels.yml` for the full taxonomy. Every issue and PR gets:

- **Exactly one phase label:** `phase-0` | `phase-1` | `phase-2` | `phase-3`.
- **Exactly one agent label:** `agent:frontend` | `agent:geometry` | `agent:app-shell` | `agent:qa` | `agent:test` | `agent:docs` | `agent:research` | `agent:architect-review`.
- **Zero or more type labels:** `bug`, `enhancement`, `tech-debt`, `blocked`, `needs-human`, `good-first-issue`.

## Milestones

1:1 with phases:

- **Phase 0 — Research & architecture** (closed 2026-04-18)
- **Phase 1 — Project skeleton**
- **Phase 2 — Agent roster operations**
- **Phase 3 — v1 core features**

Issues without a milestone are not eligible for agent assignment — lead must milestone first.

## Protected main rules

- No direct pushes.
- PRs require: 1 approving review (`qa-engineer`), green CI, linear history (no merge commits from PRs → use squash).
- Force-push disabled.
- `main` branch protected against deletion.

## Agent-specific rules

- **One issue, one branch, one PR.** No multi-issue branches, no PRs that touch three issues.
- **Don't merge your own PR.** Even if you're the lead. Every merge passes through QA review + the lead.
- **Don't close an issue without an accompanying PR.** Abandoned issues get a comment and the `blocked` label.
- **Stale branches (> 14 days without push) get auto-closed.** Agent re-opens if still relevant.

## Anti-patterns

- "Fix typo" PRs straight to main via direct push — blocked by branch protection, don't try.
- Squash-merging a PR that depends on an un-merged PR — rebase first.
- Rewriting history on shared branches (`git push --force`). Force-with-lease is acceptable on your own feature branches before PR open; never on `main`.
- Bypassing the agent-task template because "it's a small change." Every change goes through an issue.
- Labels that don't match `labels.yml`. Add to the yml first via a `chore/ci-*` PR.
