/* ===========================================================================
   London 2100 — Rail Alignment Designer :: APP
   =========================================================================== */
(function () {
'use strict';
const E = window.ENGINE, R = window.RENDER, STUDY = window.STUDY;
const $ = id => document.getElementById(id);

let map = null, result = null, busy = false;
let dwellSec = 60;
/* Overtaking infrastructure. The express gains 24 min per lap over the stopper, so
   at a 6 min stopper headway it must pass 5 of them. Five evenly-spaced secondary
   stations get four-track platform loops; P1 additionally gets a four-track throat
   because it is the hub, the terminus for both directions and the depot access. */
const PASSING_STATIONS = ['S1','S2','S3','S5','S7'];
const HUB = 'P1';
const w = Object.assign({}, E.DEFAULT_W);
const T = Object.assign({}, E.DEFAULT_T);
/* 750 km/h peak with 1.5 m/s2 accel/brake. 1.5 is the MbBO §13(5) NEVER-EXCEED,
   not a design value — measured Shanghai TR08 is 0.81 m/s2. At these station
   spacings acceleration, not top speed, sets the journey time, so this is the
   fastest legal configuration. Drop the slider to 1.0 for the conservative case. */
const opts = { vmax: 750, accel: 1.5, brake: 1.5, cant: 200, cantDef: 130 };

/* ------------------------------------------------------------ bootstrap -- */
function setStatus(msg) {
  const el = $('status');
  if (!msg) { el.style.display = 'none'; return; }
  el.style.display = 'block'; el.textContent = msg;
}

async function boot() {
  setStatus('Decompressing constraint grids…');
  try {
    await E.initGrid();
  } catch (err) {
    setStatus('Failed to load grids: ' + err.message);
    console.error(err); return;
  }
  const img = new Image();
  img.onload = () => { start(img); };
  img.onerror = () => { start(null); };
  img.src = window.BASEMAP;
}

function start(img) {
  const cv = $('map');
  const resize = () => {
    const r = cv.parentElement.getBoundingClientRect();
    cv.width = r.width; cv.height = r.height;
    for (const id of ['profile']) {
      const c = $(id), b = c.parentElement.getBoundingClientRect();
      c.width = b.width; c.height = b.height - 28;
    }
    if (map) { map.draw(); redrawCharts(); }
  };
  map = new R.MapView(cv, img);
  window.addEventListener('resize', resize);
  resize();

  /* Map <-> long-section hover sync, Google-Earth style: the cursor on either
     surface drives a shared alignment index; both redraw on the next frame.   */
  let hoverRaf = 0;
  const setHover = i => {
    if (map.hoverIdx === i) return;
    map.hoverIdx = i;
    if (result) result._hoverIdx = i;
    if (!hoverRaf) hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0; map.draw(); redrawCharts();
    });
  };
  map.onHover = wl => {
    const ix = E.e2ix(wl.E), iy = E.n2iy(wl.N);
    if (ix < 0 || iy < 0 || ix >= E.G.nx || iy >= E.G.ny) { $('readout').textContent = '—'; return; }
    const g = E.G, i = iy * g.nx + ix;
    const alcNames = ['—','1','2','3a','3b','4','5','non-ag','urban'];
    $('readout').innerHTML =
      `E ${wl.E.toFixed(0)}  N ${wl.N.toFixed(0)}` +
      ` &nbsp;|&nbsp; ${g.layer.dem[i].toFixed(0)} m AOD` +
      ` &nbsp;|&nbsp; slope ${g.layer.slope[i].toFixed(1)}%` +
      ` &nbsp;|&nbsp; ALC ${alcNames[g.layer.alc[i]]}` +
      ` &nbsp;|&nbsp; built ${(g.layer.built[i]*100).toFixed(0)}%` +
      (g.layer.aonb[i] > .05 ? '  <b>AONB</b>' : '') +
      (g.layer.flood_proxy[i] > .5 ? '  <b>floodplain</b>' : '');
    // nearest alignment point within ~35 px grabs the shared cursor
    if (result && result.P) {
      const rad = 35 / map.zoom, r2 = rad * rad;
      let bi = -1, bd = r2;
      for (let q = 0; q < result.P.length; q++) {
        const dE = result.P[q].E - wl.E, dN = result.P[q].N - wl.N;
        const d = dE*dE + dN*dN;
        if (d < bd) { bd = d; bi = q; }
      }
      setHover(bi >= 0 ? bi : null);
    }
  };
  $('map').addEventListener('mouseleave', () => setHover(null));
  $('profile').addEventListener('mousemove', e => {
    if (!result || !result._profX) return;
    const t = result._profX;
    const s = (e.offsetX - t.ml) / (t.W - t.ml - t.right) * t.L;
    if (s < 0 || s > t.L) { setHover(null); return; }
    setHover(Math.max(0, Math.min(result.P.length - 1, Math.round(s / 25))));
  });
  $('profile').addEventListener('mouseleave', () => setHover(null));

  buildNodeSelects(); buildViewSelect(); buildLayerToggles(); bindControls();
  updateGeomNote(); buildLegend();
  map.draw();
  /* Boot straight into the canonical full loop, per the wrap-up brief: the viewport
     always shows the whole loop, whatever the view mode. Deferred one frame so the
     status text paints before the ~2 s vertical-profile fit runs.               */
  setStatus('Preparing the canonical 17-station loop…');
  setTimeout(() => {
    try { if (!loadCanonicalLoop()) setStatus(''); else setStatus(''); }
    catch (err) { setStatus('Canonical loop failed: ' + err.message); console.error(err); }
  }, 60);
}

function buildNodeSelects() {
  const a = $('nodeA'), b = $('nodeB');
  E.G.nodes.forEach((n, i) => {
    a.add(new Option(n.name, i)); b.add(new Option(n.name, i));
  });
  a.value = 0; b.value = Math.min(1, E.G.nodes.length - 1);
}
function buildViewSelect() {
  const s = $('view');
  for (const k in R.VIEW) s.add(new Option(R.VIEW[k], k));
  s.value = 'alignment';
  s.onchange = () => { map.view = s.value; buildLegend(); map.draw(); };
}
/* Every layer gets a real on/off AND an opacity slider. Defaults reproduce the
   presentation-render look (hypsometric base, AONB/built/rivers at modest alpha);
   the QGIS raster is one of the layers, off by default. With every base layer off
   the georeferenced export comes out transparent for Photoshop/Illustrator.     */
function buildLayerToggles() {
  const names = { topo:'Topography (hypsometric)', basemap:'Detailed base map (QGIS)',
                  aonb:'AONB / National Landscape', greenbelt:'Green Belt',
                  built:'Built-up area', woodland:'Woodland',
                  flood_proxy:'Floodplain (proxy)',
                  river_major:'Major rivers', road_major:'Primary roads' };
  const host = $('layerToggles'); host.innerHTML = '';
  for (const k in names) {
    const row = document.createElement('div'); row.className = 'lyr';
    const a0 = Math.round((map.layerAlpha[k] === undefined ? 0.55 : map.layerAlpha[k]) * 100);
    row.innerHTML =
      `<label class="chk" style="flex:1;margin:0"><input type="checkbox" ${map.showLayers[k]?'checked':''}>` +
      `<span>${names[k]}</span></label>` +
      `<input type="range" min="5" max="100" value="${a0}" title="opacity" style="width:58px">`;
    const ins = row.querySelectorAll('input');
    ins[0].onchange = () => { map.showLayers[k] = ins[0].checked; map.draw(); };
    ins[1].oninput  = () => { map.layerAlpha[k] = +ins[1].value/100;
                              if (map.showLayers[k]) map.draw(); };
    host.appendChild(row);
  }
}

