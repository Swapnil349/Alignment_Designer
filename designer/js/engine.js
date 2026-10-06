/* ===========================================================================
   Alignment Designer v12 :: ENGINE

   Terrain and constraint access · cost surface · curvature-constrained search ·
   horizontal geometry · vertical alignment · structure selection · speed model.

   Generalised from the v11 London engine. The mathematics is the same and is
   kept deliberately intact; what changed is that nothing is hardcoded to one
   dataset or one railway any more:

     · the grid comes from a project pack, with whatever layers it happens to
       carry, instead of one baked-in 150 x 123 km London grid;
     · the geometric envelope comes from js/standards.js, so the same search
       routes a 100 km/h road and a 500 km/h maglev without a code change;
     · the speed model asks the mode for its curve-speed rule rather than
       assuming maglev bank angles.

   The one property worth restating, because it is the reason to build the
   search this way at all: the state lattice restricts the per-step heading
   change to the largest whole number of buckets that still satisfies
   stride/(k·Δθ) ≥ R_min, so EVERY path the search can emit is radius-compliant
   by construction. There is no post-hoc smoothing that might quietly violate
   the constraint, and the audit at the end exists only to catch a joint between
   legs reintroducing a corner.
   =========================================================================== */
(function (global) {
'use strict';

/* ---------------------------------------------------------------- GRID ---- */
const G = { layer: {}, meta: {}, ready: false };

async function b64inflate(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (typeof DecompressionStream !== 'function')
    throw new Error('This browser lacks DecompressionStream. Use Chrome/Edge 80+, ' +
                    'Firefox 113+ or Safari 16.4+.');
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Load a project payload (the JSON written by build/dempack.py) into the engine. */
async function loadProject(D, onProgress) {
  const keys = Object.keys(D.layers);
  const layer = {};
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i], m = D.meta[k];
    if (onProgress) onProgress(i, keys.length, k);
    const raw = await b64inflate(D.layers[k]);
    let arr;
    if (m.type === 'u16') {
      const u = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
      arr = new Float32Array(u.length);
      for (let j = 0; j < u.length; j++) arr[j] = u[j] / m.scale + m.offset;
    } else {
      arr = new Float32Array(raw.length);
      for (let j = 0; j < raw.length; j++) arr[j] = raw[j] / m.scale;
    }
    layer[k] = arr;
  }
  Object.assign(G, {
    id: D.id, name: D.name, crs: D.crs, utm: D.utm || null,
    nx: D.nx, ny: D.ny, cell: D.cell,
    xmin: D.xmin, ymax: D.ymax, xmax: D.xmax, ymin: D.ymin,
    notes: D.notes || '', defaults: D.defaults || {},
    controls: (D.controls || []).map(c => Object.assign({}, c)),
    reference: D.reference || null,
    meta: D.meta, layer, ready: true,
  });
  // Elevation range, for the hypsometric renderer and the profile axes.
  const dem = layer.dem;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < dem.length; i++) { if (dem[i] < lo) lo = dem[i]; if (dem[i] > hi) hi = dem[i]; }
  G.zmin = lo; G.zmax = hi;
  invalidateSurfaces();
  return G;
}

const idx = (ix, iy) => iy * G.nx + ix;
const e2ix = E => Math.floor((E - G.xmin) / G.cell);
const n2iy = N => Math.floor((G.ymax - N) / G.cell);
const inGrid = (ix, iy) => ix >= 0 && iy >= 0 && ix < G.nx && iy < G.ny;
const has = name => !!G.layer[name];

function sample(name, E, N) {
  const A = G.layer[name];
  if (!A) return 0;
  const ix = e2ix(E), iy = n2iy(N);
  if (!inGrid(ix, iy)) return 0;
  return A[idx(ix, iy)];
}

/** Bilinear sample — used for the DEM so the vertical profile is smooth. */
function sampleBilinear(name, E, N) {
  const A = G.layer[name];
  if (!A) return 0;
  const fx = (E - G.xmin) / G.cell - 0.5, fy = (G.ymax - N) / G.cell - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const gx = (x, y) => {
    const cx = Math.max(0, Math.min(G.nx - 1, x)), cy = Math.max(0, Math.min(G.ny - 1, y));
    return A[cy * G.nx + cx];
  };
  return (gx(x0, y0) * (1 - tx) + gx(x0 + 1, y0) * tx) * (1 - ty)
       + (gx(x0, y0 + 1) * (1 - tx) + gx(x0 + 1, y0 + 1) * tx) * ty;
}

/* ------------------------------------------------------------ COST MODEL -- */
/* Weights are multipliers on a base construction cost of 1.0 per metre of
   surface alignment. They are exposed in the UI because the sensitivity of the
   route to each constraint IS the deliverable of a corridor study — the line is
   an argument, not an answer.

   Only layers the loaded project actually carries are charged; a DEM-only
   import routes on terrain alone, which is the correct behaviour rather than a
   degraded one. */
const DEFAULT_WEIGHTS = {
  built:        60,   // settlements — displacement and acquisition
  protected:    45,   // national park / reserve / heritage landscape
  woodland:     22,
  flood:        12,
  water_body:   16,
  river_major:  16,   // major watercourse crossing
  road_major:    6,   // grade-separated crossing of an existing road
  rail:          5,
  farmland:      8,
  greenbelt:    -2,   // negative = mild preference
  mangrove:     60,   // CRZ-IA: felling needs court and CZMA leave (MAHSR: 22,000 trees, 2022)
  wetland:      25,   // marsh, mudflat, saltmarsh — Ramsar sites belong in protected
  crz:          10,   // coastal regulation zone (proxy unless an authoritative layer is given)
  exclusion:  4000,   // hard no-go: effectively a wall, not a penalty
  slope:         9,   // per % of point ground slope (earthworks proxy)
  turn:         55,   // per bucket of direction change (transition curves)
  terrGrade:    14,   // per % of ground gradient ALONG the direction of travel
  terrUndul:     3,   // per metre of undulation a stiff profile cannot follow
  terrWindow: 1200,   // m of look-ahead/behind for the directional terrain cost
};

/* Which weights correspond to coverage layers, i.e. get charged as
   coverage × weight. Everything else is handled specially. */
const COVERAGE_KEYS = ['built', 'protected', 'woodland', 'flood', 'water_body',
                       'river_major', 'road_major', 'rail', 'farmland',
                       'greenbelt', 'mangrove', 'wetland', 'crz', 'exclusion'];

/** Layers the loaded project can actually be weighted on. */
function activeCostLayers() {
  return COVERAGE_KEYS.filter(has);
}

/** Per-metre surface cost multiplier at a point. */
function cellCost(E, N, w) {
  const ix = e2ix(E), iy = n2iy(N);
  if (!inGrid(ix, iy)) return 1e6;
  const i = idx(ix, iy), L = G.layer;
  let c = 1;
  for (let k = 0; k < COVERAGE_KEYS.length; k++) {
    const key = COVERAGE_KEYS[k], A = L[key];
    if (!A) continue;
    const wk = w[key];
    if (!wk) continue;
    c += A[i] * wk;
  }
  if (L.slope) c += Math.min(L.slope[i], 25) * (w.slope || 0) * 0.1;
  return Math.max(0.05, c);
}

/* ------------------------------------------------ PRECOMPUTED SURFACES --- */
/* The search evaluates the cost surface tens of millions of times, and doing it
   the obvious way — walk every constraint layer at every sample — put a 50 km
   road corridor at 116 s. Both the constraint sum and the terrain response are
   fixed once the weights are fixed, so they are baked into grids up front:
   one weighted-sum array, and a smoothed-terrain field. The inner loop then
   costs a handful of array reads. Cached on a signature, so the ten searches of
   an option study rebuild only when the weights actually change. */
let _costCache = { sig: '', arr: null };
let _terrCache = { sig: '', gx: null, gy: null, un: null };

function invalidateSurfaces() { _costCache.sig = ''; _terrCache.sig = ''; }

function costSignature(w) {
  let s = G.id + '|';
  for (const k of COVERAGE_KEYS) s += (w[k] || 0) + ',';
  return s + '|' + (w.slope || 0);
}

function buildCostGrid(w) {
  const sig = costSignature(w);
  if (_costCache.sig === sig && _costCache.arr) return _costCache.arr;
  const n = G.nx * G.ny, out = new Float32Array(n).fill(1);
  for (const k of COVERAGE_KEYS) {
    const A = G.layer[k], wk = w[k];
    if (!A || !wk) continue;
    for (let i = 0; i < n; i++) out[i] += A[i] * wk;
  }
  if (G.layer.slope && w.slope) {
    const A = G.layer.slope, s = w.slope * 0.1;
    for (let i = 0; i < n; i++) out[i] += (A[i] < 25 ? A[i] : 25) * s;
  }
  for (let i = 0; i < n; i++) if (out[i] < 0.05) out[i] = 0.05;
  _costCache = { sig, arr: out };
  return out;
}

/** Separable moving average, run twice — a cheap, adequate Gaussian. */
function boxBlur(src, nx, ny, r) {
  if (r < 1) return Float32Array.from(src);
  let a = Float32Array.from(src), b = new Float32Array(src.length);
  const win = 2 * r + 1;
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < ny; y++) {                       // horizontal
      const o = y * nx;
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += a[o + Math.max(0, Math.min(nx-1, x))];
      for (let x = 0; x < nx; x++) {
        b[o + x] = acc / win;
        acc += a[o + Math.min(nx-1, x + r + 1)] - a[o + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < nx; x++) {                       // vertical
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += b[Math.max(0, Math.min(ny-1, y)) * nx + x];
      for (let y = 0; y < ny; y++) {
        a[y * nx + x] = acc / win;
        acc += b[Math.min(ny-1, y + r + 1) * nx + x] - b[Math.max(0, y - r) * nx + x];
      }
    }
  }
  return a;
}

/* The terrain response, precomputed over the profile-stiffness window:
     gx, gy   gradient of the SMOOTHED ground — the slope a stiff profile sees
     un       the undulation it cannot follow, i.e. the RMS residual about the
              local plane. Local variance includes the ramp itself, so the ramp's
              own contribution (g²W²/3 for a linear slope over a half-window W)
              is subtracted rather than double-charged as roughness. */
function buildTerrainField(win) {
  const sig = G.id + '|' + win;
  if (_terrCache.sig === sig && _terrCache.gx) return _terrCache;
  const nx = G.nx, ny = G.ny, n = nx * ny, dem = G.layer.dem;
  const r = Math.max(1, Math.round(win / G.cell));
  const sq = new Float32Array(n);
  for (let i = 0; i < n; i++) sq[i] = dem[i] * dem[i];
  const m1 = boxBlur(dem, nx, ny, r);
  const m2 = boxBlur(sq, nx, ny, r);
  const gx = new Float32Array(n), gy = new Float32Array(n), un = new Float32Array(n);
  const W = r * G.cell;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      const xl = m1[y*nx + (x > 0 ? x-1 : 0)], xr = m1[y*nx + (x < nx-1 ? x+1 : nx-1)];
      const yu = m1[(y > 0 ? y-1 : 0)*nx + x], yd = m1[(y < ny-1 ? y+1 : ny-1)*nx + x];
      const dx = (xr - xl) / (2 * G.cell), dy = (yu - yd) / (2 * G.cell);  // +N is up
      gx[i] = dx; gy[i] = dy;
      const varr = Math.max(0, m2[i] - m1[i] * m1[i]);
      const ramp = (dx*dx + dy*dy) * W * W / 3;
      un[i] = Math.sqrt(Math.max(0, varr - ramp));
    }
  }
  _terrCache = { sig, gx, gy, un };
  return _terrCache;
}

