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
    buffer_mask(...)            cells within a distance of a mask (the CRZ band)
    sample_grid(...)            bilinear sample of a grid layer at world E, N
    polyline_cut / _at / _locate   chainage along a reference alignment
    pack_project(...)           write the base64+deflate project.json the app reads

Grid convention (identical to v11 so the engine code carries straight over)
    x increases east, y increases north, cells are square, and the array is
    stored row-major from the NORTH-WEST corner:  A[iy*nx + ix]
        E = xmin + (ix + 0.5)*cell
        N = ymax - (iy + 0.5)*cell
"""
from __future__ import annotations

import base64
import csv
import glob
import json
import math
import os
import struct
import zipfile
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


def _geotiff_georef(im, path):
    """Georeferencing of an opened (not yet decoded) GeoTIFF, from its tags."""
    tags = getattr(im, "tag_v2", {})
    scale = tags.get(33550)          # ModelPixelScale (sx, sy, sz)
    tie = tags.get(33922)            # ModelTiepoint (i, j, k, x, y, z)
    xform = tags.get(33920)          # ModelTransformation (4x4)
    nodata = tags.get(42113)
    try:
        nodata = float(nodata) if nodata is not None else None
    except (TypeError, ValueError):
        nodata = None

    # GeoKeyDirectory: 1024 GTModelType (1 projected, 2 geographic),
    # 1025 GTRasterType (1 PixelIsArea, 2 PixelIsPoint),
    # 3072 ProjectedCSTypeGeoKey, 2048 GeographicTypeGeoKey
    epsg, model, raster_type = None, None, 1
    gk = tags.get(34735)
    if gk:
        gk = [int(v) for v in gk]
        for p in range(4, len(gk) - 3, 4):
            key, loc, _cnt, val = gk[p], gk[p + 1], gk[p + 2], gk[p + 3]
            if loc:
                continue
            if key == 1024:
                model = val
            elif key == 1025:
                raster_type = val
            elif key in (3072, 2048) and epsg is None:
                epsg = val

    if scale and tie:
        sx, sy = float(scale[0]), float(scale[1])
        i, j, X, Y = float(tie[0]), float(tie[1]), float(tie[3]), float(tie[4])
        if raster_type == 2:
            # PixelIsPoint: the tie point IS a pixel centre. Treating it as a
            # corner shifts the whole DEM by half a pixel — 45 m on a 90 m tile.
            x0 = X - i * sx
            y0 = Y + j * sy
        else:
            # PixelIsArea: the tie point is the corner of a pixel
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
    geographic = (model == 2) if model else (abs(dx) < 0.01)
    return {"x0": x0, "y0": y0, "dx": dx, "dy": dy, "nx": im.size[0], "ny": im.size[1],
            "geographic": geographic, "epsg": epsg, "nodata": nodata}


def _tiff_pixels(im, path):
    """Decode a TIFF's pixels. Pillow first; tifffile if Pillow cannot.

    Cloud-optimised GeoTIFFs (Copernicus, ALOS) are tiled, compressed and often
    use the floating-point predictor. Pillow's libtiff build reads them; if a
    particular build does not, tifffile does, and the message says how to get it.
    """
    try:
        z = np.asarray(im)
    except Exception as err:                              # noqa: BLE001
        try:
            import tifffile
        except ImportError:
            raise RuntimeError(
                "Pillow could not decode %s (%s). Install the TIFF reader that "
                "handles every GeoTIFF variant:  pip install tifffile imagecodecs"
                % (os.path.basename(path), err))
        z = tifffile.imread(path)
    z = np.asarray(z, dtype=np.float32)
    if z.ndim == 3:                                       # RGB elevation product
        z = z[..., 0]
    return z


def _read_geotiff(path):
    if Image is None:
        raise RuntimeError("Pillow is required to read TIFF DEMs (pip install pillow)")
    im = Image.open(path)
    g = _geotiff_georef(im, path)
    z = _tiff_pixels(im, path)
    return Raster(z, g["x0"], g["y0"], g["dx"], g["dy"], geographic=g["geographic"],
                  epsg=g["epsg"], nodata=g["nodata"])


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


def read_dem(path, extent=None, quiet=False):
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
    if quiet:
        return r
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


# ──────────────────────────────────────────────── tiled DEMs and mosaics ──
# Global DEMs come as 1 x 1 degree tiles, and a real corridor spans dozens of
# them: Delhi to Varanasi touches 32. Holding all of them in memory at 30 m is
# over 1.5 GB of float32, so a tile is known by its footprint (read from the
# header alone) and its pixels are decoded only while grid cells inside it are
# being sampled, then released.
DEM_EXTS = (".tif", ".tiff", ".gtiff", ".hgt", ".asc", ".grd")


def _unzip_dems(path):
    """Extract the DEM files inside a .zip once, next to it, and list them."""
    dest = os.path.splitext(path)[0] + "_unzipped"
    out = []
    with zipfile.ZipFile(path) as zf:
        for m in zf.namelist():
            if os.path.splitext(m)[1].lower() not in DEM_EXTS or m.endswith("/"):
                continue
            target = os.path.join(dest, os.path.basename(m))
            if not os.path.exists(target):
                os.makedirs(dest, exist_ok=True)
                with zf.open(m) as src, open(target, "wb") as dst:
                    dst.write(src.read())
            out.append(target)
    return out


def expand_dem_paths(specs):
    """Files, folders, wildcards and zips -> a sorted, de-duplicated file list.

    Wildcards are expanded here rather than by the shell, because Windows
    shells hand `*.tif` through to the program untouched.
    """
    found = []
    for spec in specs:
        if any(ch in spec for ch in "*?["):
            hits = sorted(glob.glob(spec))
        elif os.path.isdir(spec):
            hits = sorted(os.path.join(spec, f) for f in os.listdir(spec))
        else:
            hits = [spec]
        for h in hits:
            ext = os.path.splitext(h)[1].lower()
            if ext == ".zip":
                found.extend(_unzip_dems(h))
            elif ext in DEM_EXTS + (".npy",) and os.path.isfile(h):
                found.append(h)
            elif os.path.isfile(h) and spec == h:
                raise SystemExit("not a DEM this tool reads: %s" % h)
    seen, out = set(), []
    for f in found:
        k = os.path.normcase(os.path.abspath(f))
        if k not in seen:
            seen.add(k)
            out.append(f)
    return out


def peek_dem(path):
    """Footprint of a DEM file from its header alone — no pixels decoded."""
    ext = os.path.splitext(path)[1].lower()
    if ext in (".tif", ".tiff", ".gtiff"):
        if Image is None:
            raise RuntimeError("Pillow is required to read TIFF DEMs (pip install pillow)")
        with Image.open(path) as im:
            return _geotiff_georef(im, path)
    if ext == ".hgt":
        n = int(round(math.sqrt(os.path.getsize(path) / 2)))
        name = os.path.basename(path).upper()
        lat = int(name[1:3]) * (1 if name[0] == "N" else -1)
        lon = int(name[4:7]) * (1 if name[3] == "E" else -1)
        step = 1.0 / (n - 1)
        return {"x0": lon, "y0": lat + 1.0, "dx": step, "dy": -step, "nx": n, "ny": n,
                "geographic": True, "epsg": 4326, "nodata": None}
    if ext in (".asc", ".grd"):
        hdr = {}
        with open(path, "r", errors="replace") as f:
            for _ in range(8):
                parts = f.readline().split()
                if len(parts) >= 2 and parts[0].lower() in (
                        "ncols", "nrows", "xllcorner", "yllcorner", "xllcenter",
                        "yllcenter", "cellsize", "nodata_value", "dx", "dy"):
                    hdr[parts[0].lower()] = float(parts[1])
        nx, ny = int(hdr["ncols"]), int(hdr["nrows"])
        cs = hdr.get("cellsize", hdr.get("dx", 1.0))
        if "xllcenter" in hdr:
            x0, y0c = hdr["xllcenter"], hdr["yllcenter"]
        else:
            x0, y0c = hdr["xllcorner"] + cs / 2, hdr["yllcorner"] + cs / 2
        return {"x0": x0, "y0": y0c + cs * (ny - 1), "dx": cs, "dy": -cs,
                "nx": nx, "ny": ny, "geographic": cs < 0.01, "epsg": None,
                "nodata": hdr.get("nodata_value")}
    raise RuntimeError("cannot read the footprint of %s" % path)


class DemTile:
    """One DEM file, known by its footprint until its pixels are needed."""

    def __init__(self, path=None, raster=None):
        self.path, self._raster = path, raster
        if raster is not None:
            ny, nx = raster.shape
            info = {"x0": raster.x0, "y0": raster.y0, "dx": raster.dx, "dy": raster.dy,
                    "nx": nx, "ny": ny, "geographic": raster.geographic,
                    "epsg": raster.epsg}
        else:
            info = peek_dem(path)
        self.x0, self.y0 = info["x0"], info["y0"]
        self.dx, self.dy = info["dx"], info["dy"]
        self.nx, self.ny = info["nx"], info["ny"]
        self.geographic, self.epsg = info["geographic"], info["epsg"]

    def bounds(self):
        """Outer edges of the tile — pixel edges, not pixel centres."""
        xs = (self.x0 - self.dx / 2, self.x0 + self.dx * (self.nx - 0.5))
        ys = (self.y0 - self.dy / 2, self.y0 + self.dy * (self.ny - 0.5))
        return min(xs), min(ys), max(xs), max(ys)

    def native_m(self):
        if not self.geographic:
            return abs(self.dx)
        _, y0, _, y1 = self.bounds()
        return abs(self.dx) * 111320.0 * math.cos(math.radians((y0 + y1) / 2))

    def load(self):
        return self._raster if self._raster is not None else read_dem(self.path, quiet=True)

    def label(self):
        return os.path.basename(self.path) if self.path else "array"


def open_tiles(paths):
    tiles = [DemTile(p) for p in paths]
    kinds = {t.geographic for t in tiles}
    if len(kinds) > 1:
        raise SystemExit("these DEM files mix degrees and metres — reproject them to "
                         "one coordinate system first")
    if not tiles[0].geographic:
        codes = {t.epsg for t in tiles if t.epsg}
        if len(codes) > 1:
            raise SystemExit("these DEM files are in different projections %s — "
                             "reproject them to one first" % sorted(codes))
    return tiles


def tiles_bounds(tiles):
    b = [t.bounds() for t in tiles]
    return (min(x[0] for x in b), min(x[1] for x in b),
            max(x[2] for x in b), max(x[3] for x in b))


NICE_CELLS = (20, 25, 30, 40, 50, 60, 75, 80, 100, 120, 125, 150, 175, 200,
              225, 250, 275, 300, 350, 400, 500, 750, 1000)


def auto_cell(width_m, height_m, native_m, max_cells=4_500_000):
    """The finest sensible design cell for an extent, and why it was chosen.

    Never finer than the DEM itself (resampling cannot create detail), never
    finer than 20 m (nothing a corridor study decides depends on it), and
    coarse enough that the grid stays inside the cell budget the browser can
    hold — about 4.5 M cells, which is roughly 400 MB once every layer, the
    cost surface and the map overlays are built.
    """
    floor = max(20.0, native_m * 0.95)
    need = math.sqrt(max(1.0, width_m * height_m) / max_cells)
    want = max(floor, need)
    for c in NICE_CELLS:
        if c >= want:
            return float(c), ("DEM resolution" if c >= floor and floor >= need
                              else "grid size budget of %.1f M cells" % (max_cells / 1e6))
    return float(math.ceil(want / 100) * 100), "grid size budget"


def projected_bounds(x0, y0, x1, y1, zone, hemi, samples=64):
    """UTM bounding box of a lon/lat box, measured along its whole outline.

    Meridians converge, so a box 6 degrees wide is not a rectangle in UTM and
    its extreme eastings are not at its corners; sampling the outline catches
    the true extremes."""
    t = np.linspace(0, 1, samples)
    lon = np.concatenate([x0 + (x1 - x0) * t, np.full(samples, x1),
                          x1 - (x1 - x0) * t, np.full(samples, x0)])
    lat = np.concatenate([np.full(samples, y0), y0 + (y1 - y0) * t,
                          np.full(samples, y1), y1 - (y1 - y0) * t])
    E, N = utm_forward(lon, lat, zone, hemi)
    return float(E.min()), float(N.min()), float(E.max()), float(N.max())


def grid_from_metric_box(X0, Y0, X1, Y1, cell, epsg=None, zone=None, hemi="N",
                         max_cells=4_500_000):
    nx = max(2, int(math.ceil((X1 - X0) / cell)))
    ny = max(2, int(math.ceil((Y1 - Y0) / cell)))
    if nx * ny > max_cells * 1.02:
        raise SystemExit(
            "grid would be %d x %d = %.1fM cells. Raise --cell (now %g m), narrow "
            "the extent, or split the corridor into sections." % (nx, ny, nx * ny / 1e6, cell))
    return Grid(X0, Y1, cell, nx, ny, epsg=epsg, zone=zone, hemi=hemi)


def resample_tiles(tiles, grid, antialias=True, log=print):
    """Sample a set of DEM tiles onto the design grid, one tile at a time.

    Anti-aliasing: when the design cell is several DEM pixels wide, bilinear
    point sampling would pick one pixel in k and alias. On a surface model —
    Copernicus is a DSM, buildings and trees included — that turns every
    rooftop into a spurious hill. Each tile is first box-averaged over the
    footprint of one design cell, so the grid value is the mean ground in the
    cell, which is what earthworks are priced on.
    """
    GE, GN = grid.centres()
    geographic = tiles[0].geographic
    SX, SY = grid.to_source(GE, GN, geographic)
    out = np.full(GE.shape, np.nan, np.float32)
    used = 0
    for n, t in enumerate(tiles):
        # One pixel of tolerance at each edge: neighbouring tiles written with
        # different pixel conventions (or rounding in their tie points) can
        # leave a sliver no tile claims. Bilinear sampling clamps at the edge,
        # so a cell in that sliver takes the edge value — a one-pixel
        # extrapolation, instead of a hole filled from somewhere else.
        bx0, by0, bx1, by1 = t.bounds()
        tx, ty = abs(t.dx), abs(t.dy)
        m = (np.isnan(out) & (SX >= bx0 - tx) & (SX <= bx1 + tx)
             & (SY >= by0 - ty) & (SY <= by1 + ty))
        if not m.any():
            continue
        r = t.load()
        r.fill_voids()
        k = int(round(grid.cell / max(1e-6, t.native_m()))) if antialias else 1
        if k >= 2 and uniform_filter is not None:
            r.z = uniform_filter(r.z.astype(np.float32), size=k, mode="nearest")
        out[m] = r.sample(SX[m], SY[m])
        used += 1
        log("   %3d/%d  %-46s %8d cells%s" % (n + 1, len(tiles), t.label(), int(m.sum()),
                                              ("  (averaged %dx%d)" % (k, k)) if k >= 2 else ""))
        del r
    return out, used


# ─────────────────────────────────────────────────────── control points ──
def read_controls_csv(path):
    """Stations / control points from a CSV with a header row.

    Columns are found by name, case-insensitively: name; lat + lon (or
    latitude/longitude); or easting + northing (or E/N) in the project CRS;
    and optionally kind. Named columns, not positions, because a spreadsheet
    exported from Google Maps puts latitude FIRST and a GIS puts longitude
    first — and guessing wrong drops Delhi into the Arctic.

    Optional vertical intent, passed through only on rows that give it:
        leg     ground | elevated | tunnel — how the line runs FROM this point
                to the next ('auto' or blank: the standard's own policy)
        level   rail level here, metres on the DEM's datum
        depth   rail this far below ground here, metres (an underground station)
    These are what the browser's control list edits (c.leg, c.level, c.depth),
    so a tunnel study like Mumbai BKC - Thane can be seeded from the CSV rather
    than re-typed into the app every time the project is rebuilt.
    """
    def pick(row, *names):
        for nm in names:
            for k, v in row.items():
                if k and k.strip().lower() == nm and v not in (None, ""):
                    return v.strip()
        return None

    out = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        for i, row in enumerate(csv.DictReader(f)):
            name = pick(row, "name", "station", "id") or ("CP%d" % (i + 1))
            if name.startswith("#"):
                continue
            kind = pick(row, "kind", "type", "class") or "control"
            lat, lon = pick(row, "lat", "latitude"), pick(row, "lon", "lng", "long", "longitude")
            e, n = pick(row, "easting", "e", "x"), pick(row, "northing", "n", "y")
            extra = _vertical_intent(pick, row, path, i, name)
            if lat is not None and lon is not None:
                lat, lon = float(lat), float(lon)
                if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                    raise SystemExit("%s row %d (%s): lat %.4f lon %.4f is not a place on "
                                     "Earth — are the columns swapped?" % (path, i + 2, name, lat, lon))
                out.append(dict({"name": name, "kind": kind, "lat": lat, "lon": lon}, **extra))
            elif e is not None and n is not None:
                out.append(dict({"name": name, "kind": kind, "E": float(e), "N": float(n)}, **extra))
            else:
                raise SystemExit("%s row %d (%s): needs lat+lon or easting+northing columns"
                                 % (path, i + 2, name))
    return out


CONTROL_LEGS = ("ground", "elevated", "tunnel")


def _vertical_intent(pick, row, path, i, name):
    """The optional leg / level / depth of one control-point row.

    Only keys with a value are returned, so a CSV without these columns gives
    exactly the dicts it always did. A bad value stops the import with the row
    named: a typo'd 'tunel' silently read as 'ground' would put an underground
    station on the surface, and nobody would notice until the long section.
    """
    out = {}
    leg = pick(row, "leg")
    if leg is not None:
        leg = leg.lower()
        if leg not in CONTROL_LEGS + ("auto",):
            raise SystemExit("%s row %d (%s): leg '%s' — use one of %s (or auto / blank)"
                             % (path, i + 2, name, leg, " | ".join(CONTROL_LEGS)))
        if leg != "auto":                     # 'auto' is the browser's word for "unset"
            out["leg"] = leg
    for key in ("level", "depth"):
        v = pick(row, key)
        if v is None:
            continue
        try:
            out[key] = float(v)
        except ValueError:
            raise SystemExit("%s row %d (%s): %s '%s' is not a number (metres)"
                             % (path, i + 2, name, key, v))
    if "level" in out and "depth" in out:
        # The browser takes the level when both are set (study.js buildPolicy);
        # say so here rather than let one of them be ignored without a word.
        print("   !! %s row %d (%s) gives both level and depth — the level is used"
              % (os.path.basename(path), i + 2, name))
    return out


def lonlat_bbox(points, buffer_km=0.0):
    """Lon/lat box around points carrying lat/lon, grown by a buffer in km."""
    lats = [p["lat"] for p in points]
    lons = [p["lon"] for p in points]
    lat_c = (min(lats) + max(lats)) / 2
    dlat = buffer_km / 110.574
    dlon = buffer_km / (111.320 * math.cos(math.radians(lat_c)))
    return min(lons) - dlon, min(lats) - dlat, max(lons) + dlon, max(lats) + dlat


def slope_percent(dem_grid, cell):
    gy, gx = np.gradient(dem_grid.astype(np.float64), cell)
    return (np.hypot(gx, gy) * 100.0).astype(np.float32)


# ──────────────────────────────────────────────────────── vector ingestion ──
def _geojson_geoms(obj):
    """(kind, ring/line coordinate list, feature properties) for every geometry."""
    out = []

    def walk(g, props):
        if g is None:
            return
        t = g.get("type")
        if t == "FeatureCollection":
            for f in g.get("features", []):
                walk(f, props)
        elif t == "Feature":
            walk(g.get("geometry"), g.get("properties") or {})
        elif t == "GeometryCollection":
            for g2 in g.get("geometries", []):
                walk(g2, props)
        elif t == "Polygon":
            for ring in g["coordinates"]:
                out.append(("poly", ring, props))
        elif t == "MultiPolygon":
            for poly in g["coordinates"]:
                for ring in poly:
                    out.append(("poly", ring, props))
        elif t == "LineString":
            out.append(("line", g["coordinates"], props))
        elif t == "MultiLineString":
            for ln in g["coordinates"]:
                out.append(("line", ln, props))
        elif t == "Point":
            out.append(("point", [g["coordinates"]], props))
        elif t == "MultiPoint":
            for pt in g["coordinates"]:
                out.append(("point", [pt], props))
    walk(obj, {})
    return out


def rasterise_geojson(path, grid: Grid, width_px=1, supersample=3, select=None, label=None,
                      outline=False):
    """GeoJSON -> coverage grid in 0..1.

    Polygons are filled, lines are stroked `width_px` grid cells wide, points
    are dotted. Rendered at `supersample`x and box-averaged down, so a road
    that clips the corner of a cell contributes a partial cost, not a full one.

    outline=True strokes polygon rings as lines instead of filling them. The
    coastline needs it: fetch_osm writes the OSM coastline as lines, but the
    other common source — land polygons (osmdata.openstreetmap.de, GSHHG,
    Natural Earth) — would otherwise be filled, and every cell on land would
    come out "on the coast". (Land polygons split into tiles also carry the
    tile edges as straight artificial "shore"; prefer the coastline lines.)
    """
    if Image is None:
        raise RuntimeError("Pillow is required to rasterise vectors")
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        gj = json.load(f)
    geoms = _geojson_geoms(gj)
    if select is not None:
        geoms = [g for g in geoms if select(g[2])]
    if not geoms:
        print("   %s: no geometries" % (label or os.path.basename(path)))
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
    for kind, coords, _props in geoms:
        a = np.asarray(coords, dtype=np.float64)[:, :2]
        if geographic:
            X, Y = utm_forward(a[:, 0], a[:, 1], grid.zone, grid.hemi)
        else:
            X, Y = a[:, 0], a[:, 1]
        px, py = grid.world_to_px(X, Y)
        pts = list(zip((px * S).tolist(), (py * S).tolist()))
        if kind == "poly" and len(pts) >= 3 and not outline:
            dr.polygon(pts, fill=255)
            npoly += 1
        elif kind == "poly" and len(pts) >= 3:
            dr.line(pts + pts[:1], fill=255, width=max(1, int(round(width_px * S))))
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
          % (label or os.path.basename(path), npoly, nline, cov.mean() * 100))
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


def buffer_mask(mask, cell, dist_m, log=print):
    """Cells whose centre lies within dist_m of a cell of `mask` (mask included).

    Euclidean, from cell centre to cell centre, so the band is good to about
    one cell — the precision of the rasterised line it is measured from.
    Without scipy it falls back to a square (Chebyshev) dilation, which
    over-reaches by up to 41 % on the diagonals; it says so rather than
    quietly building a different band.
    """
    mask = np.asarray(mask, bool)
    if not mask.any() or dist_m <= 0:
        return mask.copy()
    if distance_transform_edt is not None:
        return distance_transform_edt(~mask) * cell <= dist_m
    r = int(dist_m // cell)
    log("   !! scipy not installed — the %g m band is a square dilation of %d cells "
        "(up to 41%% wider on the diagonals). pip install scipy for the true distance."
        % (dist_m, r))
    out = mask.copy()
    # Separable running max: r shifts along x, then r along y, of the growing
    # mask — 2r whole-array operations instead of (2r+1)^2.
    for _ in range(r):
        out[:, 1:] |= out[:, :-1].copy()
        out[:, :-1] |= out[:, 1:].copy()
    for _ in range(r):
        out[1:, :] |= out[:-1, :].copy()
        out[:-1, :] |= out[1:, :].copy()
    return out


# ──────────────────────────────────────────── points and lines on the grid ──
def sample_grid(arr, grid: Grid, E, N):
    """Bilinear sample of a design-grid layer at world E, N (project CRS).

    Values live at cell centres; between the outermost centres and the grid's
    edge the nearest edge value is held. Outside the grid: NaN — a surveyed
    point the DEM does not cover must not be compared with a clamped value
    from somewhere else.
    """
    E = np.asarray(E, np.float64)
    N = np.asarray(N, np.float64)
    fx = (E - grid.xmin) / grid.cell - 0.5
    fy = (grid.ymax - N) / grid.cell - 0.5
    inside = (E >= grid.xmin) & (E <= grid.xmax) & (N >= grid.ymin) & (N <= grid.ymax)
    fx = np.clip(fx, 0, grid.nx - 1)
    fy = np.clip(fy, 0, grid.ny - 1)
    x0 = np.minimum(np.floor(fx).astype(np.int64), grid.nx - 2)
    y0 = np.minimum(np.floor(fy).astype(np.int64), grid.ny - 2)
    tx, ty = fx - x0, fy - y0
    a = np.asarray(arr, np.float64)
    v = ((a[y0, x0] * (1 - tx) + a[y0, x0 + 1] * tx) * (1 - ty)
         + (a[y0 + 1, x0] * (1 - tx) + a[y0 + 1, x0 + 1] * tx) * ty)
    return np.where(inside, v, np.nan)


def polyline_cum(pts):
    """Cumulative grid length at each vertex of [[E, N], ...] — chainage from 0."""
    p = np.asarray(pts, np.float64)[:, :2]
    if len(p) < 2:
        return np.zeros(len(p))
    return np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(p, axis=0).T))])


def polyline_at(pts, cum, s):
    """(E, N) at distance s along the polyline (clamped to its ends)."""
    p = np.asarray(pts, np.float64)[:, :2]
    s = min(max(float(s), 0.0), float(cum[-1]))
    k = int(np.searchsorted(cum, s, side="right")) - 1
    k = min(max(k, 0), len(p) - 2)
    L = cum[k + 1] - cum[k]
    t = (s - cum[k]) / L if L > 0 else 0.0
    return float(p[k, 0] + t * (p[k + 1, 0] - p[k, 0])), float(p[k, 1] + t * (p[k + 1, 1] - p[k, 1]))


def polyline_cut(pts, s0, s1, tol=1e-3):
    """The part of a polyline between distances s0 and s1 along it.

    The ends are interpolated exactly, not snapped to the nearest vertex: a
    reference clipped to CH 333 641 must start at CH 333 641, or every
    chainage measured along it afterwards is off by the snap. A vertex within
    `tol` metres of a cut is dropped so no zero-length segment is left.
    """
    p = np.asarray(pts, np.float64)[:, :2]
    cum = polyline_cum(p)
    a, b = polyline_at(p, cum, s0), polyline_at(p, cum, s1)
    mid = p[(cum > s0 + tol) & (cum < s1 - tol)]
    return [list(a)] + [[float(x), float(y)] for x, y in mid] + [list(b)]


def polyline_locate(pts, E, N):
    """(distance along, offset from) the polyline of the point nearest E, N."""
    p = np.asarray(pts, np.float64)[:, :2]
    cum = polyline_cum(p)
    a, d = p[:-1], np.diff(p, axis=0)
    L2 = np.maximum((d * d).sum(1), 1e-12)
    t = np.clip(((E - a[:, 0]) * d[:, 0] + (N - a[:, 1]) * d[:, 1]) / L2, 0, 1)
    off = np.hypot(a[:, 0] + t * d[:, 0] - E, a[:, 1] + t * d[:, 1] - N)
    k = int(np.argmin(off))
    return float(cum[k] + t[k] * math.sqrt(L2[k])), float(off[k])


def json_plain(obj):
    """Recursively turn numpy scalars/arrays and tuples into plain JSON types.

    json.dump would refuse a numpy float32 outright and write a float NaN as
    the bare token NaN — which Python reads back but the browser's JSON.parse
    rejects, taking the whole project down with it. Non-finite numbers become
    null, which every reader of these files already treats as "no value".
    """
    if isinstance(obj, dict):
        return {str(k): json_plain(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, np.ndarray)):
        return [json_plain(v) for v in obj]
    if isinstance(obj, (bool, np.bool_)):
        return bool(obj)
    if isinstance(obj, (int, np.integer)):
        return int(obj)
    if isinstance(obj, (float, np.floating)):
        v = float(obj)
        return v if math.isfinite(v) else None
    return obj


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
    # Coastal classes (MAHSR: Thane Creek, the Vasai / Vaitarna / Narmada / Tapi
    # estuaries). Colours match js/render.js so the legend and the map agree.
    "mangrove":    ("Mangrove",                 "#007a5c"),
    "wetland":     ("Wetland / mudflat",        "#60b0a8"),
    "crz":         ("Coastal regulation zone",  "#ebaa1e"),
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
