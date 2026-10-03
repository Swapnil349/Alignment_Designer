"""
London 2100 — Rail Alignment Designer :: data pipeline

Builds every raster the alignment engine needs, on ONE common grid, and emits a
self-contained JavaScript data file the app can load from file:// without a server.

Outputs
    ../js/data_grid.js      packed grids (base64 zlib), grid metadata, node list
    ../js/data_base.js      downsampled basemap as a data URI
    ./dem_preview.png       visual QA of the interpolated DEM
    ./grid_qa.png           visual QA of every constraint layer

Grid
    EPSG:27700, origin = the QGIS "Model" layout extent, 100 m cells, 1500 x 1230.
    Established and validated earlier in this project:
      frame  E 452768.076 .. 602768.076,  N 123487.607 .. 246487.607
      source rasters are that frame rendered at 300 dpi => exactly 25.4 m/px
"""
import os, sys, math, json, zlib, base64, struct, sqlite3, time
import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import distance_transform_edt, uniform_filter, binary_dilation

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
Image.MAX_IMAGE_PIXELS = None

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
MAPS = os.path.join(ROOT, "Maps")
GPKG = os.path.join(ROOT, "QGIS", "OS_Open_Zoomstack.gpkg")
JSDIR = os.path.abspath(os.path.join(HERE, "..", "js")); os.makedirs(JSDIR, exist_ok=True)

# ── common grid ───────────────────────────────────────────────────────────────
XMIN, YMAX = 452768.07604494085535407, 246487.60653909383108839
XMAX, YMIN = 602768.07604494085535407, 123487.60653909383108839
CELL = 100.0
NX = int(round((XMAX - XMIN) / CELL))          # 1500
NY = int(round((YMAX - YMIN) / CELL))          # 1230
SRC_MPP = 25.4                                  # source raster metres/px
PXMM = 300 / 25.4
FRAME_X0, FRAME_Y0 = 50 * PXMM, 20 * PXMM       # map item origin in source px

print(f"grid {NX} x {NY} @ {CELL:g} m   ({NX*NY:,} cells)")

def cell_centres():
    e = XMIN + (np.arange(NX) + .5) * CELL
    n = YMAX - (np.arange(NY) + .5) * CELL
    return np.meshgrid(e, n)
GE, GN = cell_centres()

def bng2srcpx(E, N):
    return FRAME_X0 + (E - XMIN) / SRC_MPP, FRAME_Y0 + (YMAX - N) / SRC_MPP

# ── helpers: read the registered PNGs down onto the grid ──────────────────────
def raster_coverage(name):
    """Area-weighted coverage fraction (0..1) of a layer's ink, on the grid."""
    im = Image.open(os.path.join(MAPS, name))
    a = im.convert("RGBA").split()[3]
    x0, y0 = bng2srcpx(XMIN, YMAX); x1, y1 = bng2srcpx(XMAX, YMIN)
    a = a.crop((int(round(x0)), int(round(y0)), int(round(x1)), int(round(y1))))
    a = a.resize((NX, NY), Image.BOX)
    return (np.asarray(a, dtype=np.float32) / 255.0)

def raster_class(name, palette, tol=40):
    """Categorical sample at cell centres -> uint8 class ids (0 = none)."""
    im = np.asarray(Image.open(os.path.join(MAPS, name)).convert("RGBA"))
    fx, fy = bng2srcpx(GE, GN)
    ix = np.clip(fx.astype(np.int32), 0, im.shape[1] - 1)
    iy = np.clip(fy.astype(np.int32), 0, im.shape[0] - 1)
    px = im[iy, ix]
    rgb = px[..., :3].astype(np.int16); al = px[..., 3]
    out = np.zeros((NY, NX), np.uint8)
    for cid, col in palette.items():
        m = (np.abs(rgb - np.array(col, np.int16)).sum(-1) < tol) & (al > 40)
        out[m] = cid
    return out

# ── helpers: vector -> grid ───────────────────────────────────────────────────
def gp_wkb(b):
    f = b[3]; e = (f >> 1) & 7; n = {0:0,1:4,2:6,3:6,4:8}[e]
    return b[8 + n*8:]

def _rings(w, off, fmt):
    nr = struct.unpack(fmt+"I", w[off:off+4])[0]; off += 4
    out = []
    for _ in range(nr):
        npt = struct.unpack(fmt+"I", w[off:off+4])[0]; off += 4
        a = np.frombuffer(w[off:off+16*npt], dtype=("<f8" if fmt=="<" else ">f8")).reshape(npt, 2)
        off += 16*npt; out.append(a)
    return out, off

