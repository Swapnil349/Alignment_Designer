/* ===========================================================================
   London 2100 — Rail Alignment Designer :: ENGINE
   Grid access · cost model · curvature-constrained search · horizontal geometry
   vertical alignment · structure selection · speed profile
   =========================================================================== */
(function (global) {
'use strict';

/* ---------------------------------------------------------------- GRID ---- */
const G = {};

/* Grids arrive base64(zlib). Inflate with the platform DecompressionStream so
   the app has no third-party dependency and still runs straight from file://. */
async function b64inflate(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (typeof DecompressionStream !== 'function')
    throw new Error('This browser lacks DecompressionStream. Use Chrome/Edge 80+, Firefox 113+ or Safari 16.4+.');
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function initGrid() {
  const D = global.GRID;
  Object.assign(G, {
    nx: D.nx, ny: D.ny, cell: D.cell,
    xmin: D.xmin, ymax: D.ymax, xmax: D.xmax, ymin: D.ymin,
    srcMpp: D.srcMpp, frameX0: D.frameX0, frameY0: D.frameY0,
    nodes: D.nodes, meta: D.meta, layer: {},
  });
  for (const k in D.layers) {
    const m = D.meta[k], raw = await b64inflate(D.layers[k]);
    let arr;
    if (m.type === 'u16') {
      const u = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
      arr = new Float32Array(u.length);
      for (let i = 0; i < u.length; i++) arr[i] = u[i] / m.scale + m.offset;
    } else if (k === 'alc') {
      arr = raw;                                   // keep class ids as uint8
    } else {
      arr = new Float32Array(raw.length);
      for (let i = 0; i < raw.length; i++) arr[i] = raw[i] / m.scale;
    }
    G.layer[k] = arr;
  }
  return G;
}

const idx = (ix, iy) => iy * G.nx + ix;
const e2ix = E => Math.floor((E - G.xmin) / G.cell);
const n2iy = N => Math.floor((G.ymax - N) / G.cell);
const inGrid = (ix, iy) => ix >= 0 && iy >= 0 && ix < G.nx && iy < G.ny;

function sample(name, E, N) {
  const ix = e2ix(E), iy = n2iy(N);
  if (!inGrid(ix, iy)) return 0;
  return G.layer[name][idx(ix, iy)];
}

/** Bilinear sample — used for the DEM so the vertical profile is smooth. */
function sampleBilinear(name, E, N) {
  const fx = (E - G.xmin) / G.cell - 0.5, fy = (G.ymax - N) / G.cell - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const A = G.layer[name];
  const gx = (x, y) => {
    const cx = Math.max(0, Math.min(G.nx - 1, x)), cy = Math.max(0, Math.min(G.ny - 1, y));
    return A[cy * G.nx + cx];
  };
  return (gx(x0, y0) * (1 - tx) + gx(x0 + 1, y0) * tx) * (1 - ty)
       + (gx(x0, y0 + 1) * (1 - tx) + gx(x0 + 1, y0 + 1) * tx) * ty;
}

/* ------------------------------------------------------------ COST MODEL -- */
/* Weights are multipliers on a base construction cost of 1.0 per metre of
   surface alignment. They are exposed in the UI so the sensitivity of the
   alignment to each constraint can be demonstrated, which is the point of the
   tool: the route is an argument, not an answer.                              */
/* Defaults follow Research_HSR/DESIGN_STANDARDS.md rev A. Technology basis is EMS
   maglev at 500 km/h operating / 600 km/h geometric — geometry cannot be retrofitted,
   so it is set for the higher speed. */
const DEFAULT_W = {
  /* Geometry is set by the TIGHTEST CORNER of the loop, not by the target speed.
     S4 turns 106 deg between legs of 26 and 31 km. At R = 15,903 m (750 km/h) that
     turn needs 29.5 km of arc and simply does not fit — the search cannot find a
     radius-compliant line and falls back to a kink. R = 8,552 m (550 km/h) needs
     16.3 km and fits. Line speed is then set by the LOCAL radius: the straights
     still run at 750 km/h, the corners are curve-limited. That is how real lines
     work — line speed varies, it is not one number. */
  rMin:        8552,   // m, 550 km/h geometry — the tightest corner (S4) permits no more
  stride:       800,   // m, search step — must satisfy stride/(1*DB) >= rMin
  maxGrade:      2.5,  // %, ruling gradient = 25 per mille (TSI INF); corridor demand is 4.3
  vCurveR:   126000,   // m, vertical curve radius, desirable at 600 km/h (limiting 87 000)
  builtUp:       55,   // settlement avoidance
  aonb:          40,   // AONB / National Landscape
  woodland:      22,   // woodland (proxy for Ancient Woodland — see README)
  flood:         10,   // floodplain (HAND proxy — see README)
  slope:          9,   // earthworks proxy, per % of ground slope
  river:         14,   // major watercourse crossing
  road:           6,   // major road crossing
  rail:           5,   // existing railway crossing
  alcBMV:         8,   // Best & Most Versatile farmland (ALC 1, 2, 3a)
  greenBelt:     -2,   // negative = mild preference (the city sits in the belt)
  turn:          55,   // fixed penalty per direction change (2 transition curves)
  london:       120,   // Greater London — effectively excluded
  /* DIRECTIONAL terrain cost. The point-slope penalty above cannot tell an
     alignment running along a contour from one driving straight up a hillside —
     they score identically. These two do, and they are what make the route seek
     valleys and cross ridges at their lowest saddle. */
  terrGrade:     14,   // per % of ground gradient ALONG the direction of travel
  terrUndul:      3,   // per metre of undulation a stiff profile cannot follow
  terrWindow:  1200,   // m of look-ahead/behind; the profile is stiff over ~2.5 km
};

/** Per-metre surface cost multiplier at a point. */
function cellCost(E, N, w) {
  const ix = e2ix(E), iy = n2iy(N);
  if (!inGrid(ix, iy)) return 1e6;
  const i = idx(ix, iy), L = G.layer;
  let c = 1;
  c += L.built[i]      * w.builtUp;
  c += L.aonb[i]       * w.aonb;
  c += L.woodland[i]   * w.woodland;
  c += L.flood_proxy[i]* w.flood;
  c += L.london[i]     * w.london;
  c += Math.min(L.slope[i], 25) * w.slope * 0.1;
  c += L.river_major[i]* w.river;
  c += L.water_body[i] * w.river * 0.8;
  c += L.road_major[i] * w.road;
  c += L.road_a[i]     * w.road * 0.45;
  c += L.rail[i]       * w.rail;
  const g = L.alc[i];
  if (g === 1 || g === 2 || g === 3) c += w.alcBMV;      // BMV land, NPPF
  c += L.greenbelt[i]  * w.greenBelt;
  return Math.max(0.05, c);
}

/* --------------------------------------------- CURVATURE-CONSTRAINED A* --- */
/* A state-lattice search. State = (position, heading bucket). Each move
   advances one stride along a circular arc whose radius is stride/dTheta.
   By restricting the per-step heading change to the largest whole number of
   buckets satisfying stride/(k*dBucket) >= rMin, EVERY path the search can
   produce is radius-compliant by construction. There is no post-hoc smoothing
   that might violate the constraint.                                          */
const NH = 72;                       // heading buckets, 5 deg each
const DB = 2 * Math.PI / NH;

function arcStep(x, y, th, dth, L) {
  if (Math.abs(dth) < 1e-9) return [x + L * Math.cos(th), y + L * Math.sin(th), th];
  const R = L / dth;                                   // signed
  const cx = x - R * Math.sin(th), cy = y + R * Math.cos(th);
  const t2 = th + dth;
  return [cx + R * Math.sin(t2), cy - R * Math.cos(t2), t2];
}

/* Cost of the GROUND along the direction of travel.
   Samples the DEM over a window longer than the step, because the vertical
   profile is stiff over ~2.5 km, fits the best straight grade, and charges for
     (a) the along-track gradient — pushes the route into valleys and makes ridge
         crossings seek the lowest col
     (b) the RMS residual about that grade — the undulation a stiff profile
         cannot follow, which is the cut and fill it will cost                  */
function stepTerrainCost(x, y, th, dth, L, w) {
  const ext = w.terrWindow || 1200, N = 9;
  const [ex, ey, eth] = arcStep(x, y, th, dth, L);
  let st = 0, stt = 0, sz = 0, stz = 0;
  const ts = new Array(N), zs = new Array(N);
  for (let i = 0; i < N; i++) {
    const t = -ext + (L + 2*ext) * i / (N - 1);
    let px, py;
    if (t < 0)      { px = x + t*Math.cos(th);        py = y + t*Math.sin(th); }
    else if (t > L) { px = ex + (t-L)*Math.cos(eth);  py = ey + (t-L)*Math.sin(eth); }
    else            { const p = arcStep(x, y, th, dth*(t/L), t); px = p[0]; py = p[1]; }
    const z = sampleBilinear('dem', px, py);
    ts[i] = t; zs[i] = z;
    st += t; stt += t*t; sz += z; stz += t*z;
  }
  const den = N*stt - st*st;
  const b1 = Math.abs(den) < 1e-9 ? 0 : (N*stz - st*sz) / den;
  const b0 = (sz - b1*st) / N;
  let resid = 0;
  for (let i = 0; i < N; i++) { const d = zs[i] - (b0 + b1*ts[i]); resid += d*d; }
  return (w.terrGrade || 0) * Math.abs(b1) * 100 + (w.terrUndul || 0) * Math.sqrt(resid/N);
}

/* opt = { seedHeading, exitToward, exitCone }
     seedHeading  bucket index the leg MUST start on — this is what makes a chain
                  continuous. Solving legs independently and butting them together
                  puts a kink at every intermediate node, which is the same class
                  of error as the terminal chord.
     exitToward   {E,N} of the node AFTER b. The leg may only finish on a heading
                  within exitCone of the bearing b→that node, so it arrives at the
                  station already pointing the right way for the next leg.        */
function search(a, b, w, onProgress, opt) {
  opt = opt || {};
  const stride = w.stride;
  const maxBuckets = Math.max(1, Math.floor(stride / w.rMin / DB));
  const rAchievable = stride / (maxBuckets * DB);

  // corridor-local lattice
  const margin = Math.max(9000, Math.hypot(b.E - a.E, b.N - a.N) * 0.30);
  const X0 = Math.min(a.E, b.E) - margin, X1 = Math.max(a.E, b.E) + margin;
  const Y0 = Math.min(a.N, b.N) - margin, Y1 = Math.max(a.N, b.N) + margin;
  const res = stride / 2;
  const W = Math.ceil((X1 - X0) / res), H = Math.ceil((Y1 - Y0) / res);

  /* State = (cell, heading, last turn direction). The last-turn dimension exists
     so a left arc cannot run straight into a right arc: reverse curves must be
     separated by at least one straight step. Without it the alignment contains
     tangent-free reversals, which have no radius at the join and leave nowhere
     to put the transition curves. */
  const NT = 3;                       // 0 = left, 1 = straight, 2 = right
  const key = (x, y, h, lt) => {
    const ix = Math.floor((x - X0) / res), iy = Math.floor((y - Y0) / res);
    if (ix < 0 || iy < 0 || ix >= W || iy >= H) return -1;
    return ((iy * W + ix) * NH + h) * NT + lt;
  };

  const NS = W * H * NH * NT;
  if (NS > 24e6) throw new Error(
    `search space ${(NS/1e6).toFixed(1)}M states is too large — increase the stride`);
  const gS = new Float32Array(NS).fill(Infinity);
  const cameFrom = new Int32Array(NS).fill(-1);
  const stateX = new Float32Array(NS), stateY = new Float32Array(NS);

  // cheapest possible per-metre cost, for an admissible heuristic
  const hCost = 0.9;
  const heur = (x, y) => Math.hypot(b.E - x, b.N - y) * hCost;

  // binary heap
  const heap = { k: [], v: [] };
  function push(pri, st) {
    const k = heap.k, v = heap.v; k.push(pri); v.push(st);
    let i = k.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]]; i = p; }
  }
  function pop() {
    const k = heap.k, v = heap.v, top = v[0];
    const lk = k.pop(), lv = v.pop();
    if (k.length) { k[0] = lk; v[0] = lv; let i = 0;
      for (;;) { const l = 2*i+1, r = l+1; let s = i;
        if (l < k.length && k[l] < k[s]) s = l;
        if (r < k.length && k[r] < k[s]) s = r;
        if (s === i) break;
        [k[s], k[i]] = [k[i], k[s]]; [v[s], v[i]] = [v[i], v[s]]; i = s; } }
    return top;
  }

  // seed: allow any initial heading within +-50 deg of the bearing to the target
  const bearing = Math.atan2(b.N - a.N, b.E - a.E);
  if (opt.seedHeading !== undefined && opt.seedHeading !== null) {
    const h = ((opt.seedHeading % NH) + NH) % NH;
    const s = key(a.E, a.N, h, 1);
    if (s >= 0) { gS[s] = 0; stateX[s] = a.E; stateY[s] = a.N; push(heur(a.E, a.N), s); }
  } else {
    for (let h = 0; h < NH; h++) {
      let d = Math.abs(((h * DB - bearing + Math.PI * 3) % (2 * Math.PI)) - Math.PI);
      if (d > 0.9) continue;
      const s = key(a.E, a.N, h, 1);
      if (s < 0) continue;
      gS[s] = 0; stateX[s] = a.E; stateY[s] = a.N;
      push(heur(a.E, a.N), s);
    }
  }

  /* Arrival-heading gate, so the leg lines up with the one that follows.
     The target is the BISECTOR of the turn, not the outgoing bearing. A station on
     a curve is passed mid-turn; forcing the whole turn into the incoming leg made
     the search swing 106 km wide at S4 (+412%) to set up an approach it could not
     otherwise make. The cone widens with the turn so half of it can be completed
     after the station. */
  let exitB = null, exitCone = opt.exitCone === undefined ? 0.62 : opt.exitCone;
  if (opt.exitToward) {
    const inB  = Math.atan2(b.N - a.N, b.E - a.E);
    const outB = Math.atan2(opt.exitToward.N - b.N, opt.exitToward.E - b.E);
    let turn = outB - inB;
    while (turn >  Math.PI) turn -= 2*Math.PI;
    while (turn < -Math.PI) turn += 2*Math.PI;
    /* exitCenter 'full' arrives having absorbed the WHOLE turn — the chicane case,
       where the next node reverses the turn and any unfinished rotation at b is
       lateral offset the following leg cannot recover at the design radius.
       Default arrives on the bisector. exitCone < 0.5 disables the widening —
       it is the tight attempt, and widening it would defeat its purpose.       */
    exitB = inB + (opt.exitCenter === 'full' ? turn : turn/2);
    if (exitCone >= 0.5) exitCone = Math.max(exitCone, Math.abs(turn)/2 + 0.35);
  }
  const headingOK = h => {
    if (exitB === null) return true;
    const d = Math.abs(((h * DB - exitB + Math.PI * 3) % (2 * Math.PI)) - Math.PI);
    return d <= exitCone;
  };

  const goalR = stride * 0.5;
  let best = -1, expanded = 0;

  while (heap.v.length) {
    const s = pop();
    const x = stateX[s], y = stateY[s];
    const h = Math.floor(s / NT) % NH, lt = s % NT;
    if (++expanded > 6e6) break;
    if (Math.hypot(b.E - x, b.N - y) < goalR && headingOK(h)) { best = s; break; }
    const gc = gS[s];
    if (onProgress && (expanded & 16383) === 0) onProgress(expanded);

    for (let db = -maxBuckets; db <= maxBuckets; db++) {
      const lt2 = db === 0 ? 1 : (db > 0 ? 0 : 2);
      if (lt !== 1 && lt2 !== 1 && lt2 !== lt) continue;   // no direct L<->R reversal
      const dth = db * DB;
      const th = h * DB;
      const [nx2, ny2, th2] = arcStep(x, y, th, dth, stride);
      const h2 = ((Math.round(th2 / DB) % NH) + NH) % NH;
      const s2 = key(nx2, ny2, h2, lt2);
      if (s2 < 0) continue;

      // integrate cost along the swept arc
      let acc = 0; const NSAMP = 7;
      for (let i = 1; i <= NSAMP; i++) {
        const f = i / NSAMP;
        const [sx, sy] = arcStep(x, y, th, dth * f, stride * f);
        acc += cellCost(sx, sy, w);
      }
      let step = (acc / NSAMP) * stride;
      step += stepTerrainCost(x, y, th, dth, stride, w) * stride * 0.01;
      if (db !== 0) step += w.turn * stride * 0.01 * Math.abs(db);

      const ng = gc + step;
      if (ng < gS[s2]) {
        gS[s2] = ng; cameFrom[s2] = s; stateX[s2] = nx2; stateY[s2] = ny2;
        push(ng + heur(nx2, ny2), s2);
      }
    }
  }

  if (best < 0) return null;

  // Walk back collecting states, then REGENERATE each arc. Storing only the arc
  // endpoints and joining them with straight lines would inject corners that the
  // search never actually proposed, and would break the radius guarantee.
  const chain = [];
  for (let s = best; s >= 0; s = cameFrom[s])
    chain.push({ x: stateX[s], y: stateY[s], h: Math.floor(s / NT) % NH });
  chain.reverse();

  const pts = [{ E: chain[0].x, N: chain[0].y }];
  for (let i = 1; i < chain.length; i++) {
    const p = chain[i-1], q = chain[i];
    let db = q.h - p.h;
    while (db >  NH/2) db -= NH;
    while (db < -NH/2) db += NH;
    const dth = db * DB, th = p.h * DB;
    const SUB = 28;                     // 25 m spacing — matches the resample step,
    for (let k = 1; k <= SUB; k++) {    // so the arc is not polygonised
      const f = k / SUB;
      const [ax, ay] = arcStep(p.x, p.y, th, dth * f, stride * f);
      pts.push({ E: ax, N: ay });
    }
  }
  /* The exact target is deliberately NOT appended. Joining the final lattice
     state to it with a straight chord injects a corner the search never proposed
     and destroys the radius guarantee — it measured 324 m against a guaranteed
     8021 m before this was removed. The alignment ends where the geometry
     arrives; the residual offset is reported and the station sits on the line. */
  const end = pts[pts.length - 1];
  const endGap = Math.hypot(end.E - b.E, end.N - b.N);
  const endHeading = chain[chain.length - 1].h;
  return { pts, expanded, rAchievable, maxBuckets, states: chain.length, endGap, endHeading };
}

