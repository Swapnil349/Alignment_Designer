"""
Alignment Designer v12 — build the synthetic demonstration project.

Nobody should have to find a DEM before they can see whether the tool works, so
this generates one: an escarpment between a coastal plain and an inland plateau,
cut by two river valleys, with towns, a reserve and forest on it. It is the
classic corridor problem — the route has to find a pass, and every pass costs
something different.

    python make_demo.py

Writes ../projects/demo/. Deterministic: same terrain every run.
"""
from __future__ import annotations

import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dempack as dp

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECTS = os.path.abspath(os.path.join(HERE, "..", "projects"))

CELL = 50.0
NX, NY = 1200, 800                      # 60 km x 40 km
X0, Y1 = 300000.0, 2200000.0            # arbitrary UTM 43N origin
RNG = np.random.default_rng(20260809)


def smooth(a, sigma_cells):
    """Separable box-blur stack — three passes approximate a Gaussian well."""
    r = max(1, int(round(sigma_cells)))
    out = a.astype(np.float64)
    k = np.ones(2 * r + 1) / (2 * r + 1)
    axes = (0,) if out.ndim == 1 else (0, 1)
    for _ in range(3):
        for ax in axes:
            out = np.apply_along_axis(lambda m: np.convolve(m, k, mode="same"), ax, out)
    return out


