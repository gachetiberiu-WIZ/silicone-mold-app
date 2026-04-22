## Goal

Replace the rectangular print box with a **surface-conforming print shell** that hugs the silicone. This is the biggest user-visible change in the redesign phase — the reason we stripped everything else in PR #70 (issue #69).

After this PR, `generateMold` produces: master (unchanged) + one silicone offset + one print shell offset. No base slab, no radial slicing, no brims — those are deferred Waves D / E / F per the approved plan at `C:\Users\Wiz\.claude\plans\you-are-the-lead-transient-pearl.md`.

Also bundles the perf follow-up #71 (bump `edgeLength` floor 1.5 → 2.0 mm) and the CLAUDE.md v1-scope + mold-generator skill rewrite, since Wave C is the PR that makes "rigid shell + silicone glove" the real strategy.

## Scope — one PR

### Geometry pipeline (the load-bearing change)

In `src/geometry/generateMold.ts`, after the existing silicone step:

1. **Second `levelSet` call** on the SAME master SDF closure (reuse the BVH-driven `sdf` from lines ~289-334 of the post-PR-#70 code):
   ```ts
   const outerOffsetLevel = -(siliconeThickness_mm + printShellThickness_mm);
   const printShellOuter = toplevel.Manifold.levelSet(sdf, expandedBounds, edgeLength, outerOffsetLevel);
   ```
   No BVH rebuild needed — the SDF closure is stateless relative to the level parameter.

2. **Subtract silicone outer surface** from the print-shell-outer body:
   ```ts
   const printShell = printShellOuter.subtract(siliconeOuter);
   ```
   Result: a hollow, surface-conforming print shell with the silicone exactly fitting inside.

3. **Horizontal trim** via `trimByPlane`:
   - Top cut at `Y = masterBbox_oriented.max.y + siliconeThickness_mm + 3 mm` (open pour edge — 3 mm lip above silicone top).
   - Bottom cut at `Y = masterBbox_oriented.min.y` (shell sits on whatever is at the master's base; base slab comes in Wave D).
   ```ts
   const trimmedTop = printShell.trimByPlane([0, -1, 0], topY);   // keep below top cut
   const trimmedBoth = trimmedTop.trimByPlane([0, 1, 0], bottomY); // keep above bottom cut
   ```

4. **Result shape update:**
   ```ts
   interface MoldGenerationResult {
     silicone: Manifold;
     printShell: Manifold;                     // NEW — single surface-conforming shell
     siliconeVolume_mm3: number;
     resinVolume_mm3: number;                  // still === masterVolume
     printShellVolume_mm3: number;             // RENAMED from printableVolume_mm3
   }
   ```
   Drop `basePart`, `sideParts`, `topCapPart`, `printableVolume_mm3`.

5. **Delete `src/geometry/printableBox.ts` + `tests/geometry/printableBox.test.ts`.** But FIRST: extract `SIDE_CUT_ANGLES` to `src/geometry/sideAngles.ts` (a ~10-line module) so the Wave E radial slicer can reuse it without resurrecting the deleted file.

6. **Bundle perf fix #71:** change the edgeLength floor in `generateMold.ts` from `max(1.5, siliconeThickness/4)` → `max(2.0, siliconeThickness/4)`. At siliconeThickness=5 this drops ~4.6× → ~2.4× grid cells, bringing CI back under ~4 s per QA's extrapolation. Still `0.4× thickness`, well within the 0.3× preview-fidelity budget.

### Renderer changes

- `src/renderer/scene/printableParts.ts`:
  - `setPrintableParts(scene, { printShell: Manifold })` — single Manifold, single mesh.
  - Keep the existing `MeshStandardMaterial({color: 0xb8b8b8, roughness: 0.8, metalness: 0.0})`.
  - Exploded view: print shell translates `+Y` by `max(40, 0.25 * bboxHeight)` (slightly more than silicone's offset, so it lifts clear above the silicone). Silicone stays at its own `+Y` offset. The separation reveals the master in the middle.
  - Keep the visibility toggle + `isPrintableExplodedIdle` + `arePrintablePartsVisible` test hooks — semantics apply to one mesh instead of many.
  - Camera re-frame: union of master + silicone + printShell AABB.

- `src/renderer/ui/generateOrchestrator.ts`: updated result-shape handoff. Single `printShell` disposal across happy / stale / error paths, same contract as `silicone` in PR #70.

- `src/renderer/ui/topbar.ts`: `printable-volume-value` readout rename to `print-shell-volume-value`. New i18n key `topbar.volumePrintShell` ("Print shell").

### Tests

- `tests/geometry/generateMold.test.ts`:
  - Update `disposeAll` to delete `silicone` + `printShell`.
  - Drop assertions about `basePart` / `sideParts` / `topCapPart`.
  - New assertions: `printShell` is watertight (`genus === 0`), non-empty, and its AABB is bounded by `masterBbox + (siliconeThickness + printShellThickness + edgeLength_tolerance)` on XZ.
  - Keep the Generate×3 leak-check, adapt to new shape.
  - Update volume-identity: `silicone.volume + printShell.volume + hollow_interior_volume ≈ outer_offset_volume` (trivial sanity — no longer exact analytical identity).
- `tests/renderer/scene/printableParts.test.ts`: single-mesh contract.
- `tests/visual/silicone-exploded.spec.ts` + `tests/visual/printable-parts-exploded.spec.ts`: goldens invalidated. Regen both via one-shot workflow. Remove workflow in final commit.
- Apply `timeout: 60_000` to `printable-parts-exploded.png` (QA flagged in PR #70 follow-up — same flake class as `silicone-exploded`).

### Docs + skills

- `CLAUDE.md`: replace the v1-scope lock line:
  > v1 scope (locked at Phase 0 gate, 2026-04-18): two-halves-in-box mold strategy only...
  
  with:
  > v1 scope (redirected 2026-04-20 after dogfood): rigid-shell + silicone-glove mold strategy. Surface-conforming silicone offset + surface-conforming print shell, open-top pour edge, optional radial slicing + brims (Waves E/F). Sleeve+shell variations, multi-part (3-5), brush-on, and cut molds explicitly out of scope — do not add them without user approval.
  
- `.claude/skills/mold-generator/SKILL.md`: rewrite algorithm + input/output sections to match the new pipeline. Keep the "When to invoke" section; update "Output contract" with the new `MoldGenerationResult` shape.

### Visual regression workflow hygiene

Same pattern as PRs #52/#54/#63/#68/#70:
- Add `.github/workflows/update-linux-goldens.yml` on THIS branch, guarded by `if: github.ref == 'refs/heads/feat/geometry-surface-conforming-shell'`.
- It runs `pnpm test:visual --update-snapshots` on ubuntu + commits the new goldens back.
- **Remove the workflow in the final commit.** Verify via `git ls-tree origin/feat/geometry-surface-conforming-shell .github/workflows/` → `ci.yml` only.

## Acceptance criteria

- [ ] `MoldGenerationResult` shape exactly matches the interface above.
- [ ] `src/geometry/printableBox.ts` + its test deleted. `src/geometry/sideAngles.ts` created with `SIDE_CUT_ANGLES` re-exported.
- [ ] `edgeLength` floor raised to 2.0 mm in `generateMold.ts`.
- [ ] `printShell` Manifold: watertight, non-empty, top cut at `master.max.y + silicone + 3 mm`, bottom cut at `master.min.y`, bounds contained within expanded AABB.
- [ ] `resinVolume_mm3 === masterVolume_mm3` within 1e-9 (carry-over from PR #70).
- [ ] Orchestrator disposes exactly one `silicone` + one `printShell` Manifold across happy / stale / error paths. No double-delete, no leak.
- [ ] Scene preview shows silicone (translucent blue) + print shell (opaque gray), master visible through both. Toggle "Show printable parts" flips print shell visibility as before; exploded view animates both meshes `+Y`.
- [ ] Camera re-frames to union AABB after Generate.
- [ ] Topbar shows: Master, Silicone, Print shell, Resin. Resin === Master.
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e` all green.
- [ ] Mini-figurine full pipeline ≤5 s on CI (perf fix #71 bundled).
- [ ] Visual-regression: `silicone-exploded.png` + `printable-parts-exploded.png` regenerated on ubuntu CI. Two-run verification: second run matches without `--update-snapshots`.
- [ ] `.github/workflows/` on final branch tree contains ONLY `ci.yml`.
- [ ] `CLAUDE.md` v1-scope line updated to "rigid-shell + silicone-glove."
- [ ] `.claude/skills/mold-generator/SKILL.md` algorithm + output-contract sections rewritten.
- [ ] Grep confirms zero references to `printableBox`, `buildPrintableBox`, `basePart`, `sideParts`, `topCapPart`, `printableVolume` in `src/` and `tests/`.

## Out of scope (Waves D / E / F)

- **Wave D — Base slab** with 45° interlock + 2 mm overlap + 0.2 mm tolerance.
- **Wave E — Radial slicing** of the print shell into 2/3/4 pieces.
- **Wave F — Brims** on the sliced shell pieces.
- Registration keys (may return on brim interface in Wave F).
- Sprue / vent channels (removed in PR #70).
- Draft angle application.

## Effort

~1 working day. Single PR.

## Agent

`agent:geometry` — worktree isolation. Skills: `mold-generator`, `mesh-operations`, `three-js-viewer`, `testing-3d`, `github-workflow`.

## Files — expected diff

**Create:**
- `src/geometry/printShell.ts` (or inline the levelSet + subtract + trim into `generateMold.ts` if cleaner — agent's call; justify in PR body).
- `src/geometry/sideAngles.ts` (preserved `SIDE_CUT_ANGLES` constant).

**Delete:**
- `src/geometry/printableBox.ts`
- `tests/geometry/printableBox.test.ts`

**Modify:**
- `src/geometry/generateMold.ts` — pipeline extension + edgeLength floor.
- `src/geometry/index.ts` — export `printShell` / `printShellVolume_mm3`, drop printableBox / basePart / sideParts / topCapPart.
- `src/renderer/scene/printableParts.ts` — single-mesh.
- `src/renderer/ui/generateOrchestrator.ts` — new result-shape handoff.
- `src/renderer/ui/topbar.ts` — readout rename.
- `src/renderer/i18n/en.json` — `topbar.volumePrintShell` key.
- `tests/geometry/generateMold.test.ts` — new shape.
- `tests/renderer/scene/printableParts.test.ts` — single-mesh contract.
- `tests/visual/printable-parts-exploded.spec.ts` — timeout bump to 60 s.
- `CLAUDE.md` — v1-scope line.
- `.claude/skills/mold-generator/SKILL.md` — algorithm + output-contract rewrite.

**Transient (add + remove in same PR):**
- `.github/workflows/update-linux-goldens.yml`.