def geom_parts(w):
    """Return (kind, list_of_coordinate_arrays). kind in {'line','poly'}."""
    fmt = "<" if w[0] == 1 else ">"
    gt = struct.unpack(fmt+"I", w[1:5])[0] & 0xFF
    if gt == 2:
        n = struct.unpack(fmt+"I", w[5:9])[0]
        return "line", [np.frombuffer(w[9:9+16*n], dtype=("<f8" if fmt=="<" else ">f8")).reshape(n,2)]
    if gt == 5:
        nl = struct.unpack(fmt+"I", w[5:9])[0]; off = 9; out = []
        for _ in range(nl):
            f2 = "<" if w[off] == 1 else ">"
            n = struct.unpack(f2+"I", w[off+5:off+9])[0]
            out.append(np.frombuffer(w[off+9:off+9+16*n], dtype=("<f8" if f2=="<" else ">f8")).reshape(n,2))
            off += 9 + 16*n
        return "line", out
    if gt == 3:
        rr, _ = _rings(w, 5, fmt); return "poly", rr
    if gt == 6:
        npg = struct.unpack(fmt+"I", w[5:9])[0]; off = 9; out = []
        for _ in range(npg):
            f2 = "<" if w[off] == 1 else ">"
            rr, off2 = _rings(w, off+5, f2); out += rr; off = off2
        return "poly", out
    return "line", []

def to_px(a):
    return [( (E - XMIN)/CELL, (YMAX - N)/CELL ) for E, N in a]

def query(table, where_extra="", cols="geom"):
    con = sqlite3.connect(f"file:{GPKG}?mode=ro", uri=True)
    q = (f"SELECT {cols} FROM {table} t JOIN rtree_{table}_geom r ON t.rowid=r.id "
         f"WHERE r.maxx>? AND r.minx<? AND r.maxy>? AND r.miny<? {where_extra}")
    return con.execute(q, (XMIN, XMAX, YMIN, YMAX))

def rasterize_lines(table, width_px=1, where=""):
    img = Image.new("L", (NX, NY), 0); dr = ImageDraw.Draw(img); n = 0
    for (g,) in query(table, where):
        kind, parts = geom_parts(gp_wkb(g))
        for p in parts:
            if len(p) < 2: continue
            dr.line(to_px(p), fill=255, width=width_px); n += 1
    print(f"   {table}: {n}线" .replace("线", " features"))
    return (np.asarray(img) > 0)

def rasterize_polys(table, where=""):
    img = Image.new("L", (NX, NY), 0); dr = ImageDraw.Draw(img); n = 0
    for (g,) in query(table, where):
        kind, parts = geom_parts(gp_wkb(g))
        for p in parts:
            if len(p) < 3: continue
            dr.polygon(to_px(p), fill=255); n += 1
    print(f"   {table}: {n} polygons")
    return (np.asarray(img) > 0)

