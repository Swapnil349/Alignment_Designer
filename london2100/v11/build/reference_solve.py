"""
Reference implementation of the alignment engine, mirroring js/engine.js exactly.

Purpose: validate the curvature-constrained search, the vertical profile fit and
the structure classification against real data before wiring a UI around them,
and produce the Phase 1 corridor figure for the presentation.
"""
import os, sys, math, heapq, json, time
import numpy as np
from PIL import Image, ImageDraw
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
Image.MAX_IMAGE_PIXELS = None

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
MAPS = os.path.join(ROOT, "Maps")
OUT  = os.path.abspath(os.path.join(HERE, "..", "out")); os.makedirs(OUT, exist_ok=True)

XMIN, YMAX = 452768.07604494085535407, 246487.60653909383108839
CELL = 100.0; NX, NY = 1500, 1230
MPP = 25.4; PXMM = 300/25.4; FX0, FY0 = 50*PXMM, 20*PXMM

# ── load the same grids the app uses (from the build cache + rebuilt layers) ──
sys.path.insert(0, HERE)
import build_grids as B

DEM = np.load(os.path.join(HERE, "_dem_cache.npy"))
gy, gx = np.gradient(DEM, CELL); SLOPE = np.hypot(gx, gy)*100.0
LAY = {
    "aonb":      B.raster_coverage("02_AONB.png"),
    "greenbelt": B.raster_coverage("01_Green Belt.png"),
    "built":     B.raster_coverage("Built.png"),
    "woodland":  B.raster_coverage("woodland.png"),
    "london":    B.raster_coverage("London.png"),
}
ALC = B.raster_class("Agriculture.png", {1:(86,125,162),2:(182,227,232),3:(149,195,140),
    4:(204,226,136),5:(255,225,127),6:(255,153,58),7:(115,109,105),8:(216,153,153)})
LAY["water_body"]  = B.rasterize_polys("surfacewater").astype(np.float32)
LAY["river_major"] = B.rasterize_lines("waterlines",1,"AND t.type IN ('National','Regional')").astype(np.float32)
LAY["road_major"]  = B.rasterize_lines("roads_national",1).astype(np.float32)
LAY["road_a"]      = B.rasterize_lines("roads_regional",1,"AND t.type='A Road'").astype(np.float32)
LAY["rail"]        = B.rasterize_lines("rail",1).astype(np.float32)
from scipy.ndimage import distance_transform_edt
wm = LAY["river_major"] > .15
dmaj = distance_transform_edt(~wm)*CELL
ii = distance_transform_edt(~wm, return_distances=False, return_indices=True)
LAY["flood_proxy"] = ((DEM - DEM[tuple(ii)] < 4.0) & (dmaj < 1200)).astype(np.float32)

W = dict(rMin=12000, stride=1100, maxGrade=2.5, vCurveR=126000, builtUp=55, aonb=40,
         woodland=22, flood=10, slope=4, river=14, road=6, rail=5, alcBMV=8,
         greenBelt=-2, turn=55, london=120,
         terrGrade=14, terrUndul=3.0, terrWindow=1200)
T = dict(fillViaduct=8, cutTunnel=15, builtTunnel=.18, aonbTunnel=.50, woodTunnel=.60)

