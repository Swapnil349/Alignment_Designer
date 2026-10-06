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
                                                      water_body: 1.8, farmland: 1.5,
                                                      mangrove: 2.6, wetland: 2.2, crz: 1.8 } },
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

/* ---------------------------------------------------- VERTICAL POLICY --- */
/* A control point can say three things about the vertical design:
     leg    'ground' | 'elevated' | 'tunnel' — what the line does from here to
            the next control point (blank: the standard's default policy);
     level  a rail level fixed here (a station platform, a portal);
     depth  rail this far below the ground here (an underground station).
   A fixed level is a deliberate design input, so unlike an ordinary station
   (invariant 3) it IS pinned — and reported with the tie errors. */
function hasTunnelLegs(controls) { return controls.some(c => c.leg === 'tunnel'); }

/** Bored-tunnel legs pay little for what lies on the surface above them. */
const TUNNEL_SURFACE = 0.12;
function tunnelWeights(w) {
  const out = Object.assign({}, w);
  for (const k of E.COVERAGE_KEYS) if (k !== 'exclusion' && out[k]) out[k] *= TUNNEL_SURFACE;
  for (const k of ['slope', 'terrGrade', 'terrUndul']) if (out[k]) out[k] *= TUNNEL_SURFACE;
  return out;
}

/**
 * The policy spec and tie points for one alignment. Returns { policy, tie,
 * ground } — policy is null when the line simply follows the ground, and the
 * fitter then runs exactly as it always has.
 *   ctx.given     Float64Array of fixed design levels per sample (NaN = free)
 *   ctx.legAt     per-sample leg override (an existing design's structures)
 */
