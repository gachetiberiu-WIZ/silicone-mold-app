## Goal

Ship the last two waves of the mold redesign together: Wave E (radial slicing of the print shell into 2/3/4 pieces) + Wave F (brim flanges on each shell piece for clamp-together assembly). After this PR, the handcrafted-mold feature set is complete — master + silicone + sliced+brimmed shell + base slab.

Bundled because Wave E alone ships an unassemblable mold (no way to clamp the pieces closed) — churn to split.

## Wave E — radial shell slicing

### Algorithm
For each cut angle θ in `SIDE_CUT_ANGLES[sideCount]` (from `src/geometry/sideAngles.ts`):
- Build a vertical half-space plane through the Y axis with outward normal `(cos θ, 0, sin θ)` rotated to CCW-from-+X (consistent with the file's doc comment).
- The plane passes through the world-space origin of the master's XZ center (NOT necessarily the world origin — use `masterBboxWorld.center.xz`).

For each piece `i ∈ [0, sideCount)`:
- The piece is the intersection of the `printShell` Manifold with two half-spaces: one bounding at `SIDE_CUT_ANGLES[sideCount][i]` and one at `SIDE_CUT_ANGLES[sideCount][(i+1) % sideCount]`.
- Use `Manifold.trimByPlane(normal, originOffset)` twice per piece. Each trim keeps the side of the plane where `dot(point, normal) ≤ originOffset`.
- Each piece is a standalone watertight Manifold — assert `isManifold() && genus() === 0 && !isEmpty()` for every piece.

### Input / output change
`generateMold.ts`:
- Replace `printShell: Manifold` with `shellPieces: Manifold[]` of length `sideCount`.
- Drop `printShellVolume_mm3` scalar; add `shellPiecesVolume_mm3: number[]` (one per piece).
- Also keep `totalShellVolume_mm3: number` for the topbar readout (sum of pieces).

### Tests
- Unit: for sideCount ∈ {2, 3, 4}, assert length matches, each piece watertight, union of pieces' AABBs equals the original shell's AABB (within `edgeLength` tolerance), total volume equals original shell volume (within 1e-3 rel — trimming has rounding losses).
- Generate×3 leak-check disposes every piece.

## Wave F — brim flanges

### Algorithm
For each shell piece `p_i`:
- It has 2 cut faces — one at each of its bounding cut planes (piece `i` is bounded by angles `SIDE_CUT_ANGLES[sideCount][i]` and `SIDE_CUT_ANGLES[sideCount][(i+1) % sideCount]`).
  - Exception: sideCount=2 has only ONE cut plane total (angles 90 and 270 are the SAME plane, just opposite normals), so each piece has 1 cut face.
- For each cut face, construct a brim:
  - **Orientation:** the cut plane is vertical (contains Y axis). Its normal points outward from the shell piece's side (away from the next piece).
  - **Extent:** the brim is a flat slab ON THE SHELL PIECE'S SIDE of the plane, extending OUTWARD radially from the master's centerline by `brimWidth_mm` beyond the shell's outer surface, vertically spanning the shell's Y range minus a small margin at top/bottom (say 2 mm margin so the brim doesn't poke out the open pour edge).
  - **Thickness:** `brimThickness_mm` perpendicular to the cut plane, measured INTO the piece (i.e., the brim sits flush against the cut plane, no gap).
- Union the brim with the shell piece.

### Construction sketch (agent's call on exact path)
Option A (recommended):
1. Build a box primitive of size `(brimWidth + shell_outer_radius + slop) × shell_height × brimThickness` centered so it's aligned with the cut plane.
2. Rotate to match the cut-plane's normal.
3. Translate to the cut plane's origin offset (which should be 0 if the cut planes pass through the master's XZ center).
4. Boolean-intersect this box with a HALF-SPACE on the side of the cut plane that belongs to the shell piece.
5. Boolean-subtract the (transformed) master + silicone so the brim doesn't poke into the cavity (shouldn't, but belt+braces).
6. Boolean-union with the shell piece.

Option B: extract the cut-face outline from the shell (via `trimByPlane` on a slab), offset outward, extrude perpendicular. Cleaner but more work.

Pick whichever the agent finds easier to get watertight + perf-acceptable. Document the choice in a top-of-file comment.

### Parameters (new)
```ts
brimWidth_mm: number;       // default 10, range 5-20, step 0.5
brimThickness_mm: number;   // default 3, range 2-8, step 0.5
```

Add to `src/renderer/state/parameters.ts` `MoldParameters` + `NUMERIC_CONSTRAINTS` + `DEFAULT_PARAMETERS`. Add to parameters panel (two new rows). i18n keys `parameters.brimWidth`, `parameters.brimThickness`.

### Brim-to-brim interface
Flat abutment. When two adjacent shell pieces close, their brims meet face-to-face at the cut plane (each contributes `brimThickness_mm`, total interface thickness `2 × brimThickness_mm`). User clamps externally — no alignment features on the brim in v1 (registration keys / pin-holes / dovetails deferred).

### Tests
- Unit: for each sideCount, every shell piece is still watertight after brim union. Brim AABB contained within `master_xz_center ± (shell_outer_radius + brimWidth + slop)` horizontally. Brim Y-span inside shell Y-span with 2 mm margins.
- Volume: each piece's `shellPiecesVolume_mm3[i]` grows by approximately `brim_area × brimThickness × brim_count_for_this_piece` after brim addition. Loose tolerance — just sanity.

