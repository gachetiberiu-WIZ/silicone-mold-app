# Summary

<!-- 1–3 sentences. What changed and why. -->

## Linked issue

Closes #<!-- issue number -->

## Acceptance criteria (from the issue)

- [ ] <!-- paste the AC checklist from the issue, then tick each one as you verify -->
- [ ]
- [ ]

## What I did

<!-- bullet list of concrete changes, file-by-file if helpful -->

## Test results

- [ ] `pnpm lint` — green
- [ ] `pnpm typecheck` — green
- [ ] `pnpm test` — green, coverage not regressed on the geometry module
- [ ] `pnpm test:e2e` — green on `windows-latest` (or justified skip)
- [ ] New unit tests added for changed geometry / behaviour
- [ ] Canonical-SHA-256 STL snapshots updated if mesh output changed (intentional — explain below)

## Screenshots / GIFs (required if UI-touching)

<!-- before / after for the viewport or UI. Drop images or GIFs. -->

## QA sign-off

- [ ] `qa-engineer` reviewed and approved
- [ ] Visual regression diff reviewed (if present) — acceptable / intentional

## Checklist

- [ ] Units: any new numbers are in mm internally (display-layer conversion for inches)
- [ ] i18n: user-visible strings routed through `i18next`, no hardcoded English
- [ ] Secrets: no new credentials, tokens, or private keys in the diff
- [ ] New env vars documented in `.env.example`
- [ ] `docs/status.md` updated if this PR completes a milestone or changes scope
- [ ] CLAUDE.md still accurate (no decisions that contradict it)

## Agent attribution

Primary author: `<agent-name>` (e.g. `geometry-dev`, `frontend-dev`)
Reviewed by: `qa-engineer`
