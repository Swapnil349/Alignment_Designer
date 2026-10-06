# Mumbai – Ahmedabad high-speed rail (MAHSR): designing against a built design

MAHSR is a real high-speed line, about 508 km from Mumbai BKC to Sabarmati, and
most of it is now designed and under construction. This folder sets it up in
the Alignment Designer so the tool can be checked against a line someone has
already designed. It covers three studies:

- **mahsr_s5** is the training section. It is section S5 of package C-4,
  CH 333.6 – 393.7 km, the only stretch with the designed rail levels and
  surveyed ground.
- **mahsr_c4** is the whole of package C-4, Zaroli to Vadodara, on plan.
- **mahsr_mumbai_thane** is a study of the BKC – Shilphata tunnel. There's no
  NHSRCL data for it here, so its reference is built from public sources:
  the line as mapped in OpenStreetMap, plus four published levels. It is
  labelled as an estimate wherever it is shown.

| file | what it is |
|---|---|
| `extract_reference.py` | reads the design data out of CivilWorksApp and writes the reference (below) |
| `private/` | **NHSRCL design data**: `reference_c4.json`, `mahsr_piers.csv`, `mahsr_profile_20m.csv`. Not in git |
| `stations.csv` | the 12 stations of the whole line, in route order |
| `stations_c4.csv` | C-4 as designed: the start of the centre line, then Vapi, Bilimora, Surat, Bharuch and Vadodara |
| `stations_s5.csv` | the two ends of S5 |
| `stations_mumbai_thane.csv` | BKC (underground, 26 m), Vikhroli shaft, the Shilphata portal, Thane, with each leg's vertical policy |
| `build_tunnel_reference.py` | builds `reference_mumbai_thane.json` from OpenStreetMap and published levels (public data, so tracked) |
| `reference_mumbai_thane.json` | the BKC – Thane existing design, *estimated*: the OSM line, levels pinned at BKC, the two shafts and one JICA rail level |
| `dem_tiles_*.txt` | the Copernicus tiles each study needs: ids, sizes, totals and URLs (dry-run listings) |
| `raw/` | downloaded DEM tiles and OSM layers. Not in git |
| `../../designer/projects/mahsr_*/` | the packed projects. Not in git |

Run every command from the repository root (`Alignment_Designer/`).

> **Keep the design data private.** `private/`, `raw/` and `designer/projects/mahsr_*/`
> are in `.gitignore`. Building a project also adds a line for it to
> `designer/projects/index.json`, which *is* tracked, so leave those lines out
> of any commit (`git add -p`).

---

## 1 · What the data is, and what it is not

The data comes from **CivilWorksApp**
(`C:\Users\SWAPNIL\IdeaProjects\CivilWorksApp`). That is a separate project and
must be treated as read only: nothing here writes to it. It holds the NHSRCL
design for **package C-4**, from Zaroli (the Maharashtra – Gujarat border) to
Vadodara, CH 156.600 – 393.735 km. The figures below were all re-checked by
`extract_reference.py`.

**What it has**

- **Centre line, CH 157.000 – 401.002 km (244.0 km).** This is the KML layer
  C-ROAD-CNTR-N: 36 pieces that join into one 1,520-vertex polyline with no
  gaps.
  - Design chainage = 157,000 m + the cumulative **grid** length in UTM 43N
    (EPSG:32643). There are no chainage equations.
  - This was checked by projecting all 1,569 coordinated piers onto the line.
    The chainage residual has an sd of 0.007 m and a maximum of 0.06 m. Lateral
    offsets have a median of 0.014 m and a maximum of 0.14 m.
  - Grid length is not ground length. The scale factor here is 1.00003 –
    1.00019.
- **Rail levels, section S5 only (CH 333.641 – 393.700).**
  - There is a rail level at each of the 1,533 piers, and the S5 grade table:
    VIPs #103 – #116, CH 331.5 – 391.9 km, grades of 0 to 0.75 %.
  - The table gives no vertical-curve radius. Symmetric parabolas of
    **R = 25,000 m** at every VIP rebuild every pier rail level to
    **0.6 mm rms (6.6 mm max)**. Without the curves the error reaches 0.13 m at
    the VIPs.