function buildPolicy(P, chn, controls, std, ctx) {
  const n = P.length;
  const vpo = std.vpolicy || { mode: 'ground' };
  const defLeg = vpo.mode === 'elevated' ? 'elevated' : 'ground';
  const ground = new Float64Array(n);
  for (let i = 0; i < n; i++) ground[i] = E.sampleBilinear('dem', P[i].E, P[i].N);

  const leg = new Array(n);
  if (ctx.legAt) {
    for (let i = 0; i < n; i++) leg[i] = ctx.legAt[i] || defLeg;
  } else {
    let order = chn.map((c, k) => ({ s: c.s, k })).sort((a, b) => a.s - b.s);
    // on an open route the last point opens no leg: the samples at and past it
    // belong to the leg that arrives there (it used to tie a tunnel's end to
    // the default level — 7 m out in review)
    if (!ctx.closed && order.length > 1) order = order.slice(0, -1);
    let j = 0;
    for (let i = 0; i < n; i++) {
      while (j + 1 < order.length && order[j + 1].s <= P[i].s) j++;
      const c = order.length ? controls[order[j].k] : null;
      const L = c && c.leg && c.leg !== 'auto' ? c.leg : defLeg;
      leg[i] = L;
    }
  }

  // levels fixed at control points
  const pinAt = new Float64Array(n).fill(NaN);
  const tie = [];
  chn.forEach((c, k) => {
    const cp = controls[k];
    if (!cp || cp.synthetic) return;
    const hasLevel = cp.level !== undefined && cp.level !== null && cp.level !== '' && isFinite(+cp.level);
    const hasDepth = cp.depth !== undefined && cp.depth !== null && cp.depth !== '' && isFinite(+cp.depth);
    if (!hasLevel && !hasDepth) return;
    // an existing design's given level wins over anything fixed on top of it
    if (ctx.given && isFinite(ctx.given[c.idx])) return;
    const lvl = hasLevel ? +cp.level : ground[c.idx] - (+cp.depth);
    pinAt[c.idx] = lvl;
    tie.push({ idx: c.idx, level: lvl, fixed: true, name: cp.name });
  });
  /* What must sit on existing ground: the two ends of an open route, because
     that is where it ties into the network that already exists. Nothing else.
     (An end with a fixed level keeps that level; an elevated or underground
     end ties at the policy's level there, not at the ground.)

     Intermediate stations are deliberately NOT pinned. A platform has to be at
     the DESIGN level, not at the level the ground happens to be — stations on
     embankment and in cutting are entirely normal. Pinning them all was tried,
     and on the 17-station London circuit it over-constrained the profile so
     badly that the vertical radius collapsed from 67 km to 208 m: the fitter was
     being asked to touch seventeen fixed points and hold a 67 km vertical curve
     between them, and no such profile exists. Their cut and fill is reported
     instead, which is the number a designer actually needs to see. */
  // sparse levels published for an existing design (a portal, a shaft depth)
  if (ctx.extraPinsFn) for (const p of ctx.extraPinsFn(P, ground)) {
    if (!isFinite(p.level) || p.idx < 0) continue;
    if (ctx.given && isFinite(ctx.given[p.idx])) continue;      // given wins (invariant 10)
    pinAt[p.idx] = p.level;
    tie.push({ idx: p.idx, level: p.level, fixed: true, name: p.name });
  }
  if (!(ctx.cfg.tieControls === false || ctx.closed)) {
    const pr0 = Object.assign({ depth: 30, rampGrade: (std.maxGrade || 2) * 0.8 }, vpo, ctx.policyParams || {});
    for (const c of [chn[0], chn[chn.length - 1]]) {
      if (!c || c.node.synthetic || isFinite(pinAt[c.idx])) continue;
      const g = ctx.given && isFinite(ctx.given[c.idx]) ? ctx.given[c.idx] : undefined;
      if (g !== undefined) { tie.push({ idx: c.idx, level: g }); continue; }
      /* An end inside a tunnel too short to reach its cover is a PORTAL, at
         ground: MAHSR C-4 begins 50 m inside MT-08, and tying that end 30 m
         down sent a ramp 2 km into the viaduct beyond (found in review). */
      if (leg[c.idx] === 'tunnel') {
        const dir = c.idx < n / 2 ? 1 : -1;
        let k = c.idx; while (k + dir >= 0 && k + dir < n && leg[k + dir] === 'tunnel') k += dir;
        const runM = Math.abs(k - c.idx) * (P[1] ? P[1].s - P[0].s : 25);
        if (runM < pr0.depth / (pr0.rampGrade / 100)) { tie.push({ idx: c.idx, level: ground[c.idx] }); continue; }
      }
      tie.push({ idx: c.idx });
    }
  }

  const water = E.has('water_body') ? new Float64Array(n) : null;
  if (water) for (let i = 0; i < n; i++) water[i] = E.sample('water_body', P[i].E, P[i].N);
  const params = Object.assign({ clearMin: 8, clearTyp: 11.5, depth: 30, waterDepth: 6,
                                 rampGrade: (std.maxGrade || 2) * 0.8 }, vpo, ctx.policyParams || {});
  params.rampR = Math.max(std.vCrestR || 0, std.vSagR || 0);
  const policy = E.policyFor(P, ground, { leg, params, given: ctx.given || null, water, pinAt,
                                          closed: !!ctx.closed });
  /* The search can end a few samples past the terminus (its terminal
     offset). The policy has nothing to say about that stub, and holding it
     to a viaduct clearance put a corner exactly on the end tie — so beyond
     the end control points of an open route the bounds are released. */
  if (policy && !ctx.closed && chn.length >= 2) {
    const ia = Math.min(chn[0].idx, chn[chn.length - 1].idx), ib = Math.max(chn[0].idx, chn[chn.length - 1].idx);
    for (let i = 0; i < n; i++) {
      if (i >= ia && i <= ib) continue;
      if (ctx.given && isFinite(ctx.given[i])) continue;
      policy.lo[i] = -Infinity; policy.hi[i] = Infinity;
      policy.target[i] = policy.target[i < ia ? ia : ib];
    }
  }
  return { policy, tie, ground };
}

