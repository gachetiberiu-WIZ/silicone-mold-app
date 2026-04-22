## Goal

Three dogfood findings from the 2026-04-22 full-v1-stack session. Ship as one polish PR.

## Fix 1 — Shell top is CLOSED (biggest deal)

**Symptom:** After Generate, the print shell has a FLAT CLOSED CAP at the top (annotated in blue on the screenshot). For the mold to actually work, the user needs to pour liquid silicone INTO the shell from above. That requires a THROUGH-HOLE in the shell above the silicone's top, not a cap.

**Root cause:** In `src/geometry/generateMold.ts`:
- Silicone was trimmed at `masterMaxYInWorld` in PR #88 (issue #87 fix 4) — silicone top is now flat at master's top.
- But the SHELL was not changed. Shell is still built as `shellOuter.difference(siliconeOuter)` — where siliconeOuter is the UNTRIMMED original. Then shell is trimmed at `masterMaxY + siliconeThickness + 3 mm`.
- Above `masterMaxY + siliconeThickness` (where siliconeOuter's dome naturally ends), the shell material is full solid (no siliconeOuter to subtract). So the shell trim at `+3mm` only slices through the dome's top, leaving a closed cap where the shell dome extended past siliconeOuter's top.

**Fix:** Subtract a vertical pour channel (prism) from the shell so there's a through-hole from the top:

```ts
// After shell is built and trimmed, but BEFORE slicing into pieces:

// 1. Extract siliconeOuter's XZ silhouette at master.max.y (via rotate + slice).
const rotatedSiliconeOuter = siliconeOuter.rotate([-90, 0, 0]);  // Y→Z
const silhouetteCs = rotatedSiliconeOuter.slice(masterMaxYInWorld);
rotatedSiliconeOuter.delete();

// 2. Extrude the CrossSection upward by (shellTopY - masterMaxY + slop) to guarantee it pokes through the shell's top.
const slop = 2; // mm, safety
const channelHeight = (masterMaxYInWorld + siliconeThickness + 3) - masterMaxYInWorld + slop;
const channelRotated = silhouetteCs.extrude(channelHeight);
silhouetteCs.delete();

// 3. Rotate the channel back to world frame.
const channelInWorld = channelRotated.rotate([90, 0, 0]);  // Z→Y
channelRotated.delete();

// 4. Translate so the channel's base sits at masterMaxY (its top extends past shellTop).
const channelPositioned = channelInWorld.translate([0, masterMaxYInWorld, 0]);
channelInWorld.delete();

// 5. Subtract from shell.
const shellOpen = shell.difference(channelPositioned);
shell.delete();
channelPositioned.delete();
// Continue with shellOpen as the new shell going into slicing + brims.
```

**Acceptance:**
- [ ] After Generate, looking straight down at the shell, the master's top is visible through an OPEN hole in the shell cap (not covered by any shell material).
- [ ] The hole footprint matches silicone's outer silhouette at master.max.y (so the pour well has flat vertical walls from master.max.y up to shell.max.y).
- [ ] Shell is still watertight (`isManifold()` + `genus() === 0`).
- [ ] Shell pieces (post-slice) are still watertight and non-empty.
- [ ] `pnpm test` silicone + shell invariants still pass; adjust volume bounds downward for the new shell-minus-channel volume.
- [ ] Visual golden regenerated: the scene from above now shows a clear pour hole.

## Fix 2 — Brim appears "not unified" with the shell

**Symptom (annotated red):** The brim sticks out of the shell with a visible seam line where they meet. User says "this needs to be unified with the shell" — they expect the brim to blend into the shell's outer surface without a sharp discontinuity.

**Investigation needed first.** Two possible causes:

A. **True geometric disjoint:** brim and shell are NOT unioned into one Manifold. User sees two separate meshes even though they're visually adjacent. If `piece.add(brim)` is being used instead of `piece.union(brim)` somewhere, this bug lands here. Fix: ensure boolean union.

B. **Unavoidable material-change crease:** brim is correctly unioned, but there's a sharp outer angle where the flat brim face meets the curved shell surface. This is a REAL watertight surface, not a bug — but it looks "tacked on". Fix options:
- Increase `bondOverlap` significantly so the brim's inner section sits deep inside the shell material (looks more natural).
- Add a chamfer/fillet at the brim-shell junction (non-trivial in manifold-3d; might require an `offset → union → offset-back` trick on the cross-section).
- Taper the brim so it's thicker at the shell junction, thinner at the outer edge — resembles real flanges.

**Agent action:**
1. Launch the app locally, generate on the mini-figurine, and verify whether the brim IS boolean-unioned with the piece (open DevTools → `window.__testHooks.viewport.scene.children` → inspect the printable-parts group → count meshes per piece; should be 1 mesh per piece INCLUDING brim, not 2).
2. If case A (separate meshes): fix the union call.
3. If case B (crease): increase `bondOverlap` from `printShellThickness` to `printShellThickness × 2` (e.g. 8 → 16 mm at default) and check whether the junction looks softer. If not, propose fillet approach + file a follow-up.

**Acceptance:**
- [ ] `scene.children` at the printable-parts group contains `sideCount + 1` meshes (N shell pieces + 1 base slab) — NOT more.
- [ ] Visually confirm the brim-shell junction looks continuous (no floating-rectangle impression).

## Fix 3 — Face-pick regression ("bugged again")

**Symptom:** After the dimensions panel moved to a LEFT pane (PR #80) and the left-pane was added, face-picking sometimes doesn't commit. Same symptom as pre-#80: hover works, click doesn't always register.

**Investigation needed:**
1. Open DevTools. Enable Place-on-face. Click on a face. Check Console for any pointer events logged at the click position.
2. Likely suspects:
   - Left pane intercepting pointer events that should reach the viewport canvas — check if any `pointerdown` handler on the left pane has `stopPropagation()` or if it captures the pointer.
   - `event.target.closest('canvas')` check in `layFlatController.ts` too strict — may reject events that originated on a canvas-adjacent element.
   - Threshold of 6 px drag might be too tight on high-DPI displays; try 8 or 10.
3. Reproduce by clicking slowly vs quickly. If slow clicks always work, it's timing-related.

**Fix (if none of the above):** enable a debug log in `layFlatController.ts` showing `pointerdown` + `pointerup` fires + the delta. Ship a build with the log, have user reproduce, read the log, identify the cause, then implement the fix.

**Acceptance:**
- [ ] Repeated face-picks on the mini-figurine commit reliably (10/10 tries on bottom face).
- [ ] Dimensions panel interactions don't interfere with face-picking.
- [ ] Existing click-vs-drag gate unit tests still pass.

## Out of scope

- Registration keys on brim interface.
- Screw holes.
- Sprue / vent channels.
- #76, #77, #78, #81, #86, #93 follow-ups.

## Effort

- Fix 1: ~4 hours (geometry change + tests + golden regen).
- Fix 2: ~2 hours (investigation + simple fix; fillet deferred if needed).
- Fix 3: ~2 hours (reproduce + targeted fix; may escalate if deeper issue).

~1 day total. Single PR.

## Agent

`agent:geometry` (Fix 1), `agent:frontend` (Fix 2 + 3 diagnosis). Single agent handles all three with worktree isolation.

## Files (expected)

**Modify:**
- `src/geometry/generateMold.ts` — Fix 1 pour channel.
- `src/geometry/brim.ts` — Fix 2 if bond fix needed.
- `src/renderer/scene/layFlatController.ts` — Fix 3.
- Tests + visual goldens.

**Transient:**
- `.github/workflows/update-linux-goldens.yml`.

## Follow-ups

- Brim fillet at shell junction (if Fix 2 goes with bond-overlap-increase only).
- Degenerate base slab warning (#93, already filed).
