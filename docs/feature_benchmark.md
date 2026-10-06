# Feature benchmark and gap analysis

*Alignment Designer against Trimble Quantm and comparable corridor-planning tools.
Written 2026-10-06 from the working tree on `main` (uncommitted changes included) and
from the public sources listed in §6. Vendor statements that could not be checked
are marked **(vendor claim)**. "Not documented" means the sources reviewed here do
not mention the capability. It does not mean the product lacks it.*

---

## 1. Summary

The Alignment Designer already covers the core of what Quantm sells. It generates
a family of alternative alignments over a real DEM, keeps each one within its
design standard, and evaluates all of them on one basis: earthworks by volume,
structures, land, a comparative cost, journey time, multi-criteria scoring and a
Pareto front. It differs from the commercial tools in two ways. Its minimum
radius holds *by construction*, through a curvature-limited state-lattice search.
It is also open about its own limits: it reports relaxations, search mode, tie
errors and comparative-only costs. The gaps are elsewhere:

- **Ground model.** It has no geology, no borrow or spoil sites, and no haul
  barriers. Every competitor reviewed that optimises the profile has at least
  borrow and waste pits.
- **Crossings.** Existing roads, railways and canals are treated as per-metre
  penalties. They are not registered, counted or given vertical clearances.
- **Impact metrics.** There are no building counts, no noise screening and no
  carbon figure. Quantm advertises the last two (vendor claim).
- **Uncertainty.** It does not test how robust the ranking is to its own
  order-of-magnitude rates.
- **Visualisation and handover.** A WebGL 3D block view now exists (see P1.1),
  but it exports no clothoid/arc geometry, KML, IFC or glTF.

For Indian HSR studies the priorities follow from the corridors:

- **Delhi – Varanasi.** About 800 km across a plain that falls only about 130 m.
  Terrain hardly separates the options, while settlements, crossings and flood
  levels do.
- **MAHSR.** About 468 of 508 km is elevated and 27 km is underground. The
  vertical design, which a 2D map shows poorly, is what defines the line.

The P1 list below is therefore: the 3D corridor model the user asked for, a
crossing register with clearance bounds, building-footprint exposure, ranking
robustness under rate and weight uncertainty, and better land-cover data.

---

## 2. Trimble Quantm: what it does and its status

**Origin and status.** Quantm began at CSIRO in Australia. Trimble bought it in
2006 and continued developing it at Trimble Alignment Planning Solutions in
Melbourne [W1]. It is still listed as a current product on Trimble's construction
site [T1], and its online help is live [T2]. No end-of-sale or end-of-life notice
was found. Known releases:

