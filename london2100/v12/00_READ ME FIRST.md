# London 2100 · Rail Alignment Designer — v12

The app that drew the final alignment of the medium-speed orbital.

## Running it

**Double-click `index.html`.** That is the whole install: no server, no build
step, nothing to download. It wants Chrome or Edge 80+, Firefox 113+ or Safari
16.4+, because it unpacks its grids with the browser's own
`DecompressionStream`. Give it a few seconds on opening — `js/data_grid.js` is
13 MB of terrain and constraint grids and they are unpacked before the first
draw.

Everything the app needs is in `js/`. Nothing here calls out to the internet, so
it runs offline and will keep running years from now.

## What is in here

| | |
|---|---|
| `index.html`, `js/` | the app |
| `data/` | what it was built from — the seventeen nodes (`nodes.csv`), the settled alignment as GeoJSON and JSON, and the loop as a numpy array |
| `outputs/` | what it produced — the alignment as DXF (BNG metres, EPSG:27700), the journey times, the loop summary, and the plates the book figures were cut from |
| `outputs/Final rail alignment.png` | the presentation sheet of that alignment |
| `README.md` | what the app does, the rules it works to, and how to drive it |
| `VERSION.md` | what changed in v12 and what deliberately did not |

## The line it settles on

412 km, seventeen stations, worked in both directions. Calling at all of them:
89.2 minutes round the loop, 277 km/h average, 5.2 minutes between stations.
Black on the sheet is overground, brown is in tunnel.

The geometry, the journey times and the outputs are unchanged from v11 — v12 was
a presentation build. Nothing in this package has been edited since.

## A note on the other line

The high-speed line through the six primary nodes is a **different** tool
(`03_App/Geometry Optimiser`) and is not in this package. This one is the
medium-speed orbital.