/* --------------------------------------------- CURVATURE-CONSTRAINED A* --- */
const NH = 72;                       // heading buckets, 5 deg each
const DB = 2 * Math.PI / NH;

function arcStep(x, y, th, dth, L) {
  if (Math.abs(dth) < 1e-9) return [x + L * Math.cos(th), y + L * Math.sin(th), th];
  const R = L / dth;                                   // signed
  const cx = x - R * Math.sin(th), cy = y + R * Math.cos(th);
  const t2 = th + dth;
  return [cx + R * Math.sin(t2), cy - R * Math.cos(t2), t2];
}

/** Shortest search stride that still guarantees R ≥ rMin, rounded to 25 m. */
function strideFor(rMin, corridorLen) {
  const geometric = rMin * DB * 1.02;
  // Keep the state count sane on a long corridor: a stride finer than ~1/400 of
  // the run buys nothing the resample step cannot recover.
  const practical = corridorLen ? corridorLen / 400 : 0;
  return Math.max(50, Math.ceil(Math.max(geometric, practical) / 25) * 25);
}

/* Cost of the GROUND along the direction of travel.

   Samples the DEM over a window longer than the step, because the vertical
   profile is stiff over a couple of kilometres, fits the best straight grade,
   and charges for
     (a) the along-track gradient — this is what pushes the route into valleys
         and makes a ridge crossing seek the lowest col;
     (b) the RMS residual about that grade — the undulation a stiff profile
         cannot follow, which is the cut and fill it will cost.
   A point-slope penalty alone cannot tell a route running along a contour from
   one driving straight up the hillside. These two can, and on a mountain
   crossing they are the difference between a route and a wish.               */
function stepTerrainCost(x, y, th, dth, L, w, TF) {
  TF = TF || buildTerrainField(w.terrWindow || 1200);
  // Evaluate at the middle of the arc, on the heading the vehicle holds there.
  const mx = x + (L * 0.5) * Math.cos(th + dth * 0.25);
  const my = y + (L * 0.5) * Math.sin(th + dth * 0.25);
  const ix = e2ix(mx), iy = n2iy(my);
  if (!inGrid(ix, iy)) return 0;
  const i = iy * G.nx + ix;
  const thm = th + dth * 0.5;
  const along = TF.gx[i] * Math.cos(thm) + TF.gy[i] * Math.sin(thm);
  const gradePct = Math.abs(along) * 100;
  /* A grade the mode simply cannot climb is not expensive, it is infeasible.
     Charging it steeply rather than forbidding it keeps the search complete —
     a road CAN switchback up a 20 % hillside, it just pays for the length. */
  let pen = (w.terrGrade || 0) * gradePct + (w.terrUndul || 0) * TF.un[i];
  if (w.maxGrade && gradePct > w.maxGrade)
    pen += (w.terrGrade || 14) * (gradePct - w.maxGrade) * 3;
  return pen;
}

/* opt = { seedHeading, exitToward, exitCone, exitCenter }
     seedHeading  bucket index the leg MUST start on — this is what makes a
                  chain continuous. Solving legs independently and butting them
                  together puts a kink at every intermediate control point.
     exitToward   {E,N} of the control point AFTER b. The leg may only finish on
                  a heading within exitCone of the turn bisector, so it arrives
                  already pointing the right way for the next leg.            */
/* 2-D cost-to-go from the goal, on a coarse lattice over the search box.

   The heading-blind straight-line heuristic fails worst exactly where a
   corridor study needs it most: stations sit INSIDE towns. Arriving at a city
   station means crossing kilometres of built-up land at ~60× the open-ground
   cost, and a heuristic that assumes 1× there makes A* exhaust every cheaper
   alternative in the band before it will enter the town — a synthetic leg
   into a built-up block used up a 1.5 M-state budget and returned nothing.

   So: compute the 2-D cost-to-go over the search box at grid resolution
   (raster sweeping, below) and read it by bilinear interpolation between cell
   centres. It knows the city is there, and it ignores heading and curvature,
   so it never charges for those.

   It is not scaled down to be strictly admissible, deliberately. A 16-
   direction stencil can over-measure a path by at most 2.6 % (8-direction:
   8.2 %). Scaling by 0.92 to compensate was tried: on a leg whose cost is
   dominated by 10 km of town, 8 % of that is ~50 km of slack, and the search
   spent it wandering over every cheap field in the band. */
let _ctgCache = { key: '', val: null };
function costToGo(CG, X0, Y0, X1, Y1, hRes, goal, goalR) {
  const GNX = G.nx, GNY = G.ny, GC = G.cell, GX0 = G.xmin, GY1 = G.ymax;
  /* Resolution: the search's own. A step samples cost four times along its
     arc, so features thinner than a quarter-stride are only seen by the
     search part of the time anyway; resolving them finer in the heuristic
     buys nothing and cost 12 s on a 50 m grid. A quarter-stride lattice keeps
     the river, road and rail crossings a coarser (half-stride) one erased —
     min-pooled, so it stays a lower bound — and never exceeds ~1.5 M cells. */
  const area = Math.max(1, (X1 - X0) * (Y1 - Y0));
  const res = Math.max(GC, hRes, Math.sqrt(area / 1.5e6));
  const key = [G.id, CG.length, _costCache.sig, X0, Y0, X1, Y1, res, goal.E, goal.N, goalR].join('|');
  if (_ctgCache.key === key) return _ctgCache.val;
  const W = Math.max(2, Math.ceil((X1 - X0) / res)), H = Math.max(2, Math.ceil((Y1 - Y0) / res));
  const cc = new Float32Array(W * H);
  for (let cy = 0; cy < H; cy++) {
    const n0 = Y0 + cy * res, n1 = n0 + res;
    const fy0 = Math.max(0, Math.floor((GY1 - n1) / GC)), fy1 = Math.min(GNY - 1, Math.floor((GY1 - n0) / GC - 1e-9));
    for (let cx = 0; cx < W; cx++) {
      const e0 = X0 + cx * res, e1 = e0 + res;
      const fx0 = Math.max(0, Math.floor((e0 - GX0) / GC)), fx1 = Math.min(GNX - 1, Math.floor((e1 - GX0) / GC - 1e-9));
      let m = 1e6;
      for (let fy = fy0; fy <= fy1; fy++) {
        const o = fy * GNX;
        for (let fx = fx0; fx <= fx1; fx++) if (CG[o + fx] < m) m = CG[o + fx];
      }
      cc[cy * W + cx] = m;
    }
  }
  const dist = new Float64Array(W * H).fill(Infinity);
  /* Seed the whole ARRIVAL zone, not one cell. The search counts a leg as
     arrived anywhere within goalR of the point, and a single goal cell's
     centre can sit half a cell off the point; inside a town, at ~60× open-
     ground cost, those few hundred metres were worth 25–75 km-equivalent of
     OVER-estimate. An over-estimate is the one error a heuristic must not
     make: it steered the search away from the true approach and produced a
     137 km route for a 104 km leg. */
  const seedR = (goalR || 0) + res * Math.SQRT1_2;
  const gx = Math.floor((goal.E - X0) / res), gy = Math.floor((goal.N - Y0) / res);
  const rx = Math.ceil(seedR / res) + 1;
  for (let yy = Math.max(0, gy - rx); yy <= Math.min(H - 1, gy + rx); yy++)
    for (let xx = Math.max(0, gx - rx); xx <= Math.min(W - 1, gx + rx); xx++)
      if (Math.hypot(X0 + (xx + 0.5) * res - goal.E, Y0 + (yy + 0.5) * res - goal.N) <= seedR)
        dist[yy * W + xx] = 0;

  /* Weighted distance by raster sweeping (a chamfer / fast-sweeping
     transform): alternate forward and backward passes, each relaxing a cell
     from its 8 already-visited neighbours of the 16-direction stencil, until a
     pass changes nothing. Same answer as Dijkstra on this stencil, as flat
     array arithmetic: the grid is padded by two cells so no neighbour needs a
     bounds check.
     A diagonal or knight step is charged the CHEAPER of the two cells it
     slips between, so a one-cell river drawn diagonally cannot be crossed for
     free at a corner, yet a path running along a town's edge is not charged
     the town. The 16-direction stencil over-measures a path by at most 2.6 %. */
  const Wp = W + 4, Hp = H + 4;
  const cp = new Float32Array(Wp * Hp).fill(1e6);
  const dp = new Float64Array(Wp * Hp).fill(Infinity);
  for (let y = 0; y < H; y++) {
    const o = (y + 2) * Wp + 2;
    for (let x = 0; x < W; x++) { cp[o + x] = cc[y * W + x]; dp[o + x] = dist[y * W + x]; }
  }
  const F = [[-1,0],[-1,-1],[0,-1],[1,-1],[-2,-1],[-1,-2],[1,-2],[2,-1]];
  const mk = sgn => {
    const off = new Int32Array(8), m1 = new Int32Array(8), m2 = new Int32Array(8);
    const len = new Float64Array(8), diag = new Uint8Array(8);
    F.forEach(([dx, dy], k) => {
      dx *= sgn; dy *= sgn;
      off[k] = dy * Wp + dx; len[k] = Math.hypot(dx, dy) * res;
      if (Math.abs(dx) === 1 && Math.abs(dy) === 1) { m1[k] = dx; m2[k] = dy * Wp; diag[k] = 1; }
      else if (Math.abs(dx) === 2) { m1[k] = Math.sign(dx); m2[k] = Math.sign(dx) + dy * Wp; diag[k] = 1; }
      else if (Math.abs(dy) === 2) { m1[k] = Math.sign(dy) * Wp; m2[k] = dx + Math.sign(dy) * Wp; diag[k] = 1; }
    });
    return { off, m1, m2, len, diag };
  };
  const FW = mk(1), BW = mk(-1);
  const pass = (S, fwd) => {
    const { off, m1, m2, len, diag } = S;
    let changed = 0;
    for (let yy = 0; yy < H; yy++) {
      const y = fwd ? yy + 2 : H + 1 - yy;
      let i = y * Wp + (fwd ? 2 : W + 1);
      for (let xx = 0; xx < W; xx++, i += fwd ? 1 : -1) {
        let best = dp[i];
        const ci = cp[i];
        for (let k = 0; k < 8; k++) {
          const n = i + off[k], dn = dp[n];
          if (dn >= best) continue;            // costs are positive: cannot improve
          let c = ci + cp[n];
          if (diag[k]) {
            const a2 = cp[i + m1[k]], b2 = cp[i + m2[k]];
            c = (c + 2 * (a2 < b2 ? a2 : b2)) * 0.5;
          }
          const nd = dn + len[k] * 0.5 * c;
          if (nd < best) best = nd;
        }
        if (best < dp[i]) { dp[i] = best; changed++; }
      }
    }
    return changed;
  };
  for (let it = 0; it < 24; it++) {
    const ch = pass(FW, true) + pass(BW, false);
    if (!ch) break;
  }
  for (let y = 0; y < H; y++) {
    const o = (y + 2) * Wp + 2;
    for (let x = 0; x < W; x++) dist[y * W + x] = dp[o + x];
  }
  const val = { W, H, dist, cc, X0, Y0, hRes: res };
  _ctgCache = { key, val };
  return val;
}