/* ------------------------------------------------------- CHAIN ROUTING --- */
/* Route a sequence of nodes as ONE continuous railway.

   Two things make this more than "solve each leg and join them up":

   (a) HEADING CONTINUITY. The arrival heading at an intermediate node is forced
       to be the departure heading of the next leg. Independent legs butt
       together at an arbitrary angle, which is a kink at a station — exactly
       the defect the terminal-chord fix removed at the ends.

   (b) LOOK-AHEAD. Each leg may only finish on a heading within a cone of the
       bearing to the node AFTER next, so it arrives already pointing usefully.
       Without it the search is greedy: leg k takes the cheapest line to node
       k+1 and strands leg k+1 facing the wrong way.

   It is still sequential, so it is not globally optimal over the whole chain.
   A single search carrying a waypoint index in the state would be — but for a
   5-node chain that is ~29M states, well past the memory budget. Stated here
   rather than hidden.                                                        */
/* Belt and braces. The lattice guarantees R >= rAchievable BY CONSTRUCTION, so this
   can only fire if a joint between legs has reintroduced a corner. It exists because
   exactly that happened — silently — and shipped a 100 m radius to the screen. If it
   ever fires again the run fails loudly instead of drawing a curve no train can take.
   Measured over a ~400 m baseline; a 4-sample span at ~29 m spacing is too short to
   estimate a 9 km radius without numerical noise.                                  */
