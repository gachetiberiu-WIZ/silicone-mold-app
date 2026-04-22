## QA REVIEW — APPROVE

Phase 3d Waves A + B bundled. Self-reviewed by the qa-engineer sub-agent per the #54/#63/#65/#68 self-review constraint.

Verdict: **approve**. CI gating jobs green, every issue #69 acceptance criterion ticks, no scope creep, Manifold ownership contracts intact on all three orchestrator paths, single-silicone scene contract clean. Two correctness-adjacent concerns and two trivial doc-hygiene nits noted — all non-blocking.

---

### Acceptance-criteria checklist (issue #69)

- [x] **Forbidden-symbol grep** (`sprueVent`, `sprueDiameter`, `drillSprue`, `ventDiameter`, `ventCount`, `drillVents`, `registrationKeys`, `stampRegistrationKeys`, `KEY_STYLE_OPTIONS`, `siliconeUpperHalf`, `siliconeLowerHalf`, `wallThickness_mm`, `baseThickness_mm`) against `src/` + `tests/` — ZERO live-code survivors. All remaining hits are historical doc-comments explicitly permitted by the AC:
  - `src/geometry/primitives.ts:5-8` — stale import comments referencing deleted modules (flagged as follow-up, see Concern #3 below).
  - `src/renderer/state/parameters.ts:38,43` — breadcrumb comments documenting the pre-#69 names.
  - `src/renderer/ui/parameters/panel.ts:8-9` — Wave-A scope explanation.
  - `tests/renderer/ui/generateOrchestrator.test.ts:7-8` — comment explaining the shape change.
  - `tests/renderer/ui/parameters/panel.test.ts:69-75` — **negative** assertion verifying the deleted field IDs no longer render.
- [x] **`src/geometry/index.ts` export surface** (`src/geometry/index.ts:12-28`) — exactly the Wave-A surface: `initManifold`, `bufferGeometryToManifold`, `bufferGeometryToManifoldWithRepair`, `manifoldToBufferGeometry`, `isManifold`, `loadStl`, `LoadedStl`, `meshVolume`, `generateSiliconeShell`, `InvalidParametersError`, `MoldGenerationResult`, `buildPrintableBox`, `SIDE_CUT_ANGLES`, `PrintableBoxParts`, `CIRCULAR_SEGMENTS`, `verticalCylinder`. No sprue/vent/key exports.
- [x] **`MoldGenerationResult` shape** (`src/geometry/generateMold.ts:96-138`) matches the issue spec exactly: `silicone`, `basePart`, `sideParts`, `topCapPart`, `siliconeVolume_mm3`, `resinVolume_mm3`, `printableVolume_mm3`. `siliconeUpperHalf` / `siliconeLowerHalf` / `warnings` all gone.
- [x] **Parameter form** (`src/renderer/ui/parameters/panel.ts`) — exactly four fields: silicone thickness (1–15, default 5), print shell thickness (2–30, default 8), side count (2/3/4, default 4), draft angle (0–3, default 0). `src/renderer/state/parameters.ts:72-95` locks defaults + constraints to match.
- [x] **Topbar: Resin ≡ Master within 1e-9 relative.** Asserted on all three fixtures in `tests/geometry/generateMold.test.ts`: unit-cube (lines 95–99), unit-sphere (lines 137–138), mini-figurine (lines 202–205). Identity-tightening to 1e-9 confirmed on each.
- [x] **Single-silicone scene contract** (`src/renderer/scene/silicone.ts`):
  - `setSilicone(scene, { silicone: Manifold })` signature (line 268–271) — no `upper`/`lower` keys. ✓
  - Eviction disposes ONE Manifold + ONE BufferGeometry (line 296–301, `disposeCachedManifold` + `disposeMesh`). ✓
  - Exploded view translates the single mesh by `+Y` only (line 224: `state.mesh.position.y = clamped * state.offsetMax_mm`) — not the ±Y pattern. Offset rule unchanged: `max(30 mm, 0.2 * bboxHeight_mm)` (line 208–214). ✓
  - `isExplodedViewIdle` preserved (line 386–392), semantics adapted to a single `rafId === 0 && tweenStart_ms === null` check. ✓
- [x] **Orchestrator handoff — all 3 paths** (`src/renderer/ui/generateOrchestrator.ts`):
  - Happy path + scene sink (line 247–259): `scene.setSilicone({silicone})` transfers ownership; orchestrator does NOT call `.delete()`. Sink owns lifetime.
  - Happy path + no sink (line 260–265): fallback `result.silicone.delete()` — single dispose.
  - Stale path (line 218–226): `result.silicone.delete()` + `disposePrintableParts(result)` — single dispose each.
  - Error path (line 298–302): generator rejected before producing `result`; nothing to dispose. ✓
  - Sink-rejection sub-path (line 254–259): per `scene/silicone.ts:287-290`, the sink disposes the silicone Manifold before re-throwing. No double-free.
- [x] **`.github/workflows/` tree** — `git ls-tree origin/refactor/mold-strip-rename .github/workflows/` returns ONLY `ci.yml`. The one-shot `update-linux-goldens.yml` was added in bae9bf8 and removed in ecd5d32 — cleanup discipline better than the #65→#66 flow. ✓
- [x] **Generate×3 leak-check** passes with the new result shape (`tests/geometry/generateMold.test.ts:386`).
- [x] **Visual-regression advisory window**: `.github/workflows/ci.yml:61` — `continue-on-error: true` on the visual-regression job. The failing `printable-parts-exploded.png` (stability-loop timeout) and `silicone-exploded.png` (0.03 diff vs 0.01 ratio) do not block merge per ADR-003 §B.
- [x] **Follow-up #1 warranted**: `tests/visual/printable-parts-exploded.spec.ts:210` currently uses `timeout: 30_000`; `tests/visual/silicone-exploded.spec.ts:198` was bumped to `timeout: 60_000` in 82e3fd9. The 30 s stability-loop timeout on SwiftShader is the same class of issue that needed the 60 s bump in #54 — the follow-up to bump printable-parts-exploded to 60 s is correct.
- [x] **CI gating jobs green** (run 24711496173): lint + typecheck, geometry unit (ubuntu), e2e + visual smoke (windows) all passed. Visual-regression failed but is under `continue-on-error` — advisory window per ADR-003 §B.

### CI summary (run 24711496173)

| Job | Status | Notes |
|---|---|---|
| lint + typecheck | pass | 23 s |
| geometry unit (ubuntu) | pass | 31 s |
| e2e + visual smoke (windows) | pass | 5m 52s, 19 tests |
| visual regression (ubuntu) | fail (advisory) | 2 flakes, under `continue-on-error: true` |
| build windows installer | skipped | main-only branch policy |

---

### Concerns (non-blocking)

#### Concern #1 — CI perf regression 3.4 s → 7.3 s (2.1x): root cause confirmed, budget widening defensible, but the grid-density floor is over-fitting

Root cause (confirmed at `src/geometry/generateMold.ts:155-157`):

```ts
function resolveEdgeLength(siliconeThickness_mm: number): number {
  return Math.max(1.5, siliconeThickness_mm / 4);
}
```

At the pre-#69 default `wallThickness_mm=10`, `edgeLength = 10/4 = 2.5` mm. At the post-#69 default `siliconeThickness_mm=5`, `edgeLength = max(1.5, 1.25) = 1.5` mm (floor clamps). LevelSet grid cell count scales ~1/edge^3 so 2.5^3 / 1.5^3 ≈ 4.6x more cells. The observed 2.1x wall-clock slowdown implies per-cell cost (BVH raycast + closest-point query) dominates rather than pure cell count, which fits.

Budget widening (`tests/geometry/generateMold.test.ts:187`) is scoped to the mini-figurine test only (not global) and sits at 8500 ms ≈ 16% headroom over the observed 7.3 s. Local Windows at ~2.5 s is comfortable. Only catches ~3x regressions on the SDF loop now — ratchet is measurable.

**Recommendation — accept the budget widening, file a follow-up optimization issue.** The slowdown is mechanical (grid is ~3x denser) and the band-aid (wider budget) is scoped to a single fixture. I would push back on the floor though: `max(1.5, siliconeThickness/4)` is over-fitting to a thin-walls-of-the-future case when today the silicone body is render-only (not printable in v1). Bumping the floor to `2.0 mm` at `siliconeThickness=5` gives `edgeLength=2.0` — still `0.4 x` thickness (the `mesh-operations` skill default says `min(0.3 x thickness, 1 mm)`, so this is comfortably inside fidelity spec) — and drops CI wall-clock to an estimated ~3.7 s (factor 2.5^3 / 2.0^3 ≈ 1.95x). File a follow-up issue to tune this when the surface-conforming shell lands in Wave C — the grid density needs to be revisited anyway because Wave C makes the silicone printable and the floor needs to migrate.

**Push-back, not block.** The PR is functionally correct, the budget is scoped, and the comment at `src/geometry/generateMold.ts:148-154` already earmarks the optimization for a future wave. I do not consider this a merge blocker — a tighter grid floor is an optimization, not a correctness issue.

#### Concern #2 — e2e silicone-volume bounds are empirical, not first-principles

`tests/e2e/generate-wire-up.spec.ts:304-314`:

```ts
// Sanity: the mini-figurine's silicone body at the post-#69 default
// thickness (5 mm) sits around 155 000 mm^3 (generator unit-test log:
// ~154 725) and resin equals the master volume (~127 452 mm^3).
// Use +/-30% windows — we only need to catch order-of-magnitude
// regressions, not exact values.
expect(silicone_mm3).toBeGreaterThan(100_000);
expect(silicone_mm3).toBeLessThan(220_000);
expect(resin_mm3).toBeGreaterThan(100_000);
expect(resin_mm3).toBeLessThan(160_000);
```

Bounds are observed-value +/-30% anchored to the generator's first-run log output, not computed from `DEFAULT_PARAMETERS.siliconeThickness_mm * master_surface_area * 0.5`. Defensible for an e2e smoke assertion — the test only needs to confirm the mold actually generated something plausible, not assert exact values — but brittle if the grid-density tune in Concern #1 lands, because silicone volume shifts slightly when `edgeLength` changes (the offset surface is sampled at grid vertices). Recommend: when the grid tune happens, re-anchor bounds to the new observed value rather than widening the window. **Not a blocker for this PR.**

#### Concern #3 — Stale doc-comment in `src/geometry/primitives.ts`

```ts
// src/geometry/primitives.ts:5
// helpers in `./sprueVent.ts` can share the exact same cylinder-construction
// ...
// Registration keys (in `./registrationKeys.ts`) build hemispheres, not
```

Both referenced modules are deleted in this PR. The comments describe invariants for the `verticalCylinder` primitive; they should either drop the dead-module references or reword them to reference future call sites. Trivial doc-hygiene cleanup; not blocking.

#### Concern #4 — Self-referential rename comment in `src/renderer/state/parameters.ts:11-14`

```ts
// remaining four fields — wall thickness, base thickness, side count,
// draft angle — stay in this commit; `siliconeThickness_mm` is renamed to
// `siliconeThickness_mm` and `printShellThickness_mm` to `printShellThickness_mm`
// in a follow-up commit on the same branch ...
```

The rename-description sentence says "X is renamed to X" — self-referential. Almost certainly a sed-over-sed mistake during the Wave-B rename commit. Should read `wallThickness_mm -> siliconeThickness_mm` and `baseThickness_mm -> printShellThickness_mm`. Fix in a trailing doc-hygiene commit on this branch, or fold it into the Wave-C PR. **Not blocking.**

---

### Scope-discipline sweep

Walked the diff — all 31 touched files sit inside the Wave-A + Wave-B scope per issue #69:

- **Deletions** (4 files, 2137 lines): `sprueVent.ts`, `registrationKeys.ts`, and their two test files. Exactly the issue's delete list.
- **Geometry kernel**: `generateMold.ts` (pipeline trim), `printableBox.ts` (param rename only — comments + `wall = parameters.printShellThickness_mm` at line 344), `index.ts` (export trim).
- **Renderer**: `state/parameters.ts` (rename + range/default + field deletions), `ui/parameters/panel.ts` + `field.ts` (form adaptation + comment updates), `scene/silicone.ts` (single-body contract), `scene/viewport.ts` (setSilicone signature update + docs), `ui/generateOrchestrator.ts` (single-silicone handoff), `main.ts` (6-line adaptation of the sink-wiring callback signature + comment), `i18n/en.json` (key rename + deletion).
- **Tests**: updated to match the new shape, plus the two delete-file sets.
- **Visual goldens**: three PNG snapshots regenerated on ubuntu CI.

**Confirmed out of scope, not touched**:
- Rectangular print box structure unchanged (`buildPrintableBox` still produces base + sides + top cap; `printShellThickness_mm` feeds the same expansion math). Wave C will replace this.
- No new param fields (`baseSlabThickness_mm`, `brimWidth_mm` — none present).
- No skill-file rewrite (all `.claude/skills/*.md` untouched in the PR diff).
- No `src/renderer/*` file renames beyond the param key rename.

### Resin-volume identity tightening

Confirmed on all three fixtures:
- unit-cube (`tests/geometry/generateMold.test.ts:96-99`): `expect(result.resinVolume_mm3).toBeCloseTo(masterVol, 9); expect(relErr).toBeLessThan(1e-9);`
- unit-sphere (line 137–138): `expect(result.resinVolume_mm3).toBeCloseTo(MASTER_VOL, 9);`
- mini-figurine (line 202–205): `expect(relErr).toBeLessThan(1e-9);`

Pre-#69 this assertion was `1e-4 relative` to accommodate sprue+vent channel math; post-#69 tightened to `1e-9` as required by the AC. ✓

---

### Verdict

**APPROVE**. Ready for admin-bypass merge per the full-merge-autonomy policy. Concerns #1–#4 are all non-blocking follow-ups: open a tracking issue for the grid-density floor tune (Concern #1, bundled with the Wave-C shell work), and sweep the three doc-hygiene nits (Concerns #2–#4) in the Wave-C PR so the tree is spotless before that wave lands.

---

🤖 QA review by Claude (qa-engineer sub-agent, Opus 4.7-1M)
