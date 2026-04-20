// src/renderer/scene/index.ts
//
// Builds the main Three.js scene graph per `.claude/skills/three-js-viewer/
// SKILL.md`:
//
//   Scene
//   ├── Origin (Group, tag: 'origin')
//   │   └── origin-gizmos (Group)
//   │       ├── GridHelper (tag: 'grid-major' + 'grid-minor' child)
//   │       └── AxesHelper (tag: 'world-axes')
//   ├── Master (Group, tag: 'master')   ← populated by `scene/master.ts`
//   ├── Silicone (Group, tag: 'silicone')   ← populated by `scene/silicone.ts`
//   │   ├── Mesh (tag: 'silicone-upper', translucent blue)
//   │   └── Mesh (tag: 'silicone-lower', translucent blue)
//   ├── Mold   (Group, tag: 'mold', visible=false)   ← populated later
//   └── Widgets (Group, tag: 'widgets')   ← populated later
//
// Lights: one HemisphereLight + one DirectionalLight from +Y+X, per the
// skill's "no ambient-only scenes" rule.

import {
  DirectionalLight,
  Group,
  HemisphereLight,
  Scene,
} from 'three';
import { SCENE_BACKGROUND } from './renderer';
import { createOriginGizmos } from './gizmos';

export function createScene(): Scene {
  const scene = new Scene();

  // Background tracks the renderer clear colour. Set here too so test
  // environments that clear via the scene background (rare, but possible
  // for render-to-texture paths) still see the right colour.
  (scene as unknown as { background: number }).background = SCENE_BACKGROUND;

  // Lights — hemisphere + directional. Hemisphere provides sky/ground tint
  // so surfaces read as lit even without shadow mapping; directional adds
  // a primary highlight direction for form definition.
  const hemi = new HemisphereLight(
    /* skyColor  */ 0xb0c4de,
    /* groundColor */ 0x202830,
    /* intensity */ 0.85,
  );
  hemi.position.set(0, 1, 0);
  scene.add(hemi);

  const dir = new DirectionalLight(0xffffff, 0.6);
  dir.position.set(50, 80, 30);
  scene.add(dir);

  // Scene graph scaffolding — future PRs populate Master / Mold / Widgets.
  const origin = new Group();
  origin.userData['tag'] = 'origin';
  origin.add(createOriginGizmos());
  scene.add(origin);

  const master = new Group();
  master.userData['tag'] = 'master';
  scene.add(master);

  // Silicone halves preview group (issue #47). Populated by
  // `scene/silicone.ts` after a successful `generateSiliconeShell` run.
  // The halves render at world origin because the generator applies the
  // view transform internally — no group-level rotation/translation
  // compounded here.
  const silicone = new Group();
  silicone.userData['tag'] = 'silicone';
  scene.add(silicone);

  // Printable-parts preview group (issue #62). Populated by
  // `scene/printableParts.ts` after a successful generator run — carries
  // the base + sides + top cap Manifolds. Starts visible=false; the
  // toolbar "Show printable parts" toggle flips it on when the user
  // opts in. Like silicone, the parts render at world origin because
  // `generateSiliconeShell` bakes the viewport transform into the
  // Manifolds before returning them.
  const printableParts = new Group();
  printableParts.userData['tag'] = 'printableParts';
  printableParts.visible = false;
  scene.add(printableParts);

  const mold = new Group();
  mold.userData['tag'] = 'mold';
  mold.visible = false;
  scene.add(mold);

  const widgets = new Group();
  widgets.userData['tag'] = 'widgets';
  scene.add(widgets);

  return scene;
}
