/* ===========================================================================
   Alignment Designer v12 :: OPTION GENERATION

   The point of the tool, and the thing that distinguishes corridor planning
   from drawing a line: generate a FAMILY of feasible alignments, evaluate each
   one on the same basis, and show the trade-off surface — so the decision is
   made against evidence rather than defended after the fact.

   Alternatives are generated along three axes, because those are the three
   levers that actually move a corridor:

     GEOMETRY      design speed sets the minimum radius, which sets how much the
                   line is allowed to bend around what it wants to avoid. A
                   250 km/h option and a 350 km/h option are different routes,
                   not the same route driven faster.
     PRIORITIES    what the study is willing to pay to avoid. Weight sets are
                   named after the argument they represent, so a reader can see
                   which case each line is making.
     CORRIDOR      a lateral via-point offset on the longest leg, which is what
                   produces genuinely distinct northern/southern corridors
                   rather than variations on one line.

   Every option is routed by the same curvature-constrained search, so every
   option is buildable to its own standard by construction. Options that cannot
   be routed are reported, not silently dropped.
   =========================================================================== */
(function (global) {
'use strict';
const E = global.ENGINE, S = global.STANDARDS, C = global.COSTS;

/* Weight presets. Each is an argument about what a route should avoid, and the
   multiplier applies on top of the user's own weights so the sliders still
   matter — a preset shifts the emphasis, it does not overrule the study. */
const PRIORITIES = {
  balanced:    { label: 'Balanced',            mul: {} },
  cheapest:    { label: 'Least cost',          mul: { built: 0.55, protected: 0.5, woodland: 0.4,
                                                      farmland: 0.4, turn: 0.7 } },
  shortest:    { label: 'Shortest / fastest',  mul: { built: 0.7, protected: 0.6, woodland: 0.5,
                                                      farmland: 0.5, turn: 1.8, terrGrade: 0.6 } },
  environment: { label: 'Environment led',     mul: { protected: 2.6, woodland: 2.4, flood: 2.0,
                                                      water_body: 1.8, farmland: 1.5 } },
  community:   { label: 'Community led',       mul: { built: 2.8, road_major: 1.4, rail: 1.4 } },
  terrain:     { label: 'Terrain following',   mul: { terrGrade: 2.2, terrUndul: 2.4, slope: 2.0,
                                                      turn: 0.45 } },
};

/** Colour ramp best (blue) → worst (red), for the map spread. */
function rampColour(t) {
  t = Math.max(0, Math.min(1, t));
  const stops = [[0, 26, 86, 190], [0.35, 30, 150, 140], [0.6, 220, 170, 40],
                 [0.8, 230, 110, 40], [1, 200, 40, 40]];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const a = stops[i-1], b = stops[i], f = (t - a[0]) / (b[0] - a[0]);
      return `rgb(${Math.round(a[1]+(b[1]-a[1])*f)},${Math.round(a[2]+(b[2]-a[2])*f)},` +
             `${Math.round(a[3]+(b[3]-a[3])*f)})`;
    }
  }
  return 'rgb(200,40,40)';
}

function applyPriority(base, key) {
  const w = Object.assign({}, base);
  const mul = (PRIORITIES[key] || PRIORITIES.balanced).mul;
  for (const k in mul) if (w[k] !== undefined) w[k] = w[k] * mul[k];
  return w;
}

/** Insert a synthetic via point offset perpendicular to the longest leg. */
function offsetControls(controls, frac) {
  if (!frac) return controls.slice();
  let bi = 0, bd = -1;
  for (let i = 0; i < controls.length - 1; i++) {
    const d = Math.hypot(controls[i+1].E - controls[i].E, controls[i+1].N - controls[i].N);
    if (d > bd) { bd = d; bi = i; }
  }
  const a = controls[bi], b = controls[bi+1];
  const dx = b.E - a.E, dy = b.N - a.N, len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  const via = { id: '_via', name: 'corridor via', synthetic: true,
                E: (a.E + b.E) / 2 + nx * len * frac,
                N: (a.N + b.N) / 2 + ny * len * frac };
  const out = controls.slice();
  out.splice(bi + 1, 0, via);
  return out;
}

/** Clamp a control point into the grid, so an offset via cannot leave the DEM. */
function clampToGrid(c) {
  const pad = E.G.cell * 6;
  return { ...c,
    E: Math.max(E.G.xmin + pad, Math.min(E.G.xmax - pad, c.E)),
    N: Math.max(E.G.ymin + pad, Math.min(E.G.ymax - pad, c.N)) };
}

/**
 * The scenario list. Kept short enough to run interactively in a browser —
 * every entry is a full lattice search — and each one is named after the case
 * it makes so the comparison table reads as an argument, not a parameter sweep.
 */
