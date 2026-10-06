/* ===========================================================================
   Alignment Designer v12 :: VIEW3D
   A 3-D block model of the alignment and the ground it crosses.

   Why it exists. The plan says the line crosses a river at 61 km; the long
   section says it is 40 m in the air there. Neither says, at a glance, that the
   viaduct is spanning a gorge between two ridges the line could not go round,
   or that a 21 km "tunnel" is shallow cover under a creek rather than a bore
   through a mountain. That is a question about SHAPE, and shape is read in
   three dimensions. So this draws the corridor the way a block diagram does:
   a lit, coloured slab of terrain cut out around the line, with the line at its
   own design level, its structures drawn as what they are, and the alternatives
   beside it.

   Decisions, and why they were taken:

   · Plain WebGL, no library. The app has no build step and loads nothing from a
     CDN; a 600 kB 3-D engine to draw one heightfield and some lines would be
     the largest file in the project. WebGL2 is preferred; WebGL1 works when it
     has OES_element_index_uint (a 400 k-vertex terrain needs 32-bit indices).
   · Vertical exaggeration is a SHADER UNIFORM, never baked into geometry.
     Every vertex carries its raw elevation and the shader scales it, so the
     slider re-scales terrain, deck, piers, slopes and labels together and can
     never leave one of them at the old scale. Geometry is built once.
   · Relief is shaded from a native-resolution GRADIENT texture, not from mesh
     normals. The mesh is downsampled to stay under ~400 k vertices (London's
     412 km loop gets ~200 m facets); the texture keeps the DEM's own cell, so
     the hillshade does not get coarser as the window gets larger.
   · The shading exaggeration is decoupled from the geometric VE. At VE 1 the
     Gangetic plain is geometrically a table top; drawn honestly it shows
     nothing. The 2-D map solves the same problem by stretching its hillshade
     array-wide — so does this: the shading normal is steepened until the
     window's MEDIAN slope reads as a clear tilt, and saturated so escarpments
     do not burn out. Geometry stays true; only the light is exaggerated.
   · The light follows the view (from ahead-left, like a map's north-west
     light seen from the south). A fixed sun inverts relief whenever the camera
     looks towards it — valleys read as ridges — and on a flat plain shading is
     the ONLY relief cue there is, so that inversion cannot be risked.
   · Lines are drawn in SCREEN space with a world-space floor: a deck is its
     real (exaggerated) width close up and never thinner than a couple of pixels
     at 400 km. WebGL's own lines are one pixel wide on most platforms.
   · Depth fighting is handled by pulling line work towards the eye along its
     own view ray. That leaves its screen position exactly where it was and only
     changes its depth; the pull grows with distance in proportion to the depth
     buffer's own resolution there, so one scheme serves a 1 km scene and a
     450 km one. polygonOffset alone cannot: the ribbon is not coplanar with a
     terrain mesh that is coarser than the 25 m alignment samples.
   · Cuttings and tunnels are below the terrain surface — that is what they
     ARE — and the mesh is coarser than a cutting is wide, so it is not carved.
     Instead a cutting (and any at-grade line) is SURFACED in depth only: slid
     along its view ray to the ground above it, so it wins the depth test and
     reads as an open trench. Tunnels stay buried; what the terrain hides of the
     selected line is drawn again, dashed, on top — CAD's "hidden line"
     convention. X-ray mode makes the terrain translucent with a depth
     pre-pass (only its nearest surface blends, its folds do not double up)
     and hangs a cover curtain from each tunnel up to the ground.
   · Rendering is on demand. Nothing runs while the view is idle; a hover
     marker only redraws the 2-D overlay, not the 3-D frame.

   Coordinates: projected metres. The scene origin is the window centre, so
   float32 vertex positions keep centimetre precision 225 km out. World axes
   are x = east, y = north, z = up (scaled); grids are row-major from the
   north-west corner, A[iy*nx + ix], exactly as the engine stores them.
   =========================================================================== */
(function (global) {
'use strict';

/* ------------------------------------------------------------ MATRICES -- */
/* Column-major, computed in float64 and handed to GL as float32 at the end:
   the view translation of a 450 km scene is ~1e5, and composing it in float32
   loses the decimetres a zoomed-in deck needs. */
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0,  0, f, 0, 0,  0, 0, (far + near) * nf, -1,  0, 0, 2 * far * near * nf, 0];
}
function lookAt(e, t, u) {
  let zx = e[0] - t[0], zy = e[1] - t[1], zz = e[2] - t[2];
  let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
  let xx = u[1] * zz - u[2] * zy, xy = u[2] * zx - u[0] * zz, xz = u[0] * zy - u[1] * zx;
  l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return [xx, yx, zx, 0,  xy, yy, zy, 0,  xz, yz, zz, 0,
          -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]),
          -(zx * e[0] + zy * e[1] + zz * e[2]), 1];
}
function mul4(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}

/* -------------------------------------------------------------- COLOUR -- */
/** '#rgb', '#rrggbb', 'rgb(…)', 'rgba(…)' or [r,g,b] → [r,g,b] in 0..255. */
function parseColour(c, fallback) {
  if (Array.isArray(c)) return c;
  if (typeof c !== 'string') return fallback;
  let m = c.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.replace(/./g, '$&$&');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  m = c.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (m) return [+m[1], +m[2], +m[3]];
  return fallback;
}
const rgba01 = (rgb, a) => [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, a === undefined ? 1 : a];
const cssOf = (rgb, a) => `rgba(${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0},${a === undefined ? 1 : a})`;

/* Fallback constraint styles, used only when render.js is not loaded. They
   copy RENDER.LAYER_STYLE so the drape reads the same as the 2-D map; the last
   three are coastal layers some imports carry that the map may not style yet. */
const FALLBACK_STYLE = {
  built:       { rgb: [90, 90, 100],  alpha: 0.55, label: 'Built-up area' },
  protected:   { rgb: [146, 84, 178], alpha: 0.42, label: 'Protected landscape' },
  woodland:    { rgb: [70, 130, 70],  alpha: 0.50, label: 'Woodland' },
  flood:       { rgb: [60, 130, 200], alpha: 0.45, label: 'Floodplain' },
  water_body:  { rgb: [20, 110, 190], alpha: 0.85, label: 'Water' },
  river_major: { rgb: [20, 110, 190], alpha: 0.85, label: 'Major watercourse' },
  road_major:  { rgb: [170, 80, 40],  alpha: 0.60, label: 'Major road' },
  rail:        { rgb: [110, 60, 140], alpha: 0.60, label: 'Existing railway' },
  farmland:    { rgb: [180, 190, 100], alpha: 0.35, label: 'High-grade farmland' },
  greenbelt:   { rgb: [120, 170, 110], alpha: 0.35, label: 'Green belt' },
  exclusion:   { rgb: [198, 40, 40],  alpha: 0.55, label: 'No-go zone' },
  mangrove:    { rgb: [40, 120, 90],  alpha: 0.55, label: 'Mangrove' },
  wetland:     { rgb: [80, 160, 170], alpha: 0.45, label: 'Wetland' },
  crz:         { rgb: [230, 140, 60], alpha: 0.35, label: 'Coastal regulation zone' },
};
/* What the 2-D map shows on first load when a project says nothing — the
   same list, so switching to 3-D does not change what is on the ground. */
const DEFAULT_ON = ['built', 'protected', 'water_body', 'river_major', 'exclusion'];
const NON_COVERAGE = { dem: 1, slope: 1 };

/* Structure colours, used when a result's struct objects carry none. Kept the
   same as ENGINE.STRUCT so the 3-D deck, the map and the long section agree. */
const STRUCT_FALLBACK = {
  tunnel: '#8e2020', cutting: '#d98880', embankment: '#85b8dc',
  bridge: '#2e86c1', viaduct: '#1a4e8a', atgrade: '#6f7f6f',
};
const STRUCT_LABEL = {
  tunnel: 'Tunnel', cutting: 'Cutting', embankment: 'Embankment',
  bridge: 'Bridge', viaduct: 'Viaduct', atgrade: 'At grade',
};
const ELEVATED = { viaduct: 1, bridge: 1 };

/* --------------------------------------------------------- HYPSOMETRY --- */
/* The terrain ramp and its limits are the 2-D map's (render.js demOverlay),
   reproduced rather than shared because that one is a method on MapView and
   this module must work without it. The same elevation is the same colour in
   plan and in 3-D — otherwise a reader comparing the two would be comparing
   two legends. */
const RAMP = [[0.00, 0.20, 0.20, 0.60], [0.15, 0.00, 0.60, 1.00],
              [0.25, 0.00, 0.80, 0.40], [0.50, 1.00, 1.00, 0.60],
              [0.75, 0.50, 0.36, 0.33], [1.00, 1.00, 1.00, 1.00]];
function ramp(t, out) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  for (let k = 1; k < RAMP.length; k++) {
    if (t <= RAMP[k][0]) {
      const a = RAMP[k - 1], b = RAMP[k], f = (t - a[0]) / (b[0] - a[0]);
      out[0] = a[1] + (b[1] - a[1]) * f; out[1] = a[2] + (b[2] - a[2]) * f; out[2] = a[3] + (b[3] - a[3]) * f;
      return out;
    }
  }
  out[0] = out[1] = out[2] = 1; return out;
}
function terrainLimits(G) {
  const A = G.layer.dem, d = G.defaults || {};
  if (d.terrainRange && d.terrainRange.length === 2) return [+d.terrainRange[0], +d.terrainRange[1]];
  let lo, hi;
  if (d.terrainFocus && d.terrainFocus.length === 2) { lo = +d.terrainFocus[0]; hi = +d.terrainFocus[1]; }
  else {
    const step = Math.max(1, Math.floor(A.length / 40000)), smp = [];
    for (let i = 0; i < A.length; i += step) smp.push(A[i]);
    smp.sort((p, q) => p - q);
    lo = smp[Math.floor(smp.length * 0.01)]; hi = smp[Math.floor(smp.length * 0.99)];
  }
  const span = Math.max(1, hi - lo);
  const vmin = lo - 0.22 * span / 0.73;          // lo on the green, not the sea blues
  return [vmin, vmin + span / 0.73];
}

/* ------------------------------------------------------------ SHADERS --- */
const FS_PRECISION =
  '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n';

const TERRAIN_VS = `
attribute vec3 aPos;
uniform mat4 uVP;
uniform float uVE, uZRef;
uniform vec4 uTexRect;           // west edge, north edge, width, height (scene metres)
varying vec2 vUV;
varying vec3 vW;
void main() {
  vec3 p = vec3(aPos.xy, (aPos.z - uZRef) * uVE);
  vUV = vec2((aPos.x - uTexRect.x) / uTexRect.z, (uTexRect.y - aPos.y) / uTexRect.w);
  vW = p;
  gl_Position = uVP * vec4(p, 1.0);
}`;

/* Generated per project, because the number of constraint layers decides how
   many coverage textures there are (four layers to an RGBA texture) and how
   long the uniform array is — and a fixed 16-slot array would spend most of
   WebGL1's guaranteed fragment-uniform budget on layers that do not exist. */
function terrainFS(nLayers) {
  const nt = Math.ceil(nLayers / 4), n = Math.max(1, nLayers);
  let s = FS_PRECISION + `
varying vec2 vUV;
varying vec3 vW;
uniform sampler2D uBase, uGrad;
uniform vec4 uLc[${n}];          // layer rgb, and alpha × shown
uniform float uShadeK, uG0, uContrast, uAlpha;
uniform vec3 uLight, uEye, uHaze, uFog;
`;
  for (let t = 0; t < nt; t++) s += `uniform sampler2D uL${t};\n`;
  s += `
void main() {
  vec3 col = texture2D(uBase, vUV).rgb;
  vec4 l;
`;
  for (let t = 0; t < nt; t++) {
    s += `  l = texture2D(uL${t}, vUV);\n`;
    for (let c = 0; c < 4 && t * 4 + c < nLayers; c++) {
      const j = t * 4 + c;
      s += `  col = mix(col, uLc[${j}].rgb, l.${'rgba'[c]} * uLc[${j}].a);\n`;
    }
  }
  s += `
  // gradient decoded from the soft-sign encoding g/(|g|+g0) the texture holds
  vec2 e = texture2D(uGrad, vUV).rg * 2.0 - 1.0;
  vec2 g = uG0 * e / max(vec2(1.0) - abs(e), vec2(0.004));
  /* Steepened by uShadeK, then saturated towards 45°: the plain's 0.3 %
     slopes become readable without the escarpment's 30 % faces going black. */
  vec2 kg = uShadeK * g;
  kg /= 1.0 + length(kg);
  vec3 n = normalize(vec3(-kg, 1.0));
  // relative to flat ground: level terrain keeps its legend colour exactly
  float lum = clamp(1.0 + uContrast * (dot(n, uLight) - uLight.z), 0.38, 1.32);
  col *= lum;
  float f = clamp((distance(vW, uEye) - uFog.x) / max(1.0, uFog.y - uFog.x), 0.0, 1.0) * uFog.z;
  gl_FragColor = vec4(mix(col, uHaze, f), uAlpha);
}`;
  return s;
}

/* Depth-only moves, shared by every piece of line work. Both slide a point
   along its OWN view ray, so its pixel stays put and only its depth changes.

   surfaced: up to the ground above it (aTop, raw metres; −1e9 = never). This
   is what makes a cutting read as an open trench and keeps an at-grade line
   on top of a terrain mesh coarser than it: the terrain inside a cutting's
   footprint simply loses the depth test. Carving the mesh was the
   alternative, and the mesh is coarser than a cutting is wide. Tunnels carry
   no aTop — they are meant to be hidden, and the hidden-line pass dashes them.
   The ray is treated as no flatter than ~7°, so a grazing view cannot fling
   a trench over the hill in front of it.

   pulled: a little further, in proportion to the depth buffer's resolution at
   that distance, so line work never z-fights the ground it sits on. Buried
   work (aTop = NO_LIFT) gets only a token pull, enough to keep the casing,
   centre line and deck in order: the full pull is 0.5 % of the distance —
   125 m at 25 km — and a tunnel under 15 m of cover drew solid through it. */
