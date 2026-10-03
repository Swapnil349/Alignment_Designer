# CLAUDE.md

Orientation for Claude Code sessions on this repository. The README is the full
account; this is what you need before touching anything.

## What this is

A DEM-based corridor-planning tool for linear infrastructure (road, conventional
rail, high-speed rail, metro, maglev), in the spirit of Trimble Quantm, plus the
London 2100 orbital rail study it grew out of.

| folder | role | edit? |
|---|---|---|
| `designer/` | the generic tool — **where development happens** | yes |
| `london2100/v12/` | London study, latest delivery build (Sep 2026) | no — a delivered record |
| `london2100/v11/` | London study, previous build; holds the Python `build/` pipeline | no |

Both used to be called "v12". `london2100/v12` is a presentation build of
`london2100/v11` (only `render.js` and `index.html` differ); `designer/` is a
separate, generalised codebase. Do not merge them.

## Running

```bash
python serve.py --no-browser      # http://localhost:8770/designer/
```

Pure browser JavaScript, no build step, no npm. Python (numpy, pillow, scipy) is
only for the data pipeline in `designer/build/`. The app needs
`DecompressionStream` (Chrome/Edge 80+, Firefox 113+, Safari 16.4+).

Syntax-check JS with `node --check designer/js/<file>.js`.

Regenerate projects (they are committed, so only when the pipeline changes):

```bash
python designer/build/make_demo.py        # synthetic demo
python designer/build/convert_london.py   # London grid + settled loop, from london2100/v12
python designer/build/import_dem.py --dem X.tif --id myproj   # any DEM
```

## Architecture of `designer/js/` (script tags, globals, load order matters)

`standards.js` → `engine.js` → `costs.js` → `study.js` → `render.js` →
`export.js` → `app.js`. Each attaches one global (`STANDARDS`, `ENGINE`, `COSTS`,
`STUDY`, `RENDER`, `EXPORT`); `app.js` exposes `window.AD` for console use
(`AD.result`, `AD.study`, `AD.cfg`, `AD.run()`, `AD.options()`, `AD.reference()`).

- **standards.js** — mode + design speed → geometric envelope (`rMin`,
  `maxGrade`, vertical curve radii, width, rates). Values are derived from the
  published rules, never tabulated.
- **engine.js** — state-lattice A* over (cell, heading, last-turn). The per-step
  heading change is capped so every emitted arc satisfies `R ≥ rMin` **by
  construction**. Vertical profile by alternating projection; route ends tied to
  ground via a gradient reachability envelope.
- **study.js** — `runOne` (route + evaluate), `evaluatePath` (evaluate any
  polyline), `evaluateReference` (a project's settled line), `run` (option family).
- **costs.js** — earthworks by volume, structures, land, mass haul, scoring, Pareto.

## Invariants — do not break these

1. **The radius guarantee is structural.** Never add smoothing or a free-heading
   fallback after the search; either produces corners below `rMin`. A leg that
   cannot be routed is relaxed *and reported* (`search.relaxed`), never silently.
2. **Stride is floored at `rMin·Δθ·1.02`** inside `search()`. Below it one heading
   bucket is already tighter than the standard.
3. **Only the two ends of an open route are tied to ground.** Pinning every
   station over-constrained the London profile (vertical R fell from 67 km to
   208 m). Station cut/fill is reported instead.
4. **Costs are comparative.** Rates rank options; they are not an estimate. Keep
   that wording wherever a cost is shown or exported.
5. **Report, don't hide.** Failures, relaxations, tie errors and effective stride
   are surfaced in the UI. Keep doing so.

## Validation anchors

If a change moves these, it changed behaviour — check why before accepting it.

- London reference loop at maglev 750 km/h, accel/brake 1.5 m/s², 60 s dwell, all
  17 calls: **412.16 km · tightest curve 5,637 m · 89.2 min · 277 km/h avg · 664
  km/h peak** (matches `london2100/v12/00_READ ME FIRST.md`).
- Maglev standard at 550 km/h, θ 12°, a_q 0.63 → **R_min 8,552 m** (v11's value).
- Road at 100 km/h, e 7 % → **R_min 414 m, SSD 183 m, K crest 51 / sag 44** (AASHTO).
- Demo project, rail_hs 250 km/h, default weights → **~52.65 km**, both end ties exact.

```js
// in the browser console, on the London project
STUDY.evaluateReference(ENGINE.G.reference, Object.assign({}, AD.cfg, {
  mode: 'maglev', designSpeed: 750, params: STANDARDS.defaultParams('maglev'),
  accel: 1.5, brake: 1.5, dwell: 60, stopAtControls: true }))
```

## Conventions

- Comment density is high and explains *why*, including approaches that were
  tried and failed. Match it; do not strip the history out of comments.
- Coordinates are projected metres, `{E, N}`; grids are row-major from the
  north-west corner, `A[iy*nx + ix]`.
- Cache-bust script tags (`?v=`) in `designer/index.html` when JS changes ship.
- Known limits are listed in the README under **Honest limits**; update that
  section when you remove or add one.
