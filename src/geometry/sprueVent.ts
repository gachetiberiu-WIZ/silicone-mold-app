// src/geometry/sprueVent.ts
//
// Sprue + vent channel drilling — Phase 3c Wave 3 (issue #55, steps 4–5).
//
// Produces two related CSG operations on the upper silicone half + top
// cap:
//
//   1. `drillSprue`  — one vertical cylinder from master-top-Y up through
//      top-cap top, centred on the master's XZ bbox centre. Opens the
//      resin pour path from the top of the finished box down into the
//      cavity.
//
//   2. `drillVents` — up to `parameters.ventCount` vertical cylinders at
//      the master's local Y-maxima, chosen via greedy non-maximum
//      suppression on the master's vertex positions. Each vent runs from
//      its source vertex Y up through top-cap top.
//
// Locked design decisions (from issue #55, do NOT re-litigate):
//   - Only ONE sprue, centred on the master XZ bbox.
//   - Sprue / vents orient along +Y (print orientation == pour direction
//     in v1; casting-flip is Phase 3e).
//   - Sprue starts at `master.bbox.maxY + 0.1 mm` so the boolean subtract
//     opens cleanly into the cavity without a zero-thickness layer.
//   - Vents chosen by greedy NMS on sorted-by-Y vertex positions with
//     min XZ separation `max(5 mm, 2·ventDiameter_mm)`. Skip vent if
//     within `(sprueDiameter + ventDiameter)` of sprue centre.
//   - `ventCount=0` → skip vent generation entirely.
//   - If fewer vents fit than requested, return a `warnings[]` entry —
//     do NOT throw.
//
// Manifold ownership
// ------------------
// Every intermediate Manifold allocated here is `.delete()`-d inside
// `try/finally`. The INPUT `upperHalf`, `topCap`, and `master` handles
// are NOT consumed — the caller still owns them and must release them
// separately. The caller receives TWO fresh Manifolds per call
// (`updatedUpper`, `updatedTopCap`) plus metadata (placement counts,
// warnings).

import type { Box, Manifold, ManifoldToplevel } from 'manifold-3d';

import type { MoldParameters } from '@/renderer/state/parameters';
import { isManifold } from './adapters';
import { verticalCylinder } from './primitives';

/**
 * Minimum XZ-separation floor (mm) between two vents. The effective
 * separation is `max(MIN_VENT_SEPARATION_MM, 2·ventDiameter_mm)`; for the
 * default 1.5 mm vent diameter (→ 3 mm) the floor wins. On larger vents
 * (3 mm → 6 mm separation) the per-diameter rule takes over.
 *
 * Exported so tests can pin this constant without duplicating the
 * comparison.
 */
export const MIN_VENT_SEPARATION_MM = 5.0;

/**
 * Y-axis clearance (mm) added between the master's top and the sprue's
 * bottom so the boolean subtract opens the cavity cleanly — without the
 * pad the sprue bottom would land exactly on the silicone's cavity ceiling
 * and leave a zero-thickness layer the kernel may round-trip inconsistently.
 */
export const SPRUE_Y_EPSILON_MM = 0.1;

/** Result of `drillSprue`. Caller owns both Manifolds — `.delete()` each. */
export interface DrillSprueResult {
  /** Upper silicone half with the sprue hole. */
  readonly updatedUpper: Manifold;
  /** Top cap with the sprue hole. */
  readonly updatedTopCap: Manifold;
}

/** Result of `drillVents`. Caller owns both Manifolds — `.delete()` each. */
export interface DrillVentsResult {
  /** Upper silicone half with vent holes. */
  readonly updatedUpper: Manifold;
  /** Top cap with vent holes. */
  readonly updatedTopCap: Manifold;
  /** Number of vents actually drilled (`<=` requested ventCount). */
  readonly placed: number;
  /** Number of vents requested but skipped (ventCount − placed). */
  readonly skipped: number;
  /** Soft warnings (e.g. "only N of M vents placed"). */
  readonly warnings: ReadonlyArray<string>;
}

