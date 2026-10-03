"""Journey times for the four service patterns on the canonical loop.

Exact mirror of js/engine.js speedProfile:
  - resample to 25 m, curvature over a +/-8-sample (200 m) chord
  - curve speed via the MAGLEV bank form  v = sqrt((aq + g sin th) R / cos th),
    th = 12 deg (MbBO 13(3)), aq = 0.63 m/s2 (ISO comfort level 2)  -- NOT the
    wheel-rail cant formula
  - vmax 750 km/h, accel = brake = 1.5 m/s2, forward/backward sqrt passes
  - every call pinned to v = 0; dwell 60 s at each intermediate call
Nothing here is new modelling -- it is the app's model run headlessly.
"""
import os, sys, json, math
import numpy as np
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE=os.path.dirname(os.path.abspath(__file__)); os.chdir(HERE)
OUT=os.path.abspath(os.path.join(HERE,"..","out"))
from solve_loop import NODES

VMAX=750/3.6; ACC=1.5; BRK=1.5; DWELL=60.0
TH=math.radians(12.0); AQ=0.63; G=9.81

raw=np.load((lambda p: p if os.path.exists(p) else os.path.join(OUT,"loop_P.npy"))(os.path.join(OUT,"loop_P_rect.npy")))
# --- resample to 25 m (mirror engine.resample) ---
seg=np.hypot(*(raw[1:]-raw[:-1]).T); cum=np.concatenate([[0],np.cumsum(seg)]); TOT=cum[-1]
s=np.arange(0,TOT,25.0)
E=np.interp(s,cum,raw[:,0]); N=np.interp(s,cum,raw[:,1])
if s[-1]<TOT: s=np.append(s,TOT); E=np.append(E,raw[-1,0]); N=np.append(N,raw[-1,1])
n=len(s); L=s[-1]; ds=L/(n-1)
# --- curvature, span 8 (mirror engine.curvature) ---
R=np.full(n,np.inf); k=8
ax,ay=E[:-2*k],N[:-2*k]; bx,by=E[k:-k],N[k:-k]; cx,cy=E[2*k:],N[2*k:]
cross=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax); A=np.abs(cross)/2
la=np.hypot(bx-ax,by-ay); lb=np.hypot(cx-bx,cy-by); lc=np.hypot(cx-ax,cy-ay)
with np.errstate(divide="ignore",invalid="ignore"):
    Rm=np.where(A>1e-6, la*lb*lc/(4*A), np.inf)
R[k:-k]=Rm; R[:k]=R[k]; R[-k:]=R[-k-1]
# --- per-point curve speed limit (maglev bank form) ---
vlim=np.minimum(VMAX, np.sqrt(np.maximum(0,(AQ+G*math.sin(TH))*np.abs(R)/math.cos(TH))))
# --- station chainages ---
chain={}
for nm,tp,e,nn in NODES:
    chain[nm]=(float(s[int(np.hypot(E-e,N-nn).argmin())]),tp)
PRI=[nm for nm,tp,_,_ in NODES if tp=="primary"]
SEC=[nm for nm,tp,_,_ in NODES if tp=="secondary"]
AIR=[nm for nm,tp,_,_ in NODES if tp=="airport"]

def lap(names,label):
    stops=sorted(chain[nm][0] for nm in names)
    ss=[0.0]+[x for x in stops if x>1]+([] if stops and stops[-1]>L-1 else [L])
    idx=sorted(set(max(0,min(n-1,round(x/ds))) for x in ss))
    # dedupe stops closer than 500 m (loop origin can appear at both chainage ends)
    ded=[idx[0]]
    for x in idx[1:]:
        if x-ded[-1]>max(1,round(500/ds)): ded.append(x)
    idx=ded
    v=vlim.copy()
    for i in idx: v[i]=0.0
    for i in range(1,n):      v[i]=min(v[i],math.sqrt(v[i-1]**2+2*ACC*ds))
    for i in range(n-2,-1,-1):v[i]=min(v[i],math.sqrt(v[i+1]**2+2*BRK*ds))
    vm=np.maximum(0.5,(v[1:]+v[:-1])/2); t=np.concatenate([[0],np.cumsum(ds/vm)])
    run=t[-1]; dw=DWELL*max(0,len(idx)-2); tot=run+dw
    segs=[]
    order=sorted(names,key=lambda nm:chain[nm][0])
    for q in range(len(idx)-1):
        i0,i1=idx[q],idx[q+1]
        a=order[q] if q<len(order) else order[0]
        b=order[q+1] if q+1<len(order) else order[0]
        segs.append((a,b,(s[i1]-s[i0])/1000,(t[i1]-t[i0])/60,v[i0:i1+1].max()*3.6))
    return dict(label=label,calls=len(names),run=run,dwell=dw,total=tot,
                avg=L/tot*3.6,peak=v.max()*3.6,segs=segs)

pats=[(PRI,"6 nodes - primaries only"),
      (PRI+AIR,"9 nodes - primaries + airports"),
      (PRI+SEC,"14 nodes - primaries + secondaries"),
      (PRI+SEC+AIR,"17 nodes - all stations")]
res=[lap(nm,lab) for nm,lab in pats]
print(f"loop {L/1000:.1f} km · vmax 750 km/h · a=b=1.5 m/s2 · dwell {DWELL:.0f}s · "
      f"curve limit: maglev 12deg bank, aq 0.63\n")
print(f"{'pattern':<36}{'calls':>6}{'run':>9}{'dwell':>8}{'TOTAL':>9}{'avg':>7}{'peak':>7}")
for r in res:
    print(f"{r['label']:<36}{r['calls']:>6}{r['run']/60:>8.1f}m{r['dwell']/60:>7.1f}m"
          f"{r['total']/60:>8.1f}m{r['avg']:>6.0f}{r['peak']:>7.0f}")
print()
for r in res[:2]:
    print(r["label"],"— station to station:")
    for a,b,km,mn,pk in r["segs"]:
        print(f"   {a:>3} -> {b:<3} {km:6.1f} km {mn:6.2f} min  peak {pk:4.0f} km/h")
    print()
json.dump([{k:(v if k!='segs' else [list(x) for x in v]) for k,v in r.items()} for r in res],
          open(os.path.join(OUT,"journey_times.json"),"w"), indent=1)
print("wrote out/journey_times.json")
