# Fixture licenses

Mesh fixtures under this directory may be licensed differently from the project as a whole. Each fixture's `.json` sidecar declares its `license`, `source`, and `attribution` fields; this file consolidates the human-readable attributions.

## Procedurally-generated fixtures

`unit-cube.stl`, `unit-sphere-icos-3.stl`, `torus-32x16.stl` — to be generated deterministically from `tests/fixtures/meshes/generate.ts` (in a future PR). Public domain; no attribution required.

## Third-party or original fixtures

### `mini-figurine.stl`

- **Author:** Tiberiu Gache (<gache.tiberiu@gmail.com>)
- **Contribution date:** 2026-04-19
- **License:** [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)
- **Attribution:** "mini-figurine.stl" by Tiberiu Gache, licensed under CC BY-SA 4.0.
- **Notes:** 5 798 triangles; binary STL produced by Rhinoceros 3D. Bounding box approx 84 × 69 × 110 mm, not origin-centred — loaders must apply a centering transform.

Any redistribution of `mini-figurine.stl`, including derivative works, must preserve this attribution and propagate the ShareAlike (SA) clause.
