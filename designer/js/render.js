/* ===========================================================================
   Alignment Designer v12 :: RENDER
   Map canvas, thematic views, control-point editing, long section, mass haul.
   =========================================================================== */
(function (global) {
'use strict';
const E = global.ENGINE;

const VIEW = {
  alignment:   'Alignment',
  structures:  'Structures',
  earthworks:  'Cut and fill',
  gradient:    'Gradient',
  curvature:   'Curvature vs standard',
  speed:       'Speed',
  options:     'All options',
};

const PHASE_COL = ['#c62828', '#e08a1e', '#1d4ed8', '#8e44ad'];
const PHASE_LAB = ['Stop zone', 'Accelerating', 'At line speed / curve cap', 'Braking'];

function speedColour(v, vmax) {
  const t = Math.max(0, Math.min(1, v / Math.max(1, vmax)));
  const stops = [[0, 214,40,40], [0.18, 240,130,30], [0.42, 235,205,40],
                 [0.72, 60,170,75], [1.0, 30,90,210]];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const a = stops[i-1], b = stops[i], f = (t - a[0]) / (b[0] - a[0]);
      return `rgb(${Math.round(a[1]+(b[1]-a[1])*f)},${Math.round(a[2]+(b[2]-a[2])*f)},` +
             `${Math.round(a[3]+(b[3]-a[3])*f)})`;
    }
  }
  return 'rgb(30,90,210)';
}
function gradeColour(g, maxG) {
  const t = Math.min(1, Math.abs(g) / Math.max(0.5, maxG));
  return `rgb(${Math.round(40+215*t)},${Math.round(150-100*t)},${Math.round(205-165*t)})`;
}
/** Cut red, fill blue, at grade grey — the convention every earthworks drawing uses. */
function cutFillColour(d) {
  const t = Math.min(1, Math.abs(d) / 20);
  if (d < -0.5) return `rgb(${Math.round(150+105*t)},${Math.round(120-90*t)},${Math.round(110-85*t)})`;
  if (d >  0.5) return `rgb(${Math.round(120-95*t)},${Math.round(150-40*t)},${Math.round(180+70*t)})`;
  return '#77807a';
}

const LAYER_STYLE = {
  built:       { rgb: [90, 90, 100],  alpha: 0.55, label: 'Built-up area' },
  /* Violet, not the conventional amber: the hypsometric relief underneath runs
     blue-to-yellow, and an amber overlay on high ground is invisible on it. */
  protected:   { rgb: [146, 84, 178], alpha: 0.42, label: 'Protected landscape' },
  woodland:    { rgb: [70, 130, 70],  alpha: 0.50, label: 'Woodland' },
  flood:       { rgb: [60, 130, 200], alpha: 0.45, label: 'Floodplain' },
  water_body:  { rgb: [20, 110, 190], alpha: 0.85, label: 'Water' },
  river_major: { rgb: [20, 110, 190], alpha: 0.85, label: 'Major watercourse' },
  road_major:  { rgb: [170, 80, 40],  alpha: 0.60, label: 'Major road' },
  rail:        { rgb: [110, 60, 140], alpha: 0.60, label: 'Existing railway' },
  farmland:    { rgb: [180, 190, 100],alpha: 0.35, label: 'High-grade farmland' },
  greenbelt:   { rgb: [120, 170, 110],alpha: 0.35, label: 'Green belt' },
  exclusion:   { rgb: [198, 40, 40],  alpha: 0.55, label: 'No-go zone' },
};