/* ------------------------------------------------------------- controls -- */
function bindControls() {
  const S = [
    ['rMin','rMin',v=>v.toLocaleString()+' m',1],
    ['stride','stride',v=>v+' m',1],
    ['grade','maxGrade',v=>v.toFixed(1)+' %',0],
    ['vR','vCurveR',v=>v.toLocaleString()+' m',1],
    ['built','builtUp',v=>v,1],['aonb','aonb',v=>v,1],['wood','woodland',v=>v,1],
    ['flood','flood',v=>v,1],['slope','slope',v=>v,1],['river','river',v=>v,1],
    ['alc','alcBMV',v=>v,1],['turn','turn',v=>v,1],
  ];
  for (const [id,key,fmt] of S) {
    const el = $('s-'+id), lab = $('v-'+id);
    el.oninput = () => {
      const v = parseFloat(el.value); w[key] = v; lab.textContent = fmt(v);
      if (id==='rMin'||id==='stride') updateGeomNote();
    };
    lab.textContent = fmt(parseFloat(el.value));
  }
  $('s-vmax').oninput = e => { opts.vmax = +e.target.value; $('v-vmax').textContent = opts.vmax+' km/h';
                               if (result) { recomputeSpeed(); } };
  $('s-acc').oninput  = e => { opts.accel = opts.brake = +e.target.value;
                               $('v-acc').textContent = opts.accel.toFixed(2)+' m/s²';
                               if (result) { recomputeSpeed(); } };
  $('run').onclick = run;
  $('runStudy').onclick = runStudy;
  $('runChain').onclick = runChain;
  $('runLoop').onclick = () => runChain(true);
  $('optimum').onclick = showOptimum;
  $('service').onchange = () => { applyService(); showTimetable(); };
  $('s-dwell').oninput = e => {
    dwellSec = +e.target.value; $('v-dwell').textContent = dwellSec + ' s';
    if (result && result.P) { result.services = buildServices(result.P, result.R);
      applyService(); showTimetable(); }
  };
  $('fitBtn').onclick = () => { if (result) { map.fitTo(result.P); map.draw(); } };
  $('expDXF').onclick = exportDXF;
  $('expPNG').onclick = exportPNG;
  if ($('expMap')) $('expMap').onclick = exportMapPNG;
  $('expCSV').onclick = exportCSV;
  $('expJSON').onclick = exportGeoJSON;
}

function updateGeomNote() {
  const maxB = Math.max(1, Math.floor(w.stride / w.rMin / E.DB));
  const rAch = w.stride / (maxB * E.DB);
  $('geomNote').innerHTML =
    `Search lattice: ${maxB} heading bucket${maxB>1?'s':''} of ${(E.DB*180/Math.PI).toFixed(2)}° per ` +
    `${w.stride} m step &rarr; <b>every</b> route it can produce has R &ge; ` +
    `<b>${Math.round(rAch).toLocaleString()} m</b>. The radius constraint is structural, not a filter.`;
}

/* ------------------------------------------------------------------ run -- */
function run() {
  if (busy) return;
  busy = true; $('run').disabled = true;
  setStatus('Searching…');
  setTimeout(() => {
    try { doRun(); }
    catch (err) { setStatus('Error: ' + err.message); console.error(err); }
    finally { busy = false; $('run').disabled = false; }
  }, 30);
}

function doRun() {
  const a = E.G.nodes[+$('nodeA').value], b = E.G.nodes[+$('nodeB').value];
  if (a === b) { setStatus('Pick two different nodes'); return; }
  const t0 = performance.now();
  const sr = E.search({E:a.E,N:a.N}, {E:b.E,N:b.N}, w);
  if (!sr) { setStatus('No route found — try relaxing the weights or the radius'); return; }

  const P  = E.resample(sr.pts, 25);
  const Rr = E.curvature(P, 8);
  const vp = E.verticalProfile(P, w);
  const structs = E.classifyStructures(P, vp, T);
  const runs = E.structureRuns(P, structs);
  const sp = E.speedProfile(P, Rr, opts);

  result = { P, R:Rr, vp, structs, runs, sp, w:Object.assign({},w), opts:Object.assign({},opts),
             a, b, search:sr, ms: performance.now()-t0 };
  result.services = buildServices(P, Rr);
  const svc0 = result.services[$('service').value] || result.services.express;
  result.sp = svc0.sp; result.opts = svc0.opts;
  map.result = result; map.study = null; map.selectedId = null;
  $('cmpSec').style.display = 'none';
  map.fitTo(P); map.draw(); redrawCharts(); showResults();
  setStatus('');
}

/* --------------------------------------------------------- CHAIN ROUTE -- */
function runChain(asLoop) {
  if (busy) return;
  busy = true; $('runChain').disabled = $('run').disabled = $('runStudy').disabled = true;
  if ($('runLoop')) $('runLoop').disabled = true;
  setStatus(asLoop ? 'Routing the full loop…' : 'Routing the arc…');
  setTimeout(() => {
    try { doChain(asLoop === true); }
    catch (err) { setStatus('Error: ' + err.message); console.error(err); }
    finally { busy = false; $('runChain').disabled = $('run').disabled = $('runStudy').disabled = false;
      if ($('runLoop')) $('runLoop').disabled = false; }
  }, 30);
}

