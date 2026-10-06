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

The quickest route from nothing to a project is three commands — download the
terrain, download the constraints, build. `studies/delhi_varanasi/README.md`
walks through it for a real 800 km corridor; the short version:

```bash
python designer/build/fetch_dem.py --controls stations.csv --buffer-km 30 --out raw/dem
python designer/build/fetch_osm.py --controls stations.csv --buffer-km 30 --out raw/osm
python designer/build/import_dem.py --dem raw/dem --controls stations.csv --buffer-km 30 --osm raw/osm --id mycorridor --name "My corridor" --mode rail_hs --speed 320
```

`stations.csv` has named columns `name, lat, lon` (and optionally `kind`), one
row per control point in route order.

**Terrain.** `fetch_dem.py` downloads the Copernicus DEM — the most accurate free
global DEM — with no login, from the AWS open-data archive: GLO-90 (~90 m, ~5 MB
per 1° tile) by default, GLO-30 (~30 m, ~42 MB) with `--res 30`. `--dry-run` lists
the tiles and sizes first; an interrupted download resumes.

`import_dem.py --dem` takes any mix of GeoTIFFs (Copernicus, SRTM, ALOS,
CartoDEM, LiDAR exports), ESRI/GRASS ASCII grids, raw SRTM `.hgt` tiles, zips of
those, folders and wildcards, and mosaics them one tile at a time, so a corridor
spanning dozens of tiles fits in memory. It averages the DEM over each design
cell rather than point-sampling it (on a surface model, point sampling turns
rooftops into hills). Geographic DEMs are projected to the UTM zone of the
project's centre — radii, gradients and chainages are meaningless in degrees —
with a Snyder series in `dempack.py`: no pyproj, no GDAL.

The grid's extent comes from `--clip` (metres), `--bbox` (degrees), or the
stations plus `--buffer-km`; its cell size from `--cell`, or automatically — as
fine as the DEM allows while staying inside the ~4.5 M cells a browser holds
comfortably. Both choices are printed with the reason.

**Constraints.** `fetch_osm.py` pulls settlements, water, major roads, railways,
woodland and protected areas from OpenStreetMap through the public Overpass API,
in blocks, and writes one GeoJSON per layer; `--osm FOLDER` hands them all to the
importer. Any layer can come from a better source instead — every flag takes a
GeoJSON in WGS84 or the project CRS, and an explicit flag beats the `--osm` file:

```bash
python designer/build/import_dem.py --dem srtm.tif --id corridor \
  --built settlements.geojson --protected parks.geojson --woodland forest.geojson \
  --water rivers.geojson --road highways.geojson --rail railways.geojson \
  --farmland agriculture.geojson --exclusion no_go.geojson \
  --control "Start:73.79,19.99" --control "End:73.56,19.70" --mode rail_hs --speed 300
```

(`--control` takes LON first. If a point given that way lands outside the DEM
but its swapped reading lands inside, it is read as lat,lon — Google Maps order —
with a warning.)

A DEM on its own works fine — the route is then driven by terrain alone, which
the app says plainly rather than pretending it has constraint data it does not.

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

**Vertical policy.** Rail modes carry a *vertical policy*. **Follow the
ground** is the default: earthworks, with structures where the cut or fill gets
deep. **Elevated by default** is Indian high-speed practice: MAHSR is about 90 %
viaduct even on the plain. Elevated rail stays at least a minimum height above
ground and aims at a typical one. The defaults (8 m and 11.5 m) are calibrated
on 1,531 surveyed MAHSR piers, which measure 8.1 m at the least and 11.75 m at
the median.

Any leg can be a **bored tunnel**: rail at least *d* m below the ground or the
creek bed. The DEM has no bathymetry, so the bed depth below the water surface
is a stated parameter. A tunnel follows the straight grade between its ends,
pulled down only where cover demands it, which is why it dives under a creek
and does not climb into a hill. Each control point can also fix a rail level or
a depth (an underground station, a portal). A change of policy gets a ramp long
enough for the gradient and the vertical curves.

The policy enters the fitter as bounds on the same convex projection. They are
rounded by crest and sag parabolas of the standard radius, so the profile can
rest on them without corners. Any stretch that cannot be held to the policy is
reported in metres and kilometres. A study with tunnel legs adds two options:
*Tunnel deeper (+15 m cover)* and *Viaduct instead of tunnel*. A bored leg pays
only 12 % of the surface constraint weights in the search, since it passes
under the town and the creek.