/* Dense arrays cost 16 bytes per state (g, cameFrom, x, y). The cap is a memory
   budget, not a taste: 9M states is ~145 MB, which a browser tab survives. */
const STATE_CAP = 9e6;

function search(a, b, w, onProgress, opt) {
  opt = opt || {};
  const CG = buildCostGrid(w);
  const TF = buildTerrainField(w.terrWindow || 1200);
  const GNX = G.nx, GNY = G.ny, GX0 = G.xmin, GY1 = G.ymax, GC = G.cell;
  const costAt = (E_, N_) => {
    const ix = (E_ - GX0) / GC | 0, iy = (GY1 - N_) / GC | 0;
    if (ix < 0 || iy < 0 || ix >= GNX || iy >= GNY) return 1e6;
    return CG[iy * GNX + ix];
  };
  const direct = Math.hypot(b.E - a.E, b.N - a.N);
  const corrW = opt.corridor || 0.30;                 // lateral room, × direct
  const margin = Math.max(Math.min(9000, direct * 0.6), direct * corrW);
  const X0 = Math.min(a.E, b.E) - margin, X1 = Math.max(a.E, b.E) + margin;
  const Y0 = Math.min(a.N, b.N) - margin, Y1 = Math.max(a.N, b.N) + margin;

  /* Fit the stride to the corridor. Lengthening the step shrinks the lattice as
     1/stride², and it never weakens the radius guarantee — a longer step simply
     buys more heading buckets, so rAchievable stays at or above rMin. The
     effective stride is reported rather than assumed, because it is the
     resolution at which the corridor was actually searched. */
  /* Floor the stride at the value the radius guarantee needs. Below it the
     lattice can only offer one heading bucket per step, and one bucket over too
     short a step IS a curve tighter than the standard — the guarantee has to be
     enforced where it is defined, not left to a slider. */
  let stride = Math.max(w.stride, w.rMin * DB * 1.02);
  stride = Math.ceil(stride / 25) * 25;
  let W = 0, H = 0, NS = 0;
  for (let guard = 0; guard < 40; guard++) {
    const res = stride / 2;
    W = Math.ceil((X1 - X0) / res); H = Math.ceil((Y1 - Y0) / res);
    NS = W * H * NH * 3;
    if (NS <= STATE_CAP) break;
    stride = Math.ceil(stride * 1.3 / 25) * 25;
  }
  if (NS > STATE_CAP) throw new Error(
    'corridor too large to search at this radius — narrow the corridor or split ' +
    'the route with intermediate control points');
  const maxBuckets = Math.max(1, Math.floor(stride / w.rMin / DB));
  const rAchievable = stride / (maxBuckets * DB);
  const res = stride / 2;

  /* State = (cell, heading, last turn direction). The last-turn dimension is
     there so a left arc cannot run straight into a right arc: reverse curves
     must be separated by at least one straight step, or there is no radius at
     the join and nowhere to put the transition curves. */
  const NT = 3;                       // 0 = left, 1 = straight, 2 = right
  const key = (x, y, h, lt) => {
    const ix = Math.floor((x - X0) / res), iy = Math.floor((y - Y0) / res);
    if (ix < 0 || iy < 0 || ix >= W || iy >= H) return -1;
    return ((iy * W + ix) * NH + h) * NT + lt;
  };

  const gS = new Float32Array(NS).fill(Infinity);
  const cameFrom = new Int32Array(NS).fill(-1);
  const stateX = new Float32Array(NS), stateY = new Float32Array(NS);
  /* Closed set. With a calibrated (therefore not provably admissible) heuristic
     the queue order is no longer monotone, and without this a state is re-opened
     every time a marginally cheaper path to it appears — the search expanded
     past six million states and returned nothing. One byte per state buys a
     bounded-suboptimal search that terminates. */
  const closed = new Uint8Array(NS);

  /* The heuristic. A strictly admissible bound is the cheapest cell in the whole
     grid — about 1.0 — but in hill country the real cost of a metre is 10 to 40
     times that once the terrain penalties are counted, so such a heuristic
     underestimates the remaining cost by an order of magnitude and A* degenerates
     into Dijkstra: it expanded 4M states and took 86 s on a 50 km corridor.

     Instead the heuristic is calibrated on the corridor itself: probe the cost
     surface along the straight line between the two points and take a LOW
     percentile, i.e. what a metre costs in the cheap parts of this particular
     corridor. That is not a proven lower bound, so the result is no longer
     provably optimal — it is a well-informed near-optimal search, which is the
     honest description and the same trade-off every practical route optimiser
     makes. What it never does is relax the radius constraint: that is
     structural, and no heuristic can weaken it. */
  let hCost = 0.9;
  {
    const probes = [];
    for (let i = 0; i <= 48; i++) {
      const f = i / 48;
      const px = a.E + (b.E - a.E) * f, py = a.N + (b.N - a.N) * f;
      const base = costAt(px, py);
      const terr = stepTerrainCost(px, py, Math.atan2(b.N - a.N, b.E - a.E), 0,
                                   stride, w, TF) * 0.01;
      probes.push(base + terr);
    }
    probes.sort((p, q) => p - q);
    /* The cheapest cell anywhere in the search box is a true lower bound on
       the cost of a metre — terrain and turn penalties only ever add — so
       minCell × distance is an ADMISSIBLE heuristic, and on open ground it is
       usually 1.0. The previous fixed floor of 0.9 left a 10 % gap there, and on
       a flat plain a 10 % gap is ruinous: A* expands every state with
       g + 0.9·h below the optimum, which near the start is a disc 1.1 legs
       wide, times 216 headings. A 100 km leg across the Gangetic plain used up
       a 6 M-state budget and came back "infeasible" at a radius it could
       easily have met. */
    let minCell = Infinity;
    {
      const ix0 = Math.max(0, Math.floor((X0 - GX0) / GC)), ix1 = Math.min(GNX - 1, Math.floor((X1 - GX0) / GC));
      const iy0 = Math.max(0, Math.floor((GY1 - Y1) / GC)), iy1 = Math.min(GNY - 1, Math.floor((GY1 - Y0) / GC));
      for (let iy = iy0; iy <= iy1; iy++) {
        const o = iy * GNX;
        for (let ix = ix0; ix <= ix1; ix++) if (CG[o + ix] < minCell) minCell = CG[o + ix];
      }
      if (!isFinite(minCell)) minCell = 0.05;
    }
    hCost = Math.max(minCell, probes[Math.floor(probes.length * 0.30)] * 0.80);
  }
  /* Heading-aware heuristic. A state is (cell, heading, last turn) — 216
     states per cell — and a pure-distance heuristic scores a train pointing
     sideways exactly like one pointing at the goal, so A* expands every
     heading at every cell inside the search band. But any path must turn its
     heading at least to the bearing of the goal (the mean direction of a path
     is the direction of its chord, so its range of headings must reach that
     bearing), and every bucket turned is charged the curvature penalty. That
     minimum turning cost is a second admissible term, and it prunes the
     wrong-way states outright. Measured on a 104 km leg across open ground:
     1 002 expansions, where the distance-only heuristic needed 15 260. */
  /* ε: weighted A*. ε > 1 inflates the heuristic, trading optimality for far
     fewer expansions. NO hard bound is claimed for either setting: the
     heuristic is not guaranteed consistent (the stencil can over-measure by
     2.6 %, the corridor-probe term is calibrated rather than admissible) and
     closed states are not reopened. Measured on Delhi – Agra, Jewar → Mathura:
     ε 1.0 cost 361.6, ε 1.2 cost 355.1, ε 1.6 cost 391.9 (km-equivalent) — so
     ε 1.0 is near-optimal, not exact, and ε 1.6 can cost ~10 % more. Chosen per
     leg by routeLeg, lowest first, and reported. */
  const eps = opt.epsilon || 1;
  const turnPerBucket = (w.turn || 0) * stride * 0.01;
  const goalTol = stride * 0.5;
  const C2 = costToGo(CG, X0, Y0, X1, Y1, stride / 4, b, goalTol);
  const heur = (x, y, h) => {
    const gx = b.E - x, gy = b.N - y;
    const d = Math.hypot(gx, gy);
    let v = d * hCost;
    // bilinear between the four surrounding cell centres
    const fx = (x - C2.X0) / C2.hRes - 0.5, fy = (y - C2.Y0) / C2.hRes - 0.5;
    const x0 = Math.max(0, Math.min(C2.W - 2, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(C2.H - 2, Math.floor(fy)));
    const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0));
    const D = C2.dist, Wc = C2.W;
    if (C2.W > 1 && C2.H > 1) {
      const v2 = (D[y0*Wc + x0] * (1-tx) + D[y0*Wc + x0+1] * tx) * (1-ty)
               + (D[(y0+1)*Wc + x0] * (1-tx) + D[(y0+1)*Wc + x0+1] * tx) * ty;
      if (v2 > v && isFinite(v2)) v = v2;
    }
    if (turnPerBucket > 0 && d > goalTol) {
      let dth = Math.atan2(gy, gx) - h * DB;
      dth = Math.abs(((dth % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
      const need = Math.ceil((dth - Math.asin(Math.min(1, goalTol / d))) / DB - 1e-9);
      if (need > 0) v += need * turnPerBucket;
    }
    return v;
  };

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

  const bearing = Math.atan2(b.N - a.N, b.E - a.E);
  if (opt.seedHeading !== undefined && opt.seedHeading !== null) {
    const h = ((opt.seedHeading % NH) + NH) % NH;
    const s = key(a.E, a.N, h, 1);
    if (s >= 0) { gS[s] = 0; stateX[s] = a.E; stateY[s] = a.N; push(eps * heur(a.E, a.N, h), s); }
  } else {
    for (let h = 0; h < NH; h++) {
      const d = Math.abs(((h * DB - bearing + Math.PI * 3) % (2 * Math.PI)) - Math.PI);
      if (d > 0.9) continue;
      const s = key(a.E, a.N, h, 1);
      if (s < 0) continue;
      gS[s] = 0; stateX[s] = a.E; stateY[s] = a.N;
      push(eps * heur(a.E, a.N, h), s);
    }
  }

  /* Arrival-heading gate. The target is the BISECTOR of the turn, not the
     outgoing bearing: a control point on a curve is passed mid-turn, and
     forcing the whole turn into the incoming leg makes the search swing wide to
     set up an approach it could not otherwise make. The cone widens with the
     turn so the other half can be completed after the point. */
  let exitB = null, exitCone = opt.exitCone === undefined ? 0.62 : opt.exitCone;
  if (opt.exitToward) {
    const inB  = Math.atan2(b.N - a.N, b.E - a.E);
    const outB = Math.atan2(opt.exitToward.N - b.N, opt.exitToward.E - b.E);
    let turn = outB - inB;
    while (turn >  Math.PI) turn -= 2*Math.PI;
    while (turn < -Math.PI) turn += 2*Math.PI;
    exitB = inB + (opt.exitCenter === 'full' ? turn : turn/2);
    if (exitCone >= 0.5) exitCone = Math.max(exitCone, Math.abs(turn)/2 + 0.35);
  }
  const headingOK = h => {
    if (exitB === null) return true;
    const d = Math.abs(((h * DB - exitB + Math.PI * 3) % (2 * Math.PI)) - Math.PI);
    return d <= exitCone;
  };

  /* Every arc the lattice can offer is one of NH × (2·maxBuckets+1) shapes,
     identical apart from where it starts. Precomputing them turns the inner
     loop from ten trig calls per successor into an array read — on a road,
     where a short radius buys 35 successors per state, that is most of the
     runtime. */
  const NSAMP = 4;
  const ARC = new Array(NH);
  for (let h = 0; h < NH; h++) {
    const row = [];
    for (let db = -maxBuckets; db <= maxBuckets; db++) {
      const dth = db * DB, th = h * DB;
      const [ex, ey, th2] = arcStep(0, 0, th, dth, stride);
      const sx = new Float64Array(NSAMP), sy = new Float64Array(NSAMP);
      for (let i = 1; i <= NSAMP; i++) {
        const f = i / NSAMP;
        const p = arcStep(0, 0, th, dth * f, stride * f);
        sx[i-1] = p[0]; sy[i-1] = p[1];
      }
      const mth = th + dth * 0.25, thm = th + dth * 0.5;
      row.push({
        db, lt2: db === 0 ? 1 : (db > 0 ? 0 : 2),
        ex, ey, h2: ((Math.round(th2 / DB) % NH) + NH) % NH,
        sx, sy,
        mx: (stride * 0.5) * Math.cos(mth), my: (stride * 0.5) * Math.sin(mth),
        cth: Math.cos(thm), sth: Math.sin(thm),
        turnCost: (w.turn || 0) * stride * 0.01 * Math.abs(db),
      });
    }
    ARC[h] = row;
  }
  const TGX = TF.gx, TGY = TF.gy, TUN = TF.un;
  const wGrade = w.terrGrade || 0, wUndul = w.terrUndul || 0, wMaxG = w.maxGrade || 0;
  const terrScale = stride * 0.01;

  const goalR = stride * 0.5;
  let best = -1, expanded = 0, capped = false;
  const cap = opt.expandCap || 6e6;

  while (heap.v.length) {
    const s = pop();
    if (closed[s]) continue;
    closed[s] = 1;
    const x = stateX[s], y = stateY[s];
    const h = Math.floor(s / NT) % NH, lt = s % NT;
    if (++expanded > cap) { capped = true; break; }
    if (Math.hypot(b.E - x, b.N - y) < goalR && headingOK(h)) { best = s; break; }
    const gc = gS[s];
    if (onProgress && (expanded & 16383) === 0) onProgress(expanded);

    const row = ARC[h];
    for (let bi = 0; bi < row.length; bi++) {
      const A = row[bi], lt2 = A.lt2;
      if (lt !== 1 && lt2 !== 1 && lt2 !== lt) continue;   // no direct L<->R reversal
      const nx2 = x + A.ex, ny2 = y + A.ey;
      const s2 = key(nx2, ny2, A.h2, lt2);
      if (s2 < 0 || closed[s2]) continue;

      let acc = 0;
      for (let i = 0; i < NSAMP; i++) acc += costAt(x + A.sx[i], y + A.sy[i]);
      let step = (acc / NSAMP) * stride + A.turnCost;

      // terrain response at the middle of the arc, on the heading held there
      const tix = (x + A.mx - GX0) / GC | 0, tiy = (GY1 - (y + A.my)) / GC | 0;
      if (tix >= 0 && tiy >= 0 && tix < GNX && tiy < GNY) {
        const ti = tiy * GNX + tix;
        const gp = Math.abs(TGX[ti] * A.cth + TGY[ti] * A.sth) * 100;
        let pen = wGrade * gp + wUndul * TUN[ti];
        if (wMaxG && gp > wMaxG) pen += (wGrade || 14) * (gp - wMaxG) * 3;
        step += pen * terrScale;
      }

      const ng = gc + step;
      if (ng < gS[s2]) {
        gS[s2] = ng; cameFrom[s2] = s; stateX[s2] = nx2; stateY[s2] = ny2;
        push(ng + eps * heur(nx2, ny2, A.h2), s2);
      }
    }
  }

  /* Running out of budget is not the same as finding no route. A capped
     search says nothing about the geometry, and must never be read as "this
     radius does not fit" — that is how a straight leg once got a station-
     throat relaxation it did not need. */
  if (best < 0) return capped ? { capped: true, expanded, stride, epsilon: eps } : null;

  /* Walk back collecting states, then REGENERATE each arc. Storing only the arc
     endpoints and joining them with straight lines would inject corners the
     search never proposed, and would break the radius guarantee. */
  const chain = [];
  for (let s = best; s >= 0; s = cameFrom[s])
    chain.push({ x: stateX[s], y: stateY[s], h: Math.floor(s / NT) % NH });
  chain.reverse();

  const SUB = Math.max(8, Math.round(stride / 25));   // ~25 m along the arc
  const pts = [{ E: chain[0].x, N: chain[0].y }];
  for (let i = 1; i < chain.length; i++) {
    const p = chain[i-1], q = chain[i];
    let db = q.h - p.h;
    while (db >  NH/2) db -= NH;
    while (db < -NH/2) db += NH;
    const dth = db * DB, th = p.h * DB;
    for (let k = 1; k <= SUB; k++) {
      const f = k / SUB;
      const [ax, ay] = arcStep(p.x, p.y, th, dth * f, stride * f);
      pts.push({ E: ax, N: ay });
    }
  }
  /* The exact target is deliberately NOT appended. Joining the final lattice
     state to it with a straight chord injects a corner the search never
     proposed and destroys the radius guarantee. The alignment ends where the
     geometry arrives; the residual offset is reported. */
  const end = pts[pts.length - 1];
  return { pts, expanded, rAchievable, maxBuckets, stride, epsilon: eps, cost: gS[best], states: chain.length,
           endGap: Math.hypot(end.E - b.E, end.N - b.N),
           endHeading: chain[chain.length - 1].h };
}

/* ------------------------------------------------------- CHAIN ROUTING --- */
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

/* Belt and braces. The lattice guarantees R ≥ rAchievable BY CONSTRUCTION, so
   this can only fire if a joint between legs has reintroduced a corner. It
   exists because exactly that happened once — silently — and shipped a 100 m
   radius to the screen. Measured over a baseline scaled to the radius: too
   short a span cannot estimate a large radius without numerical noise. */
function auditRadius(pts, rAchievable) {
  if (pts.length < 40) return null;
  let sp = 0;
  for (let i = 1; i < 20; i++) sp += Math.hypot(pts[i].E-pts[i-1].E, pts[i].N-pts[i-1].N);
  sp /= 19;
  const baseline = Math.max(200, Math.min(1200, rAchievable * 0.06));
  const span = Math.max(4, Math.round(baseline / Math.max(sp, 1)));
  const R = curvature(pts, span);
  let minR = Infinity, at = 0, s = 0, sAt = 0;
  for (let i = 1; i < pts.length; i++) {
    s += Math.hypot(pts[i].E-pts[i-1].E, pts[i].N-pts[i-1].N);
    const r = Math.abs(R[i]);
    if (r < minR) { minR = r; at = i; sAt = s; }
  }
  return { minR, at, chainage: sAt, ok: minR >= rAchievable * 0.92 };
}

function turnAt(a, b, c) {
  if (!c) return null;
  const inB  = Math.atan2(b.N - a.N, b.E - a.E);
  const outB = Math.atan2(c.N - b.N, c.E - b.E);
  let t = outB - inB;
  while (t >  Math.PI) t -= 2*Math.PI;
  while (t < -Math.PI) t += 2*Math.PI;
  return t;
}
function tightFirst(turn) {
  return turn !== null && Math.abs(turn) > 0.9 && Math.abs(turn) < 1.6;
}

/* One leg of a chain, with the full attempt ladder:
     1. chicane (this turn and the next reverse, both sharp): arrive having
        absorbed the WHOLE turn — cone 0.35 on the full-turn heading
     2. sharp turn: arrive ON the bisector — cone 0.35
     3. wide bisector cone 0.62, then 1.05, then seed-only
   BALLOON GUARD: an attempt that "succeeds" at more than 1.6 × direct + 8 km is
   a geometric absurdity, not a route — it falls through to the next rung, and
   the least-bad candidate is kept only if every rung balloons. Every rung
   preserves the departure heading; a failure is returned as null and MUST be
   reported by the caller rather than papered over with a free-heading search. */
function routeLeg(a, b, c, d, seed, w, opt) {
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
  let bestSr = null, bestL = Infinity, capped = false;
  /* One rung: ε = 1 first; only if that runs out of budget, weighted searches.
     Budgets are generous because expansions are cheap (~1 µs): on Jewar →
     Mathura, tighter budgets pushed the leg to ε 1.6 and a route ~10 % costlier
     than ε 1.2 finds in 3 M expansions. A null at any step means the heap
     emptied — genuinely no route at this radius — and ends the rung at once;
     only budget exhaustion escalates. Costs vary 60× between open fields and
     towns, and a station inside a town makes the exact search spend its
     whole budget on the fields. Measured on a 104 km leg into a town: ε = 1
     exhausted 1.5 M states; ε = 1.2 found the same 109 km route in 6 431. */
  const solve = (ww, o) => {
    for (const [eps, cap] of [[1.0, 4e6], [1.2, 6e6], [1.6, 8e6]]) {
      const cand = search(a, {E:b.E,N:b.N}, ww, null,
                          Object.assign({}, opt, o, { epsilon: eps, expandCap: cap }));
      if (!cand || !cand.capped) return cand;
    }
    return { capped: true };
  };
  const ladder = (ww) => {
    for (const o of opts) {
      const cand = solve(ww, o);
      if (!cand) continue;
      if (cand.capped) { capped = true; continue; }
      let Lp = 0;
      for (let i = 1; i < cand.pts.length; i++)
        Lp += Math.hypot(cand.pts[i].E-cand.pts[i-1].E, cand.pts[i].N-cand.pts[i-1].N);
      if (Lp < bestL) { bestL = Lp; bestSr = cand; }
      if (Lp < direct*1.6 + 8000) return cand;
    }
    return null;
  };
  let got = ladder(w);
  if (got) return got;
  /* Every rung ran out of budget: search the same radius on a coarser lattice
     (fewer, longer steps — the radius guarantee is unaffected) before
     concluding anything about the geometry. */
  if (!bestSr && capped) {
    capped = false;
    got = ladder(Object.assign({}, w, { stride: (w.stride || 500) * 1.6 }));
    if (got) return got;
  }
  // Budget exhaustion alone is no evidence the geometry fails: do not relax.
  if (!bestSr && capped) return { capped: true };

  /* Station-throat relaxation — tried whenever the mainline radius produced no
     acceptable route: none at all, or only balloons. A 113 km loop to cover a
     14 km leg is not a route at the mainline radius; it is evidence that the
     mainline radius does not fit there. */
  /* Station-throat relaxation.
     Some control points cannot be reached at the mainline radius at all — a
     station set well off the corridor, with the legs either side of it turning
     hard, needs more longitudinal room than exists. Real practice is to take a
     local throat radius at the approach and cap line speed over it; HS2 into
     Euston is the same pattern. So rather than fail, retry the leg at a reduced
     radius and TAG it: the relaxation is reported, the speed profile picks up
     the tighter curve automatically, and the radius audit measures against the
     relaxed guarantee. The one thing it must never do is happen silently. */
  /* The balloon guard applies here too. It once did not, and a relaxed Luton →
     P2 leg came back 184.9 km long for 14.2 km of direct distance — accepted
     because it was the first relaxed route found, and it made the whole London
     circuit 105 km longer. A relaxed route that balloons falls through to the
     next, tighter rung; the least-bad one is kept only if every rung balloons. */
  let bestRelaxed = null, bestRelaxedL = Infinity;
  for (const f of [0.7, 0.5, 0.35]) {
    const wl = Object.assign({}, w, { rMin: w.rMin * f, stride: Math.max(50, w.stride * f) });
    for (const o of opts) {
      const cand = solve(wl, o);
      if (!cand || cand.capped) continue;
      cand.relaxed = f; cand.relaxedR = wl.rMin;
      let Lp = 0;
      for (let i = 1; i < cand.pts.length; i++)
        Lp += Math.hypot(cand.pts[i].E-cand.pts[i-1].E, cand.pts[i].N-cand.pts[i-1].N);
      if (Lp < direct*1.6 + 8000) return cand;
      if (Lp < bestRelaxedL) { bestRelaxedL = Lp; bestRelaxed = cand; }
    }
  }
  /* Every rung, mainline and relaxed, ballooned or failed: keep the shortest
     route found at all, mainline preferred on a tie. It is reported as found,
     and the leg table shows its length against the direct distance. */
  if (bestSr && (!bestRelaxed || bestL <= bestRelaxedL)) return bestSr;
  return bestRelaxed;
}

/**
 * Route a sequence of control points as ONE continuous alignment.
 *
 * Two things make this more than "solve each leg and join them up":
 *   (a) heading continuity — the arrival heading at an intermediate point is
 *       forced to be the departure heading of the next leg, so there is no kink
 *       where two legs meet;
 *   (b) look-ahead — each leg may only finish on a heading within a cone of the
 *       bearing to the point after next, so it arrives already pointing
 *       usefully. Without it the search is greedy and strands the next leg
 *       facing the wrong way.
 *
 * It is still sequential, so it is not globally optimal over the whole chain.
 * A single search carrying a waypoint index in the state would be, but the
 * state count makes that impractical in a browser. Stated here rather than
 * hidden.
 */
function searchChain(nodes, w, onProgress, opt) {
  opt = opt || {};
  const closed = !!opt.closed;
  const seq = closed ? nodes.concat([nodes[0]]) : nodes.slice();
  const passes = closed ? 2 : 1;
  let seed = null, out = null;

  for (let pass = 0; pass < passes; pass++) {
    const legs = [];
    let startAt = { E: seq[0].E, N: seq[0].N };
    let h = seed;
    for (let k = 0; k < seq.length - 1; k++) {
      const b = seq[k+1];
      const c = seq[k+2] || (closed ? seq[1] : null);
      const d = seq[k+3] || (closed ? seq[Math.min(2, seq.length-1)] : null);
      if (onProgress)
        onProgress(pass, passes, k, seq.length-1, `${seq[k].name} → ${b.name}`);
      /* A leg can carry its own weights: a bored tunnel passes UNDER the town,
         the creek and the sanctuary, so what lies on the surface costs it very
         little — the search must not route a tunnel around a city it would
         never have touched. opt.legWeights(k) supplies them, or null. */
      const wk = (opt.legWeights && opt.legWeights(k % nodes.length)) || w;
      const sr = routeLeg(startAt, b, c, d, h, wk, opt);
      if (sr && sr.capped) return { error: 'search budget exhausted',
                                    leg: `${seq[k].name} → ${b.name}`, legIndex: k, pass };
      if (!sr) return { error: 'no heading-continuous route',
                        leg: `${seq[k].name} → ${b.name}`, legIndex: k, pass };
      sr.from = seq[k]; sr.to = b;
      legs.push(sr);
      h = sr.endHeading;
      const last = sr.pts[sr.pts.length - 1];
      startAt = { E: last.E, N: last.N };       // continuity of POSITION too
    }
    const pts = legs[0].pts.slice();
    for (let k = 1; k < legs.length; k++) pts.push.apply(pts, legs[k].pts.slice(1));
    const rGuar = Math.min.apply(null, legs.map(l => l.rAchievable));
    const audit = auditRadius(pts, rGuar);
    if (audit && !audit.ok)
      return { error: 'radius audit failed', minR: audit.minR,
               chainage: audit.chainage, rAchievable: rGuar, pass };
    out = { legs, pts, closed, audit,
            relaxed: legs.filter(l => l.relaxed)
                         .map(l => ({ from: l.from.name, to: l.to.name,
                                      R: Math.round(l.rAchievable) })),
            expanded: legs.reduce((s,l)=>s+l.expanded,0),
            stride: Math.max.apply(null, legs.map(l => l.stride)),
            epsilon: Math.max.apply(null, legs.map(l => l.epsilon || 1)),
            rAchievable: rGuar, maxBuckets: legs[0].maxBuckets,
            endGap: legs[legs.length-1].endGap,
            states: legs.reduce((s,l)=>s+l.states,0) };
    seed = h;                                   // feed the closure back
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

/** Horizontal intersection points — a proxy for geometric complexity. */
function countHIP(R, rMin) {
  let n = 0, sign = 0;
  for (let i = 0; i < R.length; i++) {
    const s = (isFinite(R[i]) && Math.abs(R[i]) < rMin * 6) ? Math.sign(R[i]) : 0;
    if (s !== sign) { if (s !== 0) n++; sign = s; }
  }
  return n;
}

/* --------------------------------------------------- VERTICAL ALIGNMENT --- */
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
      const q = Math.max(0, Math.min(n - 1, i + j));
      acc += a[q] * k[j+r];
    }
    out[i] = acc;
  }
  return out;
}

/** Tightest crest and sag radii present in a profile: Rv = ds²/|z''|.
    skip(i), if given, leaves sample i out (an existing design's own curves). */
function verticalRadii(z, ds, skip) {
  let crest = 0, sag = 0;                        // max |z''| of each sign
  for (let i = 1; i < z.length - 1; i++) {
    if (skip && skip(i)) continue;
    const c = z[i-1] - 2*z[i] + z[i+1];
    if (c < 0) { if (-c > crest) crest = -c; }
    else if (c > sag) sag = c;
  }
  return { crest: crest > 1e-12 ? ds*ds/crest : Infinity,
           sag:   sag   > 1e-12 ? ds*ds/sag   : Infinity };
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

/* Gradient clamp with tie points.
   The ruling gradient is a Lipschitz condition, so a pinned level at chainage
   s_p bounds the profile everywhere: z(s) ≤ z_p + g·|s − s_p| and
   z(s) ≥ z_p − g·|s − s_p|. Building those two envelopes with a forward and a
   backward sweep and clamping into them puts the whole consequence of the pin
   in place in O(n) — the descent starts exactly as far back as it has to.

   This replaces trying to let the pin propagate through the curvature
   relaxation. That does converge in theory, but diffusion travels like √iters,
   so a 250 m descent at 2.5 % — 400 samples — needed on the order of 160 000
   iterations and simply never arrived. */
/* `bounds` ({lo, hi}, per-sample arrays, ±Infinity where free) carries the
   vertical POLICY: rail at least so far above ground on a viaduct, at least so
   far below the ground or the creek bed in a tunnel, or exactly a given design
   level. A bound is a box constraint — convex like the rest — and goes into the
   same envelopes as a pin, so its consequence also arrives in O(n): a tunnel
   that must be 30 m under the creek starts its descent exactly as far back as
   the ruling gradient requires. Two bounds the gradient cannot reconcile leave
   lo > hi; the clamp then honours the upper one and the caller reports the
   shortfall rather than hiding it. */
function clampGradePinned(z, ds, maxGradePct, pins, bounds) {
  const n = z.length, lim = maxGradePct / 100 * ds;
  if ((!pins || !pins.length) && !bounds) return clampGrade(z, ds, maxGradePct);
  const hi = bounds ? Float64Array.from(bounds.hi) : new Float64Array(n).fill(Infinity);
  const lo = bounds ? Float64Array.from(bounds.lo) : new Float64Array(n).fill(-Infinity);
  for (const p of (pins || [])) {
    if (p.z < hi[p.i]) hi[p.i] = p.z;
    if (p.z > lo[p.i]) lo[p.i] = p.z;
  }
  for (let i = 1; i < n; i++) {
    if (hi[i-1] + lim < hi[i]) hi[i] = hi[i-1] + lim;
    if (lo[i-1] - lim > lo[i]) lo[i] = lo[i-1] - lim;
  }
  for (let i = n - 2; i >= 0; i--) {
    if (hi[i+1] + lim < hi[i]) hi[i] = hi[i+1] + lim;
    if (lo[i+1] - lim > lo[i]) lo[i] = lo[i+1] - lim;
  }
  // Two rounds of {envelope, sweep} — both are projections, and they agree fast.
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < n; i++) {
      if (z[i] > hi[i]) z[i] = hi[i];
      else if (z[i] < lo[i]) z[i] = lo[i];
    }
    clampGrade(z, ds, maxGradePct);
  }
  if (bounds) {
    /* Where lo > hi (two requirements the gradient cannot reconcile) the
       upper one wins outright — it is where a given level or a tunnel's cover
       sits. The else-if form below lands on lo whenever z starts under both,
       which over-rode given levels; it is kept for the classic fit, which
       must not change. */
    for (let i = 0; i < n; i++) z[i] = Math.min(Math.max(z[i], lo[i]), hi[i]);
    return z;
  }
  for (let i = 0; i < n; i++) {
    if (z[i] > hi[i]) z[i] = hi[i];
    else if (z[i] < lo[i]) z[i] = lo[i];
  }
  return z;
}