function doChain(asLoop) {
  const nodes = E.G.nodes;
  if (nodes.length < 3) { setStatus('Chain needs 3+ nodes'); return; }
  const t0 = performance.now();
  const sr = asLoop
    ? E.searchLoop(nodes, w, (p,np,k,n,lab) => setStatus(`Pass ${p+1}/${np} · leg ${k+1}/${n} — ${lab}…`))
    : E.searchChain(nodes, w, (k,n,lab) => setStatus(`Leg ${k+1} of ${n} — ${lab}…`));
  /* searchChain / searchLoop now REPORT failure instead of falling through to a
     free-heading search. The error object is truthy, so it must be tested for
     explicitly — a plain `if (!sr)` would let a failure through as if it were a
     route. The previous run's numbers stay on screen otherwise, which is exactly
     what made a kinked loop look like a successful one.                          */
  if (!sr || sr.error) {
    const msg = !sr
      ? 'No route found — relax the weights or the radius'
      : sr.error === 'radius audit failed'
        ? `Radius audit FAILED: ${Math.round(sr.minR).toLocaleString()} m at ` +
          `${(sr.chainage/1000).toFixed(1)} km, against ${Math.round(sr.rAchievable).toLocaleString()} m ` +
          `guaranteed. The alignment has a corner — not delivered.`
        : `Cannot route ${sr.leg} with heading continuity. Raise the search stride, ` +
          `lower the minimum radius, or move that node.`;
    setStatus(msg);
    $('results').innerHTML = `<p class="note" style="color:#c62828"><b>Routing failed.</b><br>${msg}</p>`;
    result = null; window.__LOOP = null;
    return;
  }

  let P = E.resample(sr.pts, 25);
  /* The chain overshoots the last node by up to half a stride (the terminal
     offset). Trim there — the tail past the final station is not railway, and
     left in it shows up as a spurious 0.4 km "P2 → —" segment in the timetable. */
  {
    const last = nodes[nodes.length-1];
    let bi = P.length-1, bd = Infinity;
    for (let i = 0; i < P.length; i++) {
      const d = (P[i].E-last.E)*(P[i].E-last.E) + (P[i].N-last.N)*(P[i].N-last.N);
      if (d < bd) { bd = d; bi = i; }
    }
    if (!asLoop && bi > 10 && bi < P.length-1) P = P.slice(0, bi+1);
  }
  const Rr = E.curvature(P, 8);
  const vp = E.verticalProfile(P, w);
  const structs = E.classifyStructures(P, vp, T);
  const runs = E.structureRuns(P, structs);
  result = { P, R:Rr, vp, structs, runs, w:Object.assign({},w),
             a: nodes[0], b: nodes[nodes.length-1], search: sr, chain: sr.legs,
             ms: performance.now()-t0 };
  result.services = buildServices(P, Rr);
  result.layout = E.trackLayout(P, result.services.chn, PASSING_STATIONS, HUB);
  const svc = result.services[$('service').value] || result.services.express;
  result.sp = svc.sp; result.opts = svc.opts;
  map.result = result; map.study = null; map.selectedId = null;
  $('cmpSec').style.display = 'none';
  map.fitTo(P); map.draw(); redrawCharts(); showResults();
  window.__LOOP = { P: P.map(q=>[Math.round(q.E),Math.round(q.N),+q.s.toFixed(0)]),
    z: Array.from(result.vp.z).map(v=>+v.toFixed(1)),
    ground: Array.from(result.vp.ground).map(v=>+v.toFixed(1)),
    structs: result.structs.map(x=>x.id),
    R: Array.from(result.R).map(v=>isFinite(v)?Math.round(v):0),
    legs: sr.legs.map(l=>({from:l.from.id,to:l.to.id,n:l.pts.length,gap:Math.round(l.endGap)})),
    loop: !!sr.loop };
  showChainBreakdown(sr, P);
  showServiceSummary();
  showTimetable();
  setStatus('');
}

/* ---------------------------------------------------- CANONICAL LOOP ----- */
/* The routed 17-station loop ships WITH the app (js/data_loop.js, generated by
   build/solve_loop.py + make_data_loop.py). It loads at boot so every view mode
   always shows the full loop — no 25-minute in-browser solve, no stale screen.
   The in-app router remains available for what-if runs with different weights. */
function loadCanonicalLoop() {
  const D = window.LOOP_DATA;
  if (!D || !D.pts || D.pts.length < 100) return false;
  const t0 = performance.now();
  const raw = D.pts.map(q => ({ E: q[0], N: q[1] }));
  const P = E.resample(raw, 25);
  const Rr = E.curvature(P, 8);
  const vp = E.verticalProfile(P, w);
  const structs = E.classifyStructures(P, vp, T);
  const runs = E.structureRuns(P, structs);
  /* Rebuild per-leg polylines from station chainages so the leg table and DXF
     see the same geometry the solver produced — legs are P sliced at stations. */
  const chn = E.nodeChainages(P, E.G.nodes).slice().sort((a,b)=>a.s-b.s);
  const legs = [];
  for (let k = 0; k < chn.length; k++) {
    const a = chn[k], b = chn[(k+1) % chn.length];
    const i0 = a.idx, i1 = (k === chn.length-1) ? P.length-1 : b.idx;
    legs.push({ from: a.node, to: b.node, pts: P.slice(i0, i1+1),
                endGap: (k === chn.length-1) ? (D.closure_m||0) : 0 });
  }
  const sr = { legs, pts: P, loop: true, endGap: D.closure_m || 0,
               expanded: D.states || 0, canonical: true };
  result = { P, R:Rr, vp, structs, runs, w:Object.assign({},w),
             a: E.G.nodes[0], b: E.G.nodes[0], search: sr, chain: legs, ms: performance.now()-t0 };
  result.services = buildServices(P, Rr);
  result.layout = E.trackLayout(P, result.services.chn, PASSING_STATIONS, HUB);
  const svc = result.services[$('service').value] || result.services.express;
  result.sp = svc.sp; result.opts = svc.opts;
  map.result = result; map.study = null; map.selectedId = null;
  map.fitTo(P); map.draw(); redrawCharts(); showResults();
  showChainBreakdown(sr, P);
  showServiceSummary(); showTimetable();
  return true;
}

/* ------------------------------------------------------ SERVICE PATTERNS -- */
/* Two products on the same infrastructure. The line speed is identical — 500 km/h
   for both. The ONLY difference is how many times the train has to stop, and each
   stop costs a full brake-and-accelerate cycle plus dwell. That is what makes the
   stopping service slower, not a lower line speed.                              */
function buildServices(P, R) {
  const chn = E.nodeChainages(P, E.G.nodes);
  const kind = nd => (nd.kind||'').toLowerCase();
  const isP = nd => kind(nd)==='primary', isA = nd => kind(nd)==='airport';
  const isLoop = !!window.GRID.loop;
  const pick = f => chn.filter((c,i) => (isLoop ? false : (i===0 || i===chn.length-1)) || f(c.node));
  const mk = (set, label) => {
    if (!set.length || set[0].s > 1) set = [chn[0]].concat(set.filter(c=>c!==chn[0]));
    set = set.slice().sort((a,b)=>a.s-b.s);
    const o = Object.assign({}, opts, { stops: set.map(c => c.s), dwell: dwellSec });
    const sp = E.speedProfile(P, R, o);
    sp.segs.forEach((sg,k) => { sg.from = set[k] ? set[k].node.name : '—';
                                sg.to = set[k+1] ? set[k+1].node.name : (isLoop ? set[0].node.name : '—'); });
    return { label, calls: set, sp, opts: o };
  };
  const isS = nd => kind(nd)==='secondary';
  return {
    express:    mk(pick(isP),                    'Express — 6 primaries'),
    expressAir: mk(pick(n=>isP(n)||isA(n)),      'Express + airports — 9 calls'),
    semi:       mk(pick(n=>isP(n)||isS(n)),      'Primary + secondary — 14 calls'),
    stopping:   mk(chn.slice(),                  'All stations — 17 calls'),
    chn,
  };
}
const SERVICE_KEYS = ['express','expressAir','semi','stopping'];
const SERVICE_COL  = { express:'#1d4ed8', expressAir:'#b8272b',
                       semi:'#0e7490', stopping:'#8e44ad' };

function currentService() {
  if (!result || !result.services) return null;
  return result.services[$('service').value] || result.services.express;
}