**Comparing with an existing design.** A project can carry the line already
being built as its *reference*. That can include the given rail levels (fixed
exactly, never fitted), sparse published levels (pinned, with the policy
between), the declared structures, and surveyed ground. The reference is
evaluated under the same standard and rates as the options, and ranked with
them unless that is switched off. Its rail level is drawn dashed under every
option's long section wherever the two lines are within 300 m. Surveyed ground
is drawn against the DEM, and the DEM's measured offset is reported.
`studies/mahsr/` builds two such references: MAHSR C-4, with the S5 levels,
from CivilWorksApp; and BKC – Thane, from OpenStreetMap and published depths.

**3D view.** The **3D** button on the map toolbar opens a block model of the
corridor:

- the terrain around the line, lit and coloured, with the constraint layers
  draped over it;
- the selected alignment at its *design* level, coloured by structure, with
  piers under viaducts;
- tunnels drawn dashed through the ground, or seen through it in *x-ray*;
- the other options beside it.

Vertical exaggeration runs from 1× (true) to 20×. Hover is shared with the map
and the long section, and clicking the line moves the section there. It is
plain WebGL with no library (`js/view3d.js`). The block is up to ~400 k
vertices, and the hillshade comes from a full-resolution texture, so it stays
sharp on long corridors. It is display only: nothing in it feeds a result.

**Long section and map.** The long section zooms (wheel, ± buttons) and
scrolls (drag, scrollbar). Its vertical exaggeration can be fixed (1×–100×),
and it says when levels run off the plot. Right-click an alignment on the map
to select that option; where lines overlap, right-click again to cycle. The
unselected options fade back.

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
* **The search is near-optimal, not provably optimal.** Its heuristic combines
  a 2-D cost-to-go computed outward from each station (so it knows a station
  sits inside a town) with the minimum turning any path must make. It is not
  guaranteed consistent and closed states are not reopened, so no hard
  optimality bound is claimed. Each leg is searched unweighted first; where
  that runs out of budget — typically a leg ending deep inside a large town,
  where costs are ~60× open ground — it falls back to weighted A* (ε 1.2, then
  1.6), and the Results tab reports the ε used (*Search mode*). On one measured
  leg ε 1.6 cost ~10 % more than ε 1.2. A search that runs out of budget is
  reported as such, never mistaken for a radius that does not fit. The radius
  constraint itself is unaffected — that is structural, and no heuristic can
  weaken it.
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
* **The fitted profile has too many grade changes for a high-speed line.** It
  follows the ground (or ground plus clearance) within the curve and gradient
  limits. Real HSR practice holds long constant grades, with change points ≥ 2 km
  apart on MAHSR. On Delhi – Agra the elevated fit has about 347 grade changes in
  206 km. Compare earthworks, clearances and structures, not the VIP count, until
  a grade-line fit exists.
* **Vertical curves at fixed levels.** The fitter is local. On steep ground a
  fixed level (an end tie, a fixed station level) can leave a vertical curve
  tighter than the standard right beside it. The Results tab shows the radius
  achieved.
* **A DEM has no creek bed and is a surface model.** Tunnel cover under water
  uses an assumed bed depth. Copernicus heights include canopy and buildings and
  sit on EGM2008, not the project datum. The reference import measures the
  offset against surveyed ground where it has some; use `--dem-offset`.
* **Coastal regulation zone is a proxy** unless an authoritative CZMP layer is
  given: a buffer of the OSM coastline plus mangrove buffers.
* **The 3-D view is a picture, not a model.** The terrain mesh is
  downsampled, to about 300 m facets on the 412 km London loop. Cuttings are
  not carved: they are drawn at the ground surface as trenches. The other
  options are drawn as lines, and picking works on the selected line only.
  Panning drifts slightly at low angles. Nothing in it feeds a result.

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
  js/view3d.js                 WebGL 3-D block model of the corridor (no library)
  view3d_test.html             standalone page for the 3-D view (?project=<id>)
  js/app.js                    wiring
  build/dempack.py             DEM readers, UTM, rasterisation, packing
  build/import_dem.py          import your own terrain and constraints
  build/make_demo.py           synthetic demonstration project
  build/convert_london.py      carry the London study over, with its settled loop
  build/fetch_dem.py           download Copernicus DEM tiles for a corridor
  build/fetch_osm.py           download OpenStreetMap constraint layers
  projects/                    packed projects + index.json
studies/
  delhi_varanasi/              stations + runbook for the Delhi – Varanasi HSR study
  mahsr/                       Mumbai – Ahmedabad HSR: DEM tile lists, stations, the
                               existing design as references (C-4 from CivilWorksApp,
                               kept out of git in private/; BKC – Thane from public data)
docs/feature_benchmark.md      Trimble Quantm and similar tools vs this one
london2100/
  v12/                         delivery build: app, data/, outputs/ (Sep 2026)
  v11/                         previous build, with build/ (Python pipeline)
```
