"""
Alignment Designer v12 — import a DEM (and optional constraints) as a project.

    python import_dem.py --dem terrain.tif --id westghats --name "West Ghats crossing"

Accepted DEM formats
    .tif/.tiff  GeoTIFF (Copernicus DEM, SRTM, ALOS, NASADEM, LiDAR exports…)
    .asc        ESRI / GRASS ASCII grid
    .hgt        raw SRTM tile (N28E077.hgt)
    .npy        bare NumPy array, with --extent xmin ymin xmax ymax

Geographic DEMs (degrees) are projected to the UTM zone of their centre, so the
alignment engine always works in metres — radii, gradients and chainages are
meaningless otherwise.

Optional constraint layers, each a GeoJSON file (WGS84 or already in the
project CRS — the magnitudes are used to tell them apart):

    --built built.geojson          settlements to avoid
    --protected parks.geojson      national parks, reserves, heritage
    --woodland forest.geojson      forest / tree cover
    --water rivers.geojson         watercourses and water bodies
    --road roads.geojson           existing major roads (crossing cost)
    --rail rail.geojson            existing railways (crossing cost)
    --farmland farm.geojson        high-grade agricultural land
    --exclusion nogo.geojson       hard no-go zones — the search will not enter

Control points (start, vias, end) may be seeded from the command line:

    --control "Nashik:73.79,19.99" --control "Igatpuri:73.56,19.70"

They are read as lon,lat when both look like degrees, otherwise as easting,
northing in the project CRS. Points can also just be clicked in the app.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dempack as dp

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECTS = os.path.abspath(os.path.join(HERE, "..", "projects"))


def parse_control(spec, grid):
    if ":" in spec:
        name, coords = spec.split(":", 1)
    else:
        name, coords = "CP", spec
    a, b = [float(v.strip()) for v in coords.split(",")[:2]]
    if abs(a) <= 180 and abs(b) <= 90 and grid.zone is not None:
        x, y = dp.utm_forward(a, b, grid.zone, grid.hemi)
        E, N = float(x), float(y)
    else:
        E, N = a, b
    return {"id": name.strip()[:12].replace(" ", "_"), "name": name.strip(),
            "E": round(E, 1), "N": round(N, 1), "kind": "control"}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dem", required=True, help="DEM file")
    ap.add_argument("--id", required=True, help="short project id (folder name)")
    ap.add_argument("--name", help="display name")
    ap.add_argument("--cell", type=float, default=None,
                    help="design grid cell size in metres (default: keep DEM resolution, "
                         "clamped to 20..200 m)")
    ap.add_argument("--extent", nargs=4, type=float, metavar=("XMIN", "YMIN", "XMAX", "YMAX"),
                    help="world extent, required for a bare .npy DEM")
    ap.add_argument("--clip", nargs=4, type=float, metavar=("XMIN", "YMIN", "XMAX", "YMAX"),
                    help="clip the design grid to this extent (project CRS metres)")
    ap.add_argument("--zone", type=int, help="force a UTM zone")
    ap.add_argument("--notes", default="", help="free text shown in the project card")
    for key in ("built", "protected", "woodland", "water", "road", "rail",
                "farmland", "exclusion"):
        ap.add_argument("--" + key, help="GeoJSON for the %s layer" % key)
    ap.add_argument("--control", action="append", default=[],
                    help='seed control point, "Name:x,y" — repeatable')
    ap.add_argument("--mode", default="road",
                    help="default design mode for this project "
                         "(road | rail | rail_hs | maglev)")
    ap.add_argument("--speed", type=float, default=None, help="default design speed km/h")
    args = ap.parse_args()

    print("\n[1] DEM")
    dem_r = dp.read_dem(args.dem, extent=tuple(args.extent) if args.extent else None)
    dem_r.fill_voids()

    # Native resolution in metres — a geographic DEM's degree step is converted
    # at the tile's own latitude, which is the honest number to key the grid off.
    if dem_r.geographic:
        _, _, _, y1 = dem_r.bounds()
        lat = (dem_r.bounds()[1] + y1) / 2
        native = abs(dem_r.dx) * 111320.0 * np.cos(np.radians(lat))
    else:
        native = abs(dem_r.dx)
    cell = args.cell if args.cell else float(np.clip(round(native), 20, 200))
    print("   native ~%.0f m/px -> design grid %.0f m" % (native, cell))

    grid = dp.grid_for(dem_r, cell, zone=args.zone)
    if args.clip:
        x0, y0, x1, y1 = args.clip
        grid = dp.Grid(x0, y1, cell, max(2, int((x1 - x0) / cell)),
                       max(2, int((y1 - y0) / cell)),
                       epsg=grid.epsg, zone=grid.zone, hemi=grid.hemi)
    print("   " + repr(grid))

    print("\n[2] resampling terrain")
    dem = dp.resample(dem_r, grid)
    dem = np.nan_to_num(dem, nan=float(np.nanmedian(dem)))
    slope = dp.slope_percent(dem, grid.cell)
    print("   elevation %.0f .. %.0f m   slope median %.1f%%  p95 %.1f%%  max %.0f%%"
          % (dem.min(), dem.max(), np.median(slope),
             np.percentile(slope, 95), slope.max()))

    layers = {"dem": dem, "slope": slope}

    print("\n[3] constraint layers")
    vec = [("built", args.built, 1), ("protected", args.protected, 1),
           ("woodland", args.woodland, 1), ("water_body", args.water, 1),
           ("road_major", args.road, 1), ("rail", args.rail, 1),
           ("farmland", args.farmland, 1), ("exclusion", args.exclusion, 1)]
    any_vec = False
    for key, path, wpx in vec:
        if not path:
            continue
        layers[key] = dp.rasterise_geojson(path, grid, width_px=wpx)
        any_vec = True
    if not any_vec:
        print("   none supplied — the route will be driven by terrain alone.")
        print("   Add --built/--protected/--water/... GeoJSON to bring constraints in.")

    if "water_body" in layers:
        layers["river_major"] = layers["water_body"]
        fp = dp.flood_proxy(dem, layers["water_body"], grid.cell)
        if isinstance(fp, tuple):
            layers["flood"] = fp[0]
            print("   flood proxy (HAND < 4 m within 1.5 km of water): %.1f%% of area"
                  % (fp[0].mean() * 100))

    print("\n[4] preview + pack")
    outdir = os.path.join(PROJECTS, args.id)
    os.makedirs(outdir, exist_ok=True)
    dp.hillshade_png(dem, grid.cell, os.path.join(outdir, "terrain.png"))

    controls = [parse_control(c, grid) for c in args.control]
    for c in controls:
        ix = int((c["E"] - grid.xmin) / grid.cell)
        iy = int((grid.ymax - c["N"]) / grid.cell)
        if not (0 <= ix < grid.nx and 0 <= iy < grid.ny):
            print("   !! control %s falls outside the grid" % c["name"])
        else:
            print("   control %-16s E %.0f N %.0f  ground %.0f m"
                  % (c["name"], c["E"], c["N"], dem[iy, ix]))

    defaults = {"mode": args.mode}
    if args.speed:
        defaults["designSpeed"] = args.speed

    name = args.name or args.id
    dp.pack_project(outdir, args.id, name, grid, layers, controls=controls,
                    notes=args.notes or ("Imported from %s" % os.path.basename(args.dem)),
                    defaults=defaults)
    dp.update_index(PROJECTS, {
        "id": args.id, "name": name,
        "file": "%s/project.json" % args.id,
        "thumb": "%s/terrain.png" % args.id,
        "crs": ("EPSG:%d" % grid.epsg) if grid.epsg else "local metric",
        "extent_km": [round((grid.xmax - grid.xmin) / 1000, 1),
                      round((grid.ymax - grid.ymin) / 1000, 1)],
        "cell": grid.cell,
        "layers": sorted(layers.keys()),
        "notes": args.notes or "",
    })
    print("\ndone — reload the app and pick '%s' from the project list.\n" % name)


if __name__ == "__main__":
    main()
