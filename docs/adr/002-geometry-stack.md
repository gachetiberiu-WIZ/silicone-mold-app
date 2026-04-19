# ADR 002 — Geometry Stack

- **Status:** Proposed (pending user approval at Phase 0 gate)
- **Date:** 2026-04-18
- **Depends on:** ADR-001 (runtime = Electron + Chromium renderer)

## Context

The app must:

1. Import STL masters (ASCII + binary; 10 k–1 M triangles typical; may be non-manifold / scanned / Thingiverse-sourced).
2. Perform robust Boolean ops (union, intersect, subtract) — used to subtract the master from a bounding shell to form the silicone cavity, and to separate the shell into base/sides/cap parts.
3. Generate an **offset surface** around the master (silicone wall thickness, 6–25 mm — see molding-techniques.md). This is Minkowski-sum-style mesh dilation, or SDF level-set.
4. Compute closed-mesh volume (silicone cost + resin pour estimates).
5. Slice along a user-picked parting plane, and preview the parting line interactively while the user drags it.
6. Export binary STL per mold part.
7. Allow interactive picking on the master (hover highlights, face selection for parting direction).

Runtime is Electron + Three.js (per ADR-001) — WASM is fine, native C++ requires a Node addon and is not preferred.

## Options considered

| # | Library | Status |
|---|---|---|
| 1 | **manifold-3d** + three-mesh-bvh + three.js STL loaders | **Selected (Strategy A)** |
| 2 | three-bvh-csg + three-mesh-bvh + custom offset | Rejected (no offset, strict manifold-input) |
| 3 | OpenCascade.js (single kernel) | Rejected (stable stuck at 2020, STL-offset broken, bundle bloat, LGPL) |
| 4 | Open3D | Rejected (no WASM — needs Python sidecar) |
| 5 | CGAL | Rejected (GPL license risk; no mainstream WASM port) |
| 6 | three-csg-ts | Rejected (dormant ~2 yr, BSP-slow on real inputs) |

### manifold-3d (Apache-2.0)

- **Version:** v3.4.1 (March 2026). Actively maintained by Emmett Lalish (Google/Wētā FX). ~2 k stars. Used in Blender 4.5 Boolean node, OpenSCAD, Nomad Sculpt, BRL-CAD, IFCjs.
- **Runtime:** WASM. Async init (~200–500 ms one-time).
- **Booleans:** `Union`, `Difference`, `Intersection`, `BatchBoolean`, `Split`, `SplitByPlane`, `TrimByPlane`. **Guaranteed manifold output** even on degenerate inputs (it repairs them first).
- **Offset:** `MinkowskiSum` / `MinkowskiDifference`; `LevelSet` (SDF → body-centered-cubic marching tetrahedra) for the quality path. Both survive high curvature without self-intersection — the critical property for silicone shells.
- **Volume + area:** `.Volume()`, `.SurfaceArea()` first-class.
- **Slicing:** `Slice()` (2D cross-section parallel to X-Y), `SplitByPlane` / `TrimByPlane` (physical cut). Arbitrary planes via pre-transform.
- **STL:** Author-recommended path is to parse STL via three.js `STLLoader`, ingest triangle soup into `Manifold.Mesh`, export via `STLExporter` on three.js `BufferGeometry` — docs discourage STL as the *canonical* format but interop is fine.
- **Performance:** Nefertiti 2M-tri union ~1.3 s; 500 k-tri union ~0.24 s; 100–1000× faster than CGAL/OpenSCAD baseline. On typical mold inputs (10–100 k tri) operations run well under 100 ms.
- **Gotchas:** Async init, `MinkowskiSum` is expensive relative to other ops (`LevelSet` is usually the right offset path for silicone walls).

### three-mesh-bvh (MIT)

