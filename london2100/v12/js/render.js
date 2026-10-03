/* ===========================================================================
   London 2100 — Rail Alignment Designer :: RENDER
   Map canvas, thematic view modes, and the section/profile charts.
   =========================================================================== */
(function (global) {
'use strict';
const E = global.ENGINE;

const PHASE_COL = ['#c62828','#e08a1e','#1d4ed8','#8e44ad'];
const PHASE_LAB = ['Station zone (±400 m)','Accelerating','Cruising (at cap or line speed)','Braking'];
const VIEW = {
  alignment:    'Alignment',
  speed:        'Speed gradient',
  time:         'Time / phase',
  infrastructure:'Infrastructure',
  environment:  'Environmental constraints',
  topography:   'Topography',
  engineering:  'Engineering',
  tracks:       'Track layout',
};

/* speed ramp: red station -> orange accel -> yellow -> green -> blue max */
function speedColour(v, vmax) {
  const t = Math.max(0, Math.min(1, v / Math.max(1, vmax)));
  const stops = [[0,   214, 40, 40], [0.18, 240,130, 30], [0.42, 235,205, 40],
                 [0.72, 60, 170, 75], [1.0,  30, 90, 210]];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const a = stops[i-1], b = stops[i];
      const f = (t - a[0]) / (b[0] - a[0]);
      return `rgb(${Math.round(a[1]+(b[1]-a[1])*f)},${Math.round(a[2]+(b[2]-a[2])*f)},${Math.round(a[3]+(b[3]-a[3])*f)})`;
    }
  }
  return 'rgb(30,90,210)';
}

function gradeColour(g) {
  const t = Math.min(1, Math.abs(g) / 3);
  return `rgb(${Math.round(40+215*t)},${Math.round(140-90*t)},${Math.round(200-160*t)})`;
}

