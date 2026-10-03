/* ===========================================================================
   Alignment Designer v12 :: DESIGN STANDARDS

   One place where "what kind of route is this?" turns into numbers. Everything
   downstream — the search lattice, the vertical profile, the speed model, the
   structure thresholds and the cost rates — reads its constraints from here, so
   switching from a two-lane road to a 350 km/h high-speed line is a change of
   standard, not a change of code.

   Every value is derived from the published rule rather than tabulated, so an
   arbitrary design speed produces a defensible number instead of an
   interpolation between two rows. The rule and its source are carried on the
   result in `.basis`, and shown in the UI — a figure a reviewer cannot trace is
   worth nothing on a corridor study.

   Sources
     ROAD   AASHTO A Policy on Geometric Design of Highways and Streets, 7th ed
            (superelevation + side friction, SSD, crest/sag K values);
            IRC:73 / IRC:SP:84 for the Indian equivalents, which agree.
     RAIL   UIC 703 / EN 13803; Indian Railways SOD and IRPWM for cant limits
            and the transition-length rule.
     HSR    TSI INF (EU) 1299/2014 for cant, cant deficiency, gradient and
            vertical radius on dedicated high-speed lines.
     MAGLEV Magnetschwebebahn Bau- und Betriebsordnung (MbBO) §13 — bank angle
            and lateral acceleration limits; the large-angle comfort form is
            Jiang et al. 2019 as used in the v11 study.
   =========================================================================== */
