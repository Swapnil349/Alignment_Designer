"""
Alignment Designer — import a DEM (and optional constraints) as a project.

    python import_dem.py --dem terrain.tif --id westghats --name "West Ghats crossing"

A whole corridor from a folder of tiles, sized around its stations:

    python import_dem.py --dem studies/delhi_varanasi/raw/dem \\
        --controls studies/delhi_varanasi/stations.csv --buffer-km 30 \\
        --osm studies/delhi_varanasi/raw/osm \\
        --id delhi_varanasi --name "Delhi – Varanasi HSR" --mode rail_hs --speed 320

DEM input (--dem takes any mix of these, as many as needed)
    .tif/.tiff  GeoTIFF (Copernicus DEM, SRTM, ALOS, CartoDEM, LiDAR exports…)
    .asc        ESRI / GRASS ASCII grid
    .hgt        raw SRTM tile (N28E077.hgt)
    .zip        any of the above, zipped — unpacked once, next to the zip
    folder      every DEM file inside it
    wildcard    "dem/*.tif" — expanded here, so it works in Windows shells too
    .npy        bare NumPy array, with --extent xmin ymin xmax ymax (degrees, or
                projected metres plus --epsg, e.g. --epsg 32643 for UTM 43N)

Tiles are mosaicked: each is read only while the grid cells inside it are
being sampled, so a corridor spanning dozens of 1-degree tiles fits in memory.

--dem-offset M adds M metres to every cell after resampling: the vertical
datum shift and DSM bias that a --reference with surveyed ground measures
(see below). Copernicus / SRTM heights are geoid heights (EGM2008 / EGM96) of
a SURFACE model; a design's levels are on its own datum, on bare ground.

Geographic DEMs (degrees) are projected to the UTM zone of the project's
centre, so the alignment engine always works in metres — radii, gradients and
chainages are meaningless otherwise.

Extent, in order of precedence
    --clip XMIN YMIN XMAX YMAX      project-CRS metres
    --bbox LONMIN LATMIN LONMAX LATMAX
    --buffer-km K                   the control points, grown by K km
    (otherwise)                     everything the DEM files cover

Cell size: --cell, or chosen automatically — as fine as the DEM allows, but
coarse enough that the grid stays within --max-cells (default 4.5 M, which a
browser holds comfortably). The choice and the reason are printed.

Constraint layers, each a GeoJSON file (WGS84 or already in the project CRS —
the magnitudes are used to tell them apart):

    --built built.geojson          settlements to avoid
    --protected parks.geojson      national parks, reserves, heritage
    --woodland forest.geojson      forest / tree cover
    --water rivers.geojson         watercourses and water bodies
    --road roads.geojson           existing major roads (crossing cost)
    --rail rail.geojson            existing railways (crossing cost)
    --farmland farm.geojson        high-grade agricultural land
    --mangrove mangrove.geojson    mangrove forest (OSM, or Global Mangrove Watch
                                   converted to GeoJSON)
    --wetland wetland.geojson      marsh, saltmarsh, tidal flat, swamp
    --exclusion nogo.geojson       hard no-go zones — the search will not enter
    --osm FOLDER                   take whichever of built/protected/woodland/
                                   water/road/rail/farmland/mangrove/wetland/
                                   exclusion/coastline.geojson are in FOLDER
                                   (what fetch_osm.py writes)

Coastal regulation zone (layer 'crz'):

    --crz crz.geojson              an authoritative CRZ polygon layer (the state
                                   CZMA's approved CZMP map) — used as given
    --coastline coast.geojson      otherwise a SCREENING PROXY is built: every
    --crz-m 500                    cell within --crz-m of the coastline (default
                                   500 m, either side), plus mangroves and 50 m
                                   around them (the CRZ-IA buffer)

    The proxy is not the CRZ. The legal lines are drawn by the state Coastal
    Zone Management Authority from the High Tide Line along the sea AND along
    tidal creeks, rivers and backwaters up to the tidal limit; the OSM
    coastline approximates mean high water and stops at most creek mouths.

Reference alignment (an existing design, to compare routed options against):

    --reference ref.json           {name, epsg, chainage_start_m, pts, stations,
                                   profile, structures, ground, ...} — the format
                                   studies/mahsr/extract_reference.py writes
    --reference-range CH0 CH1      keep only design chainage CH0..CH1 (metres)

    The line is reprojected if its UTM zone differs from the grid's; a VIP
    table (profile.pvi + vc_radius_m) is expanded to rail levels every 20 m;
    surveyed ground, if any, is compared with the DEM and the offset reported
    (stored as reference.calibration) with the --dem-offset that removes it.
    Without --controls / --control, the control points are taken from the
    reference: its two ends and the stations between them.

Control points (stations, vias), from a CSV with named columns:

    --controls stations.csv        columns: name, lat, lon [, kind]
                                   (or easting, northing in the project CRS)
                                   [, leg, level, depth] — the vertical intent
                                   from this point on: leg ground | elevated |
                                   tunnel, rail level (m), or rail depth below
                                   ground (m); written only where given

or one at a time, as  --control "Agra:78.008,27.177"  — note LON first. If a
point given that way lands outside the DEM but its swapped reading lands
inside, it is swapped back and a warning printed: Google Maps copies lat,lon.
Points can also just be clicked in the app.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dempack as dp

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECTS = os.path.abspath(os.path.join(HERE, "..", "projects"))

LAYER_FLAGS = [("built", "built"), ("protected", "protected"), ("woodland", "woodland"),
               ("water", "water_body"), ("road", "road_major"), ("rail", "rail"),
               ("farmland", "farmland"), ("mangrove", "mangrove"), ("wetland", "wetland"),
               ("exclusion", "exclusion")]

# CRZ Notification: mangrove patches are CRZ-IA and carry a 50 m buffer that
# is CRZ-IA too. (2019 limits the buffer to patches over 1000 m² on private
# land; every mapped patch gets it here — a screening layer errs wide.)
MANGROVE_BUFFER_M = 50.0
# Reference profiles are expanded to levels at this spacing. On R 25 000 m
# vertical curves the chord between 20 m samples sags by 20²/(8R) = 2 mm — far
# inside what a corridor study can see.
PROFILE_STEP_M = 20.0


def parse_control(spec, tiles_box):
    """'Name:a,b' -> a raw control point, lon/lat or easting/northing."""
    if ":" in spec:
        name, coords = spec.split(":", 1)
    else:
        name, coords = "CP", spec
    a, b = [float(v.strip()) for v in coords.split(",")[:2]]
    name = name.strip()
    if abs(a) <= 180 and abs(b) <= 90:
        lon, lat = a, b
        if tiles_box is not None:
            x0, y0, x1, y1 = tiles_box
            inside = lambda lo, la: x0 <= lo <= x1 and y0 <= la <= y1
            if not inside(lon, lat) and abs(a) <= 90 and inside(b, a):
                print("   !! %s: %.4f,%.4f lies outside the DEM but %.4f,%.4f lies inside "
                      "— reading it as lat,lon (Google Maps order)" % (name, a, b, b, a))
                lon, lat = b, a
        return {"name": name, "kind": "control", "lat": lat, "lon": lon}
    return {"name": name, "kind": "control", "E": a, "N": b}


def corridor_relief(dem, grid, controls, within_m):
    """1st–99th percentile of the ground near the line joining the stations.

    The project's rectangle can hold terrain the corridor never goes near —
    Delhi – Varanasi's north-east corner is the Nepal Himalaya, 7 % of the area
    above 500 m against a corridor that never leaves 60–300 m. Stretching the
    map's colours over the whole rectangle would paint the corridor one flat
    shade; this keeps them on the ground the alignment can actually use.
    """
    GE, GN = grid.centres()
    near = np.zeros(dem.shape, bool)
    for a, b in zip(controls[:-1], controls[1:]):
        vx, vy = b["E"] - a["E"], b["N"] - a["N"]
        L2 = max(1.0, vx * vx + vy * vy)
        t = np.clip(((GE - a["E"]) * vx + (GN - a["N"]) * vy) / L2, 0, 1)
        near |= np.hypot(GE - (a["E"] + t * vx), GN - (a["N"] + t * vy)) < within_m
    if not near.any():
        return None
    lo, hi = np.percentile(dem[near], [1, 99])
    return [float(math.floor(lo)), float(math.ceil(hi))]


def is_river(props):
    """A river, as opposed to a pond, lake, reservoir or canal.

    OpenStreetMap: river lines (waterway=river), river areas (natural=water with
    water=river or oxbow, or the older waterway=riverbank). Files from other
    sources pass if they say so in a 'kind', 'type' or 'class' property."""
    kind = str(props.get("kind", props.get("type", props.get("class", "")))).lower()
    return kind in ("river", "riverbank") or str(props.get("water", "")).lower() in ("river", "oxbow")


def utm_of_epsg(epsg):
    if epsg and 32601 <= epsg <= 32660:
        return epsg - 32600, "N"
    if epsg and 32701 <= epsg <= 32760:
        return epsg - 32700, "S"
    return None, None


# ───────────────────────────────────────────────────── reference alignment ──
# An existing design carried into the project as data (pack_project's
# `reference`): the browser evaluates it under the selected standard and lays
# its rail levels under every routed option on the long section. The file
# follows the contract studies/mahsr/extract_reference.py writes, whose one
# load-bearing identity is
#     design chainage = chainage_start_m + cumulative GRID length along pts
# Every step here — the range clip, the profile expansion, a reprojection —
# keeps that identity, or (a change of UTM zone) says by how much it breaks.

def load_reference(path):
    try:
        with open(path, encoding="utf-8") as f:
            ref = json.load(f)
    except (OSError, ValueError) as err:
        sys.exit("cannot read the reference %s: %s" % (path, err))
    pts = ref.get("pts")
    if not isinstance(pts, list) or len(pts) < 2:
        sys.exit("%s: a reference needs 'pts', at least two [E, N] vertices" % path)
    ref["pts"] = [[float(p[0]), float(p[1])] for p in pts]
    ref["chainage_start_m"] = float(ref.get("chainage_start_m") or 0.0)
    notes = ref.get("notes")
    ref["notes"] = list(notes) if isinstance(notes, list) else ([str(notes)] if notes else [])
    if not ref.get("length_m"):
        ref["length_m"] = float(dp.polyline_cum(ref["pts"])[-1])
    # The chainage window filters stations by chainage, so every station needs
    # one; a file that gives only E, N gets it from the nearest point of the line.
    for st in ref.get("stations") or []:
        if st.get("chainage_m") is None and "E" in st and "N" in st:
            s, off = dp.polyline_locate(ref["pts"], float(st["E"]), float(st["N"]))
            st["chainage_m"] = round(ref["chainage_start_m"] + s, 1)
            print("   station %s carries no chainage_m — CH %.0f taken from the line "
                  "(%.0f m off it)" % (st.get("name", "?"), st["chainage_m"], off))
    return ref


def pvi_levels(pvi, R, ch):
    """Level at chainage ch from a VIP table: straight grades between VIPs and a
    symmetric parabola at every interior VIP.

    The parabola is applied as a correction to the grade line,
        y += sign(A) * max(0, T - |ch - VIP|)^2 / (2R),   T = R*|A|/2,
    with A = g_out - g_in in m/m. A sag (A > 0) is convex, so the curve runs
    ABOVE its two tangents and the correction raises the level — by R*A^2/8 at
    the VIP itself; a crest lowers it. The two end VIPs get no curve: the grade
    before the first (and after the last) is not in the table — MAHSR's VIP
    #103 at CH 331 500 is exactly that case. This is the formula
    extract_reference.pvi_levels checks against the S5 pier rail levels (0.6 mm
    rms), so what it validated is what the designer is given. A third value in
    a pvi row, when present, is that VIP's own radius.
    """
    vx = np.array([float(r[0]) for r in pvi])
    vy = np.array([float(r[1]) for r in pvi])
    rv = [float(r[2]) if len(r) > 2 and r[2] else float(R or 0) for r in pvi]
    ch = np.asarray(ch, np.float64)
    g = np.diff(vy) / np.diff(vx)
    y = np.interp(ch, vx, vy)
    for i in range(1, len(vx) - 1):
        A, Ri = g[i] - g[i - 1], rv[i]
        if Ri <= 0 or A == 0:
            continue
        T = Ri * abs(A) / 2
        y = y + np.sign(A) * np.maximum(0.0, T - np.abs(ch - vx[i])) ** 2 / (2 * Ri)
    return y


def expand_profile(ref, window=None):
    """Give the browser dense levels: profile.points over the profile's span
    (cut to `window` = (ch0, ch1) when given), and profile.coverage.

    A VIP table is expanded from the WHOLE table before any clipping, so a
    vertical curve whose VIP lies just outside the window still shapes the
    levels inside it. Dense points that came with the file are clipped, with
    the window's edges interpolated in so the levels reach them. profile.pvi
    and vc_radius_m stay in the file as the source of the points.
    """
    prof = ref.get("profile")
    if not isinstance(prof, dict):
        return
    lo, hi = window if window else (-math.inf, math.inf)
    given = prof.get("points") or []
    pvi = prof.get("pvi") or []
    if len(given) > 1:
        P = sorted([float(r[0]), float(r[1])] for r in given)
        xs, ys = [r[0] for r in P], [r[1] for r in P]
        keep = [r for r in P if lo <= r[0] <= hi]
        for edge in (lo, hi):
            if xs[0] < edge < xs[-1] and not any(abs(r[0] - edge) < 1e-3 for r in keep):
                keep.append([edge, float(np.interp(edge, xs, ys))])
        prof["points"] = sorted(keep)
        print("   profile: %d given levels kept in the window" % len(keep))
    elif len(pvi) > 1:
        vx = np.array([float(r[0]) for r in pvi])
        if np.any(np.diff(vx) <= 0):
            sys.exit("reference profile.pvi: chainages must increase strictly (VIP table "
                     "out of order or repeated)")
        R = float(prof.get("vc_radius_m") or 0)
        vy = np.array([float(r[1]) for r in pvi])
        g = np.diff(vy) / np.diff(vx)
        T = np.zeros(len(vx))
        T[1:-1] = R * np.abs(np.diff(g)) / 2
        # Superposed corrections are exact only while neighbouring curves do
        # not overlap; a table that needs them to is not a plain VIP table.
        clash = [(vx[i], vx[i + 1]) for i in range(len(vx) - 1) if T[i] + T[i + 1] > vx[i + 1] - vx[i]]
        if clash:
            print("   !! %d pair(s) of vertical curves overlap at R %.0f m (first between CH "
                  "%.0f and %.0f) — levels there are approximate" % (len(clash), R, *clash[0]))
        a, b = max(vx[0], lo), min(vx[-1], hi)
        if b - a < PROFILE_STEP_M:
            prof["points"] = []
            print("   !! the profile (CH %.0f - %.0f) does not reach this window — no levels"
                  % (vx[0], vx[-1]))
        else:
            ch = np.arange(math.ceil(a / PROFILE_STEP_M) * PROFILE_STEP_M, b, PROFILE_STEP_M)
            # VIPs off the 20 m lattice (MAHSR's CH 380 710) are added, so the
            # level AT each VIP is in the table, not a chord across it.
            ch = np.unique(np.round(np.concatenate([[a, b], ch, vx[(vx > a) & (vx < b)]]), 3))
            y = pvi_levels(pvi, R, ch)
            prof["points"] = [[float(round(c, 3)), float(round(z, 3))] for c, z in zip(ch, y)]
            print("   profile: %d VIPs, R %s m -> %d levels every %g m, CH %.0f - %.0f"
                  % (len(pvi), ("%.0f" % R) if R else "none (bare grades)", len(ch),
                     PROFILE_STEP_M, a, b))
    if prof.get("points"):
        prof["coverage"] = [prof["points"][0][0], prof["points"][-1][0]]
    elif window and prof.get("coverage"):
        c0, c1 = max(float(prof["coverage"][0]), lo), min(float(prof["coverage"][1]), hi)
        prof["coverage"] = [c0, c1] if c1 > c0 else None


def clip_reference(ref, c0, c1):
    """Keep design chainage c0..c1 of the reference, and everything that goes with it."""
    if c1 <= c0:
        sys.exit("--reference-range: CH1 (%g) must be greater than CH0 (%g)" % (c1, c0))
    s_ch = ref["chainage_start_m"]
    e_ch = s_ch + float(dp.polyline_cum(ref["pts"])[-1])
    a, b = max(c0, s_ch), min(c1, e_ch)
    if b - a < 1.0:
        sys.exit("--reference-range CH %.0f - %.0f misses the reference, which runs CH %.0f - %.0f"
                 % (c0, c1, s_ch, e_ch))
    if a > c0 + 0.5 or b < c1 - 0.5:
        print("   !! the reference runs CH %.0f - %.0f; the range is cut to CH %.0f - %.0f"
              % (s_ch, e_ch, a, b))
    expand_profile(ref, (a, b))                  # before the VIP table is clipped

    # The line itself, cut at exactly interpolated ends: chainage_start_m = a
    # only holds if pts[0] is the point at CH a, not the nearest vertex to it.
    ref["pts"] = dp.polyline_cut(ref["pts"], a - s_ch, b - s_ch)
    ref["chainage_start_m"] = float(a)
    ref["length_m"] = float(dp.polyline_cum(ref["pts"])[-1])
    inside = lambda ch: ch is not None and a - 1e-6 <= float(ch) <= b + 1e-6
    n_st = len(ref.get("stations") or [])
    ref["stations"] = [st for st in ref.get("stations") or [] if inside(st.get("chainage_m"))]
    if ref.get("ground"):
        ref["ground"] = [g for g in ref["ground"] if inside(g[0])]
    if ref.get("structures"):
        ref["structures"] = [[max(float(r[0]), a), min(float(r[1]), b)] + list(r[2:])
                             for r in ref["structures"] if float(r[1]) > a and float(r[0]) < b]
    prof = ref.get("profile")
    if isinstance(prof, dict):
        if prof.get("pvi"):
            # The VIPs inside, plus the nearest one beyond each edge: without
            # them the grade line, and so the profile, stops short of the window.
            vx = [float(r[0]) for r in prof["pvi"]]
            before = [i for i, x in enumerate(vx) if x < a]
            after = [i for i, x in enumerate(vx) if x > b]
            keep = set(i for i, x in enumerate(vx) if a <= x <= b)
            keep |= set(before[-1:]) | set(after[:1])
            prof["pvi"] = [prof["pvi"][i] for i in sorted(keep)]
        if prof.get("pins"):
            prof["pins"] = [p for p in prof["pins"] if inside(p.get("ch"))]
    if ref.get("closed"):
        ref["closed"] = False
        print("   (a clipped closed line is an open one)")
    ref["notes"].append("Clipped by import_dem.py --reference-range to CH %.3f - %.3f km; "
                        "chainage_start_m and length_m describe the clipped line."
                        % (a / 1000, b / 1000))
    print("   kept CH %.0f - %.0f: %.2f km, %d vertices, %d of %d stations, %d structure runs, "
          "%d ground points" % (a, b, ref["length_m"] / 1000, len(ref["pts"]),
                                len(ref["stations"]), n_st, len(ref.get("structures") or []),
                                len(ref.get("ground") or [])))


def reference_controls(ref, geographic, dem_epsg):
    """Control points for a project built around a reference.

    Its two ends and the stations between them — a station within 1 km of an
    end is left out, the end stands for it, since two controls that close
    together only make a kink. Given as lon/lat on a geographic DEM and as E, N
    in the DEM's own CRS on a projected one: exactly what a CSV would give, so
    --buffer-km sizes the grid around them the same way.
    """
    pts, s_ch = ref["pts"], ref["chainage_start_m"]
    e_ch = s_ch + float(dp.polyline_cum(pts)[-1])
    closed = bool(ref.get("closed"))
    picks, skipped = [], []
    if not closed:
        picks.append(("Start (CH %.3f)" % (s_ch / 1000), "terminal", pts[0][0], pts[0][1]))
    for st in sorted(ref.get("stations") or [], key=lambda s: float(s.get("chainage_m") or 0)):
        ch = st.get("chainage_m")
        if closed or (ch is not None and s_ch + 1000 <= float(ch) <= e_ch - 1000):
            picks.append((st.get("name") or st.get("id") or "station", "station",
                          float(st["E"]), float(st["N"])))
        else:
            skipped.append(st.get("name") or st.get("id") or "?")
    if not closed:
        picks.append(("End (CH %.3f)" % (e_ch / 1000), "terminal", pts[-1][0], pts[-1][1]))
    ref_epsg = ref.get("epsg")
    zr, hr = utm_of_epsg(ref_epsg)
    zd, hd = utm_of_epsg(dem_epsg)
    out = []
    for name, kind, E, N in picks:
        if geographic or (ref_epsg and dem_epsg and ref_epsg != dem_epsg):
            if zr is None:
                sys.exit("the reference's epsg (%s) is not UTM — cannot place its points on "
                         "this DEM. Export it in UTM (e.g. EPSG:32643)." % ref_epsg)
            lon, lat = dp.utm_inverse(E, N, zr, hr)
            if geographic:
                out.append({"name": name, "kind": kind, "lat": float(lat), "lon": float(lon)})
                continue
            if zd is None:
                sys.exit("the reference is in EPSG:%s but the DEM in EPSG:%s — only UTM to UTM "
                         "is built in" % (ref_epsg, dem_epsg))
            E, N = (float(v) for v in dp.utm_forward(lon, lat, zd, hd))
        out.append({"name": name, "kind": kind, "E": E, "N": N})
    n_st = sum(1 for p in picks if p[1] == "station")
    print("   no --controls: %d control points taken from the reference (%s%d station%s)"
          % (len(out), "" if closed else "its two ends and ", n_st, "" if n_st == 1 else "s"))
    if skipped:
        print("   (left out, within 1 km of an end: %s)" % ", ".join(skipped))
    return out


def reproject_reference(ref, grid):
    """Carry the reference into the grid's CRS, UTM zone to UTM zone, via lon/lat."""
    src = ref.get("epsg")
    if not src:
        print("   !! the reference states no epsg — taken to be in the grid's CRS")
        return
    if src == grid.epsg:
        return
    zs, hs = utm_of_epsg(src)
    zt, ht = utm_of_epsg(grid.epsg)
    if zs is None or zt is None:
        sys.exit("the reference is in EPSG:%s and the design grid in %s. Only UTM-to-UTM "
                 "reprojection is built in (no GDAL here) — export the reference in the grid's "
                 "UTM zone%s." % (src, ("EPSG:%s" % grid.epsg) if grid.epsg else "no stated CRS",
                                  "" if grid.epsg else ", or give a bare .npy DEM its --epsg"))

    def conv(E, N):
        lon, lat = dp.utm_inverse(np.asarray(E, np.float64), np.asarray(N, np.float64), zs, hs)
        return dp.utm_forward(lon, lat, zt, ht)

    L0 = float(dp.polyline_cum(ref["pts"])[-1])
    p = np.asarray(ref["pts"])
    X, Y = conv(p[:, 0], p[:, 1])
    ref["pts"] = [[float(x), float(y)] for x, y in zip(X, Y)]
    for st in ref.get("stations") or []:
        if "E" in st and "N" in st:
            x, y = conv(st["E"], st["N"])
            st["E"], st["N"] = float(x), float(y)
    for g in ref.get("ground") or []:
        if len(g) >= 4 and g[2] is not None and g[3] is not None:
            x, y = conv(g[2], g[3])
            g[2], g[3] = float(x), float(y)
    ref["epsg"] = grid.epsg
    # Chainage is grid length in the design's OWN zone. In another zone the
    # scale factor differs, so the browser's ch0 + (length along pts) drifts
    # from the design chainage — by this much at the far end. Reported, not
    # hidden: profile levels and structures are placed by that chainage.
    drift = float(dp.polyline_cum(ref["pts"])[-1]) - L0
    print("   reprojected EPSG:%s -> EPSG:%s. The line measures %+.1f m in this zone, so "
          "chainages read along it drift from the design's by up to %.1f m at the far end."
          % (src, grid.epsg, drift, abs(drift)))
    ref["notes"].append("Reprojected by import_dem.py from EPSG:%s to EPSG:%s; chainage along "
                        "the reprojected line drifts by up to %.1f m from design chainage."
                        % (src, grid.epsg, abs(drift)))


