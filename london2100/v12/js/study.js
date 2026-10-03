/* ===========================================================================
   London 2100 — Rail Alignment Designer :: ALIGNMENT STUDY  (v2)

   Generates a FAMILY of alignments rather than one answer, after Trimble
   Quantm's approach: sweep the design space, present the alternatives, and let
   the planner see the trade-off surface before committing.

   Ranking follows the priority order set by the client, applied
   LEXICOGRAPHICALLY WITH TOLERANCE so that the order is genuinely respected
   rather than blended away in a weighted sum:

     1. minimum journey time
     2. minimum cost
     3. minimum disruption to existing topography  (earthworks volume)
     4. no disturbance to existing towns
     5. gradual gradient, not a roller-coaster     (total gradient variation)
     6. optimum speed is then DERIVED from whichever option wins
   =========================================================================== */
(function (global) {
'use strict';
const E = global.ENGINE;

/* ---------------------------------------------------------- speed → radius */
/* Maglev, guideway banked to the MbBO §13(3) maximum of 12°, evaluated at the
   ISO level-2 comfort limit of 0.63 m/s². Deliberately not conservative — the
   client asked for the fastest geometry that is still legal and comfortable.
        R = v²·cosθ / (a_q + g·sinθ)                                          */
function radiusForSpeed(v_kmh, thetaDeg, aq) {
  thetaDeg = thetaDeg === undefined ? 12.0 : thetaDeg;
  aq       = aq       === undefined ? 0.63 : aq;
  const v = v_kmh / 3.6, th = thetaDeg * Math.PI / 180;
  return v * v * Math.cos(th) / (aq + 9.81 * Math.sin(th));
}
/* The search stride must be long enough that one 5° heading bucket per step
   still yields R ≥ rMin, otherwise the guarantee cannot hold. */
function strideForRadius(rMin) {
  return Math.ceil(rMin * E.DB * 1.02 / 50) * 50;
}

/* ------------------------------------------------------------- cost model  */
/* £m per route km, 2019/20 price base, from DfT/PwC High Speed Rail
   International Benchmarking Study (Nov 2020) where tagged [S] in
   Research_HSR/DESIGN_STANDARDS.md §6.1; interpolations are [A].
   NB no escalation to a 2026 base is applied — the BCIS index is not in the
   project yet, so these are comparative, not absolute.                        */
const RATE = {
  atGrade: 6.0, viaduct: 31.0, tunnelBored: 36.0, tunnelCC: 28.0,
  embSlope: 1.2, cutSlope: 0.9,
  portal: 8.0, portalHood: 6.0, majorSpan: 4.0,
  landTunnel: 0.5, landViaduct: 0.8, landEmb: 2.0, landEmbBMV: 6.4,
  indirects: 1.18,
};

function costOf(P, vp, structs, runs) {
  const n = P.length, ds = vp.ds;
  let civils = 0, land = 0, lumps = 0;
  for (let i = 0; i < n; i++) {
    const h = vp.diff[i], a = Math.abs(h), km = ds / 1000;
    const s = structs[i].id;
    let r, l;
    if (s === 'tunnel')          { r = a > 20 ? RATE.tunnelBored : RATE.tunnelCC; l = RATE.landTunnel; }
    else if (s === 'viaduct' ||
             s === 'bridge')     { r = RATE.viaduct + (a > 15 ? 0.6 * (a - 15) : 0); l = RATE.landViaduct; }
    else if (s === 'embankment') { r = RATE.atGrade + RATE.embSlope * Math.max(0, a - 3);
                                   const g = E.sample('alc', P[i].E, P[i].N);
                                   l = (g === 1 || g === 2 || g === 3) ? RATE.landEmbBMV : RATE.landEmb; }
    else if (s === 'cutting')    { r = RATE.atGrade + RATE.cutSlope * Math.max(0, a - 3); l = RATE.landEmb; }
    else                         { r = RATE.atGrade; l = RATE.landEmb; }
    civils += r * km; land += l * km;
  }
  // lump sums: tunnel portals (with a vented hood above 600 km/h) and big spans
  for (const run of runs) {
    if (run.type.id === 'tunnel') lumps += 2 * RATE.portal;
    if (run.type.id === 'bridge' && (run.s1 - run.s0) > 60) lumps += RATE.majorSpan;
  }
  const total = (civils + land + lumps) * RATE.indirects;
  return { total, civils, land, lumps, perKm: total / (P[n-1].s / 1000) };
}

/* --------------------------------------------------------------- metrics   */
function metricsOf(P, vp, structs, runs, sp) {
  const n = P.length, ds = vp.ds, L = P[n-1].s;
  const W_T = 16.5, SIDE = 2.0;             // HS2 trace width [S], 1:2 side slopes [A]

  let earth = 0, town = 0, gradVar = 0, maxCut = 0, maxFill = 0, bmv = 0;
  for (let i = 0; i < n; i++) {
    const h = Math.abs(vp.diff[i]);
    const s = structs[i].id;
    // volume only where ground is actually moved
    if (s === 'embankment' || s === 'cutting' || s === 'atgrade')
      earth += (W_T * h + SIDE * h * h) * ds;
    if (vp.diff[i] < -maxCut)  maxCut  = -vp.diff[i];
    if (vp.diff[i] >  maxFill) maxFill =  vp.diff[i];
    // disturbance to existing settlement, discounted where we are in tunnel
    const b = E.sample('built', P[i].E, P[i].N);
    town += b * ds * (s === 'tunnel' ? 0.15 : 1.0);
    const g = E.sample('alc', P[i].E, P[i].N);
    if ((g === 1 || g === 2 || g === 3) && s !== 'tunnel' && s !== 'viaduct') bmv += ds;
    if (i > 0) gradVar += Math.abs(vp.grade[i] - vp.grade[i-1]);
  }
  const cost = costOf(P, vp, structs, runs);
  const byType = {};
  for (const s of structs) byType[s.id] = (byType[s.id] || 0) + ds;

  return {
    length: L, time: sp.total, avg: sp.avg, peak: sp.peak,
    cost: cost.total, costPerKm: cost.perKm, costParts: cost,
    earthworks: earth, earthPerKm: earth / (L/1000),
    town, bmv, gradVar, maxCut, maxFill,
    rms: Math.sqrt(vp.diff.reduce((s,d)=>s+d*d,0)/n),
    minRv: vp.minRv, byType,
    tunnelKm: (byType.tunnel||0)/1000, viaductKm: (byType.viaduct||0)/1000,
    hip: 0, vip: 0,
  };
}

/* ------------------------------------------------------------- scenarios   */
/* Twelve variants spanning the design space. Speed is swept across the full
   500–750 band the client asked for, plus four emphasis variants at a mid
   speed so the environmental trade-offs are visible too.                      */
function scenarios(baseW) {
  const B = k => Object.assign({}, baseW, k);
  const spd = v => { const r = radiusForSpeed(v); return { rMin: Math.round(r), stride: strideForRadius(r) }; };
  const S = [];
  const add = (id, name, v, extra, note) =>
    S.push({ id, name, speed: v, note, w: B(Object.assign({}, spd(v), extra || {})) });

  add('A', 'Direct 750',        750, { builtUp: 30, aonb: 25, woodland: 10, terrGrade: 4,  terrUndul: 1.0, turn: 30 }, 'fastest geometry, weak constraints');
  add('B', 'Balanced 750',      750, {}, 'full weights at maximum speed');
  add('C', 'Balanced 700',      700, {}, '');
  add('D', 'Balanced 650',      650, {}, '');
  add('E', 'Balanced 600',      600, {}, '');
  add('F', 'Balanced 550',      550, {}, '');
  add('G', 'Balanced 500',      500, {}, 'tightest radius, most manoeuvrable');
  add('H', 'Terrain-led 600',   600, { terrGrade: 45, terrUndul: 10, slope: 12 }, 'follows landform hard');
  add('I', 'Settlement-averse 600', 600, { builtUp: 130, aonb: 90 }, 'maximum standoff from towns');
  add('J', 'Farmland-first 600',600, { alcBMV: 32, woodland: 40 }, 'protects BMV land');
  add('K', 'Low-earthworks 550',550, { terrGrade: 60, terrUndul: 16, turn: 25 }, 'minimises cut and fill');
  add('L', 'Low-structure 500', 500, { terrGrade: 50, terrUndul: 12, flood: 30 }, 'fewest tunnels and viaducts');
  return S;
}

/* ------------------------------------------------------------- the study   */
async function run(a, b, baseW, opts, onProgress) {
  const list = scenarios(baseW), out = [];
  for (let i = 0; i < list.length; i++) {
    const sc = list[i];
    if (onProgress) onProgress(i, list.length, sc.name);
    await new Promise(r => setTimeout(r, 0));          // let the UI breathe
    let res = null;
    try {
      const sr = E.search({E:a.E,N:a.N}, {E:b.E,N:b.N}, sc.w);
      if (sr) {
        const P  = E.resample(sr.pts, 25);
        const R  = E.curvature(P, 8);
        const vp = E.verticalProfile(P, sc.w);
        const st = E.classifyStructures(P, vp, E.DEFAULT_T);
        const rn = E.structureRuns(P, st);
        const o  = Object.assign({}, opts, { vmax: sc.speed });
        const sp = E.speedProfile(P, R, o);
        const m  = metricsOf(P, vp, st, rn, sp);
        // geometric complexity, in Quantm's language
        let hip = 0; for (let k = 1; k < sr.states; k++) hip++;
        m.hip = countTurns(P, R);
        m.vip = countGradeChanges(vp);
        res = { sc, P, R, vp, structs: st, runs: rn, sp, m, w: sc.w, opts: o, search: sr };
      }
    } catch (err) { console.warn('scenario', sc.id, 'failed:', err.message); }
    out.push(res);
  }
  return out.filter(Boolean);
}

function countTurns(P, R) {
  let n = 0, prev = 0;
  for (let i = 0; i < R.length; i++) {
    const s = isFinite(R[i]) && Math.abs(R[i]) < 5e5 ? Math.sign(R[i]) : 0;
    if (s !== 0 && s !== prev) { n++; prev = s; }
    if (s === 0) prev = 0;
  }
  return n;
}
function countGradeChanges(vp) {
  let n = 0, prev = 0;
  for (let i = 1; i < vp.grade.length; i++) {
    const s = Math.abs(vp.grade[i]) < 0.05 ? 0 : Math.sign(vp.grade[i]);
    if (s !== 0 && s !== prev) { n++; prev = s; }
  }
  return n;
}

/* -------------------------------------------------------------- ranking    */
/* Lexicographic with tolerance. Criteria are applied in the client's stated
   order; at each step every option within `tol` of the best on that criterion
   survives to be judged on the next. This respects the ordering — a weighted
   sum would let a big win on priority 5 overturn priority 1, which is not what
   "in order of priority" means.                                               */
const CRITERIA = [
  { key: 'time',       label: 'Journey time',            tol: 0.06, fmt: v => (v/60).toFixed(2)+' min' },
  { key: 'cost',       label: 'Cost',                    tol: 0.08, fmt: v => '£'+v.toFixed(0)+'m' },
  { key: 'earthworks', label: 'Topographic disruption',  tol: 0.15, fmt: v => (v/1e6).toFixed(2)+' Mm³' },
  { key: 'town',       label: 'Settlement disturbance',  tol: 0.20, fmt: v => (v/1000).toFixed(2)+' km eq.' },
  { key: 'gradVar',    label: 'Gradient smoothness',     tol: 0.20, fmt: v => v.toFixed(1)+' %-var' },
];

function rank(results) {
  if (!results.length) return { winner: null, trace: [] };
  let pool = results.slice();
  const trace = [];
  for (const c of CRITERIA) {
    if (pool.length === 1) { trace.push({ c, note: 'single option remained', kept: pool.length }); break; }
    const vals = pool.map(r => r.m[c.key]);
    const best = Math.min.apply(null, vals);
    const cut  = best * (1 + c.tol);
    const next = pool.filter(r => r.m[c.key] <= cut);
    trace.push({ c, best, cut, before: pool.length, kept: next.length,
                 eliminated: pool.filter(r => r.m[c.key] > cut).map(r => r.sc.id) });
    pool = next.length ? next : pool;
  }
  // tie-break on the first criterion
  pool.sort((x, y) => x.m.time - y.m.time);
  return { winner: pool[0], shortlist: pool, trace };
}

/* Colour ramp for the map and the table, best → worst, after Quantm. */
function rampColour(t) {
  const stops = [[0,'#1030b0'],[0.25,'#2f8fd0'],[0.5,'#2e9e4f'],[0.75,'#e08a1e'],[1,'#c62828']];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const a = stops[i-1], b = stops[i], f = (t-a[0])/(b[0]-a[0]);
      const hx = s => [parseInt(s.slice(1,3),16),parseInt(s.slice(3,5),16),parseInt(s.slice(5,7),16)];
      const A = hx(a[1]), B = hx(b[1]);
      return `rgb(${Math.round(A[0]+(B[0]-A[0])*f)},${Math.round(A[1]+(B[1]-A[1])*f)},${Math.round(A[2]+(B[2]-A[2])*f)})`;
    }
  }
  return '#c62828';
}

global.STUDY = { run, rank, scenarios, radiusForSpeed, strideForRadius,
                 metricsOf, costOf, rampColour, CRITERIA, RATE };
})(window);