class MapView {
  constructor(canvas, basemapImg) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.img = basemapImg;
    this.view = 'alignment';
    /* Default view = the constraint read, on a white ground: the four layers that
       actually drive the routing weights (AONB, built-up, floodplain, rivers).
       Topography and the QGIS raster ship OFF — both are available on the toggles,
       but the alignment argument is clearest against white.                      */
    this.showLayers = { topo:false, basemap:false, aonb:true, greenbelt:false, built:true,
                        woodland:false, flood_proxy:true, river_major:true, road_major:false };
    this.layerAlpha = { topo:0.95, basemap:1.0, aonb:0.42, greenbelt:0.4, built:0.55,
                        woodland:0.5, flood_proxy:0.5, river_major:0.85, road_major:0.5 };
    this.exportMode = false;      // georeferenced export: no chrome, optional transparency
    this.hoverIdx = null;         // alignment index under the cursor (map<->profile sync)
    this.overlayCache = {};
    // world = BNG; fit the frame to the canvas initially
    this.zoom = 1; this.ox = 0; this.oy = 0;
    this.G = E.G;
    this.fit();
    this._bindPanZoom();
  }
  fit() {
    const G = this.G, w = this.cv.width, h = this.cv.height;
    const wx = G.xmax - G.xmin, wy = G.ymax - G.ymin;
    this.zoom = Math.min(w / wx, h / wy) * 0.96;
    this.ox = (w - wx * this.zoom) / 2; this.oy = (h - wy * this.zoom) / 2;
  }
  fitTo(pts, pad) {
    pad = pad || 4000;
    let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
    for (const p of pts) { x0=Math.min(x0,p.E); x1=Math.max(x1,p.E); y0=Math.min(y0,p.N); y1=Math.max(y1,p.N); }
    x0-=pad; x1+=pad; y0-=pad; y1+=pad;
    const w=this.cv.width, h=this.cv.height;
    this.zoom = Math.min(w/(x1-x0), h/(y1-y0));
    // screen = origin + (world - gridOrigin) * zoom, so the offset must be taken
    // relative to the GRID origin, not to zero.
    this.ox = (w - (x1-x0)*this.zoom)/2 - (x0 - this.G.xmin)*this.zoom;
    this.oy = (h - (y1-y0)*this.zoom)/2 - (this.G.ymax - y1)*this.zoom;
  }
  toScreen(E_, N_) {
    return [ this.ox + (E_ - this.G.xmin) * this.zoom,
             this.oy + (this.G.ymax - N_) * this.zoom ];
  }
  toWorld(sx, sy) {
    return { E: (sx - this.ox) / this.zoom + this.G.xmin,
             N: this.G.ymax - (sy - this.oy) / this.zoom };
  }
  _bindPanZoom() {
    const cv = this.cv; let drag = false, lx = 0, ly = 0;
    cv.addEventListener('mousedown', e => { drag = true; lx = e.offsetX; ly = e.offsetY; });
    window.addEventListener('mouseup', () => drag = false);
    cv.addEventListener('mousemove', e => {
      if (this.onHover) this.onHover(this.toWorld(e.offsetX, e.offsetY));
      if (!drag) return;
      this.ox += e.offsetX - lx; this.oy += e.offsetY - ly;
      lx = e.offsetX; ly = e.offsetY; this.draw();
    });
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      const f = e.deltaY > 0 ? 0.87 : 1.15;
      const w = this.toWorld(e.offsetX, e.offsetY);
      this.zoom *= f;
      const [nx, ny] = this.toScreen(w.E, w.N);
      this.ox += e.offsetX - nx; this.oy += e.offsetY - ny;
      this.draw();
    }, { passive: false });
  }

  /** Topography underlay. Reproduces the published project basemap exactly:
      matplotlib's 'terrain' ramp fixed at -40..230 m AOD, over a hillshade lit
      from 315 deg at 50 deg altitude with x17 vertical exaggeration, composited
      terrain 90% over white then grey hillshade 30% over that.
      Fixed limits — NOT the array min/max — so the app and every exported map
      read the same height as the same colour. */
  demOverlay() {
    if (this._demCv) return this._demCv;
    const G = this.G, A = G.layer.dem, nx = G.nx, ny = G.ny, cell = G.cell;
    const VMIN = -40, VMAX = 230;
    /* matplotlib 'terrain' control points: deep blue, blue, green, pale yellow,
       brown, white. Linear between stops, exactly as LinearSegmentedColormap. */
    const STOP = [[0.00, 0.20,0.20,0.60],[0.15, 0.00,0.60,1.00],
                  [0.25, 0.00,0.80,0.40],[0.50, 1.00,1.00,0.60],
                  [0.75, 0.50,0.36,0.33],[1.00, 1.00,1.00,1.00]];
    const ramp = t => {
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      for (let k = 1; k < STOP.length; k++) {
        if (t <= STOP[k][0]) {
          const a = STOP[k-1], b = STOP[k];
          const f = (t - a[0]) / (b[0] - a[0]);
          return [a[1]+(b[1]-a[1])*f, a[2]+(b[2]-a[2])*f, a[3]+(b[3]-a[3])*f];
        }
      }
      return [1,1,1];
    };
    /* Hillshade, matplotlib LightSource form: surface normal dotted with the
       light vector, then rescaled across the whole array (hence two passes). */
    const az = (90 - 315) * Math.PI/180, alt = 50 * Math.PI/180;
    const Lx = Math.cos(az)*Math.cos(alt), Ly = Math.sin(az)*Math.cos(alt),
          Lz = Math.sin(alt), VE = 17;
    const hs = new Float32Array(nx*ny);
    let hmin = Infinity, hmax = -Infinity;
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const xl = A[y*nx + Math.max(0,x-1)], xr = A[y*nx + Math.min(nx-1,x+1)];
        const yu = A[Math.max(0,y-1)*nx + x], yd = A[Math.min(ny-1,y+1)*nx + x];
        const dx = VE*(xr - xl)/(2*cell), dy = VE*(yd - yu)/(2*cell);
        const m = Math.sqrt(dx*dx + dy*dy + 1);
        const v = (-dx*Lx - dy*Ly + Lz)/m;
        hs[y*nx+x] = v; if (v < hmin) hmin = v; if (v > hmax) hmax = v;
      }
    }
    const hspan = Math.max(1e-6, hmax - hmin);
    const c = document.createElement('canvas'); c.width = nx; c.height = ny;
    const ctx = c.getContext('2d');
    const im = ctx.createImageData(nx, ny);
    for (let i = 0; i < nx*ny; i++) {
      const rgb = ramp((A[i] - VMIN)/(VMAX - VMIN));
      const sh = (hs[i] - hmin)/hspan;
      const o = i*4;
      for (let ch = 0; ch < 3; ch++) {
        const terr = 0.90*rgb[ch] + 0.10;          // terrain alpha .90 over white
        im.data[o+ch] = Math.round(255*Math.max(0, Math.min(1,
                          0.30*sh + 0.70*terr)));  // hillshade alpha .30 over it
      }
      im.data[o+3] = 255;
    }
    ctx.putImageData(im, 0, 0);
    this._demCv = c;
    return c;
  }

  /** Build a tinted overlay for a grid layer once, then reuse it. */
  layerOverlay(name, rgb, alphaScale) {
    if (this.overlayCache[name]) return this.overlayCache[name];
    const G = this.G, A = G.layer[name];
    const c = document.createElement('canvas'); c.width = G.nx; c.height = G.ny;
    const ctx = c.getContext('2d');
    const im = ctx.createImageData(G.nx, G.ny);
    for (let i = 0; i < A.length; i++) {
      const v = Math.min(1, A[i] * (alphaScale || 1));
      im.data[i*4] = rgb[0]; im.data[i*4+1] = rgb[1]; im.data[i*4+2] = rgb[2];
      im.data[i*4+3] = Math.round(v * 255);
    }
    ctx.putImageData(im, 0, 0);
    this.overlayCache[name] = c;
    return c;
  }

  draw() {
    const ctx = this.ctx, G = this.G;
    const w = this.cv.width, h = this.cv.height;
    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0,0,w,h);
    const baseOn = this.showLayers.topo || (this.showLayers.basemap && this.img);
    /* In export mode with no base layer the background stays TRANSPARENT, so the
       exported PNG can be dropped straight over the user's own base maps.      */
    if (!this.exportMode || baseOn) { ctx.fillStyle = '#eceff2'; ctx.fillRect(0,0,w,h); }
    const W = (G.xmax-G.xmin)*this.zoom, H = (G.ymax-G.ymin)*this.zoom;
    ctx.imageSmoothingEnabled = true;
    if (this.showLayers.basemap && this.img) {
      ctx.globalAlpha = this.layerAlpha.basemap;
      ctx.drawImage(this.img, this.ox, this.oy, W, H);
    }
    if (this.showLayers.topo) {
      ctx.globalAlpha = this.layerAlpha.topo;
      ctx.drawImage(this.demOverlay(), this.ox, this.oy, W, H);
    }

    const OV = {
      aonb:        [[201,161,60],  1.0],
      greenbelt:   [[120,170,110], 0.8],
      built:       [[90,90,100],   1.0],
      woodland:    [[70,130,70],   0.9],
      flood_proxy: [[60,130,200],  0.7],
      river_major: [[20,110,190],  1.0],
      road_major:  [[170,80,40],   1.0],
    };
    for (const k in OV) {
      if (!this.showLayers[k]) continue;
      ctx.globalAlpha = this.layerAlpha[k] === undefined ? 0.55 : this.layerAlpha[k];
      ctx.drawImage(this.layerOverlay(k, OV[k][0], OV[k][1]), this.ox, this.oy, W, H);
    }
    ctx.globalAlpha = 1;

    // family of alternatives first, so the focused one draws on top
    if (this.study && this.study.length) this.drawStudy();
    if (this.result) this.drawAlignment();
    this.drawNodes();
    if (!this.exportMode) this.drawScaleBar();
  }

  /* All study alternatives, coloured best→worst. The selected one is drawn
     heavier; everything else is thinned so the spread stays readable. */
  drawStudy() {
    const ctx = this.ctx;
    ctx.lineJoin = ctx.lineCap = 'round';
    const sel = this.selectedId;
    // unselected first
    for (const r of this.study) {
      if (sel && r.sc.id === sel) continue;
      ctx.lineWidth = 1.8; ctx.globalAlpha = sel ? 0.30 : 0.72;
      ctx.strokeStyle = r.colour || '#888';
      ctx.beginPath();
      const P = r.P;
      for (let i = 0; i < P.length; i += 2) {
        const [x,y] = this.toScreen(P[i].E, P[i].N);
        i ? ctx.lineTo(x,y) : ctx.moveTo(x,y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (sel) {
      const r = this.study.find(z => z.sc.id === sel);
      if (r) {
        ctx.lineWidth = 7; ctx.strokeStyle = 'rgba(255,255,255,.9)';
        ctx.beginPath();
        r.P.forEach((p,i) => { const [x,y]=this.toScreen(p.E,p.N); i?ctx.lineTo(x,y):ctx.moveTo(x,y); });
        ctx.stroke();
        ctx.lineWidth = 3.6; ctx.strokeStyle = r.colour || '#1030b0';
        ctx.beginPath();
        r.P.forEach((p,i) => { const [x,y]=this.toScreen(p.E,p.N); i?ctx.lineTo(x,y):ctx.moveTo(x,y); });
        ctx.stroke();
      }
    }
  }

  drawAlignment() {
    const ctx = this.ctx, r = this.result, P = r.P;
    /* Width follows zoom: ~16 m of formation in world units once zoomed in, with a
       4 px floor at overview scale — so the line no longer thins away on zoom.  */
    const lw = Math.max(4, Math.min(18, 16 * this.zoom));
    // white halo
    ctx.lineWidth = lw + 4; ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.lineJoin = ctx.lineCap = 'round';
    ctx.beginPath();
    P.forEach((p,i) => { const [x,y] = this.toScreen(p.E,p.N); i?ctx.lineTo(x,y):ctx.moveTo(x,y); });
    ctx.stroke();

    ctx.lineWidth = lw;
    for (let i = 1; i < P.length; i++) {
      const [x0,y0] = this.toScreen(P[i-1].E,P[i-1].N);
      const [x1,y1] = this.toScreen(P[i].E,P[i].N);
      let col = '#111';
      switch (this.view) {
        /* Normalise by the PEAK ACTUALLY ACHIEVED, not the line-speed setting: against
           a fixed 750 the whole loop sat in the green-yellow mid-band and neither the
           stop zones nor the maximum ever showed.                                    */
        case 'speed':  col = speedColour((r.sp.v[i]+r.sp.v[i-1])/2*3.6,
                                         (r.sp.peak || r.opts.vmax)); break;
        case 'time': col = PHASE_COL[r.sp.phase ? r.sp.phase[i] : 2]; break;
        case 'infrastructure': col = r.structs[i].colour; break;
        case 'engineering': {
          const R = Math.abs(r.R[i]);
          col = !isFinite(R) ? '#9aa3ad'
              : R < r.w.rMin*0.98 ? '#c62828'
              : R < r.w.rMin*1.3  ? '#e08a1e' : '#2e7d32'; break;
        }
        case 'topography': col = gradeColour(r.vp.grade[i]); break;
        case 'tracks': col = (r.layout && r.layout.tracks[i] === 4) ? '#c0392b' : '#1d4ed8'; break;
        case 'environment': col = '#111'; break;
        default: col = '#101418';
      }
      ctx.strokeStyle = col;
      ctx.beginPath(); ctx.moveTo(x0,y0); ctx.lineTo(x1,y1); ctx.stroke();
    }

    // tunnel portals get a marker in infrastructure view
    if (this.view === 'infrastructure' && r.runs) {
      for (const run of r.runs) {
        if (run.type.id !== 'tunnel') continue;
        for (const i of [run.i0, run.i1]) {
          const [x,y] = this.toScreen(P[i].E, P[i].N);
          ctx.fillStyle = '#5b4636'; ctx.beginPath(); ctx.arc(x,y,4,0,7); ctx.fill();
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
        }
      }
    }
    // four-track sections drawn heavier, in the track view
    if (this.view === 'tracks' && r.layout) {
      ctx.lineWidth = 9; ctx.strokeStyle = 'rgba(192,57,43,.35)';
      let run = false;
      for (let i = 1; i < P.length; i++) {
        const four = r.layout.tracks[i] === 4;
        if (four && !run) { ctx.beginPath();
          const [x,y] = this.toScreen(P[i-1].E,P[i-1].N); ctx.moveTo(x,y); run = true; }
        if (four) { const [x,y] = this.toScreen(P[i].E,P[i].N); ctx.lineTo(x,y); }
        if (!four && run) { ctx.stroke(); run = false; }
      }
      if (run) ctx.stroke();
      ctx.lineWidth = lw;
    }
    // running time on each inter-station arc, in the time/phase view
    if (this.view === 'time' && r.sp.segs) {
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      for (const sg of r.sp.segs) {
        const mid = Math.round((sg.i0 + sg.i1) / 2);
        const [x,y] = this.toScreen(P[mid].E, P[mid].N);
        const lab = `${(sg.time/60).toFixed(1)} min`;
        const wpx = ctx.measureText(lab).width + 12;
        ctx.fillStyle = 'rgba(255,255,255,.94)';
        ctx.fillRect(x - wpx/2, y - 24, wpx, 18);
        ctx.strokeStyle = '#14181c'; ctx.lineWidth = 1;
        ctx.strokeRect(x - wpx/2, y - 24, wpx, 18);
        ctx.fillStyle = '#14181c';
        ctx.fillText(lab, x, y - 11);
      }
      // stop markers
      for (const i of r.sp.stopIdx) {
        const [x,y] = this.toScreen(P[i].E, P[i].N);
        ctx.beginPath(); ctx.arc(x, y, 5, 0, 7);
        ctx.fillStyle = '#c62828'; ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      }
      ctx.textAlign = 'start';
    }
    // chainage ticks every 5 km in engineering view
    if (this.view === 'engineering') {
      ctx.font = '10px ui-monospace, monospace'; ctx.fillStyle = '#111';
      for (let i = 0; i < P.length; i++) {
        if (P[i].s % 5000 > 25) continue;
        const [x,y] = this.toScreen(P[i].E,P[i].N);
        ctx.fillRect(x-1,y-1,3,3);
        ctx.fillText((P[i].s/1000).toFixed(0)+'k', x+5, y-4);
      }
    }
  }

  /* Station markers sit ON the alignment, not at the nominal grid coordinate. The
     search finishes within half a stride of each node, so the nominal point can be
     up to ~60 m off the line — invisible at overview, glaring when zoomed in.   */
  _snapNodes() {
    const P = this.result.P, out = {};
    for (const nd of this.G.nodes) {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < P.length; i++) {
        const d = (P[i].E-nd.E)*(P[i].E-nd.E) + (P[i].N-nd.N)*(P[i].N-nd.N);
        if (d < bd) { bd = d; bi = i; }
      }
      out[nd.id] = [P[bi].E, P[bi].N];
    }
    return out;
  }
  drawNodes() {
    const ctx = this.ctx;
    const snap = (this.result && this.result.P)
      ? (this.result._snap || (this.result._snap = this._snapNodes())) : null;
    for (const nd of this.G.nodes) {
      const p = snap && snap[nd.id] ? snap[nd.id] : [nd.E, nd.N];
      const [x,y] = this.toScreen(p[0], p[1]);
      ctx.beginPath(); ctx.arc(x,y,7,0,7);
      ctx.fillStyle = '#14181c'; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.stroke();
      ctx.fillStyle = '#14181c'; ctx.font = '600 12px system-ui, sans-serif';
      ctx.fillText(nd.name, x + 11, y + 4);
    }
    // hover crosshair, synchronised with the long section below
    if (this.hoverIdx != null && this.result && this.result.P[this.hoverIdx]) {
      const q = this.result.P[this.hoverIdx];
      const [x,y] = this.toScreen(q.E, q.N);
      ctx.beginPath(); ctx.arc(x, y, 6.5, 0, 7);
      ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fill();
      ctx.strokeStyle = '#c62828'; ctx.lineWidth = 2.5; ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 1.8, 0, 7); ctx.fillStyle = '#c62828'; ctx.fill();
    }
  }

  drawScaleBar() {
    const ctx = this.ctx, h = this.cv.height;
    const targets = [1000,2000,5000,10000,20000,50000];
    let m = targets.find(t => t*this.zoom > 70) || 50000;
    const px = m*this.zoom;
    const x = 16, y = h-24;
    ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fillRect(x-6,y-20,px+12,30);
    ctx.strokeStyle='#111'; ctx.lineWidth=2;
    ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x+px,y);
    ctx.moveTo(x,y-5); ctx.lineTo(x,y+5); ctx.moveTo(x+px,y-5); ctx.lineTo(x+px,y+5);
    ctx.stroke();
    ctx.fillStyle='#111'; ctx.font='11px system-ui,sans-serif';
    ctx.fillText((m/1000)+' km', x+4, y-7);
  }
}

