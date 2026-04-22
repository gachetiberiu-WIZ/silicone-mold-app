## Goal

Four dogfood findings from the 2026-04-21 full-v1-stack session, bundled into one polish PR.

## Fix 1 — Generate progress indicator (primary UX ask)

**Symptom:** User hits Generate. The app freezes for 10-60 s depending on model size. No visible progress. User thinks the program is hung.

**Fix:**
- Add a non-modal progress banner / toast that appears when Generate starts and disappears when done.
- Content: a spinner + phase label that updates through the pipeline:
  - "Building silicone…"
  - "Building print shell…"
  - "Slicing shell into N pieces…" (only when sideCount > 1, which is always)
  - "Adding brims…"
  - "Building base slab…"
- Position: top-center of the viewport, or wedged into the topbar between the readouts and the unit toggle. Agent's call — match existing visual language.
- Dismissable after completion (auto-fade after 2 s).

**Implementation sketch:**
- New status channel in `src/renderer/ui/` — e.g. `src/renderer/ui/generateStatus.ts` with API `setPhase(label: string | null)`, `clear()`.
- `generateMold.ts` takes an optional `onPhase?: (label: string) => void` callback and fires it at phase boundaries.
- `generateOrchestrator.ts` wires the callback through to the new status channel.
- i18n keys under `status.phase.*`.

**Acceptance:**
- [ ] Clicking Generate immediately shows a progress indicator with a sensible phase label.
- [ ] Phase label updates at least 3 times during a multi-second generate (silicone → shell → slicing/brims → slab).
- [ ] Indicator clears on success, error, and cancel.
- [ ] No visual regression in the standard empty-scene screenshot (indicator hidden by default).
- [ ] New E2E: click Generate, verify the status indicator appears, waits for "done", and then disappears.

## Fix 2 — Base slab not visible in default view

**Symptom:** User loads testing-mold STL, generates, sees shell pieces sitting ON the print bed (Y=0) but the base slab is invisible. Only visible from below.

**Root cause:** After lay-flat + recenter, the master's `min.y` sits at Y=0 (print bed). The base slab extrudes DOWNWARD from `master.min.y` by `baseSlabThickness_mm` — so the slab's world-Y span is `[-baseSlabThickness, 0]`, **below the visual floor plane**. Invisible to the user from standard angles.