/** What the policy achieved: the numbers a designer checks first — the least
    clearance on the viaducts, the least cover in the tunnels, and how much of
    the line could NOT be held to its policy (reported, never hidden). */
function summarisePolicy(P, vp, pol) {
  if (!pol) return null;
  const n = P.length, ds = vp.ds;
  let eMin = Infinity, eSum = 0, eN = 0, tMin = Infinity, tMax = -Infinity, tN = 0, gN = 0;
  for (let i = 0; i < n; i++) {
    if (isFinite(pol.lo[i]) && pol.lo[i] === pol.hi[i]) { gN++; continue; }
    if (!isFinite(pol.lo[i]) && !isFinite(pol.hi[i])) continue;      // a ramp
    if (pol.leg[i] === 'elevated') {
      const c = vp.z[i] - vp.ground[i]; if (c < eMin) eMin = c; eSum += c; eN++;
    } else if (pol.leg[i] === 'tunnel') {
      const d = pol.surf[i] - vp.z[i]; if (d < tMin) tMin = d;
      const g = vp.ground[i] - vp.z[i]; if (g > tMax) tMax = g; tN++;
    }
  }
  return {
    params: pol.params,
    elevated: eN ? { km: eN * ds / 1000, minClear: eMin, meanClear: eSum / eN } : null,
    tunnel: tN ? { km: tN * ds / 1000, minCover: tMin, maxDepth: tMax } : null,
    givenKm: gN * ds / 1000,
    boundError: vp.boundError, boundShortKm: vp.boundShort / 1000,
    boundAt: vp.boundAt != null ? P[vp.boundAt].s : null,
    warnings: pol.warnings || [],
  };
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
function scenarios(cfg, controls) {
  const m = S.MODES[cfg.mode] || S.MODES.road;
  const tunnel = !!(controls && hasTunnelLegs(controls));
  const speeds = m.speeds;
  const at = speeds.indexOf(cfg.designSpeed);
  const i = at < 0 ? Math.floor(speeds.length / 2) : at;
  const slower = speeds[Math.max(0, i - 1)];
  const faster = speeds[Math.min(speeds.length - 1, i + 1)];
  const V = cfg.designSpeed;

  const list = [
    { id: 'A', name: 'Balanced',        priority: 'balanced',    V, offset: 0 },
  ];
  /* A line with bored legs gets the two questions every tunnel study asks:
     what does more cover cost, and what would crossing on a viaduct instead
     do (the alternative MAHSR's 2015 study rejected at Thane Creek — ALT2,
     7 km of creek and its mangroves affected). */
  if (tunnel) {
    list.push({ id: 'T', name: 'Tunnel deeper (+15 m cover)', priority: 'balanced', V, offset: 0, tunnelDepth: 15 });
    list.push({ id: 'V', name: 'Viaduct instead of tunnel',   priority: 'balanced', V, offset: 0, creekViaduct: true });
  }
  list.push(
    { id: 'B', name: 'Least cost',      priority: 'cheapest',    V, offset: 0 },
    { id: 'C', name: 'Shortest',        priority: 'shortest',    V, offset: 0 },
    { id: 'D', name: 'Environment led', priority: 'environment', V, offset: 0 },
    { id: 'E', name: 'Community led',   priority: 'community',   V, offset: 0 },
    { id: 'F', name: 'Terrain hugging', priority: 'terrain',     V, offset: 0 },
  );
  if (faster !== V)
    list.push({ id: 'G', name: `Higher speed ${faster}`, priority: 'balanced', V: faster, offset: 0 });
  if (slower !== V)
    list.push({ id: 'H', name: `Lower speed ${slower}`, priority: 'terrain', V: slower, offset: 0 });
  if (cfg.corridors !== false) {
    list.push({ id: 'J', name: 'Corridor — left',  priority: 'balanced', V, offset:  0.14 });
    list.push({ id: 'K', name: 'Corridor — right', priority: 'balanced', V, offset: -0.14 });
  }
  return list.slice(0, cfg.maxOptions || (tunnel ? 12 : 10));
}

/** Route and evaluate ONE option. Returns null with `.error` set on failure. */
function runOne(sc, cfg, controls) {
  const std = S.derive(cfg.mode, sc.V, cfg.params, cfg.useDesirable);
  /* Tunnel variants change the policy, not the standard: a deeper bore, or
     the creek crossed on a viaduct instead (the Thane Creek question). A leg
     out of an underground station stays bored in every variant — a viaduct
     cannot start 26 m under BKC. */
  // through policyParams, so it works in every mode — road and maglev carry
  // no vertical-policy parameters, and T came out identical to A there
  const policyParams = sc.tunnelDepth
    ? { depth: ((std.vpolicy && std.vpolicy.depth) || 30) + sc.tunnelDepth } : null;
  if (sc.creekViaduct) {
    const under = c => c && ((c.depth !== undefined && c.depth !== '' && +c.depth > 0));
    const m = controls.length;
    // the leg from k ends at k+1 — on a closed route the closing leg ends at 0
    const next = k => k + 1 < m ? controls[k + 1] : (cfg.closed ? controls[0] : null);
    controls = controls.map((c, k) => (c.leg === 'tunnel' && !under(c) && !under(next(k)))
      ? Object.assign({}, c, { leg: 'elevated' }) : c);
  }
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

  /* Per-leg weights for bored legs. The offset via splits a leg in two, so
     legs are matched to the control they start from by walking the list. */
  let legWeights = null;
  if (hasTunnelLegs(controls)) {
    const wt = tunnelWeights(w), owner = [];
    let last = null;
    for (const p of pts) { if (!p.synthetic) last = p; owner.push(last); }
    legWeights = k => (owner[k] && owner[k].leg === 'tunnel') ? wt : null;
  }
  const sr = E.searchChain(pts, w, null, { closed: cfg.closed, corridor: cfg.corridor, legWeights });
  if (!sr || sr.error)
    return { sc, std, error: (sr && sr.error) || 'no route', leg: sr && sr.leg };

  return evaluatePath(sr.pts, { sc, std, w, cfg, controls, used: pts, direct,
                                 search: sr, closed: cfg.closed, policyParams });
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
  // ties, and the vertical policy if there is one — see buildPolicy
  const given = ctx.givenFn ? ctx.givenFn(P) : null;
  const pb = buildPolicy(P, chn, controls, std, Object.assign({}, ctx, { given, legAt: ctx.legAtFn ? ctx.legAtFn(P) : null }));
  /* Levels an existing design fixes are honoured exactly, whatever the
     selected standard says — they are what was designed, and judging them is
     the point. So the fitter's own limits are opened just enough to admit
     them (and the given grades and radii are reported against the standard,
     not silently "corrected" towards it). */
  let wProf = w, givenStats = null;
  if (given) {
    givenStats = givenProfileStats(given, (P[P.length - 1].s - P[0].s) / Math.max(1, P.length - 1));
    /* Only the gradient is opened: the gradient clamp is global by nature.
       Vertical curves are not — the fitter leaves given samples out of its
       curvature pass, so the line it designs itself keeps the standard radius
       (opening it for the whole line was found in review to design the rest
       of C-4 at 19 km against 35.8 km). */
    if (givenStats.n > 2)
      wProf = Object.assign({}, w, {
        maxGrade: Math.max(w.maxGrade, givenStats.maxGrade * 1.001 + 0.001) });
  }
  const vp = E.verticalProfile(P, wProf, { tie: pb.tie, policy: pb.policy, ground: pb.ground });
  const t = E.structureThresholds(std);
  const declared = ctx.declaredFn ? ctx.declaredFn(P) : null;
  const structs = E.classifyStructures(P, vp, t, declared);
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
    ties: pb.tie, policy: summarisePolicy(P, vp, pb.policy), given, givenStats,
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
  /* A reference cut to a window (MAHSR S5: CH 333.6 – 393.7) can hold no
     station at all. Its two ends then stand in for them, so it still has a
     direct distance, end ties and a run time between its ends. */
  let stations = (ref.stations && ref.stations.length)
    ? ref.stations.map(st => ({ id: st.id, name: st.name, kind: st.kind, E: st.E, N: st.N }))
    : [];
  if (!ref.closed && raw.length > 1) {
    const a = raw[0], b = raw[raw.length - 1], near = (p, q) => Math.hypot(p.E - q.E, p.N - q.N) < 1000;
    const ch0r = +ref.chainage_start_m || 0, km = c => 'CH ' + (c / 1000).toFixed(3);
    if (!stations.some(st => near(st, a)))
      stations.unshift({ id: 'START', name: 'Start (' + km(ch0r) + ')', kind: 'terminal', E: a.E, N: a.N });
    if (!stations.some(st => near(st, b)))
      stations.push({ id: 'END', name: 'End (' + km(ch0r + (ref.length_m || 0)) + ')', kind: 'terminal', E: b.E, N: b.N });
  }
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

  /* What an existing design carries beyond its line (all optional, all in
     DESIGN chainage, which starts at ref.chainage_start_m — MAHSR C-4 starts
     at CH 157 000, measured from BKC):
       profile.points   given rail levels, dense         → fixed exactly
       profile.pins     sparse published levels / depths → tie points; the
                        policy (from the declared structures) fills between
       structures       what is built where              → structure types,
                        and the policy where no level is given
       ground           surveyed ground levels           → drawn on the long
                        section against the DEM                              */
  const ch0 = +ref.chainage_start_m || 0;
  const prof = ref.profile || {};
  const pts = Array.isArray(prof.points) && prof.points.length > 1
    ? prof.points.slice().sort((a, b) => a[0] - b[0]) : null;
  const givenFn = pts ? P => {
    const g = new Float64Array(P.length);
    for (let i = 0; i < P.length; i++) g[i] = interpTable(pts, ch0 + P[i].s, 1, 2500);
    return g;
  } : null;
  const decl = (ref.structures || []).filter(r => r && r.length >= 3)
    .map(r => ({ a: +r[0], b: +r[1], type: String(r[2]).toLowerCase(), label: r[3] || '' }))
    .sort((x, y) => x.a - y.a);
  const STRUCT_OF = { viaduct: E.STRUCT.VIADUCT, station: E.STRUCT.VIADUCT, bridge: E.STRUCT.BRIDGE,
                      tunnel: E.STRUCT.TUNNEL, embankment: E.STRUCT.EMBANKMENT,
                      cutting: E.STRUCT.CUTTING, atgrade: E.STRUCT.ATGRADE };
  const LEG_OF = { viaduct: 'elevated', station: 'elevated', bridge: 'elevated', tunnel: 'tunnel',
                   embankment: 'ground', cutting: 'ground', atgrade: 'ground' };
  const perSample = (P, map) => {
    const out = new Array(P.length).fill(null);
    let k = 0;
    for (let i = 0; i < P.length; i++) {
      const ch = ch0 + P[i].s;
      while (k < decl.length && decl[k].b <= ch) k++;
      if (k < decl.length && decl[k].a <= ch) out[i] = map[decl[k].type] || null;
    }
    return out;
  };
  const declaredFn = decl.length ? P => perSample(P, STRUCT_OF) : null;
  const legAtFn = decl.length ? P => perSample(P, LEG_OF) : null;
  const pins = Array.isArray(prof.pins) ? prof.pins : [];
  const extraPinsFn = pins.length ? (P, ground) => pins.map(p => {
    const idx = nearestIndex(P, (+p.ch) - ch0);
    if (idx < 0) return { level: NaN };
    // level if it is a number, else depth if that is; a pin with neither is skipped
    const L = p.level === null || p.level === undefined || p.level === '' ? NaN : +p.level;
    const D = p.depth === null || p.depth === undefined || p.depth === '' ? NaN : +p.depth;
    const level = isFinite(L) ? L : isFinite(D) ? ground[idx] - D : NaN;
    return { idx, level, name: p.name || '' };
  }) : null;

  const r = evaluatePath(raw, { sc, std, w, cfg, controls: stations, used: stations,
                                direct, search, closed: !!ref.closed,
                                givenFn, declaredFn, legAtFn, extraPinsFn });
  r.isReference = true;
  r.ch0 = ch0;
  r.refSparse = !pts && pins.length > 0;      // levels estimated from a few published points
  r.refNotes = ref.notes || [];
  r.calibration = ref.calibration || null;
  r.declared = decl.length > 0;
  if (pts && !r.given.some(isFinite))
    r.refNotes = r.refNotes.concat(['The profile points did not reach any sample of the line (spaced more ' +
      'than 2.5 km apart, or outside its chainage) — no levels are given; all are estimated.']);
  if (Array.isArray(ref.ground) && ref.ground.length > 1) {
    const num = v => v === null || v === undefined || v === '' ? NaN : +v;   // null is not 0 m
    const gpts = ref.ground.map(g => [num(g[0]), num(g[1])])
      .filter(g => isFinite(g[0]) && isFinite(g[1])).sort((a, b) => a[0] - b[0]);
    if (gpts.length > 1) {
      r.refGround = new Float64Array(r.P.length);
      for (let i = 0; i < r.P.length; i++) r.refGround[i] = interpTable(gpts, ch0 + r.P[i].s, 1, 120);
    }
  }
  return r;
}

/** Linear interpolation in a sorted [[x, y], ...] table; NaN outside it, and
    NaN across a gap wider than maxGap (no inventing levels between surveys). */
function interpTable(T, x, col, maxGap) {
  /* A metre's grace at either end: a window cut at CH 393 700 resamples to a
     last sample a few millimetres past it, and leaving that one sample to the
     policy put a 1.7 km "sag" on the end of MAHSR S5. */
  const a0 = T[0][0], a1 = T[T.length - 1][0];
  if (x < a0 - 1 || x > a1 + 1) return NaN;
  x = Math.min(a1, Math.max(a0, x));
  let lo = 0, hi = T.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m][0] <= x) lo = m; else hi = m; }
  const a = T[lo], b = T[hi], dx = b[0] - a[0];
  if (maxGap && dx > maxGap) return NaN;
  return dx > 0 ? a[col] + (b[col] - a[col]) * (x - a[0]) / dx : a[col];
}
function nearestIndex(P, s) {
  if (s < P[0].s - 50 || s > P[P.length - 1].s + 50) return -1;
  let lo = 0, hi = P.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (P[m].s < s) lo = m + 1; else hi = m; }
  if (lo > 0 && Math.abs(P[lo - 1].s - s) < Math.abs(P[lo].s - s)) lo--;
  return lo;
}