function applyService() {
  const svc = currentService();
  if (!svc) return;
  result.sp = svc.sp; result.opts = svc.opts;
  map.draw(); redrawCharts(); showServiceSummary();
}

function showServiceSummary() {
  const r = result; if (!r || !r.services) { $('svcSummary').innerHTML=''; return; }
  const S = r.services, base = S.express.sp.total;
  const row = (k,s) => `<b>${s.label.split(' —')[0]}</b> ${s.calls.length} calls ·
     ${(s.sp.run/60).toFixed(1)}+${(s.sp.dwellTotal/60).toFixed(1)} =
     <b>${(s.sp.total/60).toFixed(1)} min</b> · avg ${s.sp.avg.toFixed(0)} km/h` +
     (k==='express' ? '' : ` <span style="color:var(--warn)">+${((s.sp.total-base)/60).toFixed(1)}
     (+${((s.sp.total/base-1)*100).toFixed(0)}%)</span>`);
  $('svcSummary').innerHTML = SERVICE_KEYS.map(k=>row(k,S[k])).join('<br>');
}

/* Timetable — time between every pair of consecutive calls, both services. */
function showTimetable() {
  if (!result || !result.services) return;
  const S = result.services;
  const tbl = (svc, colour) => {
    let h = `<table class="cmp" style="margin-bottom:9px">
      <tr><th colspan="4" style="color:${colour}">${svc.label} · ${svc.calls.length} calls ·
        <b>${(svc.sp.total/60).toFixed(1)} min</b> total</th></tr>
      <tr><th>segment</th><th>km</th><th>min</th><th>peak</th></tr>`;
    let cum = 0;
    svc.sp.segs.forEach(sg => {
      cum += sg.time;
      h += `<tr><td>${sg.from} → ${sg.to}</td><td>${(sg.dist/1000).toFixed(1)}</td>
            <td>${(sg.time/60).toFixed(2)}</td><td>${sg.peak.toFixed(0)}</td></tr>`;
    });
    h += `<tr style="font-weight:700"><td>running total</td>
          <td>${(svc.sp.length/1000).toFixed(1)}</td>
          <td>${(svc.sp.run/60).toFixed(2)}</td><td>${svc.sp.peak.toFixed(0)}</td></tr>
      <tr><td>dwell ${svc.sp.dwell}s × ${Math.max(0,svc.calls.length-2)}</td><td></td>
          <td>${(svc.sp.dwellTotal/60).toFixed(2)}</td><td></td></tr>
      <tr style="font-weight:700"><td>JOURNEY</td><td></td>
          <td>${(svc.sp.total/60).toFixed(2)}</td>
          <td>avg ${svc.sp.avg.toFixed(0)}</td></tr></table>`;
    return h;
  };
  const host = $('timetable');
  if (!host) return;
  host.innerHTML = SERVICE_KEYS.map(k => tbl(S[k], SERVICE_COL[k])).join('') +
    `<p class="note">All services run the same ${opts.vmax} km/h line speed on the same
     infrastructure. The stopping pattern is slower purely because each extra call
     costs a full brake-and-accelerate cycle plus dwell — not because the train is
     slower.</p>`;
  $('ttSec').style.display = 'block';
}

/* Per-leg breakdown — a chain is only as good as its worst leg. */
function showChainBreakdown(sr, P) {
  const nodes = E.G.nodes;
  let h = `<h3 style="margin-top:12px">Legs</h3><table class="cmp">
    <tr><th>leg</th><th>km</th><th>vs direct</th><th>AONB</th><th>built</th></tr>`;
  let acc = 0;
  sr.legs.forEach((lg, k) => {
    let L = 0;
    for (let i = 1; i < lg.pts.length; i++)
      L += Math.hypot(lg.pts[i].E-lg.pts[i-1].E, lg.pts[i].N-lg.pts[i-1].N);
    const direct = Math.hypot(lg.to.E-lg.from.E, lg.to.N-lg.from.N);
    // sample the constraint layers along this leg
    let aon = 0, bui = 0, n = 0;
    for (let i = 0; i < lg.pts.length; i += 4) {
      aon += E.sample('aonb', lg.pts[i].E, lg.pts[i].N);
      bui += E.sample('built', lg.pts[i].E, lg.pts[i].N); n++;
    }
    const dev = (L/direct - 1) * 100;
    h += `<tr><td>${lg.from.name} → ${lg.to.name}</td><td>${(L/1000).toFixed(1)}</td>
      <td style="color:${dev>25?'var(--warn)':'inherit'}">+${dev.toFixed(0)}%</td>
      <td>${(aon/n*100).toFixed(0)}%</td><td>${(bui/n*100).toFixed(1)}%</td></tr>`;
    acc += L;
  });
  h += `</table><p class="note">Chain routed with heading continuity through every
    intermediate node — legs are not solved independently, or there would be a kink at
    each station. Each leg must also arrive pointing within 35° of the bearing to the
    node after next.</p>`;
  $('results').innerHTML += h;
}

/* ------------------------------------------------------ ALIGNMENT STUDY -- */
let study = null, ranking = null;

async function runStudy() {
  if (busy) return;
  busy = true;
  $('runStudy').disabled = $('run').disabled = $('optimum').disabled = true;
  const a = E.G.nodes[+$('nodeA').value], b = E.G.nodes[+$('nodeB').value];
  if (a === b) { setStatus('Pick two different nodes'); busy = false;
                 $('runStudy').disabled = $('run').disabled = false; return; }
  const t0 = performance.now();
  try {
    study = await STUDY.run(a, b, w, opts, (i, n, name) =>
      setStatus(`Alignment ${i+1} of ${n} — ${name}…`));
    if (!study.length) { setStatus('No alignments found'); return; }

    // colour best→worst on the composite that drives the ranking's first two
    // criteria, so the map reads the way Quantm's does
    const key = r => r.m.time / 60 + r.m.cost / 120;
    const ks = study.map(key), lo = Math.min(...ks), hi = Math.max(...ks);
    study.forEach(r => r.colour = STUDY.rampColour(hi > lo ? (key(r)-lo)/(hi-lo) : 0));

    ranking = STUDY.rank(study);
    map.study = study; map.selectedId = null; map.result = null;
    map.fitTo(study[0].P); map.draw();
    buildComparison();
    $('cmpSec').style.display = 'block';
    $('optimum').disabled = false;
    setStatus(`${study.length} alignments in ${((performance.now()-t0)/1000).toFixed(1)} s`);
    setTimeout(() => setStatus(''), 4000);
  } catch (err) { setStatus('Error: ' + err.message); console.error(err); }
  finally { busy = false; $('runStudy').disabled = $('run').disabled = false; }
}

function selectOption(id) {
  const r = study.find(z => z.sc.id === id);
  if (!r) return;
  map.selectedId = id;
  result = { P:r.P, R:r.R, vp:r.vp, structs:r.structs, runs:r.runs, sp:r.sp,
             w:r.w, opts:r.opts, a:E.G.nodes[+$('nodeA').value], b:E.G.nodes[+$('nodeB').value],
             search:r.search, ms:0 };
  map.result = null;                       // drawStudy already highlights it
  map.draw(); redrawCharts(); showResults();
  buildComparison();
}