- **7.3 (Oct 2012):** added *Quantm Enterprise* (hosted on the customer's
  intranet), an integrated visualisation engine, automated property analysis
  ("all affected land parcels and property owners for each alignment
  alternative"), and a free viewer [T3].
- **8 (Dec 2014):** added data exchange with Bentley OpenRoads, satellite-image
  overlays and SketchUp models [T4].

The product page now also lists *Quantm Corridor*, a lighter edition for
early-phase corridor work that ships with Trimble Quadri [T1][T5]. The algorithm
itself is proprietary and is not described in any source reviewed.

**What it does** (from the help system and the product page):

| area | Quantm capability | source |
|---|---|---|
| Inputs | Terrain models, CAD/GIS (DXF, DWG, SHP, DGN, i-model), orthophotos and satellite imagery, geotechnical and hydrological data, existing features, property boundaries | [T2] |
| Zones | Sensitive areas can be *protected* (Avoid Zones), *costed* (run with and without the constraint) or *modelled* (extra land or mitigation cost) | [T2] |
| Features | Linear objects to be crossed (road, rail, river, power, cable, pipe, other). Each has a crossing type (at grade, over, under, culvert) and a clearance, and can act on earthworks: borrow pit, dump site, haul **barrier**, import/export | [T7] |
| Geology | Layered strata by material and thickness. Each material is *strip* (must go to dump) or *ordinary*, with cut side slopes, a fraction usable as fill, a compaction factor, and benches. Cross-sections are taken every 20 m | [T8] |
| Optimisation | *Unseeded*: searches the whole study area and returns up to 50 alignments from the hosted service, or 25 from Quantm Desktop. *Seeded*: works around a 3D seed line in *Total*, *Vertical only* or *Local* mode. *Realignment*: reuses parts of an existing line. Advertised as "millions of alternatives" and "true 3-dimensional" optimisation **(vendor claim)** | [T1][T9][T10][T14] |
| Earthworks | Cut, fill, borrow, dump and haul volumes and costs; mass-flow diagram; barriers stop haul across a feature | [T11][T12] |
| Structures | Retaining walls, culverts, bridges, tunnels | [T2][T12] |
| Cost | Unit costs; earthworks by material; structures (culvert, bridge, tunnel, wall); area, linear and fixed costs; land expropriation; pavement, track and ballast | [T1][T6] |
| Environment | CO2 calculator for construction and operation; noise ("analyze how noise will affect the community"), method not documented **(vendor claim)**; traffic and vehicle parameters | [T1] |
| Review | Plan, profile and cross-section views; 3D drive-through animations; comparison of alignments; cost-summary reports; manual editing with cost shown as you edit | [T2][T13] |
| Outputs | LandXML, DXF, Esri Shape, Google Earth, Terramodel. Two-way links with Quadri, Civil 3D, MicroStation, OpenRoads/OpenRail, TBC and Tilos | [T1][T2] |

---

## 3. Comparable tools

| tool | what it is for | distinctive features | source |
|---|---|---|---|
| **Autodesk InfraWorks** | Conceptual design of roads and infrastructure in a 3D context model | *Model Builder* assembles a model from an area of interest: 10/30 m DEM, Bing imagery, and OSM roads, rail, buildings and water. *Corridor Optimization* finds a horizontal path inside a user-drawn boundary from design speed, maximum grade, minimum radius, cost zones and suitability maps. *Profile Optimization* uses anchored PVIs, borrow/waste pits (location, access distance, capacity), bridge and tunnel rules and unit costs. Both now run locally (they used to be cloud services) | [A1][A2][A3] |
| **Bentley OpenRail ConceptStation** | Conceptual rail design | Imports reality meshes, point clouds and imagery. Interactive 3D layout of track, bridges, tunnels, overhead line and platforms. Real-time preliminary cost, which can use your own historical bid tabulations. Cut/fill quantities, photoreal renders and video, handover to OpenRail Designer | [B1] |
| **Softree RoadEng + Optimal** | Road design, from forestry and rural roads to highways | Patented vertical optimisation with mass-haul balancing, presented as having a "guarantee of optimality" **(vendor claim)**. Horizontal optimisation moves IPs within a set range. *Path Explorer AI* for corridor discovery. Claims 10–30 % savings on vertical construction cost **(vendor claim)** | [S1][S2] |
| **Continuum Industries Optioneer** | Cloud routing and site selection. Now marketed mainly to utilities; earlier material also lists railways and roads | 11,000+ dataset library **(vendor claim)**, built-in engineering rules, resistance maps, near-optimal corridor bands (1–20 % above optimum), site selection, team workspace with SSO, report writer | [C1][C2][C3] |
| **Esri ArcGIS Pro (Spatial Analyst)** | General GIS least-cost analysis | *Distance Accumulation*, *Optimal Path As Line* and *Least Cost Corridor* work cell to cell, with no curvature constraint. Users smooth the result afterwards and check it stays inside the corridor | [E1][E2][E3] |
| **Trimble Quadri** | Civil BIM collaboration platform | Hosts Quantm Corridor. Two-way terrain and GIS exchange with Quantm | [T1][T5] |
| **Research** | Published methods | MILP earthwork allocation with borrow and waste pits [R1][R2]. Corridor-bounded horizontal optimisation [R3]. A convex joint vertical-alignment and earthwork model [R4]. 3-D railway alignment optimisation with environmental suitability [R5]. Bridges and tunnels inside alignment optimisation [R6]. Simultaneous 3-D highway alignment by evolutionary search: Jong & Schonfeld, *Transportation Research Part B* 37(2), 2003 | — |
| **CesiumJS / glTF** | Building blocks for 3D, not competitors | Apache-2.0 3D globe and terrain library. glTF and 3D Tiles (an OGC community standard) as open 3D exchange formats | [V1] |

---

## 4. Feature matrix

"Yes", "Partial" and "No" describe what the sources show, not a hands-on test.
The *This tool* column reflects the working tree at the end of the session
(updated after the 3D view, the vertical policies and the environmental layers
landed).

| capability | Quantm | InfraWorks | OpenRail ConceptStation | Optioneer | **This tool** |
|---|---|---|---|---|---|
| **Terrain / DEM** | Yes: terrain models and imagery [T2] | Yes: Model Builder fetches 10/30 m DEM and imagery [A3] | Yes: meshes, point clouds, imagery [B1] | Partial: in its data library (vendor claim) [C1] | **Yes.** Copernicus GLO-30/90 fetch; any GeoTIFF, ASC or HGT, mosaicked; cell-averaged; UTM. Grid capped at about 4.5 M cells, so about 275 m cells on an 800 km corridor |
| **Constraints** | Yes: Avoid Zones (protect, cost or model), crossing features with clearances [T2][T7] | Yes: cost zones, suitability maps [A1] | Partial: GIS import [B1] | Yes: GIS resistance maps [C2] | **Partial.** 13 weighted coverage layers plus a hard exclusion layer; OSM fetch; mangrove, wetland and a CRZ proxy (coastline buffer + mangrove buffer, or an authoritative CRZ file). No crossing objects or clearances |
| **Geology** | Yes: layered strata, strip vs ordinary material, usable fraction, benches [T8] | Not documented | Not documented | Not documented | **No.** One excavation rate; structure thresholds depend on rates only |
| **Horizontal optimisation** | Yes: unseeded, seeded, realignment [T9][T10] | Yes: Corridor Optimization within a boundary [A1] | Partial: interactive layout and scenarios [B1] | Yes: routing over many options [C1] | **Yes.** State-lattice A* with R ≥ R_min by construction; ε escalation; relaxations reported; legs routed one after another |
| **Vertical optimisation** | Yes: 3D, plus a "Vertical only" mode [T10] | Yes: Profile Optimization [A2] | Partial: interactive [B1] | Not documented | **Partial.** The profile is a feasible fit by alternating projection (follow the ground, elevated by default, bored tunnel legs, fixed levels and an existing design's given levels as bounds). It does not minimise cost, and horizontal and vertical are solved in sequence |
| **Structures** | Yes: walls, culverts, bridges, tunnels [T12] | Yes: bridge and tunnel rules [A2] | Yes: bridges, tunnels, overhead line, platforms [B1] | Not documented for rail | **Partial.** Viaduct, bridge, tunnel, embankment, cutting and at-grade classified from depth and land sensitivity; tunnel portals. No retaining walls, culverts or ROB/RUB |
| **Earthworks and mass haul (borrow/spoil)** | Yes: borrow, dump, barriers, import/export [T7][T11] | Yes: borrow/waste pits with capacity [A2] | Partial: cut/fill [B1] | Not documented | **Partial.** Prism volumes (W·h + m·h²), swell, mass-haul curve, haul as the area under it. No borrow or spoil sites, barriers or material classes |
| **Cost model** | Yes: unit costs incl. land and track [T1] | Yes: unit costs [A2] | Yes: bid-history costing [B1] | Yes (vendor claim) [C1] | **Yes, comparative only.** Per-km structure rates, volume rates, haul, land, built-up land, portals, indirect-cost factor; all editable and labelled comparative |
| **Risk / uncertainty** | Not documented | Not documented | Not documented | Not documented | **Partial.** Reports relaxations, ε and tie errors. No probabilistic ranking |
| **Environment and social** | Yes: environmental zones; parcel and owner analysis [T3] | Partial: through cost zones [A1] | Not documented | Yes [C2] | **Partial.** Hectares of settlement and environmental land as criteria; impact by class. No building or parcel counts |
| **Noise / visual** | Partial: noise (vendor claim, method undocumented) [T1] | Not documented | Partial: renders for communication [B1] | Not documented | **No** |
| **Carbon** | Yes: CO2 calculator (vendor claim) [T1] | Not documented | Not documented | Not documented | **No** |
| **Multi-option and MCA** | Yes: 10–50 ranked options [T9] | Partial: several corridors with costs [A1] | Yes: scenarios [B1] | Yes: option shortlist, resistance themes [C2] | **Yes.** 10 options across speed × priority × corridor position; 6-criterion weighted score; Pareto front on cost, time and impact |
| **3D visualisation** | Yes: 3D views, drive-through, Google Earth [T1][T2] | Yes: 3D model is the core of the product [A3] | Yes: photoreal, video [B1] | Not documented | **Partial.** 2D hypsometric map, zoomable long section, mass-haul chart, and a WebGL 3D block view (terrain with draped layers, line at design level coloured by structure, piers, tunnels dashed or in x-ray, other options as lines). No drive-through, glTF or Google Earth export |
| **Outputs / BIM** | LandXML, DXF, SHP, Google Earth; links to Civil 3D, OpenRoads, Quadri [T1] | Not reviewed | Handover to OpenRail Designer [B1] | Report writer [C2] | **Partial.** 3D DXF layered by structure; LandXML with densified lines and PVIs (no arcs, spirals or parabolas); CSV; GeoJSON in the project CRS; drawing-sheet PNG; georeferenced PNG; study JSON. No KML, IFC or glTF |
| **Collaboration** | Enterprise intranet hosting, free viewer, Quadri [T3][T5] | Model must be uploaded to Autodesk cloud for optimisation [A1] | Not documented | Yes: SSO, shared workspace [C2] | **No.** Single-user local app; JSON export |
| **Data connectors** | CAD/GIS import, imagery, Quadri [T2] | Model Builder: DEM, imagery, OSM [A3] | Reality data [B1] | 11,000+ datasets (vendor claim) [C1] | **Partial.** Copernicus DEM (AWS), OSM Overpass (9 classes), any GeoJSON per layer |
| *Design standards and running time* (extra row) | Geometric parameters, vehicle parameters [T1] | Design speed, grades [A1] | Not documented | Engineering rules [C1] | **Yes.** Standards derived from published rules for 5 modes; trapezoidal speed profile with curve-speed caps, acceleration, braking and dwell; journey time |

---

## 5. Gap analysis and recommendations

Effort: **S** is up to about 2 days, **M** up to about 2 weeks, **L** more than 2
weeks. Invariant numbers refer to `CLAUDE.md`. Every new metric belongs in the
Results tab, the CSV and the study JSON. Every new layer or flag needs a line in
the README (*Honest limits* where it is a proxy).

### P1: do next

#### P1.1 3D corridor model of the alignment and the surrounding terrain *(user-requested; first version built: `designer/js/view3d.js`. Still open from this item: glTF export, the ground curtain and a drive-through)*

- **What.** A WebGL view of the DEM around the line with:
  - the design alignment at design level, coloured by structure;
  - viaduct piers;
  - embankment and cutting batters meeting the ground;
  - tunnels shown under a terrain whose opacity can be adjusted;
  - stations as labelled markers;
  - the other options as thin lines;
  - constraint layers draped on the terrain.

  The camera orbits, pans and flies along the chainage. Vertical exaggeration is
  adjustable and always shown on screen.
- **Why.**
  - *Delhi – Varanasi:* the ground falls only about 130 m over 800 km
    (`studies/delhi_varanasi/README.md`). On a 2D hillshade the relief cannot be
    seen. With stated exaggeration the 3D view shows why one reach is on
    embankment and another is on viaduct.
  - *MAHSR:* about 468 of 508 km is elevated and 27 km is underground [I2]. The
    vertical design *is* the alignment.
  - *Consultation:* this is the feature Quantm (drive-through) and ConceptStation
    (renders) offer for stakeholder meetings [T2][B1].
  - *Survey detail:* NHSRCL's aerial LiDAR for Delhi – Varanasi gives 1:2,500 3D
    mapping of ±50 m around the alignment [I1]. The importer already reads LiDAR
    exports, and a chainage-windowed 3D view is how that detail becomes visible.
- **Fit.**
  - *New module:* `designer/js/view3d.js` exposing `VIEW3D`, loaded after
    `render.js` and before `export.js`/`app.js`. Update the load order in
    `CLAUDE.md` and the `?v=` cache-bust in `index.html`.
  - *Terrain:* from `ENGINE.G.layer.dem` (row-major from the NW corner,
    `A[iy*nx+ix]`, `G.cell`, `G.xmin`, `G.ymax`). Crop to the alignment plus a
    buffer and keep the mesh under a fixed vertex budget. On an 800 km corridor,
    show only the chainage window the long section is displaying (`chartWindow`
    in `render.js`), at full grid resolution.
  - *Texture:* the canvases from `demOverlay()` and `layerOverlay()`, so the 3D
    view uses the same colour limits and colours as the map and the printed
    sheets.
  - *Line geometry:* the ribbon width is `std.width`. The batters come from the
    same `prismArea` side slope that `costs.js` prices, so the 3D view shows
    exactly the geometry that is costed. Add a ground "curtain" between `vp.z`
    and the ground along the centreline: the long section, stood up in 3D.
  - *Hover:* synced with `hoverIdx` in `app.js`.
  - *Exports:* a PNG snapshot and a glTF 2.0 `.glb` of the terrain tile plus the
    alignment meshes, viewable in any glTF viewer, Blender or CesiumJS [V1].
  - *Implementation:* raw WebGL2 (32-bit indices; no build step and no npm,
    consistent with the decision not to ship third-party zlib), or one vendored
    file with its licence.
- **Effort.** M for terrain, drape, ribbon, curtain and hover sync. L with batters,
  piers, tunnel x-ray and glTF.
- **Invariants.**
  - **1:** display only. Nothing drawn in 3D may feed back into the search or the
    profile, and the ribbon must use the lattice path as computed (no visual
    smoothing that hides a corner).
  - **5:** show relaxed legs (`search.relaxed`), the tie error and the ε used.
    Show the exaggeration factor.
  - **4:** any cost shown in a tooltip is labelled comparative.

#### P1.2 Crossing register and vertical clearance bounds

- **What.**
  - Detect every crossing of an existing road, railway, river or canal along the
    alignment and list it with chainage, feature class and crossing type
    (over, under or at grade, from the design level against the ground).
  - Count crossings per option and give each a per-crossing structure cost
    (ROB/RUB, bridge).
  - Where the line passes *over* a feature, add a lower bound of feature level
    plus clearance at that chainage. This is the same idea as Quantm's crossing
    features [T7].
- **Why.** A high-speed line is fully grade-separated, so on the Gangetic plain
  every highway, railway and canal is both a structure and a vertical control
  point. Today they are only per-metre penalties (`road_major` 6, `rail` 5), so
  two options with very different crossing counts can score the same.
- **Fit.**
  - Crossing detection in `engine.js` from the existing `road_major`, `rail`,
    `river_major` and `water_body` layers.
  - A clearance bound in `policyFor`: it already builds the `lo`/`hi` arrays,
    and a lower bound is convex, so the alternating projection still converges.
  - Count and cost in `costs.js`; a register table in the Results tab.
  - To tell a canal from a river and an expressway from a state highway, the
    importer must carry the OSM class as a value, not just coverage
    (`dempack.py` rasterisation, `fetch_osm.py` already keeps tags).
- **Effort.** M.
- **Invariants.**
  - **3:** clearances are bounds, not ties to ground. Do not pin stations.
  - **5:** report where a clearance could not be met; the profile already has
    `boundError`/`boundAt`.

#### P1.3 Building-footprint exposure

- **What.**
  - Count the buildings inside the land-take width and inside a wider buffer
    (for example, the noise screening band of P2.4) for each option, as a
    criterion and a Results line.
  - Optionally use building density in place of the binary `built` coverage in
    the cost surface.
- **Why.**
  - At about 275 m cells, `built` cannot tell a village edge from its centre,
    yet it is weighted 60× open ground.
  - OSM village extents are uneven (`fetch_osm.py` docstring).
  - Google Open Buildings v3 covers India (CC BY 4.0) [D5].
  - It is the closest free substitute for Quantm's parcel analysis [T3].
    Cadastral data (state Bhu-Naksha portals) is not uniformly accessible.
- **Fit.**
  - A new `--buildings` flag in `import_dem.py`.
  - `dempack.py` rasterises a per-cell count or roof area as a `u16` layer.
  - `costs.js` adds the count to `impacts` and a `CRITERIA` entry, and
    `render.js` adds a layer style.
  - Data: Open Buildings polygons or OSM `building=*`.
- **Effort.** M (most of it is the import of large polygon files).
- **Invariants.**
  - **4:** report counts, not compensation costs.
  - **5:** state the source and its inference date (May 2023) in the project
    notes.

#### P1.4 Ranking robustness under rate and weight uncertainty

- **What.**
  - Re-score the option family N times (no re-routing), with:
    - each rate drawn from a user range, for example −30 %/+50 % on tunnel;
    - the criteria weights perturbed around the chosen set.
  - Report for each option the probability of ranking first, its rank range,
    and how often it is on the Pareto front.
  - Add a tornado chart showing which rate flips the top two options.
- **Why.** The rates are order-of-magnitude benchmarks
  (`standards.js` `RATES`/`QRATES`, from DfT/PwC international benchmarking),
  and no Indian rate build-up exists yet. "Option C wins in 85 % of draws" is a
  claim a comparative model can honestly make. No competitor reviewed documents
  this, so it would be a differentiator.
- **Fit.** `costs.js` (`score`, `pareto` re-run per draw) and `study.js` (driver).
  `evaluate` is cheap next to routing. Results go to the Options tab and the
  study JSON.
- **Effort.** S–M.
- **Invariants.**
  - **4:** output ranks and probabilities, never a P50/P90 *cost* presented as an
    estimate.
  - **5:** state the ranges used.

#### P1.5 Authoritative land-cover connectors

- **What.**
  - A `fetch_worldcover.py`, or `--worldcover` in `import_dem.py`, reading ESA
    WorldCover 10 m tiles. The classes needed are built-up, cropland, tree cover,
    herbaceous wetland, mangrove and water; tiles are 3°×3° COGs [D3].
  - `--mangrove` documented against Global Mangrove Watch, which ships GeoTIFF
    and vector and has annual extents [D4].
  - WDPA for `--protected` [D6].
- **Why.**
  - OSM is uneven across rural India (README; `fetch_osm.py`).
  - Mangroves are CRZ-IA on the MAHSR coastal reach, already weighted 60.
  - WorldCover "cropland" is a better `farmland` layer than OSM on the plain.
- **Fit.** The importer already takes any GeoJSON per layer. A raster land-cover
  reader goes in `dempack.py` next to the DEM readers and is averaged per cell
  the same way. No engine change.
- **Effort.** S–M.
- **Invariants.** **5:** record layer provenance in the project `notes` and show
  it in the Layers tab.

### P2: high value, after P1

#### P2.1 Borrow and spoil sites and haul barriers in the mass haul

- **What.**
  - User-placed borrow and spoil sites (point, capacity, access distance).
  - Haul barriers at major rivers and at crossings from P1.2.
  - Earthwork allocation per balanced section: greedy, or the transport LP /
    site-selection algorithms in [R1][R2].
  - Haul priced on actual lead rather than on the area under the curve.
- **Why.** On a flat plain an embankment line is almost all fill and the cut is
  negligible, so the current curve "runs away". The imported fill and its lead
  distance are the earthworks cost, and the current haul term misprices them.
  Quantm, InfraWorks and Softree all model this [T7][A2][S1].
- **Fit.** `costs.js` `evaluate`, which already holds `massHaul`, `swell`, `cutM3`
  and `fillM3`. Sites are an extra list in the project or study config (GeoJSON
  or click-to-place in `render.js` like control points). Drawn on the mass-haul
  chart.
- **Effort.** M.
- **Invariants.** **4** (comparative).

#### P2.2 Design flood level as a vertical lower bound

- **What.** The formation must stay above design flood level plus freeboard
  wherever the line crosses a flood polygon or raster (`--hfl` with a level
  attribute). The existing HAND proxy remains as a flagged fallback.
- **Why.** The Yamuna and Ganga floodplains and the Prayagraj and Varanasi
  approaches decide embankment height or viaduct there. Today `flood` is only a
  per-metre penalty.
- **Fit.** `policyFor` in `engine.js` adds `lo[i] = max(lo[i], HFL + freeboard)`.
  This is convex, so it fits the alternating projection. Import in
  `import_dem.py`/`dempack.py`.
- **Effort.** M.
- **Invariants.**
  - **3:** a bound, not a tie.
  - **5:** report chainages where the bound binds or fails.
  - Keep the README's "flood layer is a proxy" line accurate.

#### P2.3 Geology and ground-condition classes

- **What.**
  - A categorical layer: for example alluvium, soft or marine clay, weathered
    rock, hard rock.
  - Per-class cut rate, fraction usable as fill, tunnel-rate multiplier, and a
    viaduct foundation factor.
  - A simplified form of Quantm's strata model [T8].
- **Why.** Ground conditions are one of the two things the README says the
  structure rules leave out. They matter more on MAHSR (creek and coastal
  ground, rock towards the ghats) than on the Delhi – Varanasi alluvium.
- **Fit.**
  - Import from GSI Bhukosh lithology (1:50K/1:2M; registration needed to
    download) [D2] with a class-mapping file.
  - `dempack.py` writes a `u8` class layer.
  - `costs.js` applies per-class rates, and `structureThresholds` may take
    per-class `cutTunnel`.
- **Effort.** M–L.
- **Invariants.** **4**; README *Honest limits* updated.

#### P2.4 Noise screening

- **What.** For every non-tunnel sample, measure built-up cover (or buildings,
  from P1.3) within the FRA screening distance for the speed and area type. For
  170 mph and above (≈ 274 km/h) that is 300–1,200 ft [N1]. Report km of line
  and receptors inside the band, as a criterion.
- **Why.** Both corridors run at 320 km/h. Quantm advertises noise analysis
  [T1]. Screening is the stage of the FRA method that fits a corridor study.
- **Fit.** `costs.js` (`impacts`), using `E.sample('built', …)` along offset
  lines.
- **Effort.** S.
- **Invariants.** **5:** label it a screening proxy, not a noise prediction.

#### P2.5 Embodied carbon (comparative)

- **What.** tCO2e per km of each structure type, per m³ of cut and fill, and per
  m³·km of haul, added as a criterion. Framed against PAS 2080 [N2]. Equivalent
  to Quantm's CO2 calculator [T1].
- **Why.** On an elevated corridor the viaduct-versus-embankment decision sets
  most of the embodied carbon, and lenders and clients now ask for it.
- **Fit.** A `CARBON` table in `standards.js` next to `RATES`, `evaluate` in
  `costs.js`, a `CRITERIA` entry, and an editable panel in the Priorities tab.
  The defaults must cite a source or start blank. Do not invent factors.
- **Effort.** S–M.
- **Invariants.** **4:** comparative wording, as for cost.

#### P2.6 Seeded and local re-optimisation around an existing design

- **What.**
  - Search only within a band of ±X m around a seed polyline: the reference, or
    a chosen option.
  - Also a "vertical only" mode that keeps the plan and re-fits the profile.
  - These are Quantm's *Seeded*, *Vertical* and *Local* modes [T10].
- **Why.** The MAHSR C-4 as-designed line (`studies/mahsr/extract_reference.py`)
  could be compared with the best line the tool finds within, say, ±500 m of it.
  The difference measures the headroom in the existing design.
- **Fit.** `engine.search` already takes `opt.corridor`. Add a band mask built
  from the seed, used in the cost grid and in `costToGo`. Vertical-only is
  `evaluateReference` with a policy.
- **Effort.** M.
- **Invariants.**
  - **1:** radius by construction still holds; the band only restricts cells.
  - **6:** a narrow band that runs out of budget is `capped`, not infeasible.
  - **7, 8:** the balloon guard and the min-pooled arrival-disc heuristic apply
    unchanged.

#### P2.7 Design-geometry fit for export (arcs, clothoids, parabolic vertical curves)

- **What.**
  - A separate *export representation*: IPs with circular arcs and clothoid
    transitions fitted to the lattice path within a stated offset tolerance, and
    PVIs with parabolic curves.
  - Written to LandXML as `Curve`, `Spiral` and `ParaCurve` elements instead of
    densified `Line`s and PVIs.
- **Why.** The README notes transition lengths are reported but not drawn. A
  geometry that Civil 3D, OpenRail or 12d can edit directly saves the detailed
  designer from re-drawing it.
- **Fit.** A new fit routine (in `engine.js` or a new `geometry.js`), with
  `export.js` writing it.
- **Effort.** M–L.
- **Invariants.**
  - **1:** the fit must never replace the search result. Check every fitted arc
    against `rMin` and report the maximum offset; if it cannot fit within
    tolerance, say so.
  - **5.**

#### P2.8 KML/KMZ export

- **What.** The alignment as a 3D LineString coloured by structure, with
  stations and options. This is Quantm's Google Earth export [T1].
- **Why.** Google Earth is the common stakeholder viewer.
- **Fit.** `export.js`. Needs an inverse transverse-Mercator in JS: today
  GeoJSON is written in the project CRS and only `dempack.py` has the
  projection, in Python. The heights are EGM2008 (Copernicus) [D7]; state the
  datum.
- **Effort.** S–M.

### P3: later or optional

- **P3.1 IFC 4.3 `IfcAlignment` export** (ISO 16739-1:2024) [N3], for BIM
  handover. `export.js`, after P2.7. Effort M.
- **P3.2 Cost-optimal vertical profile.** An LP/QP (or a projection with a cost
  term) that minimises earthworks plus structure cost under the same grade,
  curvature and policy bounds, instead of following the ground. See [R4] and
  InfraWorks/Softree [A2][S1]. `engine.verticalProfile`. Effort L.
  - **Invariant 3:** only the two ends tied.
  - Re-check the validation anchors: London vertical R, demo 52.65 km.
- **P3.3 Traction energy and operational carbon** from the existing
  `speedProfile` (resistance plus gradient terms). Effort M. Comparative wording.
- **P3.4 Station-site sweep.** Candidate sites on a ring around each city become
  another option axis in `study.js`. The Delhi – Varanasi README notes that
  station position "decides most of what the alignment does". Effort M–L.
  - **Invariant 3:** do not tie stations.
- **P3.5 Shared read-only study viewer** (a published snapshot of the option
  study with the 3D view), in place of Quantm's free viewer and Optioneer's
  workspace. Effort M.
- **P3.6 Simultaneous 3-D search** (Jong & Schonfeld style). Listed for
  completeness. It does not fit a browser's memory, which is the reason for the
  existing *Honest limits* entry. Not recommended now.

**Not recommended:**

- Chasing "millions of alternatives" as a feature; it is a vendor metric, not a
  capability.
- Parcel and owner analysis before cadastral access is settled.
- A PM Gati Shakti connector unless the user has government portal access. The
  platform is login-only [D1].

---

## 6. Sources

Trimble Quantm:
- [T1] https://construction.trimble.com/en/products/quantm
- [T2] https://quantmhelp.trimble.com/introduction
- [T3] https://www.prnewswire.com/news-releases/trimble-expands-alignment-planning-product-line-with-quantm-enterprise-172437191.html
- [T4] https://www.prnewswire.com/news-releases/trimble-increases-alignment-planning-capabilities-for-roads-and-railways-with-its-quantm-software-300012351.html
- [T5] https://construction.trimble.com/en/products/quadri
- [T6] https://quantmhelp.trimble.com/Manage-Data/Cost-Data
- [T7] https://quantmhelp.trimble.com/Manage-Data/Object-Data/Features-Object-data
- [T8] https://quantmhelp.trimble.com/Manage-Data/Cost-Data/Geotechnical-costs
- [T9] https://quantmhelp.trimble.com/Create-and-Submit-Jobs/Unseeded-optimization
- [T10] https://quantmhelp.trimble.com/Create-and-Submit-Jobs/Seeded-optimization/Total-vertical-or-local-optimization ; https://quantmhelp.trimble.com/Create-and-Submit-Jobs/Seeded-optimization/Realignment
- [T11] https://quantmhelp.trimble.com/Earthmoving/Earthmoving ; https://quantmhelp.trimble.com/Earthmoving/Earthmoving/Mass-Haul-Diagram
- [T12] https://quantmhelp.trimble.com/Review-Results/Alignment-summary
- [T13] https://www.forconstructionpros.com/construction-technology/product/11292898/trimble-navigation-ltd-quantm-alignment-planning-system
- [T14] https://www.trimble.com/en/resources/construction/docs/trimble-quantm-brochure
- [W1] https://en.wikipedia.org/wiki/Quantm

Comparable tools:
- [A1] https://help.autodesk.com/cloudhelp/ENU/InfraWorks-RoadsandHighways/files/GUID-E8F9C05D-6AC6-4662-80AF-5E190DC58E67.htm
- [A2] https://help.autodesk.com/cloudhelp/ENU/InfraWorks-RoadsandHighways/files/GUID-3187F97E-6654-4D04-B919-8CC7B450D120.htm
- [A3] https://help.autodesk.com/cloudhelp/ENU/InfraWorks-Basics/files/GUID-071FB6F4-AE4A-4F3D-8869-9F39D9988561.htm
- [B1] https://www.bentley.com/software/openrail-conceptstation/
- [S1] https://www.softree.com/products/optimization
- [S2] https://sourceforge.net/software/product/Softree-Optimal/
- [C1] https://www.continuum.industries/en-us
- [C2] https://www.continuum.industries/en-us/blog/winter23-feature-release-part1
- [C3] https://creativedestructionlab.com/companies/continuum-industries/
- [E1] https://pro.arcgis.com/en/pro-app/latest/tool-reference/spatial-analyst/optimal-path-as-line.htm
- [E2] https://pro.arcgis.com/en/pro-app/latest/tool-reference/spatial-analyst/how-distance-accumulation-works.htm
- [E3] https://community.esri.com/t5/arcgis-spatial-analyst-questions/creating-least-cost-path-based-on-slope-and/td-p/1341790
- [V1] https://github.com/CesiumGS/cesium ; https://cesium.com/why-cesium/3d-tiles/

Research:
- [R1] https://www.researchgate.net/publication/220288928_Models_and_algorithms_to_improve_earthwork_operations_in_road_design_using_mixed_integer_linear_programming
- [R2] https://link.springer.com/article/10.1057/s41274-016-0140-0
- [R3] https://arxiv.org/pdf/1507.02714
- [R4] https://arxiv.org/pdf/2508.15953
- [R5] https://journals.sagepub.com/doi/abs/10.3233/ICA-220692
- [R6] https://ascelibrary.org/doi/abs/10.1061/(ASCE)0733-947X(2007)133:2(71)

Standards and methods:
- [N1] https://railroads.dot.gov/sites/fra.dot.gov/files/fra_net/2680/20120220_FRA_HSR_NV_Manual_FINAL_102412.pdf
- [N2] https://www.bsigroup.com/siteassets/pdf/en/insights-and-media/insights/brochures/pas_2080.pdf
- [N3] https://www.buildingsmart.org/ifc-4-3-approved-as-a-final-standard/

Indian corridors and data:
- [I1] https://www.pib.gov.in/Pressreleaseshare.aspx?PRID=1678878 ; https://nhsrcl.in/en/media/press-release/nhsrcl-adopts-aerial-lidar-survey-technique-conduct-ground-survey-delhi (Delhi – Varanasi aerial LiDAR: 150 m either side; 1:2,500 3D mapping of ±50 m)
- [I2] https://themetrorailguy.com/nhsrcl-mumbai-ahmedabad-high-speed-rail-information-route-map-fares-timings-tenders-status-updates/ ; https://en.wikipedia.org/wiki/Mumbai%E2%80%93Ahmedabad_high-speed_rail_corridor
- [D1] https://pmgatishakti.gov.in/pmgatishakti/login ; https://www.esri.in/en-in/newsroom/blog/gis-for-pm-gati-shakti
- [D2] https://bhukosh.gsi.gov.in/Bhukosh/Public
- [D3] https://worldcover2021.esa.int/ ; https://worldcover2021.esa.int/download
- [D4] https://zenodo.org/records/12756047 ; https://www.eorc.jaxa.jp/ALOS/en/dataset/gmw_e.htm
- [D5] https://sites.research.google/gr/open-buildings/ ; https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_Research_open-buildings_v3_polygons
- [D6] https://www.protectedplanet.net/
- [D7] https://dataspace.copernicus.eu/sites/default/files/media/files/2024-06/geo1988-copernicusdem-spe-002_producthandbook_i5.0.pdf