/** Steepest grade and tightest vertical curve of a given profile, measured
    only where three consecutive samples are all given. */
function givenProfileStats(g, ds) {
  let maxGrade = 0, minRv = Infinity, n = 0;
  // grade one-sided, pair by pair — the gradient clamp works on single steps,
  // and a central difference under-read a short steep interval (review)
  for (let i = 1; i < g.length; i++)
    if (isFinite(g[i - 1]) && isFinite(g[i])) {
      const gr = Math.abs(g[i] - g[i - 1]) / ds * 100;
      if (gr > maxGrade) maxGrade = gr;
    }
  for (let i = 1; i < g.length - 1; i++) {
    if (!isFinite(g[i - 1]) || !isFinite(g[i]) || !isFinite(g[i + 1])) continue;
    n++;
    const c = Math.abs(g[i - 1] - 2 * g[i] + g[i + 1]);
    if (c > 1e-9) { const rv = ds * ds / c; if (rv < minRv) minRv = rv; }
  }
  return { n, km: n * ds / 1000, maxGrade, minRv };
}

/**
 * Lay an existing design's levels under an option, for the long section: each
 * option sample takes the level of the nearest point of the existing line, if
 * the two are within `tol` metres of each other. Matching by chainage would be
 * wrong — two alignments of different length disagree on chainage everywhere
 * after their first difference. Where the lines part company there is nothing
 * to compare, and the trace stops.
 */
