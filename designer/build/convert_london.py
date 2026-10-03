"""
Alignment Designer — carry the London 2100 dataset over as a project.

The London 2100 study (london2100/) baked one 150 x 123 km EPSG:27700 grid into
js/data_grid.js. That grid is real data — OS Open Zoomstack contours, roads,
rail and water, plus the registered AONB / Green Belt / built-up / woodland
rasters — so it is worth keeping as a worked example next to the synthetic demo,
and it lets the generic engine be checked against results the study published.

Source is the latest delivery build, london2100/v12 (Sep 2026). Its grid is
byte-identical to v11; what v12 adds, and what this carries across:

  * the SETTLED alignment — the 412.156 km orbital, 16 582 unique vertices,
    implicitly closed (data/loop.npy, data/alignment.json). It becomes the
    project's reference alignment, which the designer can load and evaluate
    under any standard instead of re-routing it.
  * the seventeen stations as they sit ON that line (data/alignment.json), as
    well as the nominal sites the router starts from.
  * the agreed default view — constraint layers on white, topography off — and
    the fixed -40 .. 230 m AOD terrain colour limits, so the designer reads the
    same height as the same colour as every published sheet.

    python convert_london.py

Writes ../projects/london2100/.
"""
from __future__ import annotations

import base64
import json
import os
import sys
import zlib

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dempack as dp

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
PROJECTS = os.path.abspath(os.path.join(HERE, "..", "projects"))
LONDON = os.path.join(ROOT, "london2100")
SOURCES = [os.path.join(LONDON, "v12"), os.path.join(LONDON, "v11")]

# Study layer name -> designer name. The engine reads a fixed vocabulary of
# constraint classes; anything not mapped here is dropped rather than silently
# mis-costed.
RENAME = {
    "dem": "dem", "slope": "slope",
    "built": "built", "aonb": "protected", "woodland": "woodland",
    "water_body": "water_body", "river_major": "river_major",
    "flood_proxy": "flood", "road_major": "road_major", "rail": "rail",
    "london": "exclusion", "greenbelt": "greenbelt",
}

# london2100/v12 render.js, MapView.showLayers — the four layers that carry
# routing weight, on white. Translated to the designer's layer names.
DEFAULT_LAYERS = {"protected": True, "built": True, "flood": True,
                  "river_major": True, "water_body": False, "greenbelt": False,
                  "woodland": False, "road_major": False, "rail": False,
                  "farmland": False, "exclusion": False}


def unpack(payload, key):
    m = payload["meta"][key]
    raw = zlib.decompress(base64.b64decode(payload["layers"][key]))
    if m["type"] == "u16":
        a = np.frombuffer(raw, "<u2").astype(np.float32) / m["scale"] + m["offset"]
    else:
        a = np.frombuffer(raw, np.uint8).astype(np.float32) / m["scale"]
    return a.reshape(payload["ny"], payload["nx"])


def find_source():
    for d in SOURCES:
        if os.path.exists(os.path.join(d, "js", "data_grid.js")):
            return d
    sys.exit("London grid not found under %s" % LONDON)


def reference_alignment(src):
    """The settled loop from the delivery build, or None if this source has none."""
    data = os.path.join(src, "data")
    npy, meta = os.path.join(data, "loop.npy"), os.path.join(data, "alignment.json")
    if not (os.path.exists(npy) and os.path.exists(meta)):
        return None
    pts = np.load(npy)
    with open(meta, encoding="utf-8") as f:
        info = json.load(f)
    # loop.npy holds UNIQUE vertices and the ring is implicitly closed — the
    # note in alignment.json is explicit that no duplicate closing point exists.
    seg = np.hypot(*np.diff(np.vstack([pts, pts[:1]]), axis=0).T)
    print("   reference loop: %d vertices, %.3f km closed (alignment.json says %.3f)"
          % (len(pts), seg.sum() / 1000, info["length_km"]))
    stations = [{"id": n["name"], "name": n["name"], "kind": n["kind"],
                 "E": round(n["easting"], 2), "N": round(n["northing"], 2),
                 "chainage_m": n["chainage_m"],
                 "moved_from_nominal_m": n["moved_from_nominal_m"]}
                for n in info["nodes"]]
    return {
        "name": "Settled orbital — London 2100 v12",
        "source": "london2100/v12/data/loop.npy",
        "closed": bool(info.get("closed_ring", True)),
        "length_m": info["length_m"],
        "epsg": info.get("epsg", 27700),
        "pts": [[round(float(e), 2), round(float(n), 2)] for e, n in pts],
        "stations": stations,
        "notes": "412 km, seventeen stations, worked in both directions. The line "
                 "the study settled on — geometry and journey times unchanged "
                 "since v11; v12 was a presentation build.",
    }


