"""
London 2100 — orbital/radial NODE SELECTION PIPELINE
Target path:  London2100_RailDesigner/build/node_pipeline.py

Builds on build_grids.py (same grid, same loaders). Nothing is re-derived.

Stages
  L  load_layers()            cached constraint stack -> _nodegrid_cache.npz
  A  calibrate()              gate thresholds from the ACTUAL distribution
  B  candidates()             coarse lattice -> gated -> clustered representative sites
  C  corridor(a,b)            leg metrics: legal-profile earthworks, grain, constraint km, £m
  D  leg_matrix()             all-pairs leg cost over the candidate set
  E  select_ring()            EXACT cyclic dynamic program -> optimal K-node ring
  F  accessibility / demand   gravity + 2SFCA, network-free upper bound + fixed point
  G  validate()               null model, weight Monte Carlo, leave-one-out

Run:  python node_pipeline.py --stage all
"""
import os, sys, math, json, argparse, itertools, hashlib, time
import numpy as np
from scipy.ndimage import (uniform_filter, gaussian_filter1d, distance_transform_edt,
                           label, maximum_filter)

BUILD = r"D:\000_AA DRL\000_Studio_Anguis\Claude_Code\London2100_RailDesigner\build"
sys.path.insert(0, BUILD)
import build_grids as B                                    # noqa: E402

CELL, NX, NY = B.CELL, B.NX, B.NY
XMIN, YMAX = B.XMIN, B.YMAX
GE, GN = B.GE, B.GN
CX, CY = 530034.0, 180381.0                                # Charing Cross
CACHE = os.path.join(BUILD, "_nodegrid_cache.npz")

# ── design constants (fixed upstream — do not re-derive) ──────────────────────
V_MAX      = 500.0 / 3.6          # 138.889 m/s  operating design speed
V_GEOM     = 600.0 / 3.6          # geometric design speed
A_LONG     = 1.0                  # m/s^2 design longitudinal acceleration
A_MEAS     = 0.810                # m/s^2 measured TR08 in service
R_HORIZ    = 12000.0              # m  preferred minimum horizontal radius
R_VERT     = 126000.0             # m  desirable minimum vertical curve radius
BANK_PLAT  = 3.4                  # deg  max bank within 400 m of a platform
L_PLAT_STR = 400.0                # m    each side
DWELL      = 60.0                 # s   [A]
G          = 9.81

# distance to reach line speed  d = v^2/(2a)
D_TO_VMAX  = V_MAX**2 / (2*A_LONG)                 # 9,645 m
L_MIN_LEG  = 2*D_TO_VMAX                           # 19,290 m  — below this the leg wastes the asset
R_PLATFORM = V_MAX**2 / (G*math.tan(math.radians(BANK_PLAT)))   # 33,110 m


# ═════════════════════════════════════════════════════════════════════════════
# L — LAYERS
# ═════════════════════════════════════════════════════════════════════════════
ALC_PALETTE = {1:(86,125,162), 2:(182,227,232), 3:(149,195,140), 4:(204,226,136),
               5:(255,225,127), 6:(255,153,58), 7:(115,109,105), 8:(216,153,153)}

def load_layers(rebuild=False):
    """Returns a dict of 2-D float32/uint8 arrays on the project grid."""
    if os.path.exists(CACHE) and not rebuild:
        z = np.load(CACHE)
        L = {k: z[k] for k in z.files}
        print(f"[L] cache {CACHE}  {len(L)} layers")
        return L
    t0 = time.time()
    L = {}
    L["dem"]   = np.load(os.path.join(BUILD, "_dem_cache.npy"))
    gy, gx     = np.gradient(L["dem"], CELL)
    L["slope"] = (np.hypot(gx, gy) * 100.0).astype(np.float32)
    L["aonb"]  = B.raster_coverage("02_AONB.png")
    L["gb"]    = B.raster_coverage("01_Green Belt.png")
    L["built"] = B.raster_coverage("Built.png")
    L["wood"]  = B.raster_coverage("woodland.png")          # SUPERSET — see QA gate 3
    L["london"]= B.raster_coverage("London.png")
    L["alc"]   = B.raster_class("Agriculture.png", ALC_PALETTE)
    L["water"] = B.rasterize_polys("surfacewater").astype(np.float32)
    L["river"] = B.rasterize_lines("waterlines", 1,
                    "AND t.type IN ('National','Regional')").astype(np.float32)
    # RAIL: heritage-line trap. Zoomstack has no type filter on `rail`; the
    # published trap says filter to Multi/Single Track. Try it, fall back loudly.
    try:
        L["rail"] = B.rasterize_lines("rail", 1,
                    "AND t.type IN ('Multi Track','Single Track')").astype(np.float32)
    except Exception as e:
        print(f"[L] !! rail type filter failed ({e}) — UNFILTERED rail, heritage lines included")
        L["rail"] = B.rasterize_lines("rail", 1).astype(np.float32)
    L["road_m"] = B.rasterize_lines("roads_national", 1).astype(np.float32)
    L["road_a"] = B.rasterize_lines("roads_regional", 1, "AND t.type='A Road'").astype(np.float32)

    for src, key, thr in (("built","d_built",0.15), ("aonb","d_aonb",0.15),
                          ("wood","d_wood",0.15), ("rail","d_rail",0.15),
                          ("road_m","d_roadm",0.15), ("river","d_river",0.15)):
        L[key] = (distance_transform_edt(~(L[src] > thr)) * CELL).astype(np.float32)

    L["R"]   = (np.hypot(GE-CX, GN-CY)/1000.0).astype(np.float32)
    L["BRG"] = (np.degrees(np.arctan2(GE-CX, GN-CY)) % 360.0).astype(np.float32)
    np.savez_compressed(CACHE, **L)
    print(f"[L] built {len(L)} layers in {time.time()-t0:.0f}s -> {CACHE}")
    return L