(function (global) {
'use strict';

const G = 9.81;

/* ------------------------------------------------------------------ ROAD -- */
/* AASHTO Table 3-7 side friction factors, interpolated on design speed. These
   are comfort/skid limits, not the available friction — the pavement has far
   more, and that margin is the safety factor. */
const F_SIDE = [[20,0.35],[30,0.28],[40,0.23],[50,0.19],[60,0.17],[70,0.15],
                [80,0.14],[90,0.13],[100,0.12],[110,0.11],[120,0.09],[130,0.08],[140,0.075]];

/* Maximum gradient, AASHTO Tables 6-x, by terrain and design speed. Flatter
   roads at higher speed: a heavy vehicle climbing at 6% loses enough speed to
   become a hazard on a 120 km/h road, which is why the limit tightens. */
const ROAD_GRADE = {
  level:       [[40,8],[60,7],[80,6],[100,5],[120,4],[140,3]],
  rolling:     [[40,9],[60,8],[80,7],[100,6],[120,5],[140,4]],
  mountainous: [[40,12],[60,10],[80,9],[100,8],[120,6],[140,5]],
};

function interp(table, x) {
  if (x <= table[0][0]) return table[0][1];
  const last = table[table.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i-1], [x1, y1] = table[i];
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
  }
  return last[1];
}

/** AASHTO stopping sight distance: 2.5 s reaction + braking at 3.4 m/s². */
function stoppingSightDistance(V, gradePct) {
  const a = 3.4;
  const g = (gradePct || 0) / 100;
  return 0.278 * V * 2.5 + (V * V) / (254 * (a / G + g));
}

/* ------------------------------------------------------------------ RAIL -- */
/* R = k·V² / (D + I), with k set by the dynamic gauge: 1500 mm for 1435 mm
   standard gauge gives the familiar 11.8, 1750 mm for 1676 mm broad gauge
   gives 13.76. V in km/h, cant D and cant deficiency I in mm, R in metres. */
const GAUGE = {
  standard: { mm: 1435, k: 11.8,  label: '1435 mm standard' },
  broad:    { mm: 1676, k: 13.76, label: '1676 mm Indian broad' },
  metre:    { mm: 1000, k: 8.6,   label: '1000 mm metre' },
  cape:     { mm: 1067, k: 9.1,   label: '1067 mm cape' },
};

/* ---------------------------------------------------------------- MAGLEV -- */
const MAGLEV = {
  thetaMax: 12.0,          // deg, MbBO §13(3) normal maximum bank
  aqPreferred: 0.49,       // m/s², CAHSR 0.05 g
  aqNormal: 0.63,          // m/s², top of ISO comfort level 2
  aqCeiling: 1.50,         // m/s², MbBO §13(5) legal ceiling
};
/** Exact large-bank-angle lateral acceleration. a_q = v²cosθ/R − g·sinθ. */
function lateralAccel(V_kmh, R_m, thetaDeg) {
  const v = V_kmh / 3.6, th = thetaDeg * Math.PI / 180;
  return v * v * Math.cos(th) / Math.abs(R_m) - G * Math.sin(th);
}
function maglevRadius(V_kmh, thetaDeg, aq) {
  const v = V_kmh / 3.6, th = thetaDeg * Math.PI / 180;
  return v * v * Math.cos(th) / (aq + G * Math.sin(th));
}
function maglevSpeed(R_m, thetaDeg, aq) {
  const th = thetaDeg * Math.PI / 180;
  return Math.sqrt(Math.max(0, (aq + G * Math.sin(th)) * Math.abs(R_m) / Math.cos(th))) * 3.6;
}

/* ============================================================== THE MODES == */
/* `params` are the knobs a designer legitimately turns for a given mode; they
   appear in the UI. `derive` turns (design speed + params) into the geometric
   envelope the engine enforces. */
const MODES = {

  road: {
    key: 'road', label: 'Road — highway', family: 'road',
    speeds: [40, 50, 60, 70, 80, 90, 100, 110, 120, 130],
    defaultSpeed: 100,
    params: {
      lanes:      { label: 'Carriageway', type: 'select', value: '2',
                    options: [['2','2-lane single'],['4','4-lane divided'],
                              ['6','6-lane expressway']] },
      emax:       { label: 'Max superelevation', type: 'range', value: 7,
                    min: 2, max: 10, step: 0.5, unit: '%' },
      terrain:    { label: 'Terrain class', type: 'select', value: 'rolling',
                    options: [['level','Level'],['rolling','Rolling'],
                              ['mountainous','Mountainous']] },
    },
    kinematics: { accel: 1.0, brake: 3.0, dwell: 0 },
    derive(V, p) {
      const e = (+p.emax) / 100;
      const f = interp(F_SIDE, V);
      const rMin = V * V / (127 * (e + f));
      // The desirable radius drops the design to two thirds of the allowable
      // side friction — the value most agencies actually build to on new-build.
      const rDes = V * V / (127 * (e + f * 0.67));
      const gradePct = interp(ROAD_GRADE[p.terrain] || ROAD_GRADE.rolling, V);
      const S = stoppingSightDistance(V, 0);
      const kCrest = S * S / 658;                    // h1 1.08 m, h2 0.60 m
      const kSag   = S * S / (120 + 3.5 * S);        // headlight, 1° upward beam
      const lanes = +p.lanes;
      const width = lanes === 2 ? 12.0 : lanes === 4 ? 24.0 : 30.0;
      return {
        rMin, rDes,
        maxGrade: gradePct,
        vCrestR: 100 * kCrest, vSagR: 100 * kSag,
        transition: Math.max(30, 0.0214 * V * V * V / (rMin * 0.6)),   // AASHTO spiral, A=0.6 m/s³
        width, sideSlope: 2.0, sight: S, super: e * 100,
        basis: [
          `R_min = V²/(127(e+f)) = ${V}²/(127(${(e).toFixed(3)}+${f.toFixed(3)})) = ${Math.round(rMin)} m — AASHTO`,
          `SSD = 0.278·V·2.5 + V²/(254·a/g) = ${Math.round(S)} m at a = 3.4 m/s²`,
          `K crest ${kCrest.toFixed(0)} (R ${Math.round(100*kCrest).toLocaleString()} m) · K sag ${kSag.toFixed(0)} (R ${Math.round(100*kSag).toLocaleString()} m)`,
          `Max grade ${gradePct.toFixed(1)} % — ${p.terrain} terrain at ${V} km/h`,
          `Formation ${width.toFixed(0)} m, side slopes 1V:2H`,
        ],
      };
    },
    curveSpeed(R, p) {                         // km/h a radius permits
      const e = (+p.emax) / 100;
      // f is speed-dependent, so solve the implicit equation by two passes
      let V = Math.sqrt(127 * R * (e + 0.15));
      for (let i = 0; i < 6; i++) V = Math.sqrt(127 * R * (e + interp(F_SIDE, V)));
      return V;
    },
  },

  rail: {
    key: 'rail', label: 'Railway — conventional', family: 'rail',
    speeds: [80, 100, 110, 120, 130, 140, 160, 180, 200],
    defaultSpeed: 130,
    params: {
      gauge:  { label: 'Track gauge', type: 'select', value: 'standard',
                options: Object.keys(GAUGE).map(k => [k, GAUGE[k].label]) },
      cant:   { label: 'Max cant D', type: 'range', value: 150, min: 80, max: 185, step: 5, unit: 'mm' },
      cantDef:{ label: 'Cant deficiency I', type: 'range', value: 100, min: 50, max: 153, step: 5, unit: 'mm' },
      ruling: { label: 'Ruling gradient', type: 'range', value: 1.0, min: 0.3, max: 3.0, step: 0.1, unit: '%' },
      tracks: { label: 'Tracks', type: 'select', value: '2',
                options: [['1','Single'],['2','Double']] },
    },
    kinematics: { accel: 0.6, brake: 0.8, dwell: 60 },
    derive(V, p) {
      const k = (GAUGE[p.gauge] || GAUGE.standard).k;
      const D = +p.cant, I = +p.cantDef;
      const rMin = k * V * V / (D + I);
      const rDes = k * V * V / (D * 0.75 + I * 0.5);        // comfort target
      // UIC/IR vertical curve: 0.35·V² desirable, floor of 2 500 m on new build
      const vR = Math.max(2500, 0.35 * V * V);
      const tracks = +p.tracks;
      const width = tracks === 1 ? 7.0 : 13.0;
      return {
        rMin, rDes,
        maxGrade: +p.ruling,
        vCrestR: vR, vSagR: vR,
        // Indian Railways / UIC: the longest of the three ramp-rate criteria
        transition: Math.max(0.008 * D * V, 0.008 * I * V, 0.72 * D) ,
        width, sideSlope: 2.0, sight: 0, super: D,
        basis: [
          `R_min = ${k}·V²/(D+I) = ${k}·${V}²/(${D}+${I}) = ${Math.round(rMin)} m — UIC 703 / EN 13803`,
          `Gauge ${(GAUGE[p.gauge]||GAUGE.standard).label}, cant ${D} mm, cant deficiency ${I} mm`,
          `Ruling gradient ${(+p.ruling).toFixed(1)} % (1 in ${Math.round(100/+p.ruling)})`,
          `Vertical curve R = max(2 500, 0.35·V²) = ${Math.round(vR).toLocaleString()} m`,
          `Transition L = max(0.008·D·V, 0.008·I·V, 0.72·D) = ${Math.round(Math.max(0.008*D*V, 0.008*I*V, 0.72*D))} m`,
        ],
      };
    },
    curveSpeed(R, p) {
      const k = (GAUGE[p.gauge] || GAUGE.standard).k;
      return Math.sqrt(Math.abs(R) * ((+p.cant) + (+p.cantDef)) / k);
    },
  },

  rail_hs: {
    key: 'rail_hs', label: 'Railway — high speed', family: 'rail',
    speeds: [200, 220, 250, 270, 300, 320, 350, 380, 400],
    defaultSpeed: 300,
    params: {
      cant:    { label: 'Max cant D', type: 'range', value: 160, min: 100, max: 200, step: 5, unit: 'mm' },
      cantDef: { label: 'Cant deficiency I', type: 'range', value: 80, min: 40, max: 130, step: 5, unit: 'mm' },
      ruling:  { label: 'Ruling gradient', type: 'range', value: 2.5, min: 0.5, max: 4.0, step: 0.1, unit: '%' },
      vfactor: { label: 'Vertical R factor', type: 'range', value: 0.35, min: 0.25, max: 0.60, step: 0.05, unit: '× V²' },
    },
    kinematics: { accel: 0.5, brake: 0.6, dwell: 90 },
    derive(V, p) {
      const D = +p.cant, I = +p.cantDef;
      const rMin = 11.8 * V * V / (D + I);
      // TSI treats D 180 / I 100 as the ceiling; lines are actually built to a
      // lower cant deficiency for ride comfort at speed, and that is what sets
      // the radius a designer should be aiming at.
      const rDes = 11.8 * V * V / (Math.min(D, 150) + Math.min(I, 40));
      const vR = (+p.vfactor) * V * V;
      return {
        rMin, rDes,
        maxGrade: +p.ruling,
        vCrestR: vR, vSagR: vR,
        transition: V * D / 180,                  // cant ramp dD/dt ≤ 50 mm/s
        width: 14.0, sideSlope: 2.0, sight: 0, super: D,
        basis: [
          `R_min = 11.8·V²/(D+I) = 11.8·${V}²/(${D}+${I}) = ${Math.round(rMin)} m — TSI INF`,
          `Desirable R at D 150 / I 40 = ${Math.round(rDes).toLocaleString()} m — comfort at line speed`,
          `Ruling gradient ${(+p.ruling).toFixed(1)} % (TSI allows 35 ‰ on dedicated high-speed lines)`,
          `Vertical curve R = ${(+p.vfactor).toFixed(2)}·V² = ${Math.round(vR).toLocaleString()} m`,
          `Transition L = V·D/180 = ${Math.round(V*D/180)} m at a 50 mm/s cant ramp`,
        ],
      };
    },
    curveSpeed(R, p) {
      return Math.sqrt(Math.abs(R) * ((+p.cant) + (+p.cantDef)) / 11.8);
    },
  },

  maglev: {
    key: 'maglev', label: 'Maglev — EMS guideway', family: 'maglev',
    speeds: [300, 350, 400, 450, 500, 550, 600, 650, 700, 750],
    defaultSpeed: 500,
    params: {
      bank: { label: 'Max guideway bank θ', type: 'range', value: 12, min: 4, max: 16, step: 0.5, unit: '°' },
      aq:   { label: 'Lateral accel target', type: 'range', value: 0.63, min: 0.30, max: 1.50, step: 0.01, unit: 'm/s²' },
      ruling: { label: 'Ruling gradient', type: 'range', value: 6.0, min: 1.0, max: 10.0, step: 0.5, unit: '%' },
      av:   { label: 'Vertical accel limit', type: 'range', value: 0.35, min: 0.15, max: 0.80, step: 0.05, unit: 'm/s²' },
    },
    kinematics: { accel: 1.0, brake: 1.0, dwell: 60 },
    derive(V, p) {
      const th = +p.bank, aq = +p.aq;
      const rMin = maglevRadius(V, th, aq);
      const rDes = maglevRadius(V, th, MAGLEV.aqPreferred);
      const v = V / 3.6;
      const vR = v * v / (+p.av);
      return {
        rMin, rDes,
        maxGrade: +p.ruling,
        vCrestR: vR, vSagR: vR,
        transition: V * (1500 * Math.sin(th * Math.PI / 180)) / 180,
        width: 12.0, sideSlope: 2.0, sight: 0, super: th,
        basis: [
          `R_min = v²cosθ/(a_q + g·sinθ) = ${Math.round(rMin).toLocaleString()} m at θ ${th}°, a_q ${aq.toFixed(2)} m/s²`,
          `Desirable R at a_q 0.49 (0.05 g) = ${Math.round(rDes).toLocaleString()} m`,
          `Ruling gradient ${(+p.ruling).toFixed(1)} % — EMS maglev climbs where wheel-on-rail cannot`,
          `Vertical curve R = v²/a_v = ${Math.round(vR).toLocaleString()} m at a_v ${(+p.av).toFixed(2)} m/s²`,
          `MbBO §13(5) legal ceiling on a_q is 1.50 m/s²; ISO comfort level 2 is 0.63`,
        ],
      };
    },
    curveSpeed(R, p) { return maglevSpeed(R, +p.bank, +p.aq); },
  },

  metro: {
    key: 'metro', label: 'Metro / light rail', family: 'rail',
    speeds: [50, 60, 70, 80, 90, 100, 120],
    defaultSpeed: 80,
    params: {
      cant:    { label: 'Max cant D', type: 'range', value: 110, min: 50, max: 160, step: 5, unit: 'mm' },
      cantDef: { label: 'Cant deficiency I', type: 'range', value: 85, min: 40, max: 130, step: 5, unit: 'mm' },
      ruling:  { label: 'Ruling gradient', type: 'range', value: 3.5, min: 1.0, max: 6.0, step: 0.1, unit: '%' },
    },
    kinematics: { accel: 1.0, brake: 1.1, dwell: 30 },
    derive(V, p) {
      const D = +p.cant, I = +p.cantDef;
      const rMin = Math.max(120, 11.8 * V * V / (D + I));
      const vR = Math.max(1500, 0.25 * V * V);
      return {
        rMin, rDes: rMin * 1.5,
        maxGrade: +p.ruling,
        vCrestR: vR, vSagR: vR,
        transition: Math.max(20, 0.008 * D * V),
        width: 10.0, sideSlope: 1.5, sight: 0, super: D,
        basis: [
          `R_min = max(120, 11.8·V²/(D+I)) = ${Math.round(rMin)} m — the 120 m floor is the vehicle, not the comfort rule`,
          `Ruling gradient ${(+p.ruling).toFixed(1)} % — metro stock is powered on every axle`,
          `Vertical curve R = max(1 500, 0.25·V²) = ${Math.round(vR).toLocaleString()} m`,
        ],
      };
    },
    curveSpeed(R, p) { return Math.sqrt(Math.abs(R) * ((+p.cant) + (+p.cantDef)) / 11.8); },
  },
};

/* ------------------------------------------------------------ COST RATES -- */
/* Order-of-magnitude capital rates, in millions of currency units. These are
   deliberately COMPARATIVE: they rank alternatives against each other and must
   be replaced with a local rate build-up before any number leaves the room.
   Sources for the shape of the table: DfT/PwC High Speed Rail International
   Benchmarking (2020) for rail, and typical national highway schedules for
   road. The UI exposes every one of them. */
const RATES = {
  road:    { atGrade: 2.2, viaduct: 22, tunnel: 70,  bridge: 26, currency: 'M', unitLabel: 'M/km' },
  rail:    { atGrade: 7.0, viaduct: 34, tunnel: 95,  bridge: 38, currency: 'M', unitLabel: 'M/km' },
  rail_hs: { atGrade: 18.0, viaduct: 52, tunnel: 125, bridge: 58, currency: 'M', unitLabel: 'M/km' },
  maglev:  { atGrade: 30.0, viaduct: 68, tunnel: 150, bridge: 72, currency: 'M', unitLabel: 'M/km' },
  metro:   { atGrade: 12.0, viaduct: 45, tunnel: 110, bridge: 48, currency: 'M', unitLabel: 'M/km' },
};
/* Quantity rates, same currency, per unit. Earthworks dominate the difference
   between two alignments in rolling country, which is exactly why they are
   priced by volume here and not smeared into a per-km rate. */
const QRATES = {
  cutM3: 6e-6,        // M per m³ excavated
  fillM3: 4.5e-6,     // M per m³ placed (won from cut where the haul allows)
  haulM3km: 0.5e-6,   // M per m³·km of mass haul
  landM2: 25e-6,      // M per m² of land take
  landBuiltM2: 320e-6,// M per m² through built-up area — acquisition, not land
  portal: 7.0,        // M per tunnel portal
  structures: 1.18,   // indirects / design / risk multiplier on civils
};

/* ------------------------------------------------------------------- API -- */
function modeList() {
  return Object.keys(MODES).map(k => [k, MODES[k].label]);
}

/** Fresh copy of a mode's parameter defaults, ready to bind to the UI. */
function defaultParams(modeKey) {
  const m = MODES[modeKey] || MODES.road;
  const out = {};
  for (const k in m.params) out[k] = m.params[k].value;
  return out;
}

/**
 * The full geometric envelope for a mode / speed / parameter set.
 * `useDesirable` picks the comfort-target radius over the absolute limit —
 * a real design decision, so it is a switch and not a hidden constant.
 */
function derive(modeKey, V, params, useDesirable) {
  const m = MODES[modeKey] || MODES.road;
  const p = Object.assign(defaultParams(modeKey), params || {});
  const d = m.derive(V, p);
  d.mode = m.key; d.modeLabel = m.label; d.family = m.family;
  d.designSpeed = V;
  d.params = p;
  d.rGoverning = useDesirable ? Math.max(d.rMin, d.rDes) : d.rMin;
  d.kinematics = Object.assign({}, m.kinematics);
  d.rates = Object.assign({}, RATES[m.key] || RATES.road);
  d.qrates = Object.assign({}, QRATES);
  return d;
}

/** Speed a given radius permits under this mode's comfort rule, km/h. */
function speedForRadius(modeKey, R, params) {
  const m = MODES[modeKey] || MODES.road;
  const p = Object.assign(defaultParams(modeKey), params || {});
  if (!isFinite(R) || Math.abs(R) < 1) return Infinity;
  return m.curveSpeed(Math.abs(R), p);
}

/** Inverse: the radius a target speed needs. Used by the option generator. */
function radiusForSpeed(modeKey, V, params) {
  return derive(modeKey, V, params, false).rMin;
}

global.STANDARDS = {
  MODES, RATES, QRATES, GAUGE, MAGLEV,
  modeList, defaultParams, derive, speedForRadius, radiusForSpeed,
  stoppingSightDistance, lateralAccel, maglevSpeed, maglevRadius, interp,
};
})(window);
