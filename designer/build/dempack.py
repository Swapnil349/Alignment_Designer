"""
Alignment Designer v12 — terrain and constraint ingestion library.

Everything here is pure Python + numpy (+ Pillow for TIFF/PNG decode, + scipy
for the distance transforms). No GDAL, no rasterio, no pyproj: the tool has to
run on a plain Python install, which is the whole point of the v11 pipeline and
is kept here.

What it provides
    read_dem(path)              GeoTIFF / ESRI ASCII / SRTM HGT / .npy  -> Raster
    Raster.to_grid(...)         resample onto a metric design grid
    utm_forward / utm_inverse   WGS84 <-> UTM, Snyder series, vectorised
    rasterise_geojson(...)      GeoJSON polygons/lines -> coverage grid
    pack_project(...)           write the base64+deflate project.json the app reads

Grid convention (identical to v11 so the engine code carries straight over)
    x increases east, y increases north, cells are square, and the array is
    stored row-major from the NORTH-WEST corner:  A[iy*nx + ix]
        E = xmin + (ix + 0.5)*cell
        N = ymax - (iy + 0.5)*cell
"""
from __future__ import annotations

import base64
import json
import math
import os
import struct
import zlib

import numpy as np

try:
    from PIL import Image, ImageDraw
    Image.MAX_IMAGE_PIXELS = None
except ImportError:                                       # pragma: no cover
    Image = ImageDraw = None

try:
    from scipy.ndimage import distance_transform_edt, uniform_filter
except ImportError:                                       # pragma: no cover
    distance_transform_edt = uniform_filter = None


# ─────────────────────────────────────────────────────────── WGS84 <-> UTM ──
# Snyder, "Map Projections — A Working Manual", USGS PP 1395, §8.
# Accurate to well under a metre inside a zone, which is far finer than any
# DEM cell we resample onto, and it keeps the tool dependency-free.
_A = 6378137.0
_F = 1.0 / 298.257223563
_E2 = _F * (2 - _F)
_EP2 = _E2 / (1 - _E2)
_K0 = 0.9996


def utm_zone(lon: float, lat: float):
    """Zone number and hemisphere for a longitude/latitude in degrees."""
    z = int(math.floor((lon + 180.0) / 6.0)) % 60 + 1
    return z, ("N" if lat >= 0 else "S")


def utm_epsg(zone: int, hemi: str) -> int:
    return (32600 if hemi.upper() == "N" else 32700) + zone


def _meridian_arc(phi):
    return _A * ((1 - _E2 / 4 - 3 * _E2 ** 2 / 64 - 5 * _E2 ** 3 / 256) * phi
                 - (3 * _E2 / 8 + 3 * _E2 ** 2 / 32 + 45 * _E2 ** 3 / 1024) * np.sin(2 * phi)
                 + (15 * _E2 ** 2 / 256 + 45 * _E2 ** 3 / 1024) * np.sin(4 * phi)
                 - (35 * _E2 ** 3 / 3072) * np.sin(6 * phi))


def utm_forward(lon, lat, zone, hemi="N"):
    """(lon, lat) degrees -> (easting, northing) metres. Arrays welcome."""
    lon = np.asarray(lon, dtype=np.float64)
    lat = np.asarray(lat, dtype=np.float64)
    lon0 = math.radians((zone - 1) * 6 - 180 + 3)
    phi, lam = np.radians(lat), np.radians(lon)
    sp, cp, tp = np.sin(phi), np.cos(phi), np.tan(phi)
    N = _A / np.sqrt(1 - _E2 * sp * sp)
    T = tp * tp
    C = _EP2 * cp * cp
    dl = lam - lon0
    dl = np.arctan2(np.sin(dl), np.cos(dl))               # wrap to +-pi
    Aa = dl * cp
    M = _meridian_arc(phi)
    x = _K0 * N * (Aa + (1 - T + C) * Aa ** 3 / 6
                   + (5 - 18 * T + T * T + 72 * C - 58 * _EP2) * Aa ** 5 / 120) + 500000.0
    y = _K0 * (M + N * tp * (Aa * Aa / 2 + (5 - T + 9 * C + 4 * C * C) * Aa ** 4 / 24
                             + (61 - 58 * T + T * T + 600 * C - 330 * _EP2) * Aa ** 6 / 720))
    if hemi.upper() == "S":
        y = y + 10000000.0
    return x, y


