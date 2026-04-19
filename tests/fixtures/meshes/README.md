# Canonical mesh fixtures

Every fixture is committed under this directory with a `.stl` file and a `.json` sidecar declaring its expected properties. Tests assert against the sidecar, so if the STL is regenerated the sidecar must be updated intentionally in the same PR.

## Contract

Each fixture `<name>.stl` has a sibling `<name>.json`:

```json
{
  "name": "unit-cube",
  "triCount": 12,
  "volume_mm3": 1.0,
  "surfaceArea_mm2": 6.0,
  "boundingBoxMin": [-0.5, -0.5, -0.5],
  "boundingBoxMax": [0.5, 0.5, 0.5],
  "isManifold": true,
  "source": "procedurally generated via tests/fixtures/meshes/generate.ts",
  "license": "public-domain"
}
```

## Planned fixtures (populate in Phase 2)

| File | Source | Tri budget | Notes |
|---|---|---|---|
| `unit-cube.stl` | procedural | 12 | Primitive sanity; exact volume = 1.0 mm³ |
| `unit-sphere-icos-3.stl` | procedural (icosphere subdivision 3) | 1280 | Curved surfaces; volume ≈ 4.188 mm³ |
| `torus-32x16.stl` | procedural (32 radial × 16 tubular) | 1024 | Genus-1 topology; non-trivial Euler characteristic |
| `mini-figurine.stl` | TBD — CC-BY-SA external source | ≤ 50 000 | Real-world master; attribution in `mini-figurine-license.txt` |

## Fixture loader

Import helper (to be added in Phase 2): `tests/fixtures/meshes/loader.ts` → `loadFixture(name: string): Promise<{ geometry: BufferGeometry; manifold: Manifold; meta: FixtureMeta }>`.

## Size budget

All fixtures under 200 KB. Total fixtures directory < 1 MB. If we ever need a larger fixture, use git LFS — never commit multi-MB binaries directly.

## Regenerating

Procedural fixtures: `pnpm test:fixtures-regen` (to be added in Phase 2). Regeneration is deterministic; re-committing should produce identical bytes. If the SHA diffs without a geometry change, investigate before committing.