- **Surveyed ground level** at 1,531 S5 piers (GL is missing at 384P28 and
  385P01).
- **Structures**: the span type of every span on C-4, merged into runs.
  - Viaduct (FSLM / SBS / CEM): 227.8 km in 32 runs.
  - River bridges: 15 runs, 5.2 km.
  - Special steel and PSC spans of 40 – 130 m: 11 runs, 2.0 km.
  - 4 elevated stations, 1.7 km.
  - Mountain tunnel MT-08: 350 m at CH 156.70 – 157.05.
  - Earthwork: 45 m.
- **Stations**: Vapi, Bilimora, Surat and Bharuch, each placed at the middle of
  its chainage extent.

**What it is not**

- **No levels outside S5.** S1 – S4 (CH 156.6 – 333.6) have span types only.
  That includes all four stations.
- **No Mumbai – Zaroli data at all (CH 0 – 156.6).** That stretch includes the
  BKC underground station, the 21 km BKC – Shilphata tunnel with ~7 km under
  Thane Creek, and the Thane, Virar and Boisar stations.
- **No Vadodara – Sabarmati data** (beyond about CH 401).
- **Vadodara station is not in the data.** It is put at CH 397.0, beside
  Vadodara Jn, and marked `approximate`. Wikipedia's coordinate falls on the
  line at about CH 397.55.
- **No horizontal curve table.** Only the polyline exists. The arcs are
  R 6,000 m and R 8,000 m with transitions of ~600 – 650 m, recovered
  approximately from the geometry.
- **Vertical datum not stated.** Rail and ground levels are presumably the
  project datum, ~MSL.
- **No environmental layers, ROW or river levels.** The Vishwamitri river layer
  is plan only.
- **The DEM is a surface model, not ground.** Copernicus is a DSM (trees and
  buildings) on EGM2008. The surveyed GL at the S5 piers is what you calibrate
  it against. A build with `--reference` reports DEM − GL there.

**Corrections applied.** Each one is also listed in the reference's `notes`.

- **367P13 rail level:** 32.8 → 31.8. This is a 1.000 m typo on a 22 km level
  grade.
- **391P13 chainage:** pier_geom gives 391,472 and piers_master gives 391,477.
  This is a revision of the pier position, not of its level, and pier_geom is
  used.
- **343P25 and 343P26 KML points** are 2.9 m and 5.0 m off their own EAST/NORTH.
  The attributes are used.
- **Chainages near the stations** in piers_master alternate by ±1 m. The
  structure runs are snapped so they meet.

**What the existing design did (S5).** These are useful targets for the
designer:

- **Rail above ground:** 8.1 – 25.9 m, median 11.75 m. The minimum is at the
  sags of the grade line, which is set just to clear ground plus a ~4 m pier.
- **Grades:** at most 0.75 %. Grade lengths run from 2 to 22.3 km.
- **Viaduct depth:** rail − pier-cap top is 3.95 m on FSLM 40 m spans.
- **Horizontal:** R 6,000 – 8,000 m with ~600 m transitions. The line is
  almost entirely viaduct.

## 2 · Extract the reference

```bash
python studies/mahsr/extract_reference.py
```

`--civilworks PATH` points it at another copy of CivilWorksApp, and `--out DIR`
writes somewhere else (the default is `studies/mahsr/private/`). It needs
numpy only and takes a few seconds. It writes:

- **`reference_c4.json`**, the file that `import_dem.py --reference` reads. It
  holds:
  - `pts`, in UTM 43N, with `chainage_start_m` 157000
  - `stations`
  - `profile`: the S5 VIP table with `vc_radius_m` 25000. The importer expands
    it to 20 m points.
  - `structures`, `ground` and `notes`
- **`mahsr_piers.csv`**: every span-start pier on C-4, with type, span, E/N,
  lat/lon and, on S5, rail, GL, pier cap, pedestal, pier height and curvature.
- **`mahsr_profile_20m.csv`**: the centre line every 20 m, with structure type,
  rail level (CH 331.5 – 393.735) and pier GL (S5).

It finishes with a self-check, which must print `OK`:

