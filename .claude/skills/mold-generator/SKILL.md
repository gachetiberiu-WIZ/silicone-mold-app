---
name: mold-generator
description: Generate the printable mold parts (base + sides + top cap + sprue/vent) from a master STL + parameters. v1 supports two-halves-in-box only.
---

# mold-generator skill

## When to invoke

Tasks that produce the mold parts themselves — base plate, printed sides (2/3/4), top cap, sprue, vent, registration keys, parting surface. Not general mesh ops (that's `mesh-operations`), not viewport rendering (that's `three-js-viewer`).

## Locked scope (do not expand)

**v1 strategy:** two-halves-in-box only. Sleeve+shell, multi-part (3–5), brush-on, cut molds are **out of scope**. If the user asks for them, escalate; do not build speculatively.

See `docs/research/molding-techniques.md` for domain background and `docs/adr/002-geometry-stack.md` for the stack.

## Input contract

```ts
interface MoldInputs {
  master: Manifold;              // master mesh, already loaded + repaired
  wallThickness_mm: number;      // 6–25, default 10
  basePlateThickness_mm: number; // 2–15, default 5
  sideCount: 2 | 3 | 4;          // default 4
  sprueDiameter_mm: number;      // 3–8, default 5
  ventDiameter_mm: number;       // 1–3, default 1.5
  ventCount: number;             // derive from master high-points, min 1
  registrationKeyStyle: 'hemi-asymmetric' | 'cone-asymmetric' | 'keyhole';
  draftAngle_deg: number;        // 0–3, default 0 (silicone stretches)
  partingPlane: { normal: Vec3; originOffset: number }; // user-picked
}
```

## Output contract

```ts
interface MoldParts {
  basePart: BufferGeometry;        // printable
  sideParts: BufferGeometry[];     // length = sideCount
  topCapPart: BufferGeometry;      // printable, has sprue hole + vent holes
  siliconeUpperHalf: Manifold;     // for volume compute + preview only (not printed)
  siliconeLowerHalf: Manifold;     // same
  siliconeVolume_mm3: number;      // = both halves combined
  resinVolume_mm3: number;         // master volume + sprue + vent channels
}
```

## Generation algorithm (high level)

1. **Bound the master**: compute AABB, expand by `wallThickness_mm` on all sides → `shellBox`.
2. **Compute silicone shell**: `shell = levelSet(master, wallThickness_mm)` — outer surface of silicone body.
3. **Subtract master from shell**: `silicone = shell − master`. This is the cavity.
4. **Split by parting plane**: `[siliconeUpperHalf, siliconeLowerHalf] = splitByPlane(silicone, partingPlane)`.
5. **Build containment box**: printed outer box wrapping `shellBox` with `basePlateThickness_mm` wall. Subdivide into base + N sides + top cap.
6. **Generate registration keys**: place along parting line, asymmetric (one larger key or one offset key) to enforce orientation.
7. **Cut sprue + vents**: cylindrical subtractions through top cap into the upper silicone half. Sprue from lowest point of master (in casting orientation); vents from all local high points.
8. **Assert manifoldness** of every output `BufferGeometry` before returning.
9. **Compute volumes**: silicone = sum of both halves; resin = master volume + sprue channel volume + vent channel volume.

## Helpers expected in `src/mold/`

- `computeShell.ts` — master → silicone outer body.
- `partingSurface.ts` — takes master + plane, returns split surfaces. Use `three-mesh-bvh` for preview; `Manifold.splitByPlane` for final.
- `containmentBox.ts` — shellBox → base + N sides + cap.
- `registrationKeys.ts` — parting line + keyStyle → stamps on both halves.
- `sprueVent.ts` — top cap + master orientation → cylindrical channels.
- `volume.ts` — thin wrapper around `manifold.volume()` with resin-specific additions.

## Parameter validation

Reject at input, with a clear error the UI can show:

- `wallThickness_mm < 6` → warn ("tearing likely"); < 3 → reject.
- `basePlateThickness_mm < 2` → reject ("base will warp during print").
- `sprueDiameter_mm < ventDiameter_mm` → reject ("sprue must be larger than vents").
- `partingPlane` that doesn't intersect the master → reject ("parting plane misses part").

## Anti-patterns

- Hardcoding numeric defaults in the generator. Defaults live in `src/config/defaults.ts`.
- Coupling UI concerns into generation code (no i18n strings, no alerts, no DOM).
- Generating parts in millimetres *and* inches. Inches is a display-only conversion; internal units are always mm.
- Skipping the `isManifold()` assertion on output "because it worked last time."

## Testing

- Unit test each helper against `unit-cube`, `unit-sphere-icos-3`, `torus-32x16`, and `mini-figurine` fixtures.
- Integration test the full generation pipeline: `mini-figurine.stl` + default params → 4 side parts + 1 base + 1 cap, all watertight, silicone volume within 3 % of hand-computed value.
- Visual-regression snapshot: exploded view of all 7 parts from a fixed camera.
