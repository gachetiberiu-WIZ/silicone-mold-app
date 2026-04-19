---
name: qa-review
description: PR review checklist for the qa-engineer agent. Gates every merge — no exceptions. Use when reviewing any PR before it goes to main.
---

# qa-review skill

## When to invoke

Every PR. The `qa-engineer` sub-agent loads this skill and walks the checklist against the PR body, diff, and CI results. No PR merges without a QA approval.

## Review order (do these in sequence)

### 1. Scope check

- [ ] PR is linked to exactly one GitHub issue.
- [ ] The issue's acceptance criteria are all ticked in the PR body.
- [ ] Diff does not exceed the issue's stated scope. New files / new modules not mentioned in the issue → request justification or split.
- [ ] No out-of-scope features snuck in (e.g. "also added a sleeve mold variant").

### 2. CI health

- [ ] `lint` green.
- [ ] `typecheck` green.
- [ ] `geometry` unit tests green, coverage on `src/geometry/**` ≥ 70 %.
- [ ] `e2e` (windows-latest) green, OR an intentional skip is documented in the PR body.
- [ ] `visual-regression` — diffs reviewed; all changes are intentional (or advisory period, in which case a diff-review comment is still required).
- [ ] `build-installer` — green on push to `main`.

### 3. Correctness spot checks

- [ ] Every changed or new geometry function has at least one unit test.
- [ ] Any new STL-producing code has a canonicalised-SHA-256 snapshot test.
- [ ] Watertight assertions (`isManifold()`) present before any STL export path.
- [ ] Numeric tolerances use `toEqualWithTolerance` / `toBeCloseTo`, not raw `===`.
- [ ] No new mesh-CSG library added — still only `manifold-3d` + `three-mesh-bvh` + three.js STL loaders.

### 4. UI / UX (if UI-touching)

- [ ] Screenshot or GIF in the PR body.
- [ ] All user-visible strings routed through `i18next` keys (grep for hardcoded English in new JSX/TSX — zero matches).
- [ ] Dark + light theme both render correctly (screenshots required for both).
- [ ] mm/inches toggle still works; new fields respect the unit.
- [ ] Keyboard accessibility: new controls reachable with Tab; focus ring visible.

### 5. Security & safety

- [ ] No new secrets / tokens / certs in the diff.
- [ ] Any new env var documented in `.env.example`.
- [ ] Electron: no renderer-side `fs` / `child_process` usage; all through typed IPC.
- [ ] No `eval`, `new Function`, or `innerHTML = <untrusted>`.
- [ ] STL parser bounds still enforced (tri count + file size).

### 6. Conventions

- [ ] Commit subjects follow conventional-commit format.
- [ ] Branch name format `feat/<area>-<desc>` etc.
- [ ] No `--no-verify`, no amended pushed commits, no force-push.
- [ ] `CLAUDE.md` still accurate (no new decisions that contradict it; no new constraints missing).
- [ ] `docs/status.md` updated if this PR completes a milestone or changes scope.

### 7. Skill alignment

- [ ] If the PR modifies geometry code, `.claude/skills/mesh-operations/SKILL.md` principles were followed.
- [ ] If UI: `.claude/skills/three-js-viewer/SKILL.md` conventions followed.
- [ ] If Electron layer: `.claude/skills/desktop-app-shell/SKILL.md` security rules followed.

## Outcomes

**Approve** — all boxes ticked. Leave a concise comment summarising what you checked.

**Request changes** — list specific unticked boxes with file:line references where possible. Don't leave vague "LGTM with nits" reviews.

**Escalate to lead (`needs-human` label)** — if the PR reveals an architectural question outside your authority (e.g. wants to add a new library, change a locked decision). Do not approve and do not reject; leave a comment tagging the lead.

## Anti-patterns for the reviewer

- Rubber-stamping because CI is green. CI doesn't check scope creep, UX regressions, or locked-decision violations.
- Asking the author to add "one more small thing" beyond the linked issue — that becomes a separate issue.
- Approving and merging in the same action — lead merges, not QA.
- Leaving comments without file:line refs — the author will ask "where?" and waste a round-trip.

## Fire criteria

An agent's PR is considered a QA failure if it lands here with any of:

- A locked decision violated (e.g. a new CSG library).
- Missing tests for new geometry code.
- CI not green at PR submission time.
- Scope creep beyond the linked issue.

Two QA failures in a row from the same agent in the same task category → the lead retires that agent for that category and spawns a replacement. Log the event in `docs/status.md`.