def main():
    src = find_source()
    grid_js = os.path.join(src, "js", "data_grid.js")
    print("[1] reading %s (%.1f MB)" % (grid_js, os.path.getsize(grid_js) / 1e6))
    with open(grid_js, encoding="utf-8") as f:
        txt = f.read()
    start = txt.index("window.GRID =") + len("window.GRID =")
    end = txt.rindex("}") + 1
    P = json.loads(txt[start:end])
    print("   %d x %d @ %g m, %d layers, %d nodes"
          % (P["nx"], P["ny"], P["cell"], len(P["layers"]), len(P.get("nodes", []))))

    layers = {}
    for s, dst in RENAME.items():
        if s not in P["layers"]:
            continue
        layers[dst] = unpack(P, s)
        print("   %-12s -> %-12s mean %.3f" % (s, dst, layers[dst].mean()))

    # The ALC raster is a class map; grades 1, 2 and 3a are the "best and most
    # versatile" land that planning policy protects, so collapse it to that.
    if "alc" in P["layers"]:
        raw = zlib.decompress(base64.b64decode(P["layers"]["alc"]))
        alc = np.frombuffer(raw, np.uint8).reshape(P["ny"], P["nx"])
        layers["farmland"] = np.isin(alc, (1, 2, 3)).astype(np.float32)
        print("   alc          -> farmland     mean %.3f" % layers["farmland"].mean())

    grid = dp.Grid(P["xmin"], P["ymax"], P["cell"], P["nx"], P["ny"], epsg=27700)
    print("   " + repr(grid))

    controls = [{"id": n["id"], "name": n["name"], "E": n["E"], "N": n["N"],
                 "kind": n.get("kind", "control")} for n in P.get("nodes", [])]

    print("[2] reference alignment")
    ref = reference_alignment(src)
    if ref is None:
        print("   none in %s — project will carry the grid only" % src)

    outdir = os.path.join(PROJECTS, "london2100")
    os.makedirs(outdir, exist_ok=True)
    print("[3] preview + pack")
    dp.hillshade_png(layers["dem"], grid.cell, os.path.join(outdir, "terrain.png"))
    dp.pack_project(
        outdir, "london2100", "London 2100 — orbital corridor", grid, layers,
        controls=controls,
        notes="OS Open Zoomstack contours relaxed to a 100 m DEM, plus AONB, Green "
              "Belt, built-up, woodland, water, road and rail. The 17 control points "
              "are the study's nominal station sites; Greater London is a no-go zone. "
              "Carries the settled 412 km orbital from the v12 delivery build as a "
              "reference alignment.",
        defaults={"mode": "maglev", "designSpeed": 550, "closed": True,
                  "topo": False, "layers": DEFAULT_LAYERS,
                  "terrainRange": [-40, 230]},
        reference=ref)
    dp.update_index(PROJECTS, {
        "id": "london2100", "name": "London 2100 — orbital corridor",
        "file": "london2100/project.json", "thumb": "london2100/terrain.png",
        "crs": "EPSG:27700",
        "extent_km": [round((grid.xmax - grid.xmin) / 1000, 1),
                      round((grid.ymax - grid.ymin) / 1000, 1)],
        "cell": grid.cell, "layers": sorted(layers.keys()),
        "reference": bool(ref),
        "notes": "Real UK open data and the settled orbital, from london2100/v12.",
    })
    print("\ndone.\n")


if __name__ == "__main__":
    main()