# ══════════════════════════════════════════════════════════════════════════════
# 1. DEM  — rasterise 10 m contours, then solve Laplace with contours held fixed
# ══════════════════════════════════════════════════════════════════════════════
def build_dem():
    print("\n[1] DEM from 10 m contours")
    cache = os.path.join(HERE, "_dem_cache.npy")
    if os.path.exists(cache):
        d = np.load(cache)
        if d.shape == (NY, NX):
            print(f"   loaded cache  range {d.min():.1f} .. {d.max():.1f} m "
                  f"(delete {os.path.basename(cache)} to rebuild)")
            return d
    t0 = time.time()
    img = Image.new("I", (NX, NY), 0); dr = ImageDraw.Draw(img)
    n = 0
    con = sqlite3.connect(f"file:{GPKG}?mode=ro", uri=True)
    q = ("SELECT t.height, t.geom FROM contours t JOIN rtree_contours_geom r ON t.rowid=r.id "
         "WHERE r.maxx>? AND r.minx<? AND r.maxy>? AND r.miny<?")
    for h, g in con.execute(q, (XMIN, XMAX, YMIN, YMAX)):
        if h is None: continue
        kind, parts = geom_parts(gp_wkb(g))
        v = int(round(float(h))) + 1000          # offset so 0 means "no data"
        for p in parts:
            if len(p) < 2: continue
            dr.line(to_px(p), fill=v, width=1); n += 1
    seed = np.asarray(img).astype(np.float32)
    known = seed > 0
    print(f"   rasterised {n} contour parts -> {known.sum():,} seeded cells "
          f"({known.mean()*100:.1f}% of grid)")
    if known.sum() == 0: raise RuntimeError("no contours rasterised")
    z = np.where(known, seed - 1000.0, np.nan)

    # initial guess: value of the nearest contour
    dist, idx = distance_transform_edt(~known, return_distances=True, return_indices=True)
    dem = z[tuple(idx)].astype(np.float64)
    dem[known] = z[known]
    print(f"   gap to nearest contour: mean {dist.mean()*CELL:.0f} m, max {dist.max()*CELL:.0f} m")

    # Laplace relaxation with the contours held as Dirichlet boundaries.
    #   Plain Jacobi (w = 1.0). Over-relaxation (w > 1) is only stable for
    #   Gauss-Seidel; applied to Jacobi it diverges -> inf -> NaN.
    print("   relaxing:", end="", flush=True)
    zk = z[known]
    for it in range(1, 801):
        lap = dem.copy()
        lap[1:-1,1:-1] = (dem[:-2,1:-1] + dem[2:,1:-1] + dem[1:-1,:-2] + dem[1:-1,2:]) * .25
        lap[0,:] = dem[1,:]; lap[-1,:] = dem[-2,:]; lap[:,0] = dem[:,1]; lap[:,-1] = dem[:,-2]
        lap[known] = zk
        delta = np.abs(lap - dem).max()
        dem = lap
        if it % 100 == 0: print(f" {it}:{delta:.3f}m", end="", flush=True)
        if delta < 0.01: print(f" converged at {it}", end=""); break
    print(f"\n   done in {time.time()-t0:.0f}s")
    assert np.isfinite(dem).all(), "DEM contains non-finite values"
    print(f"   DEM range {dem.min():.1f} .. {dem.max():.1f} m")
    dem = dem.astype(np.float32)
    np.save(cache, dem)
    return dem

