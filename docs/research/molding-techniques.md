# Silicone Molding Techniques for Resin Casting — Research

**Purpose.** Domain background for the silicone mold generator app. Informs the v1 feature scope (which mold strategies the software generates) and the parameter defaults the UI should expose.

**Date:** 2026-04-18.

**Methodology caveat.** The `research-analyst` sub-agent that produced sections 1–4 reported that its WebSearch/WebFetch tools were not exposed in the session; content is from established domain knowledge rather than live-verified. Sources in section 5 are hand-cited and should be re-verified before quoting publicly. For app-design purposes the domain facts here (formulas, typical wall thicknesses, draft-angle stance for silicone) are industry-standard and safe to build on.

---

## 1. Mold types

**One-piece sleeve / glove mold (with release cut).** A single silicone shell is formed around the master (typically by brushing or dipping, or by pouring into a simple containment box), then a single slit is cut along a chosen seam to pop the master out and insert resin. Typical use case: organic, rounded masters like figurines, hands, small sculpts, or prototypes where a visible seam is acceptable. Main trade-off: cheapest and fastest to make, but the cut leaves a flash line on every cast and the slit weakens the mold's service life (10–50 pulls typical).

**Two-piece block mold.** The master is half-buried in clay or a printed bed so silicone can be poured over one half, then the clay is removed, release agent applied, and the second half poured against the first. Typical use case: parts with a clear natural parting line (coins, medallions, symmetrical toys, simple mechanical parts). Main trade-off: clean un-cut demold and good registration, but requires two pours, careful parting-line design, and still leaves a visible seam where the two halves meet.

**Multi-part mold (3–5 pieces).** The mold is divided into three or more silicone sections held inside a rigid mother-mold (plaster, fiberglass, or 3D-printed shell) so that each section can be pulled away in a direction that clears the master's undercuts. Typical use case: complex figures with limbs sticking out, hollow statuary, props with deep undercuts, lost-wax patterns. Main trade-off: handles aggressive undercuts without stretching the silicone, but design time and seam count grow rapidly; every extra seam is a potential flash line and alignment error.

**Cut (slice-open) molds.** A block of silicone is poured fully encapsulating the master, then sliced open with a scalpel along an irregular, zig-zag or keyed path so the two halves self-register when closed. Typical use case: small-to-medium organic masters, especially when the moldmaker wants a no-box, no-clay workflow. Main trade-off: extremely fast (one pour, one cut), but the zig-zag cut requires a skilled hand and the resulting seam can be ragged.

**Brush-on vs. pour molds.** Pour molds submerge the master in a containment and rely on gravity to fill, requiring enough silicone volume to fully encase the part plus a safe wall. Brush-on (also called "glove" when combined with a mother mold) applies thickened silicone in layers directly onto the master, then a rigid shell is built over it once cured. Use case: pour molds for small parts where silicone cost is low; brush-on for large statues, architectural castings, and anything where pouring would waste liters of rubber. Main trade-off: pour molds are simple and give uniform wall thickness automatically; brush-on saves material on large parts but requires thixotropic additives and multiple cure cycles.

---

## 2. Mold architectures (printable-sides approach)

In the printed-sides architecture, the moldmaker 3D-prints a rigid containment shell around the master and pours silicone into that shell. The typical part breakdown is:

- **Base plate** — a flat or contoured platform with registration pockets or pins, and often a negative of the master's footprint so it sits in a repeatable pose. Frequently carries drainage bosses and alignment keys for the side walls.
- **Printed side walls (2, 3, or 4 pieces)** — vertical walls that clip, screw, or slot into the base and each other. **2 sides** wins for simple prismatic masters where the parting line runs down two opposing edges (think: a rectangular bar or a symmetrical figurine). **3 sides** wins when the master has a natural triangular footprint or when one face has a flat reference surface that doubles as a wall, reducing printing volume. **4 sides** wins for irregular or roughly cubic masters where the parting lines need to wrap around all four cardinal directions, and for multi-part molds where each silicone wedge needs its own printed retainer.
- **Top cap** — the lid that closes the box, usually containing the sprue/pour opening and one or more vents. The top cap also applies compression to the parting surfaces once the silicone has cured and the master is removed (important for injection or pressure casting).
- **Pour spout and vent(s)** — a funnel-shaped entry for resin (ideally at the lowest feature of the master in casting orientation) and thin vents at every high point to let air escape. Cross-sections of 3–6 mm for sprues and 1–2 mm for vents are common for small parts.

ASCII sketch (top-down and side elevation):