/* ------------------------------------------------------------- CHARTS ---- */
function drawProfile(cv, r) {
  const ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
  ctx.clearRect(0,0,W,H); ctx.fillStyle='#fff'; ctx.fillRect(0,0,W,H);
  if (!r) return;
  const P = r.P, vp = r.vp, n = P.length;
  const L = P[n-1].s;
  let zmin=Infinity, zmax=-Infinity;
  for (let i=0;i<n;i++){ zmin=Math.min(zmin,vp.ground[i],vp.z[i]); zmax=Math.max(zmax,vp.ground[i],vp.z[i]); }
  const pad = 26, ml = 46, topRoom = 26;      // topRoom keeps station labels clear
  zmin -= 12; zmax += 12;
  const X = s => ml + (s/L)*(W-ml-14);
  const Y = z => H-pad - ((z-zmin)/(zmax-zmin))*(H-pad-topRoom);
  // stash the transform so the app can invert mouse position -> chainage
  r._profX = { ml, right: 14, W, L };

  // ground — warm fill under the terrain line, as on the presentation sheet
  ctx.beginPath();
  for (let i=0;i<n;i++){ const x=X(P[i].s), y=Y(vp.ground[i]); i?ctx.lineTo(x,y):ctx.moveTo(x,y); }
  ctx.lineTo(X(L),H-pad); ctx.lineTo(X(0),H-pad); ctx.closePath();
  ctx.fillStyle='rgba(200,184,154,.72)'; ctx.fill();
  ctx.beginPath();
  for (let i=0;i<n;i++){ const x=X(P[i].s), y=Y(vp.ground[i]); i?ctx.lineTo(x,y):ctx.moveTo(x,y); }
  ctx.strokeStyle='#7a6a4e'; ctx.lineWidth=1; ctx.stroke();

  // station verticals BEHIND the rail line: solid for primaries, dotted otherwise
  const chn = r.services && r.services.chn
    ? r.services.chn.slice().sort((a,b)=>a.s-b.s) : [];
  for (const c of chn) {
    const kind = (c.node.kind||'').toLowerCase();
    const x = X(c.s);
    ctx.strokeStyle = kind==='primary' ? '#444' : '#aaa';
    ctx.lineWidth = kind==='primary' ? 1.4 : .7;
    ctx.setLineDash(kind==='primary' ? [] : [2,3]);
    ctx.beginPath(); ctx.moveTo(x, topRoom-8); ctx.lineTo(x, H-pad); ctx.stroke();
  }
  ctx.setLineDash([]);

  // rail line, coloured by structure
  ctx.lineWidth=3.2; ctx.lineCap='butt';
  for (let i=1;i<n;i++){
    ctx.strokeStyle = r.structs[i].colour;
    ctx.beginPath(); ctx.moveTo(X(P[i-1].s),Y(vp.z[i-1])); ctx.lineTo(X(P[i].s),Y(vp.z[i])); ctx.stroke();
  }

  // station names along the top
  ctx.textAlign='center';
  for (const c of chn) {
    const kind = (c.node.kind||'').toLowerCase();
    ctx.fillStyle = kind==='primary' ? '#0b2f6b' : (kind==='airport' ? '#b8272b' : '#555');
    ctx.font = (kind==='secondary' ? '' : '700 ') + '10.5px system-ui,sans-serif';
    ctx.fillText(c.node.id, X(c.s), topRoom-12);
  }
  ctx.textAlign='start';

  // axes
  ctx.strokeStyle='#333'; ctx.lineWidth=1;
  ctx.beginPath(); ctx.moveTo(ml,topRoom-6); ctx.lineTo(ml,H-pad); ctx.lineTo(W-14,H-pad); ctx.stroke();
  ctx.fillStyle='#333'; ctx.font='10px system-ui,sans-serif';
  const zStep = (zmax-zmin) > 160 ? 50 : 25;
  for (let z=Math.ceil(zmin/zStep)*zStep; z<zmax; z+=zStep){
    ctx.fillText(z+'', 6, Y(z)+3);
    ctx.strokeStyle='rgba(0,0,0,.07)';
    ctx.beginPath(); ctx.moveTo(ml,Y(z)); ctx.lineTo(W-14,Y(z)); ctx.stroke();
  }
  // adaptive chainage ticks — a 411 km loop at 5 km ticks is unreadable
  const sStep = L > 200000 ? 25000 : L > 60000 ? 10000 : 5000;
  for (let s=0; s<=L; s+=sStep){
    ctx.fillStyle='#333';
    ctx.fillText((s/1000).toFixed(0), X(s)-5, H-pad+13);
  }
  ctx.fillStyle='#555'; ctx.font='10px system-ui,sans-serif';
  ctx.fillText('m AOD', 6, 12); ctx.fillText('chainage (km)', W-88, H-6);

  // hover cursor, synchronised with the map (Google-Earth-style)
  if (r._hoverIdx != null && P[r._hoverIdx]) {
    const i = r._hoverIdx, x = X(P[i].s);
    ctx.strokeStyle = '#c62828'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(x, topRoom-6); ctx.lineTo(x, H-pad); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, Y(vp.z[i]), 4.5, 0, 7);
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.strokeStyle = '#c62828'; ctx.lineWidth = 2; ctx.stroke();
    const lab = `${(P[i].s/1000).toFixed(1)} km · ground ${vp.ground[i].toFixed(0)} m · ` +
                `rail ${vp.z[i].toFixed(0)} m` +
                (r.sp && r.sp.v ? ` · ${(r.sp.v[i]*3.6).toFixed(0)} km/h` : '');
    ctx.font = '600 10.5px system-ui,sans-serif';
    const wpx = ctx.measureText(lab).width + 10;
    const bx = Math.max(ml, Math.min(W-14-wpx, x - wpx/2));
    ctx.fillStyle = 'rgba(255,255,255,.95)'; ctx.fillRect(bx, H-pad-20, wpx, 15);
    ctx.strokeStyle = '#c62828'; ctx.lineWidth = 1; ctx.strokeRect(bx, H-pad-20, wpx, 15);
    ctx.fillStyle = '#7a1010'; ctx.fillText(lab, bx+5, H-pad-9);
  }
}