```
chainage      1569 piers: (grid length + 157000) - pier CH  median -0.001  sd 0.007  max |0.059| m
rail levels   VIP table + R 25000 m vs 1533 S5 pier rail levels:  rms 0.6 mm, max 6.6 mm
```

Re-run it whenever the CivilWorksApp data changes.

## 3 · Control points

The CSVs use the same format as `studies/delhi_varanasi/stations.csv`:
`name,lat,lon,kind,note`, with columns matched by name. Each `note` gives the
source.

| where | source | how good |
|---|---|---|
| C-4: start, Vapi, Bilimora, Surat, Bharuch, S5 ends | the design centre line at the station's mid-chainage | exact |
| Vadodara | the design centre line at CH 397.0 | approximate: not in the data |
| BKC, Virar, Boisar, Anand-Nadiad, Ahmedabad, Sabarmati | Wikipedia, checked against the OSM-mapped line | approximate: all within 30 m of that line |
| Thane, Shilphata portal | OpenStreetMap (the station node; the end of the mapped tunnel) | approximate |

**How far to trust the public coordinates.**

- For the four C-4 stations that the data fixes, Wikipedia's coordinates are
  35 – 270 m from the design along the line. Surat is also 190 m off it.
- OpenStreetMap maps the whole line as route relation 8304354. Along C-4 it
  follows the design to **5 m median, 12 m p90** (122 m at worst, near
  Vadodara).
- Measured along the OSM line, distances run about 0.22 km longer than the
  design chainage: the design's CH 157.000 point is 157.22 km from the BKC end
  of the OSM line.
- On that basis the Shilphata portal is at about CH 20.8, 21.0 km along the
  mapped tunnel. That agrees with NHSRCL's 21 km BKC – Shilphata. Thane station
  is at about CH 27.9.
- The OSM line is a usable approximate reference where the design data stops,
  that is Mumbai – Zaroli and Vadodara – Sabarmati. It is not a design.

**Public figures for the Mumbai – Thane tunnel** (NHSRCL press releases and
news reports):

- The tunnel is 21 km long, ~7 km of it under Thane Creek.
- It is a single 13.1 m bore carrying both tracks.
- The TBM drives cover ~16 km, BKC – Ghansoli.
- The NATM section covers ~5 km, Ghansoli – Shilphata. The last 4.881 km run
  from the Savli shaft to the portal.
- The tunnel is 25 – 65 m below ground, and 114 m below Parsik hill near
  Shilphata.
- The shafts are 36 m deep at BKC, 56 m at Vikhroli and 39 m at Savli.
- BKC is underground, with its platforms ~24 m below ground.

None of these figures is survey data.

## 4 · Terrain (DEM)

**Use GLO-30.** Comparing the DEM with the surveyed ground at the S5 piers, and
designing at 25 m cells, needs the 30 m data. GLO-90 is listed only for a
whole-line overview.

| study | listing | tiles | size |
|---|---|---|---|
| whole line, 15 km buffer, GLO-30 | `dem_tiles_glo30.txt` | 12 (N18 – N23 × E072 – E073) | 420 MB |
| whole line, 15 km buffer, GLO-90 | `dem_tiles_glo90.txt` | 12 | 49 MB |
| C-4, 10 km buffer | `dem_tiles_glo30_c4.txt` | 6 (N20 – N22 × E072 – E073) | 221 MB |
| S5, 8 km buffer | `dem_tiles_glo30_s5.txt` | 4 (N21 – N22 × E072 – E073) | 165 MB |
| Mumbai – Thane, 5 km buffer | `dem_tiles_glo30_mumbai_thane.txt` | 2 (N19 × E072 – E073) | 59 MB |

Every tile exists; none is reported missing as all sea. N18E072, N19E072 and
N20E072 are small because they are mostly Arabian Sea.

The study sets share tiles, so one folder serves them all. Download the whole
line once:

```bash
python designer/build/fetch_dem.py --controls studies/mahsr/stations.csv --buffer-km 15 --res 30 --out studies/mahsr/raw/dem30
```

Or download only what a study needs. For S5 alone:

```bash
python designer/build/fetch_dem.py --controls studies/mahsr/stations_s5.csv --buffer-km 8 --res 30 --out studies/mahsr/raw/dem30
```

Add `--dry-run` to see the listing first. An interrupted download resumes.