/* ---------------------------------------------------------------------------
   Fit the design profile to the ground.

   The feasible set is { crest R ≥ Rc } ∩ { sag R ≥ Rs } ∩ { |z'| ≤ ruling
   gradient }. All three are convex, and what we want is the profile inside that
   set which stays closest to the ground, because deviation from ground IS the
   earthworks bill.

   Method: alternating projection (POCS). Start at the ground and repeatedly
     · remove only the EXCESS curvature, wherever a vertical curve is tighter
       than the standard allows — c = z[i−1] − 2z[i] + z[i+1] is ds²/R, so the
       correction is local and proportional to how far out of standard it is;
     · clamp the gradient.
   Both are projections onto convex sets, so the iteration converges into the
   intersection, and because it only ever corrects violations it leaves the
   profile sitting on the ground everywhere the ground is already good enough.

   Two approaches that do NOT work, and why, so they are not tried again:
     · Global Gaussian smoothing with the bandwidth binary-searched to satisfy
       the curvature limit. It satisfies the constraint, but it flattens the
       whole profile including the stretches that never violated anything —
       measured 135 m of cut on terrain that only needed 40.
     · Relaxing toward the local mean with a spring back to ground and clamping
       afterwards. At equilibrium that is a spring of characteristic length
       ds/√(2·pull), so the profile tracks every terrain bump and the clamp is
       undone by the next spring step.
   The Gaussian fit is kept as the fallback for the case where the corridor
   simply cannot be made compliant, so the tool always returns something and
   reports the shortfall rather than looping.
--------------------------------------------------------------------------- */
/* opt.policy (from policyFor) changes WHAT the profile stays close to and
   adds bounds: it is still the same projection, only the seed is the policy's
   target level (ground + typical viaduct clearance, a tunnel line under the
   ground) instead of the ground, and the box bounds join the gradient
   envelopes. With no policy the code path is exactly the ground-following fit
   it always was — the validation anchors depend on that. */
