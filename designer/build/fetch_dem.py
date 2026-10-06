"""
Alignment Designer — download Copernicus DEM tiles for a corridor.

The Copernicus DEM is the most accurate free global elevation model: a 2011–15
TanDEM-X survey, released by ESA under the Copernicus programme, and served
without any login from the AWS Registry of Open Data. It comes in 1 x 1 degree
tiles at two resolutions:

    --res 90   GLO-90, 3 arc-seconds (~90 m). About 5 MB a tile. Right for a
               corridor-scale study at 100–300 m design cells.
    --res 30   GLO-30, 1 arc-second (~30 m). About 40 MB a tile. Worth it for a
               detailed section at 30–75 m cells.

It is a SURFACE model: in towns and forest it reads the top of the buildings and
trees, not the ground. The importer averages each tile over the design cell, which
takes the edge off, but in dense urban areas the heights stay a few metres high.

Pick the tiles by a box, or by your stations plus a margin:

    python fetch_dem.py --bbox 76.9 25.0 83.4 28.9 --out studies/delhi_varanasi/raw/dem
    python fetch_dem.py --controls studies/delhi_varanasi/stations.csv --buffer-km 30 \\
                        --out studies/delhi_varanasi/raw/dem

    --dry-run   list the tiles and their sizes without downloading anything

Tiles already on disk at the right size are skipped, so an interrupted
download can simply be run again. Licence and attribution: the data is free to
use; credit it as "Copernicus DEM — © DLR e.V. 2010–2014 and © Airbus Defence
and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and
ESA; all rights reserved".
"""
from __future__ import annotations

import argparse
import math
import os
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dempack as dp

BUCKET = {90: "https://copernicus-dem-90m.s3.amazonaws.com",
          30: "https://copernicus-dem-30m.s3.amazonaws.com"}
CODE = {90: "30", 30: "10"}            # the product name carries arc-seconds × 10
UA = "AlignmentDesigner/1.0 (corridor study; github.com/Swapnil349/Alignment_Designer)"


def tile_name(lat, lon, res):
    ns = "N" if lat >= 0 else "S"
    ew = "E" if lon >= 0 else "W"
    return "Copernicus_DSM_COG_%s_%s%02d_00_%s%03d_00_DEM" % (CODE[res], ns, abs(lat), ew, abs(lon))


def tiles_for_box(lon0, lat0, lon1, lat1):
    """Every 1-degree tile the box touches, south-west corners as integers."""
    eps = 1e-9
    las = range(math.floor(lat0), math.floor(lat1 - eps) + 1)
    los = range(math.floor(lon0), math.floor(lon1 - eps) + 1)
    return [(la, lo) for la in las for lo in los]


def head(url):
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return int(r.headers.get("Content-Length", 0))
    except urllib.error.HTTPError as e:
        if e.code in (403, 404):
            return None                # no tile there: open sea, or not released
        raise


def download(url, dest, size):
    part = dest + ".part"
    for attempt in range(1, 5):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=120) as r, open(part, "wb") as f:
                got = 0
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
                    got += len(chunk)
            if size and got != size:
                raise IOError("got %d of %d bytes" % (got, size))
            os.replace(part, dest)
            return got
        except (urllib.error.URLError, IOError, TimeoutError) as e:
            print("      attempt %d failed: %s" % (attempt, e))
            time.sleep(4 * attempt)
    raise SystemExit("could not download %s — run the command again to resume" % url)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bbox", nargs=4, type=float,
                    metavar=("LONMIN", "LATMIN", "LONMAX", "LATMAX"))
    ap.add_argument("--controls", help="CSV of stations (name, lat, lon) to size the box from")
    ap.add_argument("--buffer-km", type=float, default=30.0,
                    help="margin around the stations, km (default 30)")
    ap.add_argument("--res", type=int, choices=(30, 90), default=90,
                    help="GLO-90 (default) or GLO-30")
    ap.add_argument("--out", required=True, help="folder to save the tiles in")
    ap.add_argument("--dry-run", action="store_true", help="list tiles and sizes only")
    args = ap.parse_args()

    if args.bbox:
        box = tuple(args.bbox)
    elif args.controls:
        pts = [p for p in dp.read_controls_csv(args.controls) if "lat" in p]
        if not pts:
            sys.exit("%s has no lat/lon columns" % args.controls)
        box = dp.lonlat_bbox(pts, args.buffer_km)
    else:
        sys.exit("give --bbox or --controls")
    tiles = tiles_for_box(*box)
    print("Copernicus GLO-%d for lon %.3f .. %.3f, lat %.3f .. %.3f — %d tiles"
          % (args.res, box[0], box[2], box[1], box[3], len(tiles)))

    os.makedirs(args.out, exist_ok=True)
    plan, total, todo = [], 0, 0
    for la, lo in tiles:
        name = tile_name(la, lo, args.res)
        url = "%s/%s/%s.tif" % (BUCKET[args.res], name, name)
        size = head(url)
        dest = os.path.join(args.out, name + ".tif")
        have = os.path.exists(dest) and size is not None and os.path.getsize(dest) == size
        plan.append((name, url, size, dest, have))
        if size:
            total += size
            if not have:
                todo += size
        print("   %s  %s" % (name, "no tile (sea / not released)" if size is None else
                             "%6.1f MB%s" % (size / 1e6, "  already here" if have else "")))
    print("total %.0f MB, of which %.0f MB still to download, into %s"
          % (total / 1e6, todo / 1e6, os.path.abspath(args.out)))
    if args.dry_run:
        return

    t0 = time.time()
    for name, url, size, dest, have in plan:
        if size is None or have:
            continue
        print("   downloading %s (%.1f MB)" % (name, size / 1e6))
        download(url, dest, size)
    print("done in %.0f s — next: import_dem.py --dem %s ..." % (time.time() - t0, args.out))


if __name__ == "__main__":
    main()
