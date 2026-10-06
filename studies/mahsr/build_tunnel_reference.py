"""
MAHSR Mumbai – Thane: the existing design as a reference alignment, from
public sources only.

    python studies/mahsr/build_tunnel_reference.py

writes studies/mahsr/reference_mumbai_thane.json in the reference format
designer/build/import_dem.py --reference reads (see studies/mahsr/README.md).

Why this exists. CivilWorksApp (the NHSRCL package data the rest of this study
uses) starts at CH 156.6 km — it has nothing for Mumbai – Zaroli, so nothing
for the 21 km BKC – Shilphata tunnel or its 7 km under Thane Creek. The
detailed-design L-section is not public. What IS public:

  · the line itself, mapped in OpenStreetMap (way 916108435, tagged
    railway=construction + highspeed=yes + tunnel=yes, BKC → Shilphata,
    21.0 km — the published tunnel length — and way 1125530002 continuing on
    viaduct past Thane station). Its kinks fall at 6.8 km and 16.1 km along,
    where the Vikhroli and Sawli shafts are reported; the 9.3 km between them
    is drawn as one straight chord across the creek, so treat the plan as
    ± a few hundred metres;
  · a handful of levels and depths (each carried below with its source and a
    confidence): the BKC box depth, the shaft depths, and one rail level near
    the Shilphata portal from the 2018 JICA final alignment design.

So the profile here is PINNED at those few points and the designer's tunnel
policy fills between them — an estimate, labelled as one wherever it is shown
("existing design (estimated from published levels)"). It is good for one
thing: comparing generated options against the shape of the chosen design —
deep under the creek, very deep under Parsik hill, portal at Shilphata. It is
not a survey and must not be quoted as the design's levels.

Chainage. MAHSR chainage runs from BKC (the station box spans about
CH -0.257 to 0.773; the tunnel package C-2 runs CH 0.773 – 21.150). The OSM
tunnel way is anchored so that its east end — the tunnel-to-viaduct change —
falls at the published portal chainage, CH 21.150.

Data: © OpenStreetMap contributors (ODbL). Levels: sources in each pin.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.parse
import urllib.request

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "designer", "build"))
import dempack as dp  # noqa: E402

ZONE = 43                                   # UTM 43N, EPSG:32643 — as the C-4 reference
TUNNEL_WAY, VIADUCT_WAY = 916108435, 1125530002
PORTAL_CH = 21150.0                         # C-2 package end, Shilphata portal
CACHE = os.path.join(HERE, "raw", "osm_mahsr_mumbai_line.json")
OUT = os.path.join(HERE, "reference_mumbai_thane.json")
THANE = (19.19552, 73.06010)                # OSM 'Thane Station' node (see stations.csv)
UA = "AlignmentDesigner/1.0 (corridor study; github.com/Swapnil349/Alignment_Designer)"

JICA_FAD = "https://openjicareport.jica.go.jp/pdf/12302873_02.pdf"
SWARAJYA = ("https://swarajyamag.com/news-brief/mumbai-ahmedabad-bullet-train-project-"
            "indias-first-undersea-tunnel-takes-shape-in-maharashtra-all-about-it")
TRIBUNE = ("https://www.tribuneindia.com/news/india/ahmedabad-mumbai-bullet-train-project-"
           "indias-largest-tunnel-boring-machine-begins-excavation/")
METRORAIL = ("https://metrorailnews.in/mumbai-ahmedabad-bullet-train-second-tbm-begins-work-on-"
             "indias-first-undersea-rail-tunnel-beneath-thane-creek/")


def fetch_ways():
    """The two OSM ways, cached on disk so the study rebuilds offline."""
    if os.path.exists(CACHE):
        with open(CACHE, encoding="utf-8") as f:
            return json.load(f)
    q = "[out:json][timeout:90];way(id:%d,%d);out geom tags;" % (TUNNEL_WAY, VIADUCT_WAY)
    req = urllib.request.Request("https://overpass-api.de/api/interpreter",
                                 data=urllib.parse.urlencode({"data": q}).encode(),
                                 headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=180) as r:
        d = json.loads(r.read().decode("utf-8"))
    d["fetched"] = time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime())
    d["licence"] = "© OpenStreetMap contributors, ODbL"
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    with open(CACHE, "w", encoding="utf-8") as f:
        json.dump(d, f)
    return d


def way_xy(d, wid):
    w = next(e for e in d["elements"] if e["type"] == "way" and e["id"] == wid)
    lon = np.array([p["lon"] for p in w["geometry"]])
    lat = np.array([p["lat"] for p in w["geometry"]])
    E, N = dp.utm_forward(lon, lat, ZONE, "N")
    return np.c_[E, N], lat, lon


def main():
    d = fetch_ways()
    tun, tlat, tlon = way_xy(d, TUNNEL_WAY)
    via, _, _ = way_xy(d, VIADUCT_WAY)
    # BKC first: the tunnel way may be stored either way round
    if tlon[0] > tlon[-1]:
        tun = tun[::-1]
    if np.hypot(*(via[0] - tun[-1])) > np.hypot(*(via[-1] - tun[-1])):
        via = via[::-1]
    gap = float(np.hypot(*(via[0] - tun[-1])))
    assert gap < 50, "the viaduct way does not start at the tunnel's east end (%.0f m)" % gap

    # continue on the viaduct only as far as Thane station (+300 m). The way's
    # vertices are kilometres apart on straights, so project the station onto
    # the segments rather than taking the nearest vertex (that was 860 m off).
    te, tn = dp.utm_forward(np.array([THANE[1]]), np.array([THANE[0]]), ZONE, "N")
    sv = np.r_[0, np.cumsum(np.hypot(*np.diff(via, axis=0).T))]

    def project(P, S, E, N):
        best = (np.inf, 0.0)
        for i in range(len(P) - 1):
            a, b = P[i], P[i + 1]
            v = b - a
            L2 = float(v @ v) or 1.0
            t = min(1.0, max(0.0, float(((np.array([E, N]) - a) @ v) / L2)))
            q = a + t * v
            dd = float(np.hypot(q[0] - E, q[1] - N))
            if dd < best[0]:
                best = (dd, S[i] + t * (S[i + 1] - S[i]))
        return best

    off, s_th = project(via, sv, te[0], tn[0])
    s_end = min(sv[-1], s_th + 300.0)
    keep = sv < s_end
    end = np.array([np.interp(s_end, sv, via[:, 0]), np.interp(s_end, sv, via[:, 1])])
    pts = np.vstack([tun, via[1:][keep[1:]], end])
    s = np.r_[0, np.cumsum(np.hypot(*np.diff(pts, axis=0).T))]
    L_tun = float(np.sum(np.hypot(*np.diff(tun, axis=0).T)))
    ch0 = PORTAL_CH - L_tun                 # anchor: OSM tunnel end = portal chainage

    def ch_of(E, N):
        dd, sj = project(pts, s, E, N)
        return float(ch0 + sj), dd

    # the shafts sit at the tunnel way's two interior kinks (see the docstring)
    st = np.r_[0, np.cumsum(np.hypot(*np.diff(tun, axis=0).T))]
    seg = np.diff(st)
    long_i = int(np.argmax(seg))            # the straight creek chord
    vik, sawli = st[long_i], st[long_i + 1]

    bkc_ch = 258.0                          # middle of the C-1 box, CH -0.257 .. 0.773
    thane_ch, thane_off = ch_of(te[0], tn[0])
    pins = [
        {"ch": bkc_ch, "level": None, "depth": 26.0, "name": "BKC station (rail)",
         "source": JICA_FAD + " (FAD 2018: ~26 m ground to rail); platform ~24 m, base slab ~32 m (press)",
         "confidence": "medium"},
        {"ch": float(ch0 + vik), "level": None, "depth": 53.0, "name": "Vikhroli shaft",
         "source": TRIBUNE + " — shaft ~56 m deep; rail taken ~3 m above the shaft base (assumption)",
         "confidence": "low"},
        {"ch": float(ch0 + sawli), "level": None, "depth": 36.0, "name": "Sawli shaft (Ghansoli)",
         "source": METRORAIL + " — shaft ~39 m deep; rail taken ~3 m above the shaft base (assumption)",
         "confidence": "low"},
        {"ch": 21112.0, "level": 30.146, "depth": None, "name": "near Shilphata portal",
         "source": JICA_FAD + " (FAD 2018, pre-detailed design: RL 30.146 m at Km 21/112)",
         "confidence": "medium"},
    ]
    ref = {
        "name": "MAHSR BKC - Thane (existing design, from public sources)",
        "source": "Line: OpenStreetMap ways %d + %d (ODbL), anchored at the portal CH 21.150. "
                  "Levels: published depths and one JICA rail level - see profile.pins." % (TUNNEL_WAY, VIADUCT_WAY),
        "epsg": 32600 + ZONE, "closed": False,
        "chainage_start_m": round(ch0, 1),
        "length_m": round(float(s[-1]), 1),
        "pts": [[round(float(e), 2), round(float(n), 2)] for e, n in pts],
        "stations": [
            {"id": "BKC", "name": "Mumbai (BKC)", "kind": "terminal", "approximate": True,
             "E": round(float(np.interp(bkc_ch - ch0, s, pts[:, 0])), 1),
             "N": round(float(np.interp(bkc_ch - ch0, s, pts[:, 1])), 1),
             "chainage_m": bkc_ch},
            {"id": "Thane", "name": "Thane", "kind": "station", "approximate": True,
             "E": round(float(te[0]), 1), "N": round(float(tn[0]), 1), "chainage_m": round(thane_ch, 1)},
        ],
        "profile": {"kind": "rail", "datum": "mixed public sources - indicative only", "pins": pins},
        "structures": [
            [round(ch0, 1), 773.0, "tunnel", "BKC underground station box (C-1)"],
            [773.0, PORTAL_CH, "tunnel", "C-2: TBM to Sawli, NATM Sawli - Shilphata"],
            [PORTAL_CH, round(float(ch0 + s[-1]), 1), "viaduct", "C-3 viaduct towards Thane"],
        ],
        "notes": [
            "Plan from OpenStreetMap: the creek crossing is mapped as one straight 9.3 km chord between the "
            "reported Vikhroli and Sawli shaft positions - accurate to a few hundred metres at best.",
            "Levels are pinned at four published points (BKC box, two shafts, one JICA 2018 rail level near "
            "the portal); everything between them is the designer's tunnel policy - an estimate.",
            "Shaft depth is not rail level: the rail is assumed ~3 m above the shaft base (low confidence).",
            "Thane Creek bed depth is not in any DEM (water is flat in Copernicus); the tunnel policy's "
            "'creek bed below water' parameter is an assumption to vary (published: 2-6 m below chart datum "
            "in the middle/upper creek; tunnel 20-25 m below the bed).",
            "The detailed-design L-section is not public; the user's own NHSRCL data supersedes all of this.",
        ],
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(ref, f, indent=1)
    print("wrote %s" % OUT)
    print("  %d vertices, %.2f km, CH %.3f .. %.3f" % (len(pts), s[-1] / 1000, ch0 / 1000, (ch0 + s[-1]) / 1000))
    print("  tunnel way %.3f km; shafts at CH %.2f (Vikhroli) and %.2f (Sawli); Thane at CH %.2f (%.0f m off line)"
          % (L_tun / 1000, (ch0 + vik) / 1000, (ch0 + sawli) / 1000, thane_ch / 1000, thane_off))


if __name__ == "__main__":
    main()
