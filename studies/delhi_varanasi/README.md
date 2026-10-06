# Delhi – Varanasi high-speed rail: corridor study

A working set-up for generating and comparing alignment options for the Delhi –
Varanasi high-speed rail corridor in the Alignment Designer, from free data.

| file | what it is |
|---|---|
| `stations.csv` | control points: stations, airport, termini. **Edit this.** |
| `raw/dem/` | Copernicus DEM tiles (downloaded, not in git) |
| `raw/osm/` | OpenStreetMap constraint layers (downloaded, not in git) |
| `../../designer/projects/delhi_varanasi/` | the packed project the designer opens |

Run every command below from the repository root (`Alignment_Designer/`).

---

## 1 · Stations

`stations.csv` has one row per control point, with **named** columns:

```
name,lat,lon,kind,note
Agra,27.1767,78.0081,station,city centre
```

`lat` and `lon` are decimal degrees, latitude first as Google Maps copies them;
the columns are matched by name, so their order in the file does not matter.
`kind` is free text (terminal, station, airport).

The rows supplied are a **starting point only**: city-centre coordinates for the
stations reported for the earlier study of this corridor (Delhi – Noida – Jewar –
Mathura – Agra – Etawah – Kannauj – Lucknow – Raebareli – Prayagraj – Bhadohi –
Varanasi). Replace them with the sites actually under discussion. A high-speed
station is rarely in a city centre, and where it sits decides most of what the
alignment does on either side of it.

The order of the rows is the order of the route.

## 2 · Terrain (DEM)

The Copernicus DEM, free and with no login, in 1° × 1° tiles. See what would be
downloaded first:

```bash
python designer/build/fetch_dem.py --controls studies/delhi_varanasi/stations.csv --buffer-km 30 --out studies/delhi_varanasi/raw/dem --dry-run
```

then download it (32 tiles, about 160 MB, GLO-90 at ~90 m):

```bash
python designer/build/fetch_dem.py --controls studies/delhi_varanasi/stations.csv --buffer-km 30 --out studies/delhi_varanasi/raw/dem
```

An interrupted download resumes where it stopped. For detailed sectional work
add `--res 30` (GLO-30, ~30 m, ~42 MB a tile) — only for the section's own box.

The Copernicus DEM is a **surface** model: it includes buildings and trees. The
importer averages it over each design cell, but in dense towns heights stay a
few metres high. On the Gangetic plain the ground falls only ~130 m over the
whole corridor, so terrain will not be what drives the alignment — constraints
will.

## 3 · Constraints (OpenStreetMap)

```bash
python designer/build/fetch_osm.py --controls studies/delhi_varanasi/stations.csv --buffer-km 30 --out studies/delhi_varanasi/raw/osm
```

Six layers, one GeoJSON each: `built` (residential, commercial and industrial
land, plus every city, town, village and hamlet point drawn as a disc — rural
settlement is mostly mapped as points), `water` (rivers, canals, ponds, river
areas), `road` (expressways, NH, SH), `rail` (running lines), `woodland`,
`protected` (sanctuaries, national parks, reserves). It takes several minutes —
the public Overpass service is queried in blocks and is shared, so please don't
re-run it in a loop. Re-running skips layers already downloaded.

OpenStreetMap is uneven: towns and main roads are well mapped; village extents,
canals and forest less so. Where an authoritative layer exists, use it instead —
any GeoJSON in WGS84 or the project CRS works:

| better source | flag |
|---|---|
| WDPA / Protected Planet, or the state forest department, for sanctuaries and eco-sensitive zones | `--protected file.geojson` |
| Land-use / built-up maps (NRSC Bhuvan, ESA WorldCover built-up class) | `--built file.geojson` |
| Wetlands, Ramsar sites, ASI-protected monuments, defence land, airport zones | `--exclusion file.geojson` (no-go) or `--protected` |

An explicit flag overrides the file of the same name from `--osm`.

## 4 · Build the project