function overlayReference(opt, ref, tol) {
  const P = opt.P, RP = ref.P, n = P.length, m = RP.length, B = Math.max(tol, 250);
  const buckets = new Map();
  for (let j = 0; j < m; j++) {
    const key = Math.floor(RP[j].E / B) + ',' + Math.floor(RP[j].N / B);
    let a = buckets.get(key); if (!a) buckets.set(key, a = []); a.push(j);
  }
  const show = j => ref.refSparse || (ref.given && isFinite(ref.given[j]));
  const z = new Float64Array(n).fill(NaN), gl = ref.refGround ? new Float64Array(n).fill(NaN) : null;
  for (let i = 0; i < n; i++) {
    const bx = Math.floor(P[i].E / B), by = Math.floor(P[i].N / B);
    let best = -1, bd = tol * tol;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const a = buckets.get((bx + dx) + ',' + (by + dy));
      if (a) for (const j of a) {
        const d = (RP[j].E - P[i].E) ** 2 + (RP[j].N - P[i].N) ** 2;
        if (d < bd) { bd = d; best = j; }
      }
    }
    if (best < 0 || !show(best)) continue;
    z[i] = ref.vp.z[best];
    if (gl) gl[i] = ref.refGround[best];
  }
  opt.refProfile = z;
  opt.refGround = gl;
  opt.refLabel = ref.refSparse ? 'existing design (estimated from published levels)'
                               : 'existing design — rail level as designed';
}

