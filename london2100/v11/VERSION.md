# v11 — the mathematics audit, rectification, and the display fixes

**Date:** 2026-08-05
**Trigger:** user review of v10 — "peak 750 never achieved", "speed map only
green/yellow", "time map mostly accel/brake", "mostly tunnels + bad colours",
"busy base map, toggles barely work", "node not on the line when zoomed",
"map-only georeferenced export", "hover sync map↔section".

## 1 · The speed mathematics — audited, verified, explained

`build/verify_and_rectify.py` Part 1 checks the model against closed forms:

- **Stopping IS modelled**: v = 0 at every call; pull-away matches v = √(2·1.5·d)
  to the decimal (+1 km: 197.2 | 197.2 km/h · +5 km: 440.9 | 440.9).
- Segment times match the closed-form trapezoid at the achieved peak.
- **Why 750 never appeared — the curve-speed table** (maglev 12° bank, a_q 0.63):
  R 5,725 → 450 · R 9,089 → 567 · R 11,616 → 641 · **R 15,903 → 750**.
  Even at the MbBO *legal* ceiling (a_q 1.5) 750 needs R ≥ 11,994 m.
  The loop's design radius (8,552 slider / 9,167 guaranteed) was derived for
  550 km/h in the study phase. **Physics, not a bug.**
- Aggravating artifact: the lattice dithers ±5° per 800 m, so 67 % of route
  length measured below the 15,900 m needed for 750 — visually straight runs
  were chains of near-minimum-radius arcs.

## 2 · Rectification — taut string through a ±60 m tube

After uniform and curvature-blended low-passes both failed (inward shift σ²/2R on
real curves; aliasing against the dither dropping measured R to 4,832), the
accepted method is **string-pulling**: curve-shortening flow clamped to a ±60 m
corridor (segment-projected walls), no pins (a pinned string kinks — R 296 m),
closed-circuit resample first (wrap-flow across the unequal 329 m seam kinked at
R 1,553), seam tube widened to 400 m over an 8 km quadratic taper, then a local
Gaussian pass spreads the closing S-jog. Seam acceptance is **operational**: curve
cap ≥ √(2·a·ds) reachable speed from the mandatory P1 stop (margin +31 km/h).

Result: max lateral shift 60 m mainline (2.4 px at 25.4 m/px) / ≤312 m confined
to the P1 throat · mainline R 8,926 (lost exactly the tube) · A3 R 5,636 ·
48 % of length genuinely 750-capable · closure gap 329 → 0 m (loop truly closed)
· array rolled so chainage 0 = P1. **Alignment visually unchanged.**

## 3 · Journey times (rectified, 412.1 km)

| pattern | calls | run | dwell | TOTAL | avg | peak |
|---|---|---|---|---|---|---|
| Primaries | 6 | 54.1 | 5.0 | **59.1 min** | ~418 | **717** |
| + airports | 9 | 59.2 | 8.0 | **67.2** | ~368 | 717 |
| P + S | 14 | 68.4 | 13.0 | **81.4** | ~304 | 665 |
| All | 17 | 73.4 | 16.0 | **89.4** | ~273 | 664 |

Peak rose 641 → 717; laps gained only ~0.4 min because the REAL corridor curves
still cap 568 km/h and alternate with the straights. **Genuine sustained 750
requires re-routing the mainline at R ≥ 16,000 m — a geometry change, deferred
by explicit user instruction ("do not change what the alignment looks like").**

## 4 · Display and app fixes

- **Structure colours**: below ground = reds (tunnel dark #8e2020, cutting light
  #d98880); above ground = blues (viaduct dark #1a4e8a, bridge #2e86c1,
  embankment light #85b8dc); at grade grey-green #6f7f6f. Same palette in the
  app, the long section, `render_loop.py` and the DXF layers. (The "mostly
  tunnels" reading was the old brown cutting colour — tunnel is 2.7 %.)
- **Speed view** normalises by the peak actually achieved, not the 750 setting —
  red stop zones and blue peak bands now visible. Legend shows real km/h bands.
- **Time/phase view**: classification by physical acceleration d(v²)/2ds with a
  0.25 m/s² threshold (old per-sample test fired on every cap ripple), station
  phase covers ±400 m of every stop.
- **Nodes snap onto the alignment** for display (nominal points sit up to ~60 m
  off the line — glaring when zoomed). Line width follows zoom (~16 m formation,
  4 px floor).
- **Layer system**: every layer has on/off + opacity slider; defaults reproduce
  the presentation-render look (hypsometric base + AONB/built/rivers); QGIS
  raster is an optional layer, off by default.
- **Export map PNG (1:1 georef)**: canvas sized to the QGIS base raster's native
  pixels (25.4 m/px), same MapView draw, transparent when all base layers off —
  drops pixel-registered over the user's own maps.
- **Hover sync**: cursor on the map ⇄ cursor on the long section (shared
  alignment index, rAF-throttled), with chainage/ground/rail/speed readout.
- `speedProfile` dedupes stops closer than 500 m (loop origin at both chainage
  ends produced a phantom double-stop at P1).

## Verification

- Closed-form checks above; JS pipeline previously agreed with Python within
  0.2 % and the model code is unchanged apart from the phase/stop-dedupe fixes.
- App booted with rectified canonical loop; all scripts parse; exports run.

## Open

- Sustained 750 km/h = mainline R 16,000 m re-route — next design decision.
- S4→P5 detour (+53 %) unchanged — S4 siting question.
