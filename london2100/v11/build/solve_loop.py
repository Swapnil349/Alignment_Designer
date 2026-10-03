"""Route the FULL 16-node closed loop and render it. Runs standalone in Python so
it does not depend on the browser. Mirrors js/engine.js searchLoop exactly:
  · position + heading continuity through every station
  · exit cone centred on the TURN BISECTOR, widened with the turn
  · NO silent free-heading fallback — a leg that cannot be routed is REPORTED
"""
import os, sys, math, heapq, time, json
import numpy as np
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from scipy.ndimage import uniform_filter, gaussian_filter, distance_transform_edt
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE=os.path.dirname(os.path.abspath(__file__)); os.chdir(HERE); sys.path.insert(0,HERE)
import build_grids as B
OUT=os.path.abspath(os.path.join(HERE,"..","out")); os.makedirs(OUT,exist_ok=True)

CELL=100.; XMIN,YMAX=452768.076,246487.607; NX,NY=1500,1230
DEM=np.load("_dem_cache.npy")
gy,gx=np.gradient(DEM,CELL); SLOPE=np.hypot(gx,gy)*100
L={}
L["aonb"]=B.raster_coverage("02_AONB.png"); L["greenbelt"]=B.raster_coverage("01_Green Belt.png")
L["built"]=B.raster_coverage("Built.png");  L["woodland"]=B.raster_coverage("woodland.png")
L["london"]=B.raster_coverage("London.png")
ALC=B.raster_class("Agriculture.png",{1:(86,125,162),2:(182,227,232),3:(149,195,140),
  4:(204,226,136),5:(255,225,127),6:(255,153,58),7:(115,109,105),8:(216,153,153)})
L["water_body"]=B.rasterize_polys("surfacewater").astype(np.float32)
L["river_major"]=B.rasterize_lines("waterlines",1,"AND t.type IN ('National','Regional')").astype(np.float32)
L["road_major"]=B.rasterize_lines("roads_national",1).astype(np.float32)
L["road_a"]=B.rasterize_lines("roads_regional",1,"AND t.type='A Road'").astype(np.float32)
L["rail"]=B.rasterize_lines("rail",1).astype(np.float32)
wm=L["river_major"]>.15
ii=distance_transform_edt(~wm,return_distances=False,return_indices=True)
dmaj=distance_transform_edt(~wm)*CELL
L["flood_proxy"]=((DEM-DEM[tuple(ii)]<4.0)&(dmaj<1200)).astype(np.float32)

W=dict(rMin=8552, stride=800, maxGrade=2.5, vCurveR=126000, builtUp=55, aonb=40,
       woodland=22, flood=10, slope=4, river=14, road=6, rail=5, alcBMV=8,
       greenBelt=-2, turn=55, london=120, terrGrade=14, terrUndul=3.0, terrWindow=1200)

NODES=[("P1","primary",473591.,218706.),("S1","secondary",496763.,230576.),
 # A3 = Luton interchange (MMIP change station, not on the airport itself):
 # ~4.9 km N of the LTN 07/25 runway centreline, laterally clear of both approach
 # funnels, sited to soften the S1->P2 southward detour to a ~74 deg turn.
 ("A3","airport",511500.,225500.),
 ("P2","primary",519056.,237573.),("S2","secondary",540813.,232549.),
 ("A1","airport",555782.,224537.),("P3","primary",569135.,218706.),
 ("S3","secondary",576254.,198136.),("P4","primary",560784.,175255.),
 ("S4","secondary",571361.,151727.),("P5","primary",540647.,147408.),
 ("A2","airport",529403.,140943.),("S5","secondary",509240.,132096.),
 ("S6","secondary",478759.,132724.),("P6","primary",473199.,154269.),
 ("S7","secondary",461960.,166039.),("S8","secondary",465066.,198257.)]

