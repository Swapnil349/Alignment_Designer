# London 2100 — High-Speed Rail Alignment Designer

An alignment design system for the London 2100 orbital loop city. It generates
professional high-speed rail alignments between nodes, subject to real terrain,
environmental and planning constraints, and reports the engineering consequences.

**Open `index.html` directly in a browser.** No server, no build step, no
dependencies. Chrome/Edge 80+, Firefox 113+ or Safari 16.4+ (it uses the platform
`DecompressionStream` to unpack the grids).

---

## What it does

| | |
|---|---|
| **Search** | Curvature-constrained state-lattice A* over a 100 m constraint grid |
| **Horizontal geometry** | Radius guaranteed by construction, not by post-filtering |
| **Vertical geometry** | Constrained profile fit — ruling gradient, vertical curve radius, earthworks minimisation |
| **Structures** | Tunnel / viaduct / bridge / embankment / cutting / at-grade, from numeric thresholds |
| **Performance** | Curve-limited speed profile, kinematic accel/brake envelope, journey time |
| **Views** | Alignment · Speed · Time · Infrastructure · Environment · Topography · Engineering |
| **Export** | PNG, CSV (per-25 m chainage), GeoJSON (EPSG:27700, split by structure) |

### The radius guarantee

This is the core design decision. The search state is `(position, heading, last turn
direction)`. Each move advances one stride along a **circular arc** of radius
`stride / Δθ`. The per-step heading change is capped at the largest whole number of
5° buckets satisfying `stride/(k·Δθ) ≥ R_min`.

So at the default 700 m stride and 1 bucket, **every route the search can produce has
R ≥ 8,021 m**. The constraint is structural. There is no smoothing pass that might
violate it and no filtering step that might reject everything.

The `lastTurn` dimension forbids a left arc running directly into a right arc: reverse
curves must be separated by at least one straight step. Without it the alignment
contains tangent-free reversals — no radius at the join, and nowhere to place the
transition curves. This was a real bug: it measured **324 m against a guaranteed 8,021 m**
until the rule was added and the artificial terminal chord removed.

---

## Layout

```
London2100_RailDesigner/
├── index.html              UI shell
├── js/
│   ├── data_grid.js        GENERATED — 20 constraint grids, base64 zlib (13.4 MB)
│   ├── data_base.js        GENERATED — basemap as a data URI (1.8 MB)
│   ├── engine.js           grid · cost · search · geometry · profile · structures · physics
│   ├── render.js           map canvas, view modes, long section and speed charts
│   └── app.js              UI wiring, results, export
├── build/
│   ├── build_grids.py      regenerates the two data_*.js files from Maps/ + QGIS/
│   ├── reference_solve.py  independent Python implementation of the same engine
│   ├── dem_preview.png     DEM QA
│   └── grid_qa.png         constraint layer QA
└── out/                    reference solve outputs
```

Rebuild the data after changing any source layer:

```bash
python build/build_grids.py
```

Delete `build/_dem_cache.npy` first if the contours change.

---

## The grid

One common grid for everything, derived from the QGIS `Model` layout extent and
validated earlier in this project against 1,029 railway stations and 6 airports
(100% agreement, ±152 m).

| | |
|---|---|
| CRS | **EPSG:27700** OSGB36 / British National Grid |
| Extent | E 452768.076 → 602768.076, N 123487.607 → 246487.607 |
| Size | 150.000 × 123.000 km |
| Cell | **100 m** → 1500 × 1230 = 1,845,000 cells |
| Source rasters | the same frame at 300 dpi = exactly **25.4 m/px** |

### DEM

Built from the **OS Open Zoomstack 10 m contours** — 34,932 contour parts seeding
777,119 cells (42.1% of the grid), then Laplace relaxation with the contours held as
Dirichlet boundaries, converged to 0.03 m.

Range 10–290 m, which matches Leith Hill (294 m) and the Chilterns (267 m).
Independently cross-checked: it reads **120 m at St Paul's Walden**, exactly matching a
separate contour interpolation done during the node siting study.

> Note: the first implementation used ω = 1.85 over-relaxation on a **Jacobi** update.
> SOR with ω > 1 is only stable for Gauss-Seidel; on Jacobi it diverges to inf then NaN.
> Fixed to plain Jacobi.

### Layers

From the registered PNG exports: `aonb` `greenbelt` `built` `woodland` `london` `alc`
From OS Open Zoomstack vectors: `water_body` `river_major` `stream` `road_major`
`road_a` `road_b` `rail` `dem` `slope`
Derived: `d_built` `d_aonb` `d_wood` `d_water` `flood_proxy`

The vector layers are re-extracted rather than reusing the PNGs because the QGIS
exports carried subset filters (`type='Regional'` on surfacewater, `'MHW'` on
waterlines) — which is why `Water2.png` showed only the estuary.

---

## Validated results — Phase 1 corridor

**Quainton/Waddesdon (473887, 218604) → St Paul's Walden (520517, 220678)**

The browser engine and the independent Python implementation agree:

| | Python reference | Browser |
|---|---|---|
| Route length | 49.70 km | 49.70 km |
| Straight line | 46.68 km | 46.68 km |
| Deviation | +6.5% | +6.5% |
| Min radius | 7,943 m | 8,008 m |
| Max gradient | 2.50% | 2.50% |
| Terminal offset | 172 m | 172 m |
| Journey time | 8.43 min | 8.43 min |
| Tunnel | 4.40 km | 4.40 km |
| Solve time | 107 s | **2.8 s** |

The small radius difference is the curvature estimator's finite-chord bias, not a
geometry difference — the two paths are identical.

**Structure mix:** at grade 77.9% · cutting 10.0% · tunnel 8.8% · bridge 1.8% · embankment 1.5%

---

## Known limitations

1. **Ancient Woodland is proxied by all woodland.** OS Open Zoomstack has no
   ancient/non-ancient flag — its `woodland.type` is only `'Regional'`, a render-scale
   tag. The layer is 20.8% of the frame against ~2.5% for genuine ancient woodland.
   Conservative in the right direction (a superset), but it is not the real constraint.
   **Needs the Natural England Ancient Woodland Inventory.**
2. **Flood zones are a HAND proxy**, not Environment Agency data. Low ground (<4 m above
   nearest trunk watercourse) within 1,200 m of it. Coverage 11.6% against ~5% for EA
   Flood Zone 3. **Needs the EA Flood Map for Planning.**
3. **Structures are classified per station, not designed.** Tunnel portals, viaduct spans,
   pier positions and bridge skew angles are not yet resolved.
4. **No transition curves are drawn.** Clothoid lengths are computed and reported, but
   the plan geometry is arc-and-tangent. The search guarantees the arcs are long enough
   to accept them.
5. **Terminal offset.** The alignment ends where the geometry naturally arrives, up to
   ~350 m from the nominal node. The station is sited on the alignment rather than the
   line being bent to hit a point — bending it would break the radius guarantee.
6. **Cost weights are provisional** pending the design-standards research.

---

## Sources

Grid, DEM and constraint layers: **OS Open Zoomstack** (Ordnance Survey, Open Government
Licence). Agricultural Land Classification: **Predictive ALC Map for England**, Cranfield
Environment Centre RDE118. AONB: **Natural England**. Green Belt: **England Green Belt
2024/25**. Engineering standards and precedents: see `../Research_HSR/README.md`.