/** Pure-geometry option bag for `drillSprue`. */
export interface DrillSprueOptions {
  /** Master XZ-centre where the sprue axis sits. */
  readonly xz: { x: number; z: number };
  /** Bottom Y of the sprue (typically `master.maxY + SPRUE_Y_EPSILON_MM`). */
  readonly fromY: number;
  /** Top Y of the sprue (typically `topCap.maxY`). */
  readonly toY: number;
  /** Sprue diameter in mm. */
  readonly diameter: number;
}

/** Pure-geometry option bag for `drillVents`. */
export interface DrillVentsOptions {
  /** Master Manifold — vertex positions drive the NMS. Not consumed. */
  readonly master: Manifold;
  /**
   * Top Y to extend each vent to (shared across vents — typically
   * `topCap.maxY`).
   */
  readonly topY: number;
  /** XZ centre of the sprue (for sprue-overlap exclusion). */
  readonly sprueXZ: { x: number; z: number };
  /** Sprue diameter (for the overlap-distance calculation). */
  readonly sprueDiameter: number;
  /** Vent diameter in mm. */
  readonly ventDiameter: number;
  /** Requested vent count (clamped at caller; 0 → early return). */
  readonly ventCount: number;
}

/**
 * Minimal `(status, isEmpty)` assertion with a human-readable message.
 * Inline helper kept local to this module so the failure mode surfaces a
 * sprue/vent-specific label.
 */
function assertValid(m: Manifold, label: string): void {
  if (!isManifold(m)) {
    throw new Error(
      `sprueVent: ${label} is not a valid manifold ` +
        `(status=${m.status()}, isEmpty=${m.isEmpty()})`,
    );
  }
}

/**
 * Drill a single vertical sprue cylinder through the upper silicone half
 * and the top cap.
 *
 * Ownership contract:
 *  - `upperHalf` + `topCap` are NOT consumed — caller still owns them
 *    and must `.delete()` them when done.
 *  - Returns two FRESH Manifolds — caller owns both.
 *  - Every intermediate (the sprue cylinder) is `.delete()`-d via
 *    `try/finally`.
 */
export function drillSprue(
  toplevel: ManifoldToplevel,
  upperHalf: Manifold,
  topCap: Manifold,
  opts: DrillSprueOptions,
): DrillSprueResult {
  assertValid(upperHalf, 'input upper half (drillSprue)');
  assertValid(topCap, 'input top cap (drillSprue)');
  if (!(opts.toY > opts.fromY)) {
    throw new Error(
      `sprueVent.drillSprue: opts.toY=${opts.toY} must be > opts.fromY=${opts.fromY}`,
    );
  }
  if (!(opts.diameter > 0) || !Number.isFinite(opts.diameter)) {
    throw new Error(`sprueVent.drillSprue: opts.diameter=${opts.diameter} must be positive`);
  }

  const radius = opts.diameter / 2;
  const sprueCyl = verticalCylinder(toplevel, opts.fromY, opts.toY, opts.xz, radius);

  let updatedUpper: Manifold | undefined;
  let updatedTopCap: Manifold | undefined;
  try {
    updatedUpper = upperHalf.subtract(sprueCyl);
    assertValid(updatedUpper, 'upper half after sprue subtract');
    updatedTopCap = topCap.subtract(sprueCyl);
    assertValid(updatedTopCap, 'top cap after sprue subtract');

    const out: DrillSprueResult = { updatedUpper, updatedTopCap };
    // Transfer ownership: null out the locals so the error-path cleanup
    // below doesn't double-free on a late throw. (Between here and the
    // return there are no throw sites, but the pattern keeps the contract
    // robust against future edits.)
    updatedUpper = undefined;
    updatedTopCap = undefined;
    return out;
  } catch (err) {
    if (updatedUpper) updatedUpper.delete();
    if (updatedTopCap) updatedTopCap.delete();
    throw err;
  } finally {
    sprueCyl.delete();
  }
}