def check_reference_inside(ref, grid, args):
    """Stop, before the terrain is built, if the reference leaves the grid.

    The vertices, and the line between them every 100 m: a long straight has
    no vertices along it (S5 has a 26 km one, CH 334 966 - 360 975), so the
    vertices alone can say the line leaves the grid for 1 km of chainage when
    it is out for 9.
    """
    p = np.asarray(ref["pts"])
    cum = dp.polyline_cum(p)
    s = np.unique(np.concatenate([cum, np.arange(0.0, cum[-1], 100.0)]))
    X, Y = np.interp(s, cum, p[:, 0]), np.interp(s, cum, p[:, 1])

    def overshoot(x, y):
        return np.maximum.reduce([grid.xmin - x, x - grid.xmax, grid.ymin - y, y - grid.ymax])

    over = overshoot(X, Y)
    if not (over > 0).any():
        return
    nv = int((overshoot(p[:, 0], p[:, 1]) > 0).sum())
    ch = ref["chainage_start_m"] + s[over > 0]
    need = (args.buffer_km or 0.0) + math.ceil(float(over.max()) / 1000 + 1)
    sys.exit("\nThe reference leaves the design grid between CH %.0f and %.0f (%d of its %d "
             "vertices outside), by up to %.1f km. Either\n"
             "  - keep only the part the grid covers:  --reference-range CH0 CH1   (design "
             "chainage, metres), or\n"
             "  - grow the grid:  --buffer-km %g  (or a wider --bbox / --clip; the DEM files "
             "must cover it too)." % (ch.min(), ch.max(), nv, len(p), over.max() / 1000, need))