function buildComparison() {
  const best = ranking && ranking.winner;
  const cheapest = Math.min(...study.map(r => r.m.cost));
  const rows = study.slice().sort((x,y) => x.m.time - y.m.time).map(r => {
    const sav = ((r.m.cost - cheapest) / cheapest * 100);
    const isW = best && r.sc.id === best.sc.id;
    const isS = map.selectedId === r.sc.id;
    return `<tr class="opt${isW?' win':''}${isS?' sel':''}" data-id="${r.sc.id}">
      <td><span class="swatch" style="background:${r.colour}"></span></td>
      <td>${isW?'<span class="crown">★</span> ':''}${r.sc.id}</td>
      <td>${r.sc.speed}</td>
      <td>${(r.m.length/1000).toFixed(1)}</td>
      <td>${(r.m.time/60).toFixed(2)}</td>
      <td>£${r.m.cost.toFixed(0)}m</td>
      <td>${sav<0.05?'—':'+'+sav.toFixed(0)+'%'}</td>
      <td>${r.m.hip}/${r.m.vip}</td></tr>`;
  }).join('');
  let h = `<table class="cmp">
    <tr><th></th><th>opt</th><th>km/h</th><th>km</th><th>min</th><th>cost</th>
        <th>vs min</th><th>HIP/VIP</th></tr>${rows}</table>
    <p class="note">HIP / VIP = horizontal and vertical intersection points, i.e. geometric
      complexity. Cost is £m at a 2019/20 base from the DfT benchmarking study — comparative,
      not absolute. Click a row to inspect it.</p>`;
  if (ranking && ranking.trace.length) {
    h += `<div class="trace"><b>Ranking, applied in priority order:</b><br>`;
    ranking.trace.forEach((t,i) => {
      h += `${i+1}. ${t.c.label} — best ${t.c.fmt(t.best)}; ` +
           `${t.kept} of ${t.before} within ${(t.c.tol*100).toFixed(0)}%` +
           (t.eliminated && t.eliminated.length ? ` (out: ${t.eliminated.join(', ')})` : '') + `<br>`;
    });
    if (best) h += `<b>→ ${best.sc.id} ${best.sc.name}</b> · derived optimum speed <b>${best.sc.speed} km/h</b> ` +
                   `· required radius <b>${Math.round(best.w.rMin).toLocaleString()} m</b></div>`;
  }
  $('cmp').innerHTML = h;
  $('cmp').querySelectorAll('tr.opt').forEach(tr =>
    tr.onclick = () => selectOption(tr.dataset.id));
}

function showOptimum() {
  if (!ranking || !ranking.winner) return;
  selectOption(ranking.winner.sc.id);
  map.fitTo(ranking.winner.P); map.draw();
}

function recomputeSpeed() {
  result.sp = E.speedProfile(result.P, result.R, opts);
  result.opts = Object.assign({}, opts);
  map.draw(); redrawCharts(); showResults();
}

/* One full-width long section, per the wrap-up brief. The speed CHART is gone;
   speed stays available as a map view mode and in the timetable numbers.        */
function redrawCharts() {
  R.drawProfile($('profile'), result);
}

/* -------------------------------------------------------------- results -- */
function showResults() {
  const r = result, P = r.P, n = P.length, L = P[n-1].s;
  const straight = Math.hypot(r.b.E-r.a.E, r.b.N-r.a.N);
  let rmin = Infinity;
  for (let i=0;i<n;i++){ const x=Math.abs(r.R[i]); if (isFinite(x)&&x<rmin) rmin=x; }
  let gmax=0, fill=0, cut=0, se=0;
  for (let i=0;i<n;i++){
    gmax=Math.max(gmax,Math.abs(r.vp.grade[i]));
    fill=Math.max(fill,r.vp.diff[i]); cut=Math.max(cut,-r.vp.diff[i]);
    se += r.vp.diff[i]*r.vp.diff[i];
  }
  const rms = Math.sqrt(se/n);
  const ds = r.vp.ds;
  const tot = {};
  for (const s of r.structs) tot[s.id] = (tot[s.id]||0) + ds;

  const radOK = rmin >= r.w.rMin*0.96;
  const grOK  = gmax <= r.w.maxGrade*1.02;

  /* What the tightest curve permits, per DESIGN_STANDARDS.md rev A.
     Wheel-rail cant budgets are CAHSR TM 2.1.2 Table 3.2-1 at >=300 km/h:
     150 mm desirable, 230 maximum, 250 exceptional. Maglev is evaluated with the
     rigorous large-angle form, banked for the geometric design speed.          */
  const M = E.MAGLEV;
  const vRailDes  = E.curveSpeed(rmin, 150, 0);      // D+I = 150 desirable
  const vRailExc  = E.curveSpeed(rmin, 250, 0);      // D+I = 250 exceptional
  const theta     = Math.min(M.thetaMax, E.bankFor(600, rmin));
  const vMagPref  = E.maglevSpeed(rmin, theta, M.aqPreferred);
  const vMagNorm  = E.maglevSpeed(rmin, theta, M.aqNormal);
  const aqAtV     = E.lateralAccel(opts.vmax, rmin, theta);
  const transL    = E.transitionLength(opts.vmax, 1500*Math.sin(theta*Math.PI/180));
  const rFor500   = 11.8 * opts.vmax * opts.vmax / 250;   // wheel-rail, exceptional

  const isLoop = !!r.search.loop;
  let h = `<table class="res">
    <tr><td>${isLoop ? 'Closed loop' : 'Route length'}</td><td>${(L/1000).toFixed(2)} km</td></tr>` +
    (isLoop ? '' :
    `<tr><td>Straight-line</td><td>${(straight/1000).toFixed(2)} km</td></tr>
    <tr><td>Deviation</td><td>+${((L/straight-1)*100).toFixed(1)} %</td></tr>`) + `
    <tr class="${radOK?'okrow':'warnrow'}"><td>Min radius</td><td>${Math.round(rmin).toLocaleString()} m</td></tr>
    <tr class="${grOK?'okrow':'warnrow'}"><td>Max gradient</td><td>${gmax.toFixed(2)} %</td></tr>
    <tr><td>Max fill / cut</td><td>${fill.toFixed(1)} / ${cut.toFixed(1)} m</td></tr>
    <tr><td>Earthworks RMS</td><td>${rms.toFixed(2)} m</td></tr>
    <tr><td>${isLoop ? 'Closure gap at P1' : 'Terminal offset'}</td><td>${Math.round(r.search.endGap)} m</td></tr>
    <tr><td>Journey time</td><td>${(r.sp.total/60).toFixed(2)} min</td></tr>
    <tr><td>Average speed</td><td>${r.sp.avg.toFixed(0)} km/h</td></tr>
    <tr><td>Peak speed</td><td>${r.sp.peak.toFixed(0)} km/h</td></tr>
    <tr><td>Transition length</td><td>${transL.toFixed(0)} m</td></tr>
    <tr><td>States expanded</td><td>${r.search.expanded.toLocaleString()}</td></tr>
    <tr><td>Solve time</td><td>${(r.ms/1000).toFixed(1)} s</td></tr>
  </table>

  <h3 style="margin-top:12px">Tightest curve — comfort validation</h3>
  <table class="res">
    <tr><td>Min radius on route</td><td>${Math.round(rmin).toLocaleString()} m</td></tr>
    <tr><td>Guideway bank θ<br><span style="color:#6b7280;font-weight:400">
        banked for 600 km/h geometric</span></td><td>${theta.toFixed(1)}°</td></tr>
    <tr class="${aqAtV<=M.aqPreferred?'okrow':(aqAtV<=M.aqNormal?'':'warnrow')}">
        <td>Lateral accel at ${opts.vmax}<br><span style="color:#6b7280;font-weight:400">
        preferred ≤0.49 · normal ≤0.63 · legal ≤1.50</span></td>
        <td>${aqAtV.toFixed(2)} m/s²</td></tr>
    <tr class="okrow"><td>Maglev max, preferred comfort</td><td>${vMagPref.toFixed(0)} km/h</td></tr>
    <tr><td>Maglev max, normal limit</td><td>${vMagNorm.toFixed(0)} km/h</td></tr>
    <tr class="warnrow"><td>Wheel-rail max<br><span style="color:#6b7280;font-weight:400">
        D+I 150 desirable / 250 exceptional</span></td>
        <td>${vRailDes.toFixed(0)} / ${vRailExc.toFixed(0)} km/h</td></tr>
  </table>
  <p class="note">${
    aqAtV > M.aqCeiling
      ? `<b>ILLEGAL.</b> ${aqAtV.toFixed(2)} m/s² exceeds the MbBO §13(4) ceiling of 1.50.`
    : aqAtV > M.aqNormal
      ? `<b>Fails the normal comfort limit</b> (${aqAtV.toFixed(2)} vs 0.63 m/s²). Open the radius
         or cap line speed here at ${vMagNorm.toFixed(0)} km/h.`
    : aqAtV > M.aqPreferred
      ? `Inside the normal limit but above the preferred 0.49 m/s² target.`
      : `Passes the preferred comfort target with margin.`}
    Wheel-on-rail would need <b>${Math.round(rFor500).toLocaleString()} m</b> for ${opts.vmax} km/h
    even at the exceptional cant budget — which is why this line is specified as EMS maglev.</p>
  <h3 style="margin-top:12px">Structure mix</h3><table class="res">`;
  for (const k in E.STRUCT) {
    const s = E.STRUCT[k]; const m = tot[s.id]||0;
    if (!m) continue;
    h += `<tr><td><span class="sw" style="display:inline-block;width:14px;height:6px;
          border-radius:3px;background:${s.colour};margin-right:6px"></span>${s.label}</td>
          <td>${(m/1000).toFixed(2)} km &middot; ${(m/L*100).toFixed(1)}%</td></tr>`;
  }
  h += `</table>`;

  // analytical journey-time comparison
  h += `<h3 style="margin-top:12px">Trapezoidal check over ${(L/1000).toFixed(1)} km</h3>
        <table class="res"><tr><td style="color:#6b7280">v&#8202;max &middot; a</td>
        <td style="color:#6b7280">time &middot; avg</td></tr>`;
  for (const vk of [400,500,600,700]) {
    const t = E.trapezoid(L, vk, opts.accel, opts.brake);
    h += `<tr><td>${vk} km/h &middot; ${opts.accel.toFixed(1)}</td>
          <td>${(t.t/60).toFixed(2)} min &middot; ${(L/t.t*3.6).toFixed(0)} km/h</td></tr>`;
  }
  h += `</table><p class="note">Average speed is bounded by acceleration, not by top speed:
        over ${(L/1000).toFixed(0)} km the train is accelerating or braking for most of the run.</p>`;
  $('results').innerHTML = h;
}