def utm_inverse(x, y, zone, hemi="N"):
    """(easting, northing) metres -> (lon, lat) degrees. Arrays welcome."""
    x = np.asarray(x, dtype=np.float64) - 500000.0
    y = np.asarray(y, dtype=np.float64)
    if hemi.upper() == "S":
        y = y - 10000000.0
    lon0 = math.radians((zone - 1) * 6 - 180 + 3)
    M = y / _K0
    mu = M / (_A * (1 - _E2 / 4 - 3 * _E2 ** 2 / 64 - 5 * _E2 ** 3 / 256))
    e1 = (1 - math.sqrt(1 - _E2)) / (1 + math.sqrt(1 - _E2))
    phi1 = (mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * np.sin(2 * mu)
            + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * np.sin(4 * mu)
            + (151 * e1 ** 3 / 96) * np.sin(6 * mu)
            + (1097 * e1 ** 4 / 512) * np.sin(8 * mu))
    s1, c1, t1 = np.sin(phi1), np.cos(phi1), np.tan(phi1)
    C1 = _EP2 * c1 * c1
    T1 = t1 * t1
    R1 = _A * (1 - _E2) / (1 - _E2 * s1 * s1) ** 1.5
    N1 = _A / np.sqrt(1 - _E2 * s1 * s1)
    D = x / (N1 * _K0)
    phi = phi1 - (N1 * t1 / R1) * (D * D / 2
                                   - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * _EP2) * D ** 4 / 24
                                   + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1
                                      - 252 * _EP2 - 3 * C1 * C1) * D ** 6 / 720)
    lam = lon0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6
                  + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * _EP2 + 24 * T1 * T1) * D ** 5 / 120) / c1
    return np.degrees(lam), np.degrees(phi)


# ───────────────────────────────────────────────────────────────── rasters ──
class Raster:
    """A north-up raster: z[row, col], with the world position of its corner.

    `geographic` is True when x/y are degrees, in which case the resampler
    projects the target grid back to lon/lat to sample it.
    """

    def __init__(self, z, x0, y0, dx, dy, geographic=False, epsg=None, nodata=None):
        self.z = np.asarray(z, dtype=np.float32)
        self.x0, self.y0 = float(x0), float(y0)     # centre of pixel (0, 0)
        self.dx, self.dy = float(dx), float(dy)     # +east, +north step per pixel
        self.geographic = bool(geographic)
        self.epsg = epsg
        if nodata is not None:
            self.z = np.where(np.isclose(self.z, nodata), np.nan, self.z)
        # DEMs routinely carry -9999 / -32768 voids even without a nodata tag
        self.z = np.where(self.z < -1e4, np.nan, self.z)

    @property
    def shape(self):
        return self.z.shape

    def bounds(self):
        ny, nx = self.z.shape
        xs = [self.x0, self.x0 + self.dx * (nx - 1)]
        ys = [self.y0, self.y0 + self.dy * (ny - 1)]
        return min(xs), min(ys), max(xs), max(ys)

    def fill_voids(self):
        """Nearest-neighbour fill of NaN cells so the search never samples a hole."""
        m = ~np.isfinite(self.z)
        if not m.any():
            return self
        if distance_transform_edt is None:
            self.z = np.nan_to_num(self.z, nan=float(np.nanmedian(self.z)))
            return self
        idx = distance_transform_edt(m, return_distances=False, return_indices=True)
        self.z = self.z[tuple(idx)]
        print("   filled %d void cells (%.2f%%)" % (m.sum(), m.mean() * 100))
        return self

    def sample(self, X, Y):
        """Bilinear sample at world coordinates X, Y (same CRS as the raster)."""
        fx = (np.asarray(X, np.float64) - self.x0) / self.dx
        fy = (np.asarray(Y, np.float64) - self.y0) / self.dy
        ny, nx = self.z.shape
        x0 = np.floor(fx).astype(np.int64)
        y0 = np.floor(fy).astype(np.int64)
        tx, ty = fx - x0, fy - y0
        def g(ix, iy):
            return self.z[np.clip(iy, 0, ny - 1), np.clip(ix, 0, nx - 1)]
        return ((g(x0, y0) * (1 - tx) + g(x0 + 1, y0) * tx) * (1 - ty)
                + (g(x0, y0 + 1) * (1 - tx) + g(x0 + 1, y0 + 1) * tx) * ty)