function verticalProfile(P, w, opt) {
  opt = opt || {};
  const n = P.length;
  const ds = n > 1 ? (P[n-1].s - P[0].s) / (n - 1) : 1;
  const ground = opt.ground || new Float64Array(n);
  if (!opt.ground) for (let i = 0; i < n; i++) ground[i] = sampleBilinear('dem', P[i].E, P[i].N);
  const pol = opt.policy || null;
  const target = pol ? pol.target : ground;

  const wantC = w.vCrestR, wantS = w.vSagR === undefined ? w.vCrestR : w.vSagR;
  const limC = ds * ds / wantC;              // greatest allowed |z''| on a crest
  const limS = ds * ds / wantS;

  /* Tie points. A terminus or a station cannot float in the air, so its design
     level is PINNED to the ground and treated as a third convex set the
     projection has to satisfy — an affine subspace. Pinning matters more than it
     sounds: without it the fitter is purely local, and on this demo corridor it
     happily finished 249 m above the ground at the terminus because the ruling
     gradient would not let it descend in the last kilometre. Pinned, the same
     constraint propagates backwards and the descent simply starts earlier. */
  const pins = [];
  for (const t of (opt.tie || [])) {
    const i0 = Math.max(0, Math.min(n - 1, t.idx));
    // an untold level ties to the policy's level there (ground, unless the
    // line is elevated or underground at that end)
    pins.push({ i: i0, z: t.level === undefined ? target[i0] : t.level });
  }
  /* The raw bounds are first opened just enough to admit each pin, then
     shaped. (Not closed ONTO the pins: a crest parabola hung from a portal
     would forbid leaving it on a straight grade, which is perfectly legal.)
     Where a pin still ends up outside the shaped bounds — a portal next to a
     creek sag deeper than a standard curve can leave in the distance
     available — the bounds give way around the pin over a ramp at the ruling
     gradient: a fixed level is a design decision and wins, and the policy
     shortfall beside it is reported. */
  let bounds = null;
  if (pol) {
    const lo0 = Float64Array.from(pol.lo), hi0 = Float64Array.from(pol.hi);
    for (const p of pins) { lo0[p.i] = Math.min(lo0[p.i], p.z); hi0[p.i] = Math.max(hi0[p.i], p.z); }
    bounds = shapeBounds(lo0, hi0, ds, w.maxGrade, wantC, wantS);
    /* Give way smoothly: subtract (or add) a raised-cosine bump just deep
       enough to admit the pin, wide enough that its own curvature stays
       inside the standard radius and its slope inside the gradient. Cutting
       the bound away outright left a step at the edge of the cut — a corner
       the profile had to follow (crest R 710 m on the demo). */
    const g = w.maxGrade / 100, Rmin = Math.min(wantC, wantS);
    for (const p of pins) {
      const dLo = bounds.lo[p.i] - p.z, dHi = p.z - bounds.hi[p.i];
      const out = Math.max(dLo, dHi, 0);
      if (out < 0.01) continue;
      const halfM = Math.max(Math.PI * Math.sqrt(out * Rmin / 2), Math.PI * out / (2 * g * 0.8));
      const half = Math.ceil(halfM / ds) + 2;
      for (let k = Math.max(0, p.i - half); k <= Math.min(n - 1, p.i + half); k++) {
        const b = 0.5 * (1 + Math.cos(Math.PI * (k - p.i) / half)) * (out + 0.01);
        if (dLo > 0) bounds.lo[k] -= b;
        if (dHi > 0) bounds.hi[k] += b;
      }
    }
    /* Shaping can leave lo above hi where two policies meet over too short a
       ramp. No level satisfies both there; clamping would make the profile
       jump between them (a 358 % "grade" on the first test). Release both at
       those samples — the raw policy is still what the shortfall is measured
       against, so it is reported, not hidden. */
    // given levels (lo = hi in the policy) are restored exactly and never released
    const fixedAt = i => isFinite(pol.lo[i]) && pol.lo[i] === pol.hi[i];
    for (let i = 0; i < n; i++) {
      if (fixedAt(i)) { bounds.lo[i] = bounds.hi[i] = pol.lo[i]; continue; }
      if (bounds.lo[i] > bounds.hi[i]) { bounds.lo[i] = -Infinity; bounds.hi[i] = Infinity; }
    }
  }

  /* Seed from the ground with the DEM's own sampling noise taken off — a 25 m
     resample of a 50 m grid carries steps that are an artefact of the data, not
     terrain, and they would otherwise drive thousands of iterations. */
  let z = gaussSmooth(target, Math.max(1, (G.cell * 1.2) / ds));
  clampGradePinned(z, ds, w.maxGrade, pins, bounds);
  const pinnedEnd0 = pins.some(p => p.i === 0), pinnedEnd1 = pins.some(p => p.i === n - 1);
  /* Under a policy, excess curvature AT a pin is taken out of its neighbours
     (the pin cannot move): otherwise the correction is undone at once and the
     corner on a tie point never leaves — the arms either side are each within
     the limit, so nothing else ever moves either. */
  const isPin = bounds ? new Uint8Array(n) : null;
  if (isPin) for (const p of pins) isPin[p.i] = 1;
  /* Given levels are fixed points too. Their own curvature is the existing
     design's, judged against the standard where it is reported, not by the
     fitter — so a sample whose whole stencil is given is left out of the
     curvature pass and of the radius checks. That keeps the standard radius
     for everything the tool designs itself, instead of opening it for the
     whole line to admit the design's 25 km curves. */
  const fixedRun = bounds ? new Uint8Array(n) : null;
  if (bounds) for (let i = 0; i < n; i++)
    if (isFinite(pol.lo[i]) && pol.lo[i] === pol.hi[i]) { isPin[i] = 1; fixedRun[i] = 1; }
  const inside = i => fixedRun && fixedRun[i - 1] && fixedRun[i] && fixedRun[i + 1];
  const armFix = [];
  let nz = new Float64Array(n);
  const RELAX = 0.7;
  let it = 0;
  for (; it < 4000; it++) {
    nz.set(z);
    let worst = 0;
    armFix.length = 0;
    for (let i = 1; i < n - 1; i++) {
      if (fixedRun && inside(i)) continue;
      const c = z[i-1] - 2*z[i] + z[i+1];
      let ex = 0;
      if (c > limS) ex = c - limS;
      else if (c < -limC) ex = c + limC;
      if (ex !== 0) {
        if (isPin && isPin[i]) armFix.push(i, ex);
        else nz[i] = z[i] + 0.5 * ex * RELAX;
        const rel = Math.abs(ex) / Math.max(limC, limS, 1e-12);
        if (rel > worst) worst = rel;
      }
    }
    for (let k = 0; k < armFix.length; k += 2) {
      const i = armFix[k], d = -0.25 * armFix[k + 1] * RELAX;
      if (!isPin[i - 1]) nz[i - 1] += d;
      if (!isPin[i + 1]) nz[i + 1] += d;
    }
    const t = z; z = nz; nz = t;
    /* With bounds, clamp into the box every pass, not every 32nd: the curvature
       step and a bound meet at every viaduct pier over a road embankment, and
       clamping each pass lets the line settle over the obstruction like a stiff
       beam over a support instead of being knocked back up once in 32 steps. */
    if (bounds) {
      /* The curvature pass never moves the two end samples, so an unpinned
         end stayed wherever the seed put it and anchored the short stub the
         search leaves past the terminus — a corner on the end tie. Under a
         policy an unpinned end simply continues the line (zero curvature). */
      if (n > 3) {
        if (!pinnedEnd0) z[0] = 2 * z[1] - z[2];
        if (!pinnedEnd1) z[n-1] = 2 * z[n-2] - z[n-3];
      }
      clampBox(z, bounds.lo, bounds.hi);
      // and hold the pins every pass too, so the line settles smoothly THROUGH
      // them instead of being snapped onto them once in 32 steps — the snap is
      // what left a corner on the end tie (crest 509 m on the demo). Only
      // under a policy: the classic fit keeps its exact historical behaviour.
      for (const p of pins) z[p.i] = p.z;
    }
    if ((it & 31) === 31) {
      clampGradePinned(z, ds, w.maxGrade, pins, bounds);
      if (worst < 0.02) break;
    }
  }
  /* Final projection, then measure. If a pin still cannot be honoured, the
     corridor genuinely cannot reach that level within the ruling gradient, and
     that is a finding to report, not a number to quietly round away. */
  clampGradePinned(z, ds, w.maxGrade, pins, bounds);
  let tieError = 0, tieAt = null;
  for (const p of pins) {
    const e = Math.abs(z[p.i] - p.z);
    if (e > tieError) { tieError = e; tieAt = p.i; }
  }

  /* Verify, and fall back to the bandwidth fit if the projection could not get
     inside the feasible set — better a flat compliant profile plus an honest
     number on screen than a profile that quietly breaks the standard. */
  const radii = q => fixedRun ? verticalRadii(q, ds, inside) : verticalRadii(q, ds);
  let rv0 = radii(z);
  let sigma = 0, method = 'projection';
  if (rv0.crest < wantC * 0.9 || rv0.sag < wantS * 0.9) {
    const trial = sig =>
      clampGradePinned(gaussSmooth(target, sig / ds), ds, w.maxGrade, pins, bounds);
    const ok = q => { const r = radii(q); return r.crest >= wantC && r.sag >= wantS; };
    let lo = ds, hi = Math.max(4000, Math.min(60000, P[n-1].s * 0.25));
    if (!ok(trial(hi))) lo = hi;
    else for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (ok(trial(mid))) hi = mid; else lo = mid;
    }
    const zb = trial(hi); clampGradePinned(zb, ds, w.maxGrade, pins, bounds);
    /* Under a policy the bounds can put the kinks straight back into a
       smoothed profile (a viaduct must clear every embankment it crosses), and
       then the "fallback" is worse than the projection it replaces. Keep
       whichever comes closer to the standard; without bounds this is the
       bandwidth fit, as it always was. */
    const fit = q => { const r = radii(q); return Math.min(r.crest / wantC, r.sag / wantS); };
    if (!bounds || fit(zb) >= fit(z)) { sigma = hi; z = zb; method = 'bandwidth'; }
  }
  // measured against the policy as asked for — not the shaped bounds, which
  // were deliberately opened where the policy could not be met
  let boundError = 0, boundAt = null, boundShort = 0;
  if (pol) for (let i = 0; i < n; i++) {
    const e = Math.max(pol.lo[i] - z[i], z[i] - pol.hi[i], 0);
    if (e > 0.05) boundShort += ds;
    if (e > boundError) { boundError = e; boundAt = i; }
  }

  const grade = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) grade[i] = (z[i+1] - z[i-1]) / (2*ds) * 100;
  grade[0] = grade[1]; grade[n-1] = grade[n-2];

  const diff = new Float64Array(n);
  for (let i = 0; i < n; i++) diff[i] = z[i] - ground[i];   // + = fill, − = cut

  const rv = radii(z);
  let vip = 0, gsign = 0;
  for (let i = 1; i < n; i++) {
    const s = Math.abs(grade[i]) < 0.05 ? 0 : Math.sign(grade[i]);
    if (s !== gsign) { if (s !== 0) vip++; gsign = s; }
  }
  return { z, ground, grade, diff, ds, sigma, vip, method, iterations: it,
           tieError, tieAt, pins: pins.length,
           boundError, boundAt, boundShort, policy: pol,
           minCrestR: rv.crest, minSagR: rv.sag };
}

