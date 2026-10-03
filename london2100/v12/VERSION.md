# v12 — delivery build: default view and terrain basemap

**Date:** 2026-08-16
**Scope:** presentation only. **No routing, engine, service or geometry logic was
touched.** The alignment, journey times and all outputs are byte-identical to v11.

## Changes

### 1 · Default map view (`js/render.js`, `MapView.showLayers`)
Now opens on the constraint read against white, matching the agreed reference:

| Layer | v11 | v12 |
|---|---|---|
| Topography (hypsometric) | ON | **OFF** |
| Detailed base map (QGIS) | off | off |
| AONB / National Landscape | ON | ON |
| Green Belt | off | off |
| Built-up area | ON | ON |
| Woodland | off | off |
| **Floodplain (proxy)** | off | **ON** |
| Major rivers | ON | ON |
| Primary roads | off | off |

Rationale: the four layers now shown are precisely the ones carrying routing
weight, so the opening screen explains the alignment rather than decorating it.

### 2 · Topography replaced (`js/render.js`, `demOverlay`)
The blue→yellow hypsometric ramp is gone. The layer now reproduces the published
project basemap exactly:

- matplotlib **`terrain`** ramp, **fixed at −40 … 230 m AOD** — fixed limits, not
  array min/max, so the app and every exported sheet read the same height as the
  same colour
- hillshade from **315° at 50° altitude, ×17 vertical exaggeration**, using the
  matplotlib `LightSource` surface-normal form with array-wide rescaling
- composited **terrain 90 % over white, then grey hillshade 30 % over that**

**Verified, not assumed.** The JS was transliterated back into Python and run on
the same DEM:
- colour ramp vs matplotlib: worst channel error **0.0093** — that is matplotlib's
  own 256-entry LUT quantisation (2.4/255), i.e. the JS is the more precise of the two
- full render vs the approved print basemap: mean |diff| **9.95/255**, entirely
  attributable to hillshade resolution (100 m in-app vs 25.4 m in the print
  render, which upsamples the DEM before shading). Ramp and composite identical.

### 3 · Cache-buster bumped to `?v=12`

## Delivery package

`London2100_Delivery/01_App/` — `index.html`, `js/` (7 files, 15 MB) and a README
covering: how to run, panel-by-panel tour, five-minute walkthrough, every export,
what the numbers mean, and a **known-limits** section (floodplain is a HAND proxy
not EA Flood Zone; woodland is Zoomstack not the Ancient Woodland Inventory; the
DEM is contour-interpolated; S4→P5 is +53 %; re-routing takes 20–25 min).
Zip the folder and it runs by double-clicking `index.html` — no server, no
install, no network.

## Not verified in this build

Live in-browser confirmation was not possible — the preview pane switched to
rendering local files as static snapshots mid-session, so scripts do not execute
in it. The terrain maths is verified by transliteration as above; the layer
defaults are a two-line data change. **Open `01_App/index.html` in a real browser
once to confirm before circulating.**

---

**Packaging check, 11 Sep 2026.** This shared copy was opened in Chrome straight from
local files. It loaded, drew the 17-station loop and filled the results panel with no
server and no network. That settles the "not verified in this build" note above.