/**
 * Generate the whole family. Yields to the event loop between options so the
 * progress readout actually paints — a 10-option study is 10 lattice searches
 * and can run for a minute on a large grid.
 */
async function run(controls, cfg, onProgress) {
  const list = scenarios(cfg, controls);
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

  /* The existing design, when the project carries one: evaluated once under
     the same standard and rates, laid under every option on the long section,
     and — if asked — ranked with them, so the line already chosen is argued
     on the same basis as its alternatives. */
  let refRes = null, refError = null;
  const ref = E.G.reference;
  const refLevels = !!(ref && ref.profile && ((ref.profile.points && ref.profile.points.length > 1) ||
                                              (ref.profile.pins && ref.profile.pins.length)));
  if (ref && (cfg.includeReference || (refLevels && cfg.overlayReference !== false))) {
    try { refRes = evaluateReference(ref, cfg); }
    catch (err) { refError = err.message; }
  }
  if (refRes) {
    if (refLevels) for (const o of out) overlayReference(o, refRes, cfg.overlayTol || 300);
    if (cfg.includeReference) out.push(refRes);
  }

  const ranked = C.score(out, cfg.criteriaWeights);
  const front = C.pareto(out);
  const frontIds = new Set(front.map(o => o.sc.id));
  const lo = ranked[0].score, hi = ranked[ranked.length-1].score;
  out.forEach(o => {
    o.colour = rampColour(hi > lo ? (o.score - lo) / (hi - lo) : 0);
    o.onFront = frontIds.has(o.sc.id);
  });
  return { options: out, ranked, front, failed, reference: refRes, refError };
}

global.STUDY = { run, runOne, evaluatePath, evaluateReference, overlayReference, scenarios,
                 PRIORITIES, rampColour, applyPriority, hasTunnelLegs };
})(window);