def calibrate_reference(ref, dem, grid, offset):
    """DEM - surveyed ground at the reference's ground points -> ref['calibration']."""
    rows = [g for g in ref.get("ground") or [] if len(g) >= 2 and g[1] is not None]
    if not rows:
        return
    s_ch, pts = ref["chainage_start_m"], ref["pts"]
    cum = dp.polyline_cum(pts)
    E, N, GL = [], [], []
    for g in rows:
        if len(g) >= 4 and g[2] is not None and g[3] is not None:
            e, n = float(g[2]), float(g[3])
        else:                                  # [ch, gl] only: on the centre line
            e, n = dp.polyline_at(pts, cum, float(g[0]) - s_ch)
        E.append(e); N.append(n); GL.append(float(g[1]))
    d = dp.sample_grid(dem, grid, E, N) - np.asarray(GL)
    d = d[np.isfinite(d)]
    print("\n[5b] reference: DEM against surveyed ground")
    if not d.size:
        print("   none of the %d ground points lies on the grid" % len(rows))
        return
    med = float(np.median(d))
    cal = {"n": int(d.size), "median": round(med, 3), "mean": round(float(d.mean()), 3),
           "p5": round(float(np.percentile(d, 5)), 3), "p95": round(float(np.percentile(d, 95)), 3),
           "rms_after_median": round(float(np.sqrt(np.mean((d - med) ** 2))), 3),
           "dem_offset": round(float(offset), 3)}
    ref["calibration"] = cal
    datum = (ref.get("profile") or {}).get("datum") or "the design's datum"
    print("   %d of %d points: DEM - GL median %+.2f m, mean %+.2f m, 5-95%% %+.2f .. %+.2f m, "
          "rms about the median %.2f m%s"
          % (cal["n"], len(rows), med, cal["mean"], cal["p5"], cal["p95"], cal["rms_after_median"],
             (" (with --dem-offset %+.2f applied)" % offset) if offset else ""))
    print("   The median is the vertical datum offset (global DEMs are geoid heights, EGM2008 / "
          "EGM96;\n   the levels are on %s) plus the canopy and buildings a surface model "
          "includes.\n   The spread about it is DSM noise and the DEM's averaging over each cell."
          % datum)
    if abs(med) > 0.5:
        print("   To put the DEM on the design datum, rebuild with   --dem-offset %.2f"
              % (offset - med))
    else:
        print("   Small enough to compare levels directly.")