/* Make the bounds something a compliant profile can actually rest on.

   A raw lower bound (ground + clearance) has every corner the ground has; a
   viaduct pressed against it inherits them, and the vertical curves came out
   at a quarter of the standard on the demo escarpment (crest 5.7 km against
   21.9 km). Smoothing the profile cannot help — the bound holds it up at the
   corner. So the bound is rounded first, the way the line would be:
     · the lower bound is spread at the ruling gradient (no profile can fall
       away from a high point faster than that anyway), then dilated by a
       crest parabola of the standard radius — max over y of
       lo(y) − (x−y)²/2R — so wherever it binds, it is itself a legal crest;
     · the upper bound, mirror image, with sag parabolas.
   The dilation is a little stronger than strictly necessary (it hangs the
   parabola symmetrically over each obstruction where a tilted one would do),
   which costs a few decimetres of height over a crossing — the price of a
   feasible set the projection can reach. Sags against a lower bound and
   crests under an upper bound need no help: the profile clears them by
   moving away from the bound, which the bound allows. */
function shapeBounds(lo0, hi0, ds, maxGradePct, Rc, Rs) {
  const n = lo0.length, lim = maxGradePct / 100 * ds;
  const lo = Float64Array.from(lo0), hi = Float64Array.from(hi0);
  for (let i = 1; i < n; i++) {
    if (lo[i-1] - lim > lo[i]) lo[i] = lo[i-1] - lim;
    if (hi[i-1] + lim < hi[i]) hi[i] = hi[i-1] + lim;
  }
  for (let i = n - 2; i >= 0; i--) {
    if (lo[i+1] - lim > lo[i]) lo[i] = lo[i+1] - lim;
    if (hi[i+1] + lim < hi[i]) hi[i] = hi[i+1] + lim;
  }
  const parab = (src, R, sign) => {
    // sign +1: dilate with a crest parabola (max of y − d²/2R); −1: erode with a sag one
    let fmin = Infinity, fmax = -Infinity;
    for (let i = 0; i < n; i++) if (isFinite(src[i])) { if (src[i] < fmin) fmin = src[i]; if (src[i] > fmax) fmax = src[i]; }
    if (!isFinite(fmin) || fmax - fmin < 1e-6) return src;
    const win = Math.min(n, Math.ceil(Math.sqrt(2 * R * (fmax - fmin)) / ds) + 1);
    const k = new Float64Array(win + 1);
    for (let d = 0; d <= win; d++) k[d] = (d * ds) * (d * ds) / (2 * R);
    const out = Float64Array.from(src);
    for (let i = 0; i < n; i++) {
      if (!isFinite(src[i])) continue;
      const a = Math.max(0, i - win), b = Math.min(n - 1, i + win);
      let best = out[i];
      for (let j = a; j <= b; j++) {
        const v = src[j];
        if (!isFinite(v)) continue;
        const d = j > i ? j - i : i - j;
        if (sign > 0) { const c = v - k[d]; if (c > best) best = c; }
        else          { const c = v + k[d]; if (c < best) best = c; }
      }
      out[i] = best;
    }
    return out;
  };
  return { lo: parab(lo, Rc, +1), hi: parab(hi, Rs, -1) };
}