class MapView {
  constructor(canvas) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.view = 'alignment';
    this.showTopo = true;
    this.showLayers = {};
    this.layerAlpha = {};
    this.result = null;        // the focused alignment
    this.study = null;         // the full option family
    this.selectedId = null;
    this.controls = [];        // editable control points
    this.hoverIdx = null;
    this.dragIdx = -1;
    this.editMode = 'pan';     // pan | add | move | delete
    this.exportMode = false;
    this.overlayCache = {};
    this.zoom = 1; this.ox = 0; this.oy = 0;
    this.G = E.G;
    this.reset();
    this._bindPanZoom();
  }

  reset() {
    this.overlayCache = {}; this._demCv = null;
    this.G = E.G;
    /* A project can say how it should first be read. London 2100 v12 opens on
       the constraint layers against white with topography off — the layers that
       carry routing weight, so the opening screen explains the alignment rather
       than decorating it. Projects that say nothing get relief plus the
       constraints most likely to matter. */
    const d = (E.G.defaults || {});
    const want = d.layers || null;
    if (this._project !== E.G.id) {
      this._project = E.G.id;
      this.showLayers = {}; this.layerAlpha = {};
      this.showTopo = d.topo === undefined ? true : !!d.topo;
    }
    for (const k in LAYER_STYLE) {
      if (!E.has(k)) continue;
      if (this.showLayers[k] === undefined)
        this.showLayers[k] = want && want[k] !== undefined ? !!want[k]
          : ['built', 'protected', 'water_body', 'river_major', 'exclusion'].indexOf(k) >= 0;
      if (this.layerAlpha[k] === undefined) this.layerAlpha[k] = LAYER_STYLE[k].alpha;
    }
    this.fit();
  }

  fit() {
    const G = this.G, w = this.cv.width, h = this.cv.height;
    const wx = G.xmax - G.xmin, wy = G.ymax - G.ymin;
    if (!wx || !wy || !w || !h) return;
    this.zoom = Math.min(w / wx, h / wy) * 0.96;
    this.ox = (w - wx * this.zoom) / 2; this.oy = (h - wy * this.zoom) / 2;
  }
  fitTo(pts, pad) {
    if (!pts || !pts.length) return this.fit();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) {
      x0 = Math.min(x0, p.E); x1 = Math.max(x1, p.E);
      y0 = Math.min(y0, p.N); y1 = Math.max(y1, p.N);
    }
    pad = pad || Math.max(1500, Math.max(x1-x0, y1-y0) * 0.08);
    x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
    const w = this.cv.width, h = this.cv.height;
    this.zoom = Math.min(w/(x1-x0), h/(y1-y0));
    // screen = origin + (world − gridOrigin)·zoom, so the offset is taken
    // relative to the GRID origin, not to zero.
    this.ox = (w - (x1-x0)*this.zoom)/2 - (x0 - this.G.xmin)*this.zoom;
    this.oy = (h - (y1-y0)*this.zoom)/2 - (this.G.ymax - y1)*this.zoom;
  }
  toScreen(E_, N_) {
    return [this.ox + (E_ - this.G.xmin) * this.zoom,
            this.oy + (this.G.ymax - N_) * this.zoom];
  }
  toWorld(sx, sy) {
    return { E: (sx - this.ox) / this.zoom + this.G.xmin,
             N: this.G.ymax - (sy - this.oy) / this.zoom };
  }

  /** Index of the control point under a screen point, or −1. */
  hitControl(sx, sy, tol) {
    tol = tol || 10;
    for (let i = this.controls.length - 1; i >= 0; i--) {
      const [x, y] = this.toScreen(this.controls[i].E, this.controls[i].N);
      if (Math.hypot(x - sx, y - sy) <= tol) return i;
    }
    return -1;
  }

  _bindPanZoom() {
    const cv = this.cv;
    let drag = false, lx = 0, ly = 0, moved = false;
    cv.addEventListener('mousedown', e => {
      moved = false;
      const hit = this.hitControl(e.offsetX, e.offsetY);
      if (this.editMode !== 'pan' && hit >= 0) { this.dragIdx = hit; return; }
      drag = true; lx = e.offsetX; ly = e.offsetY;
    });
    window.addEventListener('mouseup', e => {
      if (this.dragIdx >= 0) {
        this.dragIdx = -1;
        if (this.onControlsChanged) this.onControlsChanged();
      } else if (drag && !moved && this.editMode === 'add' && this.onAddControl) {
        this.onAddControl(this.toWorld(e.offsetX, e.offsetY));
      }
      drag = false;
    });
    cv.addEventListener('mousemove', e => {
      if (this.dragIdx >= 0) {
        const w = this.toWorld(e.offsetX, e.offsetY);
        this.controls[this.dragIdx].E = w.E;
        this.controls[this.dragIdx].N = w.N;
        this.draw();
        return;
      }
      if (this.onHover) this.onHover(this.toWorld(e.offsetX, e.offsetY), e);
      if (!drag) {
        cv.style.cursor = this.editMode === 'add' ? 'crosshair'
                        : this.hitControl(e.offsetX, e.offsetY) >= 0 ? 'move' : 'grab';
        return;
      }
      moved = true;
      this.ox += e.offsetX - lx; this.oy += e.offsetY - ly;
      lx = e.offsetX; ly = e.offsetY; this.draw();
    });
    cv.addEventListener('click', e => {
      if (this.editMode !== 'delete') return;
      const hit = this.hitControl(e.offsetX, e.offsetY);
      if (hit >= 0 && this.onDeleteControl) this.onDeleteControl(hit);
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

  /** Hypsometric relief with a north-west hillshade, built once per project. */
  /* Terrain underlay — ported from london2100/v12, which matched the published
     project basemap exactly (verified by transliteration to Python: worst
     channel error 0.0093 against matplotlib's own LUT):
       · matplotlib 'terrain' ramp, linear between its six control points
       · hillshade lit from 315° at 50° altitude, ×17 vertical exaggeration,
         matplotlib LightSource surface-normal form, rescaled array-wide
       · terrain 90 % over white, then grey hillshade 30 % over that.
     Colour limits come from the project when it fixes them (London: −40 … 230 m
     AOD, so the app and every printed sheet read the same height as the same
     colour). Otherwise they are set from the DEM's 1st–99th percentiles, mapped
     onto the land part of the ramp — starting at green, not at the sea blues,
     so the lowest valley on an inland project does not read as water. */
  demOverlay() {
    if (this._demCv) return this._demCv;
    const G = this.G, A = G.layer.dem, nx = G.nx, ny = G.ny, cell = G.cell;
    let VMIN, VMAX;
    const fixed = G.defaults && G.defaults.terrainRange;
    if (fixed && fixed.length === 2) { VMIN = +fixed[0]; VMAX = +fixed[1]; }
    else {
      const step = Math.max(1, Math.floor(A.length / 40000)), smp = [];
      for (let i = 0; i < A.length; i += step) smp.push(A[i]);
      smp.sort((p, q) => p - q);
      const lo = smp[Math.floor(smp.length * 0.01)], hi = smp[Math.floor(smp.length * 0.99)];
      const span = Math.max(1, hi - lo);
      // place lo at ramp 0.22 (green) and hi at 0.95 (pale brown towards white)
      VMIN = lo - 0.22 * span / 0.73;
      VMAX = VMIN + span / 0.73;
    }
    const STOP = [[0.00, 0.20,0.20,0.60],[0.15, 0.00,0.60,1.00],
                  [0.25, 0.00,0.80,0.40],[0.50, 1.00,1.00,0.60],
                  [0.75, 0.50,0.36,0.33],[1.00, 1.00,1.00,1.00]];
    const ramp = t => {
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      for (let k = 1; k < STOP.length; k++) {
        if (t <= STOP[k][0]) {
          const a = STOP[k-1], b = STOP[k], f = (t - a[0]) / (b[0] - a[0]);
          return [a[1]+(b[1]-a[1])*f, a[2]+(b[2]-a[2])*f, a[3]+(b[3]-a[3])*f];
        }
      }
      return [1, 1, 1];
    };
    /* Vertical exaggeration was tuned at ×17 for London's 100 m grid and 280 m
       of relief. A 600 m escarpment at the same exaggeration is nothing but
       black and white, so it is scaled down with relief, never up. */
    const VE = 17 * Math.min(1, 280 / Math.max(1, G.zmax - G.zmin)) * (cell / 100);
    const az = (90 - 315) * Math.PI / 180, alt = 50 * Math.PI / 180;
    const Lx = Math.cos(az) * Math.cos(alt), Ly = Math.sin(az) * Math.cos(alt), Lz = Math.sin(alt);
    const hs = new Float32Array(nx * ny);
    let hmin = Infinity, hmax = -Infinity;
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const xl = A[y*nx + Math.max(0,x-1)], xr = A[y*nx + Math.min(nx-1,x+1)];
        const yu = A[Math.max(0,y-1)*nx + x], yd = A[Math.min(ny-1,y+1)*nx + x];
        const dx = VE * (xr - xl) / (2 * cell), dy = VE * (yd - yu) / (2 * cell);
        const v = (-dx * Lx - dy * Ly + Lz) / Math.sqrt(dx*dx + dy*dy + 1);
        hs[y*nx + x] = v;
        if (v < hmin) hmin = v; if (v > hmax) hmax = v;
      }
    }
    const hspan = Math.max(1e-6, hmax - hmin);
    const c = document.createElement('canvas'); c.width = nx; c.height = ny;
    const ctx = c.getContext('2d');
    const im = ctx.createImageData(nx, ny);
    for (let i = 0; i < nx * ny; i++) {
      const rgb = ramp((A[i] - VMIN) / (VMAX - VMIN));
      const sh = (hs[i] - hmin) / hspan, o = i * 4;
      for (let ch = 0; ch < 3; ch++) {
        const terr = 0.90 * rgb[ch] + 0.10;            // terrain α .90 over white
        im.data[o+ch] = Math.round(255 * Math.max(0, Math.min(1, 0.30*sh + 0.70*terr)));
      }
      im.data[o+3] = 255;
    }
    ctx.putImageData(im, 0, 0);
    this.terrainRange = [VMIN, VMAX];
    return (this._demCv = c);
  }

  layerOverlay(name) {
    if (this.overlayCache[name]) return this.overlayCache[name];
    const G = this.G, A = G.layer[name];
    const st = LAYER_STYLE[name] || { rgb: [128,128,128] };
    const c = document.createElement('canvas'); c.width = G.nx; c.height = G.ny;
    const ctx = c.getContext('2d');
    const im = ctx.createImageData(G.nx, G.ny);
    for (let i = 0; i < A.length; i++) {
      im.data[i*4] = st.rgb[0]; im.data[i*4+1] = st.rgb[1]; im.data[i*4+2] = st.rgb[2];
      im.data[i*4+3] = Math.round(Math.min(1, A[i]) * 255);
    }
    ctx.putImageData(im, 0, 0);
    return (this.overlayCache[name] = c);
  }

  draw() {
    const ctx = this.ctx, G = this.G;
    const w = this.cv.width, h = this.cv.height;
    if (!w || !h || !G.ready) return;
    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0,0,w,h);
    const baseOn = this.showTopo;
    if (!this.exportMode || baseOn) { ctx.fillStyle = '#eceff2'; ctx.fillRect(0,0,w,h); }
    const W = (G.xmax-G.xmin)*this.zoom, H = (G.ymax-G.ymin)*this.zoom;
    ctx.imageSmoothingEnabled = true;
    if (this.showTopo) { ctx.globalAlpha = 1; ctx.drawImage(this.demOverlay(), this.ox, this.oy, W, H); }
    for (const k in LAYER_STYLE) {
      if (!this.showLayers[k] || !E.has(k)) continue;
      ctx.globalAlpha = this.layerAlpha[k];
      ctx.drawImage(this.layerOverlay(k), this.ox, this.oy, W, H);
    }
    ctx.globalAlpha = 1;

    if (this.study && this.study.length) this.drawStudy();
    if (this.result) this.drawAlignment();
    this.drawControls();
    if (!this.exportMode) { this.drawScaleBar(); this.drawNorth(); }
  }

  drawStudy() {
    const ctx = this.ctx;
    ctx.lineJoin = ctx.lineCap = 'round';
    const sel = this.selectedId;
    const others = this.study.filter(r => !sel || r.sc.id !== sel);
    /* A white halo under every alternative. Thin coloured lines over
       hypsometric relief are close to unreadable — the terrain has colour
       everywhere, so the lines need their own separation from it. */
    const path = r => {
      ctx.beginPath();
      const P = r.P;
      for (let i = 0; i < P.length; i += 2) {
        const [x,y] = this.toScreen(P[i].E, P[i].N);
        i ? ctx.lineTo(x,y) : ctx.moveTo(x,y);
      }
      ctx.stroke();
    };
    ctx.globalAlpha = sel ? 0.45 : 0.75;
    ctx.strokeStyle = 'rgba(255,255,255,.9)';
    for (const r of others) { ctx.lineWidth = (r.onFront ? 3.4 : 2.4) + 2.5; path(r); }
    ctx.globalAlpha = sel ? 0.55 : 1;
    for (const r of others) {
      ctx.lineWidth = r.onFront ? 3.4 : 2.4;
      ctx.strokeStyle = r.colour || '#888';
      path(r);
    }
    ctx.globalAlpha = 1;
  }

  drawAlignment() {
    const ctx = this.ctx, r = this.result, P = r.P;
    if (!P || P.length < 2) return;
    const width = (r.std && r.std.width) || 14;
    const lw = Math.max(3.5, Math.min(20, width * this.zoom));
    ctx.lineJoin = ctx.lineCap = 'round';
    ctx.lineWidth = lw + 4; ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.beginPath();
    P.forEach((p,i) => { const [x,y] = this.toScreen(p.E,p.N); i?ctx.lineTo(x,y):ctx.moveTo(x,y); });
    ctx.stroke();

    const rMin = (r.std && r.std.rGoverning) || 1000;
    const maxG = (r.std && r.std.maxGrade) || 3;
    ctx.lineWidth = lw;
    for (let i = 1; i < P.length; i++) {
      const [x0,y0] = this.toScreen(P[i-1].E,P[i-1].N);
      const [x1,y1] = this.toScreen(P[i].E,P[i].N);
      let col;
      switch (this.view) {
        case 'speed':
          col = speedColour((r.sp.v[i]+r.sp.v[i-1])/2*3.6, r.sp.peak || 1); break;
        case 'structures': col = r.structs[i].colour; break;
        case 'earthworks': col = cutFillColour(r.vp.diff[i]); break;
        case 'gradient':   col = gradeColour(r.vp.grade[i], maxG); break;
        case 'curvature': {
          const R = Math.abs(r.R[i]);
          col = !isFinite(R) || R > rMin * 6 ? '#9aa3ad'
              : R < rMin * 0.98 ? '#c62828'
              : R < rMin * 1.3  ? '#e08a1e' : '#2e7d32'; break;
        }
        // In the option view the focused line keeps its own ranking colour, so
        // it matches its swatch in the comparison table.
        case 'options': col = r.colour || '#101418'; break;
        default: col = '#101418';
      }
      ctx.strokeStyle = col;
      ctx.beginPath(); ctx.moveTo(x0,y0); ctx.lineTo(x1,y1); ctx.stroke();
    }

    if (this.view === 'structures' && r.runs) {
      for (const run of r.runs) {
        if (run.type.id !== 'tunnel') continue;
        for (const i of [run.i0, run.i1]) {
          const [x,y] = this.toScreen(P[i].E, P[i].N);
          ctx.fillStyle = '#5b4636'; ctx.beginPath(); ctx.arc(x,y,4,0,7); ctx.fill();
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
        }
      }
    }
    // chainage ticks, spaced so the labels stay legible at any zoom
    if (this.zoom * 1000 > 6) {
      const L = P[P.length-1].s;
      const step = L > 200000 ? 25000 : L > 60000 ? 10000 : L > 20000 ? 5000 : 1000;
      ctx.font = '10px ui-monospace, monospace'; ctx.fillStyle = '#111';
      for (let i = 0; i < P.length; i++) {
        if (P[i].s % step > 25) continue;
        const [x,y] = this.toScreen(P[i].E,P[i].N);
        ctx.fillRect(x-1.5,y-1.5,3,3);
        ctx.fillText((P[i].s/1000).toFixed(0)+' km', x+5, y-4);
      }
    }
    if (this.hoverIdx != null && P[this.hoverIdx]) {
      const q = P[this.hoverIdx];
      const [x,y] = this.toScreen(q.E, q.N);
      ctx.beginPath(); ctx.arc(x, y, 6.5, 0, 7);
      ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fill();
      ctx.strokeStyle = '#c62828'; ctx.lineWidth = 2.5; ctx.stroke();
    }
  }

  drawControls() {
    const ctx = this.ctx;
    ctx.font = '600 12px system-ui, sans-serif';
    /* With a reference line on screen, its stations ARE the stations — sited on
       the line, up to ~320 m from the nominal control points the router starts
       from. Labelling both puts two names on every node, so the nominal points
       drop to plain dots and the on-line stations carry the labels. */
    const ref = this.result && this.result.search && this.result.search.reference;
    if (ref) {
      const KIND = { primary: '#14181c', secondary: '#4b5563', airport: '#b8272b' };
      for (const c of (this.result.chn || [])) {
        const [x, y] = this.toScreen(c.node.E, c.node.N);
        const primary = c.node.kind === 'primary';
        ctx.beginPath(); ctx.arc(x, y, primary ? 7 : 5.5, 0, 7);
        ctx.fillStyle = KIND[c.node.kind] || '#14181c'; ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.2; ctx.stroke();
        const lab = c.node.name || c.node.id;
        const wpx = ctx.measureText(lab).width;
        const flip = x + 18 + wpx > this.cv.width;
        const bx = flip ? x - 10 - (wpx + 8) : x + 10;
        ctx.fillStyle = 'rgba(255,255,255,.86)'; ctx.fillRect(bx, y - 9, wpx + 8, 16);
        ctx.fillStyle = '#14181c'; ctx.fillText(lab, bx + 4, y + 3);
      }
      for (const nd of this.controls) {
        const [x, y] = this.toScreen(nd.E, nd.N);
        ctx.beginPath(); ctx.arc(x, y, 2.5, 0, 7);
        ctx.fillStyle = 'rgba(20,24,28,.55)'; ctx.fill();
      }
      return;
    }
    this.controls.forEach((nd, i) => {
      const [x,y] = this.toScreen(nd.E, nd.N);
      const first = i === 0, last = i === this.controls.length - 1;
      ctx.beginPath(); ctx.arc(x, y, first || last ? 8 : 6.5, 0, 7);
      ctx.fillStyle = first ? '#1d7a35' : last ? '#b8272b' : '#14181c';
      ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.stroke();
      // Flip the label to the left when it would run off the edge of the canvas.
      const lab = nd.name || nd.id || String(i + 1);
      const wpx = ctx.measureText(lab).width;
      const flip = x + 18 + wpx > this.cv.width;
      const bx = flip ? x - 10 - (wpx + 8) : x + 10;
      ctx.fillStyle = 'rgba(255,255,255,.86)';
      ctx.fillRect(bx, y - 9, wpx + 8, 16);
      ctx.fillStyle = '#14181c';
      ctx.fillText(lab, bx + 4, y + 3);
    });
  }

  drawScaleBar() {
    const ctx = this.ctx, h = this.cv.height;
    const targets = [100,200,500,1000,2000,5000,10000,20000,50000,100000];
    const m = targets.find(t => t*this.zoom > 70) || 100000;
    const px = m*this.zoom, x = 16, y = h-24;
    ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fillRect(x-6,y-20,px+12,30);
    ctx.strokeStyle='#111'; ctx.lineWidth=2;
    ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x+px,y);
    ctx.moveTo(x,y-5); ctx.lineTo(x,y+5); ctx.moveTo(x+px,y-5); ctx.lineTo(x+px,y+5);
    ctx.stroke();
    ctx.fillStyle='#111'; ctx.font='11px system-ui,sans-serif';
    ctx.fillText(m >= 1000 ? (m/1000)+' km' : m+' m', x+4, y-7);
  }
  drawNorth() {
    const ctx = this.ctx, w = this.cv.width;
    const x = w - 30, y = 34;
    ctx.beginPath(); ctx.moveTo(x, y-16); ctx.lineTo(x-6, y+8); ctx.lineTo(x, y+3);
    ctx.lineTo(x+6, y+8); ctx.closePath();
    ctx.fillStyle = 'rgba(20,24,28,.8)'; ctx.fill();
    ctx.fillStyle = '#14181c'; ctx.font = '700 10px system-ui,sans-serif';
    ctx.fillText('N', x-3, y+20);
  }
}