def build_crz(args, grid, layers):
    """The 'crz' layer: an authoritative map if given, else a screening proxy.

    Returns a sentence for the project notes when the layer is a proxy, so the
    caveat travels with the project rather than living only in this console.
    """
    coast = args.coastline
    if not coast and args.osm and os.path.exists(os.path.join(args.osm, "coastline.geojson")):
        coast = os.path.join(args.osm, "coastline.geojson")
    if args.crz:
        # The approved CZMP already carries the HTL, the creek bands and the
        # mangrove buffers, drawn by the people whose line it is. Used as given.
        layers["crz"] = dp.rasterise_geojson(args.crz, grid, width_px=1,
                                             label="crz (authoritative)")
        if coast:
            print("   (--crz given: the coastline is not used for the CRZ)")
        return None
    have_mangrove = "mangrove" in layers and bool((layers["mangrove"] > 0).any())
    if not coast and args.crz_m != 500.0:
        print("   !! --crz-m has no coastline to measure from (give --coastline, or "
              "coastline.geojson in --osm)")
    if not coast and not have_mangrove:
        return None

    crz = np.zeros((grid.ny, grid.nx), bool)
    parts = []
    if coast and args.crz_m > 0:
        # Any cell the coastline touches counts as on it (coverage > 0). The
        # stroke is one cell wide and may touch two, so the band errs WIDE by
        # up to about a cell each side (~15 % at 100 m cells on 500 m, ~4 % at
        # 25 m) — the safe direction for a screening layer.
        line = dp.rasterise_geojson(coast, grid, width_px=1, outline=True,
                                    label="coastline") > 0
        if line.any():
            # Both sides of the line. Landward it is the CRZ's 500 m band from
            # the HTL; seaward the water itself is CRZ-IV, so a route out over
            # a creek mouth is in the zone either way.
            crz |= dp.buffer_mask(line, grid.cell, args.crz_m)
            parts.append("%g m either side of the coastline" % args.crz_m)
    if have_mangrove:
        crz |= dp.buffer_mask(layers["mangrove"] > 0, grid.cell, MANGROVE_BUFFER_M)
        parts.append("mangroves + %g m (CRZ-IA)" % MANGROVE_BUFFER_M)
    if not parts:
        print("   crz: the coastline file has no lines inside the grid — no CRZ layer")
        return None
    layers["crz"] = crz.astype(np.float32)
    print("   crz SCREENING PROXY — %s: %.2f%% of area" % (" + ".join(parts), crz.mean() * 100))
    print("      This is not the CRZ. The legal CRZ lines are drawn by the state Coastal Zone\n"
          "      Management Authority from the High Tide Line, along the sea AND along tidal\n"
          "      creeks, rivers and backwaters up to the tidal limit. The OSM coastline\n"
          "      approximates mean high water and stops at most creek mouths, so this band\n"
          "      misses the creeks inland and sits off the HTL. For anything past screening,\n"
          "      give the approved CZMP map as --crz FILE.")
    return ("The 'crz' layer is a screening proxy (%s), not the CZMA's CRZ map; the legal lines "
            "follow the High Tide Line along the sea and tidal creeks." % " + ".join(parts))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dem", required=True, nargs="+",
                    help="DEM file(s), folder(s), wildcard(s) or zip(s)")
    ap.add_argument("--id", required=True, help="short project id (folder name)")
    ap.add_argument("--name", help="display name")
    ap.add_argument("--cell", type=float, default=None,
                    help="design grid cell size in metres (default: automatic)")
    ap.add_argument("--max-cells", type=float, default=4.5e6,
                    help="largest grid the automatic cell size may produce (default 4.5e6)")
    ap.add_argument("--extent", nargs=4, type=float, metavar=("XMIN", "YMIN", "XMAX", "YMAX"),
                    help="world extent, required for a bare .npy DEM")
    ap.add_argument("--epsg", type=int, default=None,
                    help="EPSG code of a bare .npy DEM in projected metres (e.g. 32643 for "
                         "UTM 43N); georeferenced files carry their own")
    ap.add_argument("--dem-offset", type=float, default=0.0, metavar="METRES",
                    help="add this to every DEM cell after resampling (datum shift / DSM "
                         "bias; a --reference with surveyed ground suggests the value)")
    ap.add_argument("--clip", nargs=4, type=float, metavar=("XMIN", "YMIN", "XMAX", "YMAX"),
                    help="design grid extent in project-CRS metres")
    ap.add_argument("--bbox", nargs=4, type=float,
                    metavar=("LONMIN", "LATMIN", "LONMAX", "LATMAX"),
                    help="design grid extent in degrees")
    ap.add_argument("--buffer-km", type=float, default=None,
                    help="size the grid to the control points plus this margin")
    ap.add_argument("--zone", type=int, help="force a UTM zone")
    ap.add_argument("--notes", default="", help="free text shown in the project card")
    for flag, _key in LAYER_FLAGS:
        ap.add_argument("--" + flag, help="GeoJSON for the %s layer" % flag)
    ap.add_argument("--osm", help="folder of constraint GeoJSONs named by layer "
                                  "(as written by fetch_osm.py)")
    ap.add_argument("--coastline", help="coastline GeoJSON (lines; polygon rings are used as "
                                        "lines) for the CRZ screening proxy")
    ap.add_argument("--crz-m", type=float, default=500.0,
                    help="CRZ proxy band either side of the coastline, metres (default 500)")
    ap.add_argument("--crz", help="authoritative CRZ polygon GeoJSON (the CZMA's CZMP map) — "
                                  "used instead of the proxy")
    ap.add_argument("--reference", help="reference alignment JSON (an existing design: "
                                        "pts, stations, profile, structures, ground)")
    ap.add_argument("--reference-range", nargs=2, type=float, metavar=("CH0", "CH1"),
                    help="keep only this design-chainage window of the reference (metres)")
    ap.add_argument("--control", action="append", default=[],
                    help='control point "Name:lon,lat" (or "Name:E,N") — repeatable')
    ap.add_argument("--controls", help="CSV of control points: name, lat, lon [, kind] "
                                       "[, leg, level, depth]")
    ap.add_argument("--mode", default="road",
                    help="default design mode (road | rail | rail_hs | maglev | metro)")
    ap.add_argument("--speed", type=float, default=None, help="default design speed km/h")
    ap.add_argument("--relief-range", nargs=2, type=float, metavar=("MIN", "MAX"),
                    help="elevations the map's colours are spread over (default: the "
                         "ground within 15 km of the station line)")
    ap.add_argument("--no-antialias", action="store_true",
                    help="point-sample the DEM instead of averaging it over each cell")
    ap.add_argument("--projects-dir", default=PROJECTS, help=argparse.SUPPRESS)
    args = ap.parse_args()

    # ── 1. DEM tiles ────────────────────────────────────────────────────────
    print("\n[1] DEM")
    paths = dp.expand_dem_paths(args.dem)
    if not paths:
        sys.exit("no DEM files found in: %s" % " ".join(args.dem))
    if len(paths) == 1 and paths[0].lower().endswith(".npy"):
        r = dp.read_dem(paths[0], extent=tuple(args.extent) if args.extent else None)
        if args.epsg and r.geographic:
            print("   --epsg ignored: this --extent is in degrees, so the array is lon/lat")
        elif args.epsg:
            # A bare array has no CRS of its own. Without one the grid is "local
            # metric", and nothing in lon/lat (controls, a UTM reference) can be
            # placed on it.
            r.epsg = args.epsg
        tiles = [dp.DemTile(raster=r)]
    else:
        tiles = dp.open_tiles(paths)
        if args.epsg:
            print("   --epsg applies to a bare .npy only — ignored (these files carry their own)")
    geographic = tiles[0].geographic
    tb = dp.tiles_bounds(tiles)
    native = min(t.native_m() for t in tiles)
    print("   %d file%s, %s, native ~%.0f m/px" % (len(tiles), "" if len(tiles) == 1 else "s",
                                                  "degrees" if geographic else "metres", native))
    print("   covers %s %.3f .. %.3f, %s %.3f .. %.3f"
          % ("lon" if geographic else "E", tb[0], tb[2], "lat" if geographic else "N", tb[1], tb[3]))

    # ── 1b. reference alignment ─────────────────────────────────────────────
    # Read and clipped BEFORE the extent is chosen: with no --controls its ends
    # and stations become the control points, and --buffer-km sizes the grid
    # around them.
    ref = None
    if args.reference_range and not args.reference:
        sys.exit("--reference-range needs --reference")
    if args.reference:
        print("\n[1b] reference alignment")
        ref = load_reference(args.reference)
        print("   %s: EPSG:%s, CH %.0f - %.0f, %d vertices, %d stations"
              % (ref.get("name") or os.path.basename(args.reference), ref.get("epsg"),
                 ref["chainage_start_m"], ref["chainage_start_m"] + dp.polyline_cum(ref["pts"])[-1],
                 len(ref["pts"]), len(ref.get("stations") or [])))
        if args.reference_range:
            clip_reference(ref, *args.reference_range)
        else:
            expand_profile(ref)

    # ── 2. control points, raw ──────────────────────────────────────────────
    raw = []
    if args.controls:
        raw += dp.read_controls_csv(args.controls)
    raw += [parse_control(c, tb if geographic else None) for c in args.control]
    if not raw and ref is not None:
        raw = reference_controls(ref, geographic, tiles[0].epsg)
    if raw:
        print("   %d control point%s" % (len(raw), "" if len(raw) == 1 else "s"))

    # ── 3. extent and coordinate system ─────────────────────────────────────
    print("\n[2] design grid")
    if geographic:
        ll = [c for c in raw if "lat" in c]
        if args.bbox:
            box, why = tuple(args.bbox), "--bbox"
        elif args.buffer_km is not None and ll:
            box, why = dp.lonlat_bbox(ll, args.buffer_km), "control points + %g km" % args.buffer_km
        else:
            box, why = tb, "everything the DEM covers"
        if args.buffer_km is not None and not ll and not args.bbox:
            print("   !! --buffer-km needs control points given as lat/lon — using the DEM extent")
        lon_c, lat_c = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
        zone, hemi = (args.zone, "N" if lat_c >= 0 else "S") if args.zone else dp.utm_zone(lon_c, lat_c)
        epsg = dp.utm_epsg(zone, hemi)
        X0, Y0, X1, Y1 = dp.projected_bounds(*box, zone, hemi)
        if box[0] < tb[0] - 1e-6 or box[1] < tb[1] - 1e-6 or box[2] > tb[2] + 1e-6 or box[3] > tb[3] + 1e-6:
            print("   !! the extent reaches beyond the DEM files supplied — cells with no "
                  "DEM will be filled from the nearest ground and reported below")
        cm = (zone - 1) * 6 - 180 + 3
        worst = max(abs(box[0] - cm), abs(box[2] - cm))
        if worst > 3.0:
            k = 0.9996 * (1 + (math.radians(worst) * math.cos(math.radians(lat_c))) ** 2 / 2)
            print("   UTM %d%s spans %.1f deg either side of its meridian here; distances "
                  "are within %.2f%% of true" % (zone, hemi, worst, abs(k - 1) * 100))
    else:
        zone, hemi = utm_of_epsg(tiles[0].epsg)
        epsg = tiles[0].epsg
        # Station CSVs give lat/lon; in a UTM project they size the box just as
        # well once projected. Taking only the E/N rows silently fell back to
        # "everything the DEM covers" for every studies/*.csv (found in review).
        en = [c for c in raw if "E" in c]
        if zone is not None:
            for c in raw:
                if "lat" in c and "E" not in c:
                    x, y = dp.utm_forward(c["lon"], c["lat"], zone, hemi)
                    en.append({"E": float(x), "N": float(y)})
        if args.buffer_km is not None and not en and raw:
            print("   !! --buffer-km needs control points this DEM's CRS can place — using the DEM extent")
        if args.buffer_km is not None and en:
            b = args.buffer_km * 1000
            X0 = min(c["E"] for c in en) - b; X1 = max(c["E"] for c in en) + b
            Y0 = min(c["N"] for c in en) - b; Y1 = max(c["N"] for c in en) + b
            why = "control points + %g km" % args.buffer_km
        else:
            X0, Y0, X1, Y1 = tb
            why = "everything the DEM covers"
    if args.clip:
        X0, Y0, X1, Y1 = args.clip
        why = "--clip"

    W, H = X1 - X0, Y1 - Y0
    if args.cell:
        cell, reason = float(args.cell), "--cell"
    else:
        cell, reason = dp.auto_cell(W, H, native, args.max_cells)
    grid = dp.grid_from_metric_box(X0, Y0, X1, Y1, cell, epsg=epsg, zone=zone,
                                   hemi=hemi or "N", max_cells=args.max_cells)
    print("   extent from %s: %.0f x %.0f km" % (why, W / 1000, H / 1000))
    print("   cell %g m (%s)" % (cell, reason))
    print("   %r%s" % (grid, ("   EPSG:%d" % grid.epsg) if grid.epsg else ""))
    if ref is not None:
        # Now that the grid's CRS is known; and checked before the terrain is
        # built, so a reference that does not fit costs seconds, not minutes.
        reproject_reference(ref, grid)
        check_reference_inside(ref, grid, args)

    # ── 4. terrain ──────────────────────────────────────────────────────────
    print("\n[3] terrain")
    dem, used = dp.resample_tiles(tiles, grid, antialias=not args.no_antialias)
    missing = ~np.isfinite(dem)
    if missing.all():
        sys.exit("none of the DEM files overlaps the design grid — check the extent")
    if missing.any():
        print("   !! %.2f%% of the grid has no DEM coverage — filled from the nearest "
              "ground. Download the missing tiles if the route could go there."
              % (missing.mean() * 100))
        if dp.distance_transform_edt is not None:
            idx = dp.distance_transform_edt(missing, return_distances=False, return_indices=True)
            dem = dem[tuple(idx)]
        else:
            dem = np.nan_to_num(dem, nan=float(np.nanmedian(dem)))
    if args.dem_offset:
        # After resampling and void filling, before anything reads the DEM:
        # slope is blind to a constant, but the hillshade's colours, the
        # relief range and the reference calibration all see the shifted ground.
        dem = (dem + np.float32(args.dem_offset)).astype(np.float32)
        print("   --dem-offset %+.2f m added to every cell" % args.dem_offset)
    slope = dp.slope_percent(dem, grid.cell)
    print("   %d tile%s used; elevation %.0f .. %.0f m   slope median %.1f%%  p95 %.1f%%"
          % (used, "" if used == 1 else "s", dem.min(), dem.max(), np.median(slope),
             np.percentile(slope, 95)))
    layers = {"dem": dem.astype(np.float32), "slope": slope}

    # ── 5. constraints ──────────────────────────────────────────────────────
    print("\n[4] constraint layers")
    sources = {}
    if args.osm:
        for flag, _key in LAYER_FLAGS:
            f = os.path.join(args.osm, flag + ".geojson")
            if os.path.exists(f):
                sources[flag] = f
    for flag, _key in LAYER_FLAGS:
        if getattr(args, flag):
            sources[flag] = getattr(args, flag)            # explicit flag wins
    for flag, key in LAYER_FLAGS:
        if flag in sources:
            layers[key] = dp.rasterise_geojson(sources[flag], grid, width_px=1)
    crz_note = build_crz(args, grid, layers)
    if not sources and "crz" not in layers:
        print("   none supplied — the route will be driven by terrain alone.")
        print("   Add --osm FOLDER or --built/--protected/--water/... GeoJSON to bring "
              "constraints in.")
    if "water_body" in layers:
        # Rivers, separately from all water. Crossing ANY water costs (ponds,
        # canals, lakes — water_body), crossing a river costs more (river_major),
        # and the floodplain is measured from rivers alone: on the Gangetic plain
        # every village has a pond and the canals reach everywhere, and HAND
        # measured from those called 55 % of Delhi – Agra "floodplain".
        rivers = dp.rasterise_geojson(sources["water"], grid, width_px=1,
                                      select=is_river, label="  of which rivers")
        if rivers.max() > 0:
            layers["river_major"] = rivers
            drain = rivers
        else:
            print("   !! no feature in the water layer is marked as a river — floodplain "
                  "and river crossings use all water. Re-fetch it with fetch_osm.py "
                  "(--only water --force) to get the river tags.")
            layers["river_major"] = layers["water_body"]
            drain = layers["water_body"]
        fp = dp.flood_proxy(dem, drain, grid.cell)
        if isinstance(fp, tuple):
            layers["flood"] = fp[0]
            print("   flood proxy (HAND < 4 m within 1.5 km of water): %.1f%% of area"
                  % (fp[0].mean() * 100))

    # ── 6. control points, projected ────────────────────────────────────────
    controls = []
    for i, c in enumerate(raw):
        if "lat" in c:
            if zone is None:
                sys.exit("control %s is in lat/lon but the DEM's projection is not UTM — "
                         "give it as easting,northing" % c["name"])
            x, y = dp.utm_forward(c["lon"], c["lat"], zone, hemi)
            E, N = float(x), float(y)
        else:
            E, N = c["E"], c["N"]
        ident = "".join(ch for ch in c["name"] if ch.isalnum())[:10] or ("CP%d" % (i + 1))
        cp = {"id": ident, "name": c["name"], "E": round(float(E), 1), "N": round(float(N), 1),
              "kind": c.get("kind", "control")}
        # Vertical intent from the CSV, only where a row gives it: the browser
        # treats a missing key as "the standard's own policy" (app.js, study.js).
        if c.get("leg"):
            cp["leg"] = c["leg"]
        for key in ("level", "depth"):
            if c.get(key) is not None:
                cp[key] = float(c[key])
        controls.append(cp)
    if controls:
        print("\n[5] control points")
    for c in controls:
        ix = int((c["E"] - grid.xmin) / grid.cell)
        iy = int((grid.ymax - c["N"]) / grid.cell)
        intent = "".join(["   leg %s" % c["leg"] if "leg" in c else "",
                          "   rail level %.1f m" % c["level"] if "level" in c else "",
                          "   rail %.1f m below ground" % c["depth"] if "depth" in c else ""])
        if not (0 <= ix < grid.nx and 0 <= iy < grid.ny):
            print("   !! %-22s falls OUTSIDE the grid — widen --buffer-km or --bbox" % c["name"])
        else:
            print("   %-22s E %9.0f  N %10.0f   ground %5.0f m%s"
                  % (c["name"], c["E"], c["N"], dem[iy, ix], intent))
    if ref is not None:
        calibrate_reference(ref, dem, grid, args.dem_offset)

    # ── 7. pack ─────────────────────────────────────────────────────────────
    print("\n[6] preview + pack")
    outdir = os.path.join(args.projects_dir, args.id)
    os.makedirs(outdir, exist_ok=True)
    dp.hillshade_png(dem, grid.cell, os.path.join(outdir, "terrain.png"))
    defaults = {"mode": args.mode}
    if args.speed:
        defaults["designSpeed"] = args.speed
    focus, why_focus = None, ""
    if args.relief_range:
        focus, why_focus = [float(v) for v in args.relief_range], "--relief-range"
    elif len(controls) >= 2:
        focus = corridor_relief(dem, grid, controls, 15000.0)
        why_focus = "the ground within 15 km of the station line"
    if focus:
        defaults["terrainFocus"] = focus
        print("   map colours spread over %.0f .. %.0f m (%s)" % (focus[0], focus[1], why_focus))
    name = args.name or args.id
    src = (os.path.basename(paths[0]) if len(paths) == 1
           else "%d DEM tiles (%s …)" % (len(paths), os.path.basename(paths[0])))
    notes = args.notes or ("Imported from %s at %g m cells." % (src, cell))
    if args.dem_offset:
        notes += " DEM shifted by %+.2f m (--dem-offset)." % args.dem_offset
    if crz_note:
        notes += " " + crz_note
    if ref is not None:
        # Plain JSON only: numpy scalars would not serialise, and a NaN would
        # be written as a bare NaN token that the browser's JSON.parse rejects.
        ref["pts"] = [[round(x, 3), round(y, 3)] for x, y in ref["pts"]]
        ref = dp.json_plain(ref)
    dp.pack_project(outdir, args.id, name, grid, layers, controls=dp.json_plain(controls),
                    notes=notes, defaults=defaults, reference=ref)
    dp.update_index(args.projects_dir, {
        "id": args.id, "name": name,
        "file": "%s/project.json" % args.id,
        "thumb": "%s/terrain.png" % args.id,
        "crs": ("EPSG:%d" % grid.epsg) if grid.epsg else "local metric",
        "extent_km": [round((grid.xmax - grid.xmin) / 1000, 1),
                      round((grid.ymax - grid.ymin) / 1000, 1)],
        "cell": grid.cell,
        "layers": sorted(layers.keys()),
        "notes": notes,
    })
    print("\ndone — reload the app and pick '%s' from the project list.\n" % name)


if __name__ == "__main__":
    main()