def _read_geotiff(path):
    if Image is None:
        raise RuntimeError("Pillow is required to read TIFF DEMs (pip install pillow)")
    im = Image.open(path)
    z = np.asarray(im).astype(np.float32)
    if z.ndim == 3:                                   # RGB elevation product
        z = z[..., 0]
    tags = getattr(im, "tag_v2", {})
    scale = tags.get(33550)          # ModelPixelScale (sx, sy, sz)
    tie = tags.get(33922)            # ModelTiepoint (i, j, k, x, y, z)
    xform = tags.get(33920)          # ModelTransformation (4x4)
    nodata = tags.get(42113)
    try:
        nodata = float(nodata) if nodata is not None else None
    except (TypeError, ValueError):
        nodata = None

    if scale and tie:
        sx, sy = float(scale[0]), float(scale[1])
        i, j, _k, X, Y = (float(tie[0]), float(tie[1]), float(tie[2]),
                          float(tie[3]), float(tie[4]))
        x0 = X + (0.5 - i) * sx
        y0 = Y - (0.5 - j) * sy
        dx, dy = sx, -sy
    elif xform:
        t = [float(v) for v in xform]
        dx, dy = t[0], t[5]
        x0 = t[3] + 0.5 * dx
        y0 = t[7] + 0.5 * dy
    else:
        raise RuntimeError(
            "%s carries no GeoTIFF georeferencing tags. Supply --extent "
            "xmin ymin xmax ymax, or export the DEM with georeferencing."
            % os.path.basename(path))

    # GeoKeyDirectory: 1024 GTModelType (1 projected, 2 geographic),
    # 3072 ProjectedCSTypeGeoKey, 2048 GeographicTypeGeoKey
    epsg, model = None, None
    gk = tags.get(34735)
    if gk:
        gk = [int(v) for v in gk]
        for p in range(4, len(gk) - 3, 4):
            key, loc, _cnt, val = gk[p], gk[p + 1], gk[p + 2], gk[p + 3]
            if loc:
                continue
            if key == 1024:
                model = val
            elif key in (3072, 2048) and epsg is None:
                epsg = val
    geographic = (model == 2) if model else (abs(dx) < 0.01)
    return Raster(z, x0, y0, dx, dy, geographic=geographic, epsg=epsg, nodata=nodata)


def _read_asc(path):
    """ESRI / GRASS ASCII grid."""
    hdr, vals = {}, []
    with open(path, "r", errors="replace") as f:
        for line in f:
            parts = line.split()
            if not parts:
                continue
            k = parts[0].lower()
            if k in ("ncols", "nrows", "xllcorner", "yllcorner", "xllcenter",
                     "yllcenter", "cellsize", "nodata_value", "dx", "dy"):
                hdr[k] = float(parts[1])
            else:
                vals.append(line)
                break
        body = "".join(vals) + f.read()
    nx, ny = int(hdr["ncols"]), int(hdr["nrows"])
    cs = hdr.get("cellsize", hdr.get("dx", 1.0))
    z = np.fromstring(body, sep=" ", dtype=np.float32) if hasattr(np, "fromstring") else None
    if z is None or z.size < nx * ny:
        z = np.array(body.split(), dtype=np.float32)
    z = z[: nx * ny].reshape(ny, nx)
    if "xllcenter" in hdr:
        x0, y0c = hdr["xllcenter"], hdr["yllcenter"]
    else:
        x0, y0c = hdr["xllcorner"] + cs / 2, hdr["yllcorner"] + cs / 2
    y0 = y0c + cs * (ny - 1)                          # row 0 is the NORTH row
    geographic = cs < 0.01
    return Raster(z, x0, y0, cs, -cs, geographic=geographic,
                  nodata=hdr.get("nodata_value"))