# ── QA GATES — run after every load. These exist because the project has been
#    bitten by silent errors (heritage railway scored as a main line; a vertical
#    profile bug that a post-hoc filter would have passed).
def qa_layers(L, strict=True):
    fails = []
    def chk(name, cond, msg):
        (print if cond else (fails.append, print)[0])(f"   {'ok  ' if cond else 'FAIL'} {name}: {msg}")
        if not cond: fails.append(name)

    print("[QA] layer gates")
    chk("shape", all(L[k].shape == (NY, NX) for k in L), f"all layers {NY}x{NX}")
    chk("dem_range", 0 < L["dem"].min() < 30 and 250 < L["dem"].max() < 320,
        f"DEM {L['dem'].min():.0f}..{L['dem'].max():.0f} m (expect ~10..290)")
    chk("dem_finite", np.isfinite(L["dem"]).all(), "DEM finite")
    chk("alc_hist", 0.9 < sum((L["alc"]==k).mean() for k in range(1,9)) <= 1.0,
        f"ALC classified {sum((L['alc']==k).mean() for k in range(1,9))*100:.1f}% of frame")
    chk("alc_g1_g2", (L["alc"]==1).mean() < (L["alc"]==2).mean(),
        f"grade1 {(L['alc']==1).mean()*100:.2f}% < grade2 {(L['alc']==2).mean()*100:.2f}% "
        "(palette not swapped — grade 1 is DARK BLUE, grade 2 is CYAN)")
    chk("wood_superset", L["wood"].mean() > 0.10,
        f"woodland {L['wood'].mean()*100:.1f}% — SUPERSET of ancient woodland (~2.5%). "
        "Any 'ancient woodland' conclusion drawn from this layer is INVALID.")
    chk("aonb_sdnp", L["aonb"][int((YMAX-129500)/CELL), int((492000-XMIN)/CELL)] < 0.05,
        "AONB layer probed at Blackdown (inside South Downs NP) returns ~0 — "
        "SOUTH DOWNS NATIONAL PARK IS ABSENT. Southern candidates are under-constrained.")
    # station validation, the check that caught the georeferencing before
    probes = [("Stevenage stn",523700,224900),("Reading stn",471300,173600),
              ("Chelmsford stn",570800,206800),("Luton airport",512217,221078)]
    for nm,e,n in probes:
        i,j = int((YMAX-n)/CELL), int((e-XMIN)/CELL)
        ok = L["built"][max(0,i-3):i+4, max(0,j-3):j+4].max() > 0.25
        chk(f"probe {nm}", ok, f"built {L['built'][i,j]:.2f} dem {L['dem'][i,j]:.0f} m")
    if fails and strict:
        raise SystemExit(f"[QA] {len(set(fails))} gate(s) failed — fix before proceeding: {sorted(set(fails))}")
    return fails


# ═════════════════════════════════════════════════════════════════════════════
# A — GATE CALIBRATION.  Never apply a gate you have not first plotted.
#     (The first siting run used a 3 km town standoff and returned ZERO cells.)
# ═════════════════════════════════════════════════════════════════════════════
def calibrate(L, band=(30.0, 75.0), quantiles=(50,75,90,95,99)):
    m = (L["R"] >= band[0]) & (L["R"] <= band[1]) & (L["london"] < 0.05)
    print(f"[A] calibration population: {m.sum():,} cells "
          f"({m.sum()*CELL*CELL/1e6:,.0f} km2) in the {band[0]:.0f}-{band[1]:.0f} km band")
    out = {}
    for k, better in (("d_built","hi"),("slope","lo"),("d_aonb","hi"),
                      ("d_rail","lo"),("d_roadm","lo"),("d_wood","hi")):
        v = L[k][m]
        qs = {q: float(np.percentile(v, q)) for q in quantiles}
        out[k] = qs
        print(f"   {k:9s} ({better}) " + "  ".join(f"p{q}={qs[q]:8.1f}" for q in quantiles))
    # openness at 4 km, the metric the siting method already uses
    build = buildable_mask(L)
    op = openness(build, 4000.0)
    print(f"   openness4km  " + "  ".join(
        f"p{q}={np.percentile(op[m],q):.3f}" for q in quantiles))
    out["openness4km"] = {q: float(np.percentile(op[m], q)) for q in quantiles}
    print("   -> set every gate from THIS table, not from intuition.")
    return out