const DEPTH_GLSL = `
vec3 surfaced(vec3 p, float top) {
  float dz = (top - uZRef) * uVE - p.z;
  if (dz <= 0.0) return p;
  // the ray climbs over ground that may rise towards the eye: overshoot a little
  dz = dz * 1.3 + uVE;
  vec3 v = uEye - p;
  float L = length(v);
  v /= L;
  return p + v * min(dz / max(v.z, 0.12), 0.9 * L);
}
vec3 pulled(vec3 p, float top) {
  float k = top < -1e8 ? uPull * 0.04 : min(0.5, uPull + distance(p, uEye) * uDepthK);
  return p + (uEye - p) * k;
}`;

/* Solid geometry with a colour per vertex: the deck, the viaduct fascia,
   earthwork slopes, the tunnel cover curtain, the sides of the block. */
const MESH_VS = `
attribute vec3 aPos;
attribute float aTop;
attribute float aS;
attribute vec4 aCol;
uniform mat4 uVP;
uniform vec3 uEye;
uniform float uVE, uZRef, uPull, uDepthK;
varying vec4 vCol;
varying vec3 vW;
varying float vS;
${DEPTH_GLSL}
void main() {
  vec3 p = vec3(aPos.xy, (aPos.z - uZRef) * uVE);
  vW = p;
  vCol = aCol; vS = aS;
  gl_Position = uVP * vec4(pulled(surfaced(p, aTop), aTop), 1.0);
}`;

/* Screen-space polylines: each point is emitted twice and pushed sideways in
   pixels, perpendicular to the line's direction ON SCREEN. Half-width is the
   larger of a pixel floor and the world width at that depth, so a pier is a
   pier close up and still a visible stroke from 300 km. */
const LINE_VS = `
attribute vec3 aPos;
attribute vec3 aPrev;
attribute vec3 aNext;
attribute vec2 aSW;              // side (−1/+1), world half-width (m)
attribute float aS;
attribute float aTop;
attribute vec4 aCol;
uniform mat4 uVP;
uniform vec3 uEye;
uniform vec2 uViewport;
uniform float uVE, uZRef, uPull, uDepthK, uMinPx, uPxK;
varying vec4 vCol;
varying vec3 vW;
varying float vS;
${DEPTH_GLSL}
void main() {
  vec3 w = vec3(aPos.xy, (aPos.z - uZRef) * uVE);
  vW = w;
  // the depth moves leave screen positions alone, so the direction on screen
  // comes from the unmoved neighbours and only this vertex is moved
  vec4 c0 = uVP * vec4(w, 1.0);
  vec4 c = uVP * vec4(pulled(surfaced(w, aTop), aTop), 1.0);
  vec4 a = uVP * vec4(aPrev.xy, (aPrev.z - uZRef) * uVE, 1.0);
  vec4 b = uVP * vec4(aNext.xy, (aNext.z - uZRef) * uVE, 1.0);
  if (a.w <= 0.0) a = c0;
  if (b.w <= 0.0) b = c0;
  vec2 d = b.xy / b.w * uViewport - a.xy / a.w * uViewport;
  float L = length(d);
  d = L > 1e-6 ? d / L : vec2(1.0, 0.0);
  float hw = max(uMinPx, aSW.y / (max(c0.w, 1e-3) * uPxK));
  c.xy += vec2(-d.y, d.x) * aSW.x * hw * 2.0 / uViewport * c.w;
  vCol = aCol; vS = aS;
  gl_Position = c;
}`;

/* Shared by mesh and line work: tint (casing), dashes (hidden line), the
   window clip (alternatives that run off the block are not drawn in the air
   beside it) and the same haze the terrain gets. */
const FLAT_FS = FS_PRECISION + `
varying vec4 vCol;
varying vec3 vW;
varying float vS;
uniform float uAlpha, uDash;
uniform vec4 uTint, uClip;
uniform vec3 uEye, uHaze, uFog;
void main() {
  if (vW.x < uClip.x || vW.y < uClip.y || vW.x > uClip.z || vW.y > uClip.w) discard;
  if (uDash > 0.0 && fract(vS / uDash) > 0.55) discard;
  vec3 col = mix(vCol.rgb, uTint.rgb, uTint.a);
  float f = clamp((distance(vW, uEye) - uFog.x) / max(1.0, uFog.y - uFog.x), 0.0, 1.0) * uFog.z;
  gl_FragColor = vec4(mix(col, uHaze, f), vCol.a * uAlpha);
}`;

/* ------------------------------------------------- GROWABLE BUFFERS ----- */
class FBuf {
  constructor(stride, cap) { this.stride = stride; this.a = new Float32Array(stride * (cap || 1024)); this.n = 0; }
  need(k) {
    const want = (this.n + k) * this.stride;
    if (want <= this.a.length) return;
    let c = this.a.length; while (c < want) c *= 2;
    const b = new Float32Array(c); b.set(this.a.subarray(0, this.n * this.stride)); this.a = b;
  }
}
class IBuf {
  constructor(cap) { this.a = new Uint32Array(cap || 4096); this.n = 0; }
  need(k) {
    if (this.n + k <= this.a.length) return;
    let c = this.a.length; while (c < this.n + k) c *= 2;
    const b = new Uint32Array(c); b.set(this.a.subarray(0, this.n)); this.a = b;
  }
  push(i) { this.a[this.n++] = i; }
}
const MESH_STRIDE = 9;    // x y h | top | s | r g b a
const LINE_STRIDE = 17;   // x y h | px py ph | nx ny nh | side hw | s | top | r g b a
const NO_LIFT = -1e9;     // "top" for what must stay buried (tunnels, the block's sides)

function meshVert(F, x, y, h, top, s, c) {
  F.need(1);
  const o = F.n * MESH_STRIDE, a = F.a;
  a[o] = x; a[o + 1] = y; a[o + 2] = h; a[o + 3] = top; a[o + 4] = s;
  a[o + 5] = c[0]; a[o + 6] = c[1]; a[o + 7] = c[2]; a[o + 8] = c[3];
  return F.n++;
}
/** Quad a-b-c-d (in order round the edge) as two triangles. */
function quad(I, a, b, c, d) { I.need(6); I.push(a); I.push(b); I.push(c); I.push(a); I.push(c); I.push(d); }

/** Append one polyline. X/Y/H/S are indexable; col(i) → [r,g,b,a] 0..1; hw(i) → metres;
    top(i) → ground level to surface to (raw m), or omitted for none. */
function addPolyline(F, I, n, X, Y, H, S, col, hw, top) {
  if (n < 2) return;
  F.need(2 * n); I.need(6 * (n - 1));
  const base = F.n, a = F.a;
  for (let i = 0; i < n; i++) {
    const p = i > 0 ? i - 1 : i, q = i < n - 1 ? i + 1 : i;
    const c = col(i), w = hw(i), s = S ? S[i] : 0, tp = top ? top(i) : NO_LIFT;
    for (let side = -1; side <= 1; side += 2) {
      const o = F.n * LINE_STRIDE;
      a[o] = X[i]; a[o + 1] = Y[i]; a[o + 2] = H[i];
      a[o + 3] = X[p]; a[o + 4] = Y[p]; a[o + 5] = H[p];
      a[o + 6] = X[q]; a[o + 7] = Y[q]; a[o + 8] = H[q];
      a[o + 9] = side; a[o + 10] = w; a[o + 11] = s; a[o + 12] = tp;
      a[o + 13] = c[0]; a[o + 14] = c[1]; a[o + 15] = c[2]; a[o + 16] = c[3];
      F.n++;
    }
  }
  for (let i = 0; i < n - 1; i++) {
    const v = base + 2 * i;
    I.push(v); I.push(v + 1); I.push(v + 2); I.push(v + 1); I.push(v + 3); I.push(v + 2);
  }
}

const deg = Math.PI / 180;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