function auditRadius(pts, rAchievable) {
  if (pts.length < 40) return null;
  let sp = 0;
  for (let i = 1; i < 20; i++) sp += Math.hypot(pts[i].E-pts[i-1].E, pts[i].N-pts[i-1].N);
  sp /= 19;
  const span = Math.max(4, Math.round(400 / Math.max(sp, 1)));
  const R = curvature(pts, span);
  let minR = Infinity, at = 0, s = 0, sAt = 0;
  for (let i = 1; i < pts.length; i++) {
    s += Math.hypot(pts[i].E-pts[i-1].E, pts[i].N-pts[i-1].N);
    const r = Math.abs(R[i]);
    if (r < minR) { minR = r; at = i; sAt = s; }
  }
  return { minR, at, chainage: sAt, ok: minR >= rAchievable * 0.92 };
}

/* Signed turn a→b→c, wrapped to ±π. null when there is no look-ahead node. */
function turnAt(a, b, c) {
  if (!c) return null;
  const inB  = Math.atan2(b.N - a.N, b.E - a.E);
  const outB = Math.atan2(c.N - b.N, c.E - b.E);
  let t = outB - inB;
  while (t >  Math.PI) t -= 2*Math.PI;
  while (t < -Math.PI) t += 2*Math.PI;
  return t;
}
/* Sharp station turns (A3 Luton, S4): a greedy straight approach dumps the whole
   double-turn into the NEXT leg, where it cannot fit at the design radius — the
   A3→P2 leg ballooned to 88.8 km (+518%) exactly this way. So for turns between
   0.9 and 1.6 rad the FIRST attempt forces arrival on the turn bisector
   (cone 0.35), putting half the turn on the approach; wide cones remain fallback. */
