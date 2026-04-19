---
name: Agent task
about: Spec a task for a sub-agent to pick up (lead opens these; agents don't)
title: '[<area>] <short imperative>'
labels: 'agent:<agent-name>'
assignees: ''
---

## Context

<!-- 2–3 sentences. Why this task exists, what user need it serves, which milestone it belongs to. -->

## Inputs

- Master mesh: <!-- which fixture or describe -->
- Parameters: <!-- wall thickness, side count, etc. -->
- Existing functions to reuse: <!-- list with file:line refs — avoid duplication -->

## Outputs

- Code: <!-- files expected to be created or modified -->
- Tests: <!-- unit + E2E + visual-regression as applicable -->
- Documentation: <!-- if user-facing or changes public API -->

## Acceptance criteria

<!-- Copy this checklist into the PR body and tick each one. Be specific and testable. -->

- [ ] <!-- criterion -->
- [ ] <!-- criterion -->
- [ ] <!-- criterion -->
- [ ] Unit tests added with tolerance assertions against at least one canonical fixture
- [ ] `pnpm lint && pnpm typecheck && pnpm test` all green
- [ ] If UI-touching: Playwright `toHaveScreenshot` updated or new golden added

## Non-goals (what NOT to do)

- <!-- things the agent might be tempted to do but shouldn't in this task -->

## Relevant skill files

- `.claude/skills/<skill-name>/SKILL.md`
- <!-- additional skills if multi-domain -->

## Target agent

`<agent-name>` (see docs/agents/)

## Branch

`feat/<area>-<short-desc>` (e.g. `feat/geometry-parting-plane`)