```
         TOP-DOWN (cap removed)                SIDE ELEVATION
    +-----------------------------+        +---------------------+
    |  [key]  SIDE A      [key]   |        |    TOP CAP          |
    |  +---+  ============  +---+ |        |  =================  |
    |  |   |  |          |  |   | |        |  | sprue | vent |   |
    | S|   |  |  MASTER  |  |   |S|        |  |-------|------|   |
    | I|   |  |          |  |   |I|        |  |              |   |
    | D|   |  ============  |   |D|        |  |   MASTER     |   |  <- silicone
    | E|   |      sprue     |   |E|        |  |              |   |
    |  |   |                |   | |        |  =================
    |  +---+                +---+ |        |       BASE          |
    |      SIDE C (bottom wall)   |        +---------------------+
    +-----------------------------+
       [asymmetric registration keys on every mating face]
```

**Alternative architecture: master suspended in two half-boxes, silicone poured in halves.** The master is skewered on pins or suspended from the lid of a containment box with its intended parting line aligned to the box's midline. Clay, foam, or a printed dam fills the lower half's volume below the parting line. Silicone is poured to form the top half; once cured, the box is flipped, the clay is removed, release agent applied to the cured silicone's parting surface, and the second half is poured against the first. This avoids needing printed side pieces specific to each master — the same generic box is reused — but requires clay-work or a custom dam, produces a wider and less controlled parting line, and is harder to automate from CAD. The printed-sides approach is generally preferred when a digital master exists because the parting surface can be computed deterministically.

---

## 3. Key computations

- **Silicone volume = shell_volume − master_volume − sprue_volume − vent_volume.** The net rubber needed is the internal cavity of the containment minus everything that displaces silicone (the master itself and any channels that will be open air after demolding). Matters because silicone is the dominant material cost (tin-cure ~$40/kg, platinum-cure ~$80–120/kg as of 2026), and under-mixing wastes batches while over-mixing exceeds pot life.

- **Wall-thickness offset.** The minimum silicone thickness between the master's surface and the outer shell. For resin casting of small parts (under ~100 mm), 8–12 mm is typical; for larger parts, 15–25 mm. Thinner than ~6 mm risks tearing at undercuts; thicker than ~25 mm wastes material and makes demolding stiffer. Matters because it dominates both silicone usage and demold feel.

- **Parting line detection.** A good parting line (a) lies on a silhouette edge of the master from the demold direction, (b) avoids crossing fine surface detail, (c) is as planar as possible, and (d) ideally falls on an existing geometric edge the casting will have anyway. Undercuts — regions where the surface curls back toward the demold axis — force the parting line to detour around them or demand additional mold parts. Automatic detection typically computes per-triangle visibility against a candidate pull direction, then finds the loop separating visible from occluded faces.

- **Draft angles.** In rigid tooling (injection, die casting) 1–3 degrees per wall is standard to allow release. **Silicone molds are a contested case:** because silicone is elastic and stretches 300–900% before tearing, draft is generally *not required* for release — the rubber simply deforms past undercuts. However, zero-draft vertical walls on the *rigid master* create maximum friction during demold and wear the mold faster; some moldmakers add 0.5–1 degree purely to extend mold life and reduce the force needed on each pull. The dominant view is: for occasional casting, skip draft; for production runs from a silicone mold, add light draft where it doesn't compromise the part's geometry.

- **Registration key geometry.** Keys are bumps on one mold half that fit into pockets on the other, ensuring the halves align repeatably. Common shapes: hemispheres (6–10 mm diameter), truncated cones, pyramids, and keyhole slots. Typical depth 3–6 mm, spacing one key every 30–60 mm along the parting line. **Asymmetry is critical** — if all keys are identical and symmetrically placed, the mold can be reassembled rotated or flipped, guaranteeing misalignment. Using keys of two different sizes, or a single "clocking" key offset from the others, forces exactly one correct orientation.

- **Resin pour volume = master_volume + sprue_volume (+ small overpour margin).** The resin needed per cast equals the master's displaced volume plus whatever fills the sprue and vents, plus 5–10% for the meniscus and spill. Matters for cost estimation (polyurethane resin ~$60–100/kg), for mix ratio accuracy on two-part systems, and for choosing a pot-life appropriate for the fill time.

---

## 4. Trade-offs

