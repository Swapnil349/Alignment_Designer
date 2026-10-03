# Alignment Designer

DEM-based corridor planning for linear infrastructure — roads, conventional
railways, high-speed lines, metro and maglev — in the spirit of Trimble Quantm:
generate a family of feasible alignments over real terrain, evaluate them all on
the same basis, and compare the trade-offs before committing to one.

| folder | what it is |
|---|---|
| **`designer/`** | The generic tool. Any DEM, any mode, any design speed. This is the one to develop. |
| **`london2100/v12/`** | The London 2100 orbital study — **latest delivery build** (Sep 2026). The settled 412 km, 17-station loop, its data and its published outputs. |
| **`london2100/v11/`** | The same study one version earlier, kept because it carries the Python build scripts (`build/`) the grids and the loop were made with. |

The London study and the generic designer were both once called "v12". They are
different things: the study's v12 was a **presentation build** of v11 (new
terrain basemap, new default view — engine, geometry and outputs byte-identical),
while the designer is the generalisation of the study's engine to any terrain
and any mode. The folders are named so the two cannot be confused.

---

## Running it

Nothing to install beyond Python with NumPy, Pillow and SciPy — the app itself
is dependency-free browser JavaScript.

```bash
python serve.py
```

That serves the folder and opens `http://localhost:8770/designer/`. The London
builds are at `/london2100/v12/` and `/london2100/v11/` — and also run with no
server at all: double-click their `index.html`.

A browser with `DecompressionStream` is required (Chrome/Edge 80+, Firefox 113+,
Safari 16.4+) — it is what inflates the packed grids, and it avoids shipping a
third-party zlib.

### First run

Two projects ship ready to use:

* **Demo — coastal plain to plateau.** Synthetic terrain: 700 m of climb across a
  wandering escarpment, two incised river valleys, two saddles, towns, a reserve.
  Built by `designer/build/make_demo.py`; no real place is depicted.
* **London 2100 — orbital corridor.** The study's dataset carried over from
  `london2100/v12`: OS Open Zoomstack contours relaxed to a 100 m DEM over
  150 × 123 km, with AONB, Green Belt, built-up, woodland, water, road and rail
  layers. It also carries the **settled 412 km orbital as a reference
  alignment** — `Load reference` evaluates it under whatever standard is
  selected, without re-routing it. At the study's own settings (maglev, 750 km/h,
  1.5 m/s², 60 s dwell, all 17 calls) the designer reproduces the published
  89.2 min, 277 km/h average and 664 km/h peak, and the 5,637 m tightest curve.

If the project list is empty, build them:

```bash
python designer/build/make_demo.py
python designer/build/convert_london.py
```

---

## Using your own terrain

```bash
python designer/build/import_dem.py --dem terrain.tif --id westghats --name "West Ghats crossing"
```

Accepted DEM formats: **GeoTIFF** (Copernicus, SRTM, ALOS, NASADEM, LiDAR
exports), **ESRI/GRASS ASCII grid** (`.asc`), **raw SRTM tiles** (`.hgt`), and
bare NumPy arrays with `--extent`.

Geographic DEMs in degrees are projected to the UTM zone of their centre, because
radii, gradients and chainages are meaningless in degrees. The projection is a
Snyder series implemented in `dempack.py` — no pyproj, no GDAL.

Constraint layers are optional GeoJSON, in WGS84 or already in the project CRS:

```bash
python designer/build/import_dem.py --dem srtm.tif --id corridor \
  --built settlements.geojson \
  --protected national_parks.geojson \
  --woodland forest.geojson \
  --water rivers.geojson \
  --road highways.geojson \
  --rail railways.geojson \
  --farmland agriculture.geojson \
  --exclusion no_go.geojson \
  --control "Start:73.79,19.99" --control "End:73.56,19.70" \
  --mode rail_hs --speed 300
```

A DEM on its own works fine — the route is then driven by terrain alone, which
the app says plainly rather than pretending it has constraint data it does not.

Useful sources: Copernicus GLO-30, SRTM 30 m, ALOS World 3D, national LiDAR
programmes; OpenStreetMap extracts via Overpass or Geofabrik for the vectors.

---

## What it does

**Design standards.** Pick a mode and a design speed and the geometry follows
from the published rule, not a lookup table — so an arbitrary speed still gives a
defensible number, and the derivation is shown on screen.

| mode | minimum radius from | gradient | vertical curve |
|---|---|---|---|
| Road | `V²/(127(e+f))`, AASHTO side friction | AASHTO, by terrain class and speed | crest/sag K from stopping sight distance |
| Railway | `k·V²/(D+I)`, gauge-dependent k | ruling gradient | `0.35·V²`, floor 2 500 m |
| High speed | `11.8·V²/(D+I)`, TSI INF | TSI, up to 35 ‰ | `0.35·V²` (adjustable) |
| Maglev | `v²cosθ/(a_q + g·sinθ)`, MbBO §13 | up to 10 % | `v²/a_v` |
| Metro | `11.8·V²/(D+I)`, 120 m floor | 3.5 % typical | `0.25·V²` |

**The search.** A state lattice over (position, heading, last turn direction).
Each move advances one stride along a circular arc, and the per-step heading
change is restricted to the largest whole number of buckets that still satisfies
`stride/(k·Δθ) ≥ R_min`. Every path the search can emit is therefore
radius-compliant *by construction* — there is no post-hoc smoothing that might
violate the constraint. The last-turn dimension prevents a left arc running
straight into a right one, which would leave nowhere to put the transitions.