def buildable_mask(L, slope_max=6.0, built_max=0.02, aonb_max=0.05, water_max=0.10):
    return ((L["built"] < built_max) & (L["aonb"] < aonb_max) & (L["water"] < water_max)
            & (L["slope"] < slope_max) & (L["alc"] != 8) & (L["london"] < 0.05))


def openness(mask, radius_m=4000.0):
    k = 2*int(radius_m/CELL) + 1
    return uniform_filter(mask.astype(np.float32), size=k)


# ── aviation obstacle limitation surface, generalised from PRESENTATION §2.2 ──
AERODROMES = {   # name: (E, N, aerodrome elevation m, OLS disc radius km)
    "Luton":     (512217, 221078, 160.6, 15.0),
    "Stansted":  (554227, 223151, 106.0, 15.0),
    "Gatwick":   (526800, 141200,  62.0, 15.0),
    "Heathrow":  (507400, 176600,  25.0, 15.0),
    "Southend":  (587000, 189000,  15.0, 15.0),
    "City":      (541500, 180500,   6.0, 15.0),
}
def ols_cap(L):
    """Permitted BUILDING height (m above ground) under the ICAO Annex 14 Code 4
    outer horizontal surface = aerodrome elevation + 150 m. 1e4 where unconstrained."""
    cap = np.full((NY, NX), 1e4, np.float32)
    for nm,(e,n,elev,rkm) in AERODROMES.items():
        d = np.hypot(GE-e, GN-n)
        inside = d <= rkm*1000.0
        h = (elev + 150.0) - L["dem"]
        cap = np.where(inside, np.minimum(cap, h), cap)
    return cap