/* ------------------------------------------------------------- CHARTS ---- */
function drawProfile(cv, r, hoverIdx) {
  const ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
  ctx.clearRect(0,0,W,H); ctx.fillStyle='#fff'; ctx.fillRect(0,0,W,H);
  if (!r || !r.P || r.P.length < 2) return;
  const P = r.P, vp = r.vp, n = P.length, L = P[n-1].s;
  let zmin = Infinity, zmax = -Infinity;
  for (let i=0;i<n;i++){ zmin=Math.min(zmin,vp.ground[i],vp.z[i]); zmax=Math.max(zmax,vp.ground[i],vp.z[i]); }
  const pad = 26, ml = 50, topRoom = 24;
  const range = Math.max(20, zmax - zmin);
  zmin -= range*0.08; zmax += range*0.08;
  const X = s => ml + (s/L)*(W-ml-14);
  const Y = z => H-pad - ((z-zmin)/(zmax-zmin))*(H-pad-topRoom);
  r._profX = { ml, right: 14, W, L };

  ctx.beginPath();
  for (let i=0;i<n;i++){ const x=X(P[i].s), y=Y(vp.ground[i]); i?ctx.lineTo(x,y):ctx.moveTo(x,y); }
  ctx.lineTo(X(L),H-pad); ctx.lineTo(X(0),H-pad); ctx.closePath();
  ctx.fillStyle='rgba(200,184,154,.72)'; ctx.fill();
  ctx.beginPath();
  for (let i=0;i<n;i++){ const x=X(P[i].s), y=Y(vp.ground[i]); i?ctx.lineTo(x,y):ctx.moveTo(x,y); }
  ctx.strokeStyle='#7a6a4e'; ctx.lineWidth=1; ctx.stroke();

  // control-point verticals, behind the design line
  const chn = (r.chn || []).slice().sort((a,b)=>a.s-b.s);
  for (const c of chn) {
    if (c.node && c.node.synthetic) continue;
    const x = X(c.s);
    ctx.strokeStyle = '#666'; ctx.lineWidth = 1; ctx.setLineDash([2,3]);
    ctx.beginPath(); ctx.moveTo(x, topRoom-6); ctx.lineTo(x, H-pad); ctx.stroke();
  }
  ctx.setLineDash([]);

  ctx.lineWidth = 3.2; ctx.lineCap = 'butt';
  for (let i=1;i<n;i++){
    ctx.strokeStyle = r.structs[i].colour;
    ctx.beginPath(); ctx.moveTo(X(P[i-1].s),Y(vp.z[i-1])); ctx.lineTo(X(P[i].s),Y(vp.z[i])); ctx.stroke();
  }

  ctx.fillStyle='#333'; ctx.font='700 10px system-ui,sans-serif';
  for (const c of chn) {
    if (c.node && c.node.synthetic) continue;
    // Keep the label inside the plot — the terminus label sits on the right-hand
    // axis and was being cut in half by the canvas edge.
    const lab = c.node.name || c.node.id || '';
    const lw = ctx.measureText(lab).width;
    const lx = Math.max(ml, Math.min(W - 14 - lw, X(c.s) - lw / 2));
    ctx.fillText(lab, lx, topRoom-10);
  }

  ctx.strokeStyle='#333'; ctx.lineWidth=1;
  ctx.beginPath(); ctx.moveTo(ml,topRoom-6); ctx.lineTo(ml,H-pad); ctx.lineTo(W-14,H-pad); ctx.stroke();
  ctx.fillStyle='#333'; ctx.font='10px system-ui,sans-serif';
  const zSpan = zmax - zmin;
  const zStep = zSpan > 900 ? 250 : zSpan > 400 ? 100 : zSpan > 160 ? 50 : zSpan > 60 ? 20 : 10;
  for (let z=Math.ceil(zmin/zStep)*zStep; z<zmax; z+=zStep){
    ctx.fillStyle='#333'; ctx.fillText(z+'', 6, Y(z)+3);
    ctx.strokeStyle='rgba(0,0,0,.07)';
    ctx.beginPath(); ctx.moveTo(ml,Y(z)); ctx.lineTo(W-14,Y(z)); ctx.stroke();
  }
  const sStep = L > 200000 ? 25000 : L > 60000 ? 10000 : L > 20000 ? 5000 : L > 6000 ? 1000 : 500;
  for (let s=0; s<=L; s+=sStep){
    ctx.fillStyle='#333';
    ctx.fillText((s/1000).toFixed(sStep < 1000 ? 1 : 0), X(s)-6, H-pad+13);
  }
  ctx.fillStyle='#555';
  ctx.fillText('m', 6, 12); ctx.fillText('chainage (km)', W-92, H-6);

  if (hoverIdx != null && P[hoverIdx]) {
    const i = hoverIdx, x = X(P[i].s);
    ctx.strokeStyle = '#c62828'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(x, topRoom-6); ctx.lineTo(x, H-pad); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, Y(vp.z[i]), 4.5, 0, 7);
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.strokeStyle = '#c62828'; ctx.lineWidth = 2; ctx.stroke();
    const d = vp.diff[i];
    const lab = `${(P[i].s/1000).toFixed(2)} km · ground ${vp.ground[i].toFixed(0)} · ` +
                `design ${vp.z[i].toFixed(0)} m · ${d>=0?'fill':'cut'} ${Math.abs(d).toFixed(1)} m · ` +
                `${vp.grade[i].toFixed(2)} %` +
                (r.sp && r.sp.v ? ` · ${(r.sp.v[i]*3.6).toFixed(0)} km/h` : '');
    ctx.font = '600 10.5px system-ui,sans-serif';
    const wpx = ctx.measureText(lab).width + 10;
    const bx = Math.max(ml, Math.min(W-14-wpx, x - wpx/2));
    ctx.fillStyle = 'rgba(255,255,255,.95)'; ctx.fillRect(bx, H-pad-20, wpx, 15);
    ctx.strokeStyle = '#c62828'; ctx.lineWidth = 1; ctx.strokeRect(bx, H-pad-20, wpx, 15);
    ctx.fillStyle = '#7a1010'; ctx.fillText(lab, bx+5, H-pad-9);
  }
}