- **Version:** v0.9.9 (March 2026). Garrett Johnson. ~3.3 k stars. 212 k dependent projects on npm — the canonical acceleration structure for three.js.
- **Use:** Not a CSG library. We use it for (a) interactive raycasting / hover-picking on the master mesh, (b) **parting-plane preview** via the `shapecast` + plane clipped-edges pattern — extract clipped triangle edges on 2 M-tri meshes in real time. This is exactly what we need to show the user a live parting line while they drag the plane.
- **Bundle:** ~70–100 KB minified.
- **Gotcha:** BVH must be rebuilt when geometry mutates (booleans invalidate it). We rebuild after each Generate step; preview interactions don't mutate.

### three.js (MIT) — STLLoader, STLExporter

Standard three.js addons for ASCII + binary STL round-trip. Already part of three.js dependency.

### Rejected: three-bvh-csg

- Fast, pure-JS, ~30–60 KB — but **no offset support** (would require in-house SDF or Minkowski implementation) and **strict two-manifold input requirement**. Silicone mold masters are frequently non-manifold (Thingiverse, scans, hand-modelled); we'd need a pre-flight repair stage *on top of* a CSG engine that already fails silently on bad input. manifold-3d's self-repair is a major feature we don't want to reinvent.
- Possible later as a **preview fast-path** for interactive CSG (hybrid Strategy D); not the primary engine.

### Rejected: OpenCascade.js

- Last **stable** release v1.1.1 is from **September 2020** (5+ years old). A 2.x beta exists (last commits mid-2024) but no stable 2.0 in April 2026.
- Monolithic WASM is ~40 MB; a trimmed 2.x modular build is ~8–15 MB — still heavy for a desktop installer.
- Its theoretical strength is `BRepOffsetAPI_MakeThickSolid` for offset, but the OCCT forum documents that **offset on STL-derived shapes often returns empty results** — works cleanly on BRep, not on mesh. Our inputs are meshes.
- LGPL-2.1 on the JS bindings — requires legal review for commercial redistribution.
- Rejected primarily on maintenance risk (5-year stable gap) and the STL-offset breakage.

### Rejected: Open3D

