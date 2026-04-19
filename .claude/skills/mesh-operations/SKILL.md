---
name: mesh-operations
description: Load STL, run manifold-3d booleans (union/intersect/subtract), offset surfaces via LevelSet, compute volume, check watertightness, export binary STL. Use for any task that touches mesh geometry below the UI layer.
---

# mesh-operations skill

## When to invoke

Any task whose inputs or outputs are meshes: STL import, Boolean ops, offset/dilation, volume computation, watertight checks, mesh repair, STL export, slicing along planes, BVH construction for picking.

## Locked decisions (do not contest in-task)

- **Engine:** `manifold-3d` (WASM, Apache-2.0). Async init — load once at app start.
- **Picking accelerator:** `three-mesh-bvh`. Rebuild BVH after any mesh mutation, not on camera changes.
- **STL I/O:** `three/examples/jsm/loaders/STLLoader` + `STLExporter`. Binary preferred.
- **Default offset algorithm:** `LevelSet` (SDF via body-centered-cubic marching tetrahedra). `MinkowskiSum` is allowed only as a micro-optimisation when LevelSet is too slow for a preview — not for final export.
- **Units:** mm internally always. No inch math in geometry code.

See `docs/adr/002-geometry-stack.md` for the reasoning. Don't re-litigate.

## Canonical operations

| Op | Function / API | Notes |
|---|---|---|
| Load STL | `STLLoader.parse(ArrayBuffer) → BufferGeometry` | Handles ASCII + binary. Normalise: centre, set to mm. |
| BufferGeometry → Manifold | `Manifold.ofMesh({vertProperties, triVerts})` | Strip UVs/colors; only vertex positions go in. |
| Manifold → BufferGeometry | `manifold.getMesh()` → build BufferGeometry | Re-derive normals from vertex winding. |
| Union | `Manifold.union(a, b)` | Guaranteed-manifold output. |
| Subtract | `Manifold.difference(a, b)` | Order matters: shell − master. |
| Intersect | `Manifold.intersection(a, b)` | |
| Offset (quality) | `Manifold.levelSet(sdf, bounds, edgeLength)` | Walls for silicone; use edgeLength = min(0.3 × wall_thickness, 1 mm). |
| Offset (fast) | `Manifold.minkowskiSum(a, ball)` | Not for final export. |
| Volume | `manifold.volume()` | mm³. |
| Surface area | `manifold.surfaceArea()` | mm². |
| Is manifold | `manifold.isManifold()` | **MUST be true** for any mesh going into STL export. |
| Split by plane | `Manifold.splitByPlane(normal, originOffset)` → `[above, below]` | Use for parting surface. |
| Export STL | `STLExporter.parse(mesh, {binary: true})` | Always binary. |

## Watertightness discipline

Every exported STL must be manifold. Before export:

```ts
if (!manifold.isManifold()) {
  throw new MeshIntegrityError(`Not watertight: ${manifold.status()}`);
}
```

If an input mesh is non-manifold, `manifold-3d` repairs it silently. **Surface this to the user** with a tri-count delta (`before: 12345 tri → after: 12310 tri`) — they need to know their mesh was modified.

## Performance budgets

- **Interactive ops** (hover highlight, drag parting plane): < 16 ms per frame. No Boolean ops in the interactive path — use `three-mesh-bvh` clipped-edges for parting preview.
- **Generate (batch)**: target < 500 ms on 50 k-tri masters, < 3 s on 500 k-tri. Beyond 500 k, show progress and allow cancel.
- **WASM init**: preload `manifold-3d` at app startup. Don't lazy-load on first Generate.

## Patterns to prefer

- **Single source of truth for geometry**: Manifold instance for compute, `BufferGeometry` for display. Build a thin adapter in `src/geometry/adapters.ts` (create if missing); don't sprinkle conversions across call sites.
- **Immutable inputs**: never mutate a loaded master mesh. Clone before operations.
- **Pure functions for geometry**: no hidden state. `computeSilicone({master, params}) → {siliconeMesh, volume}` style.

## Anti-patterns to avoid

- Passing raw vertex arrays across module boundaries. Wrap in typed Manifold or BufferGeometry.
- Calling Boolean ops in a React/render loop.
- Assuming a mesh is closed without checking `isManifold()`.
- Using `MinkowskiSum` for the final shell (self-intersection risk at sharp features).
- Writing ASCII STL (1.5× larger, slower to parse, no precision benefit).
- Hand-rolling CSG "because it's just subtraction" — we locked `manifold-3d` for robustness.

## Testing requirements

Every function in `src/geometry/` must have at least one unit test against a canonical fixture in `tests/fixtures/meshes/`. See `.claude/skills/testing-3d/SKILL.md` for fixture list and assertion patterns.