def _read_hgt(path):
    """SRTM / NASADEM .hgt — raw big-endian int16, square, 1x1 degree."""
    raw = np.fromfile(path, dtype=">i2")
    n = int(round(math.sqrt(raw.size)))
    if n * n != raw.size:
        raise RuntimeError("%s is not a square HGT tile" % path)
    z = raw.reshape(n, n).astype(np.float32)
    z[z <= -32000] = np.nan
    name = os.path.basename(path).upper()
    lat = int(name[1:3]) * (1 if name[0] == "N" else -1)
    lon = int(name[4:7]) * (1 if name[3] == "E" else -1)
    step = 1.0 / (n - 1)
    return Raster(z, lon, lat + 1.0, step, -step, geographic=True, epsg=4326)


def read_dem(path, extent=None):
    """Dispatch on extension. `extent` = (xmin, ymin, xmax, ymax) for bare arrays."""
    ext = os.path.splitext(path)[1].lower()
    if ext in (".tif", ".tiff", ".gtiff"):
        r = _read_geotiff(path)
    elif ext in (".asc", ".txt", ".grd"):
        r = _read_asc(path)
    elif ext == ".hgt":
        r = _read_hgt(path)
    elif ext == ".npy":
        z = np.load(path).astype(np.float32)
        if extent is None:
            raise RuntimeError("--extent is required for a bare .npy DEM")
        x0, y0, x1, y1 = extent
        ny, nx = z.shape
        dx, dy = (x1 - x0) / (nx - 1), -(y1 - y0) / (ny - 1)
        r = Raster(z, x0, y1, dx, dy, geographic=abs(dx) < 0.01)
    else:
        raise RuntimeError("unsupported DEM format: %s" % ext)
    if extent is not None and ext != ".npy":
        pass
    print("   %s  %d x %d  %s  z %.0f..%.0f"
          % (os.path.basename(path), r.shape[1], r.shape[0],
             "degrees" if r.geographic else "metres",
             np.nanmin(r.z), np.nanmax(r.z)))
    return r


# ───────────────────────────────────────────────────────── the design grid ──
class Grid:
    """The metric grid every layer is resampled onto."""

    def __init__(self, xmin, ymax, cell, nx, ny, epsg=None, zone=None, hemi="N"):
        self.xmin, self.ymax, self.cell = float(xmin), float(ymax), float(cell)
        self.nx, self.ny = int(nx), int(ny)
        self.xmax = self.xmin + self.nx * self.cell
        self.ymin = self.ymax - self.ny * self.cell
        self.epsg, self.zone, self.hemi = epsg, zone, hemi

    def centres(self):
        e = self.xmin + (np.arange(self.nx) + 0.5) * self.cell
        n = self.ymax - (np.arange(self.ny) + 0.5) * self.cell
        return np.meshgrid(e, n)

    def to_source(self, E, N, geographic):
        """Grid coordinates -> the CRS a source raster is stored in."""
        if not geographic:
            return E, N
        return utm_inverse(E, N, self.zone, self.hemi)

    def world_to_px(self, X, Y):
        return (np.asarray(X) - self.xmin) / self.cell, (self.ymax - np.asarray(Y)) / self.cell

    def __repr__(self):
        return ("Grid %d x %d @ %g m  E %.0f..%.0f  N %.0f..%.0f  (%.0f x %.0f km)"
                % (self.nx, self.ny, self.cell, self.xmin, self.xmax, self.ymin,
                   self.ymax, (self.xmax - self.xmin) / 1000, (self.ymax - self.ymin) / 1000))


