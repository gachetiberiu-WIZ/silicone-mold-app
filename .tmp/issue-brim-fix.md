## Symptom

Dogfood 2026-04-22 on main (post-PR #88):

1. **Brims intersect each other** at the center of the mold. Adjacent cut planes meet at the Y axis; each brim extends radially all the way to the center, so all N brims overlap in a thin column at the center (thickness² cross-section).
2. **Brims intrude into the silicone cavity.** The brim's inner portion is inside the shell's outer surface → pokes into the silicone blob where it shouldn't exist.

Both visible in annotated screenshots: brim material inside the translucent silicone, and brim-on-brim hatching at the axis.

## Root cause

`src/geometry/brim.ts` builds the brim box with radial extent `shell_outer_radius + brimWidth + slop` and its inner edge near the master's XZ center. That makes the brim:
- Cross through the silicone (inner portion is inside the shell's outer surface).
- Cross through the Y-axis center (where all N cut planes meet), overlapping with every other piece's brims.

The box is unioned with the pre-sliced piece. Union doesn't clip — so the extra inner material stays.

## Fix

Two complementary changes, both in `src/geometry/brim.ts`:

### A. Make the brim box NARROW (radially)

Instead of spanning from center to outer+brimWidth, span from `(outerRadius - bondOverlap)` to `(outerRadius + brimWidth)`:

- `bondOverlap_mm = printShellThickness_mm` (passed via args). Small inward overlap so the brim bonds mechanically with the shell's outer surface.
- Brim box `widthRadial = bondOverlap_mm + brimWidth_mm`. Default: `8 + 10 = 18 mm` — way less than the current `outerRadius + brimWidth + slop` ≈ 50 mm.
- Box is centered (pre-rotation) at origin. After rotation + translation, its CENTER sits at `xzCenter + radial × (outerRadius + brimWidth/2 - bondOverlap/2)`.

### B. Subtract `siliconeOuter` from the brim box before unioning

Even with (A), the brim's inner edge may dip INTO the silicone for non-convex masters. Belt-and-braces: after the brim box is built + positioned, `brimBox = brimBox.difference(siliconeOuter)` to carve away any material that falls inside the silicone/shell cavity.

`siliconeOuter` is the silicone-outer-surface Manifold (= shell's inner cavity boundary), already available inside `generateMold.ts`. Pass it through to `addBrim` as a new arg.

After (A) + (B), the brim:
- Starts at the shell's outer surface (with a `printShellThickness` bond overlap).
- Extends outward by `brimWidth`.
- Never crosses into the silicone cavity.
- Never reaches the Y-axis (so adjacent brims don't intersect each other).

### Implementation shape

```ts
export function addBrim(
  toplevel: ManifoldToplevel,
  piece: Manifold,
  pieceIndex: number,
  sideCount: 2 | 3 | 4,
  shellBboxWorld: Bbox,
  xzCenter: { x: number; z: number },
  brimWidth_mm: number,
  brimThickness_mm: number,
  siliconeOuter: Manifold,             // NEW — caller-owned, NOT deleted here
  printShellThickness_mm: number,      // NEW — bond overlap
): Manifold;
```

Caller (`generateMold.ts`) already has `siliconeOuter` before the subtract-master step; it needs to be RETAINED until after brim construction instead of being deleted early. If `generateMold.ts` already deletes `siliconeOuter` pre-slice, defer that delete to AFTER `addBrim` runs for every piece.

## Tests (update existing)

- `tests/geometry/brim.test.ts`:
  - New assertion: `brim.min(radial) >= outerRadius - bondOverlap - edgeLength` (brim doesn't extend past bond overlap inward).
  - New assertion: `brim ∩ siliconeOuter` has zero volume (no silicone-cavity intrusion).
  - For sideCount=3 and 4: assert that piece 0's brim and piece 1's brim don't share any volume. `piece0.difference(piece1).volume() === piece0.volume()` (within 1e-4 rel).
- `tests/geometry/generateMold.test.ts`: if the volume bands get tighter because the brim is now smaller, adjust.

## Visual regression

Goldens will shift because the brim geometry visibly changes. Use one-shot workflow pattern.

## Acceptance

- [ ] Brim doesn't intersect siliconeOuter volume (tested).
- [ ] Adjacent brims don't share volume at any sideCount (tested).
- [ ] Each brim's radial inner edge sits at `outerRadius - printShellThickness` (bond overlap) ± edgeLength.
- [ ] Each brim's radial outer edge sits at `outerRadius + brimWidth` ± edgeLength.
- [ ] Watertight + genus 0 preserved for every shell piece after brim union.
- [ ] Mini-figurine perf still under 10 s on CI (should be FASTER because smaller boolean work).
- [ ] `.github/workflows/` = `ci.yml` only at final HEAD.
- [ ] Visual goldens regenerated via one-shot workflow.

## Out of scope

- Brim shape beyond flat rectangle (curved brims, filleted edges, etc).
- Screw holes in brims.
- Registration keys on brim interface.
- Any changes to slab, silicone, or slicer.
- #76, #77, #78, #81, #86 follow-ups.
- STL export feature (next-next priority).

## Effort

~0.5 day. Single PR.

## Agent

`agent:geometry` — worktree isolation. Skills: `mold-generator`, `mesh-operations`, `testing-3d`, `github-workflow`.

## Files

**Modify:**
- `src/geometry/brim.ts` — narrow brim + siliconeOuter subtract.
- `src/geometry/generateMold.ts` — defer siliconeOuter deletion past brim construction; pass `printShellThickness_mm` + `siliconeOuter` through.
- `tests/geometry/brim.test.ts` — new assertions.
- `tests/geometry/generateMold.test.ts` — tolerance bands if needed.

**Transient:**
- `.github/workflows/update-linux-goldens.yml` (add + remove in final commit).