/* --------------------------------------------------------------- legend -- */
function buildLegend() {
  const v = map.view, L = $('legend');
  const li = (c,t) => `<div class="li"><div class="sw" style="background:${c}"></div>${t}</div>`;
  let h = '';
  if (v === 'time') {
    const svc = currentService();
    h = `<h4>Phase — ${svc ? svc.label : ''}</h4>`;
    R.PHASE_COL.forEach((c,i) => h += li(c, R.PHASE_LAB[i]));
    if (svc) h += `<div style="margin-top:7px;font-size:10.5px;color:#4b5563">
      ${svc.calls.length} calls · <b>${(svc.sp.total/60).toFixed(1)} min</b><br>
      run ${(svc.sp.run/60).toFixed(1)} + dwell ${(svc.sp.dwellTotal/60).toFixed(1)}</div>`;
  } else if (v === 'tracks') {
    h = `<h4>Track layout</h4>`;
    h += li('#1d4ed8','2 track — plain line');
    h += li('#c0392b','4 track — passing loop / hub');
    if (result && result.layout) h += `<div style="margin-top:7px;font-size:10.5px;color:#4b5563">
      ${result.layout.fourKm.toFixed(0)} km of four track
      (${result.layout.pct.toFixed(1)}% of ${result.layout.totalKm.toFixed(0)} km)<br>
      passing at ${PASSING_STATIONS.join(', ')} · hub ${HUB}</div>`;
  } else if (v === 'speed') {
    const svc = currentService();
    const pk = result && result.sp ? result.sp.peak : opts.vmax;
    h = `<h4>Speed — ${svc ? svc.label : ''}</h4>`;
    h += li('rgb(214,40,40)','Station / stopped');
    h += li('rgb(240,130,30)',`~${Math.round(pk*0.25)} km/h`);
    h += li('rgb(235,205,40)',`~${Math.round(pk*0.5)} km/h`);
    h += li('rgb(60,170,75)',`~${Math.round(pk*0.75)} km/h`);
    h += li('rgb(30,90,210)',`Peak achieved — ${Math.round(pk)} km/h`);
  } else if (v === 'infrastructure') {
    h = `<h4>Structure</h4>`;
    for (const k in E.STRUCT) h += li(E.STRUCT[k].colour, E.STRUCT[k].label);
  } else if (v === 'engineering') {
    h = `<h4>Radius vs design minimum</h4>`;
    h += li('#2e7d32','&ge; 1.3 &times; R min');
    h += li('#e08a1e','1.0 – 1.3 &times; R min');
    h += li('#c62828','&lt; R min — violation');
    h += li('#9aa3ad','Tangent (straight)');
  } else if (v === 'topography') {
    h = `<h4>Gradient</h4>`;
    h += li('rgb(40,140,200)','Level');
    h += li('rgb(148,95,120)','~1.5 %');
    h += li('rgb(255,50,40)','&ge; 3 %');
  } else {
    h = `<h4>Layers</h4>`;
    h += li('rgb(201,161,60)','AONB / National Landscape');
    h += li('rgb(90,90,100)','Built-up');
    h += li('rgb(70,130,70)','Woodland');
    h += li('rgb(20,110,190)','Major river');
  }
  L.innerHTML = h;
}