ix=lambda E:int((E-XMIN)//CELL); iy=lambda N:int((YMAX-N)//CELL)
def cell_cost(E,N):
    j,i=ix(E),iy(N)
    if not(0<=j<NX and 0<=i<NY): return 1e6
    c=1.0
    c+=L["built"][i,j]*W["builtUp"]; c+=L["aonb"][i,j]*W["aonb"]
    c+=L["woodland"][i,j]*W["woodland"]; c+=L["flood_proxy"][i,j]*W["flood"]
    c+=L["london"][i,j]*W["london"]; c+=min(SLOPE[i,j],25)*W["slope"]*0.1
    c+=L["river_major"][i,j]*W["river"]; c+=L["water_body"][i,j]*W["river"]*0.8
    c+=L["road_major"][i,j]*W["road"]; c+=L["road_a"][i,j]*W["road"]*0.45
    c+=L["rail"][i,j]*W["rail"]
    if ALC[i,j] in (1,2,3): c+=W["alcBMV"]
    c+=L["greenbelt"][i,j]*W["greenBelt"]
    return max(0.05,c)
def bilinear(A,E,N):
    fx=(E-XMIN)/CELL-0.5; fy=(YMAX-N)/CELL-0.5
    x0,y0=int(math.floor(fx)),int(math.floor(fy)); tx,ty=fx-x0,fy-y0
    g=lambda x,y:A[max(0,min(NY-1,y)),max(0,min(NX-1,x))]
    return (g(x0,y0)*(1-tx)+g(x0+1,y0)*tx)*(1-ty)+(g(x0,y0+1)*(1-tx)+g(x0+1,y0+1)*tx)*ty

NH=72; DB=2*math.pi/NH
def arc(x,y,th,dth,Lm):
    if abs(dth)<1e-9: return x+Lm*math.cos(th), y+Lm*math.sin(th), th
    R=Lm/dth; cx,cy=x-R*math.sin(th), y+R*math.cos(th); t2=th+dth
    return cx+R*math.sin(t2), cy-R*math.cos(t2), t2
def terr_cost(x,y,th,dth,Lm):
    ext=W["terrWindow"]; n=9
    ex,ey,eth=arc(x,y,th,dth,Lm)
    ts=np.linspace(-ext,Lm+ext,n); zs=np.empty(n)
    for k,t in enumerate(ts):
        if t<0: px,py=x+t*math.cos(th), y+t*math.sin(th)
        elif t>Lm: px,py=ex+(t-Lm)*math.cos(eth), ey+(t-Lm)*math.sin(eth)
        else: px,py,_=arc(x,y,th,dth*(t/Lm),t)
        zs[k]=bilinear(DEM,px,py)
    b1,b0=np.polyfit(ts,zs,1)
    return W["terrGrade"]*abs(b1)*100 + W["terrUndul"]*float(np.sqrt(((zs-(b0+b1*ts))**2).mean()))

def search(a,b,seed=None,exit_toward=None,cone0=0.62,center="bisector",stride_o=None):
    """stride_o overrides the search stride for THIS leg. stride 500 -> guaranteed
       R >= 5,730 m: the local station-approach radius for the Luton chicane, worth
       ~450 km/h under the maglev bank formula. Everywhere else: 800 -> R 9,167."""
    stride=stride_o if stride_o else W["stride"]; maxB=max(1,int(stride/W["rMin"]/DB))
    margin=max(11000, math.hypot(b[0]-a[0],b[1]-a[1])*0.38)
    X0,X1=min(a[0],b[0])-margin, max(a[0],b[0])+margin
    Y0,Y1=min(a[1],b[1])-margin, max(a[1],b[1])+margin
    res=stride/2
    GW=int(math.ceil((X1-X0)/res)); GH=int(math.ceil((Y1-Y0)/res)); NT=3
    def key(x,y,h,lt):
        jx=int((x-X0)//res); jy=int((y-Y0)//res)
        if jx<0 or jy<0 or jx>=GW or jy>=GH: return -1
        return ((jy*GW+jx)*NH+h)*NT+lt
    NS=GW*GH*NH*NT
    gS=np.full(NS,np.inf,np.float32); came=np.full(NS,-1,np.int32)
    SX=np.zeros(NS,np.float32); SY=np.zeros(NS,np.float32)
    heur=lambda x,y: math.hypot(b[0]-x,b[1]-y)*0.9
    exitB=None; cone=cone0
    if exit_toward is not None:
        inB=math.atan2(b[1]-a[1],b[0]-a[0]); outB=math.atan2(exit_toward[1]-b[1],exit_toward[0]-b[0])
        turn=outB-inB
        while turn>math.pi: turn-=2*math.pi
        while turn<-math.pi: turn+=2*math.pi
        # center="full" arrives having absorbed the WHOLE turn (chicane case: the
        # next node reverses the turn, so any unfinished rotation at b is lateral
        # offset the following leg cannot recover at the design radius).
        # center="bisector" arrives half-turned. cone0 < 0.5 disables the widening.
        exitB=inB+(turn if center=="full" else turn/2)
        if cone0>=0.5: cone=max(cone0, abs(turn)/2+0.35)
    def hok(h):
        if exitB is None: return True
        d=abs(((h*DB-exitB+3*math.pi)%(2*math.pi))-math.pi); return d<=cone
    pq=[]; bearing=math.atan2(b[1]-a[1],b[0]-a[0])
    if seed is not None:
        s=key(a[0],a[1],seed%NH,1)
        if s>=0: gS[s]=0; SX[s]=a[0]; SY[s]=a[1]; heapq.heappush(pq,(heur(*a),s))
    else:
        for h in range(NH):
            if abs(((h*DB-bearing+3*math.pi)%(2*math.pi))-math.pi)>0.9: continue
            s=key(a[0],a[1],h,1)
            if s<0: continue
            gS[s]=0; SX[s]=a[0]; SY[s]=a[1]; heapq.heappush(pq,(heur(*a),s))
    goalR=stride*0.5; best=-1; exp=0
    while pq:
        _,s=heapq.heappop(pq)
        x,y=SX[s],SY[s]; h=(s//NT)%NH; lt=s%NT; exp+=1
        if math.hypot(b[0]-x,b[1]-y)<goalR and hok(h): best=s; break
        gc=gS[s]; th=h*DB
        for db in range(-maxB,maxB+1):
            lt2=1 if db==0 else (0 if db>0 else 2)
            if lt!=1 and lt2!=1 and lt2!=lt: continue
            dth=db*DB; nx2,ny2,th2=arc(x,y,th,dth,stride)
            h2=int(round(th2/DB))%NH; s2=key(nx2,ny2,h2,lt2)
            if s2<0: continue
            acc=0.0
            for q in range(1,8):
                f=q/7; sx,sy,_=arc(x,y,th,dth*f,stride*f); acc+=cell_cost(sx,sy)
            step=(acc/7)*stride + terr_cost(x,y,th,dth,stride)*stride*0.01
            if db!=0: step+=W["turn"]*stride*0.01*abs(db)
            ng=gc+step
            if ng<gS[s2]:
                gS[s2]=ng; came[s2]=s; SX[s2]=nx2; SY[s2]=ny2
                heapq.heappush(pq,(ng+heur(nx2,ny2),s2))
    if best<0: return None
    chain=[]; s=best
    while s>=0: chain.append((SX[s],SY[s],int((s//NT)%NH))); s=came[s]
    chain.reverse()
    pts=[(chain[0][0],chain[0][1])]
    for k in range(1,len(chain)):
        px,py,ph=chain[k-1]; qh=chain[k][2]
        d=qh-ph
        while d>NH//2: d-=NH
        while d<-NH//2: d+=NH
        dth=d*DB; th=ph*DB
        for q in range(1,29):
            f=q/28; ax,ay,_=arc(px,py,th,dth*f,stride*f); pts.append((ax,ay))
    return dict(pts=np.array(pts), endH=chain[-1][2], exp=exp,
                gap=math.hypot(pts[-1][0]-b[0],pts[-1][1]-b[1]))

if __name__=="__main__":
    t00=time.time()
    print(f"FULL LOOP  R>={W['rMin']} m  stride {W['stride']} m  "
          f"guaranteed R >= {W['stride']/(max(1,int(W['stride']/W['rMin']/DB))*DB):,.0f} m\n", flush=True)
    seq=NODES+[NODES[0]]
    """Two passes. Pass 1 leaves P1 on a free heading, so where the loop closes the
       arrival heading and the departure heading need not agree — a kink at the seam.
       Pass 2 feeds pass 1's arrival heading back in as the departure heading, so the
       circuit is continuous in heading all the way round, including at P1."""
    seed0=None; legs=None; failed=None
    for p in range(2):
        legs=[]; failed=[]; seed=seed0; start=(NODES[0][2],NODES[0][3])
        print(f"  -- pass {p+1}/2" + ("" if seed0 is None else f"  (seam heading {seed0})"), flush=True)
        for k in range(len(seq)-1):
            a=start; bn=seq[k+1]; b=(bn[2],bn[3])
            cn=seq[k+2] if k+2<len(seq) else seq[1]
            t0=time.time()
            """Sharp station turns (A3, S4): a greedy straight approach dumps the whole
               double-turn into the NEXT leg, where it cannot fit at R 9,167 m — the
               A3->P2 leg ballooned to 88.8 km (+518%). First attempt therefore forces
               arrival ON the turn bisector (cone 0.35) so half the turn happens on the
               approach; the wide-cone search remains as the fallback."""
            inB=math.atan2(b[1]-a[1],b[0]-a[0]); outB=math.atan2(cn[3]-b[1],cn[2]-b[0])
            turn=outB-inB
            while turn>math.pi: turn-=2*math.pi
            while turn<-math.pi: turn+=2*math.pi
            # look one further ahead: does the turn REVERSE at the next node?
            dn=seq[k+3] if k+3<len(seq) else seq[k+3-(len(seq)-1)]
            outB2=math.atan2(dn[3]-cn[3],dn[2]-cn[2])
            turn2=outB2-outB
            while turn2>math.pi: turn2-=2*math.pi
            while turn2<-math.pi: turn2+=2*math.pi
            """The Luton chicane (+77 deg at A3, -71 deg at P2, 14 km apart) is
               GEOMETRICALLY infeasible at R 9,167: A3 lies 9.26 km off the S1-P2
               chord and the out-and-back needs ~26 km of longitudinal room where
               only 23.4 exists. Local station-approach radius instead — stride 500
               (R >= 5,730 m, ~450 km/h) on the two legs touching A3, exactly the
               HS2-into-Euston pattern. Everything else stays at R 9,167."""
            astride=500 if "A3" in (seq[k][0],bn[0]) else None
            # attempt ladder, all heading-continuous; a "success" longer than
            # 1.6 x direct + 8 km is a balloon and falls through to the next rung
            attempts=[]
            if 0.9<abs(turn)<1.6:
                if turn*turn2<0 and abs(turn2)>0.9:
                    attempts.append(dict(cone0=0.35,center="full"))
                attempts.append(dict(cone0=0.35))
            attempts.append(dict())
            directm=math.hypot(b[0]-a[0],b[1]-a[1])
            r=None; best=None
            for at in attempts:
                cand=search(a,b,seed,(cn[2],cn[3]),stride_o=astride,**at)
                if cand is None: continue
                Lp=float(np.hypot(*(cand["pts"][1:]-cand["pts"][:-1]).T).sum())
                if best is None or Lp<best[0]: best=(Lp,cand)
                if Lp<directm*1.6+8000: r=cand; break
                print(f"    ({seq[k][0]}->{bn[0]}: attempt {at or 'wide'} ballooned "
                      f"to {Lp/1000:.1f} km, trying next)",flush=True)
            if r is None and best is not None:
                print(f"    ({seq[k][0]}->{bn[0]}: ALL attempts ballooned; keeping "
                      f"shortest {best[0]/1000:.1f} km)",flush=True)
                r=best[1]
            if r is None:
                r=search(a,b,seed,None,stride_o=astride)   # drop the exit constraint
                if r is None:                       # NO free-heading fallback: that is
                                                    # what silently injected the kink
                    print(f"  {seq[k][0]}->{bn[0]}  *** CANNOT ROUTE with heading "
                          f"continuity — reporting, not faking ***", flush=True)
                    failed.append(f"{seq[k][0]}->{bn[0]}"); sys.exit(2)
            Lkm=np.hypot(*(r["pts"][1:]-r["pts"][:-1]).T).sum()/1000
            direct=math.hypot(b[0]-a[0],b[1]-a[1])/1000
            print(f"  {seq[k][0]:>2}->{bn[0]:<2} {Lkm:6.1f} km ({(Lkm/direct-1)*100:+5.0f}%)  "
                  f"gap {r['gap']:4.0f} m  {r['exp']:7,} states  {time.time()-t0:5.1f}s", flush=True)
            legs.append(r); seed=r["endH"]; start=(r["pts"][-1][0], r["pts"][-1][1])
        seed0=legs[-1]["endH"]
    # stitch: leg 0 whole, every later leg minus its duplicated first point
    P=np.vstack([legs[0]["pts"]]+[l["pts"][1:] for l in legs[1:]])
    seg=np.hypot(*(P[1:]-P[:-1]).T); total=seg.sum()
    closure=float(np.hypot(P[-1,0]-P[0,0], P[-1,1]-P[0,1]))
    print(f"\n  LOOP {total/1000:.1f} km, {len(P):,} points, closure gap {closure:.0f} m, "
          f"{time.time()-t00:.0f}s total")
    if failed: print("  legs without heading continuity:", ", ".join(failed))
    np.save(os.path.join(OUT,"loop_P.npy"), P)
    json.dump({"length_km":float(total/1000),"closure_m":closure,"failed":failed,
               "legs":[{"from":seq[k][0],"to":seq[k+1][0],
                        "km":float(np.hypot(*(legs[k]['pts'][1:]-legs[k]['pts'][:-1]).T).sum()/1000),
                        "gap":float(legs[k]['gap'])} for k in range(len(legs))]},
              open(os.path.join(OUT,"loop_summary.json"),"w"), indent=1)
    print("  wrote out/loop_P.npy + loop_summary.json")