def grid_for(dem: Raster, cell, margin=0.0, zone=None, max_cells=4_500_000):
    """Build a metric design grid covering `dem`, in UTM if the DEM is geographic."""
    x0, y0, x1, y1 = dem.bounds()
    if dem.geographic:
        lon_c, lat_c = (x0 + x1) / 2, (y0 + y1) / 2
        if zone is None:
            zone, hemi = utm_zone(lon_c, lat_c)
        else:
            hemi = "N" if lat_c >= 0 else "S"
        cx = np.array([x0, x1, x0, x1, lon_c, lon_c])
        cy = np.array([y0, y0, y1, y1, y0, y1])
        ex, ny_ = utm_forward(cx, cy, zone, hemi)
        X0, X1 = float(ex.min()), float(ex.max())
        Y0, Y1 = float(ny_.min()), float(ny_.max())
        epsg = utm_epsg(zone, hemi)
    else:
        X0, X1, Y0, Y1 = x0, x1, y0, y1
        epsg, hemi = dem.epsg, "N"
    X0 -= margin; Y0 -= margin; X1 += margin; Y1 += margin
    nx = max(2, int(round((X1 - X0) / cell)))
    ny = max(2, int(round((Y1 - Y0) / cell)))
    if nx * ny > max_cells:
        raise SystemExit(
            "grid would be %d x %d = %.1fM cells. Raise --cell (currently %g m) — "
            "a design grid finer than ~25 m buys nothing for corridor selection."
            % (nx, ny, nx * ny / 1e6, cell))
    return Grid(X0, Y1, cell, nx, ny, epsg=epsg, zone=zone, hemi=hemi)


def resample(raster: Raster, grid: Grid):
    """Bilinear-resample a raster onto the design grid."""
    GE, GN = grid.centres()
    SX, SY = grid.to_source(GE, GN, raster.geographic)
    return raster.sample(SX, SY).astype(np.float32)


def slope_percent(dem_grid, cell):
    gy, gx = np.gradient(dem_grid.astype(np.float64), cell)
    return (np.hypot(gx, gy) * 100.0).astype(np.float32)


# ──────────────────────────────────────────────────────── vector ingestion ──
def _geojson_geoms(obj):
    """Yield (kind, ring/line coordinate list) for every geometry in a GeoJSON."""
    def walk(g):
        if g is None:
            return
        t = g.get("type")
        if t == "FeatureCollection":
            for f in g.get("features", []):
                walk(f)
        elif t == "Feature":
            walk(g.get("geometry"))
        elif t == "GeometryCollection":
            for g2 in g.get("geometries", []):
                walk(g2)
        elif t == "Polygon":
            for ring in g["coordinates"]:
                yield_list.append(("poly", ring))
        elif t == "MultiPolygon":
            for poly in g["coordinates"]:
                for ring in poly:
                    yield_list.append(("poly", ring))
        elif t in ("LineString",):
            yield_list.append(("line", g["coordinates"]))
        elif t == "MultiLineString":
            for ln in g["coordinates"]:
                yield_list.append(("line", ln))
        elif t == "Point":
            yield_list.append(("point", [g["coordinates"]]))
        elif t == "MultiPoint":
            for p in g["coordinates"]:
                yield_list.append(("point", [p]))
    yield_list = []
    walk(obj)
    return yield_list