function tightFirst(turn) { return turn !== null && Math.abs(turn) > 0.9 && Math.abs(turn) < 1.6; }

/* One leg of a chain/loop, with the full attempt ladder:
     1. chicane (this turn and the next reverse, both sharp): arrive having absorbed
        the WHOLE turn — cone 0.35 on the full-turn heading
     2. sharp turn: arrive ON the bisector — cone 0.35
     3. wide bisector cone 0.62, then 1.05, then seed-only
   Legs touching A3 (Luton) search at stride 500 → guaranteed R ≥ 5,730 m: the
   chicane is GEOMETRICALLY infeasible at R 9,167 (A3 sits 9.26 km off the S1–P2
   chord; the out-and-back needs ~26 km of longitudinal room where 23.4 exists),
   so the approach takes a local station-throat radius, ~450 km/h under the maglev
   bank formula — the HS2-into-Euston pattern.
   BALLOON GUARD: an attempt that "succeeds" at more than 1.6 × direct + 8 km is a
   geometric absurdity (measured 125.6 km on a 14.2 km leg), not a route — it falls
   through to the next rung; the least-bad candidate is kept only if every rung
   balloons. Every rung preserves the departure heading; there is NO free-heading
   fallback, a failure is returned as null and MUST be reported by the caller.   */
function routeLeg(a, fromNode, b, c, d, seed, w) {
  const wLeg = (fromNode.id === 'A3' || b.id === 'A3')
    ? Object.assign({}, w, { stride: 500 }) : w;
  const t1 = turnAt(a, b, c), t2 = (c && d) ? turnAt(b, c, d) : null;
  const opts = [];
  if (tightFirst(t1)) {
    if (t2 !== null && t1*t2 < 0 && Math.abs(t2) > 0.9)
      opts.push({ seedHeading: seed, exitToward: c, exitCone: 0.35, exitCenter: 'full' });
    opts.push({ seedHeading: seed, exitToward: c, exitCone: 0.35 });
  }
  opts.push({ seedHeading: seed, exitToward: c, exitCone: 0.62 });
  if (c) opts.push({ seedHeading: seed, exitToward: c, exitCone: 1.05 });
  opts.push({ seedHeading: seed });
  const direct = Math.hypot(b.E - a.E, b.N - a.N);
  let bestSr = null, bestL = Infinity;
  for (const o of opts) {
    const cand = search(a, {E:b.E,N:b.N}, wLeg, null, o);
    if (!cand) continue;
    let Lp = 0;
    for (let i = 1; i < cand.pts.length; i++)
      Lp += Math.hypot(cand.pts[i].E-cand.pts[i-1].E, cand.pts[i].N-cand.pts[i-1].N);
    if (Lp < bestL) { bestL = Lp; bestSr = cand; }
    if (Lp < direct*1.6 + 8000) return cand;
  }
  return bestSr;             // least-bad heading-continuous candidate, or null
}