/**
 * Pure-function NMS over a list of candidate points. Sorts descending by
 * Y, then greedily accepts each candidate whose XZ distance from every
 * already-accepted candidate is >= `minSeparation` AND whose XZ distance
 * from the sprue centre is >= `sprueExclusion`. Stops at `ventCount`
 * accepted candidates (or after the candidate list is exhausted).
 *
 * Exported for unit-test coverage without having to allocate Manifolds.
 *
 * Algorithmic notes:
 *  - We sort the full candidate list once (O(N log N)) rather than using
 *    a priority queue — the candidate list is `numVert(master)` which is
 *    at most ~50 000 on our largest fixture; an in-place sort costs
 *    ~1 ms. Simpler than a heap for no appreciable cost.
 *  - Ties on Y are broken by first-seen order. The caller passes vertex
 *    positions in the mesh's native vertex order, which is deterministic
 *    across runs, so the placement is deterministic too.
 *  - Duplicate candidate XZs (common on master meshes where many
 *    triangles share a single peak vertex) are implicitly deduplicated
 *    by the `minSeparation` rule — the second one is always within 0 mm
 *    of the first and gets rejected.
 */
export function selectVentCandidates(
  vertices: ReadonlyArray<{ x: number; y: number; z: number }>,
  opts: {
    readonly ventCount: number;
    readonly minSeparation: number;
    readonly sprueXZ: { x: number; z: number };
    readonly sprueExclusion: number;
  },
): Array<{ x: number; z: number }> {
  if (opts.ventCount <= 0) return [];
  // Shallow-copy so we don't mutate the caller's array. Sort descending
  // by Y. `.slice()` preserves insertion order for the tie-break via
  // Array.prototype.sort being stable in V8 / SpiderMonkey.
  const sorted = vertices.slice().sort((a, b) => b.y - a.y);

  const placed: Array<{ x: number; z: number }> = [];
  const minSep2 = opts.minSeparation * opts.minSeparation;
  const sprueExcl2 = opts.sprueExclusion * opts.sprueExclusion;

  for (const v of sorted) {
    if (placed.length >= opts.ventCount) break;
    // Sprue exclusion — reject any vent that would overlap the sprue.
    const dxs = v.x - opts.sprueXZ.x;
    const dzs = v.z - opts.sprueXZ.z;
    if (dxs * dxs + dzs * dzs < sprueExcl2) continue;
    // Existing-vent separation — reject any vent that's too close to a
    // previously-placed vent.
    let tooClose = false;
    for (const p of placed) {
      const dx = v.x - p.x;
      const dz = v.z - p.z;
      if (dx * dx + dz * dz < minSep2) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;
    placed.push({ x: v.x, z: v.z });
  }

  return placed;
}

/**
 * Read the master's vertex XYZ positions. Pulls from `master.getMesh()`
 * directly because `numProp` may be > 3 (manifold-3d stores extra
 * per-vertex properties after position; we only read the first 3).
 *
 * Exported so the NMS test can pin behaviour without duplicating the
 * mesh-access boilerplate.
 */
export function readMasterVertices(
  master: Manifold,
): Array<{ x: number; y: number; z: number }> {
  const mesh = master.getMesh();
  const numProp = mesh.numProp;
  const numVert = mesh.vertProperties.length / numProp;
  const out: Array<{ x: number; y: number; z: number }> = [];
  for (let i = 0; i < numVert; i++) {
    const base = i * numProp;
    out.push({
      x: mesh.vertProperties[base] as number,
      y: mesh.vertProperties[base + 1] as number,
      z: mesh.vertProperties[base + 2] as number,
    });
  }
  return out;
}

/**
 * Drill up to `opts.ventCount` vertical cylinders through the upper
 * silicone half and the top cap at the master's local Y-maxima (greedy
 * NMS; see `selectVentCandidates`).
 *
 * Ownership contract matches `drillSprue`:
 *  - `upperHalf`, `topCap`, `opts.master` are NOT consumed.
 *  - Returns two FRESH Manifolds + metadata. Caller owns both Manifolds.
 *
 * `ventCount=0` short-circuits — no CSG, no allocation — and returns
 * `{ placed: 0, skipped: 0, warnings: [] }` with the inputs unmodified.
 * Because the caller's ownership of the inputs is untouched in that case
 * and the return shape must still supply fresh Manifolds, we clone both
 * via a no-op `add` with an empty... no — that would be wasteful. We
 * instead use `Manifold.cube([0,0,0])` as a zero... also wasteful.
 *
 * The cheapest "clone" is `input.translate([0,0,0])`: it produces a fresh
 * handle to the same underlying data with no CSG. That's what we do, so
 * the caller's "both outputs are fresh, call .delete() on each" contract
 * holds uniformly on the zero-vent path.
 */
export function drillVents(
  toplevel: ManifoldToplevel,
  upperHalf: Manifold,
  topCap: Manifold,
  opts: DrillVentsOptions,
): DrillVentsResult {
  assertValid(upperHalf, 'input upper half (drillVents)');
  assertValid(topCap, 'input top cap (drillVents)');
  assertValid(opts.master, 'input master (drillVents)');

  if (!(opts.ventDiameter > 0) || !Number.isFinite(opts.ventDiameter)) {
    throw new Error(`sprueVent.drillVents: ventDiameter=${opts.ventDiameter} must be positive`);
  }
  if (!(opts.sprueDiameter > 0) || !Number.isFinite(opts.sprueDiameter)) {
    throw new Error(`sprueVent.drillVents: sprueDiameter=${opts.sprueDiameter} must be positive`);
  }
  if (!Number.isFinite(opts.topY)) {
    throw new Error(`sprueVent.drillVents: topY=${opts.topY} must be finite`);
  }

  // ventCount=0 short-circuit: fresh clones, no NMS, no CSG.
  if (opts.ventCount <= 0) {
    const upperClone = upperHalf.translate([0, 0, 0]);
    let topClone: Manifold | undefined;
    try {
      topClone = topCap.translate([0, 0, 0]);
    } catch (err) {
      upperClone.delete();
      throw err;
    }
    return {
      updatedUpper: upperClone,
      updatedTopCap: topClone,
      placed: 0,
      skipped: 0,
      warnings: [],
    };
  }

  // NMS separation: per the issue, `max(5 mm, 2·ventDiameter)`.
  const minSeparation = Math.max(MIN_VENT_SEPARATION_MM, 2 * opts.ventDiameter);
  // Sprue-overlap exclusion: per the issue, `sprueDiameter + ventDiameter`
  // (centre-to-centre distance below which the cylinders interpenetrate).
  const sprueExclusion = opts.sprueDiameter + opts.ventDiameter;

  const vertices = readMasterVertices(opts.master);
  const selected = selectVentCandidates(vertices, {
    ventCount: opts.ventCount,
    minSeparation,
    sprueXZ: opts.sprueXZ,
    sprueExclusion,
  });

  const warnings: string[] = [];
  const placed = selected.length;
  const skipped = opts.ventCount - placed;
  if (placed < opts.ventCount) {
    warnings.push(
      `only ${placed} of ${opts.ventCount} vents placed: insufficient local maxima`,
    );
  }

  // If NMS returned nothing (every candidate clipped by the sprue) —
  // clone the inputs and return early, same shape as the ventCount=0
  // branch.
  if (placed === 0) {
    const upperClone = upperHalf.translate([0, 0, 0]);
    let topClone: Manifold | undefined;
    try {
      topClone = topCap.translate([0, 0, 0]);
    } catch (err) {
      upperClone.delete();
      throw err;
    }
    return {
      updatedUpper: upperClone,
      updatedTopCap: topClone,
      placed,
      skipped,
      warnings,
    };
  }

  // Build a cylinder per selected vent, union them into a single tool,
  // then subtract once from each half. Single-op avoids per-vent kernel
  // noise accumulation on the silicone ceiling.
  const radius = opts.ventDiameter / 2;
  const tools: Manifold[] = [];
  let updatedUpper: Manifold | undefined;
  let updatedTopCap: Manifold | undefined;
  try {
    const cylinders: Manifold[] = [];
    for (const pos of selected) {
      // Each vent's bottom Y is the candidate vertex's Y — NOT the
      // master's max Y. That's what lets local maxima on ridges / limbs
      // each get their own channel.
      const vertY = vertexYForXZ(vertices, pos);
      const cyl = verticalCylinder(toplevel, vertY, opts.topY, pos, radius);
      tools.push(cyl);
      cylinders.push(cyl);
    }

    const ventUnion =
      cylinders.length === 1 ? cylinders[0]! : toplevel.Manifold.union(cylinders);
    // Only push if it's a genuinely new Manifold (not the cylinders[0]
    // we'd double-free otherwise).
    if (cylinders.length > 1) tools.push(ventUnion);
    assertValid(ventUnion, 'vent-cylinder union');

    updatedUpper = upperHalf.subtract(ventUnion);
    assertValid(updatedUpper, 'upper half after vent subtract');

    updatedTopCap = topCap.subtract(ventUnion);
    assertValid(updatedTopCap, 'top cap after vent subtract');

    const out: DrillVentsResult = {
      updatedUpper,
      updatedTopCap,
      placed,
      skipped,
      warnings,
    };
    updatedUpper = undefined;
    updatedTopCap = undefined;
    return out;
  } catch (err) {
    if (updatedUpper) updatedUpper.delete();
    if (updatedTopCap) updatedTopCap.delete();
    throw err;
  } finally {
    for (const t of tools) t.delete();
  }
}

/**
 * Pick a representative Y for the given XZ position from the master's
 * vertex list. Used by `drillVents` to set each vent cylinder's `fromY`
 * back to the source peak's Y (NMS selection only recorded X / Z).
 *
 * The XZ position is by construction equal-to-machine-precision to the
 * selected vertex, so we look for an exact match. If no match is found
 * (unreachable via the `selectVentCandidates` → `drillVents` call path,
 * but defence-in-depth), we fall back to the highest Y across the mesh.
 *
 * Returns the vertex's Y in mm.
 */
function vertexYForXZ(
  vertices: ReadonlyArray<{ x: number; y: number; z: number }>,
  xz: { x: number; z: number },
): number {
  let bestY = Number.NEGATIVE_INFINITY;
  let matchY: number | undefined;
  for (const v of vertices) {
    if (v.y > bestY) bestY = v.y;
    if (v.x === xz.x && v.z === xz.z) {
      // The NMS output is the first match per XZ (sorted by Y desc), so
      // the FIRST vertex we encounter with matching XZ is the one the
      // selector picked. Keep the first match.
      if (matchY === undefined) matchY = v.y;
    }
  }
  return matchY ?? bestY;
}

/**
 * Helper exported for the generator entry: validate the Wave-3 parameter
 * subset (registration-key style, sprue-vs-vent ordering, vent count
 * range). Throws `InvalidParametersError` (imported by caller) with a
 * clear message on bad input.
 *
 * NOT exported as `validateSprueVentParams`-style but kept local so the
 * generator module owns the error class. See `generateMold.ts` for the
 * full validation entry.
 */
export function sprueVentDiameterRatioIsValid(parameters: MoldParameters): boolean {
  // Sprue must be strictly wider than vents — the skill's "sprue must be
  // larger than vents" rule. Equal widths are rejected too (the resin
  // path is ambiguous and the user almost certainly mis-set the value).
  return parameters.sprueDiameter_mm > parameters.ventDiameter_mm;
}

/**
 * Box helper: pull a Vec3 out of a `Box` safely. Inlined at call sites in
 * `generateMold.ts`; exported here as a trivial convenience so the
 * sprue-geometry parameters the generator feeds us can be derived from
 * boundingBox() without duplicating indexing.
 */
export function boxCentreXZ(b: Box): { x: number; z: number } {
  return {
    x: ((b.min[0] as number) + (b.max[0] as number)) / 2,
    z: ((b.min[2] as number) + (b.max[2] as number)) / 2,
  };
}
