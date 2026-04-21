---
name: mold-generator
description: Generate the silicone body + surface-conforming rigid print shell from a master STL + parameters. v1 supports rigid-shell + silicone-glove only.
---

# mold-generator skill

## When to invoke

Tasks that produce the mold itself — the silicone body and the rigid
surface-conforming print shell around it. Not general mesh ops (that's
`mesh-operations`), not viewport rendering (that's `three-js-viewer`).

## Locked scope (do not expand)

**v1 strategy (redirected 2026-04-20):** rigid-shell + silicone-glove.
Sleeve+shell variations, multi-part (3–5), brush-on, cut molds are **out
of scope**. If the user asks for them, escalate; do not build
speculatively.

See `docs/research/molding-techniques.md` for domain background and
`docs/adr/002-geometry-stack.md` for the stack.

## Input contract

```ts
interface MoldInputs {
  master: Manifold;              // master mesh, already loaded + repaired
  siliconeThickness_mm: number;  // 1–15, default 5
  printShellThickness_mm: number;// 2–30, default 8
  sideCount: 2 | 3 | 4;          // default 4 — reserved for Wave E radial slicing
  draftAngle_deg: number;        // 0–3, default 0 (silicone stretches) — reserved
  // viewTransform: Matrix4      // Master group's world matrix (applied inside kernel)
}
```

## Output contract

```ts
interface MoldGenerationResult {
  silicone: Manifold;              // surface-conforming silicone body (shell − master)
  printShell: Manifold;            // surface-conforming rigid shell hugging the silicone
  siliconeVolume_mm3: number;
  resinVolume_mm3: number;         // === master.volume() at 1e-9 relative
  printShellVolume_mm3: number;
}
```

Ownership: both Manifolds are caller-owned. Call `.delete()` on each when
done.

## Generation algorithm (Wave C, issue #72)

1. **Apply the viewport transform** to the master so all downstream
   operations live in the oriented frame the user sees.
2. **Build an SDF closure** from the transformed master via
   `three-mesh-bvh` (`closestPointToPoint` distance + axis-aligned
   ray-parity sign). The SDF is stateless w.r.t. the iso-level, so the
   same closure feeds both levelSet passes below.
3. **First `Manifold.levelSet`** at `level = -siliconeThickness_mm`
   with bounds = master bbox expanded by `silicone + 2 × edgeLength` →
   silicone outer body.
4. **`silicone = siliconeOuter.difference(master)`** — carve the cavity.
   Single piece.
5. **Second `Manifold.levelSet`** at
   `level = -(siliconeThickness_mm + printShellThickness_mm)` with
   bounds expanded by `total + 2 × edgeLength` → print-shell outer body.
6. **`printShellRaw = shellOuter.difference(siliconeOuter)`** — hollow
   surface-conforming shell with silicone fitting exactly inside.
7. **`trimByPlane`** twice:
   - Top trim at `y = master.max.y + siliconeThickness + 3 mm` — open
     pour edge.
   - Bottom trim at `y = master.min.y` — flat base where Wave D will
     attach the base slab.
8. **Assert `isManifold()` + `genus() === 0`** on silicone and
   printShell before returning.
9. **Compute volumes**: `silicone.volume()`, `master.volume()` (≡
   resinVolume_mm3 at 1e-9), `printShell.volume()`.

`edgeLength = max(2.0 mm, siliconeThickness_mm / 4)`. The 2.0 mm floor
is the Wave-C perf bump bundled from issue #71 — at the default
silicone=5 mm this yields a 2.0 mm BCC grid (0.4 × thickness), well
within the `mesh-operations` skill's 0.3 × thickness preview-fidelity
budget.

## Out of scope for Wave C — deferred to Waves D/E/F

- **Wave D** — Base slab below the shell (45° interlock, 2 mm overlap,
  0.2 mm tolerance).
- **Wave E** — Radial slicing of the print shell into 2/3/4 pieces
  (angles in `src/geometry/sideAngles.ts::SIDE_CUT_ANGLES`).
- **Wave F** — Brims on the sliced shell pieces; optional registration
  keys on the brim interfaces.
- Draft-angle application (separate wave).
- Sprue + vent channels — removed in Wave A; the open-top pour edge
  replaces them.

## Implementation layout

- `src/geometry/generateMold.ts` — pipeline entrypoint
  (`generateSiliconeShell`).
- `src/geometry/sideAngles.ts` — `SIDE_CUT_ANGLES` constant (pure data,
  reserved for Wave E).
- `src/geometry/adapters.ts` — `manifoldToBufferGeometry` /
  `bufferGeometryToManifold` / `isManifold`.
- `src/geometry/volume.ts` — thin wrappers around `manifold.volume()`.

## Parameter validation

Reject at input with a clear error the UI can show:

- `siliconeThickness_mm < 1` → reject ("silicone layer too thin").
- `printShellThickness_mm ≤ 0` or non-finite → reject.
- `sideCount ∉ {2, 3, 4}` → reject.
- `viewTransform.elements.length !== 16` → reject.

## Anti-patterns

- Hardcoding numeric defaults in the generator. Defaults live in
  `src/renderer/state/parameters.ts::DEFAULT_PARAMETERS`.
- Coupling UI concerns into generation code (no i18n strings, no alerts,
  no DOM).
- Generating parts in millimetres *and* inches. Inches is a display-only
  conversion; internal units are always mm.
- Skipping `isManifold()` assertion on output "because it worked last
  time."
- Letting an intermediate Manifold (`siliconeOuter`, `shellOuter`,
  `shellRaw`, `shellTrimTop`) leak past the `finally` block. Every
  intermediate `.delete()`s before return.

## Testing

- Unit tests against `unit-cube`, `unit-sphere-icos-3`, `torus-32x16`,
  and `mini-figurine` fixtures.
- Integration: full pipeline produces a watertight silicone AND a
  watertight `genus === 0` print shell. Print-shell bbox contained
  within the expanded master AABB (+silicone+printShell+edgeLength
  slack) with exact Y cuts from `trimByPlane`.
- Perf: mini-figurine full pipeline ≤ 5 s on CI (issue #72 AC).
- Generate-×3 leak check: volumes stable across three successive runs.
- Visual regression: `silicone-exploded.png` (silicone-only view) +
  `printable-parts-exploded.png` (silicone + shell exploded view).