## 5 · Constraints (OpenStreetMap)

One fetch covers all three studies:

```bash
python designer/build/fetch_osm.py --controls studies/mahsr/stations.csv --buffer-km 15 --out studies/mahsr/raw/osm
```

It fetches the usual classes: `built`, `water`, `road`, `rail`, `woodland` and
`protected`.

It also fetches the coastal and environmental classes this corridor needs:
`mangrove`, `wetland` and `coastline`. The line crosses Thane Creek and the
Vasai, Vaitarna, Narmada and Tapi estuaries. Protected areas near it in
Maharashtra include the Thane Creek Flamingo Sanctuary, Sanjay Gandhi National
Park and Tungareshwar Wildlife Sanctuary.

The importer picks the files up from `--osm`. `--mangrove`, `--wetland` and
`--coastline` take explicit GeoJSONs instead. `--crz-m` sets the Coastal
Regulation Zone width drawn inland from the coastline.

These flags are new: `import_dem.py --help` and `fetch_osm.py --help` describe
them exactly.

Re-running the fetch skips classes already on disk, so a download made before
the new classes existed is completed by running the same command again.

OSM's mangrove and coast mapping is uneven. Where authoritative layers exist,
use them instead. Examples are the approved Coastal Zone Management Plan (CZMP)
maps of Maharashtra and Gujarat for CRZ and mangroves, WDPA for sanctuaries,
and the state forest departments.

## 6 · Build the projects

Run `extract_reference.py` (§2) first. All three builds are in UTM 43N
(EPSG:32643), the CRS of the reference, so nothing is reprojected.

**mahsr_s5**: the training section, with design levels and surveyed ground:

```bash
python designer/build/import_dem.py --dem studies/mahsr/raw/dem30 --reference studies/mahsr/private/reference_c4.json --reference-range 333641 393700 --buffer-km 8 --osm studies/mahsr/raw/osm --id mahsr_s5 --name "MAHSR S5 (CH 333.6-393.7)" --mode rail_hs --speed 350 --cell 25
```

- The box is ~41 × 70 km. At 25 m that comes to ~4.55 M cells, right at the
  ~4.5 M budget.
- If the importer refuses the grid, use `--buffer-km 7` or `--cell 30`.
- The build reports the DEM − surveyed GL statistics (`calibration`) at the
  1,531 piers.
- Note the median: it is the DSM / datum offset for the other two builds.

**mahsr_c4**: the whole package, on plan. The cell is chosen automatically and
comes to about 60 m for this ~51 × 253 km box:

```bash
python designer/build/import_dem.py --dem studies/mahsr/raw/dem30 --reference studies/mahsr/private/reference_c4.json --buffer-km 10 --osm studies/mahsr/raw/osm --id mahsr_c4 --name "MAHSR C-4 (CH 157.0-401.0)" --mode rail_hs --speed 350
```

**mahsr_mumbai_thane**: a tunnel study between BKC, the Shilphata portal and
Thane. Its reference is the public-data estimate:

```bash
python studies/mahsr/build_tunnel_reference.py
```

```bash
python designer/build/import_dem.py --dem studies/mahsr/raw/dem30 --controls studies/mahsr/stations_mumbai_thane.csv --reference studies/mahsr/reference_mumbai_thane.json --buffer-km 5 --osm studies/mahsr/raw/osm --id mahsr_mumbai_thane --name "MAHSR Mumbai - Thane (tunnel)" --mode rail_hs --speed 350 --cell 25
```

The control points carry their vertical intent in three columns. `leg` is what
the line does from that point to the next. `depth` is rail depth below ground
there, and `level` is a fixed rail level. BKC is underground at 26 m, and the
legs to Vikhroli and on to Shilphata are bored. From the portal the line is on
viaduct.

- The grid is ~31 × 25 km, ~1.2 M cells.
- The portal is a via point, not a stop. Untick *Service stops at each
  control point* when timing runs.
- No surveyed ground exists here. To correct the DSM, apply the S5 offset with
  `--dem-offset`.

The speed of 350 km/h is the MAHSR design speed (320 km/h operating).

## 7 · Designing against the existing design