/* ============================================================= VIEWER === */
class Viewer {
  constructor(canvas, opts) {
    opts = opts || {};
    this.cv = canvas;
    this.opts = Object.assign({
      ve: 3,                  // vertical exaggeration
      terrainAlpha: 1,        // < 1 makes the block translucent
      xray: false,            // translucent terrain, so tunnels read through it
      showLayers: {},         // { key: bool } over the project's defaults
      ribbonWidth: 2,         // deck drawn at this × the standard's formation width
      ribbonMinPx: 1.6,       // and never thinner than this half-width on screen
      slopes: true,           // earthwork side slopes as hints
      piers: true,
      labels: true,           // stations and long structures
      hidden: true,           // dashed hidden-line pass for what the ground covers
      hud: true,              // compass, scale, VE, structure legend
      shade: 1,               // multiplier on the automatic relief shading
      maxVertices: 400000,
      maxTexturePixels: 4.2e6,
      fov: 40,
      background: '#dfe6ee',
      bufferM: 3000,
      webgl1: false,          // force the WebGL1 path (testing the fallback)
    }, opts);
    this.onPick = opts.onPick || null;
    this.onHover = opts.onHover || null;
    this.stats = {};
    this.error = null;
    this.G = null;
    this.scene = null;
    this.terrain = null;
    this.items = {};
    this.cam = null;
    this.marker = null;
    this._camVer = 0;
    this._raf = 0; this._tween = 0;
    this._listeners = [];
    this.dpr = 1; this.cssW = canvas.width || 300; this.cssH = canvas.height || 150;
    try { this._initGL(); }
    catch (err) { this.error = err.message; this.gl = null; }
    this._makeOverlay();
    if (!this.gl) { this.resize(); return; }
    this._bind();
    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(canvas);
    }
    this.resize();
  }

  /* --------------------------------------------------------- GL SETUP -- */
  _initGL() {
    const cv = this.cv;
    /* alpha:false — the block is composited over our own background, never
       the page: a translucent x-ray terrain over a transparent canvas would
       blend twice. antialias for the line work, which is mostly thin. */
    const attrs = { alpha: false, antialias: true, depth: true, premultipliedAlpha: false,
                    preserveDrawingBuffer: false, powerPreference: 'high-performance' };
    let gl = null, gl2 = false;
    if (!this.opts.webgl1) try { gl = cv.getContext('webgl2', attrs); gl2 = !!gl; } catch (e) { gl = null; }
    if (!gl) try { gl = cv.getContext('webgl', attrs) || cv.getContext('experimental-webgl', attrs); } catch (e) { gl = null; }
    if (!gl) {
      this.error = 'WebGL is not available in this browser, or it is switched off (check ' +
                   'hardware acceleration in the browser settings). The 3-D view needs WebGL.';
      return;
    }
    if (!gl2 && !gl.getExtension('OES_element_index_uint')) {
      this.error = 'This browser offers WebGL 1 without 32-bit indices (OES_element_index_uint); ' +
                   'the 3-D terrain cannot be drawn at a useful resolution.';
      this.gl = null;
      return;
    }
    this.gl = gl; this.gl2 = gl2;
    this._exts();
    this.maxTex = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048);
    this.depthBits = gl.getParameter(gl.DEPTH_BITS) || 16;
    this.stats.gl = gl2 ? 'webgl2' : 'webgl1';
    /* A canvas can be handed to a second viewer after dispose(); getContext
       then returns the SAME context, with the first viewer's attribute arrays
       still enabled and pointing at deleted buffers — every draw would fail. */
    const nAttr = gl.getParameter(gl.MAX_VERTEX_ATTRIBS) || 8;
    for (let i = 0; i < nAttr; i++) gl.disableVertexAttribArray(i);
    this.progMesh = this._program(MESH_VS, FLAT_FS);
    this.progLine = this._program(LINE_VS, FLAT_FS);
    this.progTerrain = null;
    this._enabled = new Set();
    this._lost = false;
    this._on(cv, 'webglcontextlost', e => {
      e.preventDefault(); this._lost = true;
      this.error = 'The graphics context was lost (GPU reset or memory pressure). It will be rebuilt when the browser restores it.';
      this._drawOverlay();
    });
    /* Everything from the old context is gone, extensions included: they
       must be asked for again, or a WebGL1 context draws its 32-bit-indexed
       terrain as nothing and the anisotropy calls raise INVALID_ENUM. Seen in
       testing: a page that created more than 16 contexts lost this one, and
       the restore rebuilt the scene with the dead extension objects. The
       camera is kept — a GPU hiccup should not throw the reader's view away. */
    this._on(cv, 'webglcontextrestored', () => {
      this._lost = false; this.error = null;
      this._exts();
      this.progMesh = this._program(MESH_VS, FLAT_FS);
      this.progLine = this._program(LINE_VS, FLAT_FS);
      this.progTerrain = null;                         // belonged to the lost context
      this._enabled = new Set();
      this.terrain = null; this.items = {};
      if (this.G) {
        const sc = this.scene, cam = this.cam, home = this._home, touched = this._touched, mk = this.marker;
        this.setGrid(this.G);
        if (sc) {
          this.setScene(Object.assign({}, sc.args, { fit: !cam }));
          if (cam && this.terrain) {
            this.cam = cam; this._home = home; this._touched = touched;
            this.marker = sc.sel && mk !== null && mk < sc.sel.P.length ? mk : null;
            this._camVer++; this.requestRender();
          }
        }
      }
    });
  }

  /** (Re-)acquire the extensions this viewer uses. Must run again after a
      context restore: extension objects do not survive a lost context. */
  _exts() {
    const gl = this.gl;
    if (!this.gl2) gl.getExtension('OES_element_index_uint');
    this.aniso = gl.getExtension('EXT_texture_filter_anisotropic') ||
                 gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
  }

  _program(vs, fs) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost())
        throw new Error('3-D view shader failed to compile: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    const vsh = sh(gl.VERTEX_SHADER, vs), fsh = sh(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(p, vsh);
    gl.attachShader(p, fsh);
    /* Every program has aPos; pinning it to location 0 keeps attribute 0
       always enabled, which WebGL1 on desktop-GL drivers otherwise emulates
       at a cost (or, on some, draws nothing). */
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    /* Flag the shaders for deletion now: they go when the program does. Left
       alone they outlived it — two leaked per setGrid, eight per viewer. */
    gl.deleteShader(vsh); gl.deleteShader(fsh);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost())
      throw new Error('3-D view shader failed to link: ' + gl.getProgramInfoLog(p));
    const prog = { p, a: {}, u: {} };
    const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES) || 0;
    for (let i = 0; i < na; i++) { const inf = gl.getActiveAttrib(p, i); prog.a[inf.name] = gl.getAttribLocation(p, inf.name); }
    const nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) || 0;
    for (let i = 0; i < nu; i++) {
      const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '');
      prog.u[name] = gl.getUniformLocation(p, name);
    }
    return prog;
  }

  /** Point the program's attributes into the bound buffer; disable the rest. */
  _attribs(prog, layout, stride) {
    const gl = this.gl, want = new Set();
    for (const [name, size, off] of layout) {
      const loc = prog.a[name];
      if (loc === undefined || loc < 0) continue;
      want.add(loc);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride * 4, off * 4);
    }
    for (const loc of this._enabled) if (!want.has(loc)) gl.disableVertexAttribArray(loc);
    this._enabled = want;
  }

  _upload(F, I) {
    if (!I.n) return null;
    const gl = this.gl;
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, F.a.subarray(0, F.n * F.stride), gl.STATIC_DRAW);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, I.a.subarray(0, I.n), gl.STATIC_DRAW);
    return { vbo, ibo, n: I.n, verts: F.n };
  }
  _free(item) {
    if (!item || !this.gl) return;
    this.gl.deleteBuffer(item.vbo); this.gl.deleteBuffer(item.ibo);
  }
  _freeItems() { for (const k in this.items) this._free(this.items[k]); this.items = {}; }

  _texture(w, h, data, mip) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    /* Mipmaps and anisotropy matter here more than in most scenes: a corridor
       is usually viewed obliquely, and an un-mipmapped drape shimmers into
       noise towards the horizon. WebGL1 can only mipmap power-of-two sizes. */
    const pot = (w & (w - 1)) === 0 && (h & (h - 1)) === 0;
    if (mip && (this.gl2 || pot)) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      if (this.aniso) {
        const mx = gl.getParameter(this.aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1;
        gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, mx));
      }
    } else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    return t;
  }

  /* ----------------------------------------------------------- OVERLAY -- */
  /* Labels, the hover marker and the HUD are 2-D, drawn on a canvas laid over
     the GL one. Text in WebGL would need a glyph atlas; a 2-D canvas gives
     crisp, halo'd type for free and can be redrawn without a 3-D frame. */
  _makeOverlay() {
    const o = this.opts.overlay || document.createElement('canvas');
    if (!this.opts.overlay) {
      o.className = 'view3d-overlay';
      o.style.cssText = 'position:absolute;pointer-events:none;left:0;top:0';
      if (this.cv.parentNode) this.cv.parentNode.insertBefore(o, this.cv.nextSibling);
      this._ownOverlay = true;
    }
    this.ov = o;
    this.octx = o.getContext('2d');
  }

  _on(el, ev, fn, opt) { el.addEventListener(ev, fn, opt); this._listeners.push([el, ev, fn, opt]); }

  /* -------------------------------------------------------------- GRID -- */
  /** Hand the viewer an engine grid (ENGINE.G). Clears any scene. */
  setGrid(G) {
    this.G = G;
    this.scene = null; this.cam = null; this.marker = null;
    this._freeTerrain(); this._freeItems();
    if (!G || !G.layer || !G.layer.dem) return;
    this.limits = terrainLimits(G);
    /* Constraint layers: every coverage grid the project carries that has a
       style, in the map's own draw order (later layers paint over earlier). */
    const RS = (global.RENDER && global.RENDER.LAYER_STYLE) || {};
    const style = Object.assign({}, FALLBACK_STYLE);
    for (const k in RS) style[k] = RS[k];
    const order = Object.keys(RS).concat(Object.keys(FALLBACK_STYLE).filter(k => !(k in RS)));
    this.layerKeys = order.filter(k => G.layer[k] && !NON_COVERAGE[k]).slice(0, 16);
    this.layerStyle = style;
    const want = (G.defaults && G.defaults.layers) || null;
    this.layerOn = {};
    for (const k of this.layerKeys)
      this.layerOn[k] = want && want[k] !== undefined ? !!want[k] : DEFAULT_ON.indexOf(k) >= 0;
    for (const k in this.opts.showLayers) if (k in this.layerOn) this.layerOn[k] = !!this.opts.showLayers[k];
    if (this.gl) {
      if (this.progTerrain) this.gl.deleteProgram(this.progTerrain.p);
      this.progTerrain = this._program(TERRAIN_VS, terrainFS(this.layerKeys.length));
    }
    this.requestRender();
  }

  /** The draped layers, for building a toggle list: [{key, label, rgb, on}]. */
  layers() {
    return (this.layerKeys || []).map(k => ({
      key: k, label: (this.layerStyle[k] || {}).label || k,
      rgb: (this.layerStyle[k] || {}).rgb || [128, 128, 128], on: !!this.layerOn[k] }));
  }

  _freeTerrain() {
    const T = this.terrain, gl = this.gl;
    if (T && gl) {
      gl.deleteBuffer(T.vbo); gl.deleteBuffer(T.ibo);
      if (T.skirt) this._free(T.skirt);
      for (const t of T.textures) gl.deleteTexture(t);
    }
    this.terrain = null;
  }

  /* ------------------------------------------------------------- SCENE -- */
  /**
   * scene = { selected, others, window: {E0,N0,E1,N1}|null, bufferM, controls, fit }
   *   selected  an evaluated alignment (study.js result) drawn in full
   *   others    further results, drawn as thin lines in their own colours
   *   window    the block to model; default the bounding box of selected AND
   *             others plus bufferM, so switching between options in a study
   *             keeps the same block (and camera) instead of rebuilding it
   *   controls  [{E,N,name}] markers to label; default the selected line's own
   *   fit       true re-frames the camera; default only when the block changes
   */
  setScene(scene) {
    // no WebGL (viewer.ok false): nothing to build; the overlay shows the error
    if (!this.gl || !this.G || !this.G.layer || !this.G.layer.dem) return;
    scene = scene || {};
    const G = this.G;
    const sel = scene.selected && scene.selected.P && scene.selected.P.length > 1 ? scene.selected : null;
    const others = (scene.others || []).filter(r => r && r.P && r.P.length > 1 && r !== sel &&
      !(sel && r.sc && sel.sc && r.sc.id === sel.sc.id && r.sc.name === sel.sc.name));
    let win = scene.window;
    if (!win) {
      const buf = scene.bufferM === undefined ? this.opts.bufferM : scene.bufferM;
      let e0 = Infinity, n0 = Infinity, e1 = -Infinity, n1 = -Infinity;
      const grow = (E, N) => { if (E < e0) e0 = E; if (E > e1) e1 = E; if (N < n0) n0 = N; if (N > n1) n1 = N; };
      for (const r of (sel ? [sel] : []).concat(others)) for (const p of r.P) grow(p.E, p.N);
      for (const c of scene.controls || []) grow(c.E, c.N);
      win = isFinite(e0) ? { E0: e0 - buf, N0: n0 - buf, E1: e1 + buf, N1: n1 + buf }
                         : { E0: G.xmin, N0: G.ymin, E1: G.xmax, N1: G.ymax };
    }
    /* Clip to the grid, and snap to whole cells so a window that differs by
       a few metres from the last one is recognised as the same block. */
    const ix0 = clamp(Math.floor((win.E0 - G.xmin) / G.cell), 0, G.nx - 2);
    const ix1 = clamp(Math.ceil((win.E1 - G.xmin) / G.cell), ix0 + 2, G.nx);
    const iy0 = clamp(Math.floor((G.ymax - win.N1) / G.cell), 0, G.ny - 2);
    const iy1 = clamp(Math.ceil((G.ymax - win.N0) / G.cell), iy0 + 2, G.ny);
    const key = [G.id, ix0, ix1, iy0, iy1, this.opts.maxVertices, this.opts.maxTexturePixels].join(',');
    this.scene = { sel, others, controls: scene.controls || null, args: scene };
    const t0 = performance.now();
    let rebuilt = false;
    if (!this.terrain || this.terrain.key !== key) {
      this._freeTerrain();
      this._buildTerrain(ix0, ix1, iy0, iy1, key);
      rebuilt = true;
    }
    const t1 = performance.now();
    this._buildAlignment();
    const t2 = performance.now();
    this.stats.terrainMs = rebuilt ? Math.round(t1 - t0) : 0;
    this.stats.alignmentMs = Math.round(t2 - t1);
    this.stats.reusedTerrain = !rebuilt;
    if (this.marker !== null && (!sel || this.marker >= sel.P.length)) this.marker = null;
    if (!this.cam || scene.fit === true || (rebuilt && scene.fit !== false)) this._fitView();
    this._camVer++;
    this.requestRender();
  }

  /* --------------------------------------------------------- TERRAIN ---- */
  _buildTerrain(ix0, ix1, iy0, iy1, key) {
    const G = this.G, gl = this.gl, dem = G.layer.dem, nx = G.nx, cell = G.cell;
    const wc = ix1 - ix0, hc = iy1 - iy0;
    /* Mesh spacing: k cells, k ≥ 1 and FRACTIONAL, chosen so the vertex count
       lands on the budget. An integer step was tried first and has a cliff:
       a window 8 % over budget dropped from step 1 to step 2 and lost three
       quarters of its vertices. Each vertex is the mean of the cells under its
       footprint (a summed-area table makes that O(1) per vertex) — means, not
       point samples, because a point-sampled 300 m mesh aliases ridgelines
       into saw teeth. */
    const k = Math.max(1, Math.sqrt(wc * hc / this.opts.maxVertices));
    const mx = Math.max(2, Math.floor(wc / k)), my = Math.max(2, Math.floor(hc / k));
    const W = Math.min(wc, Math.round(mx * k)), H = Math.min(hc, Math.round(my * k));   // cells covered
    const Ec = G.xmin + (ix0 + W / 2) * cell, Nc = G.ymax - (iy0 + H / 2) * cell;
    this.origin = { E: Ec, N: Nc };

    const SW = W + 1, SAT = new Float64Array(SW * (H + 1));
    for (let y = 0; y < H; y++) {
      let run = 0;
      const src = (iy0 + y) * nx + ix0, o = (y + 1) * SW, up = y * SW;
      for (let x = 0; x < W; x++) { run += dem[src + x]; SAT[o + x + 1] = SAT[up + x + 1] + run; }
    }
    const hm = new Float32Array(mx * my);
    let zlo = Infinity, zhi = -Infinity;
    for (let by = 0; by < my; by++) {
      const ya = Math.min(H - 1, Math.round(by * k)), yb = Math.max(ya + 1, Math.min(H, Math.round((by + 1) * k)));
      for (let bx = 0; bx < mx; bx++) {
        const xa = Math.min(W - 1, Math.round(bx * k)), xb = Math.max(xa + 1, Math.min(W, Math.round((bx + 1) * k)));
        const h = (SAT[yb * SW + xb] - SAT[ya * SW + xb] - SAT[yb * SW + xa] + SAT[ya * SW + xa]) /
                  ((xb - xa) * (yb - ya));
        hm[by * mx + bx] = h;
        if (h < zlo) zlo = h; if (h > zhi) zhi = h;
      }
    }
    const dxm = k * cell;
    const x0 = G.xmin + (ix0 + k / 2) * cell - Ec;      // first vertex column (scene x)
    const y0 = G.ymax - (iy0 + k / 2) * cell - Nc;      // first vertex row (scene y, north)
    const pos = new Float32Array(mx * my * 3);
    for (let by = 0, o = 0; by < my; by++)
      for (let bx = 0; bx < mx; bx++, o += 3) {
        pos[o] = x0 + bx * dxm; pos[o + 1] = y0 - by * dxm; pos[o + 2] = hm[by * mx + bx];
      }
    const idx = new Uint32Array((mx - 1) * (my - 1) * 6);
    for (let by = 0, o = 0; by < my - 1; by++)
      for (let bx = 0; bx < mx - 1; bx++) {
        const a = by * mx + bx, b = a + 1, c = a + mx, d = c + 1;
        idx[o++] = a; idx[o++] = c; idx[o++] = b; idx[o++] = b; idx[o++] = c; idx[o++] = d;
      }
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);

    const tTex = performance.now();
    const tex = this._buildTextures(ix0, iy0, W, H, Ec, Nc);
    const texMs = performance.now() - tTex;

    const relief = Math.max(1, zhi - zlo);
    const base = zlo - Math.max(25, 0.08 * relief);
    this.zRef = base;
    this.terrain = {
      key, vbo, ibo, n: idx.length, verts: mx * my, hm, mx, my, k, dxm, x0, y0,
      xW: G.xmin + ix0 * cell - Ec, xE: G.xmin + (ix0 + W) * cell - Ec,
      yN: G.ymax - iy0 * cell - Nc, yS: G.ymax - (iy0 + H) * cell - Nc,
      zlo, zhi, base, textures: tex.textures, tex,
    };
    this.terrain.skirt = this._buildSkirt();
    Object.assign(this.stats, {
      vertices: mx * my, triangles: idx.length / 3, meshStep: +k.toFixed(2), meshSpacing: Math.round(dxm),
      windowKm: [+(W * cell / 1000).toFixed(1), +(H * cell / 1000).toFixed(1)],
      texture: [tex.tw, tex.th], texel: tex.texel, textureMs: Math.round(texMs),
    });
  }

  /* Native-resolution drapes: hypsometric colour, the relief gradient, and
     the constraint coverages packed four to a texture so that toggling a layer
     is a uniform change, not a re-upload. */
  _buildTextures(ix0, iy0, W, H, Ec, Nc) {
    const G = this.G, dem = G.layer.dem, nx = G.nx, cell = G.cell;
    let kt = Math.max(1, Math.ceil(Math.sqrt(W * H / this.opts.maxTexturePixels)));
    while (Math.floor(W / kt) > this.maxTex || Math.floor(H / kt) > this.maxTex) kt++;
    const tw = Math.max(1, Math.floor(W / kt)), th = Math.max(1, Math.floor(H / kt));
    const n = tw * th, inv = 1 / (kt * kt);
    /* kt×kt block means of a grid into out[], row by row — no per-texel
       closure: this runs over a few million cells for every layer. */
    const blocks = (A, out) => {
      if (kt === 1) {
        for (let ty = 0; ty < th; ty++) {
          const src = (iy0 + ty) * nx + ix0, dst = ty * tw;
          for (let tx = 0; tx < tw; tx++) out[dst + tx] = A[src + tx];
        }
        return out;
      }
      out.fill(0);
      for (let ty = 0; ty < th; ty++)
        for (let yy = 0; yy < kt; yy++) {
          const src = (iy0 + ty * kt + yy) * nx + ix0, dst = ty * tw;
          for (let tx = 0; tx < tw; tx++) {
            let s = 0; const o = src + tx * kt;
            for (let xx = 0; xx < kt; xx++) s += A[o + xx];
            out[dst + tx] += s * inv;
          }
        }
      return out;
    };
    const h = blocks(dem, new Float32Array(n));

    // hypsometric colour, 90 % over white as the map lays it (a 2048-step LUT)
    const [VMIN, VMAX] = this.limits, span = Math.max(1e-6, VMAX - VMIN);
    const LUT = new Uint8Array(2048 * 3), rgb = [0, 0, 0];
    for (let j = 0; j < 2048; j++) {
      ramp(j / 2047, rgb);
      for (let ch = 0; ch < 3; ch++) LUT[j * 3 + ch] = Math.round(255 * (0.9 * rgb[ch] + 0.1));
    }
    const base = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      let j = Math.round((h[i] - VMIN) / span * 2047);
      j = j < 0 ? 0 : j > 2047 ? 2047 : j;
      base[i * 4] = LUT[j * 3]; base[i * 4 + 1] = LUT[j * 3 + 1]; base[i * 4 + 2] = LUT[j * 3 + 2];
      base[i * 4 + 3] = 255;
    }

    /* Gradient, central differences at the texel spacing, stored as the soft
       sign g/(|g|+g0). A linear 8-bit code cannot hold both the 0.1 % slopes
       of a river plain and the 40 % face of an escarpment; this one resolves
       small slopes finely and still saturates gracefully. g0 is the window's
       90th-percentile slope, so it adapts to the terrain it is describing. */
    const sp = kt * cell, gx = new Float32Array(n), gy = new Float32Array(n);
    for (let ty = 0; ty < th; ty++) {
      const tu = Math.max(0, ty - 1), td = Math.min(th - 1, ty + 1);
      for (let tx = 0; tx < tw; tx++) {
        const tl = Math.max(0, tx - 1), tr = Math.min(tw - 1, tx + 1);
        gx[ty * tw + tx] = (h[ty * tw + tr] - h[ty * tw + tl]) / ((tr - tl || 1) * sp);
        gy[ty * tw + tx] = (h[tu * tw + tx] - h[td * tw + tx]) / ((td - tu || 1) * sp);   // + = rising northward
      }
    }
    const step = Math.max(1, Math.floor(n / 60000)), mags = [];
    for (let i = 0; i < n; i += step) mags.push(Math.hypot(gx[i], gy[i]));
    mags.sort((a, b) => a - b);
    const g90 = Math.max(1e-5, mags[Math.floor(mags.length * 0.9)] || 1e-5);
    const g50 = Math.max(1e-5, mags[Math.floor(mags.length * 0.5)] || 1e-5);
    const g0 = g90;
    const grad = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const a = gx[i], b = gy[i];
      grad[i * 4] = Math.round(255 * (0.5 + 0.5 * a / (Math.abs(a) + g0)));
      grad[i * 4 + 1] = Math.round(255 * (0.5 + 0.5 * b / (Math.abs(b) + g0)));
      grad[i * 4 + 3] = 255;
    }

    const textures = [this._texture(tw, th, base, true), this._texture(tw, th, grad, true)];
    const keys = this.layerKeys, cov = new Float32Array(n);
    for (let t = 0; t * 4 < keys.length; t++) {
      const L = new Uint8Array(n * 4);
      for (let c = 0; c < 4 && t * 4 + c < keys.length; c++) {
        blocks(G.layer[keys[t * 4 + c]], cov);
        for (let i = 0; i < n; i++) {
          const v = cov[i];
          L[i * 4 + c] = v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0;
        }
      }
      textures.push(this._texture(tw, th, L, true));
    }
    return {
      textures, tw, th, texel: sp, g0, g50, g90,
      rect: [G.xmin + ix0 * cell - Ec, G.ymax - iy0 * cell - Nc, tw * sp, th * sp],
    };
  }

  /* The sides of the block, down to a base below the lowest ground. A cut
     edge shows the reader where the model stops and how deep a tunnel runs
     where it leaves the block — and stops the terrain reading as a floating
     sheet. */
  _buildSkirt() {
    const T = this.terrain, F = new FBuf(MESH_STRIDE, 4 * (T.mx + T.my) * 2), I = new IBuf(12 * (T.mx + T.my));
    const soil = [0.55, 0.47, 0.39];
    const edge = (pts, shade) => {
      const c = [soil[0] * shade, soil[1] * shade, soil[2] * shade, 1];
      let prev = null;
      for (const [x, y, h] of pts) {
        const a = meshVert(F, x, y, h, NO_LIFT, 0, c), b = meshVert(F, x, y, T.base, NO_LIFT, 0, c);
        if (prev) quad(I, prev[0], prev[1], b, a);
        prev = [a, b];
      }
    };
    const v = (bx, by) => [T.x0 + bx * T.dxm, T.y0 - by * T.dxm, T.hm[by * T.mx + bx]];
    const N = [], S = [], Wd = [], Ed = [];
    for (let bx = 0; bx < T.mx; bx++) { N.push(v(bx, 0)); S.push(v(bx, T.my - 1)); }
    for (let by = 0; by < T.my; by++) { Wd.push(v(0, by)); Ed.push(v(T.mx - 1, by)); }
    edge(S, 0.92); edge(Ed, 0.78); edge(N, 0.62); edge(Wd, 0.7);
    return this._upload(F, I);
  }

  /** Mesh height (raw metres) at scene x, y — bilinear on the block means. */
  _hRaw(x, y) {
    const T = this.terrain;
    const fx = clamp((x - T.x0) / T.dxm, 0, T.mx - 1.0001), fy = clamp((T.y0 - y) / T.dxm, 0, T.my - 1.0001);
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    const i = iy * T.mx + ix, A = T.hm;
    return (A[i] * (1 - tx) + A[i + 1] * tx) * (1 - ty) + (A[i + T.mx] * (1 - tx) + A[i + T.mx + 1] * tx) * ty;
  }

  /** DEM height at projected E, N — bilinear at the grid's own cell. */
  _demAt(E, N) {
    const G = this.G, A = G.layer.dem;
    const fx = clamp((E - G.xmin) / G.cell - 0.5, 0, G.nx - 1.0001);
    const fy = clamp((G.ymax - N) / G.cell - 0.5, 0, G.ny - 1.0001);
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy, i = iy * G.nx + ix;
    return (A[i] * (1 - tx) + A[i + 1] * tx) * (1 - ty) + (A[i + G.nx] * (1 - tx) + A[i + G.nx + 1] * tx) * ty;
  }

  /** The ground a point must surface to (raw m, scene x/y): the higher of the
      DEM and the mesh, because either one can be the surface that hides it. */
  _surf(x, y) {
    return Math.max(this._demAt(x + this.origin.E, y + this.origin.N), this._hRaw(x, y)) + 0.5;
  }

  /* ------------------------------------------------------- ALIGNMENT ---- */
  _buildAlignment() {
    this._freeItems();
    const sc = this.scene, r = sc.sel, Ec = this.origin.E, Nc = this.origin.N;
    let zTop = this.terrain.zhi;

    /* The alternatives first: thin, in their own option colours, at their own
       design levels — so a reader can see one option tunnelling where another
       climbs, not only that they part company in plan. */
    if (sc.others.length) {
      let tot = 0; for (const o of sc.others) tot += o.P.length;
      const F = new FBuf(LINE_STRIDE, 2 * tot), I = new IBuf(6 * tot);
      for (const o of sc.others) {
        const n = o.P.length, X = new Float64Array(n), Y = new Float64Array(n), H = new Float64Array(n);
        const z = o.vp && o.vp.z;
        for (let i = 0; i < n; i++) {
          X[i] = o.P[i].E - Ec; Y[i] = o.P[i].N - Nc;
          H[i] = z ? z[i] : this._demAt(o.P[i].E, o.P[i].N);
          if (H[i] > zTop) zTop = H[i];
        }
        const c = rgba01(parseColour(o.colour, [120, 128, 140]), 0.9), ost = o.structs || [];
        addPolyline(F, I, n, X, Y, H, null, () => c, () => 0,
                    i => ost[i] && ost[i].id === 'tunnel' ? NO_LIFT : this._surf(X[i], Y[i]));
      }
      this.items.others = this._upload(F, I);
    }

    if (r) {
      const P = r.P, n = P.length, z = r.vp.z, g = r.vp.ground || new Float64Array(n);
      const st = r.structs || [];
      const sid = i => (st[i] && st[i].id) || 'atgrade';
      const colCache = {};
      const scol = i => {
        const s = st[i], id = sid(i);
        return colCache[id] || (colCache[id] = rgba01(parseColour(s && s.colour, null) ||
                                                      parseColour(STRUCT_FALLBACK[id], [110, 120, 110]), 1));
      };
      const X = new Float64Array(n), Y = new Float64Array(n), S = new Float64Array(n);
      const NX = new Float64Array(n), NY = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        X[i] = P[i].E - Ec; Y[i] = P[i].N - Nc; S[i] = P[i].s;
        if (z[i] > zTop) zTop = z[i];
      }
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
        const tx = X[b] - X[a], ty = Y[b] - Y[a], l = Math.hypot(tx, ty) || 1;
        NX[i] = -ty / l; NY[i] = tx / l;                 // left of the direction of travel
      }
      const ds = r.vp.ds || (n > 1 ? (S[n - 1] - S[0]) / (n - 1) : 25);
      const W = (r.std && r.std.width) || 12;
      const hw = W / 2 * this.opts.ribbonWidth;
      /* What each sample surfaces to: the highest ground across its whole
         earthwork section (out to where a 1V:mH slope from the deck edge would
         daylight), not just the ground on the centre line — the view ray to the
         floor of a cutting climbs over the cutting's upper edge. Tunnels never. */
      const m = (r.std && r.std.sideSlope) || 2, TOP = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        if (sid(i) === 'tunnel') { TOP[i] = NO_LIFT; continue; }
        const reach = hw + m * Math.max(0, g[i] - z[i]);
        TOP[i] = Math.max(this._surf(X[i], Y[i]),
                          this._surf(X[i] + NX[i] * reach, Y[i] + NY[i] * reach),
                          this._surf(X[i] - NX[i] * reach, Y[i] - NY[i] * reach));
      }
      const top = i => TOP[i];
      this._geom = { X, Y, S, NX, NY, z, g, n, ds, sid, TOP };

      // centre line: what carries the alignment when the deck is sub-pixel
      {
        const F = new FBuf(LINE_STRIDE, 2 * n), I = new IBuf(6 * n);
        addPolyline(F, I, n, X, Y, z, S, scol, () => 0, top);
        this.items.centre = this._upload(F, I);
      }
      // the deck itself, level at formation, at its (exaggerated) width
      {
        const F = new FBuf(MESH_STRIDE, 2 * n), I = new IBuf(6 * n);
        for (let i = 0; i < n; i++) {
          const c = scol(i);
          const lx = X[i] + NX[i] * hw, ly = Y[i] + NY[i] * hw, rx = X[i] - NX[i] * hw, ry = Y[i] - NY[i] * hw;
          meshVert(F, lx, ly, z[i], TOP[i], S[i], c);
          meshVert(F, rx, ry, z[i], TOP[i], S[i], c);
          if (i) quad(I, 2 * i - 2, 2 * i - 1, 2 * i + 1, 2 * i);
        }
        this.items.ribbon = this._upload(F, I);
      }
      /* Viaduct and bridge fascia: the deck's edge beam, a few metres deep.
         Without it a deck seen side-on is a line, and the eye cannot tell a
         viaduct from an embankment top at the same level. */
      {
        const F = new FBuf(MESH_STRIDE, 8 * n), I = new IBuf(12 * n), depth = 2.8;
        for (let i = 0; i < n - 1; i++) {
          if (!ELEVATED[sid(i)] || !ELEVATED[sid(i + 1)]) continue;
          const c0 = scol(i), c = [c0[0] * 0.62, c0[1] * 0.62, c0[2] * 0.62, 1];
          for (const sd of [1, -1]) {
            const ax = X[i] + NX[i] * hw * sd, ay = Y[i] + NY[i] * hw * sd;
            const bx = X[i + 1] + NX[i + 1] * hw * sd, by = Y[i + 1] + NY[i + 1] * hw * sd;
            const ta = TOP[i], tb = TOP[i + 1];
            const a = meshVert(F, ax, ay, z[i], ta, S[i], c), b = meshVert(F, bx, by, z[i + 1], tb, S[i + 1], c);
            const cc = meshVert(F, bx, by, z[i + 1] - depth, tb, S[i + 1], c);
            const d = meshVert(F, ax, ay, z[i] - depth, ta, S[i], c);
            quad(I, a, b, cc, d);
          }
        }
        this.items.fascia = this._upload(F, I);
      }
      /* Piers every ~50 m along elevated runs, from deck to ground — the forest
         of piers is what makes a 40 m viaduct read as 40 m. Abutment samples
         (first and last of a run) carry none. */
      if (this.opts.piers) {
        const every = Math.max(1, Math.round(50 / ds)), F = new FBuf(LINE_STRIDE, 512), I = new IBuf(1024);
        const pc = [0.47, 0.51, 0.56, 1], pw = Math.max(1.2, W * 0.12);
        const PX = [0, 0], PY = [0, 0], PH = [0, 0];
        for (const run of r.runs || []) {
          const id = run.type && run.type.id;
          if (!ELEVATED[id]) continue;
          for (let i = run.i0 + 1; i < run.i1; i += every) {
            if (z[i] - g[i] < 1.5) continue;
            PX[0] = PX[1] = X[i]; PY[0] = PY[1] = Y[i]; PH[0] = g[i] - 1; PH[1] = z[i] - 2.8;
            const foot = TOP[i];
            addPolyline(F, I, 2, PX, PY, PH, null, () => pc, () => pw, j => j ? NO_LIFT : foot);
          }
        }
        this.items.piers = this._upload(F, I);
      }
      if (this.opts.slopes) this.items.slopes = this._buildSlopes(r, hw);
      /* Cover curtain: a translucent wall from the tunnel up to the ground
         surface, drawn only when the terrain is see-through. Without it an
         x-rayed tunnel reads as a line ON the ground; with it the cover — 8 m
         under a creek or 300 m under a ridge — is visible at a glance. */
      {
        const F = new FBuf(MESH_STRIDE, 512), I = new IBuf(1024);
        for (const run of r.runs || []) {
          if (!run.type || run.type.id !== 'tunnel') continue;
          const c0 = scol(run.i0), c = [c0[0], c0[1], c0[2], 0.3];
          let prev = -1;
          for (let i = run.i0; i <= run.i1; i++) {
            const a = meshVert(F, X[i], Y[i], z[i], NO_LIFT, S[i], c);
            const b = meshVert(F, X[i], Y[i], Math.max(g[i], z[i]), NO_LIFT, S[i], c);
            if (prev >= 0) quad(I, prev, prev + 1, b, a);
            prev = a;
          }
        }
        this.items.curtain = this._upload(F, I);
      }
    }
    this.zTop = zTop;
  }

  /* Earthwork side slopes, from the deck edge out at the standard's 1V:mH
     until they meet the ground. A hint, not a takeoff: they start at the
     drawn (exaggerated) deck edge so the two meet on screen, and the ground
     they daylight onto is the DEM, not the coarser mesh. Embankments stand up
     out of the block; cuttings run down into it and are surfaced in depth (see
     DEPTH_GLSL), so they read as an open trench without carving the mesh. */
  _buildSlopes(r, hw) {
    const { X, Y, NX, NY, z, n, sid, S, TOP } = this._geom;
    const m = (r.std && r.std.sideSlope) || 2, Ec = this.origin.E, Nc = this.origin.N;
    const kind = i => sid(i) === 'embankment' ? 1 : sid(i) === 'cutting' ? -1 : 0;
    const step = clamp(this.G.cell / 4, 2, 10), maxRun = m * 60;
    const dayT = [new Float32Array(n), new Float32Array(n)], dayH = [new Float32Array(n), new Float32Array(n)];
    for (let i = 0; i < n; i++) {
      const k = kind(i); if (!k) continue;
      for (let sdI = 0; sdI < 2; sdI++) {
        const sd = sdI ? -1 : 1, nx = NX[i] * sd, ny = NY[i] * sd;
        const E0 = X[i] + Ec, N0 = Y[i] + Nc;
        // signed height of the slope surface above ground: + while still out of the ground
        const f = t => k * ((z[i] - k * (t - hw) / m) - this._demAt(E0 + nx * t, N0 + ny * t));
        let t = hw, prev = f(t);
        if (prev <= 0) { dayT[sdI][i] = hw; dayH[sdI][i] = z[i]; continue; }
        let tt = hw, found = false;
        while (tt < hw + maxRun) {
          const t2 = tt + step, v = f(t2);
          if (v <= 0) { t = tt + step * prev / (prev - v); found = true; break; }
          tt = t2; prev = v;
        }
        if (!found) t = hw + maxRun;
        dayT[sdI][i] = t;
        dayH[sdI][i] = z[i] - k * (t - hw) / m;
      }
    }
    // static NW light: slopes are small and the hint only needs to read as a face
    const L = [-0.5, 0.5, 0.7071];
    const F = new FBuf(MESH_STRIDE, 8 * n), I = new IBuf(12 * n);
    for (let i = 0; i < n - 1; i++) {
      const k = kind(i);
      if (!k || kind(i + 1) !== k) continue;
      for (let sdI = 0; sdI < 2; sdI++) {
        const sd = sdI ? -1 : 1, nx = NX[i] * sd, ny = NY[i] * sd;
        // face normal: a fill face leans outward, a cut face leans back towards the line
        const fn = [k * nx, k * ny, m], fl = Math.hypot(fn[0], fn[1], fn[2]);
        const lam = clamp((fn[0] * L[0] + fn[1] * L[1] + fn[2] * L[2]) / fl, 0, 1);
        const b = k > 0 ? [0.74, 0.68, 0.50] : [0.70, 0.52, 0.36], sh = 0.62 + 0.45 * lam;
        const c = [b[0] * sh, b[1] * sh, b[2] * sh, 1];
        const e = (j, t, h) => meshVert(F, X[j] + NX[j] * sd * t, Y[j] + NY[j] * sd * t, h, TOP[j], S[j], c);
        const a = e(i, hw, z[i]), bb = e(i + 1, hw, z[i + 1]);
        const cc = e(i + 1, dayT[sdI][i + 1], dayH[sdI][i + 1]), d = e(i, dayT[sdI][i], dayH[sdI][i]);
        quad(I, a, bb, cc, d);
      }
    }
    return this._upload(F, I);
  }

  /* ------------------------------------------------------------ CAMERA -- */
  /* Frame the block. The default heading looks ACROSS the line (perpendicular
     to its principal axis, northward where there is a choice) because a
     corridor seen end-on is foreshortened into nothing; a loop or a compact
     scheme simply looks north, as the plan does. */
  _fitView() {
    const T = this.terrain, sel = this.scene && this.scene.sel;
    let heading = 0;
    if (sel && sel.P.length > 2) {
      const P = sel.P, stp = Math.max(1, Math.floor(P.length / 3000));
      let mx = 0, my = 0, c = 0;
      for (let i = 0; i < P.length; i += stp) { mx += P[i].E; my += P[i].N; c++; }
      mx /= c; my /= c;
      let sxx = 0, syy = 0, sxy = 0;
      for (let i = 0; i < P.length; i += stp) {
        const dx = P[i].E - mx, dy = P[i].N - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
      }
      const tr = sxx + syy, det = sxx * syy - sxy * sxy;
      const l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det)), l2 = tr - l1;
      if (l1 > 2.5 * Math.max(l2, 1e-9)) {
        const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);  // major axis, from east
        let fx = -Math.sin(th), fy = Math.cos(th);          // perpendicular to it
        if (fy < -1e-3 || (Math.abs(fy) <= 1e-3 && fx < 0)) { fx = -fx; fy = -fy; }
        heading = Math.atan2(fx, fy);
      }
    }
    let hs = 0; for (let i = 0; i < T.hm.length; i += 7) hs += T.hm[i];
    const hMean = hs / Math.ceil(T.hm.length / 7);
    this.cam = { tx: (T.xW + T.xE) / 2, ty: (T.yN + T.yS) / 2, th: hMean,
                 heading, pitch: 36 * deg, dist: 1 };
    this.cam.dist = this._fitDistance();
    this._home = Object.assign({}, this.cam);
    this._touched = false;
    this._camVer++;
  }
  /* Fit by projection, not by formula. A closed-form fit was tried first and
     cropped London's southern arc: in perspective the near edge of a block
     viewed at 36° is far larger on screen than the far edge, which no
     symmetric formula sees. So the eight corners of the block are projected
     and the distance scaled until they fill ~90 % of the frame, while the
     target slides along the view so the block sits centred, not low. Mutates
     this.cam (tx, ty, dist) and returns the distance. */
  _fitDistance() {
    const T = this.terrain, c = this.cam, VE = this.opts.ve, zr = this.zRef;
    const zt = (Math.max(this.zTop || T.zhi, T.zhi) - zr) * VE;
    const ty = Math.tan(this.opts.fov * deg / 2), asp = this._aspect();
    const span = Math.max(T.xE - T.xW, T.yN - T.yS);
    c.dist = Math.max(200, span / ty);
    for (let it = 0; it < 12; it++) {
      const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch), ch = Math.cos(c.heading), sh = Math.sin(c.heading);
      const tz = (c.th - zr) * VE;
      const eye = [c.tx - sh * cp * c.dist, c.ty - ch * cp * c.dist, tz + sp * c.dist];
      const f = [sh * cp, ch * cp, -sp], r = [ch, -sh, 0];
      const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const x of [T.xW, T.xE]) for (const y of [T.yS, T.yN]) for (const z of [0, zt]) {
        const d = [x - eye[0], y - eye[1], z - eye[2]];
        const w = Math.max(1, d[0] * f[0] + d[1] * f[1] + d[2] * f[2]);
        const nx = (d[0] * r[0] + d[1] * r[1] + d[2] * r[2]) / (w * ty * asp);
        const ny = (d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / (w * ty);
        if (nx < x0) x0 = nx; if (nx > x1) x1 = nx; if (ny < y0) y0 = ny; if (ny > y1) y1 = ny;
      }
      // centre: slide the target forward/back for vertical, sideways for horizontal
      const cy = (y0 + y1) / 2, cx = (x0 + x1) / 2;
      const fwd = cy * c.dist * ty / Math.max(0.3, sp), side = cx * c.dist * ty * asp;
      c.tx += sh * fwd + ch * side; c.ty += ch * fwd - sh * side;
      const k = Math.max((x1 - x0) / 1.8, (y1 - y0) / 1.8);
      c.dist = Math.max(200, c.dist * (0.35 + 0.65 * k));
      if (Math.abs(k - 1) < 0.01 && Math.abs(cy) < 0.01 && Math.abs(cx) < 0.01) break;
    }
    return c.dist;
  }
  _aspect() { return (this.cv.width || 1) / (this.cv.height || 1); }
  _clampCam() {
    const c = this.cam, T = this.terrain;
    const diag = Math.hypot(T.xE - T.xW, T.yN - T.yS);
    c.pitch = clamp(c.pitch, 3 * deg, 89.5 * deg);
    c.dist = clamp(c.dist, 40, diag * 4);
    const pad = diag * 0.5;
    c.tx = clamp(c.tx, T.xW - pad, T.xE + pad);
    c.ty = clamp(c.ty, T.yS - pad, T.yN + pad);
    this._camVer++;
  }

  /** Camera basis, matrices and clip planes for the current state. */
  _frame() {
    const c = this.cam, T = this.terrain, VE = this.opts.ve, zr = this.zRef;
    const tz = (c.th - zr) * VE;
    const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch), ch = Math.cos(c.heading), sh = Math.sin(c.heading);
    const f = [sh * cp, ch * cp, -sp], r = [ch, -sh, 0];
    const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    const eye = [c.tx - f[0] * c.dist, c.ty - f[1] * c.dist, tz - f[2] * c.dist];
    /* Clip planes from the scene, every frame. The near plane scales with the
       orbit distance (a 1 km close-up and a 450 km overview each get ~2e5:1);
       the far plane is the farthest corner of the block. What depth precision
       is still short of is made up by the distance-scaled pull in the shaders. */
    const zt = (Math.max(this.zTop || T.zhi, T.zhi) - zr) * VE;
    let far = 0;
    for (const x of [T.xW, T.xE]) for (const y of [T.yS, T.yN]) for (const z of [0, zt])
      far = Math.max(far, Math.hypot(x - eye[0], y - eye[1], z - eye[2]));
    far = Math.max(far * 1.05, c.dist * 2);
    const near = Math.max(0.5, c.dist * 0.004);
    const fovy = this.opts.fov * deg, asp = this._aspect();
    const V = lookAt(eye, [c.tx, c.ty, tz], [0, 0, 1]);
    const Pm = perspective(fovy, asp, near, far);
    const VP = mul4(Pm, V);
    this._fr = { eye, f, r, u, VP, near, far, tanY: Math.tan(fovy / 2), asp, tz,
                 W: this.cv.width, H: this.cv.height, cssW: this.cssW, cssH: this.cssH };
    return this._fr;
  }

  /* ------------------------------------------------------------ RENDER -- */
  requestRender() {
    if (!this.gl || this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }

  render() {
    const gl = this.gl;
    if (!gl || this._lost) { this._drawOverlay(); return; }
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    const W = this.cv.width, H = this.cv.height;
    gl.viewport(0, 0, W, H);
    const bg = parseColour(this.opts.background, [223, 230, 238]);
    gl.clearColor(bg[0] / 255, bg[1] / 255, bg[2] / 255, 1);
    gl.depthMask(true); gl.colorMask(true, true, true, true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.terrain || !this.cam || !this.progTerrain) { this._drawOverlay(); return; }
    const fr = this._frame(), o = this.opts, dpr = this.dpr || 1;
    const hz = [bg[0] / 255, bg[1] / 255, bg[2] / 255];
    /* Haze from beyond the orbit target, so the far side of a 400 km block
       recedes and the near side stays crisp: depth read from contrast. */
    const fog = [this.cam.dist * 1.1, Math.max(this.cam.dist * 1.1 + 1, fr.far), 0.45];
    const depthK = 6 / (fr.near * Math.pow(2, this.depthBits));
    const pxK = 2 * fr.tanY / H;
    const common = { uVP: new Float32Array(fr.VP), uEye: fr.eye, uVE: o.ve, uZRef: this.zRef,
                     uHaze: hz, uFog: fog, uDepthK: depthK, uPxK: pxK, uViewport: [W, H] };
    const alpha = o.xray ? Math.min(o.terrainAlpha, 0.45) : o.terrainAlpha;
    const translucent = alpha < 0.999;
    const T = this.terrain;
    const clipAll = [-1e9, -1e9, 1e9, 1e9];
    const clipBlock = [T.xW - 1, T.yS - 1, T.xE + 1, T.yN + 1];

    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.BLEND);

    if (!translucent) { this._drawTerrain(common, 1); this._drawMesh(T.skirt, common, { pull: 0, clip: clipAll }); }

    // the selected line and its structures, opaque
    const I = this.items;
    this._drawMesh(I.slopes, common, { pull: 0.003, clip: clipAll });
    this._drawMesh(I.fascia, common, { pull: 0.0055, clip: clipAll });
    this._drawLines(I.piers, common, { pull: 0.003, minPx: 0.6 * dpr, clip: clipAll });
    gl.enable(gl.BLEND);
    // white casing under the centre line: structure colours on hypsometric
    // relief need their own separation from it, as on the 2-D map
    this._drawLines(I.centre, common, { pull: 0.0045, minPx: (o.ribbonMinPx + 1.3) * dpr,
                                        tint: [1, 1, 1, 1], alpha: 0.9, clip: clipAll });
    this._drawLines(I.centre, common, { pull: 0.005, minPx: o.ribbonMinPx * dpr, clip: clipAll });
    this._drawMesh(I.ribbon, common, { pull: 0.006, clip: clipAll });
    this._drawLines(I.others, common, { pull: 0.004, minPx: 1.0 * dpr, alpha: 0.85, clip: clipBlock });

    if (translucent) {
      gl.depthMask(false);
      this._drawMesh(I.curtain, common, { pull: 0, clip: clipAll });
      gl.depthMask(true);
      /* Depth pre-pass, then colour where the terrain is the nearest surface:
         one blend per pixel, so the block's own folds never stack up into a
         darker smear, and what is behind or under it shows through evenly. */
      gl.disable(gl.BLEND);
      gl.colorMask(false, false, false, false);
      this._drawTerrain(common, 1);
      this._drawMesh(T.skirt, common, { pull: 0, clip: clipAll });
      gl.colorMask(true, true, true, true);
      gl.enable(gl.BLEND); gl.depthMask(false);
      this._drawTerrain(common, alpha);
      this._drawMesh(T.skirt, common, { pull: 0, clip: clipAll, alpha });
      gl.depthMask(true);
    } else if (o.hidden && I.centre) {
      /* Hidden line: what the ground covers (tunnels, and the line behind a
         ridge) drawn again, dashed, where the depth test says it lost.
         Pulled a touch further than the deck, so it never dashes over the
         visible deck itself. */
      gl.enable(gl.BLEND); gl.depthMask(false); gl.depthFunc(gl.GREATER);
      const dash = Math.max(20, this.cam.dist / 90);
      this._drawLines(I.centre, common, { pull: 0.0062, minPx: Math.max(1.1, o.ribbonMinPx * 0.8) * dpr,
                                          alpha: 0.75, dash, clip: clipAll });
      gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
    }
    gl.disable(gl.BLEND);
    this.stats.frames = (this.stats.frames || 0) + 1;
    this._drawOverlay();
  }

  _setCommon(prog, common) {
    const gl = this.gl, u = prog.u;
    gl.useProgram(prog.p);
    if (u.uVP) gl.uniformMatrix4fv(u.uVP, false, common.uVP);
    if (u.uEye) gl.uniform3fv(u.uEye, common.uEye);
    if (u.uVE) gl.uniform1f(u.uVE, common.uVE);
    if (u.uZRef) gl.uniform1f(u.uZRef, common.uZRef);
    if (u.uHaze) gl.uniform3fv(u.uHaze, common.uHaze);
    if (u.uFog) gl.uniform3fv(u.uFog, common.uFog);
    if (u.uDepthK) gl.uniform1f(u.uDepthK, common.uDepthK);
    if (u.uPxK) gl.uniform1f(u.uPxK, common.uPxK);
    if (u.uViewport) gl.uniform2fv(u.uViewport, common.uViewport);
  }

  _drawTerrain(common, alpha) {
    const gl = this.gl, T = this.terrain, P = this.progTerrain, u = P.u, o = this.opts;
    this._setCommon(P, common);
    gl.uniform4fv(u.uTexRect, T.tex.rect);
    /* Shading steepness: the larger of the geometric VE and whatever tilts
       the window's MEDIAN slope by ~6° — the median, because the 90th
       percentile is set by whatever escarpment the window holds and says
       nothing about the plain either side of it. Capped at 40: beyond that a
       DSM's tree and roof noise starts to read as relief. The shader
       saturates steep faces, so a large factor cannot burn them out. */
    const kShade = Math.max(o.ve, Math.min(40, 0.1 / T.tex.g50)) * o.shade;
    gl.uniform1f(u.uShadeK, kShade);
    gl.uniform1f(u.uG0, T.tex.g0);
    gl.uniform1f(u.uContrast, 1.15);
    gl.uniform1f(u.uAlpha, alpha);
    /* Light from ahead-left of the viewer, 45° up: a map's north-west light
       as seen from the south, wherever the camera has been turned. */
    const az = this.cam.heading - 50 * deg, alt = 45 * deg;
    gl.uniform3fv(u.uLight, [Math.sin(az) * Math.cos(alt), Math.cos(az) * Math.cos(alt), Math.sin(alt)]);
    const lc = new Float32Array(Math.max(1, this.layerKeys.length) * 4);
    this.layerKeys.forEach((k, j) => {
      const s = this.layerStyle[k] || {}, rgb = s.rgb || [128, 128, 128];
      lc[j * 4] = rgb[0] / 255; lc[j * 4 + 1] = rgb[1] / 255; lc[j * 4 + 2] = rgb[2] / 255;
      lc[j * 4 + 3] = this.layerOn[k] ? (s.alpha === undefined ? 0.5 : s.alpha) : 0;
    });
    if (u.uLc) gl.uniform4fv(u.uLc, lc);
    T.textures.forEach((t, i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, t);
      const name = i === 0 ? 'uBase' : i === 1 ? 'uGrad' : 'uL' + (i - 2);
      if (u[name]) gl.uniform1i(u[name], i);
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, T.vbo);
    this._attribs(P, [['aPos', 3, 0]], 3);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, T.ibo);
    gl.drawElements(gl.TRIANGLES, T.n, gl.UNSIGNED_INT, 0);
  }

  _flatUniforms(prog, s) {
    const gl = this.gl, u = prog.u;
    gl.uniform1f(u.uPull, s.pull || 0);
    gl.uniform1f(u.uAlpha, s.alpha === undefined ? 1 : s.alpha);
    gl.uniform1f(u.uDash, s.dash || 0);
    gl.uniform4fv(u.uTint, s.tint || [0, 0, 0, 0]);
    gl.uniform4fv(u.uClip, s.clip);
    if (u.uMinPx) gl.uniform1f(u.uMinPx, s.minPx || 1);
  }

  _drawMesh(item, common, s) {
    if (!item) return;
    const gl = this.gl, P = this.progMesh;
    this._setCommon(P, common); this._flatUniforms(P, s);
    gl.bindBuffer(gl.ARRAY_BUFFER, item.vbo);
    this._attribs(P, [['aPos', 3, 0], ['aTop', 1, 3], ['aS', 1, 4], ['aCol', 4, 5]], MESH_STRIDE);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, item.ibo);
    gl.drawElements(gl.TRIANGLES, item.n, gl.UNSIGNED_INT, 0);
  }

  _drawLines(item, common, s) {
    if (!item) return;
    const gl = this.gl, P = this.progLine;
    this._setCommon(P, common); this._flatUniforms(P, s);
    gl.bindBuffer(gl.ARRAY_BUFFER, item.vbo);
    this._attribs(P, [['aPos', 3, 0], ['aPrev', 3, 3], ['aNext', 3, 6], ['aSW', 2, 9],
                      ['aS', 1, 11], ['aTop', 1, 12], ['aCol', 4, 13]], LINE_STRIDE);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, item.ibo);
    gl.drawElements(gl.TRIANGLES, item.n, gl.UNSIGNED_INT, 0);
  }

  /* ---------------------------------------------------- PROJECT / PICK -- */
  /** Scene point (x, y, raw h) → CSS px {x, y, w}; w ≤ 0 means behind the eye. */
  _project(x, y, h) {
    const fr = this._fr, M = fr.VP, z = (h - this.zRef) * this.opts.ve;
    const cx = M[0] * x + M[4] * y + M[8] * z + M[12];
    const cy = M[1] * x + M[5] * y + M[9] * z + M[13];
    const cw = M[3] * x + M[7] * y + M[11] * z + M[15];
    if (cw <= 1e-6) return { x: 0, y: 0, w: cw };
    return { x: (cx / cw + 1) / 2 * this.cssW, y: (1 - cy / cw) / 2 * this.cssH, w: cw };
  }

  /** Ray through a CSS-px point: origin = eye, unit direction (scaled space). */
  _ray(sx, sy) {
    const fr = this._fr || this._frame();
    const nx = (sx / this.cssW) * 2 - 1, ny = 1 - (sy / this.cssH) * 2;
    const a = nx * fr.tanY * fr.asp, b = ny * fr.tanY;
    const d = [fr.f[0] + fr.r[0] * a + fr.u[0] * b, fr.f[1] + fr.r[1] * a + fr.u[1] * b,
               fr.f[2] + fr.r[2] * a + fr.u[2] * b];
    const l = Math.hypot(d[0], d[1], d[2]);
    return { o: fr.eye, d: [d[0] / l, d[1] / l, d[2] / l] };
  }

  /* March a ray over the mesh heightfield. Steps grow with distance (a 450 km
     view does not need 25 m steps 300 km out), and a crossing is refined by
     bisection. Returns the distance to the first hit, or −1. */
  _march(o, d, tmax) {
    const T = this.terrain, VE = this.opts.ve, zr = this.zRef;
    const zt = (Math.max(this.zTop || T.zhi, T.zhi) - zr) * VE + 1;
    // slab test against the block
    let t0 = 0, t1 = tmax === undefined ? Infinity : tmax;
    const lo = [T.xW, T.yS, -1], hi = [T.xE, T.yN, zt];
    for (let a = 0; a < 3; a++) {
      if (Math.abs(d[a]) < 1e-12) { if (o[a] < lo[a] || o[a] > hi[a]) return -1; continue; }
      let ta = (lo[a] - o[a]) / d[a], tb = (hi[a] - o[a]) / d[a];
      if (ta > tb) { const q = ta; ta = tb; tb = q; }
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) return -1;
    }
    const above = t => o[2] + d[2] * t - (this._hRaw(o[0] + d[0] * t, o[1] + d[1] * t) - zr) * VE;
    let t = t0, prev = above(t);
    if (prev < 0) return t;
    const base = T.dxm * 0.5;
    while (t < t1) {
      const tn = Math.min(t1, t + Math.max(base, t * 0.002));
      const v = above(tn);
      if (v < 0) {
        let a = t, b = tn;
        for (let it = 0; it < 22; it++) { const m = (a + b) / 2; if (above(m) < 0) b = m; else a = m; }
        return (a + b) / 2;
      }
      t = tn; prev = v;
    }
    return -1;
  }

  /** Ground point under a CSS-px point: {x, y, h} (scene metres, raw h) or null. */
  groundAt(sx, sy) {
    if (!this.terrain || !this.cam) return null;
    this._frame();                 // the camera may have moved since the last frame was drawn
    const { o, d } = this._ray(sx, sy);
    let t = this._march(o, d);
    if (t < 0) {
      // off the block: the horizontal plane through the orbit target
      const tz = (this.cam.th - this.zRef) * this.opts.ve;
      if (Math.abs(d[2]) < 1e-9) return null;
      t = (tz - o[2]) / d[2];
      if (t <= 0) return null;
    }
    const x = o[0] + d[0] * t, y = o[1] + d[1] * t, z = o[2] + d[2] * t;
    return { x, y, h: z / this.opts.ve + this.zRef, t };
  }

  /** Nearest sample of the selected line to a CSS-px point: {i, s, E, N, z, ground, d} or null. */
  pickAt(sx, sy, tolPx) {
    const sel = this.scene && this.scene.sel;
    if (!sel || !this.terrain || !this.cam) return null;
    this._frame();
    const tol = tolPx || 10, Ec = this.origin.E, Nc = this.origin.N, z = sel.vp.z;
    let best = -1, bd = tol * tol;
    for (let i = 0; i < sel.P.length; i++) {
      const p = this._project(sel.P[i].E - Ec, sel.P[i].N - Nc, z[i]);
      if (p.w <= 0) continue;
      const dd = (p.x - sx) * (p.x - sx) + (p.y - sy) * (p.y - sy);
      if (dd < bd) { bd = dd; best = i; }
    }
    if (best < 0) return null;
    const P = sel.P[best];
    return { i: best, s: P.s, E: P.E, N: P.N, z: z[best],
             ground: sel.vp.ground ? sel.vp.ground[best] : null,
             struct: sel.structs && sel.structs[best] ? sel.structs[best].id : null, d: Math.sqrt(bd) };
  }

  /* ------------------------------------------------------------ OVERLAY - */
  _drawOverlay() {
    const c = this.octx; if (!c) return;
    const W = this.cssW || this.cv.clientWidth || this.cv.width, H = this.cssH || this.cv.clientHeight || this.cv.height;
    const dpr = this.dpr || 1;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    if (this.error) {
      c.fillStyle = 'rgba(255,255,255,.92)'; c.fillRect(0, 0, W, H);
      c.fillStyle = '#c62828'; c.font = '600 13px system-ui,sans-serif';
      this._wrap(c, '3-D view unavailable', 20, 32, W - 40, 18);
      c.fillStyle = '#374151'; c.font = '12px system-ui,sans-serif';
      this._wrap(c, this.error, 20, 54, W - 40, 17);
      return;
    }
    if (!this.terrain || !this._fr) {
      c.fillStyle = '#6b7280'; c.font = '12px system-ui,sans-serif';
      c.fillText(this.G ? 'No scene yet' : 'No project loaded', 16, 24);
      return;
    }
    const o = this.opts, sel = this.scene && this.scene.sel, Ec = this.origin.E, Nc = this.origin.N;
    const boxes = [];
    const free = (x, y, w, h) => {
      for (const b of boxes) if (x < b[0] + b[2] && x + w > b[0] && y < b[1] + b[3] && y + h > b[1]) return false;
      boxes.push([x, y, w, h]); return true;
    };
    c.textBaseline = 'middle';

    if (o.labels) {
      // stations and control points
      const marks = this._markers();
      if (this._occVer !== this._camVer) { this._occ = new Map(); this._occVer = this._camVer; }
      for (const m of marks) {
        const p = this._project(m.x, m.y, m.h);
        if (p.w <= 0 || p.x < -50 || p.y < -50 || p.x > W + 50 || p.y > H + 50) continue;
        let hid = this._occ.get(m.key);
        if (hid === undefined) { hid = this._occluded(m.x, m.y, m.h + 12); this._occ.set(m.key, hid); }
        c.font = '600 11px system-ui,sans-serif';
        const tw = c.measureText(m.label).width + 10, lx = p.x - tw / 2, ly = p.y - 34;
        if (!free(lx, ly - 9, tw, 18)) continue;
        c.globalAlpha = hid ? 0.5 : 1;
        c.strokeStyle = '#14181c'; c.lineWidth = 1.2;
        c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(p.x, ly + 9); c.stroke();
        c.fillStyle = '#fff'; c.beginPath(); c.arc(p.x, p.y, 4, 0, 7); c.fill();
        c.fillStyle = m.primary ? '#14181c' : '#374151';
        c.beginPath(); c.arc(p.x, p.y, 2.6, 0, 7); c.fill();
        c.fillStyle = 'rgba(255,255,255,.93)'; c.fillRect(lx, ly - 9, tw, 18);
        c.strokeStyle = 'rgba(20,24,28,.25)'; c.strokeRect(lx + 0.5, ly - 8.5, tw - 1, 17);
        c.fillStyle = '#14181c'; c.fillText(m.label, lx + 5, ly + 0.5);
        c.globalAlpha = 1;
      }
      // long structures, named with their lengths
      if (sel && sel.runs) {
        const runs = sel.runs.filter(rn => rn.type && (rn.type.id === 'tunnel' || ELEVATED[rn.type.id]) &&
                                            rn.s1 - rn.s0 >= 400)
                             .sort((a, b) => (b.s1 - b.s0) - (a.s1 - a.s0)).slice(0, 14);
        c.font = '600 10.5px system-ui,sans-serif';
        for (const rn of runs) {
          const i = (rn.i0 + rn.i1) >> 1, P = sel.P[i];
          const p = this._project(P.E - Ec, P.N - Nc, sel.vp.z[i]);
          if (p.w <= 0 || p.x < 0 || p.y < 0 || p.x > W || p.y > H) continue;
          const txt = `${rn.type.label || STRUCT_LABEL[rn.type.id]} ${((rn.s1 - rn.s0) / 1000).toFixed(rn.s1 - rn.s0 >= 10000 ? 0 : 1)} km`;
          const tw = c.measureText(txt).width + 10, lx = p.x - tw / 2, ly = p.y + 22;
          if (!free(lx, ly - 8, tw, 16)) continue;
          const col = parseColour(rn.type.colour || STRUCT_FALLBACK[rn.type.id], [80, 80, 80]);
          c.strokeStyle = cssOf(col, 0.8); c.lineWidth = 1;
          c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(p.x, ly - 8); c.stroke();
          c.fillStyle = cssOf(col, 0.92); c.fillRect(lx, ly - 8, tw, 16);
          c.fillStyle = '#fff'; c.fillText(txt, lx + 5, ly + 0.5);
        }
      }
    }

    // hover marker: ground to design level, as the long section draws it
    if (sel && this.marker !== null && this.marker < sel.P.length) {
      const i = this.marker, P = sel.P[i], z = sel.vp.z[i], g = sel.vp.ground ? sel.vp.ground[i] : z;
      const a = this._project(P.E - Ec, P.N - Nc, z), b = this._project(P.E - Ec, P.N - Nc, g);
      if (a.w > 0 && b.w > 0) {
        c.strokeStyle = '#111'; c.lineWidth = 2; c.setLineDash([4, 3]);
        c.beginPath(); c.moveTo(b.x, b.y); c.lineTo(a.x, a.y); c.stroke(); c.setLineDash([]);
        c.fillStyle = '#fff'; c.strokeStyle = '#d0021b'; c.lineWidth = 2.5;
        c.beginPath(); c.arc(a.x, a.y, 6, 0, 7); c.fill(); c.stroke();
        c.fillStyle = '#111'; c.beginPath(); c.arc(b.x, b.y, 2.5, 0, 7); c.fill();
        const id = sel.structs && sel.structs[i] ? (sel.structs[i].label || sel.structs[i].id) : '';
        // design chainage where the line has one (an existing design starting at CH 157 km)
        const txt = `${((P.s + (sel.ch0 || 0)) / 1000).toFixed(3)} km · level ${z.toFixed(1)} m · ground ${g.toFixed(1)} m` +
                    (id ? ' · ' + id : '');
        c.font = '600 11px system-ui,sans-serif';
        const tw = c.measureText(txt).width + 12;
        let lx = clamp(a.x + 12, 4, W - tw - 4), ly = clamp(a.y - 22, 12, H - 12);
        c.fillStyle = 'rgba(20,24,28,.88)'; c.fillRect(lx, ly - 10, tw, 20);
        c.fillStyle = '#fff'; c.fillText(txt, lx + 6, ly + 0.5);
      }
    }
    if (o.hud) this._hud(c, W, H);
  }

  _hud(c, W, H) {
    const cam = this.cam, o = this.opts;
    // compass: north as it lies on screen
    const cx = W - 34, cy = 34, R = 20;
    c.fillStyle = 'rgba(255,255,255,.9)'; c.strokeStyle = 'rgba(20,24,28,.3)'; c.lineWidth = 1;
    c.beginPath(); c.arc(cx, cy, R, 0, 7); c.fill(); c.stroke();
    const nx = -Math.sin(cam.heading), ny = -Math.cos(cam.heading) * Math.max(0.35, Math.sin(cam.pitch));
    const l = Math.hypot(nx, ny) || 1, ux = nx / l, uy = ny / l;
    c.fillStyle = '#c62828';
    c.beginPath(); c.moveTo(cx + ux * 15, cy + uy * 15); c.lineTo(cx - uy * 5, cy + ux * 5); c.lineTo(cx + uy * 5, cy - ux * 5); c.fill();
    c.fillStyle = '#9aa3ad';
    c.beginPath(); c.moveTo(cx - ux * 15, cy - uy * 15); c.lineTo(cx - uy * 5, cy + ux * 5); c.lineTo(cx + uy * 5, cy - ux * 5); c.fill();
    c.fillStyle = '#14181c'; c.font = '700 10px system-ui,sans-serif'; c.textAlign = 'center';
    c.fillText('N', cx + ux * 27, cy + uy * 27);
    c.textAlign = 'left';

    // scale at the orbit target, and the exaggeration, so nobody reads VE 3 as true slope
    const mpp = 2 * cam.dist * Math.tan(o.fov * deg / 2) / Math.max(1, this.cssH);
    const want = mpp * 110, p10 = Math.pow(10, Math.floor(Math.log10(want)));
    const nice = [1, 2, 5, 10].map(m => m * p10).filter(v => v <= want).pop() || p10;
    const px = nice / mpp, x0 = 14, y0 = H - 16;
    c.fillStyle = 'rgba(255,255,255,.85)'; c.fillRect(x0 - 6, y0 - 30, Math.max(px, 120) + 12, 38);
    c.strokeStyle = '#14181c'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(x0, y0 - 5); c.lineTo(x0, y0); c.lineTo(x0 + px, y0); c.lineTo(x0 + px, y0 - 5); c.stroke();
    c.fillStyle = '#14181c'; c.font = '600 10.5px system-ui,sans-serif';
    c.fillText((nice >= 1000 ? (nice / 1000) + ' km' : nice + ' m') + ' at centre', x0, y0 - 12);
    c.fillStyle = '#b45309';
    c.fillText('VE ×' + (+o.ve).toFixed(o.ve < 10 ? 1 : 0).replace(/\.0$/, ''), x0 + Math.max(px, 120) - 34, y0 - 22);

    // structure legend for the selected line
    const sel = this.scene && this.scene.sel;
    if (sel && sel.runs) {
      const tot = {};
      for (const rn of sel.runs) { const id = rn.type && rn.type.id; if (id) tot[id] = (tot[id] || 0) + (rn.s1 - rn.s0); }
      const ids = ['viaduct', 'bridge', 'embankment', 'atgrade', 'cutting', 'tunnel'].filter(k => tot[k] > 0);
      if (ids.length) {
        c.font = '10.5px system-ui,sans-serif';
        const rows = ids.map(k => `${STRUCT_LABEL[k]} ${(tot[k] / 1000).toFixed(1)} km`);
        const w = Math.max(...rows.map(s => c.measureText(s).width)) + 30, h = rows.length * 15 + 10;
        const lx = W - w - 12, ly = H - h - 12;
        c.fillStyle = 'rgba(255,255,255,.88)'; c.fillRect(lx, ly, w, h);
        rows.forEach((s, j) => {
          const run = sel.runs.find(rn => rn.type && rn.type.id === ids[j]);
          c.fillStyle = (run && run.type.colour) || STRUCT_FALLBACK[ids[j]];
          c.fillRect(lx + 8, ly + 8 + j * 15, 12, 8);
          c.fillStyle = '#14181c'; c.fillText(s, lx + 25, ly + 12.5 + j * 15);
        });
      }
    }
  }

  _wrap(c, text, x, y, w, lh) {
    const words = String(text).split(/\s+/); let line = '';
    for (const wd of words) {
      const t = line ? line + ' ' + wd : wd;
      if (c.measureText(t).width > w && line) { c.fillText(line, x, y); y += lh; line = wd; } else line = t;
    }
    if (line) c.fillText(line, x, y);
  }

  /** Labelled points: scene.controls if given, else the selected line's own stations. */
  _markers() {
    const sc = this.scene, Ec = this.origin.E, Nc = this.origin.N, out = [];
    if (sc.controls && sc.controls.length) {
      sc.controls.forEach((m, j) => {
        if (m.synthetic) return;
        out.push({ key: 'c' + j, x: m.E - Ec, y: m.N - Nc, h: m.z !== undefined ? m.z : this._demAt(m.E, m.N),
                   label: m.name || m.id || ('CP' + (j + 1)), primary: m.kind !== 'secondary' });
      });
      return out;
    }
    const r = sc.sel;
    if (!r) return out;
    const chn = r.chn || [];
    chn.forEach((c, j) => {
      const nd = c.node || {};
      if (nd.synthetic) return;
      const P = r.P[c.idx];
      out.push({ key: 's' + j, x: P.E - Ec, y: P.N - Nc, h: r.vp.z[c.idx],
                 label: nd.name || nd.id || ('S' + (j + 1)), primary: nd.kind !== 'secondary' });
    });
    return out;
  }

  _occluded(x, y, h) {
    const fr = this._fr, e = fr.eye, z = (h - this.zRef) * this.opts.ve;
    const d = [x - e[0], y - e[1], z - e[2]], L = Math.hypot(d[0], d[1], d[2]);
    if (L < 1) return false;
    const t = this._march(e, [d[0] / L, d[1] / L, d[2] / L], L * 0.985);
    return t >= 0;
  }

  /* ------------------------------------------------------------ INPUT --- */
  _bind() {
    const cv = this.cv;
    cv.style.touchAction = 'none';
    if (!cv.hasAttribute('tabindex')) cv.tabIndex = 0;
    const ptrs = new Map();
    let mode = null, lx = 0, ly = 0, sx0 = 0, sy0 = 0, moved = false, pinch = null;
    this._hoverQ = 0;
    const stopTween = () => { if (this._tween) { cancelAnimationFrame(this._tween); this._tween = 0; } };
    /* CSS px inside the canvas, from clientX/Y and the canvas's own box —
       not offsetX/Y, which is relative to whatever element the event was
       retargeted to and, in testing, came back scaled by the device-emulation
       ratio (467 for a clientX of 700), so zoom-to-cursor zoomed about the
       wrong point. */
    const at = e => {
      const r = cv.getBoundingClientRect();
      return [e.clientX - r.left - cv.clientLeft, e.clientY - r.top - cv.clientTop];
    };

    this._on(cv, 'pointerdown', e => {
      if (!this.cam) return;
      stopTween(); this._touched = true;
      try { cv.focus({ preventScroll: true }); } catch (err) { /* old browsers */ }
      // throws NotFoundError for a pointer the browser no longer tracks (and for synthetic events)
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* drag still works inside the canvas */ }
      const [ex, ey] = at(e);
      ptrs.set(e.pointerId, { x: ex, y: ey });
      if (ptrs.size === 1) {
        mode = (e.button === 2 || e.button === 1 || e.shiftKey || e.ctrlKey) ? 'pan' : 'orbit';
        lx = sx0 = ex; ly = sy0 = ey; moved = false;
      } else if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        mode = 'pinch'; moved = true;
      }
    });
    this._on(cv, 'pointermove', e => {
      if (!this.cam) return;
      const [ex, ey] = at(e);
      if (!ptrs.has(e.pointerId)) {
        if (this.onHover && !this._hoverQ) {
          this._hoverQ = requestAnimationFrame(() => {
            this._hoverQ = 0;
            if (this.onHover) this.onHover(this.pickAt(ex, ey, 10));
          });
        }
        return;
      }
      const pt = ptrs.get(e.pointerId); pt.x = ex; pt.y = ey;
      if (mode === 'pinch' && ptrs.size >= 2) {
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        if (pinch.d > 0 && d > 0) this._zoomAt(mx, my, pinch.d / d);
        this._pan(mx - pinch.mx, my - pinch.my);
        pinch = { d, mx, my };
        return;
      }
      const dx = ex - lx, dy = ey - ly;
      lx = ex; ly = ey;
      if (Math.abs(ex - sx0) + Math.abs(ey - sy0) > 3) moved = true;
      if (!moved) return;
      if (mode === 'orbit') {
        const c = this.cam;
        c.heading -= dx * 0.0055;
        c.pitch += dy * 0.0045;
        this._clampCam(); this.requestRender();
      } else if (mode === 'pan') this._pan(dx, dy);
    });
    const up = e => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.delete(e.pointerId);
      try { cv.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
      if (ptrs.size === 0) {
        if (!moved && e.type === 'pointerup' && e.button === 0 && this.onPick) {
          const [ex, ey] = at(e), hit = this.pickAt(ex, ey, 12);
          if (hit) { this.setMarker(hit.i); this.onPick(hit); }
        }
        mode = null; pinch = null;
      } else if (ptrs.size === 1) {
        const p = [...ptrs.values()][0]; lx = p.x; ly = p.y; mode = 'orbit'; pinch = null;
      }
    };
    this._on(cv, 'pointerup', up);
    this._on(cv, 'pointercancel', up);
    this._on(cv, 'pointerleave', () => { if (this.onHover && !ptrs.size) this.onHover(null); });
    this._on(cv, 'wheel', e => {
      if (!this.cam) return;
      e.preventDefault(); stopTween(); this._touched = true;
      const k = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1, [ex, ey] = at(e);
      this._zoomAt(ex, ey, Math.exp(clamp(e.deltaY * k, -300, 300) * 0.0015));
    }, { passive: false });
    this._on(cv, 'dblclick', e => {
      if (!this.cam) return;
      const [ex, ey] = at(e), g = this.groundAt(ex, ey);
      if (g) this._tweenTo({ tx: g.x, ty: g.y, th: g.h, dist: this.cam.dist * 0.6 }, 420);
    });
    this._on(cv, 'contextmenu', e => e.preventDefault());
    this._on(cv, 'keydown', e => {
      if (!this.cam) return;
      const c = this.cam; let used = true;
      switch (e.key) {
        case 'r': case 'R': this.resetView(); break;
        case 'ArrowLeft':  c.heading += 5 * deg; break;
        case 'ArrowRight': c.heading -= 5 * deg; break;
        case 'ArrowUp':    c.pitch += 3 * deg; break;
        case 'ArrowDown':  c.pitch -= 3 * deg; break;
        case '+': case '=': c.dist *= 0.8; break;
        case '-': case '_': c.dist *= 1.25; break;
        default: used = false;
      }
      if (used) { e.preventDefault(); stopTween(); this._touched = true; this._clampCam(); this.requestRender(); }
    });
  }

  /* Horizontal pan, scaled so the ground at the orbit target moves with the
     pointer; the forward component is divided by sin(pitch) because the ground
     is foreshortened by it (capped, or a grazing view would fling the target). */
  _pan(dx, dy) {
    const c = this.cam;
    const mpp = 2 * c.dist * Math.tan(this.opts.fov * deg / 2) / Math.max(1, this.cssH);
    const ch = Math.cos(c.heading), sh = Math.sin(c.heading), fwd = mpp / Math.max(0.3, Math.sin(c.pitch));
    c.tx += -dx * mpp * ch + dy * fwd * sh;
    c.ty += dx * mpp * sh + dy * fwd * ch;
    this._clampCam(); this.requestRender();
  }

  /* Zoom about the point under the cursor: eye and target both scale about it,
     which keeps that point exactly where it is on screen. */
  _zoomAt(sx, sy, f) {
    const c = this.cam, T = this.terrain;
    const diag = Math.hypot(T.xE - T.xW, T.yN - T.yS);
    f = clamp(f, 40 / c.dist, diag * 4 / c.dist);
    if (Math.abs(f - 1) < 1e-4) return;
    this._frame();
    const g = this.groundAt(sx, sy);
    if (g) {
      const VE = this.opts.ve, zr = this.zRef;
      const tz = (c.th - zr) * VE, gz = (g.h - zr) * VE;
      c.tx = g.x + (c.tx - g.x) * f; c.ty = g.y + (c.ty - g.y) * f;
      c.th = (gz + (tz - gz) * f) / VE + zr;
    }
    c.dist *= f;
    this._clampCam(); this.requestRender();
  }

  _tweenTo(dst, ms) {
    if (this._tween) cancelAnimationFrame(this._tween);
    const cam0 = this.cam, src = Object.assign({}, cam0), t0 = performance.now();
    let dh = (dst.heading === undefined ? src.heading : dst.heading) - src.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    const step = () => {
      /* setGrid (cam → null) or a re-fitting setScene (a new cam) mid-flight:
         the flight belongs to the old scene. Carrying on threw a TypeError
         on the null camera, or dragged the new framing back to old values. */
      if (this.cam !== cam0 || !this.terrain) { this._tween = 0; return; }
      const t = Math.min(1, (performance.now() - t0) / ms);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const c = this.cam;
      for (const k of ['tx', 'ty', 'th', 'pitch']) if (dst[k] !== undefined) c[k] = src[k] + (dst[k] - src[k]) * e;
      c.heading = src.heading + dh * e;
      if (dst.dist !== undefined) c.dist = Math.exp(Math.log(src.dist) + (Math.log(dst.dist) - Math.log(src.dist)) * e);
      this._clampCam(); this.render();
      this._tween = t < 1 ? requestAnimationFrame(step) : 0;
    };
    step();
  }

  /* -------------------------------------------------------- PUBLIC API -- */
  setVerticalExaggeration(ve) {
    ve = +ve;
    if (!(ve > 0)) return;
    this.opts.ve = ve;
    this._camVer++;
    this.requestRender();
  }

  /** { terrainAlpha, xray, showLayers:{key:bool}, ribbonWidth, ribbonMinPx, slopes, piers,
        labels, hidden, hud, shade, background } — geometry is rebuilt only if it must be. */
  setOptions(o) {
    if (!o) return;
    let rebuild = false;
    for (const k in o) {
      if (k === 'showLayers') {
        for (const l in o.showLayers) if (this.layerOn && l in this.layerOn) this.layerOn[l] = !!o.showLayers[l];
        Object.assign(this.opts.showLayers, o.showLayers);
      } else if (k === 've') { if (+o.ve > 0) this.opts.ve = +o.ve; }   // 0 or NaN would divide groundAt by zero
      else {
        if ((k === 'ribbonWidth' || k === 'slopes' || k === 'piers') && this.opts[k] !== o[k]) rebuild = true;
        this.opts[k] = o[k];
      }
    }
    if (rebuild && this.scene && this.terrain) this._buildAlignment();
    this._camVer++;
    this.requestRender();
  }

  /** Centre the orbit on chainage s of the selected line.
      opts: {distance (m), heading (°, 0 = looking north), pitch (°), animate} */
  flyTo(s, opts) {
    const sel = this.scene && this.scene.sel;
    if (!sel || !this.cam) return;
    opts = opts || {};
    this._touched = true;
    const i = this._indexAt(s), P = sel.P[i];
    const dst = { tx: P.E - this.origin.E, ty: P.N - this.origin.N, th: sel.vp.z[i] };
    if (opts.distance) dst.dist = opts.distance;
    if (opts.heading !== undefined) dst.heading = opts.heading * deg;
    if (opts.pitch !== undefined) dst.pitch = opts.pitch * deg;
    if (opts.animate === false) { Object.assign(this.cam, dst); this._clampCam(); this.requestRender(); }
    else this._tweenTo(dst, 450);
  }
  _indexAt(s) {
    const P = this.scene.sel.P;
    let lo = 0, hi = P.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (P[m].s < s) lo = m + 1; else hi = m; }
    if (lo > 0 && Math.abs(P[lo - 1].s - s) < Math.abs(P[lo].s - s)) lo--;
    return lo;
  }

  /** Hover marker at sample i of the selected line (null clears). Overlay only — no 3-D frame. */
  setMarker(i) {
    const v = (i === null || i === undefined || i < 0) ? null : i | 0;
    if (v === this.marker) return;
    this.marker = v;
    if (!this._raf) this._drawOverlay();
  }

  /** Back to the framing the scene opened with (key R). The distance is
      re-fitted, because the canvas may have changed shape since. */
  resetView() {
    if (!this.terrain || !this._home || !this.cam) return;
    const live = this.cam, home = Object.assign({}, this._home);
    this.cam = home; home.dist = this._fitDistance(); this.cam = live;
    this._tweenTo(home, 450);
  }

  /** Current camera, for saving a viewpoint: {E, N, h, heading°, pitch°, distance}. */
  getView() {
    if (!this.cam) return null;
    const c = this.cam;
    return { E: c.tx + this.origin.E, N: c.ty + this.origin.N, h: c.th,
             heading: c.heading / deg, pitch: c.pitch / deg, distance: c.dist };
  }
  setView(v) {
    if (!v || !this.cam) return;
    const c = this.cam;
    this._touched = true;
    if (v.E !== undefined) c.tx = v.E - this.origin.E;
    if (v.N !== undefined) c.ty = v.N - this.origin.N;
    if (v.h !== undefined) c.th = v.h;
    if (v.heading !== undefined) c.heading = v.heading * deg;
    if (v.pitch !== undefined) c.pitch = v.pitch * deg;
    if (v.distance !== undefined) c.dist = v.distance;
    this._clampCam(); this.requestRender();
  }

  /** Size the drawing buffers to the canvas's CSS box (× devicePixelRatio, capped at 2). */
  resize() {
    const cv = this.cv;
    /* A hidden canvas (display:none, a collapsed tab) reports 0×0: keep the
       last size and wait — the ResizeObserver calls again when it is shown. */
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) { this._drawOverlay(); return; }
    const dpr = Math.min(2, global.devicePixelRatio || 1);
    this.dpr = dpr; this.cssW = w; this.cssH = h;
    const W = Math.round(w * dpr), H = Math.round(h * dpr);
    const aspectWas = this._aspect();
    if (cv.width !== W || cv.height !== H) {
      cv.width = W; cv.height = H;
      /* A canvas with no CSS size takes its box from these attributes, so at
         devicePixelRatio > 1 every ResizeObserver call would grow it by that
         ratio, without end. If the box moved with the attributes, pin it at
         the size just measured. (Give the canvas a CSS size — width/height
         100% of a sized container — and this never fires.) */
      if (Math.abs(cv.clientWidth - w) > 1 || Math.abs(cv.clientHeight - h) > 1) {
        cv.style.width = w + 'px'; cv.style.height = h + 'px';
      }
    }
    /* A viewer created in a hidden pane framed its block for a 300×150 canvas.
       Until someone has moved the camera, a change of shape re-frames it. */
    if (this.cam && this.terrain && !this._touched && Math.abs(this._aspect() / aspectWas - 1) > 0.02) {
      this._fitDistance(); this._home = Object.assign({}, this.cam);
    }
    if (this.ov.width !== W || this.ov.height !== H) { this.ov.width = W; this.ov.height = H; }
    if (this._ownOverlay) {
      this.ov.style.width = w + 'px'; this.ov.style.height = h + 'px';
      this.ov.style.left = cv.offsetLeft + 'px'; this.ov.style.top = cv.offsetTop + 'px';
    }
    this._camVer++;
    if (this.gl) this.render(); else this._drawOverlay();
  }

  /** The current frame (3-D plus labels) as a PNG data URL, for reports. */
  toDataURL() {
    if (!this.gl) return null;
    this.render();                                     // same task: the buffer is still intact
    const c = document.createElement('canvas'); c.width = this.cv.width; c.height = this.cv.height;
    const x = c.getContext('2d');
    x.drawImage(this.cv, 0, 0); x.drawImage(this.ov, 0, 0);
    return c.toDataURL('image/png');
  }

  /** Release every GL object (buffers, textures, programs and their shaders),
      listeners, the observer and the overlay. The context itself is left to
      the canvas: losing it would also break a viewer created on it later. */
  dispose() {
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._tween) cancelAnimationFrame(this._tween);
    if (this._hoverQ) cancelAnimationFrame(this._hoverQ);
    this._raf = this._tween = this._hoverQ = 0;
    if (this._ro) this._ro.disconnect();
    for (const [el, ev, fn, opt] of this._listeners) el.removeEventListener(ev, fn, opt);
    this._listeners = [];
    if (this.gl) {
      const gl = this.gl;
      this._freeTerrain(); this._freeItems();
      for (const p of [this.progMesh, this.progLine, this.progTerrain]) if (p) gl.deleteProgram(p.p);
      for (const loc of this._enabled || []) gl.disableVertexAttribArray(loc);
      gl.bindBuffer(gl.ARRAY_BUFFER, null); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
      gl.useProgram(null);
    }
    if (this._ownOverlay && this.ov && this.ov.parentNode) this.ov.parentNode.removeChild(this.ov);
    this.progMesh = this.progLine = this.progTerrain = null;
    this._enabled = new Set();
    this.gl = null; this.scene = null; this.G = null; this.cam = null; this.terrain = null;
    this.onPick = this.onHover = null;
  }
}

/* --------------------------------------------------------------- API ---- */
/** True when this browser can draw the 3-D view at all. Probed once and
    cached, and the probe's context is released at once: browsers keep ~16
    live contexts and LOSE THE OLDEST beyond that, so a probe per call (as
    this first did) killed the live viewer's context after a dozen checks. */
let probed = null;
function supported() {
  if (probed !== null) return probed;
  let ok = false, g = null;
  try {
    const c = document.createElement('canvas');
    g = c.getContext('webgl2');
    if (g) ok = true;
    else {
      g = c.getContext('webgl');
      ok = !!(g && g.getExtension('OES_element_index_uint'));
    }
  } catch (e) { ok = false; }
  try { const lose = g && g.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); } catch (e) { /* gone anyway */ }
  return (probed = ok);
}

global.VIEW3D = {
  /** VIEW3D.create(canvas, opts) → viewer. Check viewer.ok / viewer.error. */
  create(canvas, opts) {
    const v = new Viewer(canvas, opts);
    v.ok = !v.error;
    return v;
  },
  supported,
  Viewer,
};
})(window);
