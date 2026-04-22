## Goal

Add a printed base slab that sits under the print shell, with a **step-pocket** interlock so the shell drops onto it with positive alignment (like a lid over a box). No 45° chamfer — chamfering an arbitrary master footprint isn't tractable with manifold-3d's CrossSection primitives. The step-pocket matches the user's mental model ("shell sits on slab, plug locates it") and works on any master shape.

## Geometry spec

### Slab body
- **Outer footprint**: master XZ footprint offset outward by `siliconeThickness_mm + printShellThickness_mm + baseSlabOverhang_mm` (new parameter, default 5, range 2-10 mm).
- **Extrude downward**: from `master.min.y` to `master.min.y - baseSlabThickness_mm` (new parameter, default 8, range 5-15 mm).
- **Bottom**: flat (prints on the bed).

### Raised plug (the "step" that locates the shell)
- **Plug footprint**: master XZ footprint offset outward by `siliconeThickness_mm - tolerance_mm` where `tolerance_mm = 0.2` (hardcoded). This is the shell's INNER cavity outer edge, minus a 0.2 mm horizontal clearance so the shell drops on without binding.
- **Extrude upward**: from `master.min.y` to `master.min.y + 2 mm` (plug height hardcoded 2 mm per user spec "extends down a bit also").
- **Union with slab body**: single watertight Manifold.

### Shell bottom adjustment
The existing `printShell` is currently trimmed at `master.min.y` (bottom flush). With the 2 mm plug: move the shell's bottom trim DOWN to `master.min.y - 2 mm` so the shell's bottom edge wraps the plug instead of floating above it. Cleaner visual + better mechanical interlock.

## Coordinate-system gotcha (important)

`Manifold.slice(height)` slices parallel to the XY plane at `Z = height`. Our pipeline is Y-up (three.js). To extract the horizontal master footprint at `master.min.y`, you must rotate the Manifold first so our+Y becomes manifold+Z:

```ts
const masterForSlice = transformedMaster.rotate([-90, 0, 0]);  // Y→Z
const cs = masterForSlice.slice(masterMin.y);                  // now slicing horizontally
masterForSlice.delete();
// ...offset, extrude...
// After extruding, rotate the resulting Manifold back:
const slabWorld = slabInSliceFrame.rotate([90, 0, 0]);         // Z→Y
slabInSliceFrame.delete();
```

`CrossSection.extrude(h)` extrudes along manifold+Z; after rotating back, that height direction becomes our+Y (up). Correct.

## Parameters

Add to `src/renderer/state/parameters.ts`:

```ts
baseSlabThickness_mm: number;   // default 8, range 5-15, step 0.5
baseSlabOverhang_mm: number;    // default 5, range 2-10, step 0.5
```

Panel rows in `src/renderer/ui/parameters/panel.ts`. i18n keys `parameters.baseSlabThickness` + `parameters.baseSlabOverhang`.

## Result shape

Add to `MoldGenerationResult` in `src/geometry/generateMold.ts`:

```ts
basePart: Manifold;
baseSlabVolume_mm3: number;
```

Disposal: `generateOrchestrator.ts` disposes `basePart` in happy / stale / error paths alongside `silicone` and `printShell`.

## Scene

`src/renderer/scene/printableParts.ts`:
- Signature: `setPrintableParts(scene, { printShell: Manifold; basePart: Manifold })`.
- Two meshes in the `printableParts` group. Shared material allowed (same print-grey), different tags.
- Exploded view: shell lifts `+Y` by current offset. Slab lifts `-Y` by `max(30, 0.2 * bboxY)` so it drops below the master to reveal the interface. Symmetric visual.
- Toggle `Show printable parts` hides BOTH.

## Topbar

`src/renderer/ui/topbar.ts`:
- New readout `Base slab: <vol> mm³`. Sequence: Master / Silicone / Print shell / **Base slab** / Resin.
- i18n key `topbar.volumeBaseSlab` "Base slab".
- Stale-class wiring on dimension or parameter edits.

## Tests

