---
name: three-js-viewer
description: Three.js viewport conventions — camera, lights, gizmos, units, picking via three-mesh-bvh, parting-plane preview, exploded view. Use for any task that touches what the user sees in 3D.
---

# three-js-viewer skill

## When to invoke

Anything rendered in the 3D canvas: loading a mesh for display, hover highlights, drag-select, axis/origin gizmos, camera controls, parting-plane widget, exploded-view toggle, per-part wireframe, STL-quality overlays.

## Locked conventions

| Concern | Decision |
|---|---|
| Coordinate system | Three.js default **Y-up**. XZ plane is the print-bed. |
| Units | mm, always. One Three.js unit = 1 mm. Never scale at the renderer layer. |
| Renderer | `WebGLRenderer({ antialias: false, pixelRatio: 1 })` for test determinism; `antialias: true`, dpr = window.devicePixelRatio in prod. Gate on env flag. |
| Camera | `PerspectiveCamera(fov=45, near=1, far=5000)`. Frame-on-load to master's AABB with 1.4× padding. |
| Lights | One hemisphere light (sky ≠ ground) + one directional from +Y+X for shadow cues. No ambient-only scenes (flat). |
| Grid | XZ grid at y=0, 100 mm major / 10 mm minor, always on. Toggle via Settings but default-on. |
| Axis gizmo | Bottom-left corner. Standard colors (X red, Y green, Z blue). Always on. |
| Background | Neutral `#1b1d22` (dark) / `#f2f4f7` (light). Use the app's theme, not hardcoded. |
| Picking | `three-mesh-bvh` via `Mesh.raycast = acceleratedRaycast`. Rebuild BVH after any mesh mutation. |

## Scene graph rules

```
Scene
├── Origin (Group)
│   ├── GridHelper
│   └── AxesHelper
├── Master (Group, tag: 'master')
│   └── Mesh (BufferGeometry from STLLoader, phong shader)
├── Mold (Group, tag: 'mold', starts hidden until Generate)
│   ├── Base (Mesh, tag: 'base')
│   ├── Sides (Group, tag: 'sides')
│   │   └── Mesh[] (one per side)
│   ├── TopCap (Mesh, tag: 'cap')
│   └── Silicone (Mesh, tag: 'silicone', transparent, optional display)
└── Widgets (Group)
    ├── PartingPlane (THREE.Plane + visual helper)
    └── SelectionHighlight
```

Tags are `.userData.tag` — used by tests and the exploded-view animator.

## Parting-plane preview

Use `three-mesh-bvh`'s clipped-edges pattern (`MeshBVH.shapecast` + a plane) to extract the visible intersection as a `LineSegments`. This renders at 60 fps on up to 2 M-tri masters. Update on every `pointermove` during drag, no throttle needed.

Do **not** run `Manifold.splitByPlane` interactively — it's a final-export operation, too slow for drag.

## Exploded view

When the user clicks "Exploded view" after Generate: animate each mold part along its outward-from-centre vector to 1.5× its distance from the assembly centroid. Use `@tweenjs/tween.js` or vanilla `requestAnimationFrame` lerp — don't pull in a heavy animation lib.

## Units in the UI

Users see mm or inches (toggle in Settings). The **viewport labels** (ruler overlays, dimension readouts) convert at the display layer. The scene, camera, and geometry are always mm. Never scale meshes at render to fake inches.

## Test hooks (stripped in prod)

```ts
if (process.env.NODE_ENV === 'test') {
  (window as any).__testHooks = {
    readyForInput: appReadyPromise,
    parseComplete: new Map<string, Promise<void>>(),
    generateComplete: new Map<string, Promise<void>>(),
    scene,        // direct reference for assertion
    camera,
  };
}
```

Vite tree-shakes the guarded block when `NODE_ENV !== 'test'`. Confirm via a bundle-analyzer check in the `build-installer` CI job.

## Anti-patterns

- Hardcoded colors that bypass the theme.
- Multiple cameras / multiple renderers (one canvas, one camera).
- `requestAnimationFrame` loops that run when the window is hidden (cost battery).
- OrbitControls `damping` = true with a time-dependent step (breaks determinism in visual tests — disable damping when `NODE_ENV === 'test'`).
- `setPixelRatio(window.devicePixelRatio)` in tests (breaks snapshot determinism).
- Mixing `Group.position` animation and `Mesh.position` animation on the same part (confuses exploded-view reset).

## Testing

- Visual-regression snapshots (Playwright `toHaveScreenshot`) in `tests/visual/`. One per canonical scene.
- Unit tests for scene-graph invariants: "after Generate, Mold group exists with base + sides + cap; BVH present on master."
- Playwright + `page.clock.install()` to freeze time before snapshotting.
