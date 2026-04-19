# Sub-agent roster

Named Sonnet sub-agents used by the lead (Opus). The lead spawns them on demand with scoped prompts that reference the GitHub issue, relevant skill files, and test fixtures. One agent per task; agents don't spawn other agents.

## Active roster

| Agent | Primary domain | Primary skills |
|---|---|---|
| [architect-reviewer](architect-reviewer.md) | Deep PR review when QA flags ambiguity or cross-cutting impact | `qa-review` + all domain skills |
| [frontend-dev](frontend-dev.md) | React/DOM UI outside the 3D canvas — forms, settings, i18n, theming | `three-js-viewer` (for canvas-adjacent UI) |
| [geometry-dev](geometry-dev.md) | Mesh ops, mold generation algorithms | `mesh-operations`, `mold-generator`, `testing-3d` |
| [app-shell-dev](app-shell-dev.md) | Electron main/preload, IPC, installer, updater | `desktop-app-shell` |
| [qa-engineer](qa-engineer.md) | Gate every PR before merge | `qa-review` |
| [test-engineer](test-engineer.md) | Test infrastructure, fixtures, CI health, visual-regression | `testing-3d` |
| [docs-writer](docs-writer.md) | User-facing docs, CLAUDE.md upkeep, ADR editing support | (general) |
| [research-analyst](research-analyst.md) | Ad-hoc research before architectural decisions | (general) |

## Spawning rules

- Lead spawns agents with a scoped prompt that links: (a) the GitHub issue, (b) the skill file(s), (c) the fixture path(s), (d) any relevant existing code to reuse.
- Agent context is small and task-specific — don't dump the whole repo into the prompt.
- Agents return a PR link (or a draft for review). Lead does not re-spawn the same agent for the same task if it failed QA twice — retire and replace (see `github-workflow` skill).
- Multiple agents in parallel is fine when their work doesn't touch overlapping files. Lead serialises on shared files.

## Fire/hire log

Tracked in [docs/status.md](../status.md). Every spawn, every merge, every retirement gets a line.

## Phase applicability

| Agent | Phase 0 | Phase 1 | Phase 2 | Phase 3 |
|---|:-:|:-:|:-:|:-:|
| research-analyst | heavy | light | light | light |
| architect-reviewer | — | — | on demand | on demand |
| app-shell-dev | — | heavy | — | light |
| geometry-dev | — | — | — | heavy |
| frontend-dev | — | — | — | heavy |
| test-engineer | — | light | heavy | heavy |
| qa-engineer | — | — | every PR | every PR |
| docs-writer | — | light | light | light |