def e2ix(E): return int((E - XMIN)//CELL)
def n2iy(N): return int((YMAX - N)//CELL)

def cell_cost(E, N):
    ix, iy = e2ix(E), n2iy(N)
    if not (0 <= ix < NX and 0 <= iy < NY): return 1e6
    c = 1.0
    c += LAY["built"][iy,ix]*W["builtUp"]
    c += LAY["aonb"][iy,ix]*W["aonb"]
    c += LAY["woodland"][iy,ix]*W["woodland"]
    c += LAY["flood_proxy"][iy,ix]*W["flood"]
    c += LAY["london"][iy,ix]*W["london"]
    c += min(SLOPE[iy,ix],25)*W["slope"]*0.1
    c += LAY["river_major"][iy,ix]*W["river"]
    c += LAY["water_body"][iy,ix]*W["river"]*0.8
    c += LAY["road_major"][iy,ix]*W["road"]
    c += LAY["road_a"][iy,ix]*W["road"]*0.45
    c += LAY["rail"][iy,ix]*W["rail"]
    g = ALC[iy,ix]
    if g in (1,2,3): c += W["alcBMV"]
    c += LAY["greenbelt"][iy,ix]*W["greenBelt"]
    return max(0.05, c)

NH = 72; DB = 2*math.pi/NH

def arc_step(x,y,th,dth,L):
    if abs(dth) < 1e-9: return x+L*math.cos(th), y+L*math.sin(th), th
    R = L/dth
    cx, cy = x - R*math.sin(th), y + R*math.cos(th)
    t2 = th+dth
    return cx + R*math.sin(t2), cy - R*math.cos(t2), t2

def terrain_step_cost(x, y, th, dth, L):
    """Cost of the GROUND along the direction of travel.

    The point-slope penalty cannot tell a contour-following alignment from one
    driving straight up a hillside - they cost the same. This does. It samples
    the ground over a window longer than the step (because the vertical profile
    is stiff over ~2.5 km), fits the best straight grade, and charges for:
      (a) the along-track gradient  - pushes the route into valleys and makes
          ridge crossings seek the lowest col
      (b) the RMS residual about that grade - the undulation a stiff profile
          cannot follow, i.e. the cut and fill it will cost
    """
    ext = W["terrWindow"]; N = 9
    ts = np.linspace(-ext, L+ext, N); zs = np.empty(N)
    ex, ey, eth = arc_step(x, y, th, dth, L)
    for i, t in enumerate(ts):
        if t < 0:      px, py = x + t*math.cos(th),   y + t*math.sin(th)
        elif t > L:    px, py = ex + (t-L)*math.cos(eth), ey + (t-L)*math.sin(eth)
        else:          px, py, _ = arc_step(x, y, th, dth*(t/L), t)
        zs[i] = bilinear(DEM, px, py)
    b1, b0 = np.polyfit(ts, zs, 1)
    grade_pct = abs(b1)*100.0
    resid = float(np.sqrt(((zs - (b0 + b1*ts))**2).mean()))
    return W["terrGrade"]*grade_pct + W["terrUndul"]*resid


def search(a, b):
    stride = W["stride"]
    maxB = max(1, int(stride/W["rMin"]/DB))
    rAch = stride/(maxB*DB)
    print(f"  stride {stride} m, {maxB} bucket(s)/step -> guaranteed R >= {rAch:,.0f} m")
    margin = max(9000, math.hypot(b[0]-a[0], b[1]-a[1])*0.30)
    X0,X1 = min(a[0],b[0])-margin, max(a[0],b[0])+margin
    Y0,Y1 = min(a[1],b[1])-margin, max(a[1],b[1])+margin
    res = stride/2
    GW = int(math.ceil((X1-X0)/res)); GH = int(math.ceil((Y1-Y0)/res))
    print(f"  lattice {GW} x {GH} x {NH} = {GW*GH*NH/1e6:.2f}M states")
    # state = (cell, heading, last turn direction).  The last-turn dimension exists
    # so a left arc cannot run straight into a right arc: reverse curves must be
    # separated by at least one straight step. Without it the alignment contains
    # tangent-free reversals, which have no radius at the join and leave nowhere
    # to place the transition curves.
    NT = 3                                   # lastTurn: 0 = left, 1 = straight, 2 = right
    def key(x,y,h,lt):
        ix = int((x-X0)//res); iy = int((y-Y0)//res)
        if ix<0 or iy<0 or ix>=GW or iy>=GH: return -1
        return ((iy*GW+ix)*NH+h)*NT+lt
    NS = GW*GH*NH*NT
    gS = np.full(NS, np.inf, np.float32)
    came = np.full(NS, -1, np.int32)
    SX = np.zeros(NS, np.float32); SY = np.zeros(NS, np.float32)
    heur = lambda x,y: math.hypot(b[0]-x, b[1]-y)*0.9
    pq = []
    bearing = math.atan2(b[1]-a[1], b[0]-a[0])
    for h in range(NH):
        d = abs(((h*DB - bearing + 3*math.pi) % (2*math.pi)) - math.pi)
        if d > 0.9: continue
        s = key(a[0],a[1],h,1)
        if s < 0: continue
        gS[s]=0; SX[s]=a[0]; SY[s]=a[1]
        heapq.heappush(pq,(heur(a[0],a[1]), s))
    goalR = stride*0.5; best=-1; exp=0; t0=time.time()
    while pq:
        _, s = heapq.heappop(pq)
        x,y = SX[s], SY[s]
        h = (s//NT) % NH; lt = s % NT
        exp += 1
        if math.hypot(b[0]-x, b[1]-y) < goalR: best=s; break
        gc = gS[s]
        th = h*DB
        for db in range(-maxB, maxB+1):
            lt2 = 1 if db == 0 else (0 if db > 0 else 2)
            # forbid a direct left<->right reversal
            if lt != 1 and lt2 != 1 and lt2 != lt: continue
            dth = db*DB
            nx2, ny2, th2 = arc_step(x,y,th,dth,stride)
            h2 = int(round(th2/DB)) % NH
            s2 = key(nx2,ny2,h2,lt2)
            if s2 < 0: continue
            acc = 0.0; NSAMP=7
            for i in range(1,NSAMP+1):
                f=i/NSAMP
                sx,sy,_ = arc_step(x,y,th,dth*f,stride*f)
                acc += cell_cost(sx,sy)
            step = (acc/NSAMP)*stride
            step += terrain_step_cost(x, y, th, dth, stride)*stride*0.01
            if db != 0: step += W["turn"]*stride*0.01*abs(db)
            ng = gc + step
            if ng < gS[s2]:
                gS[s2]=ng; came[s2]=s; SX[s2]=nx2; SY[s2]=ny2
                heapq.heappush(pq,(ng+heur(nx2,ny2), s2))
    print(f"  expanded {exp:,} states in {time.time()-t0:.1f}s")
    if best < 0: return None
    chain=[]
    s=best
    while s>=0:
        chain.append((SX[s],SY[s],int((s//NT)%NH))); s=came[s]
    chain.reverse()
    pts=[(chain[0][0],chain[0][1])]
    for i in range(1,len(chain)):
        px,py,ph = chain[i-1]; _,_,qh = chain[i]
        db = qh-ph
        while db >  NH//2: db -= NH
        while db < -NH//2: db += NH
        dth = db*DB; th = ph*DB
        SUB=28
        for k in range(1,SUB+1):
            f=k/SUB
            ax,ay,_ = arc_step(px,py,th,dth*f,stride*f)
            pts.append((ax,ay))
    # NB: the exact target is deliberately NOT appended. Joining the last lattice
    # state to it with a straight chord injects a corner the search never proposed
    # and destroys the radius guarantee. The alignment terminates where the
    # geometry naturally arrives; the residual offset is reported instead, and the
    # station is sited on the alignment.
    endGap = math.hypot(pts[-1][0]-b[0], pts[-1][1]-b[1])
    return np.array(pts), rAch, endGap

def resample(pts, step):
    cum=[0.0]
    for i in range(1,len(pts)):
        cum.append(cum[-1]+math.hypot(*(pts[i]-pts[i-1])))
    total=cum[-1]; out=[]; j=0
    s=0.0
    while s <= total:
        while j < len(cum)-2 and cum[j+1] < s: j+=1
        seg=cum[j+1]-cum[j]; f=(s-cum[j])/seg if seg>1e-9 else 0
        out.append((pts[j][0]+(pts[j+1][0]-pts[j][0])*f,
                    pts[j][1]+(pts[j+1][1]-pts[j][1])*f, s))
        s+=step
    out.append((pts[-1][0],pts[-1][1],total))
    return np.array(out)

def curvature(P, span=4):
    n=len(P); R=np.full(n, np.inf)
    for i in range(span,n-span):
        a,bb,c = P[i-span,:2],P[i,:2],P[i+span,:2]
        cr=(bb[0]-a[0])*(c[1]-a[1])-(bb[1]-a[1])*(c[0]-a[0])
        A=abs(cr)/2
        if A<1e-6: continue
        la=np.hypot(*(bb-a)); lb=np.hypot(*(c-bb)); lc=np.hypot(*(c-a))
        R[i]=math.copysign((la*lb*lc)/(4*A), cr)
    R[:span]=R[span]; R[-span:]=R[-span-1]
    return R

def bilinear(A,E,N):
    fx=(E-XMIN)/CELL-0.5; fy=(YMAX-N)/CELL-0.5
    x0,y0=int(math.floor(fx)),int(math.floor(fy)); tx,ty=fx-x0,fy-y0
    def g(x,y): return A[max(0,min(NY-1,y)), max(0,min(NX-1,x))]
    return (g(x0,y0)*(1-tx)+g(x0+1,y0)*tx)*(1-ty)+(g(x0,y0+1)*(1-tx)+g(x0+1,y0+1)*tx)*ty

def vertical(P):
    """Project the ground onto {|z''| <= ds^2/Rv} and {|z'| <= ruling gradient}.

    Binary-search a smoothing bandwidth until the curvature constraint holds.
    The previous spring-to-ground formulation had a characteristic length of
    ds/sqrt(2*pull) = 72 m, so the rail copied the terrain and the curvature
    clamp never bound (achieved 700 m against a 126,000 m target)."""
    from scipy.ndimage import gaussian_filter1d
    n=len(P); ds=(P[-1,2]-P[0,2])/(n-1)
    ground=np.array([bilinear(DEM,P[i,0],P[i,1]) for i in range(n)])
    lim=W["maxGrade"]/100*ds
    def clamp(z):
        z=z.copy()
        for _ in range(200):
            ch=False
            for i in range(1,n):
                d=z[i]-z[i-1]
                if abs(d)>lim: z[i]=z[i-1]+math.copysign(lim,d); ch=True
            for i in range(n-2,-1,-1):
                d=z[i]-z[i+1]
                if abs(d)>lim: z[i]=z[i+1]+math.copysign(lim,d); ch=True
            if not ch: break
        return z
    def minRv(z):
        c=np.abs(z[:-2]-2*z[1:-1]+z[2:]).max()
        return ds*ds/c if c>1e-12 else np.inf
    trial=lambda sig: clamp(gaussian_filter1d(ground,sig/ds,mode='nearest'))
    lo,hi=ds,40000.0
    if minRv(trial(hi))<W["vCurveR"]: lo=hi
    else:
        for _ in range(50):
            mid=(lo+hi)/2
            if minRv(trial(mid))>=W["vCurveR"]: hi=mid
            else: lo=mid
    z=trial(hi)
    grade=np.gradient(z,ds)*100
    print(f"  vertical fit: sigma {hi:,.0f} m -> achieved Rv {minRv(z):,.0f} m "
          f"(target {W['vCurveR']:,.0f})")
    return z, ground, grade, z-ground, ds

STRUCTS=[("tunnel","#5b4636"),("viaduct","#1d4ed8"),("bridge","#0891b2"),
         ("embankment","#b06a3b"),("cutting","#8a6d3b"),("atgrade","#6b7280")]
def classify(P, diff, ds):
    out=[]
    for i in range(len(P)):
        E,N=P[i,0],P[i,1]; d=diff[i]
        ix,iy=e2ix(E),n2iy(N)
        ix=max(0,min(NX-1,ix)); iy=max(0,min(NY-1,iy))
        built=LAY["built"][iy,ix]; aonb=LAY["aonb"][iy,ix]; wood=LAY["woodland"][iy,ix]
        river=LAY["river_major"][iy,ix]+LAY["water_body"][iy,ix]
        if built>=T["builtTunnel"] or aonb>=T["aonbTunnel"] or wood>=T["woodTunnel"]: s="tunnel"
        elif -d>=T["cutTunnel"]: s="tunnel"
        elif river>0.05 and d>-2: s="bridge"
        elif d>=T["fillViaduct"]: s="viaduct"
        elif d>=1.5: s="embankment"
        elif d<=-1.5: s="cutting"
        else: s="atgrade"
        out.append(s)
    minRun=max(2,int(round(200/ds)))
    i=0
    while i<len(out):
        j=i
        while j<len(out) and out[j]==out[i]: j+=1
        if j-i<minRun and i>0:
            for k in range(i,j): out[k]=out[i-1]
        i=j
    return out

def speed_profile(P,R,vmax_kmh=500,a=1.0,brake=1.0,D=200,I=130):
    n=len(P); ds=(P[-1,2]-P[0,2])/(n-1)
    vmax=vmax_kmh/3.6
    v=np.minimum(vmax, np.where(np.isfinite(R), np.sqrt(np.abs(R)*(D+I)/11.8)/3.6, np.inf))
    v[0]=0; v[-1]=0
    for i in range(1,n): v[i]=min(v[i], math.sqrt(v[i-1]**2+2*a*ds))
    for i in range(n-2,-1,-1): v[i]=min(v[i], math.sqrt(v[i+1]**2+2*brake*ds))
    Tt=0.0; t=np.zeros(n)
    for i in range(1,n):
        vm=max(0.5,(v[i]+v[i-1])/2); Tt+=ds/vm; t[i]=Tt
    return v,t,Tt

# ══════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    N1 = (473887.0, 218604.0)   # Quainton / Waddesdon, on HS2
    N2 = (520517.0, 220678.0)   # St Paul's Walden, Luton node
    print(f"\nPHASE 1 CORRIDOR   straight-line {math.hypot(N2[0]-N1[0],N2[1]-N1[1])/1000:.2f} km")
    res = search(N1, N2)
    if res is None: print("NO PATH"); sys.exit(1)
    raw, rAch, endGap = res
    P = resample(raw, 25.0)
    R = curvature(P, span=8)
    z, ground, grade, diff, ds = vertical(P)
    structs = classify(P, diff, ds)
    v, t, T = speed_profile(P, R)

    L = P[-1,2]
    finite = R[np.isfinite(R)]
    print(f"\n  length            {L/1000:.2f} km   (straight line {math.hypot(N2[0]-N1[0],N2[1]-N1[1])/1000:.2f} km, "
          f"+{(L/math.hypot(N2[0]-N1[0],N2[1]-N1[1])-1)*100:.1f}%)")
    rmin = np.abs(finite).min()
    ok = "OK" if rmin >= W['rMin']*0.97 else "*** VIOLATION ***"
    print(f"  min |radius|      {rmin:,.0f} m   (design minimum {W['rMin']:,} m)  {ok}")
    print(f"  terminal offset   {endGap:.0f} m from the nominal node position")
    print(f"  max |gradient|    {np.abs(grade).max():.2f} %   (ruling {W['maxGrade']} %)")
    print(f"  max fill          {diff.max():.1f} m      max cut {(-diff).max():.1f} m")
    print(f"  earthworks RMS    {np.sqrt((diff**2).mean()):.2f} m")
    from collections import Counter
    cc = Counter(structs)
    print("  structure mix:")
    for k,_ in STRUCTS:
        if cc[k]: print(f"     {k:11} {cc[k]*ds/1000:6.2f} km  {cc[k]/len(structs)*100:5.1f}%")
    print(f"  journey time      {T/60:.2f} min   avg {L/T*3.6:.0f} km/h   peak {v.max()*3.6:.0f} km/h")

    # analytical comparison
    print("\n  trapezoidal check over this length:")
    d=L
    for vk in (400,500,600,700):
        for acc in (0.7,1.0,1.3):
            V=vk/3.6; da=V*V/(2*acc)
            if 2*da<=d:
                tt=2*V/acc+(d-2*da)/V; reach=vk
            else:
                Vp=math.sqrt(d*acc); tt=2*Vp/acc; reach=Vp*3.6
            print(f"     vmax {vk:4d} a={acc:.1f}  ->  {tt/60:5.2f} min   avg {d/tt*3.6:5.0f} km/h   reached {reach:5.0f}")
        print()

    np.save(os.path.join(OUT,"align_P.npy"), P)
    json.dump({"length":float(L),"minR":float(np.abs(finite).min()),
               "maxGrade":float(np.abs(grade).max()),"time_s":float(T),
               "avg_kmh":float(L/T*3.6),"peak_kmh":float(v.max()*3.6),
               "structures":{k:float(cc[k]*ds) for k,_ in STRUCTS}},
              open(os.path.join(OUT,"align_summary.json"),"w"), indent=2)

    # ── figure ────────────────────────────────────────────────────────────────
    base = Image.open(os.path.join(MAPS,"Overlay2.png")).convert("RGB")
    def b2p(E,N): return (FX0+(E-XMIN)/MPP, FY0+(YMAX-N)/MPP)
    pad=6000
    x0,y0 = b2p(min(N1[0],N2[0])-pad, max(N1[1],N2[1])+pad)
    x1,y1 = b2p(max(N1[0],N2[0])+pad, min(N1[1],N2[1])-pad)
    box=(int(x0),int(y0),int(x1),int(y1))
    crop=base.crop(box); SC=2400/crop.size[0]
    crop=crop.resize((2400,int(crop.size[1]*SC)))
    dr=ImageDraw.Draw(crop,"RGBA")
    def to(E,N):
        px,py=b2p(E,N); return ((px-box[0])*SC,(py-box[1])*SC)
    COL=dict(STRUCTS)
    for i in range(1,len(P)):
        dr.line([to(P[i-1,0],P[i-1,1]),to(P[i,0],P[i,1])],
                fill=(255,255,255,190), width=11)
    for i in range(1,len(P)):
        c=COL[structs[i]]
        rgb=tuple(int(c[k:k+2],16) for k in (1,3,5))
        dr.line([to(P[i-1,0],P[i-1,1]),to(P[i,0],P[i,1])], fill=rgb+(255,), width=6)
    for nm,pt in (("N1 Quainton (HS2)",N1),("N2 St Paul's Walden",N2)):
        x,y=to(*pt)
        dr.ellipse([x-15,y-15,x+15,y+15],fill=(20,20,20,255),outline=(255,255,255,255),width=4)
    crop.save(os.path.join(OUT,"phase1_alignment.png"))
    print(f"\n  wrote out/phase1_alignment.png")