function scenarios(cfg) {
  const m = S.MODES[cfg.mode] || S.MODES.road;
  const speeds = m.speeds;
  const at = speeds.indexOf(cfg.designSpeed);
  const i = at < 0 ? Math.floor(speeds.length / 2) : at;
  const slower = speeds[Math.max(0, i - 1)];
  const faster = speeds[Math.min(speeds.length - 1, i + 1)];
  const V = cfg.designSpeed;

  const list = [
    { id: 'A', name: 'Balanced',        priority: 'balanced',    V, offset: 0 },
    { id: 'B', name: 'Least cost',      priority: 'cheapest',    V, offset: 0 },
    { id: 'C', name: 'Shortest',        priority: 'shortest',    V, offset: 0 },
    { id: 'D', name: 'Environment led', priority: 'environment', V, offset: 0 },
    { id: 'E', name: 'Community led',   priority: 'community',   V, offset: 0 },
    { id: 'F', name: 'Terrain hugging', priority: 'terrain',     V, offset: 0 },
  ];
  if (faster !== V)
    list.push({ id: 'G', name: `Higher speed ${faster}`, priority: 'balanced', V: faster, offset: 0 });
  if (slower !== V)
    list.push({ id: 'H', name: `Lower speed ${slower}`, priority: 'terrain', V: slower, offset: 0 });
  if (cfg.corridors !== false) {
    list.push({ id: 'J', name: 'Corridor — left',  priority: 'balanced', V, offset:  0.14 });
    list.push({ id: 'K', name: 'Corridor — right', priority: 'balanced', V, offset: -0.14 });
  }
  return list.slice(0, cfg.maxOptions || 10);
}

/** Route and evaluate ONE option. Returns null with `.error` set on failure. */
function runOne(sc, cfg, controls) {
  const std = S.derive(cfg.mode, sc.V, cfg.params, cfg.useDesirable);
  const pts = offsetControls(controls, sc.offset).map(clampToGrid);
  let direct = 0;
  for (let i = 1; i < pts.length; i++)
    direct += Math.hypot(pts[i].E - pts[i-1].E, pts[i].N - pts[i-1].N);

  const w = applyPriority(cfg.weights, sc.priority);
  w.rMin = std.rGoverning;
  w.stride = cfg.stride || E.strideFor(w.rMin, direct);
  w.maxGrade = std.maxGrade;
  w.vCrestR = std.vCrestR;
  w.vSagR = std.vSagR;

  const sr = E.searchChain(pts, w, null, { closed: cfg.closed, corridor: cfg.corridor });
  if (!sr || sr.error)
    return { sc, std, error: (sr && sr.error) || 'no route', leg: sr && sr.leg };

  return evaluatePath(sr.pts, { sc, std, w, cfg, controls, used: pts, direct,
                                 search: sr, closed: cfg.closed });
}

/**
 * Everything after the search: resample, profile, structures, quantities,
 * speed. Split out of runOne so an alignment that was NOT routed here — the
 * settled line a project carries as its reference — goes through exactly the
 * same evaluation as one that was, and the two can be compared on one basis.
 */
function evaluatePath(raw, ctx) {
  const { sc, std, w, cfg, controls } = ctx;
  const P = E.resample(raw, 25);
  const R = E.curvature(P, 8);
  const chn = E.nodeChainages(P, controls);
  /* What must sit on existing ground: the two ends of an open route, because
     that is where it ties into the network that already exists. Nothing else.

     Intermediate stations are deliberately NOT pinned. A platform has to be at
     the DESIGN level, not at the level the ground happens to be — stations on
     embankment and in cutting are entirely normal. Pinning them all was tried,
     and on the 17-station London circuit it over-constrained the profile so
     badly that the vertical radius collapsed from 67 km to 208 m: the fitter was
     being asked to touch seventeen fixed points and hold a 67 km vertical curve
     between them, and no such profile exists. Their cut and fill is reported
     instead, which is the number a designer actually needs to see. */
  const tie = (cfg.tieControls === false || ctx.closed) ? [] :
    [chn[0], chn[chn.length - 1]]
      .filter(c => c && !c.node.synthetic)
      .map(c => ({ idx: c.idx }));
  const vp = E.verticalProfile(P, w, { tie });
  const t = E.structureThresholds(std);
  const structs = E.classifyStructures(P, vp, t);
  const runs = E.structureRuns(P, structs);
  const q = C.evaluate(P, vp, structs, runs, std, cfg.costOverrides);

  const kin = std.kinematics;
  const sp = E.speedProfile(P, R, {
    vmax: sc.V, accel: cfg.accel || kin.accel, brake: cfg.brake || kin.brake,
    dwell: cfg.dwell === undefined ? kin.dwell : cfg.dwell,
    stops: cfg.stopAtControls ? chn.map(c => c.s) : null,
    curveSpeed: Rm => S.speedForRadius(cfg.mode, Rm, std.params),
  });

  let minR = Infinity;
  for (let i = 0; i < R.length; i++) {
    const a = Math.abs(R[i]); if (isFinite(a) && a < minR) minR = a;
  }
  let maxGrade = 0;
  for (let i = 0; i < vp.grade.length; i++) maxGrade = Math.max(maxGrade, Math.abs(vp.grade[i]));
  const direct = ctx.direct;

  return {
    sc, std, w, P, R, vp, structs, runs, sp, q, search: ctx.search, chn,
    controls: ctx.used || controls, priority: sc.priority,
    metrics: { length: P[P.length-1].s, direct, minR, maxGrade,
               hip: E.countHIP(R, std.rGoverning), vip: vp.vip,
               deviation: direct > 0 ? P[P.length-1].s / direct - 1 : 0 },
  };
}

