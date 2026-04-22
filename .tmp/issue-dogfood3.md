## Goal

Four dogfood findings from 2026-04-22 session 2 (post-PR #95 merge). Pour channel works ✓; these four remain.

## Fix 1 — Banner doesn't paint during the 10-second freeze (PRIMARY UX)

**Symptom:** User clicks Generate. The UI freezes for ~10 s. Banner appears at the END (or during the unfreeze) and shows all phases in rapid succession. During the freeze, user thinks the app is broken.

**Root cause:** Manifold-3d ops are synchronous. `await new Promise(r => requestAnimationFrame(r))` queues the resolve for the NEXT RAF tick — but a single RAF tick fires BEFORE the browser has painted. So when `resolve()` runs and the next synchronous manifold call starts, the render thread is still in the "last frame ended" gap — the banner update is in the DOM but hasn't been painted to screen before the next long-running sync block owns the thread.

**Fix:**

Two changes:

A. **Mount + show the banner BEFORE entering the pipeline.** In `src/renderer/ui/generateOrchestrator.ts`, at the top of the generate function, fire `status.setPhase('starting')` (new i18n key `status.phase.starting` = "Generating mold…") and `await new Promise(r => setTimeout(r, 32))` — 32 ms forces at least one full frame to paint.

B. **After EVERY phase change, yield for a real paint with a DOUBLE RAF:**
```ts
await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
```
OR the equivalent `setTimeout(r, 32)` which is more reliable. Double-RAF gives the browser two frames: one to run layout + paint, one to return control.

C. **Keep the banner visible until the assembly actually RENDERS in the scene.** After `setSilicone + setPrintableParts` complete, wait for one more RAF before calling `status.setPhase(null)`. That way the banner doesn't disappear while the scene is still being rebuilt.

**Acceptance:**
- [ ] Click Generate → banner appears IMMEDIATELY (within ~32 ms, before any manifold work starts).
- [ ] Banner updates visibly at each phase — user can see text change from "Building silicone" to "Building print shell" etc. during the 10-second run.
- [ ] Banner clears only after the scene has been updated.
- [ ] No regression in the existing `tests/e2e/generate-progress.spec.ts`.

## Fix 2 — Face-pick STILL bugged (6→10 px widen didn't fix it)

**Symptom:** Face-pick click doesn't always commit. Fix in PR #95 widened the click-vs-drag threshold 6→10 px — still bugged.

**Investigation — add verbose logging first:**

In `src/renderer/scene/layFlatController.ts`, add `console.debug` at each handler event with the relevant state. Ship a dev build, have user reproduce, read the log:
- `onPointerDown(target, x, y, button)` + armed state
- `onPointerUp(target, x, y, button, delta, armed)` + commit fired or skipped with reason
- `onClick` if it fires at all (it shouldn't post-#80)
- `canvas.contains(target)` check at pointerUp

Possible causes to rule out:
- Pointer event target not on canvas (new left pane, banner overlay, or dimensions widget intercepting).
- `event.pointerType === 'touch' | 'pen'` on user's input device — their pointerdown may route via touch, `button` might be 0 but `buttons` differs.
- `pointer-events: none` missing on the banner overlay → banner covers canvas.

**Likely fix:**
1. Ensure the progress banner has `pointer-events: none` on its overlay (check CSS in `src/renderer/index.html` or the banner module).
2. At `pointerup`, check `event.target.closest('canvas')` rather than strict equality — the user might click on a DOM sibling that's z-index-below the canvas.
3. If logging reveals `button !== 0`, relax the primary-button check to `buttons & 1` instead (bit-mask check).

Start with the CSS `pointer-events: none` check — that's the most common regression cause when new overlays land.

**Acceptance:**
- [ ] 10 consecutive face-picks commit on the mini-figurine bottom face.
- [ ] No regression in existing click-vs-drag gate tests.
- [ ] Console logging removed or gated behind a debug flag before merge.

## Fix 3 — Base slab missing in rendered scene

**Symptom:** Dogfood screenshot shows shell pieces + brims but NO base slab underneath. In the top-down-ish view, the slab should be visible as the wider base footprint. Instead, the shell appears to float.

**Investigation:**

1. Load the app, generate a mold, check `window.__testHooks.viewport.scene.children` — count meshes in the printable-parts group. Should be `sideCount + 1` (N shell pieces + 1 slab).
2. If count is only N (no slab mesh): the slab's Manifold conversion to BufferGeometry is failing OR the slab has zero volume.
3. If count is N+1 but slab is invisible: check the slab mesh's `visible`, `material.transparent`, `position`, `bbox`.

**Likely causes:**
- The pour-channel change in PR #95 may have accidentally consumed or deleted the silicone-outer handle before the slab builder ran.
- `setPrintableParts` signature or ordering changed; base slab handoff broken.
- Slab has zero volume (degenerate — see #93) and the scene module handles zero-volume by not mounting, silently.

**Fix:**
1. Reproduce with testing-mold STL.
2. Add `console.log(result.basePart.volume(), result.basePart.isEmpty())` in generateMold.ts post-slab-build.
3. If volume > 0, the issue is in scene/renderer — fix there.
4. If volume === 0, the issue is in baseSlab.ts or generateMold.ts's slab call — likely the pour-channel change consumed siliconeOuter or shifted the master's bbox.

**Acceptance:**
- [ ] Scene shows base slab mesh after Generate. Visible from standard angles.
- [ ] `__testHooks.viewport.scene` has N+1 meshes in the printable-parts group.
- [ ] Slab watertight + non-empty (existing assertion still passes).

## Fix 4 — Brim fins still not connected to shell

**Symptom:** Even after PR #95's 1× → 1.5× bondOverlap bump, the brim still looks disconnected from the shell in the rendered scene.

**Investigation:**

Similar to #94 Fix 2. The brim IS Manifold-unioned with the piece (confirmed case B). The visible disconnect is a rendering artifact of the sharp outer angle + uniform shading.

**Fix — go further than bondOverlap:**

Option A: bump bondOverlap to `printShellThickness × 2` (currently 1.5×). With 8 mm shell thickness → 16 mm bond. Inner brim face sits deep in the shell.

Option B: taper the brim — thicker at shell junction, thinner at the outer edge. Implement as a trapezoidal brim via `CrossSection.extrude(h, 1, 0, scaleTop)` with `scaleTop < 1`. More natural look.

Option C: ship the fillet work from #96.

**Recommended: start with A (double bondOverlap), re-dogfood. If still bad, escalate to B (taper).** C (fillet) remains a deferred cosmetic issue.

**Acceptance:**
- [ ] Brim visually blends into shell in default view (no sharp floating-fin impression).
- [ ] No regression in brim unit tests.
- [ ] If option B lands, new "tapered brim" test asserts outer face is smaller than inner face.

## Out of scope

- Brim fillet (#96 remains deferred).
- Base slab degenerate warning (#93 remains deferred).
- Worker offload for true UI responsiveness (#77 remains deferred; double-RAF is the interim fix).
- Adaptive edgeLength (#76), SKILL sync (#78), resin viewTransform (#81), E+F perf claw-back (#86).

## Effort

~0.5-1 day. Single PR.

## Agent

`agent:geometry` (Fix 3 + 4) + `agent:frontend` (Fix 1 + 2). Single agent handles all four with worktree isolation.

## Files — expected diff

**Modify:**
- `src/renderer/ui/generateOrchestrator.ts` — banner paint + double RAF (Fix 1).
- `src/renderer/ui/generateStatus.ts` — possibly add "starting" phase.
- `src/renderer/i18n/en.json` — `status.phase.starting` key.
- `src/renderer/index.html` — check banner CSS has `pointer-events: none` (Fix 2).
- `src/renderer/scene/layFlatController.ts` — diagnostic logging + potential fixes (Fix 2).
- `src/geometry/generateMold.ts` — diagnose slab regression (Fix 3).
- `src/geometry/brim.ts` — bump bondOverlap to 2× (Fix 4 option A).
- Tests + goldens as needed.

**Transient:**
- `.github/workflows/update-linux-goldens.yml`.