def rasterise_geojson(path, grid: Grid, width_px=1, supersample=3):
    """GeoJSON -> coverage grid in 0..1.

    Polygons are filled, lines are stroked `width_px` grid cells wide, points
    are dotted. Rendered at `supersample`x and box-averaged down, so a road
    that clips the corner of a cell contributes a partial cost, not a full one.
    """
    if Image is None:
        raise RuntimeError("Pillow is required to rasterise vectors")
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        gj = json.load(f)
    geoms = _geojson_geoms(gj)
    if not geoms:
        print("   %s: no geometries" % os.path.basename(path))
        return np.zeros((grid.ny, grid.nx), np.float32)

    # Decide the source CRS from the coordinate magnitudes: RFC 7946 GeoJSON is
    # WGS84 degrees, but projected GeoJSON in the project CRS is common in
    # engineering exports and must not be silently mangled.
    sx = float(geoms[0][1][0][0])
    sy = float(geoms[0][1][0][1])
    geographic = abs(sx) <= 180.0 and abs(sy) <= 90.0 and grid.zone is not None

    S = supersample
    img = Image.new("L", (grid.nx * S, grid.ny * S), 0)
    dr = ImageDraw.Draw(img)
    npoly = nline = 0
    for kind, coords in geoms:
        a = np.asarray(coords, dtype=np.float64)[:, :2]
        if geographic:
            X, Y = utm_forward(a[:, 0], a[:, 1], grid.zone, grid.hemi)
        else:
            X, Y = a[:, 0], a[:, 1]
        px, py = grid.world_to_px(X, Y)
        pts = list(zip((px * S).tolist(), (py * S).tolist()))
        if kind == "poly" and len(pts) >= 3:
            dr.polygon(pts, fill=255)
            npoly += 1
        elif kind == "line" and len(pts) >= 2:
            dr.line(pts, fill=255, width=max(1, int(round(width_px * S))))
            nline += 1
        elif kind == "point":
            x, y = pts[0]
            r = max(1, int(round(width_px * S / 2)))
            dr.ellipse([x - r, y - r, x + r, y + r], fill=255)
    small = img.resize((grid.nx, grid.ny), Image.BOX)
    cov = np.asarray(small, dtype=np.float32) / 255.0
    print("   %-28s %4d polygons, %4d lines -> %.2f%% coverage"
          % (os.path.basename(path), npoly, nline, cov.mean() * 100))
    return cov


def flood_proxy(dem, water, cell, hand_m=4.0, reach_m=1500.0):
    """Height-above-nearest-drainage floodplain proxy.

    Not a substitute for a published flood map — it is the stand-in the v11
    pipeline used, kept because a corridor study still has to price a valley
    floor even where no flood layer exists.
    """
    if distance_transform_edt is None:
        return np.zeros_like(dem, np.float32)
    wm = water > 0.15
    if not wm.any():
        return np.zeros_like(dem, np.float32)
    dist = distance_transform_edt(~wm) * cell
    idx = distance_transform_edt(~wm, return_distances=False, return_indices=True)
    hand = dem - dem[tuple(idx)]
    return (((hand < hand_m) & (dist < reach_m)).astype(np.float32),
            hand.astype(np.float32))


def distance_to(mask, cell, cap=60000.0):
    if distance_transform_edt is None:
        return np.full(mask.shape, cap, np.float32)
    return np.clip(distance_transform_edt(~mask) * cell, 0, cap).astype(np.float32)


# ────────────────────────────────────────────────────────────────── packing ──
def pack_u16(a, scale=1.0, offset=0.0):
    q = np.clip((np.asarray(a, np.float32) - offset) * scale, 0, 65535).astype("<u2")
    return base64.b64encode(zlib.compress(q.tobytes(), 9)).decode()


def pack_u8(a):
    q = np.clip(np.asarray(a, np.float32), 0, 255).astype(np.uint8)
    return base64.b64encode(zlib.compress(q.tobytes(), 9)).decode()


def hillshade_png(dem, cell, path, exaggeration=1.0):
    """Hypsometric + hillshade preview, for the project card and QA."""
    if Image is None:
        return
    d = dem.astype(np.float64)
    lo, hi = np.percentile(d, 0.5), np.percentile(d, 99.5)
    t = np.clip((d - lo) / max(1e-6, hi - lo), 0, 1)
    gy, gx = np.gradient(d * exaggeration, cell)
    sh = np.clip(0.55 + (gx * 0.7 - gy * 0.7) * 9, 0, 1)
    k = 0.55 + 0.9 * sh
    rgb = np.stack([np.clip(t * 1.15, 0, 1), np.clip(t * .95 + .05, 0, 1),
                    np.clip(1 - t * .6, 0, 1)], -1) * k[..., None]
    Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8)).save(path)


