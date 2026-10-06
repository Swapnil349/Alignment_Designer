/* ===========================================================================
   Alignment Designer v12 :: EXPORT

   Everything leaves the tool in a format an engineer can open in the software
   they already use:

     DXF       3D polylines in real coordinates, Z = design level, one layer per
               structure type — opens in AutoCAD, Civil 3D, Rhino, BricsCAD.
     LandXML   alignment + design profile + ground profile — the interchange
               Civil 3D, OpenRoads and 12d all read, so the corridor can be
               taken straight into detailed design.
     CSV       chainage table: ground, design, cut/fill, gradient, radius,
               structure, speed, cumulative mass haul.
     GeoJSON   structure runs and control points, for QGIS/ArcGIS.
     PNG       the drawing sheet, and a 1:1 georeferenced map overlay.

   Coordinates are written in the project CRS, unprojected and unrounded beyond
   millimetres. Nothing is re-datumed on the way out.
   =========================================================================== */
(function (global) {
'use strict';
const E = global.ENGINE;
const NL = String.fromCharCode(10);

function download(name, text, mime) {
  const b = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.download = name; a.href = URL.createObjectURL(b); a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function stamp() {
  const d = new Date();
  return d.toISOString().slice(0, 19);
}

/* ------------------------------------------------------------------ DXF -- */
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
function dxfPolyline(layer, pts, closed) {
  const L = ['0','POLYLINE','8',layer,'66','1','70', closed ? '9' : '8',
             '10','0.0','20','0.0','30','0.0'];
  for (const p of pts)
    L.push('0','VERTEX','8',layer,'10',p.E.toFixed(3),'20',p.N.toFixed(3),
           '30',(p.Z||0).toFixed(3),'70','32');
  L.push('0','SEQEND','8',layer);
  return L.join(NL);
}
function dxfPoint(layer, e, n, z) {
  return ['0','POINT','8',layer,'10',e.toFixed(3),'20',n.toFixed(3),'30',(z||0).toFixed(3)].join(NL);
}
function dxfText(layer, e, n, z, h, txt) {
  return ['0','TEXT','8',layer,'10',e.toFixed(3),'20',n.toFixed(3),'30',(z||0).toFixed(3),
          '40',String(h),'1',txt].join(NL);
}

function exportDXF(r, name) {
  const P = r.P, n = P.length;
  const LAYERS = [
    ['ALIGN_TUNNEL',8],['ALIGN_VIADUCT',5],['ALIGN_BRIDGE',4],['ALIGN_EMBANKMENT',30],
    ['ALIGN_CUTTING',42],['ALIGN_ATGRADE',7],['GROUND',9],['CONTROL_POINTS',1],
    ['CONTROL_LABELS',1],['CENTRELINE_2D',253],
  ];
  const out = [dxfHeader(), dxfTables(LAYERS), '0','SECTION','2','ENTITIES'];
  const lay = id => 'ALIGN_' + id.toUpperCase();
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
  const gnd = [], flat = [];
  for (let i = 0; i < n; i++) {
    gnd.push({ E:P[i].E, N:P[i].N, Z:r.vp.ground[i] });
    flat.push({ E:P[i].E, N:P[i].N, Z:0 });
  }
  out.push(dxfPolyline('GROUND', gnd, false));
  out.push(dxfPolyline('CENTRELINE_2D', flat, !!(r.search && r.search.closed)));
  const size = Math.max(50, r.P[n-1].s / 400);
  for (const c of (r.chn || [])) {
    if (c.node.synthetic) continue;
    out.push(dxfPoint('CONTROL_POINTS', c.node.E, c.node.N, r.vp.z[c.idx]));
    out.push(dxfText('CONTROL_LABELS', c.node.E + size/2, c.node.N + size/2,
                     r.vp.z[c.idx], size, c.node.name || c.node.id));
  }
  out.push('0','ENDSEC','0','EOF');
  download(name + '.dxf', out.join(NL), 'application/dxf');
}

/* -------------------------------------------------------------- LandXML -- */
/* LandXML writes coordinates as "northing easting", which is the opposite of
   almost everything else and the single most common reason an imported
   alignment lands in the wrong place. Written correctly here.

   The horizontal geometry goes out as a chain of Line elements at the resample
   spacing rather than as arcs and spirals. That is a deliberate simplification:
   the search produces arcs on a 5° lattice, and refitting them to exact
   circular curves with transitions is a design task, not an export task. The
   receiving package will fit the design geometry — what it needs from here is
   the corridor, the levels and the ground. */
function exportLandXML(r, name, crs) {
  const P = r.P, n = P.length;
  const stepN = Math.max(1, Math.round(P.length / 3000));   // keep the file sane
  const L = P[n-1].s;
  const x = [];
  x.push('<?xml version="1.0" encoding="UTF-8"?>');
  x.push(`<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" ` +
         `version="1.2" date="${stamp().slice(0,10)}" time="${stamp().slice(11)}">`);
  x.push(`  <Units><Metric areaUnit="squareMeter" linearUnit="meter" volumeUnit="cubicMeter" ` +
         `temperatureUnit="celsius" pressureUnit="milliBars" angularUnit="decimal degrees" ` +
         `directionUnit="decimal degrees"/></Units>`);
  x.push(`  <Project name="${name}"/>`);
  x.push(`  <Application name="Alignment Designer v12" version="12"/>`);
  if (crs) x.push(`  <CoordinateSystem desc="${crs}" horizontalDatum="${crs}"/>`);
  x.push(`  <Alignments name="corridor">`);
  x.push(`    <Alignment name="${name}" length="${L.toFixed(4)}" staStart="${(r.ch0 || 0).toFixed(1)}">`);
  x.push(`      <CoordGeom>`);
  for (let i = stepN; i < n; i += stepN) {
    const a = P[i-stepN], b = P[i];
    const len = Math.hypot(b.E-a.E, b.N-a.N);
    if (len < 1e-6) continue;
    let dir = Math.atan2(b.E-a.E, b.N-a.N) * 180 / Math.PI;
    if (dir < 0) dir += 360;
    x.push(`        <Line dir="${dir.toFixed(6)}" length="${len.toFixed(4)}">`);
    x.push(`          <Start>${a.N.toFixed(4)} ${a.E.toFixed(4)}</Start>`);
    x.push(`          <End>${b.N.toFixed(4)} ${b.E.toFixed(4)}</End>`);
    x.push(`        </Line>`);
  }
  x.push(`      </CoordGeom>`);
  x.push(`      <Profile name="design">`);
  x.push(`        <ProfAlign name="design">`);
  /* PVIs at every vertical intersection point, not at every sample: a profile
     with 16 000 PVIs is unusable in the receiving package. */
  const pvStep = Math.max(1, Math.round(n / 400));
  for (let i = 0; i < n; i += pvStep)
    x.push(`          <PVI>${(P[i].s + (r.ch0 || 0)).toFixed(3)} ${r.vp.z[i].toFixed(3)}</PVI>`);
  x.push(`          <PVI>${L.toFixed(3)} ${r.vp.z[n-1].toFixed(3)}</PVI>`);
  x.push(`        </ProfAlign>`);
  x.push(`        <ProfSurf name="existing ground">`);
  const gs = [];
  for (let i = 0; i < n; i += pvStep) gs.push(`${(P[i].s + (r.ch0 || 0)).toFixed(2)} ${r.vp.ground[i].toFixed(2)}`);
  x.push(`          <PntList2D>${gs.join(' ')}</PntList2D>`);
  x.push(`        </ProfSurf>`);
  x.push(`      </Profile>`);
  x.push(`    </Alignment>`);
  x.push(`  </Alignments>`);
  x.push(`</LandXML>`);
  download(name + '.xml', x.join(NL), 'application/xml');
}

/* ------------------------------------------------------------------ CSV -- */
function exportCSV(r, name) {
  const P = r.P, mh = r.q && r.q.massHaul;
  let s = 'chainage_m,easting,northing,ground_m,design_m,cut_fill_m,gradient_pct,' +
          'radius_m,structure,speed_kmh,time_s,mass_haul_m3\n';
  for (let i = 0; i < P.length; i++) {
    const R = isFinite(r.R[i]) ? r.R[i].toFixed(0) : '';
    s += [(P[i].s + (r.ch0 || 0)).toFixed(1), P[i].E.toFixed(2), P[i].N.toFixed(2),
          r.vp.ground[i].toFixed(2), r.vp.z[i].toFixed(2), r.vp.diff[i].toFixed(2),
          r.vp.grade[i].toFixed(3), R, r.structs[i].id,
          (r.sp.v[i]*3.6).toFixed(1), r.sp.t[i].toFixed(1),
          mh ? mh[i].toFixed(0) : ''].join(',') + '\n';
  }
  download(name + '.csv', s, 'text/csv');
}

/* -------------------------------------------------------------- GeoJSON -- */
function exportGeoJSON(r, name, crs) {
  const feats = r.runs.map(run => ({
    type: 'Feature',
    properties: { structure: run.type.id, label: run.type.label,
                  from_m: Math.round(run.s0), to_m: Math.round(run.s1),
                  length_m: Math.round(run.s1 - run.s0) },
    geometry: { type: 'LineString',
                coordinates: r.P.slice(run.i0, run.i1+1).map(p => [+p.E.toFixed(2), +p.N.toFixed(2)]) },
  }));
  for (const c of (r.chn || [])) {
    if (c.node.synthetic) continue;
    feats.push({ type: 'Feature',
      properties: { control_point: c.node.name || c.node.id, chainage_m: Math.round(c.s + (r.ch0 || 0)),
                    design_level_m: +r.vp.z[c.idx].toFixed(2) },
      geometry: { type: 'Point', coordinates: [+c.node.E.toFixed(2), +c.node.N.toFixed(2)] } });
  }
  const gj = {
    type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:' + (crs || 'local').replace(':', '::') } },
    properties: {
      generator: 'Alignment Designer v12', generated: stamp(),
      mode: r.std.modeLabel, design_speed_kmh: r.std.designSpeed,
      length_m: Math.round(r.P[r.P.length-1].s),
      min_radius_m: Math.round(r.metrics.minR),
      max_gradient_pct: +r.metrics.maxGrade.toFixed(2),
      capital_cost: +r.q.cost.total.toFixed(1),
    },
    features: feats,
  };
  download(name + '.geojson', JSON.stringify(gj, null, 1), 'application/geo+json');
}

/* ------------------------------------------------------------- REPORT ---- */
/** Machine-readable summary of the whole option family — the study, not one line. */
function exportStudyJSON(study, cfg, name) {
  const out = {
    generator: 'Alignment Designer v12', generated: stamp(),
    project: E.G.name, crs: E.G.crs,
    mode: cfg.mode, design_speed_kmh: cfg.designSpeed,
    parameters: cfg.params, weights: cfg.weights,
    options: study.options.map(o => ({
      id: o.sc.id, name: o.sc.name, priority: o.priority,
      design_speed_kmh: o.std.designSpeed,
      min_radius_required_m: Math.round(o.std.rGoverning),
      min_radius_achieved_m: Math.round(o.metrics.minR),
      max_gradient_pct: +o.metrics.maxGrade.toFixed(2),
      length_km: +(o.metrics.length/1000).toFixed(2),
      deviation_pct: +(o.metrics.deviation*100).toFixed(1),
      journey_time_min: +(o.sp.total/60).toFixed(2),
      capital_cost: +o.q.cost.total.toFixed(1),
      cost_breakdown: {
        civils: +o.q.cost.civils.toFixed(1), earthworks: +o.q.cost.earthworks.toFixed(1),
        land: +o.q.cost.land.toFixed(1), portals: +o.q.cost.portals.toFixed(1),
      },
      earthworks_Mm3: { cut: +(o.q.earthworks.cutM3/1e6).toFixed(3),
                        fill: +(o.q.earthworks.fillM3/1e6).toFixed(3) },
      structures_km: Object.fromEntries(Object.entries(o.q.byType)
        .map(([k, v]) => [k, +(v.m/1000).toFixed(2)])),
      impacts_ha: Object.fromEntries(Object.entries(o.q.impacts)
        .map(([k, v]) => [k, +v.ha.toFixed(1)])),
      score: +o.score.toFixed(4), on_pareto_front: !!o.onFront,
    })),
    failed: study.failed.map(f => ({ id: f.sc.id, name: f.sc.name, error: f.error })),
    note: 'Costs are comparative, built on the rate table shown in the app. They ' +
          'rank alternatives against each other and are not an estimate.',
  };
  download(name + '_study.json', JSON.stringify(out, null, 1), 'application/json');
}

/* ---------------------------------------------------------------- PNGs --- */
function exportMapPNG(map, name, scaleMpp) {
  const G = E.G;
  const mpp = scaleMpp || G.cell / 2;
  const Wpx = Math.min(12000, Math.round((G.xmax - G.xmin) / mpp));
  const Hpx = Math.min(12000, Math.round((G.ymax - G.ymin) / mpp));
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
  a.download = name + '_map.png';
  a.href = cv.toDataURL('image/png'); a.click();
  /* A world file makes the PNG a georeferenced raster in QGIS/ArcGIS — six
     numbers, and without them the export is just a picture. */
  const pxX = (G.xmax - G.xmin) / Wpx, pxY = (G.ymax - G.ymin) / Hpx;
  download(name + '_map.pgw',
    [pxX.toFixed(6), '0.0', '0.0', (-pxY).toFixed(6),
     (G.xmin + pxX/2).toFixed(4), (G.ymax - pxY/2).toFixed(4)].join(NL),
    'text/plain');
  return [Wpx, Hpx];
}

/** Drawing sheet: title block, key numbers, map, long section and mass haul. */
function exportSheet(map, r, name, R) {
  const mapCv = map.cv;
  const panelW = 380, headH = 66, profH = 230, haulH = 150, pad = 14;
  const W = panelW + mapCv.width, H = headH + mapCv.height + profH + haulH;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = '#14181c'; ctx.fillRect(0, 0, W, headH);
  ctx.fillStyle = '#fff'; ctx.font = '700 20px system-ui,sans-serif';
  ctx.fillText(`${E.G.name} — ${r.std.modeLabel}`, pad, 27);
  ctx.font = '12px system-ui,sans-serif'; ctx.fillStyle = '#9fb3d0';
  ctx.fillText(
    `${(r.metrics.length/1000).toFixed(1)} km · design speed ${r.std.designSpeed} km/h · ` +
    `min R ${Math.round(r.metrics.minR).toLocaleString()} m (required ` +
    `${Math.round(r.std.rGoverning).toLocaleString()}) · max grade ` +
    `${r.metrics.maxGrade.toFixed(2)} % · ${E.G.crs} · ${stamp().slice(0,10)}`, pad, 48);

  ctx.fillStyle = '#f6f5f2'; ctx.fillRect(0, headH, panelW, mapCv.height);
  let y = headH + 26;
  const line = (txt, opt) => {
    opt = opt || {};
    ctx.fillStyle = opt.col || '#14181c';
    ctx.font = (opt.bold ? '700 ' : '') + (opt.size || 12.5) + 'px system-ui,sans-serif';
    ctx.fillText(txt, pad + (opt.indent || 0), y);
    y += opt.gap || 18;
  };
  const head = t => line(t, { bold: true, size: 11, col: '#6b7280', gap: 20 });

  head('GEOMETRY');
  line(`Length ${(r.metrics.length/1000).toFixed(2)} km · +${(r.metrics.deviation*100).toFixed(1)} % on direct`);
  line(`Min radius ${Math.round(r.metrics.minR).toLocaleString()} m · ${r.metrics.hip} horizontal IPs`);
  line(`Max gradient ${r.metrics.maxGrade.toFixed(2)} % · ${r.vp.vip} vertical IPs`);
  line(`Vertical R crest ${Math.round(r.vp.minCrestR).toLocaleString()} / sag ${Math.round(r.vp.minSagR).toLocaleString()} m`, { gap: 24 });

  head('EARTHWORKS');
  line(`Cut ${(r.q.earthworks.cutM3/1e6).toFixed(2)} Mm³ · fill ${(r.q.earthworks.fillM3/1e6).toFixed(2)} Mm³`);
  line(`Max cut ${r.q.earthworks.maxCut.toFixed(0)} m · max fill ${r.q.earthworks.maxFill.toFixed(0)} m`);
  line(`Balance ${(r.q.earthworks.balance*100).toFixed(0)} % of fill won from cut`, { gap: 24 });

  head('STRUCTURES');
  for (const k in E.STRUCT) {
    const s = E.STRUCT[k], q = r.q.byType[s.id];
    if (!q || q.m < 1) continue;
    ctx.fillStyle = s.colour; ctx.fillRect(pad, y-9, 18, 7);
    line(`${s.label}  ${(q.m/1000).toFixed(2)} km  (${(q.m/r.metrics.length*100).toFixed(0)} %)`,
         { indent: 26 });
  }
  y += 8;
  head('COST — COMPARATIVE');
  const c = r.q.cost;
  line(`Civils ${c.civils.toFixed(0)} · earthworks ${c.earthworks.toFixed(0)} · land ${c.land.toFixed(0)}`);
  line(`TOTAL ${c.total.toFixed(0)} ${c.currency} · ${c.perKm.toFixed(1)} ${c.currency}/km`, { bold: true, gap: 24 });

  head('OPERATION');
  line(`Journey time ${(r.sp.total/60).toFixed(1)} min · average ${r.sp.avg.toFixed(0)} km/h`);
  line(`Peak achieved ${r.sp.peak.toFixed(0)} km/h`, { gap: 22 });
  line('Costs are comparative, on the rate table in the app —', { size: 10.5, col: '#6b7280', gap: 14 });
  line('they rank options against each other, not an estimate.', { size: 10.5, col: '#6b7280' });

  ctx.drawImage(mapCv, panelW, headH);
  // drawProfile records its screen mapping on the result; the sheet's own
  // drawing must not leave the app's long section reading the sheet's numbers
  const liveProfX = r._profX;
  const prof = document.createElement('canvas');
  prof.width = W - 2*pad; prof.height = profH - pad;
  R.drawProfile(prof, r, null);
  ctx.drawImage(prof, pad, headH + mapCv.height + 4);
  const haul = document.createElement('canvas');
  haul.width = W - 2*pad; haul.height = haulH - pad;
  R.drawMassHaul(haul, r, null);
  ctx.drawImage(haul, pad, headH + mapCv.height + profH + 2);
  r._profX = liveProfX;

  const a = document.createElement('a');
  a.download = name + '_sheet.png';
  a.href = cv.toDataURL('image/png'); a.click();
}

global.EXPORT = { exportDXF, exportLandXML, exportCSV, exportGeoJSON,
                  exportStudyJSON, exportMapPNG, exportSheet, download };
})(window);