function searchChain(nodes, w, onProgress) {
  const legs = [];
  let seed = null;
  /* Leg k must START where leg k-1 actually ARRIVED, not at the nominal node.
     A leg finishes within goalR (half a stride) of its target, so beginning the
     next leg at the node instead leaves a jump of up to ~475 m at every joint.
     Stitching across that gap reintroduced exactly the corner the terminal-chord
     fix removed — measured 140 m against a guaranteed 12,605 m. The station is
     sited on the alignment, as it already is at the ends.                      */
  let startAt = { E: nodes[0].E, N: nodes[0].N };
  for (let k = 0; k < nodes.length - 1; k++) {
    const a = startAt, b = nodes[k+1], c = nodes[k+2] || null, d = nodes[k+3] || null;
    if (onProgress) onProgress(k, nodes.length - 1, `${nodes[k].name} → ${b.name}`);
    const sr = routeLeg(a, nodes[k], b, c, d, seed, w);
    /* There is deliberately NO free-heading fallback in routeLeg. Dropping seedHeading
       lets the leg depart on any bearing, which puts a corner at the joint with the
       leg before it — measured 100 m radius against a guaranteed 9,167 m, produced
       silently, and varying run to run as different legs fell through. A leg that
       cannot be routed with heading continuity is a REPORTED failure, not a fudge. */
    if (!sr) return { error: 'no heading-continuous route',
                      leg: nodes[k].name + ' → ' + b.name, legIndex: k };
    sr.from = nodes[k]; sr.to = b;
    legs.push(sr);
    seed = sr.endHeading;
    const last = sr.pts[sr.pts.length - 1];
    startAt = { E: last.E, N: last.N };            // continuity of POSITION too
  }
  // stitch into one polyline, dropping the duplicated node point at each joint
  const pts = legs[0].pts.slice();
  for (let k = 1; k < legs.length; k++) pts.push.apply(pts, legs[k].pts.slice(1));
  /* Audit against the SMALLEST per-leg guarantee: the A3 approach legs run at a
     local R 5,730 by design, and holding them to the mainline 9,167 would fail a
     legitimate route. Anything below 0.92 × the local guarantee is still a kink. */
  const rGuar = Math.min.apply(null, legs.map(l => l.rAchievable));
  const audit = auditRadius(pts, rGuar);
  if (audit && !audit.ok)
    return { error: 'radius audit failed', minR: audit.minR,
             chainage: audit.chainage, rAchievable: rGuar };
  return { legs, pts, audit,
           expanded: legs.reduce((s,l)=>s+l.expanded,0),
           rAchievable: legs[0].rAchievable, maxBuckets: legs[0].maxBuckets,
           endGap: legs[legs.length-1].endGap,
           states: legs.reduce((s,l)=>s+l.states,0) };
}

/* Closed loop. Routed as a chain that returns to the first node, then re-routed a
   second time with the arrival heading fed back as the departure heading — so the
   seam at the start node is continuous in heading too, not just in position.
   Without that pass the loop has a kink exactly where it closes.               */
function searchLoop(nodes, w, onProgress, passes) {
  passes = passes || 2;
  const seq = nodes.concat([nodes[0]]);
  let seed = null, out = null, err = null;
  for (let pass = 0; pass < passes; pass++) {
    const legs = [];
    let startAt = { E: nodes[0].E, N: nodes[0].N };
    let h = seed;
    let ok = true;
    for (let k = 0; k < seq.length - 1; k++) {
      const b = seq[k+1], c = seq[k+2] || seq[1];      // wrap the look-ahead too
      const d = seq[k+3] || seq[(k+3) - (seq.length-1)];
      if (onProgress) onProgress(pass, passes, k, seq.length-1, `${seq[k].name} → ${b.name}`);
      const sr = routeLeg(startAt, seq[k], b, c, d, h, w);
      /* No free-heading fallback — see routeLeg. That fallback was what made the
         loop report a 100 m minimum radius on a 9,167 m guarantee.              */
      if (!sr) { ok = false;
                 err = { error: 'no heading-continuous route',
                         leg: seq[k].name + ' → ' + b.name, legIndex: k, pass: pass };
                 break; }
      sr.from = seq[k]; sr.to = b;
      legs.push(sr);
      h = sr.endHeading;
      const last = sr.pts[sr.pts.length-1];
      startAt = { E: last.E, N: last.N };
    }
    /* Do NOT quietly hand back the previous pass. Pass 1 leaves P1 on a free heading,
       so its seam is discontinuous by construction; returning it as if it were the
       finished article is how a kinked loop reached the screen looking successful. */
    if (!ok) return err;
    const pts = legs[0].pts.slice();
    for (let k = 1; k < legs.length; k++) pts.push.apply(pts, legs[k].pts.slice(1));
    const rGuar = Math.min.apply(null, legs.map(l => l.rAchievable));  // A3 legs: 5,730
    const audit = auditRadius(pts, rGuar);
    if (audit && !audit.ok)
      return { error: 'radius audit failed', minR: audit.minR,
               chainage: audit.chainage, rAchievable: rGuar, pass: pass };
    out = { legs, pts, loop: true, audit,
            expanded: legs.reduce((s,l)=>s+l.expanded,0),
            rAchievable: legs[0].rAchievable, maxBuckets: legs[0].maxBuckets,
            endGap: legs[legs.length-1].endGap,
            states: legs.reduce((s,l)=>s+l.states,0),
            seamHeading: [seed, h] };
    seed = h;                                          // feed the closure back
  }
  return out;
}

/* -------------------------------------------------- HORIZONTAL GEOMETRY --- */
/** Resample a polyline to a fixed chainage step. */
function resample(pts, step) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++)
    cum.push(cum[i-1] + Math.hypot(pts[i].E - pts[i-1].E, pts[i].N - pts[i-1].N));
  const total = cum[cum.length - 1];
  const out = [];
  let j = 0;
  for (let s = 0; s <= total; s += step) {
    while (j < cum.length - 2 && cum[j+1] < s) j++;
    const seg = cum[j+1] - cum[j];
    const f = seg > 1e-9 ? (s - cum[j]) / seg : 0;
    out.push({ E: pts[j].E + (pts[j+1].E - pts[j].E) * f,
               N: pts[j].N + (pts[j+1].N - pts[j].N) * f, s });
  }
  const last = pts[pts.length - 1];
  if (!out.length || total - out[out.length-1].s > 1e-6)
    out.push({ E: last.E, N: last.N, s: total });
  return out;
}

/** Signed radius at each station, from the circumscribed circle of a wide triangle. */
function curvature(P, span) {
  span = span || 4;
  const n = P.length, R = new Float32Array(n).fill(Infinity);
  for (let i = span; i < n - span; i++) {
    const a = P[i - span], b = P[i], c = P[i + span];
    const cross = (b.E - a.E) * (c.N - a.N) - (b.N - a.N) * (c.E - a.E);
    const A = Math.abs(cross) / 2;
    if (A < 1e-6) continue;
    const la = Math.hypot(b.E - a.E, b.N - a.N),
          lb = Math.hypot(c.E - b.E, c.N - b.N),
          lc = Math.hypot(c.E - a.E, c.N - a.N);
    R[i] = Math.sign(cross) * (la * lb * lc) / (4 * A);
  }
  for (let i = 0; i < span; i++) { R[i] = R[span]; R[n-1-i] = R[n-1-span]; }
  return R;
}

