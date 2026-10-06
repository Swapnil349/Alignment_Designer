/* ===========================================================================
   Alignment Designer v12 :: QUANTITIES, COST AND IMPACT

   Turns a geometric alignment into the numbers a corridor decision is actually
   made on: earthworks volumes, structure lengths, land take, capital cost, mass
   haul, and the environmental footprint by constraint class.

   Two principles the rest of the tool depends on:

   1. Earthworks are priced by VOLUME, not smeared into a per-kilometre rate.
      In rolling country the difference between two alignments is almost
      entirely cut and fill; a per-km rate cannot see that difference at all,
      which is precisely the comparison the tool exists to make.

   2. Every rate is exposed and editable. The defaults are order-of-magnitude
      benchmarks and are labelled as comparative. They rank alternatives against
      each other honestly; they are not an estimate, and the tool says so rather
      than implying a precision it does not have.
   =========================================================================== */
(function (global) {
'use strict';
const E = global.ENGINE;

/* Cross-sectional area of the earthworks prism at a given cut or fill height.
       A = W·h + m·h²      formation width W, side slopes 1V : mH
   The second term is the batter, and it is why a 20 m fill costs far more than
   twice a 10 m one — the reason alignments hunt for the contour. */
function prismArea(h, width, sideSlope) {
  const a = Math.abs(h);
  return width * a + sideSlope * a * a;
}

/**
 * Quantities and cost for one alignment.
 *
 * P        resampled alignment  [{E,N,s}]
 * vp       vertical profile from ENGINE.verticalProfile
 * structs  per-point structure classification
 * runs     structure runs
 * std      derived standard from STANDARDS.derive (carries width, rates)
 * opt      { rates, qrates, swell } overrides
 */
function evaluate(P, vp, structs, runs, std, opt) {
  opt = opt || {};
  const rates  = Object.assign({}, std.rates,  opt.rates  || {});
  const q      = Object.assign({}, std.qrates, opt.qrates || {});
  const swell  = opt.swell === undefined ? 0.90 : opt.swell;   // cut usable as fill
  const n = P.length, ds = vp.ds, L = P[n-1].s;
  const W = std.width, m = std.sideSlope;

  let cutM3 = 0, fillM3 = 0, maxCut = 0, maxFill = 0;
  let landM2 = 0, builtLandM2 = 0;
  const massHaul = new Float64Array(n);          // cumulative net volume, m³
  const byType = {};
  for (const k in E.STRUCT) byType[E.STRUCT[k].id] = { m: 0, cost: 0 };

  let running = 0;
  for (let i = 0; i < n; i++) {
    const id = structs[i].id;
    const d = vp.diff[i];                        // + fill, − cut
    byType[id].m += ds;

    let cut = 0, fill = 0, takeW = 0;
    if (id === 'cutting' || id === 'atgrade') {
      if (d < 0) cut = prismArea(d, W, m) * ds;
      else       fill = prismArea(d, W, m) * ds;
      takeW = W + 2 * m * Math.abs(d) + 6;       // + boundary fence/drainage
    } else if (id === 'embankment') {
      fill = prismArea(d, W, m) * ds;
      takeW = W + 2 * m * Math.abs(d) + 6;
    } else if (id === 'viaduct' || id === 'bridge') {
      takeW = W + 4;                             // piers and maintenance access
    } else if (id === 'tunnel') {
      takeW = 0;                                 // surface stays in use
    }
    cutM3 += cut; fillM3 += fill;
    if (-d > maxCut) maxCut = -d;
    if (d > maxFill) maxFill = d;

    const built = E.sample('built', P[i].E, P[i].N);
    landM2 += takeW * ds * (1 - built);
    builtLandM2 += takeW * ds * built;

    running += cut * swell - fill;
    massHaul[i] = running;
  }

  /* Haul: the area under the mass-haul curve is volume × distance, and that is
     what a haul rate is charged on. Balanced earthworks show as a curve that
     returns to zero; a curve that runs away means importing or dumping. */
  let haulM3km = 0;
  for (let i = 1; i < n; i++) haulM3km += Math.abs(massHaul[i]) * ds / 1000;
  haulM3km /= Math.max(1, n / 40);               // damp the discretisation

  // ── structure costs ──────────────────────────────────────────────────────
  const rateOf = id => id === 'tunnel'  ? rates.tunnel
                     : id === 'viaduct' ? rates.viaduct
                     : id === 'bridge'  ? rates.bridge
                     : rates.atGrade;
  let civils = 0;
  for (const id in byType) {
    byType[id].cost = byType[id].m / 1000 * rateOf(id);
    civils += byType[id].cost;
  }
  const portals = runs.filter(r => r.type.id === 'tunnel').length * 2;
  const portalCost = portals * q.portal;

  const earthCost = cutM3 * q.cutM3 + fillM3 * q.fillM3 + haulM3km * q.haulM3km;
  const landCost = landM2 * q.landM2 + builtLandM2 * q.landBuiltM2;

  const direct = civils + portalCost + earthCost + landCost;
  const total = direct * (q.structures || 1.0);

  // ── environmental footprint, by constraint class ─────────────────────────
  const impacts = {};
  for (const key of E.COVERAGE_KEYS) {
    if (!E.has(key)) continue;
    let m2 = 0, len = 0;
    for (let i = 0; i < n; i++) {
      if (structs[i].id === 'tunnel') continue;  // under it, not through it
      const c = E.sample(key, P[i].E, P[i].N);
      if (c > 0.05) { len += ds * c; m2 += c * ds * (W + 12); }
    }
    impacts[key] = { km: len / 1000, ha: m2 / 10000 };
  }
  const waterCrossings = runs.filter(r => r.type.id === 'bridge').length;

  return {
    length: L,
    earthworks: { cutM3, fillM3, netM3: cutM3 * swell - fillM3, haulM3km,
                  maxCut, maxFill, swell,
                  balance: fillM3 > 0 ? (cutM3 * swell) / fillM3 : Infinity },
    massHaul,
    byType, portals,
    cost: { civils, portals: portalCost, earthworks: earthCost, land: landCost,
            direct, total, currency: rates.currency || 'M',
            perKm: total / Math.max(0.001, L / 1000) },
    land: { m2: landM2, builtM2: builtLandM2, ha: (landM2 + builtLandM2) / 10000 },
    impacts, waterCrossings,
    rates, qrates: q,
  };
}

/* ------------------------------------------------------- MULTI-CRITERIA -- */
/* The criteria a corridor study is argued on. Each is normalised across the
   option set, so the score answers "how does this compare with the others",
   which is the only question a comparative cost model can honestly answer. */
const CRITERIA = [
  { key: 'cost',      label: 'Capital cost',     dir: 'min', weight: 30,
    get: r => r.q.cost.total,
    fmt: v => v.toFixed(0) + ' M' },
  { key: 'time',      label: 'Journey time',     dir: 'min', weight: 25,
    get: r => r.sp.total,
    fmt: v => (v/60).toFixed(1) + ' min' },
  { key: 'length',    label: 'Length',           dir: 'min', weight: 10,
    get: r => r.q.length,
    fmt: v => (v/1000).toFixed(1) + ' km' },
  { key: 'earthworks',label: 'Earthworks',       dir: 'min', weight: 12,
    get: r => r.q.earthworks.cutM3 + r.q.earthworks.fillM3,
    fmt: v => (v/1e6).toFixed(2) + ' Mm³' },
  { key: 'community', label: 'Settlement impact',dir: 'min', weight: 12,
    get: r => (r.q.impacts.built ? r.q.impacts.built.ha : 0) + r.q.land.builtM2/10000,
    fmt: v => v.toFixed(0) + ' ha' },
  /* Sensitive land the line occupies at the surface (tunnels are excluded
     where the footprint is measured). Mangrove counts in full — in India it
     is CRZ-IA and needs court leave to fell; other wetland and woodland at a
     discount; the coastal-zone proxy lightly, since it is regulated land,
     not necessarily habitat. Layers a project does not carry contribute 0, so
     older projects score exactly as before. */
  { key: 'environment',label:'Environmental land',dir: 'min', weight: 11,
    get: r => { const I = r.q.impacts, ha = k => (I[k] ? I[k].ha : 0);
                return ha('protected') + ha('woodland') * 0.6 + ha('mangrove')
                     + ha('wetland') * 0.6 + ha('crz') * 0.2; },
    fmt: v => v.toFixed(0) + ' ha' },
];

/** Normalise each criterion to 0 (best) .. 1 (worst) across the option set. */
function score(options, weights) {
  const W = Object.assign({}, weights || {});
  const active = CRITERIA.filter(c => (W[c.key] === undefined ? c.weight : W[c.key]) > 0);
  const wsum = active.reduce((s,c) => s + (W[c.key] === undefined ? c.weight : W[c.key]), 0) || 1;
  for (const c of CRITERIA) {
    const vals = options.map(o => c.get(o));
    const lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    const span = hi - lo;
    options.forEach((o, i) => {
      o.norm = o.norm || {};
      o.raw = o.raw || {};
      o.raw[c.key] = vals[i];
      o.norm[c.key] = span < 1e-9 ? 0 : (vals[i] - lo) / span;
    });
  }
  options.forEach(o => {
    let s = 0;
    for (const c of active) {
      const w = W[c.key] === undefined ? c.weight : W[c.key];
      s += w * o.norm[c.key];
    }
    o.score = s / wsum;                          // 0 best, 1 worst
    /* Settlement and protected-land impact are both hectares of surface
       footprint, so they add. Keeping them apart in the dominance test inflates
       the dimension count, and in four dimensions almost nothing dominates
       anything — the front came back with nine options out of ten, which tells
       a reader nothing at all. */
    o.raw.impact = o.raw.community + o.raw.environment;
  });
  return options.slice().sort((a, b) => a.score - b.score);
}

/** Pareto front: options nothing else beats on every criterion at once. */
const PARETO_KEYS = ['cost', 'time', 'impact'];
function pareto(options, keys) {
  keys = keys || PARETO_KEYS;
  const eps = 1e-9;
  return options.filter(o =>
    !options.some(p => p !== o
      && keys.every(k => p.raw[k] <= o.raw[k] * (1 + eps))
      && keys.some(k => p.raw[k] <  o.raw[k] * (1 - 1e-4))));
}

global.COSTS = { evaluate, score, pareto, CRITERIA, prismArea };
})(window);