LAYER_INFO = {
    # key            label                      colour        how the cost model reads it
    "dem":         ("Elevation",                None),
    "slope":       ("Ground slope",             None),
    "built":       ("Built-up / settlement",    "#5a5a64"),
    "protected":   ("Protected landscape",      "#c9a13c"),
    "woodland":    ("Woodland / forest",        "#468246"),
    "water_body":  ("Water body",               "#1466be"),
    "river_major": ("Major watercourse",        "#1466be"),
    "flood":       ("Floodplain",               "#3c82c8"),
    "road_major":  ("Major road",               "#aa5028"),
    "rail":        ("Existing railway",         "#7a4b8a"),
    "farmland":    ("High-grade farmland",      "#b9c46a"),
    "exclusion":   ("No-go zone",               "#c62828"),
}


def pack_project(outdir, ident, name, grid: Grid, layers: dict, controls=None,
                 notes=None, defaults=None, basemap=None, reference=None):
    """Write projects/<id>/project.json in the format js/gridpack.js reads."""
    os.makedirs(outdir, exist_ok=True)
    payload = {
        "id": ident,
        "name": name,
        "crs": ("EPSG:%d" % grid.epsg) if grid.epsg else "local metric",
        "utm": ({"zone": grid.zone, "hemi": grid.hemi} if grid.zone else None),
        "cell": grid.cell, "nx": grid.nx, "ny": grid.ny,
        "xmin": grid.xmin, "ymax": grid.ymax, "xmax": grid.xmax, "ymin": grid.ymin,
        "notes": notes or "",
        "defaults": defaults or {},
        "controls": controls or [],
        "basemap": basemap,
        # An alignment the project already settled on, carried as data so the
        # designer can load and evaluate it under any standard rather than
        # re-route it: {name, closed, pts: [[E, N], ...], stations: [...]}.
        "reference": reference,
        "layers": {}, "meta": {},
    }
    for key, arr in layers.items():
        arr = np.asarray(arr, np.float32)
        if key == "dem":
            payload["layers"][key] = pack_u16(arr, 10.0, -500.0)
            payload["meta"][key] = {"type": "u16", "scale": 10.0, "offset": -500.0,
                                    "unit": "m", "label": "Elevation"}
        elif key == "slope":
            payload["layers"][key] = pack_u16(np.clip(arr, 0, 200), 300.0, 0.0)
            payload["meta"][key] = {"type": "u16", "scale": 300.0, "offset": 0.0,
                                    "unit": "%", "label": "Ground slope"}
        elif key.startswith("d_"):
            payload["layers"][key] = pack_u16(np.clip(arr, 0, 60000), 1.0, 0.0)
            payload["meta"][key] = {"type": "u16", "scale": 1.0, "offset": 0.0,
                                    "unit": "m", "label": key}
        else:
            label, colour = LAYER_INFO.get(key, (key.replace("_", " ").title(), "#888888"))
            payload["layers"][key] = pack_u8(np.clip(arr, 0, 1) * 255)
            payload["meta"][key] = {"type": "u8", "scale": 255.0, "offset": 0.0,
                                    "unit": "coverage", "label": label, "colour": colour}
    path = os.path.join(outdir, "project.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"))
    print("   wrote %s  (%.1f MB)" % (path, os.path.getsize(path) / 1e6))
    return path


def update_index(projects_dir, entry):
    """Keep projects/index.json in step so the app's project picker sees it."""
    idx_path = os.path.join(projects_dir, "index.json")
    items = []
    if os.path.exists(idx_path):
        try:
            with open(idx_path, encoding="utf-8") as f:
                items = json.load(f).get("projects", [])
        except (ValueError, OSError):
            items = []
    items = [p for p in items if p.get("id") != entry["id"]]
    items.append(entry)
    items.sort(key=lambda p: p.get("name", ""))
    with open(idx_path, "w", encoding="utf-8") as f:
        json.dump({"projects": items}, f, indent=1)
    print("   index.json now lists %d project(s)" % len(items))