- `tests/geometry/generateMold.test.ts`:
  - Update `disposeAll` to delete `basePart`.
  - Assert `basePart.isManifold()`, `basePart.genus() === 0`, non-empty.
  - Assert AABB: bounds contain `master XZ footprint + overhang on XZ` and span `[master.min.y - thickness, master.min.y + 2 mm]` on Y.
  - Assert `baseSlabVolume_mm3 > 0` and roughly equals `(flat_footprint_area × thickness) + (plug_footprint_area × 2)` within 10% on unit-cube fixture.
  - Generate×3 leak-check updated for the new Manifold.
- `tests/renderer/scene/printableParts.test.ts`: two-mesh contract; toggle flips both.
- `tests/renderer/ui/parameters/panel.test.ts`: two new rows rendered with correct defaults + bounds.
- `tests/visual/*`: regen what changes. Likely affected: `sidebar-parameters-*`, `printable-parts-exploded`, maybe `topbar-all-volumes`. Use one-shot goldens workflow pattern (add on branch, remove in final commit).
- `tests/e2e/generate-wire-up.spec.ts` (or similar): assert 2 printable meshes in the `printableParts` group + 1 silicone mesh in the silicone group.

## Acceptance criteria

- [ ] `MoldGenerationResult` includes `basePart: Manifold` and `baseSlabVolume_mm3: number`.
- [ ] `basePart`: watertight, non-empty, bounds correct per above.
- [ ] Outer slab footprint = shell-outer-footprint + `baseSlabOverhang_mm` outward. Visually verify overhang is uniform.
- [ ] Plug top at `master.min.y + 2 mm` ± `edgeLength`; plug horizontal clearance 0.2 mm inside shell's inner cavity.
- [ ] Shell's bottom trim moved to `master.min.y - 2 mm` so shell wraps the plug.
- [ ] Resin readout still matches master volume (1e-9 rel) on identity transform. (Dimensions-panel scale bug #81 is separate.)
- [ ] Scene shows slab + shell + silicone + master, all correctly aligned.
- [ ] Exploded view lifts shell +Y, slab -Y, master stays put. Silicone stays at its own offset.
- [ ] "Show printable parts" hides both shell + slab together.
- [ ] Topbar shows Base slab volume, staled on dimension/parameter edits.
- [ ] Two new parameters in the right-sidebar panel with correct defaults + bounds.
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e && pnpm test:visual` all green.
- [ ] Final branch HEAD: `.github/workflows/` = `ci.yml` only (one-shot goldens workflow removed in last commit).
- [ ] Perf: mini-figurine full pipeline stays under 8 s on CI (slab is cheap — 2D offset + extrude, no BVH).

## Out of scope

- Radial slicing of the slab (Wave E is shell-only — slab stays a single piece).
- Registration keys, dovetails, or any additional interlock features (brims in Wave F).
- Automatic sizing of slab for objects that don't fit the printer bed.
- Slab rotation/orientation optimization for print.

## Effort

~1 day. Single PR.

## Agent

`agent:geometry` — worktree isolation. Skills: `mold-generator`, `mesh-operations`, `testing-3d`, `github-workflow`.

## Files — expected diff

**Create:**
- `src/geometry/baseSlab.ts` — slab + plug geometry helper.
- `tests/geometry/baseSlab.test.ts` — unit tests.

**Modify:**
- `src/geometry/generateMold.ts` — call `buildBaseSlab`, return `basePart`; adjust shell bottom trim to `master.min.y - 2 mm`.
- `src/geometry/index.ts` — export `buildBaseSlab` + types.
- `src/renderer/state/parameters.ts` — two new fields.
- `src/renderer/ui/parameters/panel.ts` — two new rows.
- `src/renderer/ui/topbar.ts` — new Base slab readout.
- `src/renderer/ui/generateOrchestrator.ts` — `basePart` disposal + handoff.
- `src/renderer/scene/printableParts.ts` — two-mesh contract.
- `src/renderer/i18n/en.json` — new keys.
- `tests/geometry/generateMold.test.ts` — updated.
- `tests/renderer/scene/printableParts.test.ts` — two-mesh contract.
- `tests/renderer/ui/parameters/panel.test.ts` — two new rows.

**Transient (add + remove in same PR):**
- `.github/workflows/update-linux-goldens.yml`.

## Follow-ups (do not do this PR)

- Wave E (radial slicing of shell into 2/3/4 pieces).
- Wave F (brims on shell pieces).
- #81 (resin volume doesn't reflect viewTransform scale).