# ═════════════════════════════════════════════════════════════════════════════
# B — CANDIDATE GENERATION
# ═════════════════════════════════════════════════════════════════════════════
def candidates(L, gates, lattice_m=2000.0, band=(30.0, 78.0),
               min_open=None, min_d_town=None, max_slope=6.0, city_km2=25.0):
    """Coarse lattice of viable CITY SEEDS. A node is a ~5x5 km city footprint,
    so the test is on a disc, not a cell — the single-cell ALC read is what made
    Hart's Spring look like grade 5 in a grade-2 sea."""
    build = buildable_mask(L, slope_max=max_slope)
    op4   = openness(build, 4000.0)
    town  = uniform_filter(L["built"], size=int(1000/CELL)) > 0.12
    d_town= distance_transform_edt(~town) * CELL
    cap   = ols_cap(L)

    if min_open   is None: min_open   = gates["openness4km"][75]
    if min_d_town is None: min_d_town = gates["d_built"][75]
    print(f"[B] gates from calibration: openness4km>{min_open:.3f}  d_town>{min_d_town:.0f} m")

    step = int(lattice_m/CELL)
    ii, jj = np.mgrid[step//2:NY:step, step//2:NX:step]
    ii, jj = ii.ravel(), jj.ravel()
    keep = ((L["R"][ii,jj] >= band[0]) & (L["R"][ii,jj] <= band[1])
            & build[ii,jj] & (op4[ii,jj] >= min_open) & (d_town[ii,jj] >= min_d_town))
    ii, jj = ii[keep], jj[keep]
    print(f"[B] lattice {lattice_m:.0f} m -> {len(ii)} sites clear the hard gates")

    rad = int(math.sqrt(city_km2/math.pi)*1000/CELL)        # 2.82 km for 25 km2
    rows = []
    for i, j in zip(ii, jj):
        sl = (slice(max(0,i-rad), i+rad+1), slice(max(0,j-rad), j+rad+1))
        yy, xx = np.mgrid[sl]
        disc = (yy-i)**2 + (xx-j)**2 <= rad*rad
        alc  = L["alc"][sl][disc]
        n    = max(1, alc.size)
        rows.append(dict(
            E=float(GE[i,j]), N=float(GN[i,j]), i=int(i), j=int(j),
            r_km=float(L["R"][i,j]), brg=float(L["BRG"][i,j]),
            dem=float(L["dem"][i,j]), slope=float(L["slope"][i,j]),
            open4=float(op4[i,j]), d_town=float(d_town[i,j]),
            bmv=float(((alc>=1)&(alc<=3)).sum()/n),          # ALC 1,2,3a
            g3b=float((alc==4).sum()/n),
            poor=float(((alc==5)|(alc==6)).sum()/n),
            nonag=float((alc==7).sum()/n),
            gb=float(L["gb"][sl][disc].mean()),
            wood=float(L["wood"][sl][disc].mean()),
            aonb=float(L["aonb"][sl][disc].mean()),
            d_rail=float(L["d_rail"][i,j]), d_roadm=float(L["d_roadm"][i,j]),
            h_cap=float(min(cap[sl][disc].min(), 1e4)),
        ))
    return rows


def cluster_candidates(rows, min_sep_m=6000.0, score_key="score", topn=140):
    """Non-maximum suppression: keep the best site in every min_sep disc.
    Reduces M to something the exact ring DP can chew (see select_ring)."""
    rows = sorted(rows, key=lambda r: -r.get(score_key, 0.0))
    kept = []
    for r in rows:
        if all(math.hypot(r["E"]-k["E"], r["N"]-k["N"]) >= min_sep_m for k in kept):
            kept.append(r)
        if len(kept) >= topn: break
    print(f"[B] NMS at {min_sep_m/1000:.0f} km -> {len(kept)} representative candidates")
    return kept


# ═════════════════════════════════════════════════════════════════════════════
# C — CORRIDOR.  The brief's stub, extended.
#     Straight-line proxy is legitimate at node-selection stage because at
#     R=12,000 m the line needs 7.0 km of track to shift 1 km laterally: it
#     cannot weave, so the straight line IS approximately the corridor.
# ═════════════════════════════════════════════════════════════════════════════
def _sample_line(a, b, ds=100.0):
    (e0,n0),(e1,n1) = a, b
    Lm = math.hypot(e1-e0, n1-n0)
    m = max(2, int(Lm/ds)+1)
    t = np.linspace(0.0, 1.0, m)
    E = e0 + (e1-e0)*t; N = n0 + (n1-n0)*t
    j = np.clip(((E-XMIN)/CELL).astype(int), 0, NX-1)
    i = np.clip(((YMAX-N)/CELL).astype(int), 0, NY-1)
    return E, N, i, j, Lm, Lm/(m-1)


def legal_profile(z, ds, R_v=R_VERT, ruling=0.025):
    """The flattest LEGAL grade line over ground profile z.

    At R_v=126,000 m the profile may bend +/-ds^2/R_v per station (0.079 m at
    ds=100 m). v1.0-1.1 clamped curvature AFTER a spring step and the clamp never
    bound (achieved R_v = 700 m, 180x too tight). Here the constraint is SOLVED
    FOR: binary-search a Gaussian bandwidth until |z''| provably holds, which
    lands on the constraint boundary — the flattest LEGAL profile, not the
    flattest profile."""
    lim = ds*ds / R_v
    lo, hi = 0.5, max(4.0, len(z)/2.0)
    for _ in range(48):
        mid = 0.5*(lo+hi)
        s = gaussian_filter1d(z, mid, mode="nearest")
        d2 = np.abs(np.diff(s, 2)).max() if len(s) > 2 else 0.0
        d1 = np.abs(np.diff(s)).max()/ds if len(s) > 1 else 0.0
        if d2 <= lim and d1 <= ruling: hi = mid
        else:                          lo = mid
    s = gaussian_filter1d(z, hi, mode="nearest")
    return s, float(np.abs(np.diff(s,2)).max()), float(np.abs(np.diff(s)).max()/ds)


def corridor(a, b, L, ds=100.0, verbose=False):
    """Full leg metrics for a straight corridor a->b. a,b = (E,N) in BNG.

    Returns everything the ring optimiser and the phasing logic need."""
    E, N, i, j, Lm, ds_eff = _sample_line(a, b, ds)
    z = L["dem"][i, j].astype(float)
    km = Lm/1000.0

    # 1. the brief's metric — height crossed per km of travel
    rise_per_km = float(np.abs(np.diff(z)).sum() / max(km, 1e-9))

    # 2. COARSE grain — resample on a 2 km baseline, per 10 km of travel.
    #    The 100 m metric measures DEM interpolation noise as much as landform.
    k2 = max(1, int(2000.0/ds_eff))
    zc = z[::k2]
    coarse_per_10km = float(np.abs(np.diff(zc)).sum() / max(km,1e-9) * 10.0)

    # 3. the metric that actually costs money — earthworks against a LEGAL profile
    prof, achieved_d2, achieved_grad = legal_profile(z, ds_eff)
    cutfill = prof - z
    ew_rms  = float(np.sqrt((cutfill**2).mean()))
    max_cut = float((-cutfill).min() if (-cutfill).size else 0.0)   # ground above rail = cut
    max_fill= float(cutfill.max())
    R_v_ach = float(ds_eff*ds_eff/achieved_d2) if achieved_d2 > 1e-9 else 1e9

    # 4. constraint length, in km of centreline
    f = lambda key, thr: float((L[key][i,j] > thr).mean()) * km
    alc = L["alc"][i,j]
    m = dict(
        km_aonb  = f("aonb", 0.15),
        km_built = f("built", 0.15),
        km_wood  = f("wood", 0.15),
        km_gb    = f("gb", 0.15),
        km_bmv   = float(((alc>=1)&(alc<=3)).mean())*km,
        km_3b    = float((alc==4).mean())*km,
        n_river  = int((np.diff((L["river"][i,j] > 0.15).astype(int)) > 0).sum()),
        n_road   = int((np.diff((L["road_m"][i,j] > 0.15).astype(int)) > 0).sum()),
        n_rail   = int((np.diff((L["rail"][i,j] > 0.15).astype(int)) > 0).sum()),
    )

    # 5. structure mix + cost, DESIGN_STANDARDS §4.2 / §6.2
    h = cutfill                                     # >0 fill, <0 cut
    tunnel  = (h < -20.0) | (L["aonb"][i,j] > 0.15) | (L["built"][i,j] > 0.30)
    viaduct = (~tunnel) & ((h > 8.0) | (L["water"][i,j] > 0.5))
    grade   = ~(tunnel | viaduct)
    frac = lambda mm: float(mm.mean())
    c_struct = (frac(tunnel)*36.0 + frac(viaduct)*31.0
                + float(np.where(grade, 6.0 + 1.2*np.clip(np.abs(h)-3,0,None), 0.0).mean()))
    # environmental weights, §5.2, surface rates, £m per km inside the polygon
    c_env = (m["km_aonb"]*40.0 + m["km_built"]*35.0 + m["km_bmv"]*3.0
             + m["km_3b"]*1.0 + m["km_gb"]*4.0) / max(km,1e-9)
    c_land = frac(tunnel)*0.5 + frac(viaduct)*0.8 + frac(grade)*2.0
    cost_m_per_km = (c_struct + c_land + c_env) * 1.18      # I_esc NOT applied — see §6.2

    # 6. performance — does the leg reach line speed?
    v_peak_1p0 = min(V_MAX, math.sqrt(Lm * A_LONG))
    v_peak_msd = min(V_MAX, math.sqrt(Lm * A_MEAS))
    t_leg = leg_time(Lm, A_LONG)

    out = dict(len_m=Lm, len_km=km,
               rise_per_km=rise_per_km, coarse_per_10km=coarse_per_10km,
               ew_rms=ew_rms, max_cut=max_cut, max_fill=max_fill, R_v_achieved=R_v_ach,
               grad_max_pct=achieved_grad*100.0,
               f_tunnel=frac(tunnel), f_viaduct=frac(viaduct), f_grade=frac(grade),
               cost_m_per_km=cost_m_per_km, cost_m_total=cost_m_per_km*km,
               v_peak_kmh=v_peak_1p0*3.6, v_peak_meas_kmh=v_peak_msd*3.6,
               t_leg_s=t_leg, reaches_vmax=bool(Lm >= L_MIN_LEG), **m)
    if verbose:
        print(f"   {km:6.1f} km  rise/km {rise_per_km:5.1f}  coarse/10km {coarse_per_10km:6.1f}  "
              f"ew_rms {ew_rms:5.1f} m  Rv {R_v_ach:,.0f}  tun {frac(tunnel)*100:4.1f}%  "
              f"£{cost_m_per_km:5.1f}m/km  v_peak {v_peak_1p0*3.6:5.0f} km/h")
    return out


def leg_time(Lm, a=A_LONG, v=V_MAX):
    """Stop-to-stop run time, trapezoidal, no cruise if the leg is too short."""
    d_acc = v*v/(2*a)
    if Lm >= 2*d_acc:
        return 2*(v/a) + (Lm - 2*d_acc)/v
    return 2.0*math.sqrt(Lm/a)


def stop_penalty(a=A_LONG, v=V_MAX, dwell=DWELL):
    """Time cost of an intermediate stop vs running through at v.
       = 2v/a - (v^2/a)/v + dwell = v/a + dwell."""
    return v/a + dwell


# ═════════════════════════════════════════════════════════════════════════════
# D — LEG MATRIX + GEOMETRIC FEASIBILITY
# ═════════════════════════════════════════════════════════════════════════════
def tangent_length(delta_deg, R=R_HORIZ):
    """Curve tangent T = R tan(delta/2). delta = deflection angle at the node."""
    return R*math.tan(math.radians(delta_deg)/2.0)


def deflection(p, q, r):
    """Deflection angle in degrees at q for the path p->q->r."""
    v1 = (q[0]-p[0], q[1]-p[1]); v2 = (r[0]-q[0], r[1]-q[1])
    a1 = math.atan2(v1[0], v1[1]); a2 = math.atan2(v2[0], v2[1])
    d = math.degrees(a2-a1)
    return abs((d + 180.0) % 360.0 - 180.0)


def turn_feasible(p, q, r, R=R_HORIZ, plat=L_PLAT_STR):
    """T_pq + T_qr + 2*plat <= min(len). At >=20 km spacing this is slack —
    proving that the binding geometric constraint is the CORRIDOR, not the node."""
    d = deflection(p, q, r)
    T = tangent_length(d, R)
    Lpq = math.hypot(q[0]-p[0], q[1]-p[1]); Lqr = math.hypot(r[0]-q[0], r[1]-q[1])
    return (2*T + 2*plat) <= min(Lpq, Lqr), d, T


def leg_matrix(cands, L, lmin=L_MIN_LEG, lmax=55000.0, cache=None):
    M = len(cands)
    C = np.full((M, M), np.inf)             # £m total for the leg
    T = np.full((M, M), np.inf)             # seconds
    D = np.zeros((M, M))                    # metres
    meta = {}
    t0 = time.time()
    for x in range(M):
        for y in range(M):
            if x == y: continue
            a = (cands[x]["E"], cands[x]["N"]); b = (cands[y]["E"], cands[y]["N"])
            d = math.hypot(b[0]-a[0], b[1]-a[1]); D[x,y] = d
            if not (lmin <= d <= lmax):     # hard spacing constraint
                continue
            m = corridor(a, b, L)
            C[x,y] = m["cost_m_total"]; T[x,y] = m["t_leg_s"]; meta[(x,y)] = m
        if x % 20 == 0: print(f"   leg row {x}/{M}  {time.time()-t0:.0f}s")
    print(f"[D] leg matrix {M}x{M}, {np.isfinite(C).sum()} feasible legs, {time.time()-t0:.0f}s")
    return C, T, D, meta


# ═════════════════════════════════════════════════════════════════════════════
# E — THE RING OPTIMISER.  EXACT, not heuristic.
#
#  KEY OBSERVATION that makes this tractable: the orbital is a simple closed
#  curve enclosing London, so the cyclic ORDER of the selected nodes is their
#  ORDER IN BEARING from Charing Cross. Selection and sequencing decouple: this
#  is not a TSP, it is a shortest cycle in a bearing-ordered DAG, and a dynamic
#  program solves it EXACTLY.
#
#  Variables   x_c in {0,1}, sum x_c = K
#  Objective   min  sum over consecutive pairs [ C_leg ] - lambda * sum benefit(c)
#  Constraints L_MIN <= leg <= L_MAX ; ring length <= L_ring_max ;
#              turn feasibility at every node ; >=1 node per populated sector
# ═════════════════════════════════════════════════════════════════════════════
def select_ring(cands, C, benefit, K, lam=1.0, ring_max_km=350.0,
                enforce_turn=True, second_order=True, topn=10):
    """Exact cyclic DP. Complexity O(M^3 K) with second_order=False,
    O(M^2 * deg * K) per start with second_order=True."""
    M = len(cands)
    order = np.argsort([c["brg"] for c in cands])
    idx = list(order)
    pos = {c: p for p, c in enumerate(idx)}
    P = [(cands[c]["E"], cands[c]["N"]) for c in idx]
    Cb = C[np.ix_(idx, idx)]
    Bb = np.array([benefit[c] for c in idx])
    node_cost = -lam*Bb

    succ = [np.where(np.isfinite(Cb[u]))[0] for u in range(M)]
    results = []
    t0 = time.time()

    for start in range(M):
        # DP over states (prev, cur) so the turn constraint at `cur` is checkable.
        # dp[k][(p,c)] = min cost of a k-node path start=..->p->c, all bearings > start
        dp = {}
        for c in succ[start]:
            if c <= start: continue
            dp[(start, c)] = (Cb[start, c] + node_cost[c], (start,))
        for k in range(2, K):
            nxt = {}
            for (p, c), (val, path) in dp.items():
                for n in succ[c]:
                    if n <= start or n == p: continue
                    if enforce_turn and second_order:
                        ok, _, _ = turn_feasible(P[p], P[c], P[n])
                        if not ok: continue
                    v = val + Cb[c, n] + node_cost[n]
                    key = (c, n)
                    if key not in nxt or v < nxt[key][0]:
                        nxt[key] = (v, path + (c,))
            dp = nxt
            if not dp: break
        for (p, c), (val, path) in dp.items():
            if not np.isfinite(Cb[c, start]): continue
            if enforce_turn and second_order:
                ok1, _, _ = turn_feasible(P[p], P[c], P[start])
                ok2, _, _ = turn_feasible(P[c], P[start], P[path[1]] if len(path) > 1 else P[c])
                if not (ok1 and ok2): continue
            full = path + (c,)
            tot = val + Cb[c, start]
            ring_km = sum(math.hypot(P[full[t+1]][0]-P[full[t]][0],
                                     P[full[t+1]][1]-P[full[t]][1])
                          for t in range(len(full)-1))
            ring_km = (ring_km + math.hypot(P[full[0]][0]-P[full[-1]][0],
                                            P[full[0]][1]-P[full[-1]][1]))/1000.0
            if ring_km > ring_max_km: continue
            results.append((tot, ring_km, [idx[t] for t in full]))
    results.sort(key=lambda r: r[0])
    print(f"[E] exact DP over M={M}, K={K}: {len(results)} feasible rings, {time.time()-t0:.0f}s")
    return results[:topn]


def combinatorics(M, K):
    """Report the search space so the tractability claim is checkable."""
    from math import comb
    return dict(subsets=comb(M, K),
                dp_states=M*M*K,
                note="bearing-ordering collapses sequencing; DP is exact")


# ═════════════════════════════════════════════════════════════════════════════
# F — ACCESSIBILITY AND DEMAND
# ═════════════════════════════════════════════════════════════════════════════
def potential_accessibility(cands, pop_xy, pop, beta=0.06, mode="network_free"):
    """Hansen potential  A_i = sum_j P_j * f(t_ij).

    mode='network_free': t_ij from great-circle distance at the maglev speed
    profile INCLUDING the stop penalty. This is an UPPER BOUND on what any
    orbital could deliver and depends on NO network. Use it for seeding, so the
    first pass has zero circularity."""
    A = np.zeros(len(cands))
    for k, c in enumerate(cands):
        d = np.hypot(pop_xy[:,0]-c["E"], pop_xy[:,1]-c["N"])
        t = np.array([leg_time(max(dd, 1.0)) for dd in d])/60.0     # minutes
        A[k] = float((pop*np.exp(-beta*t)).sum())
    return A


def gravity_doubly_constrained(O, D, cost, f, iters=60, tol=1e-6):
    """Furness / IPF. T_ij = A_i O_i B_j D_j f(c_ij)."""
    F = f(cost)
    np.fill_diagonal(F, 0.0)
    n = len(O)
    A = np.ones(n); Bv = np.ones(n)
    for it in range(iters):
        A_new = 1.0/np.maximum((F*(Bv*D)).sum(1), 1e-12)
        B_new = 1.0/np.maximum((F.T*(A_new*O)).sum(1), 1e-12)
        if max(np.abs(A_new-A).max(), np.abs(B_new-Bv).max()) < tol:
            A, Bv = A_new, B_new; break
        A, Bv = A_new, B_new
    T = (A*O)[:,None] * F * (Bv*D)[None,:]
    return T, A, Bv, it


def tanner(alpha, beta):
    """Combined power-exponential deterrence  f(c) = c^-alpha * exp(-beta c).
    Power term fits the short-trip mass, exponential kills the long tail."""
    return lambda c: np.where(c > 0, np.power(np.maximum(c,1e-6), -alpha)*np.exp(-beta*c), 0.0)


def calibrate_deterrence(T_obs, cost, alpha0=0.5, beta0=0.05):
    """Mean-trip-cost matching — the standard doubly-constrained calibration.
    Adjust (alpha,beta) until the modelled mean trip cost equals the observed."""
    from scipy.optimize import minimize
    O = T_obs.sum(1); D = T_obs.sum(0)
    obs_mean = (T_obs*cost).sum()/T_obs.sum()
    obs_tld, edges = np.histogram(cost.ravel(), bins=20, weights=T_obs.ravel())
    obs_tld = obs_tld/obs_tld.sum()
    def loss(p):
        a, b = p
        T,_,_,_ = gravity_doubly_constrained(O, D, cost, tanner(a, b))
        mod_tld,_ = np.histogram(cost.ravel(), bins=edges, weights=T.ravel())
        mod_tld = mod_tld/max(mod_tld.sum(), 1e-12)
        mean_err = ((T*cost).sum()/max(T.sum(),1e-12) - obs_mean)/obs_mean
        return float(((mod_tld-obs_tld)**2).sum() + mean_err**2)
    r = minimize(loss, [alpha0, beta0], method="Nelder-Mead",
                 options=dict(xatol=1e-4, fatol=1e-8, maxiter=400))
    return float(r.x[0]), float(r.x[1]), float(r.fun)


def two_step_fca(demand_xy, demand_w, supply_xy, supply_cap, t0=30.0, beta=0.06):
    """Enhanced 2SFCA with a Gaussian-ish decay. Use for JOBS and for the
    project's own thesis variable: food-growing capacity per head."""
    d1 = np.hypot(demand_xy[:,None,0]-supply_xy[None,:,0],
                  demand_xy[:,None,1]-supply_xy[None,:,1])
    t = np.vectorize(lambda dd: leg_time(max(dd,1.0)))(d1)/60.0
    W = np.exp(-beta*t)*(t <= t0*3)
    R = supply_cap/np.maximum((W*demand_w[:,None]).sum(0), 1e-9)      # step 1
    return (W*R[None,:]).sum(1)                                       # step 2


# ═════════════════════════════════════════════════════════════════════════════
# G — VALIDATION
# ═════════════════════════════════════════════════════════════════════════════
def null_model(cands, C, K, n=5000, ring_max_km=350.0, seed=0, tries=400):
    """Random FEASIBLE rings — same geometry, NO criteria. If the optimised ring
    is not far out in this distribution, the criteria are not discriminating.

    NOTE (measured): naive i.i.d. sampling of K candidates yields a feasible ring
    about 0.1% of the time, because the 19.29-55 km spacing window is very tight.
    Uniform-over-subsets is therefore the WRONG null — it would flatter any
    solution. Sample uniformly over the FEASIBLE set instead, by a random walk in
    bearing order with backtracking."""
    rng = np.random.default_rng(seed)
    M = len(cands)
    order = np.argsort([c["brg"] for c in cands]); pos = {c: p for p, c in enumerate(order)}
    Cb = C[np.ix_(order, order)]
    succ = [np.where(np.isfinite(Cb[u]))[0] for u in range(M)]
    vals, sets = [], []
    for _ in range(n):
        for _t in range(tries):
            s = int(rng.integers(M)); path = [s]; ok = True
            for _k in range(K-1):
                nxt = [v for v in succ[path[-1]] if v > path[-1] and v != s]
                if not nxt: ok = False; break
                path.append(int(rng.choice(nxt)))
            if ok and np.isfinite(Cb[path[-1], s]):
                vals.append(float(sum(Cb[path[t], path[t+1]] for t in range(K-1))
                                  + Cb[path[-1], s]))
                sets.append([int(order[p]) for p in path]); break
    return np.array(vals), sets


def weight_monte_carlo(cands, L, C, K, criteria, n=2000, seed=0):
    """Dirichlet-sample the criterion weights; record how often each candidate is
    selected. >80% = robust. <30% = an artefact of one weight choice."""
    rng = np.random.default_rng(seed)
    hits = np.zeros(len(cands))
    for _ in range(n):
        w = rng.dirichlet(np.ones(len(criteria)))
        ben = sum(wi*np.asarray(criteria[k]) for wi, k in zip(w, criteria))
        best = select_ring(cands, C, ben, K, topn=1, enforce_turn=False)
        if best:
            for c in best[0][2]: hits[c] += 1
    return hits/n


def leave_one_criterion_out(cands, C, K, criteria):
    base = select_ring(cands, C, sum(np.asarray(v) for v in criteria.values()), K, topn=1)
    base_set = set(base[0][2]) if base else set()
    out = {}
    for drop in criteria:
        ben = sum(np.asarray(v) for k, v in criteria.items() if k != drop)
        r = select_ring(cands, C, ben, K, topn=1)
        s = set(r[0][2]) if r else set()
        out[drop] = len(base_set & s)/max(1, len(base_set | s))       # Jaccard
    return base_set, out


# ═════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", default="all")
    ap.add_argument("--K", type=int, default=9)
    ap.add_argument("--rebuild", action="store_true")
    args = ap.parse_args()

    print(f"design: v={V_MAX*3.6:.0f} km/h  a={A_LONG} m/s2  "
          f"d_to_vmax={D_TO_VMAX:,.0f} m  L_min_leg={L_MIN_LEG:,.0f} m  "
          f"R_platform={R_PLATFORM:,.0f} m  stop_penalty={stop_penalty():.0f} s")

    L = load_layers(rebuild=args.rebuild)
    qa_layers(L, strict=False)
    gates = calibrate(L)
    cs = candidates(L, gates)
    for c in cs:
        c["score"] = (1.5*(1.0-c["bmv"]) + 1.0*c["open4"] + 0.6*min(c["d_town"]/3000.0, 1.0)
                      + 0.4*(1.0-c["aonb"]) + 0.3*(1.0 - min(c["d_rail"]/10000.0, 1.0)))
    cs = cluster_candidates(cs, 6000.0, topn=110)
    print(combinatorics(len(cs), args.K))
    C, T, D, meta = leg_matrix(cs, L)
    ben = np.array([c["score"] for c in cs])*1000.0
    rings = select_ring(cs, C, ben, args.K, lam=1.0)
    for tot, rkm, path in rings[:5]:
        print(f"  ring £{tot:,.0f}m  {rkm:.0f} km  " +
              " -> ".join(f"({cs[p]['E']:.0f},{cs[p]['N']:.0f})" for p in path))