/** Transition (clothoid) length from the cant ramp-rate limit dD/dt <= 50 mm/s. */
function transitionLength(V_kmh, cant_mm) { return V_kmh * cant_mm / 180; }

/** Equilibrium cant, and the cant needed at a given radius and speed. */
function cantRequired(V_kmh, R_m) { return 11.8 * V_kmh * V_kmh / Math.max(1, R_m); }

/** Speed a curve permits for a given cant budget (wheel-on-rail). */
function curveSpeed(R_m, D_mm, I_mm) { return Math.sqrt(Math.abs(R_m) * (D_mm + I_mm) / 11.8); }

/* --- MAGLEV LATERAL COMFORT ------------------------------------------------
   Rigorous large-bank-angle form. The 11.8 V^2/(D+I) formula is still correct
   for maglev if fed D = 1500 sin(theta) and I = 1500 a_q / g, but it returns the
   exact result divided by cos(theta), i.e. conservative by +2.2% at 12 deg.
   For validation we want the exact value, so use this.
        a_q = v^2 cos(theta) / R  -  g sin(theta)          [Jiang et al. 2019]  */
const MAGLEV = {
  thetaMax:      12.0,   // deg, MbBO §13(3) normal maximum
  thetaPlatform:  3.4,   // deg, cap within 400 m of a platform
  aqPreferred:    0.49,  // m/s^2, CAHSR 0.05 g
  aqNormal:       0.63,  // m/s^2, top of ISO comfort level 2
  aqCeiling:      1.50,  // m/s^2, MbBO §13(5) legal ceiling
  cantExcess:    -0.65,  // m/s^2, limit in degraded (0.7 V) running
};
function lateralAccel(V_kmh, R_m, thetaDeg) {
  const v = V_kmh / 3.6, th = thetaDeg * Math.PI / 180;
  return v * v * Math.cos(th) / Math.abs(R_m) - 9.81 * Math.sin(th);
}
/** Highest speed a radius/bank pair supports at a given comfort target. */
function maglevSpeed(R_m, thetaDeg, aq) {
  const th = thetaDeg * Math.PI / 180;
  const v2 = (aq + 9.81 * Math.sin(th)) * Math.abs(R_m) / Math.cos(th);
  return Math.sqrt(Math.max(0, v2)) * 3.6;
}
/** Bank the curve for the GEOMETRIC design speed, targeting a_q = +0.30 m/s². */
function bankFor(V_kmh, R_m) {
  let lo = 0, hi = MAGLEV.thetaMax;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (lateralAccel(V_kmh, R_m, mid) > 0.30) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/* --------------------------------------------------- VERTICAL ALIGNMENT --- */
/* Fit a rail profile to the ground that (a) stays within the ruling gradient,
   (b) respects the vertical curve radius, and (c) minimises earthworks.
   Implemented as constrained smoothing: relax toward the local mean (which
   controls curvature) with a spring back to ground (which controls earthworks),
   then hard-clamp the gradient. Repeat to convergence.                        */
/* Gaussian smoother, truncated at 3 sigma, edge-clamped. */
function gaussSmooth(a, sigmaSamples) {
  const n = a.length;
  if (sigmaSamples < 0.05) return Float64Array.from(a);
  const r = Math.max(1, Math.ceil(3 * sigmaSamples));
  const k = new Float64Array(2*r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i*i) / (2*sigmaSamples*sigmaSamples));
    k[i+r] = v; sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = -r; j <= r; j++) {
      const idx = Math.max(0, Math.min(n - 1, i + j));
      acc += a[idx] * k[j+r];
    }
    out[i] = acc;
  }
  return out;
}

/** Tightest vertical curve radius present in a profile: Rv = ds^2 / max|z''|. */
function minVerticalRadius(z, ds) {
  let m = 0;
  for (let i = 1; i < z.length - 1; i++) {
    const c = Math.abs(z[i-1] - 2*z[i] + z[i+1]);
    if (c > m) m = c;
  }
  return m > 1e-12 ? ds*ds/m : Infinity;
}

function clampGrade(z, ds, maxGradePct) {
  const lim = maxGradePct / 100 * ds, n = z.length;
  for (let pass = 0; pass < 200; pass++) {
    let changed = false;
    for (let i = 1; i < n; i++) {
      const d = z[i] - z[i-1];
      if (Math.abs(d) > lim) { z[i] = z[i-1] + Math.sign(d)*lim; changed = true; }
    }
    for (let i = n - 2; i >= 0; i--) {
      const d = z[i] - z[i+1];
      if (Math.abs(d) > lim) { z[i] = z[i+1] + Math.sign(d)*lim; changed = true; }
    }
    if (!changed) break;
  }
  return z;
}

/* ---------------------------------------------------------------------------
   Fit the rail profile to the ground.

   The feasible set is  { |z''| <= ds^2/Rv }  AND  { |z'| <= ruling gradient },
   both convex. We want the profile inside that set which stays closest to the
   ground, because deviation from ground IS the earthworks bill.

   Method: binary-search a smoothing bandwidth until the curvature constraint is
   satisfied. Smoothing is monotone in sigma, so the search is guaranteed to land
   on the constraint boundary — the FLATTEST profile is not what we want, the
   flattest-that-is-legal is.

   NB the previous implementation relaxed toward the local mean with a spring
   back to ground (pull = 0.06). At equilibrium that is z'' = (2*pull/ds^2)(z-g),
   a spring of characteristic length ds/sqrt(2*pull) = 72 m — so the rail tracked
   every terrain bump, and the curvature clamp that followed was undone by the
   next spring step. Achieved radius was 700 m against a 126,000 m target.
   The constraint must be solved for, not clamped afterwards.
--------------------------------------------------------------------------- */
function verticalProfile(P, w) {
  const n = P.length;
  const ds = n > 1 ? (P[n-1].s - P[0].s) / (n - 1) : 1;
  const ground = new Float64Array(n);
  for (let i = 0; i < n; i++) ground[i] = sampleBilinear('dem', P[i].E, P[i].N);

  const trial = sig => clampGrade(gaussSmooth(ground, sig / ds), ds, w.maxGrade);
  let lo = ds, hi = 40000;
  if (minVerticalRadius(trial(hi), ds) < w.vCurveR) lo = hi;      // cannot satisfy: use flattest
  else for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (minVerticalRadius(trial(mid), ds) >= w.vCurveR) hi = mid; else lo = mid;
  }
  const sigma = hi;
  const z = trial(sigma);

  const grade = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) grade[i] = (z[i+1] - z[i-1]) / (2*ds) * 100;
  grade[0] = grade[1]; grade[n-1] = grade[n-2];

  const diff = new Float64Array(n);
  for (let i = 0; i < n; i++) diff[i] = z[i] - ground[i];   // + = fill, - = cut

  return { z, ground, grade, diff, ds, sigma, minRv: minVerticalRadius(z, ds) };
}