def fractal(shape, octaves=6, persistence=0.5, base=64):
    """Value noise: white noise smoothed at halving scales and summed."""
    out = np.zeros(shape)
    amp, scale = 1.0, base
    for _ in range(octaves):
        n = RNG.standard_normal(shape)
        out += smooth(n, max(1, scale)) * amp * scale
        amp *= persistence
        scale = max(1, scale // 2)
    out -= out.mean()
    return out / (np.abs(out).max() + 1e-9)


def polyline_mask(pts, width_px, shape):
    """Stroke a polyline onto a boolean grid without needing PIL."""
    from PIL import Image, ImageDraw
    img = Image.new("L", (shape[1], shape[0]), 0)
    ImageDraw.Draw(img).line([tuple(p) for p in pts], fill=255, width=width_px)
    return np.asarray(img) > 0


def blob_mask(cx, cy, rx, ry, shape, rough=0.0):
    yy, xx = np.mgrid[0:shape[0], 0:shape[1]]
    th = np.arctan2(yy - cy, xx - cx)
    r = np.hypot((xx - cx) / rx, (yy - cy) / ry)
    if rough:
        r = r * (1 + rough * np.sin(3 * th) * 0.5 + rough * np.sin(7 * th) * 0.3)
    return r < 1.0


def build_terrain():
    yy, xx = np.mgrid[0:NY, 0:NX]
    u = xx / (NX - 1.0)                     # 0 west, 1 east
    v = yy / (NY - 1.0)                     # 0 north, 1 south

    # Regional form: coastal plain -> escarpment -> plateau at ~700 m. The scarp
    # line itself wanders on noise rather than a sine, so there is no periodic
    # structure for the search to exploit and no trivially straight crossing.
    wander = fractal((NY, NX), octaves=3, base=110)[:, :1] * 0.0
    line = smooth(RNG.standard_normal(NY), 40)
    line = line / (np.abs(line).max() + 1e-9)
    scarp = 0.44 + 0.085 * line[:, None] + wander
    ramp = 1 / (1 + np.exp(-(u - scarp) / 0.058))
    z = 25 + 660 * ramp

    # Two saddles cut into the scarp — the passes the corridor ought to find,
    # one broad and shallow, one tighter but better placed for a short route.
    for py, depth, halfwidth in ((0.27, 290.0, 0.052), (0.71, 235.0, 0.040)):
        z -= depth * np.exp(-((v - py) ** 2) / (2 * halfwidth ** 2)) * ramp

    # Relief: coarse on the plateau, gentler rolling ground on the plain.
    z += fractal((NY, NX), octaves=6, base=56) * 130 * (0.12 + 0.88 * ramp)
    z += fractal((NY, NX), octaves=5, base=30) * 55 * (0.85 - 0.55 * ramp)

    # Ridged noise gives spurs and re-entrants with no repeating period — this is
    # what makes the vertical alignment a real problem rather than a ramp.
    rid = 1.0 - np.abs(fractal((NY, NX), octaves=4, base=34))
    z += rid * 105 * ramp * np.exp(-((u - scarp) ** 2) / (2 * 0.14 ** 2))
    z += rid * 30 * (1 - ramp)

    return np.maximum(z, 2.0).astype(np.float32)


def carve_rivers(z):
    """Two rivers draining west off the plateau, each carving its valley."""
    rivers = []
    for y_start, wig in ((0.27, 1.0), (0.71, -1.0)):
        pts = []
        for k in range(81):
            t = k / 80.0
            x = (0.97 - 0.95 * t) * (NX - 1)
            y = (y_start + wig * 0.05 * np.sin(t * 5.0)
                 + 0.022 * np.sin(t * 13.0 + 1.1)) * (NY - 1)
            pts.append((x, y))
        rivers.append(pts)

    water = np.zeros((NY, NX), np.float32)
    for pts in rivers:
        chan = polyline_mask(pts, 3, (NY, NX))
        water = np.maximum(water, chan.astype(np.float32))
        # Incise a V-shaped valley: a narrow deep trench inside a broad one, so
        # the crossing is a genuine bridge-or-detour decision rather than a dip.
        near = smooth(chan.astype(np.float64), 7)
        near /= near.max() + 1e-9
        broad = smooth(chan.astype(np.float64), 26)
        broad /= broad.max() + 1e-9
        z -= (near * 70 + broad * 90).astype(np.float32)
    return np.maximum(z, 2.0).astype(np.float32), water


def main():
    print("[1] terrain")
    z = build_terrain()
    z, water = carve_rivers(z)
    z = smooth(z, 2).astype(np.float32)
    print("   %d x %d @ %g m  = %.0f x %.0f km   z %.0f .. %.0f m"
          % (NX, NY, CELL, NX * CELL / 1000, NY * CELL / 1000, z.min(), z.max()))

    slope = dp.slope_percent(z, CELL)
    print("   slope median %.1f%%  p95 %.1f%%  max %.0f%%"
          % (np.median(slope), np.percentile(slope, 95), slope.max()))

    print("[2] constraints")
    built = np.zeros((NY, NX), np.float32)
    towns = [("Port Halden", 90, 250, 46, 34), ("Riverford", 300, 615, 30, 24),
             ("Kavali", 760, 210, 34, 28), ("Upland", 1075, 560, 40, 32),
             ("Saddle Town", 545, 235, 20, 16)]
    for _n, cx, cy, rx, ry in towns:
        core = blob_mask(cx, cy, rx, ry, (NY, NX), rough=0.25)
        built = np.maximum(built, core.astype(np.float32))
        built = np.maximum(built, 0.45 * blob_mask(cx, cy, rx * 1.8, ry * 1.8,
                                                   (NY, NX), rough=0.3))
    print("   built-up %.2f%%" % (built.mean() * 100))

    protected = blob_mask(690, 430, 165, 150, (NY, NX), rough=0.35).astype(np.float32)
    protected = np.maximum(protected,
                           blob_mask(980, 130, 110, 80, (NY, NX), rough=0.3) * 1.0)
    print("   protected landscape %.2f%%" % (protected.mean() * 100))

    wood = (smooth(RNG.random((NY, NX)), 9) > 0.507).astype(np.float32)
    wood *= (slope > 8).astype(np.float32) * 0.9 + 0.1
    wood = np.clip(wood, 0, 1)
    print("   woodland %.2f%%" % (wood.mean() * 100))

    farmland = ((z < 260) & (slope < 6)).astype(np.float32)
    farmland *= (1 - built)
    print("   farmland %.2f%%" % (farmland.mean() * 100))

    road = polyline_mask([(90, 250), (300, 615), (545, 235), (760, 210), (1075, 560)],
                         2, (NY, NX)).astype(np.float32)
    rail = polyline_mask([(60, 120), (140, 380), (330, 690), (700, 760)],
                         2, (NY, NX)).astype(np.float32)

    fp = dp.flood_proxy(z, water, CELL)
    flood = fp[0] if isinstance(fp, tuple) else fp
    print("   floodplain %.2f%%" % (flood.mean() * 100))

    layers = {"dem": z, "slope": slope, "built": built, "protected": protected,
              "woodland": wood, "farmland": farmland, "water_body": water,
              "river_major": water, "flood": flood, "road_major": road, "rail": rail}

    print("[3] pack")
    grid = dp.Grid(X0, Y1, CELL, NX, NY, epsg=32643, zone=43, hemi="N")
    outdir = os.path.join(PROJECTS, "demo")
    os.makedirs(outdir, exist_ok=True)
    dp.hillshade_png(z, CELL, os.path.join(outdir, "terrain.png"))

    def cp(ident, name, ix, iy):
        return {"id": ident, "name": name,
                "E": round(X0 + (ix + 0.5) * CELL, 1),
                "N": round(Y1 - (iy + 0.5) * CELL, 1), "kind": "control"}

    # Sited on the plateau between the two river valleys, not on a valley floor:
    # a terminus 300 m below the ground it is approached across forces the whole
    # descent into tunnel and makes the demo about one bad control point rather
    # than about the corridor.
    controls = [cp("A", "Port Halden", 96, 250),
                cp("B", "Upland Junction", 1075, 470)]
    for c in controls:
        ix = int((c["E"] - X0) / CELL); iy = int((Y1 - c["N"]) / CELL)
        print("   %-16s ground %4.0f m" % (c["name"], z[iy, ix]))

    dp.pack_project(outdir, "demo", "Demo — coastal plain to plateau", grid, layers,
                    controls=controls,
                    notes="Synthetic escarpment corridor: 700 m of climb between a coastal "
                          "plain and an inland plateau, two river valleys, two saddles, a "
                          "reserve in the middle. Built by build/make_demo.py — no real "
                          "place is depicted.",
                    defaults={"mode": "rail_hs", "designSpeed": 250})
    dp.update_index(PROJECTS, {
        "id": "demo", "name": "Demo — coastal plain to plateau",
        "file": "demo/project.json", "thumb": "demo/terrain.png",
        "crs": "EPSG:32643", "extent_km": [NX * CELL / 1000, NY * CELL / 1000],
        "cell": CELL, "layers": sorted(layers.keys()),
        "notes": "Synthetic terrain — 700 m escarpment, two passes, two river valleys.",
    })
    print("\ndone.\n")


if __name__ == "__main__":
    main()