/* Mass haul. The classic earthworks diagram: cumulative cut minus fill along
   the chainage. Where the curve rises the alignment is generating spoil, where
   it falls it is consuming it, and a curve that returns to zero is a balanced
   design. The vertical distance between two points on the curve is the volume
   that has to be hauled between them — which is why this drawing, and not the
   cut/fill totals, is what tells you whether the earthworks are sensible. */
function drawMassHaul(cv, r, hoverIdx) {
  const ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
  ctx.clearRect(0,0,W,H); ctx.fillStyle='#fff'; ctx.fillRect(0,0,W,H);
  if (!r || !r.q || !r.q.massHaul) return;
  const P = r.P, m = r.q.massHaul, n = P.length, L = P[n-1].s;
  let lo = 0, hi = 0;
  for (let i=0;i<n;i++){ if (m[i]<lo) lo=m[i]; if (m[i]>hi) hi=m[i]; }
  const span = Math.max(1, hi - lo);
  lo -= span*0.1; hi += span*0.1;
  const pad = 24, ml = 58;
  const X = s => ml + (s/L)*(W-ml-14);
  const Y = v => H-pad - ((v-lo)/(hi-lo))*(H-pad-16);

  // zero line — the balance point
  ctx.strokeStyle='#999'; ctx.lineWidth=1; ctx.setLineDash([4,3]);
  ctx.beginPath(); ctx.moveTo(ml,Y(0)); ctx.lineTo(W-14,Y(0)); ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath();
  for (let i=0;i<n;i++){ const x=X(P[i].s), y=Y(m[i]); i?ctx.lineTo(x,y):ctx.moveTo(x,y); }
  ctx.lineTo(X(L), Y(0)); ctx.lineTo(X(0), Y(0)); ctx.closePath();
  ctx.fillStyle = 'rgba(180,120,90,.28)'; ctx.fill();
  ctx.beginPath();
  for (let i=0;i<n;i++){ const x=X(P[i].s), y=Y(m[i]); i?ctx.lineTo(x,y):ctx.moveTo(x,y); }
  ctx.strokeStyle='#8a4b2a'; ctx.lineWidth=1.8; ctx.stroke();

  ctx.strokeStyle='#333'; ctx.lineWidth=1;
  ctx.beginPath(); ctx.moveTo(ml,14); ctx.lineTo(ml,H-pad); ctx.lineTo(W-14,H-pad); ctx.stroke();
  ctx.fillStyle='#333'; ctx.font='10px system-ui,sans-serif';
  const step = Math.pow(10, Math.floor(Math.log10(span))) * (span/Math.pow(10, Math.floor(Math.log10(span))) > 4 ? 1 : 0.5);
  for (let v=Math.ceil(lo/step)*step; v<hi; v+=step) {
    ctx.fillStyle='#333';
    ctx.fillText((v/1000).toFixed(0)+'k', 6, Y(v)+3);
    ctx.strokeStyle='rgba(0,0,0,.07)';
    ctx.beginPath(); ctx.moveTo(ml,Y(v)); ctx.lineTo(W-14,Y(v)); ctx.stroke();
  }
  ctx.fillStyle='#555';
  ctx.fillText('m³ cumulative', 6, 11);
  const net = r.q.earthworks.netM3;
  ctx.fillText(net >= 0 ? `surplus ${(net/1000).toFixed(0)}k m³ to dispose`
                        : `deficit ${(-net/1000).toFixed(0)}k m³ to import`, W-190, 11);
  if (hoverIdx != null && P[hoverIdx]) {
    const x = X(P[hoverIdx].s);
    ctx.strokeStyle = '#c62828'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(x, 14); ctx.lineTo(x, H-pad); ctx.stroke();
  }
}

global.RENDER = { MapView, drawProfile, drawMassHaul, speedColour, cutFillColour,
                  gradeColour, VIEW, PHASE_COL, PHASE_LAB, LAYER_STYLE };
})(window);