/* ------------------------------------------------------------ DXF EXPORT -- */
const NL = String.fromCharCode(10);   // NB: a literal '\n' here gets un-escaped
                                      // by the editor's formatter, breaking the file
/* AutoCAD R12 ASCII. 3D POLYLINEs in real BNG coordinates with rail level as Z,
   so the geometry lands in Rhino at true scale and true elevation — metres,
   EPSG:27700. One layer per structure type plus separate ground and stations,
   so the whole thing can be styled or isolated once it is open.               */
function dxfHeader() {
  return ['0','SECTION','2','HEADER',
          '9','$INSBASE','10','0.0','20','0.0','30','0.0',
          '9','$EXTMIN','10','0.0','20','0.0','30','0.0',
          '9','$EXTMAX','10','1.0','20','1.0','30','1.0',
          '0','ENDSEC'].join(NL);
}
function dxfTables(layers) {
  const L = ['0','SECTION','2','TABLES','0','TABLE','2','LAYER','70',String(layers.length)];
  for (const [name, colour] of layers)
    L.push('0','LAYER','2',name,'70','0','62',String(colour),'6','CONTINUOUS');
  L.push('0','ENDTAB','0','ENDSEC');
  return L.join(NL);
}
/** 3D polyline. pts = [{E,N,Z}] */
function dxfPolyline(layer, pts, closed) {
  const L = ['0','POLYLINE','8',layer,'66','1','70', closed ? '9' : '8',
             '10','0.0','20','0.0','30','0.0'];
  for (const p of pts)
    L.push('0','VERTEX','8',layer,
           '10',p.E.toFixed(3),'20',p.N.toFixed(3),'30',(p.Z||0).toFixed(3),'70','32');
  L.push('0','SEQEND','8',layer);
  return L.join(NL);
}
function dxfPoint(layer, E, N, Z) {
  return ['0','POINT','8',layer,'10',E.toFixed(3),'20',N.toFixed(3),'30',(Z||0).toFixed(3)].join(NL);
}
function dxfText(layer, E, N, Z, h, txt) {
  return ['0','TEXT','8',layer,'10',E.toFixed(3),'20',N.toFixed(3),'30',(Z||0).toFixed(3),
          '40',String(h),'1',txt].join(NL);
}

function exportDXF() {
  if (!result) { setStatus('Route something first'); setTimeout(()=>setStatus(''),2500); return; }
  const r = result, P = r.P, n = P.length;
  const LAYERS = [
    ['RAIL_TUNNEL',8],['RAIL_VIADUCT',5],['RAIL_BRIDGE',4],['RAIL_EMBANKMENT',30],
    ['RAIL_CUTTING',42],['RAIL_ATGRADE',7],['GROUND',9],['STATIONS',1],
    ['STATION_LABELS',1],['FOURTRACK',1],['CENTRELINE_2D',253],
  ];
  const out = [dxfHeader(), dxfTables(LAYERS), '0','SECTION','2','ENTITIES'];

  // rail centreline, split by structure so each run lands on its own layer
  const lay = id => 'RAIL_' + id.toUpperCase();
  let i0 = 0;
  for (let i = 1; i <= n; i++) {
    if (i === n || r.structs[i].id !== r.structs[i0].id) {
      const seg = [];
      for (let k = i0; k < Math.min(i+1, n); k++)
        seg.push({ E:P[k].E, N:P[k].N, Z:r.vp.z[k] });
      if (seg.length > 1) out.push(dxfPolyline(lay(r.structs[i0].id), seg, false));
      i0 = i;
    }
  }
  // existing ground along the alignment, and a flat 2D centreline for plan work
  const gnd = [], flat = [];
  for (let i = 0; i < n; i++) {
    gnd.push({ E:P[i].E, N:P[i].N, Z:r.vp.ground[i] });
    flat.push({ E:P[i].E, N:P[i].N, Z:0 });
  }
  out.push(dxfPolyline('GROUND', gnd, false));
  out.push(dxfPolyline('CENTRELINE_2D', flat, !!r.search.loop));

  // four-track sections as separate polylines
  if (r.layout) {
    let s0 = -1;
    for (let i = 0; i < n; i++) {
      const four = r.layout.tracks[i] === 4;
      if (four && s0 < 0) s0 = i;
      if ((!four || i === n-1) && s0 >= 0) {
        const seg = [];
        for (let k = s0; k <= i; k++) seg.push({ E:P[k].E, N:P[k].N, Z:r.vp.z[k] });
        if (seg.length > 1) out.push(dxfPolyline('FOURTRACK', seg, false));
        s0 = -1;
      }
    }
  }
  // stations as points plus labels at rail level
  if (r.services && r.services.chn) {
    for (const c of r.services.chn) {
      out.push(dxfPoint('STATIONS', c.node.E, c.node.N, r.vp.z[c.idx]));
      out.push(dxfText('STATION_LABELS', c.node.E + 300, c.node.N + 300,
                       r.vp.z[c.idx], 400, c.node.id));
    }
  }
  out.push('0','ENDSEC','0','EOF');
  download('london2100_alignment.dxf', out.join(NL), 'application/dxf');
  setStatus('DXF exported — EPSG:27700 metres, Z = rail level');
  setTimeout(()=>setStatus(''), 4000);
}

/* --------------------------------------------------------------- export -- */
/* Georeferenced 1:1 map export. The canvas is sized to the QGIS base raster's
   native pixels (25.4 m/px), rendered from the SAME MapView with zoom pinned to
   world-to-pixel — so the PNG registers pixel-perfect over the user's own base
   maps in Photoshop/Illustrator. Layer toggles and opacities apply as on screen;
   with every base layer off the background is transparent.                     */
function exportMapPNG() {
  const G = E.G;
  const Wpx = map.img ? map.img.naturalWidth  : Math.round((G.xmax - G.xmin) / 25.4);
  const Hpx = map.img ? map.img.naturalHeight : Math.round((G.ymax - G.ymin) / 25.4);
  const cv = document.createElement('canvas'); cv.width = Wpx; cv.height = Hpx;
  const save = { cv: map.cv, ctx: map.ctx, zoom: map.zoom, ox: map.ox, oy: map.oy,
                 hover: map.hoverIdx };
  map.cv = cv; map.ctx = cv.getContext('2d');
  map.zoom = Wpx / (G.xmax - G.xmin); map.ox = 0; map.oy = 0;
  map.exportMode = true; map.hoverIdx = null;
  map.draw();
  map.exportMode = false;
  map.cv = save.cv; map.ctx = save.ctx; map.zoom = save.zoom;
  map.ox = save.ox; map.oy = save.oy; map.hoverIdx = save.hover;
  map.draw();
  const a = document.createElement('a');
  a.download = 'london2100_map_georef.png';
  a.href = cv.toDataURL('image/png'); a.click();
  setStatus(`Map exported ${Wpx}×${Hpx} px — pixel-registered to the QGIS base at 25.4 m/px. ` +
            `Turn all base layers off for a transparent alignment-only overlay.`);
  setTimeout(() => setStatus(''), 6500);
}

/* Composite sheet, per the wrap-up brief: left data panel + map on the top row,
   the long section re-rendered at full sheet width underneath. Everything is
   drawn fresh onto an offscreen canvas so nothing depends on screen layout.   */