/* -------------------------------------------------- STRUCTURE SELECTION --- */
/* Colour language per the design brief: everything BELOW ground in reds (tunnel
   dark, cutting light), everything ABOVE ground in blues (viaduct dark, bridge
   medium, embankment light), at-grade neutral grey-green — so the above-ground
   segments that will shape the city read at a glance.                          */
const STRUCT = {
  TUNNEL:     { id: 'tunnel',     label: 'Tunnel',      colour: '#8e2020' },
  CUTTING:    { id: 'cutting',    label: 'Cutting',     colour: '#d98880' },
  EMBANKMENT: { id: 'embankment', label: 'Embankment',  colour: '#85b8dc' },
  BRIDGE:     { id: 'bridge',     label: 'River bridge',colour: '#2e86c1' },
  VIADUCT:    { id: 'viaduct',    label: 'Viaduct',     colour: '#1a4e8a' },
  ATGRADE:    { id: 'atgrade',    label: 'At grade',    colour: '#6f7f6f' },
};

/* Thresholds. Sources and reasoning are documented in the presentation;
   they are exposed here so they can be challenged and varied.               */
const DEFAULT_T = {
  fillViaduct:   8,    // m of fill above which viaduct beats embankment
  cutTunnel:    15,    // m of cut below which tunnel beats open cutting
  builtTunnel:  0.18,  // settlement coverage forcing tunnel
  aonbTunnel:   0.50,  // AONB coverage forcing tunnel
  woodTunnel:   0.60,  // woodland coverage forcing tunnel
};

function classifyStructures(P, vp, t) {
  const n = P.length, out = new Array(n);
  for (let i = 0; i < n; i++) {
    const d = vp.diff[i];
    const built = sample('built', P[i].E, P[i].N);
    const aonb  = sample('aonb',  P[i].E, P[i].N);
    const wood  = sample('woodland', P[i].E, P[i].N);
    const river = sample('river_major', P[i].E, P[i].N) + sample('water_body', P[i].E, P[i].N);

    let s;
    if (built >= t.builtTunnel || aonb >= t.aonbTunnel || wood >= t.woodTunnel) s = STRUCT.TUNNEL;
    else if (-d >= t.cutTunnel) s = STRUCT.TUNNEL;
    else if (river > 0.05 && d > -2) s = STRUCT.BRIDGE;
    else if (d >= t.fillViaduct) s = STRUCT.VIADUCT;
    else if (d >= 1.5) s = STRUCT.EMBANKMENT;
    else if (d <= -1.5) s = STRUCT.CUTTING;
    else s = STRUCT.ATGRADE;
    out[i] = s;
  }
  // remove structures shorter than 200 m — real projects do not build 3 m of tunnel
  const minRun = Math.max(2, Math.round(200 / vp.ds));
  let i = 0;
  while (i < n) {
    let j = i; while (j < n && out[j] === out[i]) j++;
    if (j - i < minRun && i > 0) { for (let k = i; k < j; k++) out[k] = out[i-1]; }
    i = j;
  }
  return out;
}

function structureRuns(P, structs) {
  const runs = []; let i = 0;
  while (i < P.length) {
    let j = i; while (j < P.length && structs[j] === structs[i]) j++;
    runs.push({ type: structs[i], i0: i, i1: j - 1,
                s0: P[i].s, s1: P[Math.min(j - 1, P.length - 1)].s });
    i = j;
  }
  return runs;
}

/* --------------------------------------------------------- TRACK LAYOUT --- */
/* Where the loop needs to be four-track so a fast train can overtake a stopper.

   Sizing follows the STATION-LOOP philosophy, not full segregation. The stopper
   brakes and accelerates on the running line and the express passes during the
   DWELL; the four-track section is the station plus turnouts. Shinkansen passing
   loops are 2-3 km, not 25 km. Full segregation — keeping the stopper off the
   fast line through its whole brake-dwell-accelerate cycle — would need 30 km per
   location at 750 km/h, i.e. 39% of the loop four-tracked. The timetable does the
   work instead: the express needs ~68 s of separation when the stopper starts
   braking, which sits comfortably inside a 6 min headway.                       */
const TRACK = { PASSING_LEN: 5000, DEPOT_LEN: 3000 };

function trackLayout(P, nodeChn, passingIds, hubId) {
  const n = P.length, L = P[n-1].s;
  const tracks = new Uint8Array(n).fill(2);
  const zones = [];
  const mark = (s, len, kind, id) => {
    const a = s - len/2, b = s + len/2;
    for (let i = 0; i < n; i++) {
      let d = P[i].s;
      // wrap for a closed loop
      let inZone = (d >= a && d <= b) ||
                   (a < 0 && d >= a + L) || (b > L && d <= b - L);
      if (inZone) tracks[i] = 4;
    }
    zones.push({ id, kind, s: s, from: a, to: b, len });
  };
  for (const c of nodeChn) {
    if (passingIds.indexOf(c.node.id) >= 0) mark(c.s, TRACK.PASSING_LEN, 'passing', c.node.id);
    if (c.node.id === hubId)                mark(c.s, TRACK.DEPOT_LEN,   'hub',     c.node.id);
  }
  let four = 0;
  for (let i = 0; i < n; i++) if (tracks[i] === 4) four++;
  const ds = L / (n - 1);
  return { tracks, zones, fourKm: four*ds/1000, totalKm: L/1000,
           pct: four/n*100 };
}

/* ------------------------------------------------------- SPEED PROFILE --- */
/* Curve-limited speed, then a station-limited accel/brake envelope, then a
   forward/backward pass so the profile is kinematically achievable.          */
/* opts.stops : array of chainages (m) where the train must come to a stand.
   Without it the profile only zeroes at the two ends, which models one non-stop
   run — not a service calling at stations. Every intermediate stop costs a full
   brake-and-accelerate cycle, and that is the whole difference between an express
   and a stopping pattern.
   opts.dwell : seconds held at each intermediate stop.                          */