Open the project and set the standard first. In **Design standard**, choose
*Railway — high speed* at 350 km/h, then set these:

| setting | MAHSR value | why |
|---|---|---|
| Max cant / cant deficiency | defaults (160 / 80 mm) | together they give R_min ≈ 6,000 m at 350 km/h, the radius C-4 is built to |
| Ruling gradient | 1.5 % | JICA FAD 2018: 15 ‰ on the main line. S5 itself never exceeds 0.75 % |
| Vertical R factor | 0.20 | 0.20 · 350² ≈ 24,500 m, close to the 25,000 m the S5 levels use |
| Vertical policy | *Elevated (viaduct) by default* | MAHSR is ~90 % viaduct |
| Viaduct: least / typical rail above ground | 8 / 11.5 m | measured on S5: least 8.1 m, median 11.75 m |
| Tunnel: rail below ground / bed | 30 m | the creek tunnel is 20–25 m below the bed to the crown, and the rail sits ~10 m under the crown |
| Tunnel: creek bed below water | 6 m (vary 3–10) | no public bathymetry exists. 2–6 m below chart datum is published, and chart datum is ~2.5 m below MSL |

**Then compare:**

1. Press **Load reference**. The existing design is evaluated under the
   standard you set. On S5 its levels are *given* and fixed exactly, not
   fitted; elsewhere they are estimated by the policy and drawn faint. The
   Results tab shows:
   - the given grades and radii against the standard;
   - the DEM against the surveyed ground at the 1,531 piers. This is the
     measured offset; rebuild with `--dem-offset` if it is large;
   - the declared structures (viaduct, river bridges, special spans,
     stations).
2. Press **Generate options**. *Rank the existing design with the options* is
   ticked, so the design appears as row **REF**, scored on the same basis.
   - On the map it is the dashed line. Right-click any line to select it, and
     right-click again to cycle where lines overlap.
   - Under every option's long section, the existing rail level is drawn
     dashed wherever the two lines are within 300 m. The hover label gives the
     difference in metres, and surveyed ground is dotted against the DEM.
   - Zoom the section and fix the exaggeration (1×–10×) to compare grades as
     they really are.
3. Read the differences as *the tool's assumptions against the designer's
   decisions*. Typical findings:
   - The tool's profile has many more grade changes. The design holds grades
     2–22 km long, so compare clearances and structures, not the VIP count.
   - The design rises 18–26 m at fixed crossings (roads, rail, rivers). The tool
     has no crossing clearances yet; see `docs/feature_benchmark.md` P1.2.
   - Horizontal differences come from what the cost surface charges. Change
     *What the route avoids* and watch which options move towards REF.

**The tunnel study.** Generating options on `mahsr_mumbai_thane` adds two
options to the usual family:

- **T, tunnel deeper:** 15 m more cover. This shows what depth costs.
- **V, viaduct instead of tunnel:** the creek is crossed on viaduct from the
  Vikhroli shaft. This is the 2015 study's ALT2. Compare its *Environmental
  land* (mangrove, wetland, CRZ, the Thane Creek Flamingo Sanctuary) with the
  bored options. That trade is why the undersea tunnel was chosen.

Vary the creek-bed depth and watch the deepest point move. The REF row here is
an estimate from four published points, so treat its levels as indicative.

## Limits worth knowing on this corridor

- **Design levels cover 60 km of 508 km.** Everywhere else, the reference gives
  plan, structure type and stations only. Rail levels are not inferred where
  the data has none.
- **The Mumbai – Thane reference is an estimate.** It uses the OSM plan, which
  maps the creek as one straight chord, and four published levels. Only the
  public figures in §3 exist.
- **Set the vertical policy to elevated.** If it is left on *Follow the ground*,
  the tool builds earthworks where MAHSR builds viaduct, and every cost
  comparison is off.
- **Costs are comparative.** Rates rank options; they are not an estimate.
- **OpenStreetMap completeness** varies, especially for mangroves, wetlands and
  village extents. Check the layers on the map before trusting an impact
  figure.

Licences: OSM data © OpenStreetMap contributors (ODbL). The Copernicus DEM is
© DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided
under COPERNICUS by the European Union and ESA. The design data belongs to
NHSRCL and is for private study.