function exportPNG() {
  const mapCv = $('map');
  if (!result) {                       // nothing routed: fall back to the bare map
    const a = document.createElement('a');
    a.download = 'london2100_map.png';
    a.href = mapCv.toDataURL('image/png'); a.click(); return;
  }
  const r = result;
  const panelW = 360, headH = 64, profH = 250, pad = 14;
  const W = panelW + mapCv.width, H = headH + mapCv.height + profH;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);

  // header band
  ctx.fillStyle = '#14181c'; ctx.fillRect(0, 0, W, headH);
  ctx.fillStyle = '#fff'; ctx.font = '700 20px system-ui,sans-serif';
  const L = r.P[r.P.length-1].s;
  let rmin = Infinity;
  for (let i = 0; i < r.P.length; i++) {
    const x = Math.abs(r.R[i]); if (isFinite(x) && x < rmin) rmin = x;
  }
  ctx.fillText('LONDON 2100 — high-speed orbital loop', pad, 27);
  ctx.font = '12px system-ui,sans-serif'; ctx.fillStyle = '#9fb3d0';
  ctx.fillText(`${(L/1000).toFixed(1)} km ${r.search.loop?'closed circuit':'alignment'} · ` +
    `min radius ${Math.round(rmin).toLocaleString()} m · line speed ${opts.vmax} km/h · ` +
    `EPSG:27700 · ${new Date().toISOString().slice(0,10)}`, pad, 48);

  // left data panel
  ctx.fillStyle = '#f6f5f2'; ctx.fillRect(0, headH, panelW, mapCv.height);
  let y = headH + 26;
  const line = (txt, opt) => {
    opt = opt || {};
    ctx.fillStyle = opt.col || '#14181c';
    ctx.font = (opt.bold ? '700 ' : '') + (opt.size || 12.5) + 'px system-ui,sans-serif';
    ctx.fillText(txt, pad + (opt.indent || 0), y);
    y += opt.gap || 19;
  };
  let gmax = 0, fill = 0, cut = 0;
  for (let i = 0; i < r.P.length; i++) {
    gmax = Math.max(gmax, Math.abs(r.vp.grade[i]));
    fill = Math.max(fill, r.vp.diff[i]); cut = Math.max(cut, -r.vp.diff[i]);
  }
  line('GEOMETRY', { bold: true, size: 11, col: '#6b7280', gap: 21 });
  line(`Length ${(L/1000).toFixed(2)} km · min R ${Math.round(rmin).toLocaleString()} m`);
  line(`Max gradient ${gmax.toFixed(2)} % · vertical R ${w.vCurveR.toLocaleString()} m`);
  line(`Max fill / cut ${fill.toFixed(0)} / ${cut.toFixed(0)} m`, { gap: 26 });

  line('STRUCTURES', { bold: true, size: 11, col: '#6b7280', gap: 21 });
  const tot = {};
  for (const s of r.structs) tot[s.id] = (tot[s.id]||0) + r.vp.ds;
  for (const k in E.STRUCT) {
    const s = E.STRUCT[k], m = tot[s.id] || 0;
    if (!m) continue;
    ctx.fillStyle = s.colour; ctx.fillRect(pad, y-9, 18, 7);
    line(`${s.label}  ${(m/1000).toFixed(1)} km  (${(m/L*100).toFixed(0)}%)`, { indent: 26 });
  }
  y += 9;
  if (r.services) {
    line('SERVICE PATTERNS — one lap', { bold: true, size: 11, col: '#6b7280', gap: 21 });
    for (const k of SERVICE_KEYS) {
      const s = r.services[k]; if (!s) continue;
      ctx.fillStyle = SERVICE_COL[k]; ctx.fillRect(pad, y-9, 18, 7);
      line(`${s.label}`, { indent: 26, bold: true, gap: 16 });
      line(`${(s.sp.run/60).toFixed(1)} min run + ${(s.sp.dwellTotal/60).toFixed(1)} dwell = ` +
           `${(s.sp.total/60).toFixed(1)} min · avg ${s.sp.avg.toFixed(0)} km/h`,
           { indent: 26, col: '#4b5563', gap: 22 });
    }
  }
  if (r.layout) {
    y += 4;
    line('TRACKS', { bold: true, size: 11, col: '#6b7280', gap: 21 });
    line(`${r.layout.fourKm.toFixed(0)} km four-track (${r.layout.pct.toFixed(1)}%)`);
    line(`passing: ${PASSING_STATIONS.join(' ')} · hub ${HUB}`, { col: '#4b5563' });
  }

  // map + full-width long section, then save
  ctx.drawImage(mapCv, panelW, headH);
  const prof = document.createElement('canvas');
  prof.width = W - 2*pad; prof.height = profH - pad;
  R.drawProfile(prof, r);
  ctx.drawImage(prof, pad, headH + mapCv.height + 6);
  const a = document.createElement('a');
  a.download = 'london2100_loop_sheet.png';
  a.href = cv.toDataURL('image/png'); a.click();
  setStatus('Sheet exported — data panel + map + long section');
  setTimeout(() => setStatus(''), 3500);
}
function download(name, text, mime) {
  const b = new Blob([text], {type: mime});
  const a = document.createElement('a');
  a.download = name; a.href = URL.createObjectURL(b); a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href), 4000);
}
function exportCSV() {
  if (!result) return;
  const r = result;
  let s = 'chainage_m,easting,northing,ground_m,rail_m,cut_fill_m,gradient_pct,radius_m,structure,speed_kmh,time_s\n';
  for (let i = 0; i < r.P.length; i++) {
    const R_ = isFinite(r.R[i]) ? r.R[i].toFixed(0) : '';
    s += [r.P[i].s.toFixed(1), r.P[i].E.toFixed(2), r.P[i].N.toFixed(2),
          r.vp.ground[i].toFixed(2), r.vp.z[i].toFixed(2), r.vp.diff[i].toFixed(2),
          r.vp.grade[i].toFixed(3), R_, r.structs[i].id,
          (r.sp.v[i]*3.6).toFixed(1), r.sp.t[i].toFixed(1)].join(',') + '\n';
  }
  download('london2100_alignment.csv', s, 'text/csv');
}
function exportGeoJSON() {
  if (!result) return;
  const r = result;
  const feats = r.runs.map(run => ({
    type: 'Feature',
    properties: { structure: run.type.id, from_m: Math.round(run.s0), to_m: Math.round(run.s1),
                  length_m: Math.round(run.s1-run.s0) },
    geometry: { type: 'LineString',
      coordinates: r.P.slice(run.i0, run.i1+1).map(p => [p.E, p.N]) }
  }));
  const gj = { type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::27700' } },
    properties: { length_m: Math.round(r.P[r.P.length-1].s),
                  min_radius_m: Math.round(Math.min(...r.R.filter(x=>isFinite(x)).map(Math.abs))),
                  journey_time_s: Math.round(r.sp.total) },
    features: feats };
  download('london2100_alignment.geojson', JSON.stringify(gj, null, 1), 'application/geo+json');
}

boot();
})();