| Axis | Lean one way | Lean the other |
|---|---|---|
| **Silicone savings vs. wall strength** | Thin walls (6–8 mm) save rubber and flex easily for demold, but tear at undercuts and fatigue fast — mold may fail after 10–20 pulls. | Thick walls (15–25 mm) give long service life and tear resistance but use 2–3× the silicone per mold. |
| **Undercut tolerance vs. mold complexity** | A single-piece glove mold stretches over almost any undercut, but the cut-line is a permanent defect on every cast. | More parts (3, 4, 5) let each piece pull in a clean direction with no stretching, preserving fine detail — at the cost of more seams, more registration work, and more assembly time per pour. |
| **Seam visibility vs. demold difficulty** | Seams placed on flat or hidden surfaces are invisible but often force the mold to split in awkward directions, making demold harder and risking tears. | Seams placed on prominent silhouette edges demold easily but leave flash lines that need post-processing. |
| **Simple sleeve (cut to release) vs. multi-part box (no cut)** | Sleeve: one pour, one cut, fastest path from master to first cast; but every cast carries the cut's flash line and the mold's lifespan is limited by the slit propagating. | Multi-part box: no cut, cleaner cast surfaces, longer mold life, full CAD control over parting lines; but design and print time for the shell can rival the silicone cure time. |

---

## 5. Sources (to re-verify before publication)

- [Smooth-On — How to Make a Two-Piece Block Mold](https://www.smooth-on.com/tutorials/how-make-two-piece-block-mold/)
- [Smooth-On — Mold Making & Casting Technical Overview](https://www.smooth-on.com/support/technical-overview/)
- [Smooth-On YouTube Channel — official tutorials on glove, block, and brush-on molds](https://www.youtube.com/user/SmoothOn)
- [MatterHackers — Guide to Silicone Molding with 3D Printed Masters](https://www.matterhackers.com/articles/how-to-make-a-silicone-mold-from-a-3d-print)
- [PCBWay — 3D Printed Silicone Mold Making Guide](https://www.pcbway.com/blog/3d_printing/3D_Printed_Silicone_Molds.html)
- [Make: Magazine — Molding & Casting category](https://makezine.com/category/workshop/molding-casting/)
- [Robert Tolone — Moldmaking and Sculpting YouTube tutorials](https://www.youtube.com/user/rtolone1)
- [TAP Plastics — Mold Making Instructional Videos](https://www.tapplastics.com/information/how_to_videos/make_a_mold)
- [Formlabs — Silicone Molding for Low-Volume Production](https://formlabs.com/blog/how-to-make-a-silicone-mold/)

---

## 6. Recommendation for v1 — APPROVED 2026-04-18

**Locked strategy v1 generates (singular):**

**Two-halves-in-box** — two-piece block mold using the printed-sides architecture (base + 2/3/4 printed sides + top cap + sprue/vent). The app computes the parting surface, splits the containment into upper and lower halves, and generates separate printable parts for each.

**Scope narrowed from the Phase 3 spec's "sleeve+shell vs. two-halves-in-box":** user approved dropping sleeve+shell at the gate. Rationale: two-halves subsumes sleeve functionally — users who want a sleeve-style workflow can simply not cut their mold in half, or can cut their two-halves mold into a single sleeve with a scalpel post-print. Every printed part from the two-halves pipeline remains usable. This cuts v1 engineering (no separate sleeve code path) without removing user capability.

**Parameter defaults exposed in the UI:**

| Parameter | Default | Range | Notes |
|---|---|---|---|
| Units | mm | mm / inches | mm default per user constraint; inches toggle in Settings. |
| Silicone wall thickness | 10 mm | 6–25 mm | Middle of the 8–12 mm band for small parts. Warn below 6 mm. |
| Base plate thickness | 5 mm | 2–15 mm | Printed part stiffness. |
| Side count (box variant) | 4 | 2, 3, 4 | Per user Phase 3 spec. |
| Sprue diameter | 5 mm | 3–8 mm | |
| Vent diameter | 1.5 mm | 1–3 mm | |
| Registration key style | Asymmetric hemispherical (one small, one large) | Hemi, cone, keyhole | Prevents rotation/flip errors. |
| Draft angle (silicone) | 0° | 0°–3° | Default off; user opts in for production molds. |

**Explicitly NOT in v1 (punt to v2+):**

- **Sleeve+shell as a separate pipeline** (dropped at the gate — user cuts two-halves into a sleeve manually if desired).
- Multi-part molds (3–5 pieces with rigid mother-mold) — complex parting-surface topology and undercut handling is a research project in itself.
- Brush-on / glove molds over a master — different workflow, no pour calculation.
- Cut (zig-zag slice) molds — generated from CAD doesn't model the manual slice.
- Draft-angle application *to the master mesh itself* — we only generate mold parts; the master stays untouched.

**Why this scope:** it delivers a useful product for the common case (small-to-medium resin masters, desktop 3D printer to produce the containment) while deferring the algorithmic hard problem (automatic multi-piece parting surface generation against arbitrary undercuts). Users with complex masters can still use v1 by picking simpler parting directions or manually pre-orienting their STL.