/**
 * Evaluate a project's reference alignment under the current standard.
 *
 * The line is taken exactly as supplied — not re-routed, not smoothed — and
 * judged against whatever mode and design speed are selected. That is the
 * question a reference exists to answer: does the line we settled on meet this
 * standard, and what does it cost and take under it?
 */
function evaluateReference(ref, cfg) {
  const V = cfg.designSpeed;
  const std = S.derive(cfg.mode, V, cfg.params, cfg.useDesirable);
  const w = Object.assign({}, cfg.weights, {
    rMin: std.rGoverning, maxGrade: std.maxGrade,
    vCrestR: std.vCrestR, vSagR: std.vSagR,
  });
  let raw = ref.pts.map(p => ({ E: p[0], N: p[1] }));
  /* A closed ring is stored as UNIQUE vertices with the closing segment
     implicit (london2100/v12/data/alignment.json says so in as many words).
     Append the first vertex so the closing segment is actually measured —
     without it the loop comes up one segment short and never closes. */
  let gap = 0;
  if (ref.closed) {
    const a = raw[0], b = raw[raw.length - 1];
    gap = Math.hypot(a.E - b.E, a.N - b.N);
    if (gap > 0.01) raw = raw.concat([{ E: a.E, N: a.N }]);
  }
  const stations = (ref.stations && ref.stations.length)
    ? ref.stations.map(st => ({ id: st.id, name: st.name, kind: st.kind, E: st.E, N: st.N }))
    : [];
  let direct = 0;
  for (let i = 1; i < stations.length; i++)
    direct += Math.hypot(stations[i].E - stations[i-1].E, stations[i].N - stations[i-1].N);
  if (ref.closed && stations.length > 2)
    direct += Math.hypot(stations[0].E - stations[stations.length-1].E,
                         stations[0].N - stations[stations.length-1].N);
  const search = { reference: true, name: ref.name, closed: !!ref.closed,
                   stride: null, rAchievable: null, endGap: 0, relaxed: [],
                   closingSegment: gap, expanded: 0 };
  const sc = { id: 'REF', name: ref.name || 'Reference alignment',
               priority: 'reference', V, offset: 0 };
  return evaluatePath(raw, { sc, std, w, cfg, controls: stations, used: stations,
                             direct, search, closed: !!ref.closed });
}

/**
 * Generate the whole family. Yields to the event loop between options so the
 * progress readout actually paints — a 10-option study is 10 lattice searches
 * and can run for a minute on a large grid.
 */
async function run(controls, cfg, onProgress) {
  const list = scenarios(cfg);
  const out = [], failed = [];
  for (let i = 0; i < list.length; i++) {
    const sc = list[i];
    if (onProgress) onProgress(i, list.length, sc.name);
    await new Promise(r => setTimeout(r, 0));
    let r;
    try { r = runOne(sc, cfg, controls); }
    catch (err) { r = { sc, error: err.message }; }
    if (r.error) failed.push(r); else out.push(r);
  }
  if (!out.length) return { options: [], failed };

  const ranked = C.score(out, cfg.criteriaWeights);
  const front = C.pareto(out);
  const frontIds = new Set(front.map(o => o.sc.id));
  const lo = ranked[0].score, hi = ranked[ranked.length-1].score;
  out.forEach(o => {
    o.colour = rampColour(hi > lo ? (o.score - lo) / (hi - lo) : 0);
    o.onFront = frontIds.has(o.sc.id);
  });
  return { options: out, ranked, front, failed };
}

global.STUDY = { run, runOne, evaluatePath, evaluateReference, scenarios, PRIORITIES, rampColour, applyPriority };
})(window);
