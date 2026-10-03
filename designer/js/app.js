/* ===========================================================================
   Alignment Designer v12 :: APP
   Wiring: project loading, the design standard, control-point editing, running
   the search, the results and comparison panels, and export.
   =========================================================================== */
(function () {
'use strict';
const E = window.ENGINE, R = window.RENDER, S = window.STANDARDS,
      C = window.COSTS, ST = window.STUDY, X = window.EXPORT;
const $ = id => document.getElementById(id);

let map = null, result = null, study = null, busy = false;
let projects = [], controls = [], strideAuto = true, hoverIdx = null;

const cfg = {
  mode: 'road',
  designSpeed: 100,
  params: {},
  weights: Object.assign({}, E.DEFAULT_WEIGHTS),
  criteriaWeights: {},
  costOverrides: { rates: {}, qrates: {} },
  useDesirable: false,
  closed: false,
  stopAtControls: true,
  stride: 400,
  corridor: 0.30,
  tieControls: true,
};

/* ------------------------------------------------------------ utilities -- */
function setStatus(msg) {
  const el = $('status');
  if (!msg) { el.style.display = 'none'; return; }
  el.style.display = 'block'; el.textContent = msg;
}
function boot(pct, msg) {
  const b = $('boot');
  if (pct === null) { b.style.display = 'none'; return; }
  $('bootBar').style.width = Math.round(pct * 100) + '%';
  if (msg) $('bootMsg').textContent = msg;
}
const fmt = (v, d) => (v === undefined || v === null || !isFinite(v)) ? '—'
                    : v.toLocaleString(undefined, { maximumFractionDigits: d === undefined ? 0 : d });
function defer(fn) { return new Promise(r => setTimeout(() => { fn(); r(); }, 30)); }

/* ----------------------------------------------------------- BOOTSTRAP --- */
async function start() {
  boot(0.05, 'reading the project list…');
  try {
    const res = await fetch('projects/index.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    projects = (await res.json()).projects || [];
  } catch (err) {
    boot(0.05, 'no projects found — run build/make_demo.py, then reload');
    console.error(err);
    return;
  }
  if (!projects.length) {
    boot(0.05, 'projects/index.json is empty — run build/make_demo.py');
    return;
  }
  const sel = $('project');
  projects.forEach(p => sel.add(new Option(p.name, p.id)));
  sel.onchange = () => loadProject(sel.value);

  const want = location.hash.replace('#', '');
  const pick = projects.find(p => p.id === want) || projects[0];
  sel.value = pick.id;
  await loadProject(pick.id);
  boot(null);
}

async function loadProject(id) {
  const p = projects.find(q => q.id === id) || projects[0];
  boot(0.15, 'downloading ' + p.name + '…');
  location.hash = p.id;
  const res = await fetch('projects/' + p.file, { cache: 'no-store' });
  const payload = await res.json();
  boot(0.4, 'decompressing terrain and constraint grids…');
  await E.loadProject(payload, (i, n, k) =>
    boot(0.4 + 0.5 * i / n, 'decompressing ' + k + '…'));
  boot(0.92, 'preparing the map…');

  // Defaults the project itself carries — an import can nominate the mode and
  // speed it was set up for, which is usually what the user wants first.
  const d = E.G.defaults || {};
  cfg.mode = S.MODES[d.mode] ? d.mode : 'road';
  cfg.params = S.defaultParams(cfg.mode);
  cfg.designSpeed = d.designSpeed || S.MODES[cfg.mode].defaultSpeed;
  cfg.closed = !!d.closed;
  cfg.weights = Object.assign({}, E.DEFAULT_WEIGHTS);
  strideAuto = true;
  result = null; study = null; hoverIdx = null;

  controls = (E.G.controls || []).map((c, i) => ({
    id: c.id || ('CP' + (i+1)), name: c.name || c.id || ('CP' + (i+1)),
    E: c.E, N: c.N, kind: c.kind || 'control',
  }));
  /* A project with 17 seeded points is a circuit study; one with two is a
     point-to-point. Neither should force the other, so only the first two are
     taken by default when there are many, and the rest stay available in the
     card as a hint. */
  if (controls.length > 8 && !cfg.closed) controls = controls.slice(0, 2);

  const cv = $('map');
  if (!map) {
    map = new R.MapView(cv);
    bindMap();
  } else {
    map.showLayers = {}; map.layerAlpha = {};
    map.reset();
  }
  map.controls = controls;
  map.result = null; map.study = null; map.selectedId = null;
  resize();

  $('projCard').innerHTML =
    `${E.G.crs} · ${fmt(E.G.nx)}×${fmt(E.G.ny)} cells at ${E.G.cell} m · ` +
    `${fmt((E.G.xmax-E.G.xmin)/1000,1)} × ${fmt((E.G.ymax-E.G.ymin)/1000,1)} km<br>` +
    `elevation ${fmt(E.G.zmin)}–${fmt(E.G.zmax)} m` +
    (E.G.notes ? `<br><span style="color:#8a9099">${E.G.notes}</span>` : '');

  /* The project's own defaults have to reach the switches, not just `cfg` — a
     closed-circuit project that loads with the circuit box unticked is telling
     the user something untrue about what it is about to route. */
  $('closed').checked = cfg.closed;
  $('stopAt').checked = cfg.stopAtControls;
  $('useDesirable').checked = cfg.useDesirable;
  $('s-corr').value = cfg.corridor;
  $('v-corr').textContent = '±' + Math.round(cfg.corridor * 100) + ' %';

  const ref = E.G.reference;
  $('runRef').style.display = ref ? '' : 'none';
  if (ref) $('runRef').textContent = 'Load reference: ' + fmt(ref.length_m / 1000, 1) + ' km ' +
                                     (ref.closed ? 'loop' : 'line');

  buildModeUI(); buildParamUI(); buildWeightUI(); buildRateUI(); buildCriteriaUI();
  buildLayerUI(); buildViewUI(); buildGridInfo(); buildControlList();
  updateStandard();
  map.fit(); map.draw(); redrawCharts();
}

/* --------------------------------------------------------------- LAYOUT -- */
function resize() {
  const cv = $('map');
  const r = cv.parentElement.getBoundingClientRect();
  cv.width = Math.max(10, r.width); cv.height = Math.max(10, r.height);
  for (const id of ['profile', 'haul']) {
    const c = $(id), b = c.parentElement.getBoundingClientRect();
    c.width = Math.max(10, b.width); c.height = Math.max(10, b.height - 26);
  }
  if (map) { map.draw(); redrawCharts(); }
}
window.addEventListener('resize', resize);

/* -------------------------------------------------------- MAP BEHAVIOUR -- */
function bindMap() {
  map.onHover = wl => {
    const ix = E.e2ix(wl.E), iy = E.n2iy(wl.N);
    if (ix < 0 || iy < 0 || ix >= E.G.nx || iy >= E.G.ny) {
      $('readout').textContent = '—'; return;
    }
    const g = E.G, i = iy * g.nx + ix;
    let s = `E ${wl.E.toFixed(0)}  N ${wl.N.toFixed(0)}` +
            ` &nbsp;|&nbsp; ${g.layer.dem[i].toFixed(0)} m`;
    if (g.layer.slope) s += ` &nbsp;|&nbsp; slope ${g.layer.slope[i].toFixed(1)}%`;
    for (const k of E.COVERAGE_KEYS) {
      if (!E.has(k) || g.layer[k][i] < 0.15) continue;
      s += ` &nbsp;|&nbsp; <b>${(R.LAYER_STYLE[k] || {}).label || k}</b>`;
    }
    $('readout').innerHTML = s;

    if (result && result.P) {
      const rad = 30 / map.zoom, r2 = rad * rad;
      let bi = -1, bd = r2;
      for (let q = 0; q < result.P.length; q++) {
        const dE = result.P[q].E - wl.E, dN = result.P[q].N - wl.N;
        const d = dE*dE + dN*dN;
        if (d < bd) { bd = d; bi = q; }
      }
      setHover(bi >= 0 ? bi : null);
    }
  };
  map.onAddControl = w => {
    const n = controls.length + 1;
    controls.push({ id: 'CP' + n, name: 'CP' + n, E: w.E, N: w.N, kind: 'control' });
    buildControlList(); map.draw(); updateStandard();
  };
  map.onDeleteControl = i => {
    controls.splice(i, 1); buildControlList(); map.draw(); updateStandard();
  };
  map.onControlsChanged = () => { buildControlList(); updateStandard(); };

  $('map').addEventListener('mouseleave', () => setHover(null));
  for (const id of ['profile', 'haul']) {
    $(id).addEventListener('mousemove', e => {
      if (!result || !result._profX) return;
      const t = result._profX;
      const s = (e.offsetX - t.ml) / (t.W - t.ml - t.right) * t.L;
      if (s < 0 || s > t.L) { setHover(null); return; }
      setHover(Math.max(0, Math.min(result.P.length - 1, Math.round(s / 25))));
    });
    $(id).addEventListener('mouseleave', () => setHover(null));
  }

  const modeBtn = (id, m) => $(id).onclick = () => {
    map.editMode = m;
    for (const b of ['mPan','mAdd','mDel']) $(b).classList.toggle('on', b === id);
  };
  modeBtn('mPan', 'pan'); modeBtn('mAdd', 'add'); modeBtn('mDel', 'delete');
  $('mFit').onclick = () => {
    if (result) map.fitTo(result.P);
    else if (controls.length > 1) map.fitTo(controls);
    else map.fit();
    map.draw();
  };
}

let hoverRaf = 0;
function setHover(i) {
  if (hoverIdx === i) return;
  hoverIdx = i; map.hoverIdx = i;
  if (!hoverRaf) hoverRaf = requestAnimationFrame(() => {
    hoverRaf = 0; map.draw(); redrawCharts();
  });
}

/* --------------------------------------------------- STANDARD + PARAMS --- */
function buildModeUI() {
  const sel = $('mode'); sel.innerHTML = '';
  S.modeList().forEach(([k, label]) => sel.add(new Option(label, k)));
  sel.value = cfg.mode;
  sel.onchange = () => {
    cfg.mode = sel.value;
    cfg.params = S.defaultParams(cfg.mode);
    const m = S.MODES[cfg.mode];
    cfg.designSpeed = m.speeds.indexOf(cfg.designSpeed) >= 0 ? cfg.designSpeed : m.defaultSpeed;
    strideAuto = true;
    buildSpeedUI(); buildParamUI(); updateStandard();
  };
  buildSpeedUI();
}
function buildSpeedUI() {
  const sel = $('speed'); sel.innerHTML = '';
  S.MODES[cfg.mode].speeds.forEach(v => sel.add(new Option(v + ' km/h', v)));
  sel.value = cfg.designSpeed;
  sel.onchange = () => { cfg.designSpeed = +sel.value; strideAuto = true; updateStandard(); };
}
function buildParamUI() {
  const host = $('modeParams'); host.innerHTML = '';
  const defs = S.MODES[cfg.mode].params;
  for (const k in defs) {
    const d = defs[k];
    const row = document.createElement('div'); row.className = 'row';
    if (d.type === 'select') {
      row.innerHTML = `<label>${d.label}</label>` +
        `<select style="flex:1.2">${d.options.map(o =>
          `<option value="${o[0]}"${String(cfg.params[k])===o[0]?' selected':''}>${o[1]}</option>`).join('')}</select>`;
      row.querySelector('select').onchange = ev => {
        cfg.params[k] = ev.target.value; strideAuto = true; updateStandard();
      };
    } else {
      row.innerHTML = `<label>${d.label}</label>` +
        `<input type="range" min="${d.min}" max="${d.max}" step="${d.step}" value="${cfg.params[k]}">` +
        `<span class="val">${(+cfg.params[k]).toFixed(d.step < 1 ? 2 : 0)} ${d.unit||''}</span>`;
      const inp = row.querySelector('input'), lab = row.querySelector('.val');
      inp.oninput = () => {
        cfg.params[k] = +inp.value;
        lab.textContent = (+inp.value).toFixed(d.step < 1 ? 2 : 0) + ' ' + (d.unit || '');
        strideAuto = true; updateStandard();
      };
    }
    host.appendChild(row);
  }
}

/** Current derived standard, and the search-lattice consequences of it. */
function currentStandard() {
  return S.derive(cfg.mode, cfg.designSpeed, cfg.params, cfg.useDesirable);
}
function directLength() {
  let d = 0;
  for (let i = 1; i < controls.length; i++)
    d += Math.hypot(controls[i].E - controls[i-1].E, controls[i].N - controls[i-1].N);
  if (cfg.closed && controls.length > 2)
    d += Math.hypot(controls[0].E - controls[controls.length-1].E,
                    controls[0].N - controls[controls.length-1].N);
  return d;
}
function updateStandard() {
  const std = currentStandard();
  if (strideAuto) {
    cfg.stride = E.strideFor(std.rGoverning, directLength());
    const sl = $('s-stride');
    sl.value = Math.max(+sl.min, Math.min(+sl.max, cfg.stride));
    cfg.stride = +sl.value;
    $('v-stride').textContent = cfg.stride + ' m';
  }
  const floor = Math.ceil(std.rGoverning * E.DB * 1.02 / 25) * 25;
  const eff = Math.max(cfg.stride, floor);
  const maxB = Math.max(1, Math.floor(eff / std.rGoverning / E.DB));
  const rAch = eff / (maxB * E.DB);
  $('geomNote').innerHTML =
    `Lattice: ${maxB} heading bucket${maxB>1?'s':''} of ${(E.DB*180/Math.PI).toFixed(2)}° per ` +
    `${eff} m step → <b>every</b> route it can produce has R ≥ ` +
    `<b>${fmt(rAch)} m</b> against a required ${fmt(std.rGoverning)} m.` +
    (eff > cfg.stride
      ? ` <span style="color:var(--amber)">The stride is held up from ${cfg.stride} m — ` +
        `any shorter and one heading bucket already breaks the radius.</span>` : '') +
    `<br>The search lengthens it further if the corridor is too large to hold in memory; ` +
    `the stride actually used is reported with the result.` +
    `<br>${controls.length} control point${controls.length===1?'':'s'} · ` +
    `${fmt(directLength()/1000, 1)} km direct.`;

  $('stdBasis').innerHTML =
    `<table class="res">
      <tr><td>Mode</td><td>${std.modeLabel}</td></tr>
      <tr><td>Design speed</td><td>${std.designSpeed} km/h</td></tr>
      <tr><td>Minimum radius (absolute)</td><td>${fmt(std.rMin)} m</td></tr>
      <tr><td>Minimum radius (desirable)</td><td>${fmt(std.rDes)} m</td></tr>
      <tr class="okrow"><td>Governing radius used</td><td>${fmt(std.rGoverning)} m</td></tr>
      <tr><td>Ruling gradient</td><td>${std.maxGrade.toFixed(2)} %</td></tr>
      <tr><td>Vertical curve R crest / sag</td><td>${fmt(std.vCrestR)} / ${fmt(std.vSagR)} m</td></tr>
      <tr><td>Transition length</td><td>${fmt(std.transition)} m</td></tr>
      <tr><td>Formation width</td><td>${std.width.toFixed(1)} m</td></tr>
    </table>
    <div class="basis">${std.basis.map(b => '· ' + b).join('<br>')}</div>`;
  buildLegend();
}

/* --------------------------------------------------- CONTROL POINT LIST -- */
function buildControlList() {
  const host = $('cpList'); host.innerHTML = '';
  controls.forEach((c, i) => {
    const row = document.createElement('div'); row.className = 'cp';
    const col = i === 0 ? '#1d7a35' : i === controls.length-1 ? '#b8272b' : '#14181c';
    row.innerHTML = `<span class="dot" style="background:${col}"></span>` +
      `<input type="text" value="${c.name}">` +
      `<span style="font:10px ui-monospace;color:#9aa3ad">${(c.E/1000).toFixed(1)},${(c.N/1000).toFixed(1)}</span>` +
      `<button title="remove">×</button>`;
    row.querySelector('input').onchange = ev => { c.name = ev.target.value; map.draw(); };
    row.querySelector('button').onclick = () => {
      controls.splice(i, 1); buildControlList(); map.draw(); updateStandard();
    };
    host.appendChild(row);
  });
  if (!controls.length)
    host.innerHTML = '<div class="note">No control points yet.</div>';
  $('cpHint').style.display = controls.length >= 2 ? 'none' : 'block';
  map.controls = controls;
}

/* -------------------------------------------------------------- WEIGHTS -- */
function buildWeightUI() {
  const host = $('costW'); host.innerHTML = '';
  const active = E.activeCostLayers();
  if (!active.length) {
    host.innerHTML = '<div class="note">This project carries terrain only — there are no ' +
      'constraint layers to weight. Import GeoJSON constraints with build/import_dem.py to ' +
      'bring settlements, protected land, water and existing infrastructure into the cost ' +
      'surface.</div>';
  }
  for (const k of active) {
    const st = R.LAYER_STYLE[k] || {};
    const row = document.createElement('div'); row.className = 'row';
    const v = cfg.weights[k] === undefined ? 0 : cfg.weights[k];
    row.innerHTML =
      `<label><span class="swatch" style="background:rgb(${(st.rgb||[128,128,128]).join(',')})"></span> ` +
      `${st.label || k}</label>` +
      `<input type="range" min="${k==='greenbelt'?-20:0}" max="${k==='exclusion'?8000:200}" ` +
      `step="${k==='exclusion'?100:1}" value="${v}">` +
      `<span class="val">${v}</span>`;
    const inp = row.querySelector('input'), lab = row.querySelector('.val');
    inp.oninput = () => { cfg.weights[k] = +inp.value; lab.textContent = inp.value; };
    host.appendChild(row);
  }

  const th = $('terrW'); th.innerHTML = '';
  const terr = [['slope','Point slope', 0, 40], ['terrGrade','Grade along route', 0, 60],
                ['terrUndul','Undulation', 0, 20], ['turn','Curvature penalty', 0, 200],
                ['terrWindow','Profile stiffness window', 400, 3000]];
  for (const [k, label, lo, hi] of terr) {
    const row = document.createElement('div'); row.className = 'row';
    row.innerHTML = `<label>${label}</label>` +
      `<input type="range" min="${lo}" max="${hi}" step="${k==='terrWindow'?100:1}" value="${cfg.weights[k]}">` +
      `<span class="val">${cfg.weights[k]}${k==='terrWindow'?' m':''}</span>`;
    const inp = row.querySelector('input'), lab = row.querySelector('.val');
    inp.oninput = () => { cfg.weights[k] = +inp.value;
                          lab.textContent = inp.value + (k==='terrWindow'?' m':''); };
    th.appendChild(row);
  }
}

function buildRateUI() {
  const host = $('rateW'); host.innerHTML = '';
  const std = currentStandard();
  const rr = [['atGrade','At grade','M/km'], ['viaduct','Viaduct','M/km'],
              ['bridge','Bridge','M/km'], ['tunnel','Tunnel','M/km']];
  for (const [k, label, unit] of rr) {
    const row = document.createElement('div'); row.className = 'row';
    const v = cfg.costOverrides.rates[k] === undefined ? std.rates[k] : cfg.costOverrides.rates[k];
    row.innerHTML = `<label>${label}</label>` +
      `<input type="number" step="0.5" value="${v}" style="flex:1;max-width:90px">` +
      `<span class="val" style="min-width:44px">${unit}</span>`;
    row.querySelector('input').onchange = ev =>
      cfg.costOverrides.rates[k] = +ev.target.value;
    host.appendChild(row);
  }
  const qq = [['cutM3','Excavation','per m³'], ['fillM3','Fill placement','per m³'],
              ['landM2','Land take','per m²'], ['landBuiltM2','Built-up acquisition','per m²']];
  for (const [k, label, unit] of qq) {
    const row = document.createElement('div'); row.className = 'row';
    const v = (cfg.costOverrides.qrates[k] === undefined ? std.qrates[k] : cfg.costOverrides.qrates[k]) * 1e6;
    row.innerHTML = `<label>${label}</label>` +
      `<input type="number" step="0.5" value="${v.toFixed(1)}" style="flex:1;max-width:90px">` +
      `<span class="val" style="min-width:44px">${unit}</span>`;
    row.querySelector('input').onchange = ev =>
      cfg.costOverrides.qrates[k] = +ev.target.value / 1e6;
    host.appendChild(row);
  }
}

function buildCriteriaUI() {
  const host = $('critW'); host.innerHTML = '';
  for (const c of C.CRITERIA) {
    const v = cfg.criteriaWeights[c.key] === undefined ? c.weight : cfg.criteriaWeights[c.key];
    const row = document.createElement('div'); row.className = 'row';
    row.innerHTML = `<label>${c.label}</label>` +
      `<input type="range" min="0" max="60" value="${v}"><span class="val">${v}</span>`;
    const inp = row.querySelector('input'), lab = row.querySelector('.val');
    inp.oninput = () => {
      cfg.criteriaWeights[c.key] = +inp.value; lab.textContent = inp.value;
      if (study && study.options.length) { rankStudy(); showComparison(); }
    };
    host.appendChild(row);
  }
}

/* --------------------------------------------------------------- LAYERS -- */
function buildLayerUI() {
  const host = $('layerToggles'); host.innerHTML = '';
  const topo = document.createElement('label');
  topo.className = 'chk';
  topo.innerHTML = `<input type="checkbox" ${map.showTopo?'checked':''}><span>Terrain relief</span>`;
  topo.querySelector('input').onchange = ev => { map.showTopo = ev.target.checked; map.draw(); };
  host.appendChild(topo);

  for (const k in R.LAYER_STYLE) {
    if (!E.has(k)) continue;
    const st = R.LAYER_STYLE[k];
    const row = document.createElement('div'); row.className = 'row';
    row.innerHTML =
      `<label class="chk" style="flex:1;margin:0"><input type="checkbox" ${map.showLayers[k]?'checked':''}>` +
      `<span class="swatch" style="background:rgb(${st.rgb.join(',')})"></span>` +
      `<span>${st.label}</span></label>` +
      `<input type="range" min="5" max="100" value="${Math.round(map.layerAlpha[k]*100)}" ` +
      `title="opacity" style="width:56px;flex:none">`;
    const ins = row.querySelectorAll('input');
    ins[0].onchange = () => { map.showLayers[k] = ins[0].checked; map.draw(); };
    ins[1].oninput = () => { map.layerAlpha[k] = +ins[1].value/100;
                             if (map.showLayers[k]) map.draw(); };
    host.appendChild(row);
  }
}
function buildGridInfo() {
  const g = E.G;
  $('gridInfo').innerHTML = `<table class="res">
    <tr><td>Project</td><td>${g.name}</td></tr>
    <tr><td>CRS</td><td>${g.crs}</td></tr>
    <tr><td>Grid</td><td>${fmt(g.nx)} × ${fmt(g.ny)} @ ${g.cell} m</td></tr>
    <tr><td>Extent</td><td>${fmt((g.xmax-g.xmin)/1000,1)} × ${fmt((g.ymax-g.ymin)/1000,1)} km</td></tr>
    <tr><td>Easting</td><td>${fmt(g.xmin)} – ${fmt(g.xmax)}</td></tr>
    <tr><td>Northing</td><td>${fmt(g.ymin)} – ${fmt(g.ymax)}</td></tr>
    <tr><td>Elevation</td><td>${fmt(g.zmin)} – ${fmt(g.zmax)} m</td></tr>
    <tr><td>Layers</td><td>${Object.keys(g.layer).length}</td></tr>
  </table><div class="note">${Object.keys(g.layer).join(' · ')}</div>`;
}

function buildViewUI() {
  const sel = $('view'); sel.innerHTML = '';
  for (const k in R.VIEW) sel.add(new Option(R.VIEW[k], k));
  sel.value = map.view;
  sel.onchange = () => { map.view = sel.value; buildLegend(); map.draw(); };
}

/* --------------------------------------------------------------- LEGEND -- */
function buildLegend() {
  const li = (c, t) => `<div class="li"><div class="sw" style="background:${c}"></div>${t}</div>`;
  const v = map ? map.view : 'alignment';
  const std = currentStandard();
  let h = '';
  if (v === 'structures') {
    h = '<h4>Structure</h4>';
    for (const k in E.STRUCT) h += li(E.STRUCT[k].colour, E.STRUCT[k].label);
  } else if (v === 'earthworks') {
    h = '<h4>Cut and fill</h4>';
    h += li(R.cutFillColour(-20), 'Deep cut (20 m+)');
    h += li(R.cutFillColour(-6),  'Cutting');
    h += li('#77807a', 'At grade');
    h += li(R.cutFillColour(6),   'Embankment');
    h += li(R.cutFillColour(20),  'High fill (20 m+)');
  } else if (v === 'gradient') {
    h = `<h4>Gradient — ruling ${std.maxGrade.toFixed(1)} %</h4>`;
    h += li(R.gradeColour(0, std.maxGrade), 'Level');
    h += li(R.gradeColour(std.maxGrade/2, std.maxGrade), (std.maxGrade/2).toFixed(1) + ' %');
    h += li(R.gradeColour(std.maxGrade, std.maxGrade), 'At the ruling gradient');
  } else if (v === 'curvature') {
    h = `<h4>Radius vs ${fmt(std.rGoverning)} m</h4>`;
    h += li('#9aa3ad', 'Tangent / very open');
    h += li('#2e7d32', '≥ 1.3 × required');
    h += li('#e08a1e', '1.0 – 1.3 × required');
    h += li('#c62828', 'Below the standard');
  } else if (v === 'speed') {
    const pk = result && result.sp ? result.sp.peak : cfg.designSpeed;
    h = '<h4>Speed achieved</h4>';
    h += li('rgb(214,40,40)', 'Stopped / stop zone');
    h += li('rgb(240,130,30)', `~${Math.round(pk*0.25)} km/h`);
    h += li('rgb(235,205,40)', `~${Math.round(pk*0.5)} km/h`);
    h += li('rgb(60,170,75)', `~${Math.round(pk*0.75)} km/h`);
    h += li('rgb(30,90,210)', `Peak ${Math.round(pk)} km/h`);
  } else if (v === 'options') {
    h = '<h4>Option family</h4>';
    h += li(ST.rampColour(0), 'Best on the weighted score');
    h += li(ST.rampColour(0.5), 'Middle');
    h += li(ST.rampColour(1), 'Worst');
    h += '<div style="margin-top:6px;font-size:10px;color:#4b5563">Thicker lines are on the ' +
         'Pareto front — nothing beats them on every criterion at once.</div>';
  } else {
    h = '<h4>Constraints</h4>';
    for (const k in R.LAYER_STYLE) {
      if (!E.has(k) || !map.showLayers[k]) continue;
      h += li(`rgb(${R.LAYER_STYLE[k].rgb.join(',')})`, R.LAYER_STYLE[k].label);
    }
    if (h === '<h4>Constraints</h4>') h += '<div style="color:#6b7280">No layers shown</div>';
  }
  $('legend').innerHTML = h;
}

/* ------------------------------------------------------------ RUN: ONE --- */
function buildCfg() {
  const std = currentStandard();
  return Object.assign({}, cfg, {
    accel: std.kinematics.accel, brake: std.kinematics.brake,
    dwell: std.kinematics.dwell,
  });
}

/* The project's reference alignment — for London, the settled 412 km orbital
   from the v12 delivery build. Evaluated exactly as supplied under the current
   standard, so the question it answers is "does the line we settled on meet
   this standard, and what does it cost and take under it?" */
async function loadReference() {
  const ref = E.G.reference;
  if (!ref || busy) return;
  busy = true;
  setStatus('Evaluating ' + (ref.name || 'the reference alignment') + '…');
  const t0 = performance.now();
  await defer(() => {
    try {
      const r = ST.evaluateReference(ref, buildCfg());
      r.ms = performance.now() - t0;
      result = r; study = null;
      map.result = r; map.study = null; map.selectedId = null;
      if (map.view === 'options') { map.view = 'alignment'; $('view').value = 'alignment'; }
      map.fitTo(r.P); map.draw(); redrawCharts(); showResults(); buildLegend();
      showTab('results');
      setStatus('');
    } catch (err) {
      setStatus('Error: ' + err.message); console.error(err);
    }
  });
  busy = false;
}

async function runOne() {
  if (busy || controls.length < 2) {
    if (controls.length < 2) setStatus('Place at least two control points first');
    setTimeout(() => setStatus(''), 2500);
    return;
  }
  busy = true; $('runOne').disabled = $('runStudy').disabled = true;
  setStatus('Searching the corridor…');
  const t0 = performance.now();
  await defer(() => {
    try {
      const sc = { id: '—', name: 'Working alignment', priority: 'balanced',
                   V: cfg.designSpeed, offset: 0 };
      const r = ST.runOne(sc, buildCfg(), controls);
      if (r.error) {
        setStatus(errorText(r));
        $('results').innerHTML = `<p class="note" style="color:#c62828"><b>Routing failed.</b><br>${errorText(r)}</p>`;
        result = null; map.result = null; map.draw(); redrawCharts();
        return;
      }
      r.ms = performance.now() - t0;
      result = r; study = null;
      map.result = r; map.study = null; map.selectedId = null;
      if (map.view === 'options') { map.view = 'alignment'; $('view').value = 'alignment'; }
      map.fitTo(r.P); map.draw(); redrawCharts(); showResults(); buildLegend();
      setStatus('');
    } catch (err) {
      setStatus('Error: ' + err.message); console.error(err);
    }
  });
  busy = false; $('runOne').disabled = $('runStudy').disabled = false;
}

function errorText(r) {
  if (r.error === 'radius audit failed')
    return `Radius audit FAILED: ${fmt(r.minR)} m at ${fmt(r.chainage/1000,1)} km against ` +
           `${fmt(r.rAchievable)} m guaranteed. The alignment has a corner — not delivered.`;
  if (r.error === 'no heading-continuous route')
    return `Cannot route ${r.leg || 'a leg'} with heading continuity. Raise the search stride, ` +
           `widen the corridor, lower the design speed, or move that control point.`;
  return r.error || 'no route found';
}

/* ---------------------------------------------------------- RUN: STUDY --- */
async function runStudy() {
  if (busy || controls.length < 2) {
    if (controls.length < 2) setStatus('Place at least two control points first');
    setTimeout(() => setStatus(''), 2500);
    return;
  }
  busy = true; $('runOne').disabled = $('runStudy').disabled = true;
  showTab('options');
  const t0 = performance.now();
  try {
    study = await ST.run(controls, buildCfg(), (i, n, name) =>
      setStatus(`Option ${i+1} of ${n} — ${name}…`));
    if (!study.options.length) {
      setStatus('No option could be routed');
      $('cmp').innerHTML = `<p class="note" style="color:#c62828"><b>Nothing routed.</b><br>` +
        study.failed.map(f => `${f.sc.name}: ${f.error}`).join('<br>') + `</p>`;
      return;
    }
    rankStudy();
    map.study = study.options;
    map.view = 'options'; $('view').value = 'options';
    const best = study.ranked[0];
    selectOption(best.sc.id, false);
    map.fitTo(best.P); map.draw();
    showComparison(); buildLegend();
    setStatus(`${study.options.length} options in ${((performance.now()-t0)/1000).toFixed(1)} s`);
    setTimeout(() => setStatus(''), 4000);
  } catch (err) {
    setStatus('Error: ' + err.message); console.error(err);
  } finally {
    busy = false; $('runOne').disabled = $('runStudy').disabled = false;
  }
}

function rankStudy() {
  study.ranked = C.score(study.options, cfg.criteriaWeights);
  study.front = C.pareto(study.options);
  const ids = new Set(study.front.map(o => o.sc.id));
  const lo = study.ranked[0].score, hi = study.ranked[study.ranked.length-1].score;
  study.options.forEach(o => {
    o.colour = ST.rampColour(hi > lo ? (o.score - lo) / (hi - lo) : 0);
    o.onFront = ids.has(o.sc.id);
  });
}

function selectOption(id, fit) {
  const o = study.options.find(z => z.sc.id === id);
  if (!o) return;
  result = o; map.selectedId = id; map.result = o;
  if (fit !== false) map.fitTo(o.P);
  map.draw(); redrawCharts(); showResults(); showComparison();
}

/* -------------------------------------------------------------- RESULTS -- */
function redrawCharts() {
  R.drawProfile($('profile'), result, hoverIdx);
  R.drawMassHaul($('haul'), result, hoverIdx);
  if (result) {
    $('profStat').textContent =
      `max cut ${result.q.earthworks.maxCut.toFixed(0)} m · max fill ${result.q.earthworks.maxFill.toFixed(0)} m`;
    $('haulStat').textContent =
      `cut ${(result.q.earthworks.cutM3/1e6).toFixed(2)} · fill ${(result.q.earthworks.fillM3/1e6).toFixed(2)} Mm³`;
  } else { $('profStat').textContent = ''; $('haulStat').textContent = ''; }
}

function showResults() {
  const r = result;
  if (!r) return;
  const m = r.metrics, std = r.std, q = r.q;
  /* Judge the achieved radius against what the lattice actually guaranteed. On a
     leg with a reported throat relaxation the guarantee is deliberately lower
     than the mainline standard, and flagging that as a defect would cry wolf
     over a decision the tool has already explained. A genuine corner — a radius
     below the guarantee — is still an error and still shown as one. */
  const guarantee = Math.min(std.rGoverning, r.search.rAchievable || std.rGoverning);
  const radOK = m.minR >= guarantee * 0.96;
  const grOK = m.maxGrade <= std.maxGrade * 1.02;
  const crestOK = r.vp.minCrestR >= std.vCrestR * 0.96;
  const sagOK = r.vp.minSagR >= std.vSagR * 0.96;

  let h = `<table class="res">
    <tr><td>${r.search.closed ? 'Closed circuit' : 'Length'}</td><td>${fmt(m.length/1000,2)} km</td></tr>
    <tr><td>Direct distance</td><td>${fmt(m.direct/1000,2)} km</td></tr>
    <tr><td>Deviation</td><td>+${(m.deviation*100).toFixed(1)} %</td></tr>
    <tr class="${radOK?'okrow':'warnrow'}"><td>Minimum radius<br>
      <span style="color:#6b7280;font-weight:400">required ${fmt(std.rGoverning)} m</span></td>
      <td>${fmt(m.minR)} m</td></tr>
    <tr class="${grOK?'okrow':'warnrow'}"><td>Maximum gradient<br>
      <span style="color:#6b7280;font-weight:400">ruling ${std.maxGrade.toFixed(2)} %</span></td>
      <td>${m.maxGrade.toFixed(2)} %</td></tr>
    <tr class="${crestOK?'okrow':'amberrow'}"><td>Vertical R — crest</td><td>${fmt(r.vp.minCrestR)} m</td></tr>
    <tr class="${sagOK?'okrow':'amberrow'}"><td>Vertical R — sag</td><td>${fmt(r.vp.minSagR)} m</td></tr>
    ${r.vp.pins ? `<tr class="${r.vp.tieError<1?'okrow':'warnrow'}"><td>Tie into existing ground<br>
      <span style="color:#6b7280;font-weight:400">at the ${r.vp.pins === 2 ? 'two ends' : 'terminus'}</span></td>
      <td>${r.vp.tieError < 0.05 ? 'exact' : fmt(r.vp.tieError,1) + ' m out'}</td></tr>` : ''}
    <tr><td>Intersection points H / V</td><td>${m.hip} / ${r.vp.vip}</td></tr>
    ${r.search.reference
      ? `<tr><td>Source<br><span style="color:#6b7280;font-weight:400">evaluated as supplied — not re-routed</span></td>
           <td>reference</td></tr>
         <tr><td>${r.search.closed ? 'Closing segment' : 'Vertices'}</td>
           <td>${r.search.closed ? fmt(r.search.closingSegment,1) + ' m' : fmt(r.P.length)}</td></tr>`
      : `<tr><td>Searched at stride<br><span style="color:#6b7280;font-weight:400">guarantees R ≥ ${fmt(r.search.rAchievable)} m</span></td>
           <td>${fmt(r.search.stride)} m</td></tr>
         <tr><td>Terminal offset</td><td>${fmt(r.search.endGap)} m</td></tr>`}
    <tr><td>Journey time</td><td>${(r.sp.total/60).toFixed(2)} min</td></tr>
    <tr><td>Average speed</td><td>${r.sp.avg.toFixed(0)} km/h</td></tr>
    <tr><td>Peak speed achieved</td><td>${r.sp.peak.toFixed(0)} km/h</td></tr>
    ${r.ms ? `<tr><td>Solve time</td><td>${(r.ms/1000).toFixed(1)} s</td></tr>` : ''}
  </table>`;

  if (r.search.relaxed && r.search.relaxed.length) {
    const worst = Math.min.apply(null, r.search.relaxed.map(x => x.R));
    h += `<p class="note" style="color:#b45309"><b>Local radius relaxed on
      ${r.search.relaxed.length} leg${r.search.relaxed.length===1?'':'s'}:</b>
      ${r.search.relaxed.map(x => `${x.from} → ${x.to} at ${fmt(x.R)} m`).join(' · ')}.
      These approaches cannot be built at the ${fmt(std.rGoverning)} m mainline radius —
      there is not enough longitudinal room. A station throat at ${fmt(worst)} m caps line
      speed there at <b>${S.speedForRadius(cfg.mode, worst, std.params).toFixed(0)} km/h</b>,
      which the journey time below already accounts for. Move the control point to avoid it.</p>`;
  }
  if (r.vp.tieError >= 1)
    h += `<p class="note" style="color:#c62828"><b>The profile cannot reach the ground at a
      control point</b> — ${fmt(r.vp.tieError,1)} m short at
      ${fmt(r.P[r.vp.tieAt].s/1000,1)} km. Within a ${std.maxGrade.toFixed(1)} % ruling
      gradient there is not enough length to climb or fall to that level. Move the point,
      accept a steeper gradient, or let the alignment approach it from further away.</p>`;
  if (r.search.reference)
    h += `<p class="note"><b>${r.search.name || 'Reference alignment'}</b> — the line the
      project settled on, judged against the ${std.modeLabel.toLowerCase()} standard at
      ${std.designSpeed} km/h. ${radOK
        ? 'Every curve on it meets this standard.'
        : `Its tightest curve, <b>${fmt(m.minR)} m</b>, is below the ${fmt(std.rGoverning)} m
           this standard needs — the line was set for a different speed or rule, and the
           speed profile below caps it accordingly.`}
      Change mode or design speed and press the button again to re-judge it.</p>`;
  if (!radOK && !r.search.reference)
    h += `<p class="note" style="color:#c62828"><b>The achieved radius is below what the search
      guaranteed</b> (${fmt(m.minR)} m against ${fmt(guarantee)} m). Every arc the lattice can
      emit is compliant by construction, so this is a corner at a joint between legs, not a
      curve the search proposed. Do not use this alignment.</p>`;
  if (m.minR < std.rMin)
    h += `<p class="note" style="color:#c62828">Speed at the tightest curve is limited to
      <b>${S.speedForRadius(cfg.mode, m.minR, std.params).toFixed(0)} km/h</b>, below the
      ${std.designSpeed} km/h design speed.</p>`;
  else
    h += `<p class="note">The tightest curve supports
      <b>${S.speedForRadius(cfg.mode, m.minR, std.params).toFixed(0)} km/h</b> under this
      standard's comfort rule, against a ${std.designSpeed} km/h design speed.</p>`;

  /* Where each control point actually ends up. Intermediate stations are not
     held to existing ground — that over-constrains the profile — so the honest
     substitute is to show what each one costs vertically. A station 30 m in the
     air is a decision, and this is where a reader sees it. */
  const cps = (r.chn || []).filter(c => !c.node.synthetic);
  if (cps.length) {
    h += `<h3 style="margin-top:14px">Control points</h3><table class="res">`;
    for (const c of cps.slice().sort((a, b) => a.s - b.s)) {
      const d = r.vp.diff[c.idx];
      const tag = Math.abs(d) < 2 ? 'okrow' : Math.abs(d) < 15 ? '' : 'warnrow';
      h += `<tr class="${tag}"><td>${c.node.name}<br>
        <span style="color:#6b7280;font-weight:400">${fmt(c.s/1000,1)} km · ground ${fmt(r.vp.ground[c.idx])} m</span></td>
        <td>${fmt(r.vp.z[c.idx])} m<br><span style="color:#6b7280">${
          Math.abs(d) < 0.5 ? 'at grade' :
          (d > 0 ? fmt(d,1) + ' m fill' : fmt(-d,1) + ' m cut')}</span></td></tr>`;
    }
    h += `</table><p class="note">Only the two ends of an open route are held to existing
      ground. A station sits at the design level, on embankment or in cutting as the profile
      requires — but a large figure here is worth questioning.</p>`;
  }

  h += `<h3 style="margin-top:14px">Earthworks</h3><table class="res">
    <tr><td>Excavation</td><td>${fmt(q.earthworks.cutM3/1e6,2)} Mm³</td></tr>
    <tr><td>Fill</td><td>${fmt(q.earthworks.fillM3/1e6,2)} Mm³</td></tr>
    <tr class="${q.earthworks.balance>0.85&&q.earthworks.balance<1.35?'okrow':'amberrow'}">
      <td>Cut available : fill required<br><span style="color:#6b7280;font-weight:400">
        at ${(q.earthworks.swell*100).toFixed(0)} % usable</span></td>
      <td>${q.earthworks.balance>9.9?'&gt;10':q.earthworks.balance.toFixed(2)} : 1</td></tr>
    <tr><td>Net movement</td><td>${q.earthworks.netM3>=0
        ? fmt(q.earthworks.netM3/1e6,2)+' Mm³ to dispose'
        : fmt(-q.earthworks.netM3/1e6,2)+' Mm³ to import'}</td></tr>
    <tr><td>Max cut / fill</td><td>${q.earthworks.maxCut.toFixed(0)} / ${q.earthworks.maxFill.toFixed(0)} m</td></tr>
    <tr><td>Land take</td><td>${fmt(q.land.ha)} ha</td></tr>
  </table>`;

  h += `<h3 style="margin-top:14px">Structures</h3><table class="res">`;
  for (const k in E.STRUCT) {
    const s = E.STRUCT[k], t = q.byType[s.id];
    if (!t || t.m < 1) continue;
    h += `<tr><td><span class="sw" style="display:inline-block;width:14px;height:6px;
      border-radius:3px;background:${s.colour};margin-right:6px"></span>${s.label}</td>
      <td>${fmt(t.m/1000,2)} km · ${(t.m/m.length*100).toFixed(1)} %</td></tr>`;
  }
  h += `<tr><td>Tunnel portals</td><td>${q.portals}</td></tr>
        <tr><td>Water crossings</td><td>${q.waterCrossings}</td></tr></table>`;

  h += `<h3 style="margin-top:14px">Capital cost — comparative</h3><table class="res">
    <tr><td>Civils by structure</td><td>${fmt(q.cost.civils)} ${q.cost.currency}</td></tr>
    <tr><td>Earthworks and haul</td><td>${fmt(q.cost.earthworks)} ${q.cost.currency}</td></tr>
    <tr><td>Tunnel portals</td><td>${fmt(q.cost.portals)} ${q.cost.currency}</td></tr>
    <tr><td>Land and acquisition</td><td>${fmt(q.cost.land)} ${q.cost.currency}</td></tr>
    <tr style="font-weight:700"><td>TOTAL</td><td>${fmt(q.cost.total)} ${q.cost.currency}</td></tr>
    <tr><td>Per kilometre</td><td>${fmt(q.cost.perKm,1)} ${q.cost.currency}/km</td></tr>
  </table>`;

  const imp = Object.keys(q.impacts).filter(k => q.impacts[k].km > 0.01);
  if (imp.length) {
    h += `<h3 style="margin-top:14px">Footprint by constraint</h3><table class="res">`;
    for (const k of imp) {
      const st = R.LAYER_STYLE[k] || {};
      h += `<tr><td><span class="swatch" style="background:rgb(${(st.rgb||[128,128,128]).join(',')})"></span>
        ${st.label || k}</td><td>${fmt(q.impacts[k].km,1)} km · ${fmt(q.impacts[k].ha)} ha</td></tr>`;
    }
    h += `</table><p class="note">Surface length only — tunnelled sections pass beneath and are
      not counted as impact.</p>`;
  }

  const tz = E.trapezoid(m.length, std.designSpeed, std.kinematics.accel, std.kinematics.brake);
  const lost = r.sp.run - tz.t;
  h += `<p class="note">A straight run of the same ${fmt(m.length/1000,1)} km at
    ${std.designSpeed} km/h takes ${(tz.t/60).toFixed(1)} min; this alignment takes
    ${(r.sp.run/60).toFixed(1)} min running. ${lost > 6
      ? `The <b>${(lost/60).toFixed(1)} min</b> difference is what the curves and stops cost.`
      : `Curvature costs it almost nothing — the geometry is not what limits this route.`}</p>`;

  $('results').innerHTML = h;
}

/* ----------------------------------------------------------- COMPARISON -- */
function showComparison() {
  if (!study || !study.options.length) return;
  const best = study.ranked[0];
  const rows = study.ranked.map(o => {
    const isW = o.sc.id === best.sc.id, isS = map.selectedId === o.sc.id;
    return `<tr class="opt${isW?' win':''}${isS?' sel':''}" data-id="${o.sc.id}">
      <td><span class="swatch" style="background:${o.colour}"></span></td>
      <td>${isW?'<span class="crown">★</span> ':''}${o.sc.id}${o.onFront?' <span class="front">◆</span>':''}</td>
      <td>${o.sc.name}</td>
      <td>${o.std.designSpeed}</td>
      <td>${(o.metrics.length/1000).toFixed(1)}</td>
      <td>${(o.sp.total/60).toFixed(1)}</td>
      <td>${fmt(o.q.cost.total)}</td>
      <td>${(o.q.earthworks.cutM3/1e6).toFixed(1)}</td>
      <td>${fmt(o.search.stride)}</td>
      <td>${o.score.toFixed(3)}</td></tr>`;
  }).join('');
  let h = `<table class="cmp">
    <tr><th></th><th>id</th><th>option</th><th>km/h</th><th>km</th><th>min</th>
        <th>cost</th><th>Mm³</th><th>stride</th><th>score</th></tr>${rows}</table>
    <p class="note">★ best on the current decision weighting · ◆ on the Pareto front — no other
      option beats it on cost, journey time and total footprint at the same time.
      Click a row to load that alignment into the results, section and exports.</p>`;

  /* Two options that were searched on the same lattice and came back the same
     length are the same line. Saying so is more use than letting a reader hunt
     for a difference that is not there — and it is a real finding: at this
     corridor resolution the higher design speed cost nothing. */
  const byGeom = {};
  for (const o of study.ranked) {
    const k = o.search.stride + ':' + Math.round(o.metrics.length) + ':' +
              Math.round(o.q.cost.total * 10);
    (byGeom[k] = byGeom[k] || []).push(o.sc.id);
  }
  const dupes = Object.values(byGeom).filter(g => g.length > 1);
  if (dupes.length)
    h += `<p class="note">Identical geometry: ${dupes.map(g => g.join(' = ')).join(' · ')}.
      Searched on the same lattice, these options converged on the same line — where they
      differ it is in operation, not in the corridor.</p>`;

  if (study.failed && study.failed.length)
    h += `<p class="note" style="color:#c62828"><b>Not routed:</b> ` +
         study.failed.map(f => `${f.sc.name} (${f.error})`).join(' · ') + `</p>`;

  // Spread on each criterion — the trade-off, stated plainly.
  h += `<h3 style="margin-top:14px">Trade-off across the family</h3><table class="res">`;
  for (const c of C.CRITERIA) {
    const vals = study.options.map(o => o.raw[c.key]);
    const lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    const loO = study.options[vals.indexOf(lo)], hiO = study.options[vals.indexOf(hi)];
    h += `<tr><td>${c.label}<br><span style="color:#6b7280;font-weight:400">
      best ${loO.sc.id} · worst ${hiO.sc.id}</span></td>
      <td>${c.fmt(lo)} → ${c.fmt(hi)}<br>
      <span style="color:#6b7280">${lo>0?'+'+((hi/lo-1)*100).toFixed(0)+' %':''}</span></td></tr>`;
  }
  h += `</table>`;

  $('cmp').innerHTML = h;
  $('cmp').querySelectorAll('tr.opt').forEach(tr =>
    tr.onclick = () => selectOption(tr.dataset.id));
}

/* ----------------------------------------------------------------- TABS -- */
function showTab(name) {
  document.querySelectorAll('.tabs div').forEach(d =>
    d.classList.toggle('on', d.dataset.tab === name));
  document.querySelectorAll('.pane').forEach(p =>
    p.style.display = p.id === 'pane-' + name ? '' : 'none');
}

/* -------------------------------------------------------------- CONTROLS -- */
function bindControls() {
  document.querySelectorAll('.tabs div').forEach(d =>
    d.onclick = () => showTab(d.dataset.tab));

  $('runOne').onclick = runOne;
  $('runStudy').onclick = runStudy;
  $('runRef').onclick = loadReference;
  $('useDesirable').onchange = e => { cfg.useDesirable = e.target.checked; strideAuto = true; updateStandard(); };
  $('closed').onchange = e => { cfg.closed = e.target.checked; updateStandard(); };
  $('stopAt').onchange = e => { cfg.stopAtControls = e.target.checked; };
  $('cpClear').onclick = () => {
    controls.length = 0; buildControlList(); map.draw(); updateStandard();
  };
  $('s-stride').oninput = e => {
    strideAuto = false; cfg.stride = +e.target.value;
    $('v-stride').textContent = cfg.stride + ' m'; updateStandard();
  };
  $('s-corr').oninput = e => {
    cfg.corridor = +e.target.value;
    $('v-corr').textContent = '±' + Math.round(cfg.corridor*100) + ' %';
  };

  const need = () => {
    if (result) return true;
    setStatus('Route an alignment first'); setTimeout(() => setStatus(''), 2500); return false;
  };
  const baseName = () => (E.G.id || 'alignment') + '_' + cfg.mode + '_' + cfg.designSpeed;
  $('expDXF').onclick = () => need() && X.exportDXF(result, baseName());
  $('expXML').onclick = () => need() && X.exportLandXML(result, baseName(), E.G.crs);
  $('expCSV').onclick = () => need() && X.exportCSV(result, baseName());
  $('expJSON').onclick = () => need() && X.exportGeoJSON(result, baseName(), E.G.crs);
  $('expSheet').onclick = () => need() && X.exportSheet(map, result, baseName(), R);
  $('expMap').onclick = () => {
    const [w, h] = X.exportMapPNG(map, baseName());
    setStatus(`Map exported ${w}×${h} px with a world file — drops georeferenced into QGIS.`);
    setTimeout(() => setStatus(''), 5000);
  };
  $('expStudy').onclick = () => {
    if (!study || !study.options.length) {
      setStatus('Generate options first'); setTimeout(() => setStatus(''), 2500); return;
    }
    X.exportStudyJSON(study, buildCfg(), baseName());
  };
}

/* A handle on the live state, for the console. A corridor tool gets argued with,
   and being able to pull the actual arrays out — chainages, levels, quantities,
   the whole option family — is often faster than adding a panel for every
   question somebody asks of it. */
window.AD = {
  get result() { return result; },
  get study() { return study; },
  get map() { return map; },
  get controls() { return controls; },
  cfg, run: runOne, options: runStudy, reference: loadReference,
  standard: currentStandard,
};

bindControls();
start();
})();