```bash
python designer/build/import_dem.py --dem studies/delhi_varanasi/raw/dem --controls studies/delhi_varanasi/stations.csv --buffer-km 30 --osm studies/delhi_varanasi/raw/osm --id delhi_varanasi --name "Delhi - Varanasi HSR" --mode rail_hs --speed 320
```

What it does, and prints as it goes: stitches the tiles; sizes the design grid
to the stations plus 30 km (about 640 × 430 km); projects it to UTM zone 44N
(EPSG:32644) — Delhi is 4° from that zone's meridian, so distances there are
within ~0.15 % of true; chooses the cell size (≈ 275 m — the finest that keeps
the grid inside the ~4.5 M cells a browser handles comfortably); averages the
DEM over each cell; rasterises the constraint layers; derives a floodplain proxy
from the water layer; and checks every station falls inside the grid.

Rebuild after any change to `stations.csv` or the layers — it takes a minute or
two.

## 5 · Design in the designer

Start it (`python serve.py`), choose **Delhi - Varanasi HSR** from the project
list, then:

1. **Standard** — *Railway — high speed*. Set design speed, cant, cant
   deficiency, ruling gradient and the vertical-curve factor to the project's
   design basis; the panel shows the minimum radius and vertical curve radii
   that follow, and the rule each one came from.
2. **Rates** — *Priorities → Cost rates*. Enter rates per km for at-grade,
   viaduct, bridge and tunnel, and per m³ / m² for earthworks and land, from
   your own benchmarks. The figures are in millions of whatever currency you
   enter (₹ 1 crore = ₹ 10 million). They rank options; they are not an
   estimate until the rates are.
3. **Weights** — *Priorities → What the route avoids*. How much the search will
   pay, per metre, to avoid each constraint. These ARE the alignment argument:
   change them and watch where the line goes.
4. **Route the alignment** — the 11 legs are searched in sequence; expect
   tens of seconds. Read the Results tab, the long section and mass haul, and
   the per-station cut and fill.
5. **Generate options** — ten alternatives across design speed, priorities and
   corridor position, each a full route: expect several minutes on a corridor
   this long. Compare them on the **Options** tab; ◆ marks the Pareto front.
6. **Export** — DXF and LandXML for detailed design, CSV and GeoJSON for GIS,
   and *JSON — the whole option study* for the report.

## 6 · Sectional detail

The whole-corridor grid is ≈ 275 m — right for choosing between corridors, too
coarse for setting out. For the section that matters, make a second project
from its own stations at 100 m with the 30 m DEM, e.g. Delhi – Agra:

```bash
python designer/build/fetch_dem.py --bbox 76.9 26.9 78.3 28.8 --res 30 --out studies/delhi_varanasi/raw/dem30
```

```bash
python designer/build/import_dem.py --dem studies/delhi_varanasi/raw/dem30 --controls studies/delhi_varanasi/stations_delhi_agra.csv --buffer-km 20 --osm studies/delhi_varanasi/raw/osm --id dv_delhi_agra --name "D-V: Delhi - Agra (100 m)" --mode rail_hs --speed 320 --cell 100
```

(`stations_delhi_agra.csv` is a copy of `stations.csv` keeping only Delhi to
Agra.)

## Limits worth knowing on this corridor

- **Structures** are chosen from cut/fill depth and land sensitivity. On a
  plain this flat most of the line comes out *at grade*, whereas Indian
  high-speed practice is predominantly elevated (MAHSR is mostly viaduct).
  Until the tool has an "elevated by default" policy, compare options on the
  earthworks and impact figures, and set the at-grade rate to reflect what you
  would actually build.
- **Costs are comparative** — see Rates above.
- **OpenStreetMap completeness** varies district by district; check the layers
  on the map (Layers tab) before trusting an impact figure.
- **The search** is near-optimal, not provably optimal. On a leg ending deep
  inside a large town it may fall back to a faster weighted search; Results
  shows the ε used (*Search mode*). Stations placed at city centres make this
  more likely — real high-speed stations usually sit on the edge of town.