function drawSpeed(cv, r) {
  const ctx = cv.getContext('2d'), W=cv.width, H=cv.height;
  ctx.clearRect(0,0,W,H); ctx.fillStyle='#fff'; ctx.fillRect(0,0,W,H);
  if (!r) return;
  const P=r.P, sp=r.sp, n=P.length, L=P[n-1].s;
  const vmax=r.opts.vmax, pad=26, ml=46;
  const X = s => ml + (s/L)*(W-ml-14);
  const Y = v => H-pad - (v/(vmax*1.08))*(H-pad-14);
  ctx.lineWidth=2.6;
  for (let i=1;i<n;i++){
    const v0=sp.v[i-1]*3.6, v1=sp.v[i]*3.6;
    ctx.strokeStyle=speedColour((v0+v1)/2, vmax);
    ctx.beginPath(); ctx.moveTo(X(P[i-1].s),Y(v0)); ctx.lineTo(X(P[i].s),Y(v1)); ctx.stroke();
  }
  ctx.strokeStyle='#333'; ctx.lineWidth=1;
  ctx.beginPath(); ctx.moveTo(ml,14); ctx.lineTo(ml,H-pad); ctx.lineTo(W-14,H-pad); ctx.stroke();
  ctx.fillStyle='#333'; ctx.font='10px system-ui,sans-serif';
  for (let v=0; v<=vmax; v+=100){
    ctx.fillText(v+'', 8, Y(v)+3);
    ctx.strokeStyle='rgba(0,0,0,.07)';
    ctx.beginPath(); ctx.moveTo(ml,Y(v)); ctx.lineTo(W-14,Y(v)); ctx.stroke();
  }
  for (let s=0;s<=L;s+=5000){ ctx.fillStyle='#333'; ctx.fillText((s/1000).toFixed(0), X(s)-5, H-pad+13); }
  ctx.fillStyle='#555'; ctx.fillText('km/h', 8, 12); ctx.fillText('chainage (km)', W-88, H-6);
}

global.RENDER = { MapView, drawProfile, drawSpeed, speedColour, VIEW, PHASE_COL, PHASE_LAB };
})(window);