- No official WASM build. Running in Electron means spawning a Python subprocess, bundling a Python runtime (>100 MB), and shipping IPC — an architectural complication that fights ADR-001's single-binary Electron choice.
- Also: Booleans are not a first-class feature (tracked as feature request isl-org/Open3D#4769); you'd still call out to Manifold or libigl.

### Rejected: CGAL

- Dual license: GPL/LGPL OSS, or paid commercial via GeometryFactory. The 3D Boolean / Nef polyhedra core is **GPL** — copyleft incompatible with a closed-source redistributable. Commercial license cost is not public but historically four-figures/year+.
- No mainstream WASM port (experimental forks exist but are unmaintained).
- Slower than manifold-3d (Nefertiti union ~7.5 s vs 1.3 s).

### Rejected: three-csg-ts

Dormant (~2 years since last release). BSP construction is O(n²) in practice. Superseded.

## Decision

**Primary geometry stack: `manifold-3d` + `three-mesh-bvh` + three.js STLLoader/STLExporter.**

Optionally add **three-bvh-csg as an interactive preview fast-path** if profiling shows manifold-3d is too slow for real-time "drag the parting plane and see the result" feedback. Defer this to Phase 3 profiling — don't build it preemptively.

### Why

1. **Completeness.** manifold-3d has ALL six operations we need (Boolean, offset via Minkowski/LevelSet, volume, slice/split, manifold repair, good STL interop). No second-library dependency for core operations.
2. **Robustness on real-world STL.** Non-manifold inputs are repaired automatically. Our users will hand us dirty Thingiverse STLs — silent failure is the worst outcome; manifold-3d's guarantee is worth the async-init cost.
3. **License-clean.** Apache-2.0 on the engine, MIT on three-mesh-bvh and three.js. Zero legal overhead for commercial redistribution.
4. **Maintenance signal.** v3.4.1 in March 2026, ~monthly commits, adopted by Blender/OpenSCAD/Nomad Sculpt. Healthy bus factor relative to OpenCascade.js's single maintainer with a 5-year gap.
5. **Performance headroom.** Under 100 ms on 10–100 k-tri typical inputs; 1.3 s on 2 M-tri worst case. We can afford non-realtime batch operations on Generate, and keep the UI responsive.
6. **Interactive picking via three-mesh-bvh** solves the "show parting line as user drags plane" requirement without pulling CSG into the hot path.

## Architecture implications

- **Two mesh representations in memory:** three.js `BufferGeometry` (for Three.js rendering + BVH picking) and `Manifold.Mesh` (for Boolean / offset / volume). We need a thin sync layer — convert one to the other at the boundary of each Generate step. This is well-trodden; Manifold ships helpers.
- **Boolean ops on the main thread vs. worker thread.** Start on main; move to a Web Worker (or Node worker in Electron) only if profiling shows jank on inputs above ~500 k triangles. Manifold loads fine in workers.
- **BVH lifecycle.** Rebuild after Generate; don't rebuild on camera/view changes. Use `ParallelMeshBVHWorker` if build latency becomes noticeable on large masters.
- **WASM packaging.** `manifold-3d` WASM (~2–4 MB) ships in the Electron bundle; no network fetch at startup. Preload the module at app launch so the first Generate is warm.

## Consequences

**Positive**
- One engine for all geometry ops except picking.
- Clean license story.
- Determinism across platforms → Layer-A geometry tests (see ADR-003) can use SHA-hash snapshot assertions on canonicalised STL output.
- Performance well within interactive budgets at realistic mesh sizes.

**Negative**
- Two mesh representations to keep in sync (minor ongoing cost).
- WASM async init adds ~200–500 ms to cold start; preload mitigates.
- Dependency on a single engine's algorithm choices — if manifold-3d's LevelSet produces unsatisfactory offset for specific mold geometries, the fallback is a custom SDF pipeline (non-trivial).
- Pre-1.0 coupling on three-bvh-csg if we adopt the hybrid preview path later; revisit when it hits 1.0.

**Open questions surfaced for user at gate**

1. **Offset algorithm:** default to `LevelSet` for quality at the cost of ~2–5× runtime, or start with `MinkowskiSum` for speed at the cost of self-intersections on sharp features? Recommendation: **start with LevelSet** — silicone mold quality depends on clean offset.
2. **Realtime preview:** is "click Generate, wait ~100–500 ms, see the result" acceptable for v1, or do we need sub-16 ms interactive CSG (which forces three-bvh-csg hybrid from day 1)? Recommendation: **non-realtime is fine for v1** — skip the hybrid until we profile.
3. **Input repair UX:** when manifold-3d repairs a non-manifold STL, do we silently accept, or show the user a diff/warning? Recommendation: **show a warning with tri-count delta** so users know their STL was modified.

## References

- [manifold on GitHub (elalish/manifold)](https://github.com/elalish/manifold)
- [manifold-3d on npm](https://www.npmjs.com/package/manifold-3d)
- [ManifoldCAD JS User Guide](https://manifoldcad.org/docs/jsuser/)
- [Manifold Performance Discussion #383](https://github.com/elalish/manifold/discussions/383)
- [Users of Manifold — Discussion #340](https://github.com/elalish/manifold/discussions/340)
- [three-mesh-bvh on GitHub](https://github.com/gkjohnson/three-mesh-bvh)
- [three-mesh-bvh Clipped Edges example](https://gkjohnson.github.io/three-mesh-bvh/example/bundle/clippedEdges.html)
- [three-bvh-csg on GitHub (for future hybrid path)](https://github.com/gkjohnson/three-bvh-csg)
- [OCCT STL offset pitfall — dev.opencascade.org forum](https://dev.opencascade.org/content/offseting-stl-surface-brepoffsetapimakeoffsetshape-result-empty-shape)
- [MeshLib 2025 boolean-libraries benchmark](https://meshlib.io/blog/comparing-3d-boolean-libraries/)
- [CGAL license page](https://www.cgal.org/license.html)
- [three.js STLLoader](https://threejs.org/docs/pages/STLLoader.html)
- [three.js STLExporter](https://threejs.org/docs/pages/STLExporter.html)