# ══════════════════════════════════════════════════════════════════════════════
def main():
    L = {}

    dem = build_dem()
    L["dem"] = dem

    # slope in percent, from the DEM
    gy, gx = np.gradient(dem, CELL)
    slope = np.hypot(gx, gy) * 100.0
    L["slope"] = slope.astype(np.float32)
    print(f"   slope  median {np.median(slope):.2f}%  p95 {np.percentile(slope,95):.2f}%  max {slope.max():.1f}%")

    print("\n[2] constraint layers from registered rasters")
    L["aonb"]      = raster_coverage("02_AONB.png")
    L["greenbelt"] = raster_coverage("01_Green Belt.png")
    L["built"]     = raster_coverage("Built.png")
    L["woodland"]  = raster_coverage("woodland.png")
    L["london"]    = raster_coverage("London.png")
    for k in ("aonb","greenbelt","built","woodland","london"):
        print(f"   {k:10} mean coverage {L[k].mean()*100:5.1f}%")

    ALC = {1:(86,125,162), 2:(182,227,232), 3:(149,195,140), 4:(204,226,136),
           5:(255,225,127), 6:(255,153,58), 7:(115,109,105), 8:(216,153,153)}
    L["alc"] = raster_class("Agriculture.png", ALC)
    print("   alc class histogram:",
          {k: int((L['alc']==k).sum()) for k in range(9)})

    print("\n[3] vector layers rasterised from OS Open Zoomstack")
    #   NOTE: the PNG exports carried QGIS subset filters ("type"='Regional' on
    #   surfacewater, 'MHW' on waterlines) which is why Water2.png showed only the
    #   estuary. Here we take the full data, but keep water BODIES separate from
    #   water COURSES, and major rivers separate from ditches — conflating them
    #   made "water" 19% of the frame, which is meaningless for crossing cost.
    L["water_body"] = rasterize_polys("surfacewater").astype(np.float32)
    L["river_major"] = rasterize_lines(
        "waterlines", 1, "AND t.type IN ('National','Regional')").astype(np.float32)
    L["stream"] = rasterize_lines(
        "waterlines", 1, "AND t.type IN ('District','Local')").astype(np.float32)
    print(f"   water_body  {L['water_body'].mean()*100:5.2f}%   "
          f"river_major {L['river_major'].mean()*100:5.2f}%   "
          f"stream {L['stream'].mean()*100:5.2f}%")

    L["road_major"] = rasterize_lines("roads_national", 1).astype(np.float32)
    L["road_a"]     = rasterize_lines("roads_regional", 1, "AND t.type='A Road'").astype(np.float32)
    L["road_b"]     = rasterize_lines("roads_regional", 1, "AND t.type='B Road'").astype(np.float32)
    L["rail"]       = rasterize_lines("rail", 1).astype(np.float32)

    print("\n[4] distance transforms")
    L["drain"] = np.maximum(L["water_body"], L["river_major"])
    for src, key in (("built","d_built"), ("aonb","d_aonb"),
                     ("woodland","d_wood"), ("drain","d_water")):
        m = L[src] > 0.15
        L[key] = (distance_transform_edt(~m) * CELL).astype(np.float32)
        print(f"   {key:8} max {L[key].max()/1000:5.1f} km   mean {L[key].mean()/1000:5.2f} km")

    print("\n[5] flood proxy — HAND (height above nearest drainage)")
    #   Environment Agency Flood Zone 2/3 is NOT in this project yet. Until it is we
    #   approximate the floodplain from the DEM: low ground close to a MAJOR river.
    #   The drainage baseline must be the trunk network only — using every pond and
    #   field ditch puts drainage within ~500 m of everywhere, HAND collapses to ~0
    #   and the "floodplain" swallows two thirds of the map.
    wm = L["river_major"] > 0.15
    dmaj = (distance_transform_edt(~wm) * CELL).astype(np.float32)
    L["d_river_major"] = dmaj
    idx = distance_transform_edt(~wm, return_distances=False, return_indices=True)
    hand = dem - dem[tuple(idx)]
    flood = ((hand < 4.0) & (dmaj < 1200)).astype(np.float32)
    L["flood_proxy"] = flood
    L["hand"] = hand.astype(np.float32)
    print(f"   trunk river coverage {wm.mean()*100:.2f}%   mean distance to trunk {dmaj.mean()/1000:.2f} km")
    print(f"   HAND p5 {np.percentile(hand,5):.0f}  median {np.median(hand):.0f}  p95 {np.percentile(hand,95):.0f} m")
    print(f"   flood proxy coverage {flood.mean()*100:.2f}%   "
          f"(EA Flood Zone 3 is ~5% of England — sanity target)")
    print( "   *** PROXY ONLY — replace with EA Flood Map for Planning, see README data gaps ***")

    # ── QA imagery ────────────────────────────────────────────────────────────
    print("\n[6] QA images")
    d = dem.copy(); d = (d - d.min())/(d.max()-d.min())
    hs_y, hs_x = np.gradient(dem*3, CELL)
    hill = np.clip(.5 + (hs_x*.7 - hs_y*.7)/np.maximum(1e-6, np.abs(hs_x).max()), 0, 1)
    rgb = np.stack([np.clip(d*1.15,0,1), np.clip(d*.95+.05,0,1), np.clip(1-d*.6,0,1)], -1)
    rgb = np.clip(rgb * (0.55 + 0.9*hill[...,None]), 0, 1)
    Image.fromarray((rgb*255).astype(np.uint8)).save(os.path.join(HERE, "dem_preview.png"))

    keys = ["aonb","greenbelt","built","woodland","river_major","road_major","flood_proxy","slope"]
    tiles = []
    for k in keys:
        a = L[k].astype(np.float32)
        a = a/ max(1e-6, np.percentile(a, 99.5))
        tiles.append(np.clip(a,0,1))
    cols, rows = 4, 2
    sheet = np.zeros((rows*NY//3, cols*NX//3), np.float32)
    for i,t in enumerate(tiles):
        tt = np.asarray(Image.fromarray((t*255).astype(np.uint8)).resize((NX//3, NY//3), Image.BOX))/255.
        r, c = divmod(i, cols)
        sheet[r*(NY//3):(r+1)*(NY//3), c*(NX//3):(c+1)*(NX//3)] = tt
    Image.fromarray((255-(sheet*255)).astype(np.uint8)).save(os.path.join(HERE, "grid_qa.png"))
    print("   dem_preview.png, grid_qa.png")

    # ── pack to JS ────────────────────────────────────────────────────────────
    print("\n[7] packing js/data_grid.js")
    def pack_f32(a, scale=1.0, offset=0.0):
        q = np.clip((a.astype(np.float32) - offset) * scale, 0, 65535).astype("<u2")
        return base64.b64encode(zlib.compress(q.tobytes(), 9)).decode()
    def pack_u8(a):
        return base64.b64encode(zlib.compress(np.asarray(a, np.uint8).tobytes(), 9)).decode()

    payload = {
        "crs": "EPSG:27700",
        "cell": CELL, "nx": NX, "ny": NY,
        "xmin": XMIN, "ymax": YMAX, "xmax": XMAX, "ymin": YMIN,
        "srcMpp": SRC_MPP, "frameX0": FRAME_X0, "frameY0": FRAME_Y0,
        "built_from": "OS Open Zoomstack (contours/roads/rail/water) + QGIS Model layout PNG exports",
        "layers": {}, "meta": {},
    }
    # dem: store as uint16 in 0.1 m -> range 0..6553 m, plenty
    payload["layers"]["dem"] = pack_f32(dem, 10.0, -100.0)
    payload["meta"]["dem"] = {"type":"u16","scale":10.0,"offset":-100.0,"unit":"m"}
    payload["layers"]["slope"] = pack_f32(np.clip(slope,0,60), 1000.0, 0)
    payload["meta"]["slope"] = {"type":"u16","scale":1000.0,"offset":0,"unit":"percent"}
    for k in ("aonb","greenbelt","built","woodland","london","water_body","river_major",
              "stream","road_major","road_a","road_b","rail","flood_proxy"):
        payload["layers"][k] = pack_u8(np.clip(L[k],0,1)*255)
        payload["meta"][k] = {"type":"u8","scale":255.0,"offset":0,"unit":"coverage"}
    payload["layers"]["alc"] = pack_u8(L["alc"])
    payload["meta"]["alc"] = {"type":"u8","scale":1,"offset":0,"unit":"class",
        "classes":{"1":"Grade 1 Excellent","2":"Grade 2 Very good","3":"Grade 3a","4":"Grade 3b",
                   "5":"Grade 4 Poor","6":"Grade 5 Very poor","7":"Non-agricultural","8":"Urban"}}
    for k in ("d_built","d_aonb","d_wood","d_water"):
        payload["layers"][k] = pack_f32(np.clip(L[k],0,60000), 1.0, 0)
        payload["meta"][k] = {"type":"u16","scale":1.0,"offset":0,"unit":"m"}

    payload["nodes"] = [
        {"id":"N1","name":"Quainton / Waddesdon","note":"on the HS2 alignment","E":473887.0,"N":218604.0},
        {"id":"N2","name":"St Paul's Walden","note":"Luton node, candidate #3 from the siting study","E":520517.0,"N":220678.0},
    ]
    out = os.path.join(JSDIR, "data_grid.js")
    with open(out, "w", encoding="utf-8") as f:
        f.write("// GENERATED by build/build_grids.py — do not edit by hand\n")
        f.write("window.GRID = ")
        json.dump(payload, f, separators=(",", ":"))
        f.write(";\n")
    print(f"   wrote {out}  ({os.path.getsize(out)/1e6:.1f} MB)")

    # ── basemap as data URI ───────────────────────────────────────────────────
    print("\n[8] packing js/data_base.js")
    base = Image.open(os.path.join(MAPS, "Overlay2.png")).convert("RGB")
    x0, y0 = bng2srcpx(XMIN, YMAX); x1, y1 = bng2srcpx(XMAX, YMIN)
    base = base.crop((int(round(x0)), int(round(y0)), int(round(x1)), int(round(y1))))
    base = base.resize((2250, 1845), Image.LANCZOS)
    tmp = os.path.join(HERE, "_base.jpg"); base.save(tmp, "JPEG", quality=72, optimize=True)
    b64 = base64.b64encode(open(tmp,"rb").read()).decode(); os.remove(tmp)
    out2 = os.path.join(JSDIR, "data_base.js")
    with open(out2, "w", encoding="utf-8") as f:
        f.write("// GENERATED by build/build_grids.py\n")
        f.write(f'window.BASEMAP = "data:image/jpeg;base64,{b64}";\n')
    print(f"   wrote {out2}  ({os.path.getsize(out2)/1e6:.1f} MB)")

    # sanity: sample both nodes
    print("\n[9] node sanity check")
    for nd in payload["nodes"]:
        j = int((nd["E"]-XMIN)/CELL); i = int((YMAX-nd["N"])/CELL)
        print(f"   {nd['name']:22} cell({j},{i})  ground {dem[i,j]:5.0f} m  slope {slope[i,j]:4.1f}%  "
              f"built {L['built'][i,j]:.2f}  aonb {L['aonb'][i,j]:.2f}  "
              f"alc {L['alc'][i,j]}  d_built {L['d_built'][i,j]/1000:.1f} km")
    print("\ndone.")

if __name__ == "__main__":
    main()