## Scene

`src/renderer/scene/printableParts.ts`:
- Current signature: `setPrintableParts(scene, { printShell, basePart })`.
- New signature: `setPrintableParts(scene, { shellPieces: Manifold[], basePart: Manifold })`.
- Mount N+1 meshes in the `printableParts` group (N shell pieces + 1 base slab). Shared material OK; distinct tags (`shell-piece-0`, `shell-piece-1`, ..., `base-slab-mesh`).
- **Exploded view:** each shell piece translates RADIALLY outward from the master's XZ center by `max(30, 0.3 × bboxHorizRadius)`. No +Y lift (the pieces are side-by-side, not stacked). Base slab still lifts `-Y`.
- `Show printable parts` toggle hides all meshes.
- `hasPrintableParts()` returns true if any piece or basePart is present.

## Topbar

- Readouts: Master / Silicone / Print shell (total) / Base slab / Resin. Total shell volume = sum of pieces (reuse existing "Print shell" label, value from `totalShellVolume_mm3`).
- Keep "Print shell" label even though it's now plural — users don't need the piece count exposed here.

## Orchestrator

`src/renderer/ui/generateOrchestrator.ts`:
- Dispose every piece + base slab on happy / stale / error paths.
- Hand off `{ shellPieces, basePart }` to scene.

## Visual regression

One-shot goldens workflow pattern (same as PRs #70/#73/#75/#80/#83):
- Add `.github/workflows/update-linux-goldens.yml` guarded by `if: github.ref == 'refs/heads/feat/geometry-slice-brim'`.
- It runs `pnpm test:visual --update-snapshots` on ubuntu + commits goldens back.
- **Remove in final commit.** Verify `git ls-tree origin/feat/geometry-slice-brim .github/workflows/` = `ci.yml` only.

Likely affected goldens:
- `sidebar-parameters-*` (two new rows).
- `printable-parts-exploded` (radial explosion, not axial anymore).
- `topbar-all-volumes` (no, volume math is internal).
- `scene-with-mini-figurine` (if the viewport is screenshotted post-Generate — check).

## Acceptance criteria

- [ ] `MoldGenerationResult.shellPieces.length === sideCount` for sideCount ∈ {2, 3, 4}.
- [ ] Every shell piece: watertight (`isManifold` + `genus === 0`), non-empty, brim attached on correct cut face(s).
- [ ] `totalShellVolume_mm3` within 1e-3 rel of pre-slice shell volume + sum of brim analytic volumes.
- [ ] `basePart` unchanged — slab stays a single piece across all sideCount values.
- [ ] Scene renders N shell pieces + 1 base slab + silicone + master. Exploded view moves each shell piece radially outward.
- [ ] `Show printable parts` toggle hides all printable meshes.
- [ ] Two new parameters in the sidebar panel with correct defaults + bounds + i18n labels.
- [ ] `resinVolume_mm3 === masterVolume_mm3` within 1e-9 (identity transform preserved from prior PRs).
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e && pnpm test:visual` all green.
- [ ] Final HEAD `.github/workflows/` = `ci.yml` only.
- [ ] Mini-figurine full pipeline under 8 s on CI (slicing + brim unions cheap vs. the existing dominant levelSet cost).

## Out of scope

- Registration keys / pin holes / dovetails on the brim interface (flat abutment only in v1).
- Auto-screw-hole generation in the brims.
- Brim thickness mismatch between adjacent pieces (assume uniform).
- Optimizing radial cuts for minimum-part-count based on master silhouette.
- Sprue channels, vent channels, draft angle application (all already out of v1 scope).

## Effort

~1.5 days. Single bundled PR.

## Agent

`agent:geometry` — worktree isolation. Skills: `mold-generator`, `mesh-operations`, `three-js-viewer`, `testing-3d`, `github-workflow`.

## Files — expected diff

**Create:**
- `src/geometry/shellSlicer.ts` — radial slicer (Wave E).
- `src/geometry/brim.ts` — brim flange builder (Wave F).
- `tests/geometry/shellSlicer.test.ts`.
- `tests/geometry/brim.test.ts`.

**Modify:**
- `src/geometry/generateMold.ts` — call shellSlicer + brim after printShell construction; return `shellPieces: Manifold[]` instead of `printShell: Manifold`.
- `src/geometry/index.ts` — new exports.
- `src/renderer/state/parameters.ts` — two new fields.
- `src/renderer/ui/parameters/panel.ts` — two new rows.
- `src/renderer/scene/printableParts.ts` — N+1 mesh contract + radial exploded view.
- `src/renderer/ui/generateOrchestrator.ts` — array disposal.
- `src/renderer/i18n/en.json` — new keys.
- `tests/geometry/generateMold.test.ts` — update for new shape.
- `tests/renderer/scene/printableParts.test.ts` — N+1 mesh contract.
- `tests/renderer/ui/parameters/panel.test.ts` — two new rows.

**Transient (add + remove in same PR):**
- `.github/workflows/update-linux-goldens.yml`.

## Follow-ups (not this PR)

- #76 adaptive edgeLength for large masters.
- #77 worker offload.
- #78 SKILL.md sync.
- #81 resin volume viewTransform.
- Registration keys on brim interface (if user wants post-dogfood).
