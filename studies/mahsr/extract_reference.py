"""
MAHSR study — export the as-designed C-4 alignment from CivilWorksApp as an
Alignment Designer reference.

CivilWorksApp (a separate, read-only project) carries the NHSRCL design data
for package C-4 of the Mumbai - Ahmedabad high-speed rail: Zaroli (Maharashtra
- Gujarat border) to Vadodara, CH 156.600 - 393.735 km. This script reads its
`data/` folder — it never writes there — and produces, in --out:

    reference_c4.json       the reference the importer reads
                            (import_dem.py --reference ...): centre line,
                            stations, rail-level grade table, structure runs,
                            surveyed ground levels, and notes on every
                            correction and gap
    mahsr_piers.csv         one row per span-start pier, CH 156.6 - 393.7 km
    mahsr_profile_20m.csv   the centre line every --step m, CH 157.0 - 401.0 km,
                            with structure, rail level and pier GL where known

    python studies/mahsr/extract_reference.py
    python studies/mahsr/extract_reference.py --civilworks D:/CivilWorksApp --out somewhere/

The outputs are NHSRCL design data. They go to studies/mahsr/private/ by
default, which .gitignore keeps out of the repository; keep them out of git.

What the data is, and how each piece was verified (2026-10-06):

  * CENTRE LINE. The KML layer C-ROAD-CNTR-N (bundled in data/kml_map.json):
    36 LineStrings, about a third stored reversed, that chain end to end with
    0 m gaps into one 1,520-vertex polyline. The design chainage is the
    cumulative UTM 43N (WGS84, EPSG:32643) GRID length along it plus
    157,000 m: projecting the 1,569 coordinated piers (S5 and GAD) onto it
    reproduces their chainage to a few centimetres, with no chainage
    equations anywhere. Grid length, not ground length — the UTM scale
    factor here is 1.00003 - 1.00019, so measuring on the ellipsoid would put
    CH 393 km ~50 m off, and on a sphere ~0.9 km off. The self-check below
    re-derives this every run.
  * RAIL LEVELS exist for S5 only (CH 333.641 - 393.700, 1,533 piers in
    data/pier_geom.json), with the S5 grade table `vgrad` (VIPs CH 331.5 -
    391.9 km). The table has no vertical-curve parameters, but symmetric
    parabolic curves of R = 25,000 m at every interior VIP rebuild every pier
    rail level to about a millimetre rms — once the one 1.000 m typo at
    367P13 is corrected. The reference therefore carries the VIP table
    ("pvi" + "vc_radius_m"), not dense levels: the importer expands it.
  * STRUCTURES come from data/piers_master.json (every span on C-4 and its
    erection method / structure type), merged into runs, plus mountain tunnel
    MT-08 from data/civil_structures.json.
  * GROUND is the surveyed natural ground level at each S5 pier (pier_geom
    'gl', identical to the KML 'GL'), at the pier's own KML EAST/NORTH.

Needs numpy only; dempack (designer/build) supplies utm_forward/utm_inverse.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(REPO, "designer", "build"))
import dempack as dp  # noqa: E402  (WGS84 <-> UTM, no pyproj)

DEFAULT_CIVILWORKS = r"C:\Users\SWAPNIL\IdeaProjects\CivilWorksApp"
DEFAULT_OUT = os.path.join(HERE, "private")

ZONE, EPSG = 43, 32643          # every E, N in the outputs is WGS84 / UTM 43N
CH0 = 157000.0                  # design chainage of the first centre-line vertex
RV = 25000.0                    # vertical-curve radius that rebuilds the S5 pier levels
OPEN_END_M = 2000.0             # how far an open-ended last grade is carried, at most
VADODARA_CH = 397000.0          # not in the data: by position, beside Vadodara Jn

# Rail-level corrections: pier -> (value in the data, corrected value, why).
RAIL_FIXES = {
    "367P13": (32.8, 31.8,
               "367P13 rail level 32.8 corrected to 31.8: a 1.000 m typo. It sits on the "
               "22.3 km level grade at 31.8 m (CH 353.5 - 375.8), its pier-cap level equals "
               "its neighbours', and 32.8 would be a +/-25 per-mille spike between them."),
}

# piers_master 'type' -> (structure kind for the designer, label).
KIND = {
    "FSLM": ("viaduct", "viaduct"),
    "SBS": ("viaduct", "viaduct"),
    "CEM": ("viaduct", "viaduct"),
    "FSLM-River": ("bridge", "river bridge"),
    "SBS-River": ("bridge", "river bridge"),
    "PSC-Box Girder": ("bridge", "special span"),
    "Steel Girder": ("bridge", "special span"),
    "Station": ("station", "station"),
    "Earth": ("embankment", "earthwork"),
}
SNAP_M = 2.0     # piers_master chainages near stations alternate by +/-1 m (integer rounding)


# ────────────────────────────────────────────────────────────────── input ──
def data_dir(path):
    """Accept either the CivilWorksApp root or its data/ folder."""
    for d in (os.path.join(path, "data"), path):
        if os.path.exists(os.path.join(d, "piers_master.json")):
            return d
    sys.exit("no CivilWorksApp data under %s (looked for data/piers_master.json)" % path)


def load(d, name):
    with open(os.path.join(d, name), encoding="utf-8") as f:     # read only
        return json.load(f)


def kml_layers(d):
    return load(d, "kml_map.json")["sources"][0]["layers"]


def chain_centreline(layers):
    """The 36 C-ROAD-CNTR-N pieces as one polyline, Mumbai end first.

    Pieces are chained greedily by nearest endpoint, flipping reversed ones,
    starting from the southernmost free end (the Mumbai side). Every joint in
    the data closes exactly; anything over 0.5 m is treated as an error rather
    than bridged, because a silent bridge would shift every chainage after it.
    """
    L = next(l for l in layers if "C-ROAD-CNTR-N" in l["name"])
    segs = []
    for f in L["features"]:
        if f["g"]["type"] != "LineString":       # 'Polygon 3' is a 5 m marker, not alignment
            continue
        ll = np.asarray(f["g"]["coordinates"], float)[:, :2]
        e, n = dp.utm_forward(ll[:, 0], ll[:, 1], ZONE)
        segs.append(np.column_stack([e, n]))
    ends = [(i, r) for i in range(len(segs)) for r in (False, True)]
    i, r = min(ends, key=lambda t: (segs[t[0]][-1] if t[1] else segs[t[0]][0])[1])
    out = [segs[i][::-1] if r else segs[i]]
    left = set(range(len(segs))) - {i}
    worst = 0.0
    while left:
        tail = out[-1][-1]
        j, r = min(((j, r) for j in left for r in (False, True)),
                   key=lambda t: np.hypot(*((segs[t[0]][-1] if t[1] else segs[t[0]][0]) - tail)))
        s = segs[j][::-1] if r else segs[j]
        gap = float(np.hypot(*(s[0] - tail)))
        if gap > 0.5:
            sys.exit("C-ROAD-CNTR-N has a %.2f m gap before piece %d; not bridging it" % (gap, j))
        worst = max(worst, gap)
        out.append(s[1:])
        left.remove(j)
    P = np.vstack(out)
    keep = np.r_[True, np.hypot(*np.diff(P, axis=0).T) > 0.001]   # unique vertices
    return P[keep], len(segs), worst


def kml_piers(layers):
    """pid -> {E, N, ch} from the coordinated pier layers (S5 piers and GAD piers).

    Their EAST/NORTH attributes are UTM 43N and agree with the chainage; the
    point geometry (lat/lon) of a few S5 piers is off by up to ~5 m (a sheet
    error), so the attributes are used, not the geometry.
    """
    out = {}
    for L in layers:
        if not ("Section 5 piers" in L["name"] or "GAD piers" in L["name"]):
            continue
        for f in L["features"]:
            pid = f.get("pid")
            if not pid:
                continue
            p = {k.strip().upper(): v for k, v in f.get("p") or []}
            try:
                e = float(p["EAST"].replace(",", ""))
                n = float(p["NORTH"].replace(",", ""))
                ch = float(p["CHAINAGE"].replace(",", ""))
            except (KeyError, ValueError):
                continue
            ge, gn = dp.utm_forward(*f["g"]["coordinates"][:2], ZONE)
            out.setdefault(pid, dict(E=e, N=n, ch=ch, layer=L["name"].split("/")[-1].strip(),
                                     geom_off=float(np.hypot(ge - e, gn - n))))
    return out


# ───────────────────────────────────────────────────────────── geometry ──
def project(P, pts):
    """Station (grid distance from pts[0]) and signed offset of each point in P."""
    A, B = P[:-1], P[1:]
    AB = B - A
    L2 = (AB ** 2).sum(1)
    s0 = np.r_[0, np.cumsum(np.sqrt(L2))]
    s_out, d_out = np.empty(len(pts)), np.empty(len(pts))
    for k in range(0, len(pts), 256):
        Q = pts[k:k + 256, None, :]
        t = np.clip(((Q - A) * AB).sum(2) / L2, 0, 1)
        X = A + t[..., None] * AB
        D = np.hypot(*(X - Q).transpose(2, 0, 1))
        j = D.argmin(1)
        r = np.arange(len(j))
        s_out[k:k + 256] = s0[j] + t[r, j] * np.sqrt(L2[j])
        cross = AB[j, 0] * (Q[r, 0, 1] - A[j, 1]) - AB[j, 1] * (Q[r, 0, 0] - A[j, 0])
        d_out[k:k + 256] = np.sign(cross) * D[r, j]     # + = left of the direction of chainage
    return s_out, d_out


# ────────────────────────────────────────────────────────────── profile ──
def vip_table(vgrad, data_end):
    """VIP list [[ch, level], ...] from the grade table, plus any warnings.

    Rows are grades from VIP 'from' (level gp0) to VIP 'to' (level gp1). The
    last row may be open-ended ('to' = 0): that grade continues into a section
    whose table is not bundled, so it is carried OPEN_END_M beyond its VIP or
    to the end of the C-4 span data, whichever comes first — no further.
    """
    rows = sorted(vgrad, key=lambda g: g["from"])
    warn = []
    pvi = [[float(rows[0]["from"]), float(rows[0]["gp0"])]]
    for a, b in zip(rows, rows[1:]):
        if a["to"] != b["from"] or abs(a["gp1"] - b["gp0"]) > 1e-6:
            warn.append("grade rows %s/%s do not join (%s:%s vs %s:%s)"
                        % (a["no"], b["no"], a["to"], a["gp1"], b["from"], b["gp0"]))
    for g in rows:
        sgn = {"RISE": 1, "FALL": -1}.get(g["dir"], 0)
        if g["to"] > 0:
            pct = 100 * (g["gp1"] - g["gp0"]) / (g["to"] - g["from"])
            if abs(pct - sgn * g["pct"]) > 0.0015:
                warn.append("grade row %s: stated %s %.3f %% but levels give %.4f %%"
                            % (g["no"], g["dir"], g["pct"], pct))
            pvi.append([float(g["to"]), float(g["gp1"])])
        else:
            end = min(g["from"] + OPEN_END_M, data_end)
            if end > g["from"]:
                pvi.append([float(end), round(g["gp0"] + sgn * g["pct"] / 100 * (end - g["from"]), 4)])
    return pvi, warn


def pvi_levels(pvi, R, ch):
    """Rail level at ch from a VIP table with symmetric parabolic vertical curves.

    Each interior VIP gets a curve of length R*|dg| centred on it (tangent
    length T = R*|dg|/2); the ends get none. This is the same normalisation
    the importer applies, so what is checked here is what the designer sees.
    NaN outside the table.
    """
    vx, vy = np.array(pvi, float).T
    ch = np.asarray(ch, float)
    g = np.diff(vy) / np.diff(vx)
    y = np.interp(ch, vx, vy)
    for i in range(1, len(vx) - 1):
        A = g[i] - g[i - 1]
        T = R * abs(A) / 2
        y = y + np.sign(A) * np.maximum(0.0, T - np.abs(ch - vx[i])) ** 2 / (2 * R)
    return np.where((ch >= vx[0]) & (ch <= vx[-1]), y, np.nan)


# ─────────────────────────────────────────────────────────── structures ──
def structure_runs(master, civil_structures, station_names):
    """Declared structure runs [ch0, ch1, kind, label] in chainage order.

    Labels are plain ASCII on purpose: the file is read on Windows too, where
    a reader that forgets encoding='utf-8' would mangle a dash.
    station_names: [(ch_from, ch_to, name)] from civil_stations.json.
    """
    def length(v):
        return "%.1f km" % (v / 1000) if v >= 100 else "%d m" % round(v)

    def station_at(a, b):
        for c0, c1, nm in station_names:
            if c0 < b and a < c1:
                return nm
        return None

    spans = sorted(master.values(), key=lambda m: m["ch_from"])
    runs = []                         # [ch0, ch1, kind, label, {type: metres}, [spans]]
    for m in spans:
        kind, label = KIND.get(m["type"], ("viaduct", "viaduct (%s)" % m["type"]))
        a, b = float(m["ch_from"]), float(m["ch_to"])
        if runs and runs[-1][2] == kind and runs[-1][3] == label and abs(a - runs[-1][1]) <= SNAP_M:
            r = runs[-1]
            r[1] = b
        else:
            if runs and abs(a - runs[-1][1]) <= SNAP_M:
                a = runs[-1][1]       # snap the +/-1 m rounding so runs are contiguous
            r = [a, b, kind, label, {}, []]
            runs.append(r)
        r[4][m["type"]] = r[4].get(m["type"], 0) + (b - float(m["ch_from"]))
        r[5].append(int(m["span_m"]))

    # Tunnels and other non-pier structures (MT-08) fill the gaps between spans.
    for sec in civil_structures.values():
        for s in sec:
            if s.get("type") == "tunnel":
                runs.append([float(s["ch_from"]), float(s["ch_to"]), "tunnel",
                             "%s mountain tunnel" % s.get("name", ""), {}, []])
    runs.sort(key=lambda r: r[0])

    out = []
    for a, b, kind, label, types, spans_m in runs:
        if label == "special span":
            what = "+".join(sorted(t.lower() for t in types))
            label = "special span: %s, %s m" % (what, "+".join(str(x) for x in spans_m))
        elif label == "river bridge":
            label = "river bridge: %s, %d spans" % ("+".join(sorted(types)), len(spans_m))
        elif kind == "station":
            label = "%s station (elevated, %d m)" % (station_at(a, b) or "?", round(b - a))
        elif kind == "viaduct":
            label = "viaduct: " + ", ".join("%s %s" % (t, length(v))
                                           for t, v in sorted(types.items(), key=lambda kv: -kv[1]))
        out.append([a, b, kind, label])
    return out


# ───────────────────────────────────────────────────────────────── main ──
def stats(x):
    x = np.asarray(x, float)
    x = x[np.isfinite(x)]
    return dict(n=len(x), rms=float(np.sqrt((x ** 2).mean())), med=float(np.median(x)),
                sd=float(x.std()), maxabs=float(np.abs(x).max()))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--civilworks", default=DEFAULT_CIVILWORKS,
                    help="CivilWorksApp folder, or its data/ folder (read only)")
    ap.add_argument("--out", default=DEFAULT_OUT, help="output folder (default studies/mahsr/private)")
    ap.add_argument("--step", type=float, default=20.0, help="profile CSV spacing, m (default 20)")
    a = ap.parse_args()

    d = data_dir(a.civilworks)
    # Refuse to write anywhere under CivilWorksApp — its root, not just the folder
    # given: --civilworks may name data/ itself. commonpath, not a string prefix,
    # so a sibling such as CivilWorksApp2/ is not mistaken for it.
    root = os.path.dirname(d) if os.path.basename(os.path.normpath(d)).lower() == "data" else d
    root, out = os.path.normcase(os.path.abspath(root)), os.path.normcase(os.path.abspath(a.out))
    try:
        inside = os.path.commonpath([root, out]) == root
    except ValueError:                                    # different drives
        inside = False
    if inside:
        sys.exit("--out is inside CivilWorksApp, which is read only")
    os.makedirs(a.out, exist_ok=True)

    layers = kml_layers(d)
    master = load(d, "piers_master.json")
    geom = load(d, "pier_geom.json")["SEC-5"]
    civil_structures = load(d, "civil_structures.json")
    civil_stations = load(d, "civil_stations.json")
    P5 = {k: dict(v) for k, v in geom["piers"].items()}
    vgrad = geom["vgrad"]

    # ---- centre line and its chainage
    P, npieces, worst_gap = chain_centreline(layers)
    P = np.round(P, 3)                                    # what the reference stores
    s = np.r_[0, np.cumsum(np.hypot(*np.diff(P, axis=0).T))]
    CH = CH0 + s
    lon0, lat0 = dp.utm_inverse(P[0, 0], P[0, 1], ZONE)
    lon1, lat1 = dp.utm_inverse(P[-1, 0], P[-1, 1], ZONE)

    def at(ch):
        """E, N on the centre line at a chainage (interpolated in UTM, not lat/lon)."""
        return np.interp(ch, CH, P[:, 0]), np.interp(ch, CH, P[:, 1])

    # ---- chainage calibration: every coordinated pier projected onto the line
    kp = kml_piers(layers)
    ids = sorted(kp, key=lambda k: kp[k]["ch"])
    XY = np.array([[kp[k]["E"], kp[k]["N"]] for k in ids])
    sp, off = project(P, XY)
    res = (sp + CH0) - np.array([kp[k]["ch"] for k in ids])
    fit = np.polyfit(sp, [kp[k]["ch"] for k in ids], 1)

    # ---- rail levels: corrections, then the grade table
    fixes = []
    for pid, (was, now, why) in RAIL_FIXES.items():
        if pid in P5 and abs(P5[pid].get("rail", np.nan) - was) < 1e-6:
            P5[pid]["rail"] = now
            fixes.append(why)
    data_end = max(float(m["ch_to"]) for m in master.values())
    pvi, grade_warn = vip_table(vgrad, data_end)
    rail_ids = sorted((k for k in P5 if P5[k].get("rail") is not None), key=lambda k: P5[k]["ch"])
    rch = np.array([P5[k]["ch"] for k in rail_ids])
    rr = np.array([P5[k]["rail"] for k in rail_ids])
    rail_res = pvi_levels(pvi, RV, rch) - rr
    lin_res = pvi_levels(pvi, 1e-9, rch) - rr            # the bare grade table, no curves
    unfixed = {pid: float(pvi_levels(pvi, RV, P5[pid]["ch"]) - was)
               for pid, (was, now, why) in RAIL_FIXES.items() if pid in P5}

    # ---- structures
    station_names = [(float(st["ch_from"]), float(st["ch_to"]), st["name"])
                     for items in civil_stations.values() if isinstance(items, list)
                     for st in items]
    structures = structure_runs(master, civil_structures, station_names)
    ch_moved = [(pid, P5[pid]["ch"], master[pid]["ch_from"]) for pid in sorted(P5)
                if pid in master and float(master[pid]["ch_from"]) != float(P5[pid]["ch"])]

    # ---- stations: the four C-4 stations from the data, Vadodara by position
    stations = []
    for sec, items in civil_stations.items():
        if not isinstance(items, list):
            continue
        for st in items:
            c = (st["ch_from"] + st["ch_to"]) / 2
            e, n = at(c)
            stations.append(dict(id=st["name"], name=st["name"], kind="station",
                                 E=round(float(e), 3), N=round(float(n), 3),
                                 chainage_m=float(c), approximate=False))
    e, n = at(VADODARA_CH)
    stations.append(dict(id="Vadodara", name="Vadodara", kind="station",
                         E=round(float(e), 3), N=round(float(n), 3),
                         chainage_m=VADODARA_CH, approximate=True))
    stations.sort(key=lambda t: t["chainage_m"])

    # ---- ground: surveyed GL at the S5 piers, at the pier's own E/N
    ground, gl_missing, xy_from_line = [], [], 0
    for pid in sorted(P5, key=lambda k: P5[k]["ch"]):
        g = P5[pid]
        if g.get("gl") is None:
            gl_missing.append(pid)
            continue
        if pid in kp:
            e, n = kp[pid]["E"], kp[pid]["N"]
        else:
            e, n = at(g["ch"])
            xy_from_line += 1
        ground.append([float(g["ch"]), round(float(g["gl"]), 3),
                       round(float(e), 3), round(float(n), 3)])

    # ---- rail above ground at the S5 piers, and pier points whose geometry disagrees
    rg = np.array([P5[k]["rail"] - P5[k]["gl"] for k in rail_ids if P5[k].get("gl") is not None])
    bad_geom = sorted((v["geom_off"], k) for k, v in kp.items() if v["geom_off"] > 1.0)[::-1]

    # ---- notes: every correction and every gap, in words (ASCII only)
    gch = np.array([r[0] for r in ground])
    moved = []
    for pid, c5, cm in ch_moved:
        moved.append("%s: pier_geom.json puts it at CH %.0f, piers_master.json at CH %.0f." % (pid, c5, cm))
        if pid == "391P13":
            moved[-1] += (" The merger KML agrees with pier_geom (rail 52.29) and the Vishwamitri "
                          "KMZ with piers_master (rail 52.327); each level matches the grade table "
                          "at its own chainage, so this is a pier-position revision, not a level "
                          "error. Ground and the rail check use pier_geom's chainage.")
    notes = [
        "Source: NHSRCL design data for MAHSR package C-4 as bundled in CivilWorksApp/data "
        "(kml_map.json layer C-ROAD-CNTR-N; pier_geom.json SEC-5; piers_master.json; "
        "civil_structures.json; civil_stations.json), itself built from the KML 'MAHSR & "
        "Viswamitri Merger' and the KMZ 'Vishwamitri River with Alignment'. NHSRCL design "
        "data: keep this file out of public repositories.",
        "Chainage = %.0f + cumulative WGS84/UTM 43N GRID length along pts (no chainage "
        "equations). Checked on %d coordinated piers (S5 + GAD): residual median %+.3f m, "
        "sd %.3f m, max |%.3f| m; lateral offset median %.3f m, max %.2f m."
        % (CH0, len(res), np.median(res), res.std(), np.abs(res).max(),
           np.median(np.abs(off)), np.abs(off).max()),
        "Centre line: %d LineStrings chained end to end (largest joint gap %.3f m), %d unique "
        "vertices; coordinates were rounded to 1e-6 deg (~0.1 m) in the KML. It runs CH "
        "%.3f - %.3f km, i.e. past the end of C-4 (CH 393.735) into Vadodara; there are no "
        "structures or levels beyond CH 393.735." % (npieces, worst_gap, len(P), CH[0] / 1000,
                                                     CH[-1] / 1000),
        "The C-4 span data starts at CH 156.600, before the centre line: spans CH 156.600 - "
        "157.000 (CEM viaduct, earthwork, the first 300 m of tunnel MT-08) lie before pts[0] "
        "and have no coordinates.",
    ] + fixes + moved + [
        "Design levels exist for S5 only: pier rail levels CH 333.641 - 393.700 and the S5 grade "
        "table (VIP #103 - #116, CH 331.5 - 391.9 km). S1 - S4 (CH 156.6 - 333.6, including the "
        "Vapi, Bilimora, Surat and Bharuch stations) have span types and lengths but no rail, "
        "ground or pier levels. Earlier VIPs (#1 - #102) are not bundled.",
        "Profile: VIP table %s; the last grade row is open-ended (LEVEL at %.1f m from CH "
        "%.0f) and is carried only to CH %.0f, the end of the C-4 span data. No vertical-curve "
        "radius is stated anywhere: R = %.0f m symmetric parabolas are inferred because they "
        "rebuild the S5 pier rail levels to %.1f mm rms (max %.0f mm); the bare grade table "
        "without curves is off by up to %.2f m at the VIPs. The first VIP (CH 331,500) is in "
        "S4 and has no known incoming grade, so no curve is put there."
        % ("rows join exactly" if not grade_warn else "WARNINGS: " + "; ".join(grade_warn),
           vgrad[-1]["gp0"], vgrad[-1]["from"], pvi[-1][0], RV,
           1000 * stats(rail_res)["rms"], 1000 * stats(rail_res)["maxabs"],
           stats(lin_res)["maxabs"]),
        "Vertical datum not stated in the data (rail and ground levels presumably project "
        "datum / MSL). The Copernicus DEM is EGM2008 and a surface model (DSM: trees, "
        "buildings), so compare it with the surveyed ground here before using it as ground.",
        "Profile kind 'rail' = top of rail. On S5: rail - pier-cap top = 3.95 m for FSLM "
        "(3.75 m SBS); pier-cap top - GL = 'height of pier above ground'; rail - GL over %d "
        "piers is %.2f - %.2f m (median %.2f m, p95 %.2f m), the minimum at the sags of the "
        "grade line, which is set to just clear ground." % (len(rg), rg.min(), rg.max(),
                                                           np.median(rg), np.percentile(rg, 95)),
        "Ground: surveyed natural ground level at %d S5 piers, CH %.0f - %.0f, at each pier's "
        "KML EAST/NORTH attribute (%d from the centre line instead). GL missing at %s. The KML "
        "point geometry of %s is off its own EAST/NORTH by more than 1 m; the attributes agree "
        "with the chainage and are what is used here. The Vishwamitri KMZ (a different revision, "
        "CH 370 - 393.7) differs at 27 GL values; this export follows pier_geom.json, which "
        "matches the merger KML." % (len(ground), gch.min(), gch.max(), xy_from_line,
                                     ", ".join(gl_missing) or "none",
                                     ", ".join("%s (%.1f m)" % (k, v) for v, k in bad_geom) or "no pier"),
        "Structures: piers_master span types merged into runs (FSLM / SBS / CEM -> viaduct; "
        "FSLM-River / SBS-River -> bridge 'river bridge'; PSC-Box Girder / Steel Girder -> "
        "bridge 'special span'; Station -> station; Earth -> embankment), plus mountain "
        "tunnel MT-08 (CH 156,700 - 157,050) from civil_structures.json, which has no levels, "
        "portals or coordinates. piers_master chainages near stations alternate by +/-1 m "
        "(integer rounding); runs are snapped to be contiguous. CEM (an erection method) is "
        "not defined in the data; treated as viaduct.",
        "Stations: Vapi, Bilimora, Surat and Bharuch at the mid-chainage of their extent in "
        "civil_stations.json (all elevated, 425 - 450 m long). Vadodara is NOT in the data: "
        "CH %.1f km is its approximate position beside Vadodara Jn (approximate: true). The "
        "SEC-5 'stations' in pier_geom.json are traction power sites, not passenger stations."
        % (VADODARA_CH / 1000),
        "Not in the data at all: Mumbai BKC - Zaroli (CH 0 - 156.6: the BKC underground station, "
        "the ~21 km BKC - Shilphata tunnel with ~7 km under Thane Creek, Thane, Virar, Boisar) "
        "and Vadodara - Sabarmati (beyond CH ~401). No horizontal IP/curve table either: radii "
        "(R 6,000 / 8,000 m arcs, ~600 - 650 m transitions on C-4) can only be recovered "
        "approximately from the polyline. No environmental layers, ROW or river levels.",
    ]

    ref = dict(
        name="MAHSR C-4 Zaroli - Vadodara (as designed)",
        source="NHSRCL MAHSR package C-4 design data via CivilWorksApp/data: centre line = KML "
               "layer C-ROAD-CNTR-N (kml_map.json); rail-level grade table = pier_geom.json "
               "SEC-5 vgrad; structures = piers_master.json + civil_structures.json; stations = "
               "civil_stations.json; ground = surveyed GL at the S5 piers (pier_geom.json, KML "
               "EAST/NORTH). Extracted by studies/mahsr/extract_reference.py.",
        epsg=EPSG,
        closed=False,
        chainage_start_m=CH0,
        length_m=round(float(s[-1]), 3),
        pts=[[float(x), float(y)] for x, y in P],
        stations=stations,
        profile=dict(kind="rail", datum="project datum (assumed MSL)",
                     pvi=[[float(c), float(z)] for c, z in pvi], vc_radius_m=RV),
        structures=structures,
        ground=ground,
        notes=notes,
    )
    with open(os.path.join(a.out, "reference_c4.json"), "w", encoding="utf-8") as f:
        # allow_nan=False: a NaN would be written as a bare NaN token, which the
        # browser's JSON.parse rejects — fail here instead, where the cause is visible
        json.dump(ref, f, separators=(",", ":"), allow_nan=False)

    # ---- per-pier table (span-start piers; type/span describe the span ch -> ch_to)
    rows = []
    for pid, m in sorted(master.items(), key=lambda kv: kv[1]["ch_from"]):
        ch = float(m["ch_from"])
        g = P5.get(pid, {})
        if pid in kp:
            e, n, src = kp[pid]["E"], kp[pid]["N"], "kml_pier"
        elif CH[0] <= ch <= CH[-1]:
            e, n = at(ch)
            src = "centreline"
        else:
            e = n = np.nan
            src = "none (before CH 157.000)"
        lon, lat = dp.utm_inverse(e, n, ZONE)
        rail = g.get("rail")

        def r_(v, k):
            return "" if not np.isfinite(v) else round(float(v), k)
        rows.append(dict(
            pier=pid, sec=m["sec"], ch=ch, ch_to=m["ch_to"], span_m=m["span_m"], type=m["type"],
            girder=m["girder_id"], E=r_(e, 3), N=r_(n, 3), lat=r_(lat, 7), lon=r_(lon, 7),
            xy_src=src,
            rail=rail, rail_vgrad=(round(float(pvi_levels(pvi, RV, g.get("ch", ch))), 3)
                                   if m["sec"] == "S5" else None),
            gl=g.get("gl"), pier_cap=g.get("pcap"), pedestal=g.get("ped"),
            pier_ht=g.get("pier_ht"),
            rail_minus_gl=(round(rail - g["gl"], 3) if rail is not None and g.get("gl") is not None
                           else None),
            curv="/".join(c.strip(" .\n") for c in g.get("curv", []))))
    with open(os.path.join(a.out, "mahsr_piers.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)

    # ---- the centre line resampled, with structure, rail (grade table) and GL (S5 piers)
    st = np.arange(CH[0], CH[-1], a.step)
    e, n = at(st)
    lon, lat = dp.utm_inverse(e, n, ZONE)
    spans = sorted(master.values(), key=lambda m: m["ch_from"])
    sf = np.array([m["ch_from"] for m in spans], float)
    stt = np.array([m["ch_to"] for m in spans], float)
    j = np.clip(np.searchsorted(sf, st, side="right") - 1, 0, len(sf) - 1)
    typ = [spans[i]["type"] if sf[i] <= c < stt[i] + 1 else "" for i, c in zip(j, st)]
    for a0, b0, kind, label in structures:                # MT-08 has no spans
        if kind == "tunnel":
            typ = ["tunnel" if a0 <= c < b0 else t for t, c in zip(typ, st)]
    gl = np.where((st >= gch.min()) & (st <= gch.max()),
                  np.interp(st, gch, [r[1] for r in ground]), np.nan)
    rail = pvi_levels(pvi, RV, st)
    name = "mahsr_profile_%gm.csv" % a.step
    with open(os.path.join(a.out, name), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["ch", "E", "N", "lat", "lon", "structure", "rail_level", "ground_level_piers"])
        for r in zip(st, e, n, lat, lon, typ, rail, gl):
            w.writerow(["%.1f" % r[0], "%.3f" % r[1], "%.3f" % r[2], "%.7f" % r[3], "%.7f" % r[4],
                        r[5], "" if np.isnan(r[6]) else "%.3f" % r[6],
                        "" if np.isnan(r[7]) else "%.3f" % r[7]])

    # ---- summary and self-check
    rs, ls = stats(rail_res), stats(lin_res)
    print("MAHSR C-4 reference  ->  %s" % os.path.abspath(a.out))
    print("  centre line   %d pieces -> %d vertices, %.3f km, CH %.3f - %.3f"
          % (npieces, len(P), s[-1] / 1000, CH[0] / 1000, CH[-1] / 1000))
    print("                start lon %.6f lat %.6f   end lon %.6f lat %.6f"
          % (lon0, lat0, lon1, lat1))
    print("  stations      " + "; ".join("%s CH %.1f%s" % (t["name"], t["chainage_m"],
                                                          " (approx.)" if t["approximate"] else "")
                                         for t in stations))
    print("  profile       %d VIPs, CH %.0f - %.0f, R %.0f m" % (len(pvi), pvi[0][0], pvi[-1][0], RV))
    for w_ in grade_warn:
        print("    WARNING     " + w_)
    kinds = {}
    for a0, b0, kind, label in structures:
        kinds.setdefault(kind, [0, 0.0])
        kinds[kind][0] += 1
        kinds[kind][1] += b0 - a0
    print("  structures    %d runs: %s" % (len(structures), ", ".join(
        "%s %d (%.2f km)" % (k, v[0], v[1] / 1000) for k, v in kinds.items())))
    print("  ground        %d S5 piers, CH %.0f - %.0f (GL missing: %s)"
          % (len(ground), gch.min(), gch.max(), ", ".join(gl_missing)))
    print("  piers csv     %d rows; profile csv %d rows at %g m" % (len(rows), len(st), a.step))
    print("SELF-CHECK")
    print("  chainage      %d piers: (grid length + %.0f) - pier CH  median %+.3f  sd %.3f  "
          "max |%.3f| m;  fit CH = %.7f s + %.2f" % (len(res), CH0, np.median(res), res.std(),
                                                     np.abs(res).max(), fit[0], fit[1]))
    print("                lateral offset of pier E/N from the line  median %.3f  max %.3f m"
          % (np.median(np.abs(off)), np.abs(off).max()))
    print("  rail levels   VIP table + R %.0f m vs %d S5 pier rails:  rms %.1f mm, max %.1f mm"
          % (RV, rs["n"], 1000 * rs["rms"], 1000 * rs["maxabs"]))
    print("                bare grade table (no curves): rms %.0f mm, max %.0f mm"
          % (1000 * ls["rms"], 1000 * ls["maxabs"]))
    for pid, r in unfixed.items():
        print("                %s as given in the data would miss by %+.3f m (corrected)" % (pid, r))
    ok = rs["rms"] < 0.005 and rs["maxabs"] < 0.05 and np.abs(res).max() < 0.25
    print("  %s" % ("OK" if ok else "CHECK FAILED: the data or the method has changed"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