function clampBox(z, lo, hi) {
  for (let i = 0; i < z.length; i++) {
    if (z[i] > hi[i]) z[i] = hi[i];
    else if (z[i] < lo[i]) z[i] = lo[i];
  }
}

/* ---------------------------------------------------- VERTICAL POLICY --- */
/* What the vertical profile is asked to do, sample by sample.

   'ground'    follow the ground — earthworks, the classic fit (and the default:
               with every leg on 'ground' and nothing given, policyFor returns
               null and the fitter runs exactly as it always has).
   'elevated'  viaduct by default: target rail level = ground + typical
               clearance, and never below ground + minimum clearance. Indian
               high-speed practice — 1,531 surveyed piers on MAHSR S5 put rail
               8.1 m above ground at the least and 11.75 m at the median, the
               minimum reached at the sag of every grade, i.e. the grade line is
               set to just clear the ground plus a pier.
   'tunnel'    bored: rail at least `depth` below the ground — or below the
               creek bed, where the DEM's surface is water and the bed lies
               `waterDepth` further down (the DEM has no bathymetry). The target
               is the straight grade between the tunnel's two ends, pulled down
               only where the cover demands it — so under a hill the tunnel does
               not climb into the hill (the BKC – Shilphata tunnel is 114 m
               under Parsik hill for that reason) and under a creek it dives.
   given       a design level fixed by the existing design: lo = hi = level.

   A change of policy needs a ramp — a viaduct cannot become a tunnel in one
   sample — so for a ramp length either side of the change the bounds are
   lifted and the target blends linearly; the structure classifier then names
   the ramp by what it is (embankment, cutting, U-trough as cutting).

   spec = { leg: [policy per sample], params: { clearMin, clearTyp, depth,
            waterDepth, rampGrade }, given: Float64Array | null (NaN = free),
            water: Float64Array | null (water coverage per sample) }          */
function policyFor(P, ground, spec) {
  const n = P.length;
  const leg = spec.leg, pr = spec.params, given = spec.given;
  const ds = n > 1 ? (P[n-1].s - P[0].s) / (n - 1) : 1;
  /* A fixed level alone (an underground station on an otherwise ordinary
     line) also needs the policy path: the classic fit would meet it with a
     corner — sag R 500 m against a 35.8 km standard, found in review. */
  let any = !!given || !!(spec.pinAt && spec.pinAt.some(isFinite));
  for (let i = 0; i < n && !any; i++) if (leg[i] !== 'ground') any = true;
  if (!any) return null;
  const warnings = [];

  const off = new Float64Array(n);              // desired level relative to ground
  const surf = new Float64Array(n);             // what tunnel cover is measured from
  for (let i = 0; i < n; i++) {
    const wet = spec.water ? spec.water[i] : 0;
    surf[i] = ground[i] - (wet > 0.5 ? pr.waterDepth : 0);
    off[i] = leg[i] === 'elevated' ? pr.clearTyp : leg[i] === 'tunnel' ? -pr.depth : 0;
  }
  const target = new Float64Array(n), lo = new Float64Array(n), hi = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    target[i] = leg[i] === 'tunnel' ? surf[i] - pr.depth : ground[i] + off[i];
    lo[i] = leg[i] === 'elevated' ? ground[i] + pr.clearMin : -Infinity;
    hi[i] = leg[i] === 'tunnel' ? surf[i] - pr.depth : Infinity;
  }
  /* Tunnel target: the chord between the run's end levels, pulled down to the
     cover line where it has to be. Ends are the given level or a pin if there
     is one, otherwise the cover line itself. */
  for (let i = 0; i < n; ) {
    if (leg[i] !== 'tunnel') { i++; continue; }
    let j = i; while (j + 1 < n && leg[j + 1] === 'tunnel') j++;
    const za = given && isFinite(given[i]) ? given[i] : spec.pinAt && isFinite(spec.pinAt[i]) ? spec.pinAt[i] : target[i];
    const zb = given && isFinite(given[j]) ? given[j] : spec.pinAt && isFinite(spec.pinAt[j]) ? spec.pinAt[j] : target[j];
    for (let k = i; k <= j; k++) {
      const chord = j > i ? za + (zb - za) * (k - i) / (j - i) : za;
      target[k] = Math.min(chord, hi[k]);
    }
    i = j + 1;
  }
  /* Ramps at each change of policy: long enough to make the change at a
     fraction of the ruling gradient AND to get into and out of that grade on
     vertical curves of the standard radius (2·R·g), centred on the change. A
     ramp sized on the gradient alone left the viaduct's and the tunnel's
     rounded bounds overlapping in the middle of it. */
  const g = Math.max(0.1, pr.rampGrade) / 100, Rv = pr.rampR || 0;
  const runs = [];
  for (let i = 0; i < n; ) { let j = i; while (j + 1 < n && leg[j + 1] === leg[i]) j++; runs.push([i, j]); i = j + 1; }
  const runLen = r => r[1] - r[0] + 1;
  /* A ramp may take at most 40 % of either policy stretch it joins, so a
     short stretch keeps some of its policy — and when it cannot keep its
     policy that shows as a measured shortfall. Released whole, a 3 km viaduct
     between two tunnels used to vanish into its ramps unreported. */
  const capRamp = (half, lenA, lenB, s, from, to) => {
    const cap = Math.max(2, Math.floor(0.4 * Math.min(lenA, lenB)));
    if (half <= cap) return half;
    warnings.push(`${from} → ${to} at ${(s / 1000).toFixed(2)} km: the change needs ` +
                  `${(2 * half * ds / 1000).toFixed(1)} km of ramp, the stretches either side allow ` +
                  `${(2 * cap * ds / 1000).toFixed(1)} km`);
    return cap;
  };
  const blend = (idx, ta, tb) => {          // linear target over a list of sample indices
    for (let q = 0; q < idx.length; q++) {
      const k = idx[q];
      if (given && isFinite(given[k])) continue;
      target[k] = ta + (tb - ta) * q / Math.max(1, idx.length - 1);
      lo[k] = -Infinity; hi[k] = Infinity;
    }
  };
  for (let r = 1; r < runs.length; r++) {
    const i = runs[r][0];
    const dz = Math.abs(target[i] - target[i - 1]);
    let half = Math.ceil((dz / g + 2 * Rv * g) / ds / 2) + 2;
    half = capRamp(half, runLen(runs[r - 1]), runLen(runs[r]), P[i].s, leg[i - 1], leg[i]);
    const a = Math.max(0, i - half), b = Math.min(n - 1, i + half);
    const idx = []; for (let k = a; k <= b; k++) idx.push(k);
    blend(idx, target[a], target[b]);
  }
  /* A closed loop's seam is a change of policy too (the closing leg meets the
     first): ramp across the wrap, with the two end samples — the same point on
     the ground — given the same level. Without it the loop did not close: a
     42 m step at the seam in review. */
  if (spec.closed && runs.length > 1 && leg[0] !== leg[n - 1]) {
    const dz = Math.abs(target[0] - target[n - 1]);
    let half = Math.ceil((dz / g + 2 * Rv * g) / ds / 2) + 2;
    half = capRamp(half, runLen(runs[0]), runLen(runs[runs.length - 1]), 0, leg[n - 1], leg[0]);
    const idx = [];
    for (let k = n - 1 - half; k <= n - 1; k++) idx.push(k);   // ... n-1 ≡ 0 ...
    for (let k = 1; k <= half; k++) idx.push(k);
    blend(idx, target[n - 1 - half], target[half]);
    target[0] = target[n - 1]; lo[0] = lo[n - 1]; hi[0] = hi[n - 1];
  }
  /* A level fixed at a control point wins over the leg's policy around it:
     an underground station box sits shallower than the running tunnel's
     cover, a portal is at the surface. Lift the bounds over a ramp either
     side and lead the target into the fixed level on a smoothstep — level at
     the fixed point (a platform is level), and long enough that its own
     curvature, 6·Δ/L², is inside the standard radius. A straight V into the
     pin was a corner the fitter could not remove (sag R 2.2 km in review). */
  if (spec.pinAt) for (let i = 0; i < n; i++) {
    const pz = spec.pinAt[i];
    if (!isFinite(pz)) continue;
    const dz = Math.abs(pz - target[i]);
    const Lm = Math.max(dz / g * 1.5, Rv > 0 ? Math.sqrt(6 * dz * Rv) * 1.15 : 0, 2 * ds);
    const half = Math.ceil(Lm / ds) + 2;
    const a = Math.max(0, i - half), b = Math.min(n - 1, i + half);
    const ta = target[a], tb = target[b];
    const S = t => t * t * (3 - 2 * t);
    for (let k = a; k <= b; k++) {
      if (given && isFinite(given[k])) continue;
      target[k] = k <= i ? pz + (ta - pz) * S((i - k) / Math.max(1, i - a))
                         : pz + (tb - pz) * S((k - i) / Math.max(1, b - i));
      lo[k] = -Infinity; hi[k] = Infinity;
    }
  }
  /* The ends of a stretch of given levels are fixed levels too, and get the
     same ramp beside them: the existing design's levels must meet the
     policy's estimate somewhere, and without room to do it the viaduct's
     clearance (spread at the ruling gradient) collided with the given levels
     and overrode them — 64 m out on the first test. */
  if (given) {
    /* Leaving a given stretch, the target first CONTINUES the given grade and
       then eases (smoothstep) into the policy's level — so the seed has no
       corner where the existing design's levels stop. */
    const pol0 = Float64Array.from(target);
    const S = t => t * t * (3 - 2 * t);
    for (let i = 0; i < n; i++) {
      if (!isFinite(given[i])) continue;
      const isStart = i === 0 || !isFinite(given[i - 1]), isEnd = i === n - 1 || !isFinite(given[i + 1]);
      if (!isStart && !isEnd) continue;
      const dir = isStart ? -1 : 1;
      const back = i - dir;                        // the given sample behind the end
      const slope = back >= 0 && back < n && isFinite(given[back]) ? given[i] - given[back] : 0;
      const dz = Math.abs(given[i] - pol0[i]);
      const Lm = Math.max(dz / g * 1.5, Rv > 0 ? Math.sqrt(6 * dz * Rv) * 1.15 : 0, 2 * ds);
      const far = Math.min(n - 1, Math.max(0, i + dir * (Math.ceil(Lm / ds) + 2)));
      for (let k = i + dir; dir < 0 ? k >= far : k <= far; k += dir) {
        if (isFinite(given[k])) break;
        const steps = (k - i) * dir, f = steps / Math.max(1, (far - i) * dir);
        const ext = given[i] + slope * steps;
        target[k] = ext + (pol0[k] - ext) * S(f);
        lo[k] = -Infinity; hi[k] = Infinity;
      }
    }
    for (let i = 0; i < n; i++) {
      if (!isFinite(given[i])) continue;
      target[i] = lo[i] = hi[i] = given[i];
    }
  }
  return { target, lo, hi, leg, params: pr, surf, warnings,
           givenCount: given ? given.filter(isFinite).length : 0 };
}

