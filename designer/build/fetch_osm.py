"""
Alignment Designer — fetch constraint layers from OpenStreetMap for a corridor.

Writes one GeoJSON per constraint class into --out, named the way the importer
expects, so the next step is just  import_dem.py ... --osm <that folder>.

    built.geojson      residential / commercial / industrial land, plus every
                       city, town, village and hamlet point drawn as a disc
                       (villages are mostly mapped as points in rural India)
    water.geojson      lakes, ponds, river areas, plus river and canal lines
    road.geojson       motorways / expressways, trunk (NH) and primary (SH) roads
    rail.geojson       running lines (sidings, yards and spurs left out)
    woodland.geojson   forest and wood
    protected.geojson  national parks, sanctuaries, nature reserves, protected areas
                       (protect_class / protection_title kept: they tell a
                       wildlife sanctuary from an eco-sensitive zone)
    mangrove.geojson   mangrove forest (natural=wetland + wetland=mangrove, and
                       the older natural=mangrove)
    wetland.geojson    every other wetland — marsh, saltmarsh, tidal flat,
                       reed bed, swamp — with its wetland=* type kept
    coastline.geojson  the OSM coastline (mean high water), as lines; the
                       importer turns it into a coastal-regulation-zone proxy

    Default is every class; --only picks a subset (--only mangrove,coastline).

    python fetch_osm.py --controls studies/delhi_varanasi/stations.csv --buffer-km 30 \\
                        --out studies/delhi_varanasi/raw/osm

Data comes from the public Overpass API, queried in blocks (2 x 2 degrees by
default) so no single query is too large; a block that times out is split in
four and retried. Be patient — a corridor of this size takes a few minutes —
and please do not run it in a loop: Overpass is a shared, volunteer-run
service. Re-running skips classes whose file is already there (use --force).

Coverage is only as good as OpenStreetMap's. Towns and main roads are well
mapped across India; village extents, forest and canals are uneven. Treat the
layers as a corridor-screening basis and replace any of them with an
authoritative source (WDPA for protected areas, a land-use map for settlement,
Global Mangrove Watch for mangroves, the state CZMA's CRZ map for the coast)
when you have one — the importer takes any GeoJSON. Mangrove mapping in OSM is
good around Mumbai and patchy elsewhere on the Gujarat coast.

Licence: © OpenStreetMap contributors, Open Database Licence (ODbL).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dempack as dp

ENDPOINTS = ["https://overpass-api.de/api/interpreter",
             "https://overpass.kumi.systems/api/interpreter"]
UA = "AlignmentDesigner/1.0 (corridor study; github.com/Swapnil349/Alignment_Designer)"

LANDUSE_BUILT = "^(residential|commercial|industrial|retail)$"
CATEGORIES = {
    "built": [
        'way["landuse"~"%s"]' % LANDUSE_BUILT,
        'relation["landuse"~"%s"]' % LANDUSE_BUILT,
        'node["place"~"^(city|town|suburb|village|hamlet)$"]',
    ],
    "water": [
        'way["natural"="water"]', 'relation["natural"="water"]',
        'way["waterway"="riverbank"]', 'relation["waterway"="riverbank"]',
        'way["waterway"~"^(river|canal)$"]',
    ],
    "road": ['way["highway"~"^(motorway|trunk|primary)$"]'],
    "rail": ['way["railway"="rail"][!"service"]'],
    "woodland": [
        'way["landuse"="forest"]', 'relation["landuse"="forest"]',
        'way["natural"="wood"]', 'relation["natural"="wood"]',
    ],
    "protected": [
        'way["boundary"~"^(protected_area|national_park)$"]',
        'relation["boundary"~"^(protected_area|national_park)$"]',
        'way["leisure"="nature_reserve"]', 'relation["leisure"="nature_reserve"]',
    ],
    # Mangroves are their own class, not just "wetland": under the CRZ
    # Notification they are CRZ-IA (the most restrictive category, with a 50 m
    # buffer), clearing them needs separate forest and coastal clearances, and
    # MAHSR's own alignment had to be argued through them at Thane Creek and
    # the Gujarat estuaries. natural=mangrove is the pre-2011 tagging and is
    # still on a lot of the Indian coast, so both are asked for.
    "mangrove": [
        'way["natural"="wetland"]["wetland"="mangrove"]',
        'relation["natural"="wetland"]["wetland"="mangrove"]',
        'way["natural"="mangrove"]', 'relation["natural"="mangrove"]',
    ],
    # [wetland!=mangrove] in Overpass also matches a natural=wetland with no
    # wetland=* tag at all, which is what we want: an untyped wetland is still
    # a wetland, and the mangrove class already has the mangroves.
    "wetland": [
        'way["natural"="wetland"]["wetland"!="mangrove"]',
        'relation["natural"="wetland"]["wetland"!="mangrove"]',
    ],
    # OSM maps natural=coastline at mean high water, as open ways that join end
    # to end (land on the left). Only ways: there are no coastline relations.
    "coastline": ['way["natural"="coastline"]'],
}
# Written as LineStrings, never closed into polygons. A closed coastline way is
# an island's shore, and it is the shore — not the island — that the CRZ
# distance band is measured from.
LINEAR = {"road", "rail", "coastline"}
# A settlement mapped only as a point still occupies ground. Radii are typical
# built-up extents for each place class in the Indo-Gangetic plain; where a town
# also has land-use polygons the two simply overlap.
PLACE_RADIUS_M = {"city": 2500, "town": 1000, "suburb": 600, "village": 250, "hamlet": 100}


# ───────────────────────────────────────────────────────────── Overpass ──
def overpass(query, timeout_s):
    """POST a query; return the parsed JSON, or raise RuntimeError to split."""
    body = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for ep in ENDPOINTS:
        for attempt in range(1, 4):
            req = urllib.request.Request(ep, data=body, headers={"User-Agent": UA})
            try:
                with urllib.request.urlopen(req, timeout=timeout_s + 90) as r:
                    data = json.loads(r.read().decode("utf-8"))
                remark = data.get("remark", "") or ""
                if "runtime error" in remark or "timed out" in remark or "memory" in remark:
                    raise RuntimeError(remark.strip())
                return data
            except urllib.error.HTTPError as e:
                last = "HTTP %d from %s" % (e.code, ep)
                if e.code == 429:                      # rate limited: wait our turn
                    wait = int(e.headers.get("Retry-After", 0) or 30 * attempt)
                    print("      busy (429) — waiting %d s" % wait)
                    time.sleep(wait)
                    continue
                if e.code in (502, 503, 504):
                    time.sleep(10 * attempt)
                    continue
                if e.code == 400:
                    raise RuntimeError("query rejected (400)")
                break
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                last = "%s from %s" % (e, ep)
                time.sleep(10 * attempt)
            except json.JSONDecodeError:
                last = "unreadable reply from %s" % ep
                break
    raise RuntimeError(last or "no Overpass server answered")


def build_query(clauses, s, w, n, e, timeout_s):
    bb = "(%.5f,%.5f,%.5f,%.5f)" % (s, w, n, e)
    body = "".join("  %s%s;\n" % (c, bb) for c in clauses)
    return "[out:json][timeout:%d][maxsize:1073741824];\n(\n%s);\nout geom qt;\n" % (timeout_s, body)


def blocks_for(box, size):
    lon0, lat0, lon1, lat1 = box
    out = []
    la = lat0
    while la < lat1 - 1e-9:
        lo = lon0
        la2 = min(lat1, la + size)
        while lo < lon1 - 1e-9:
            lo2 = min(lon1, lo + size)
            out.append((la, lo, la2, lo2))
            lo = lo2
        la = la2
    return out


def fetch_block(cat, blk, timeout_s, depth=0):
    """Elements for one block; splits into quarters if Overpass gives up."""
    s, w, n, e = blk
    try:
        return overpass(build_query(CATEGORIES[cat], s, w, n, e, timeout_s), timeout_s)["elements"]
    except RuntimeError as err:
        if depth >= 3 or (n - s) < 0.2:
            raise SystemExit("Overpass could not return %s for %.2f,%.2f..%.2f,%.2f (%s). "
                             "Try again later, or use QGIS QuickOSM for this layer."
                             % (cat, s, w, n, e, err))
        print("      %s — splitting %.2f x %.2f deg block in four" % (err, n - s, e - w))
        ms, mw = (s + n) / 2, (w + e) / 2
        out = []
        for q in ((s, w, ms, mw), (s, mw, ms, e), (ms, w, n, mw), (ms, mw, n, e)):
            out += fetch_block(cat, q, timeout_s, depth + 1)
            time.sleep(2)
        return out


# ─────────────────────────────────────────────────────── to GeoJSON ──
def _pts(geom):
    return [(round(p["lon"], 5), round(p["lat"], 5)) for p in geom if p]


def assemble_rings(segments):
    """Join the outer ways of a multipolygon into closed rings, end to end."""
    segs = [list(s) for s in segments if len(s) >= 2]
    rings = []
    while segs:
        cur = segs.pop(0)
        grown = True
        while cur[0] != cur[-1] and grown:
            grown = False
            for i, s in enumerate(segs):
                if s[0] == cur[-1]:
                    cur += s[1:]
                elif s[-1] == cur[-1]:
                    cur += s[-2::-1]
                elif s[-1] == cur[0]:
                    cur = s[:-1] + cur
                elif s[0] == cur[0]:
                    cur = s[:0:-1] + cur
                else:
                    continue
                segs.pop(i)
                grown = True
                break
        if len(cur) >= 4 and cur[0] == cur[-1]:
            rings.append(cur)
    return rings


def disc(lon, lat, r_m, n=16):
    dlat = r_m / 110574.0
    dlon = r_m / (111320.0 * math.cos(math.radians(lat)))
    ring = [(round(lon + dlon * math.cos(2 * math.pi * k / n), 5),
             round(lat + dlat * math.sin(2 * math.pi * k / n), 5)) for k in range(n)]
    return ring + [ring[0]]


def to_features(cat, elements):
    feats, seen = [], set()
    for el in elements:
        key = (el["type"], el["id"])
        if key in seen:
            continue
        seen.add(key)
        tags = el.get("tags", {})
        oid = el["type"][0] + str(el["id"])
        kind = (tags.get("place") or tags.get("landuse") or tags.get("natural")
                or tags.get("waterway") or tags.get("highway") or tags.get("railway")
                or tags.get("boundary") or tags.get("leisure") or "")
        if cat == "mangrove":
            kind = "mangrove"                  # whichever of the two taggings it used
        props = {"osm": oid, "kind": kind}
        # Which water is RIVER matters downstream: the floodplain proxy must be
        # measured from rivers, not from every village pond and canal.
        if tags.get("water"):
            props["water"] = tags["water"]
        # The wetland type is the difference between a saltmarsh or tidal flat
        # (coastal, CRZ-relevant, soft ground under a viaduct's piers) and an
        # inland reed bed. Kept so a later cost model, or a person, can tell.
        if tags.get("wetland"):
            props["wetland"] = tags["wetland"]
        # protect_class (IUCN-based: 1a/1b strict reserve, 2 national park, 4
        # habitat / species area — where most Indian wildlife sanctuaries sit)
        # and the local title ("Wildlife Sanctuary", "Eco-Sensitive Zone") are
        # what separate a sanctuary the line must not touch from an ESZ it may
        # cross with conditions. Both are kept verbatim; nothing here
        # interprets them, and neither is mapped consistently.
        for k in ("protect_class", "protection_title"):
            if tags.get(k):
                props[k] = tags[k][:60]
        if tags.get("name"):
            props["name"] = tags["name"][:60]
        if el["type"] == "node":
            r = PLACE_RADIUS_M.get(tags.get("place"))
            if r and "lon" in el:
                feats.append({"type": "Feature", "properties": props,
                              "geometry": {"type": "Polygon",
                                           "coordinates": [disc(el["lon"], el["lat"], r)]}})
        elif el["type"] == "way":
            c = _pts(el.get("geometry", []))
            if len(c) < 2:
                continue
            closed = len(c) >= 4 and c[0] == c[-1]
            linear = cat in LINEAR or (cat == "water" and tags.get("waterway") in ("river", "canal"))
            if linear or not closed:
                if linear or cat == "water":
                    feats.append({"type": "Feature", "properties": props,
                                  "geometry": {"type": "LineString", "coordinates": c}})
                continue                       # an open land-use edge is part of a relation
            feats.append({"type": "Feature", "properties": props,
                          "geometry": {"type": "Polygon", "coordinates": [c]}})
        elif el["type"] == "relation":
            outers = [_pts(m.get("geometry", [])) for m in el.get("members", [])
                      if m.get("type") == "way" and m.get("role", "outer") in ("outer", "")]
            for ring in assemble_rings(outers):
                feats.append({"type": "Feature", "properties": props,
                              "geometry": {"type": "Polygon", "coordinates": [ring]}})
    return feats


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bbox", nargs=4, type=float,
                    metavar=("LONMIN", "LATMIN", "LONMAX", "LATMAX"))
    ap.add_argument("--controls", help="CSV of stations (name, lat, lon) to size the box from")
    ap.add_argument("--buffer-km", type=float, default=30.0)
    ap.add_argument("--out", required=True, help="folder for the GeoJSON files")
    ap.add_argument("--only", help="comma-separated subset of: " + ",".join(CATEGORIES))
    ap.add_argument("--block", type=float, default=2.0, help="query block size, degrees")
    ap.add_argument("--timeout", type=int, default=600, help="Overpass timeout per query, s")
    ap.add_argument("--force", action="store_true", help="re-fetch classes already on disk")
    args = ap.parse_args()

    if args.bbox:
        box = tuple(args.bbox)
    elif args.controls:
        pts = [p for p in dp.read_controls_csv(args.controls) if "lat" in p]
        box = dp.lonlat_bbox(pts, args.buffer_km)
    else:
        sys.exit("give --bbox or --controls")
    cats = [c.strip() for c in args.only.split(",")] if args.only else list(CATEGORIES)
    bad = [c for c in cats if c not in CATEGORIES]
    if bad:
        sys.exit("unknown class %s — choose from %s" % (bad, ",".join(CATEGORIES)))
    blocks = blocks_for(box, args.block)
    os.makedirs(args.out, exist_ok=True)
    print("OpenStreetMap for lon %.3f .. %.3f, lat %.3f .. %.3f — %d block%s per class"
          % (box[0], box[2], box[1], box[3], len(blocks), "" if len(blocks) == 1 else "s"))

    manifest = {"bbox": box, "fetched": time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime()),
                "source": "OpenStreetMap via Overpass API",
                "licence": "© OpenStreetMap contributors, ODbL", "classes": {}}
    mpath = os.path.join(args.out, "manifest.json")
    if os.path.exists(mpath):
        try:
            with open(mpath, encoding="utf-8") as f:
                manifest["classes"] = json.load(f).get("classes", {})
        except (ValueError, OSError):
            pass
    for cat in cats:
        path = os.path.join(args.out, cat + ".geojson")
        if os.path.exists(path) and not args.force:
            print("   %-9s already here — skipped (use --force to re-fetch)" % cat)
            continue
        t0 = time.time()
        elements = []
        for i, blk in enumerate(blocks):
            print("   %-9s block %d/%d ..." % (cat, i + 1, len(blocks)), end="", flush=True)
            got = fetch_block(cat, blk, args.timeout)
            elements += got
            print(" %d elements" % len(got))
            time.sleep(1.5)
        feats = to_features(cat, elements)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"type": "FeatureCollection", "features": feats}, f, separators=(",", ":"))
        mb = os.path.getsize(path) / 1e6
        manifest["classes"][cat] = {"features": len(feats), "MB": round(mb, 1)}
        print("   %-9s %d features, %.1f MB, %.0f s" % (cat, len(feats), mb, time.time() - t0))
        with open(mpath, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=1)
    print("done — next: import_dem.py ... --osm %s" % args.out)


if __name__ == "__main__":
    main()