**Fix:** Shift the whole mold assembly UP so the base slab sits ON the bed, master rides on top. Real mold-making: you print the slab, the print shell, the master sits in/on the slab — not under a virtual floor. The Y=0 reference line should be the BOTTOM of the printable assembly (the slab's underside), not the master's underside.

**Implementation approach (agent picks):**

**Option A — apply an upward offset in `generateMold.ts`:** after all four parts (silicone, shellPieces, basePart, + leave master alone) are constructed, translate silicone + shellPieces + basePart UP by `baseSlabThickness_mm`. Also translate the master's visual group (or apply a transform to the master mesh) by the same amount so master + silicone + shell stay co-located. Caveat: the master's lay-flat invariant is "master.min.y == 0"; we'd be violating it if we blindly translate the master group. So this option probably means the SCENE translates the whole group, not generateMold.

**Option B — apply the offset in the scene module:** `src/renderer/scene/` orchestrator tracks a `baseSlabOffsetY` and applies it to all four scene groups (master, silicone, printableParts) so the slab sits at Y≥0. Clean because it doesn't disturb geometry code.

**Option B is preferred.** The master's group gets translated up by `baseSlabThickness_mm` after generate. Exploded view still applies additional ±Y offsets on top. The master stays visually anchored to the slab's top surface.

**Acceptance:**
- [ ] After Generate, the base slab is visible from all standard camera angles — its outer footprint is ~5 mm wider than the shell, and its thickness (default 8 mm) sits on the Y=0 plane.
- [ ] Master, silicone, and shell pieces all ride `+baseSlabThickness_mm` above their pre-Wave-D positions.
- [ ] Exploded view still separates correctly (shell pieces radial, slab -Y from its new position, silicone +Y).
- [ ] Re-entering lay-flat picking after Generate re-enables face-picking on the master.
- [ ] Camera re-frames to include the slab after Generate.

## Fix 3 — Brim thickness default too thin

**Symptom:** User says "thickness should be the same as the shell." Default brim thickness is 3 mm; default print shell thickness is 8 mm. The brim looks visually thin next to the shell walls.

**Fix:** Bump `brimThickness_mm` default from 3 to 8. Keep range 2-8 (upper bound 8 — user's sweet spot). Users can still override.

Do NOT drop the parameter entirely or strictly link it to printShellThickness_mm — keeping them independent preserves flexibility for molds where a thinner brim is wanted (small masters). Document the new default in the i18n hint if there's one.

**Acceptance:**
- [ ] Default `brimThickness_mm` = 8 in `src/renderer/state/parameters.ts`.
- [ ] Range unchanged (2-8).
- [ ] Existing `brimThickness_mm` tests still pass.
- [ ] Visual-regression goldens regen if affected.

## Fix 4 — Silicone top is closed, needs to be open for pouring

**Symptom:** In the scene, the silicone fully encloses the master like a sealed jacket — there is no visible top opening to pour liquid silicone into. In real mold-making, the user prints the shell + slab, places the master inside, pours liquid silicone from above, it fills the cavity around the master, then cures. That requires a pour path from the top.

**Root cause:** In `src/geometry/generateMold.ts`, `silicone = siliconeOuter - transformedMaster` where `siliconeOuter = levelSet(-siliconeThickness)`. The level-set wraps the master tightly in all directions, including above. The resulting silicone manifold is a closed jacket with an internal master-shaped cavity, completely sealed — genus ≥ 1. No pour opening.

**Fix:** Trim the silicone's top at `master.max.y` (or a small constant like `master.max.y + 1 mm`) so the silicone's top surface sits flush with (or a hair above) the master's top, exposing the master's top face. Concretely:

```ts
// After: const silicone = siliconeOuter.subtract(transformedMaster);
const siliconeTrimY = masterMaxYInWorld; // expose master top
const siliconeTopOpen = silicone.trimByPlane([0, -1, 0], siliconeTrimY);
silicone.delete();
// Use siliconeTopOpen going forward.
```

Consequence:
- Silicone's top surface = flat plane at `master.max.y`, with the master's top outline as a hole (pour opening).
- Shell still extends up to `master.max.y + siliconeThickness + 3 mm` → forms a pour-well wall of depth `siliconeThickness + 3 mm` above the silicone.
- User pours silicone into this well, it drains around the master through any path the liquid finds until level.
- `siliconeVolume_mm3` shrinks slightly (the top dome is removed) — expected.

**Acceptance:**
- [ ] Silicone viewport: looking straight down (plan view), the master's top is visible as an opening through the silicone. The shell's pour-well wall surrounds it.
- [ ] Silicone is watertight (no open edges at the cut plane — `trimByPlane` should produce a clean cap).
- [ ] `siliconeVolume_mm3` matches expected reduction (roughly: `oldVolume - (master_top_area × siliconeThickness)`).
- [ ] Resin-volume identity `resinVolume_mm3 === masterVolume_mm3` preserved (resin math is independent).
- [ ] Visual goldens regen.

## Investigation (quick check, not a blocker)

**"Based seemed bugged" annotation in image 2:** top-down view shows the base slab has a small rounded bump at one edge of its footprint.

**Likely explanation:** the master (two-lobe figurine) has a small tab at its base that's faithfully reproduced by the master's XZ projection. If that's the case, it's working as intended — the slab follows the master's outline.

**Agent: 5-minute check.** Load the fixture in a browser session or a vitest and log the CrossSection's polygon count + bounds. If the bump corresponds to a real feature of the master's footprint, no fix needed. If the CrossSection has a spurious sub-1mm artifact (e.g. from a degenerate triangle surviving into the slice), file it as a follow-up.

## Out of scope

- Strict linking of brim and shell thickness (user wants the default match, not a lock).
- Progress percentage (phase labels are enough; manifold-3d doesn't emit progress events).
- Re-design of the topbar.
- Waves G+ (registration keys, sprue, vents — all deferred).
- #76, #77, #78, #81, #86 follow-ups.

## Effort

~0.5 day. Single PR.

## Agent

`agent:frontend` + touch `src/geometry/generateMold.ts` lightly (onPhase callback). Worktree isolation. Skills: `three-js-viewer`, `testing-3d`, `github-workflow`.

## Files — expected diff

**Create:**
- `src/renderer/ui/generateStatus.ts` — status banner component + store.
- `tests/renderer/ui/generateStatus.test.ts`.

**Modify:**
- `src/geometry/generateMold.ts` — optional `onPhase` callback.
- `src/renderer/ui/generateOrchestrator.ts` — wire onPhase to status channel.
- `src/renderer/scene/` orchestrator (wherever the group positioning lives) — apply baseSlabOffsetY after Generate.
- `src/renderer/state/parameters.ts` — default brimThickness 3 → 8.
- `src/renderer/i18n/en.json` — `status.phase.*` keys.
- `tests/renderer/scene/*` — update bbox expectations for the +baseSlabThickness offset.
- `tests/visual/*` — regen what shifts (likely sidebar-parameters-defaults, printable-parts-exploded, scene-with-mini-figurine).

**Transient (add + remove in same PR):**
- `.github/workflows/update-linux-goldens.yml`.

## Follow-ups (not this PR)

- #76 adaptive edgeLength, #77 worker offload, #78 SKILL sync, #81 resin viewTransform, #86 E+F perf.