function speedProfile(P, R, opts) {
  const n = P.length, ds = P.length > 1 ? (P[n-1].s - P[0].s) / (n - 1) : 1;
  const vmax = opts.vmax / 3.6, a = opts.accel, b = opts.brake;
  const D = opts.cant, I = opts.cantDef;
  const L = P[n-1].s;

  const v = new Float64Array(n);
  /* Curve speed limit. The project is specified as EMS maglev, so use the maglev
     bank-angle form, NOT the wheel-rail cant formula — at R = 8,552 m the two
     differ by 11% (550 vs 489 km/h), which is the difference between meeting the
     design speed and missing it. Falls back to cant if opts.mode === 'rail'. */
  const useRail = opts.mode === 'rail';
  const th = (opts.bank === undefined ? MAGLEV.thetaMax : opts.bank) * Math.PI/180;
  const aq = opts.aq === undefined ? MAGLEV.aqNormal : opts.aq;
  for (let i = 0; i < n; i++) {
    const r = Math.abs(R[i]);
    let vCurve = Infinity;
    if (isFinite(r) && r > 1) {
      vCurve = useRail ? curveSpeed(r, D, I) / 3.6
                       : Math.sqrt(Math.max(0, (aq + 9.81*Math.sin(th)) * r / Math.cos(th)));
    }
    v[i] = Math.min(vmax, vCurve);
  }

  // pin every stop to zero, not just the ends
  const stops = (opts.stops && opts.stops.length) ? opts.stops.slice() : [0, L];
  if (stops[0] > 1) stops.unshift(0);
  if (stops[stops.length-1] < L - 1) stops.push(L);
  let stopIdx = stops.map(s => Math.max(0, Math.min(n-1, Math.round(s / ds))));
  /* Dedupe stops closer than 500 m — on a closed loop the origin station can be
     seen at BOTH ends of the chainage axis, which double-counts its dwell and
     inserts a phantom 0.1 km crawl segment.                                    */
  stopIdx.sort((a,b) => a-b);
  const minGap = Math.max(1, Math.round(500 / ds));
  stopIdx = stopIdx.filter((x,k) => k === 0 || x - stopIdx[k-1] > minGap);
  for (const i of stopIdx) v[i] = 0;

  for (let i = 1; i < n; i++)      v[i] = Math.min(v[i], Math.sqrt(v[i-1]*v[i-1] + 2*a*ds));
  for (let i = n - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i+1]*v[i+1] + 2*b*ds));

  let T = 0; const t = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const vm = Math.max(0.5, (v[i] + v[i-1]) / 2);
    T += ds / vm; t[i] = T;
  }

  /* phase, for the time/phase view: 0 station · 1 accelerating · 2 cruising · 3 braking.
     Classified by PHYSICAL acceleration a = d(v²)/2ds, threshold 0.25 m/s² — the old
     per-sample dv test (0.12 m/s per 25 m) fired on every gentle curve-cap ripple and
     painted the whole loop accel/brake. Station phase covers ±400 m of every stop so
     it is actually visible at map scale, not one 25 m sample.                        */
  const phase = new Uint8Array(n);
  const nearStop = new Uint8Array(n);
  const stopR = Math.max(1, Math.round(400 / ds));
  for (const i of stopIdx)
    for (let q = Math.max(0, i - stopR); q <= Math.min(n-1, i + stopR); q++) nearStop[q] = 1;
  for (let i = 0; i < n; i++) {
    if (nearStop[i] || v[i] < 40/3.6) { phase[i] = 0; continue; }
    const im = Math.max(0, i-1), ip = Math.min(n-1, i+1);
    const acc = (v[ip]*v[ip] - v[im]*v[im]) / (2 * ds * (ip - im));
    phase[i] = acc > 0.25 ? 1 : acc < -0.25 ? 3 : 2;
  }

  // per-segment running times between consecutive stops
  const dwell = opts.dwell === undefined ? 60 : opts.dwell;
  const segs = [];
  for (let k = 1; k < stopIdx.length; k++) {
    const i0 = stopIdx[k-1], i1 = stopIdx[k];
    let peakSeg = 0;
    for (let i = i0; i <= i1; i++) if (v[i] > peakSeg) peakSeg = v[i];
    segs.push({ i0, i1, s0: P[i0].s, s1: P[i1].s,
                dist: P[i1].s - P[i0].s, time: t[i1] - t[i0],
                peak: peakSeg * 3.6 });
  }
  const dwellTotal = dwell * Math.max(0, stopIdx.length - 2);

  let peak = 0;
  for (let i = 0; i < n; i++) if (v[i] > peak) peak = v[i];
  return { v, t, phase, segs, stopIdx, dwell, dwellTotal,
           run: T, total: T + dwellTotal, length: L,
           avg: L / (T + dwellTotal) * 3.6, avgRun: L / T * 3.6, peak: peak * 3.6 };
}

/* Chainage of each node along a resampled chain polyline. */
function nodeChainages(P, nodes) {
  return nodes.map(nd => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < P.length; i++) {
      const d = (P[i].E-nd.E)*(P[i].E-nd.E) + (P[i].N-nd.N)*(P[i].N-nd.N);
      if (d < bd) { bd = d; best = i; }
    }
    return { node: nd, idx: best, s: P[best].s, off: Math.sqrt(bd) };
  });
}

/** Closed-form trapezoidal journey time, for the analytical comparison table. */
function trapezoid(d, vmaxKmh, a, b) {
  const V = vmaxKmh / 3.6;
  const da = V*V/(2*a), db = V*V/(2*b);
  if (da + db <= d) {
    const tc = (d - da - db) / V;
    return { reached: vmaxKmh, t: V/a + V/b + tc, tAcc: V/a, tCruise: tc, tBrake: V/b, cruise: true };
  }
  const Vp = Math.sqrt(2*d*a*b/(a+b));
  return { reached: Vp*3.6, t: Vp/a + Vp/b, tAcc: Vp/a, tCruise: 0, tBrake: Vp/b, cruise: false };
}

/* ---------------------------------------------------------------- API ---- */
global.ENGINE = {
  initGrid, G, sample, sampleBilinear, cellCost, search, searchChain, searchLoop, resample, curvature,
  verticalProfile, classifyStructures, structureRuns, speedProfile, nodeChainages, trapezoid,
  trackLayout, TRACK,
  transitionLength, cantRequired, curveSpeed,
  MAGLEV, lateralAccel, maglevSpeed, bankFor,
  DEFAULT_W, DEFAULT_T, STRUCT, NH, DB,
  e2ix, n2iy,
};
})(window);