/* -------------------------------------------------- STRUCTURE SELECTION --- */
/* Colour language: everything BELOW ground in reds (tunnel dark, cutting
   light), everything ABOVE ground in blues (viaduct dark, bridge medium,
   embankment light), at grade neutral grey-green — so the parts of the route
   that will be visible in the landscape read at a glance. */
const STRUCT = {
  TUNNEL:     { id: 'tunnel',     label: 'Tunnel',       colour: '#8e2020' },
  CUTTING:    { id: 'cutting',    label: 'Cutting',      colour: '#d98880' },
  EMBANKMENT: { id: 'embankment', label: 'Embankment',   colour: '#85b8dc' },
  BRIDGE:     { id: 'bridge',     label: 'Bridge',       colour: '#2e86c1' },
  VIADUCT:    { id: 'viaduct',    label: 'Viaduct',      colour: '#1a4e8a' },
  ATGRADE:    { id: 'atgrade',    label: 'At grade',     colour: '#6f7f6f' },
};

/* Thresholds are where earthworks stop being cheaper than a structure, so they
   properly belong to the rate table, not to a constant. A road tolerates far
   deeper cuttings than a railway before tunnelling wins, because road tunnels
   carry ventilation and life-safety costs a cutting does not. */
function structureThresholds(std) {
  const road = std.family === 'road';
  return {
    fillViaduct: road ? 14 : 8,
    cutTunnel:   road ? 28 : 16,
    builtTunnel: 0.30,
    protectedTunnel: 0.70,
    minRun: 200,
  };
}

function classifyStructures(P, vp, t, declared) {
  const n = P.length, out = new Array(n);
  const hasWater = has('water_body') || has('river_major');
  const pol = vp.policy, pr = pol && pol.params;
  for (let i = 0; i < n; i++) {
    /* What an existing design SAYS it builds wins over what the levels
       suggest: a station or a special span reads as neither from cut/fill. */
    if (declared && declared[i]) { out[i] = declared[i]; continue; }
    const d = vp.diff[i];
    const built = sample('built', P[i].E, P[i].N);
    const prot  = sample('protected', P[i].E, P[i].N);
    const river = hasWater
      ? sample('river_major', P[i].E, P[i].N) + sample('water_body', P[i].E, P[i].N) : 0;

    /* Under a policy the intent is known: an elevated line that is a few
       metres up is still a viaduct (short piers), not an embankment, and a
       tunnel leg that is properly under cover is a tunnel even where the cover
       is less than a cutting would need. Ramps fall through to the rules. */
    const leg = pol ? pol.leg[i] : 'ground';
    const free = pol && !isFinite(pol.lo[i]) && !isFinite(pol.hi[i]);
    if (leg === 'elevated' && !free && d >= Math.min(t.fillViaduct, pr.clearMin * 0.75)) {
      out[i] = river > 0.05 ? STRUCT.BRIDGE : STRUCT.VIADUCT; continue;
    }
    if (leg === 'tunnel' && !free && -(vp.z[i] - pol.surf[i]) >= Math.min(t.cutTunnel, pr.depth * 0.6)) {
      out[i] = STRUCT.TUNNEL; continue;
    }

    /* Order matters. What the alignment is doing relative to the ground is
       decided FIRST, because a sensitive-land rule cannot tunnel a formation
       that is 250 m in the air — that mis-ordering classified gorge crossings
       as tunnel and hid a quarter of the viaduct on this corridor. */
    let s;
    if (d >= t.fillViaduct)                 s = river > 0.05 ? STRUCT.BRIDGE : STRUCT.VIADUCT;
    else if (built >= t.builtTunnel || prot >= t.protectedTunnel) s = STRUCT.TUNNEL;
    else if (-d >= t.cutTunnel)             s = STRUCT.TUNNEL;
    else if (river > 0.05 && d > -2)        s = STRUCT.BRIDGE;
    else if (d >= 1.5)                      s = STRUCT.EMBANKMENT;
    else if (d <= -1.5)                     s = STRUCT.CUTTING;
    else                                    s = STRUCT.ATGRADE;
    out[i] = s;
  }
  /* Absorb runs too short to build — nobody constructs 3 m of tunnel. But a
     short run that is DEEP is a real structure, not a discretisation artefact:
     a 150 m viaduct over a gorge is exactly the thing a corridor study must
     price, so only marginal runs are absorbed. */
  const minRun = Math.max(2, Math.round(t.minRun / vp.ds));
  let i = 0;
  while (i < n) {
    let j = i; while (j < n && out[j] === out[i]) j++;
    // a declared structure is built as declared, however short
    if (j - i < minRun && i > 0 && !(declared && declared[i])) {
      let peak = 0;
      for (let k = i; k < j; k++) peak = Math.max(peak, Math.abs(vp.diff[k]));
      const marginal = out[i] === STRUCT.VIADUCT ? peak < t.fillViaduct * 1.8
                     : out[i] === STRUCT.TUNNEL  ? peak < t.cutTunnel * 1.8
                     : true;
      if (marginal) for (let k = i; k < j; k++) out[k] = out[i-1];
    }
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

/* ------------------------------------------------------- SPEED PROFILE --- */
/* Curve-limited speed, then a stop-limited accel/brake envelope, then a
   forward/backward pass so the profile is kinematically achievable.

   opts.curveSpeed(R) -> km/h is supplied by the mode, so a road is limited by
   side friction and a maglev by bank angle without this routine knowing the
   difference.                                                                */
function speedProfile(P, R, opts) {
  const n = P.length, ds = n > 1 ? (P[n-1].s - P[0].s) / (n - 1) : 1;
  const vmax = opts.vmax / 3.6, a = opts.accel, b = opts.brake;
  const L = P[n-1].s;
  const cs = opts.curveSpeed || (() => Infinity);

  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = Math.abs(R[i]);
    let vCurve = Infinity;
    if (isFinite(r) && r > 1) vCurve = cs(r) / 3.6;
    v[i] = Math.min(vmax, vCurve);
  }

  const stops = (opts.stops && opts.stops.length) ? opts.stops.slice() : [0, L];
  if (stops[0] > 1) stops.unshift(0);
  if (stops[stops.length-1] < L - 1) stops.push(L);
  let stopIdx = stops.map(s => Math.max(0, Math.min(n-1, Math.round(s / ds))));
  stopIdx.sort((x,y) => x-y);
  /* Dedupe stops closer than 500 m — on a closed circuit the origin is seen at
     BOTH ends of the chainage axis, which double-counts its dwell. */
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

  /* Phase: 0 stop zone · 1 accelerating · 2 cruising · 3 braking. Classified by
     PHYSICAL acceleration d(v²)/2ds against a 0.25 m/s² threshold — a
     per-sample dv test fires on every gentle curve-cap ripple and paints the
     whole route accel/brake. */
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

  const dwell = opts.dwell === undefined ? 0 : opts.dwell;
  const segs = [];
  for (let k = 1; k < stopIdx.length; k++) {
    const i0 = stopIdx[k-1], i1 = stopIdx[k];
    let peakSeg = 0;
    for (let i = i0; i <= i1; i++) if (v[i] > peakSeg) peakSeg = v[i];
    segs.push({ i0, i1, s0: P[i0].s, s1: P[i1].s,
                dist: P[i1].s - P[i0].s, time: t[i1] - t[i0], peak: peakSeg * 3.6 });
  }
  const dwellTotal = dwell * Math.max(0, stopIdx.length - 2);

  let peak = 0;
  for (let i = 0; i < n; i++) if (v[i] > peak) peak = v[i];
  return { v, t, phase, segs, stopIdx, dwell, dwellTotal,
           run: T, total: T + dwellTotal, length: L,
           avg: L / (T + dwellTotal) * 3.6, avgRun: L / T * 3.6, peak: peak * 3.6 };
}

/** Chainage of each control point along a resampled alignment. */
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

/** Closed-form trapezoidal journey time, for the analytical sanity check. */
function trapezoid(d, vmaxKmh, a, b) {
  const V = vmaxKmh / 3.6;
  const da = V*V/(2*a), db = V*V/(2*b);
  if (da + db <= d) {
    const tc = (d - da - db) / V;
    return { reached: vmaxKmh, t: V/a + V/b + tc, cruise: true };
  }
  const Vp = Math.sqrt(2*d*a*b/(a+b));
  return { reached: Vp*3.6, t: Vp/a + Vp/b, cruise: false };
}

/* ---------------------------------------------------------------- API ---- */
global.ENGINE = {
  G, loadProject, sample, sampleBilinear, cellCost, activeCostLayers,
  buildCostGrid, buildTerrainField, invalidateSurfaces, costToGo,
  search, searchChain, routeLeg, resample, curvature, countHIP, auditRadius, strideFor,
  verticalProfile, verticalRadii, policyFor, classifyStructures, structureRuns, structureThresholds,
  speedProfile, nodeChainages, trapezoid,
  DEFAULT_WEIGHTS, COVERAGE_KEYS, STRUCT, NH, DB, e2ix, n2iy, has,
};
})(window);