The cost surface charges per metre for what the route crosses (settlement,
protected land, woodland, floodplain, water, existing infrastructure, farmland),
plus a **directional** terrain cost: the gradient along the direction of travel
and the undulation a stiff profile cannot follow. That directional term is what
makes the route seek valleys and cross ridges at their lowest saddle — a
point-slope penalty cannot tell a contour-hugging alignment from one driving
straight up the hillside.

**The vertical alignment** is fitted by alternating projection: repeatedly remove
only the *excess* curvature wherever a vertical curve is tighter than the
standard allows, then clamp the gradient. Both are projections onto convex sets,
so it converges into the feasible region while leaving the profile on the ground
everywhere the ground was already acceptable.

The two ends of an open route are tied to existing ground, because that is where
it meets the network that already exists. The tie is enforced as a *reachability
envelope* — the ruling gradient is a Lipschitz condition, so a fixed level at one
chainage bounds the profile everywhere — which means the descent into a terminus
begins exactly as far back as it must. Intermediate stations are deliberately not
tied: a platform sits at the design level, on embankment or in cutting, and
forcing seventeen of them onto existing ground collapsed the vertical radius from
67 km to 208 m on the London circuit. Their cut and fill is reported instead.

**Where a control point cannot be reached** at the mainline radius — a station set
well off the corridor, with hard turns either side — the leg is re-routed at a
reduced local radius and the relaxation is reported, with the line speed it
implies. This is the HS2-into-Euston pattern: a station throat is taken at a
tighter radius and speed is capped over it. What it never does is happen
silently. On the London circuit the tool independently finds the same two
stations the v11 study had to hand-tune.

**Quantities and cost.** Earthworks are priced by volume from the formation width
and side slopes, not smeared into a rate per kilometre — in rolling country that
volume *is* the difference between two alignments. Structures are selected from
cut and fill depth and land sensitivity, land take is measured from the actual
prism width, and a mass-haul diagram shows whether the design balances.

**Options.** `Generate options` routes a family of alternatives across three
axes — design speed, priorities (least cost, shortest, environment-led,
community-led, terrain-following) and corridor position — then ranks them on a
weighted score and marks the Pareto front, the options nothing else beats on cost,
time, settlement impact and protected land at once.

**Terrain basemap.** Ported from the London v12 delivery build, which matched the
published project basemap: matplotlib's `terrain` ramp over a LightSource
hillshade (315°, 50° altitude), terrain 90 % over white and hillshade 30 % over
that. A project may fix its colour limits (London: −40 … 230 m AOD, so the app and
every printed sheet read the same height as the same colour); otherwise they come
from the DEM's own percentiles. A project may also set its opening view — London
opens on the constraint layers against white, as the delivery build does.

**Export.** DXF (3D, layered by structure), LandXML (alignment + design profile +
ground profile, for Civil 3D / OpenRoads / 12d), CSV chainage table, GeoJSON,
a drawing sheet PNG, and a georeferenced map PNG with a world file.

---

## Honest limits

These are stated because a corridor tool that hides them is worse than useless.

* **Costs are comparative.** The rate tables are order-of-magnitude benchmarks,
  exposed and editable in the app. They rank alternatives against each other.
  They are not an estimate, and no figure should leave the room before a local
  rate build-up replaces them.
* **The search is near-optimal, not provably optimal.** The heuristic is
  calibrated on the corridor's own cost surface rather than on a global lower
  bound; without that it degenerates into Dijkstra and takes 86 s where it now
  takes 11. The radius constraint is unaffected — that is structural, and no
  heuristic can weaken it.
* **Horizontal and vertical are solved in sequence, not together.** The search
  picks the corridor using a terrain-response proxy — the gradient along the
  direction of travel and the undulation a stiff profile cannot follow — and the
  profile is then fitted to that corridor. A true 3-D optimiser would trade a
  longer line against a shallower gradient inside one search. The proxy is what
  makes the route seek valleys and cross ridges at their saddles, but it is a
  proxy.
* **Chains are routed sequentially**, with heading continuity and one-point
  look-ahead. That is not globally optimal over a multi-point chain; a search
  carrying the waypoint index in its state would be, and does not fit in a
  browser's memory.
* **Horizontal geometry is arcs on a 5° lattice**, not fitted circular curves with
  clothoid transitions. Transition lengths are reported from the standard but not
  drawn. Refitting exact design geometry belongs in the detailed-design package,
  which is why LandXML export exists.
* **The flood layer** in an import with no published flood map is a
  height-above-nearest-drainage proxy, not a flood zone.
* **Structure thresholds** (when fill becomes viaduct, when cut becomes tunnel)
  are rate-driven simplifications of a decision that in reality involves ground
  conditions, ventilation and consent.

---

## Layout

```
serve.py                       local static server
CLAUDE.md                      orientation for Claude Code sessions
designer/                      the generic tool
  index.html                   the app
  js/standards.js              design standards, per mode, derived from the rules
  js/engine.js                 grid access, cost surface, lattice search, profiles
  js/costs.js                  quantities, capital cost, mass haul, multi-criteria
  js/study.js                  option generation, ranking, reference evaluation
  js/render.js                 map, terrain basemap, thematic views, charts
  js/export.js                 DXF, LandXML, CSV, GeoJSON, PNG
  js/app.js                    wiring
  build/dempack.py             DEM readers, UTM, rasterisation, packing
  build/import_dem.py          import your own terrain and constraints
  build/make_demo.py           synthetic demonstration project
  build/convert_london.py      carry the London study over, with its settled loop
  projects/                    packed projects + index.json
london2100/
  v12/                         delivery build: app, data/, outputs/ (Sep 2026)
  v11/                         previous build, with build/ (Python pipeline)
```
