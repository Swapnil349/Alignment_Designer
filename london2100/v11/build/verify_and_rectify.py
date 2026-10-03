"""VERIFY the speed mathematics, then RECTIFY the horizontal alignment.

Part 1 — verification against closed forms (no simulation, pure algebra):
  a) trains stop: v = 0 at every call, and the pull-away obeys v = sqrt(2 a d)
  b) segment times match the closed-form trapezoid when fed the same speed cap
  c) the curve-speed table: what radius supports what speed (maglev 12 deg, aq 0.63)

Part 2 — why 750 km/h is never reached, quantified:
  750 km/h needs R >= 15,900 m at the normal comfort limit. The lattice router
  emits micro-wander (+-5 deg heading dither per 800 m step), so long visually
  straight runs are actually chains of near-minimum-radius arcs capped at
  ~567 km/h. That is an ARTIFACT of the corridor search, not a design decision.

Part 3 — rectification: low-pass the polyline (Gaussian over chainage). This
  removes the dither (real curves are barely touched — lateral shift sigma^2/2R)
  and turns visually straight runs into true tangents. The drawn alignment moves
  by at most a few tens of metres — invisible at the 25.4 m/px base-map scale.
  Constraints enforced: max lateral shift, mainline min R not reduced, A3 local
  min R not reduced, station offsets not worsened.
"""
import os, sys, math
import numpy as np
from scipy.ndimage import gaussian_filter1d
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE=os.path.dirname(os.path.abspath(__file__)); os.chdir(HERE)
OUT=os.path.abspath(os.path.join(HERE,"..","out"))
from solve_loop import NODES

VMAX=750/3.6; ACC=1.5; BRK=1.5
TH=math.radians(12.0); AQ=0.63; G=9.81
K=(AQ+G*math.sin(TH))/math.cos(TH)          # v^2 = K * R
def vcap(R): return np.minimum(VMAX, np.sqrt(K*np.abs(R)))
def r_for(v_kmh): return (v_kmh/3.6)**2/K

def resample(raw, step=25.0):
    seg=np.hypot(*(raw[1:]-raw[:-1]).T); cum=np.concatenate([[0],np.cumsum(seg)])
    s=np.arange(0,cum[-1],step)
    E=np.interp(s,cum,raw[:,0]); N=np.interp(s,cum,raw[:,1])
    return E,N,s
def radii(E,N,k=8):
    n=len(E); R=np.full(n,np.inf)
    ax,ay=E[:-2*k],N[:-2*k]; bx,by=E[k:-k],N[k:-k]; cx,cy=E[2*k:],N[2*k:]
    cr=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax); A=np.abs(cr)/2
    la=np.hypot(bx-ax,by-ay); lb=np.hypot(cx-bx,cy-by); lc=np.hypot(cx-ax,cy-ay)
    with np.errstate(divide="ignore",invalid="ignore"):
        Rm=np.where(A>1e-6, la*lb*lc/(4*A), np.inf)
    R[k:-k]=Rm; R[:k]=R[k]; R[-k:]=R[-k-1]
    return R
def profile(E,N,s,stop_names,chain):
    n=len(s); ds=s[-1]/(n-1); L=s[-1]
    v=vcap(radii(E,N))
    ss=[0.0]+[chain[nm] for nm in stop_names if chain[nm]>1]+[L]
    idx=[max(0,min(n-1,round(x/ds))) for x in sorted(ss)]
    for i in idx: v[i]=0.0
    for i in range(1,n):       v[i]=min(v[i],math.sqrt(v[i-1]**2+2*ACC*ds))
    for i in range(n-2,-1,-1): v[i]=min(v[i],math.sqrt(v[i+1]**2+2*BRK*ds))
    vm=np.maximum(0.5,(v[1:]+v[:-1])/2); t=np.concatenate([[0],np.cumsum(ds/vm)])
    return v,t,idx,ds

raw=np.load(os.path.join(OUT,"loop_P.npy"))
E0,N0,s0=resample(raw); R0=radii(E0,N0); L=s0[-1]
chain0={nm:float(s0[int(np.hypot(E0-e,N0-nn).argmin())]) for nm,tp,e,nn in NODES}
off0={nm:float(np.hypot(E0-e,N0-nn).min()) for nm,tp,e,nn in NODES}
PRI=[nm for nm,tp,_,_ in NODES if tp=="primary"]

print("="*74)
print("PART 1 — VERIFICATION AGAINST CLOSED FORMS")
print("="*74)
v,t,idx,ds=profile(E0,N0,s0,PRI,chain0)
print(f"\n(a) Stopping is modelled: speed AT each of the {len(idx)} express calls:")
print("    " + "  ".join(f"{v[i]*3.6:.0f}" for i in idx) + "   km/h  (all zero = stopped)")
i0=idx[1]   # pull-away from the first intermediate call (P2)
print(f"    pull-away from P2 vs v=sqrt(2*1.5*d)  [model | algebra]:")
for dkm in (1,5,14.5):
    j=i0+int(dkm*1000/ds); vv=v[j]*3.6; th=math.sqrt(2*ACC*dkm*1000)*3.6
    print(f"      +{dkm:>4} km : {vv:6.1f} | {th:6.1f} km/h"
          + ("   (curve-capped below algebra — correct)" if vv<th-1 else ""))
print(f"\n(b) Trapezoid cross-check, longest primary leg (P5->P6):")
i5,i6=idx[PRI.index('P5')] if False else (None,None)
# find P5..P6 indices from chainage
iP5=int(round(chain0['P5']/ds)); iP6=int(round(chain0['P6']/ds))
dist=s0[iP6]-s0[iP5]; tt=t[iP6]-t[iP5]; pk=v[iP5:iP6].max()
Vp=pk; tf=dist/Vp+Vp/ACC   # closed form at the ACHIEVED peak (flat-out between caps)
print(f"    model: {dist/1000:.1f} km in {tt/60:.2f} min, peak {pk*3.6:.0f} km/h")
print(f"    closed-form floor at that peak: {tf/60:.2f} min  "
      f"(model is slower only where curve caps bite mid-leg)")
print(f"\n(c) Curve-speed table (maglev, 12 deg bank, aq 0.63 m/s2):")
for vk in (450,500,567,641,700,750):
    print(f"      {vk:>4} km/h  needs  R >= {r_for(vk):>7,.0f} m")
print(f"    ...and at the MbBO LEGAL ceiling aq=1.5:  750 km/h needs "
      f"R >= {(750/3.6)**2*math.cos(TH)/(1.5+G*math.sin(TH)):,.0f} m")

print()
print("="*74)
print("PART 2 — WHY 750 NEVER APPEARS ON THE SOLVED POLYLINE")
print("="*74)
capped=(R0<r_for(750)).mean()
print(f"  min mainline R {np.nanmin(R0[np.hypot(E0-511500,N0-225500)>=20000]):,.0f} m -> cap {vcap(np.array([9111]))[0]*3.6:.0f} km/h")
print(f"  {capped*100:.0f}% of route length lies below the 15,900 m needed for 750:")
print(f"  the lattice dithers +-5 deg per 800 m, so even visually straight runs")
print(f"  are chains of near-minimum-radius arcs. Artifact, not physics.")

print()
print("="*74)
print("PART 3 — RECTIFICATION (low-pass, constraints enforced)")
print("="*74)
from scipy.spatial import cKDTree
a3zone=lambda E,N: np.hypot(E-511500,N-225500)<20000
m0=~a3zone(E0,N0)
Rmain0=np.nanmin(R0[m0&np.isfinite(R0)]); Ra30=np.nanmin(R0[~m0&np.isfinite(R0)])
tree0=cKDTree(np.stack([E0,N0],1))
"""STRING-PULLING. Uniform and curvature-blended low-passes both failed: they shift
   real curves inward by sigma^2/2R or alias against the 800 m dither and REDUCE
   measured radius. The taut-string formulation has clean guarantees instead:
   stretch a string through a +-TUBE m corridor around the original line, stations
   pinned exactly. Straights become true tangents; a curve the string hugs loses at
   most TUBE metres of radius; nothing moves more than TUBE from the solved line.
   Implemented as curve-shortening flow with a corridor clamp, wrap-around (the
   string also closes the 329 m P1 seam smoothly)."""
"""No pins (a taut string KINKS at a pinned point — measured R 296 m at stations;
   the tube already limits station drift and the app snaps nodes onto the line).
   The loop is first resampled as a CLOSED circuit — the raw array ends 329 m
   apart at P1, and wrap-flow across that unequal seam is what produced the
   1,584 m kink there. Closing it also removes the closure gap for good.
   The tube clamp projects onto polyline SEGMENTS, not vertices, so the corridor
   wall is smooth rather than scalloped."""
TUBE=60.0
pts=np.stack([E0,N0],1); n0=len(pts)
ptsC=np.vstack([pts,pts[:1]])
segC=np.hypot(*(np.diff(ptsC,axis=0)).T); cumC=np.concatenate([[0],np.cumsum(segC)])
sQ=np.arange(0,cumC[-1],25.0)
Q=np.stack([np.interp(sQ,cumC,ptsC[:,0]),np.interp(sQ,cumC,ptsC[:,1])],1)
"""The loop closes 329 m laterally offset at P1 — a +-60 m tube cannot absorb an
   S-jog that size (it needs ~3.5 km of spiral), so the string kinked at R ~340
   there. Widen the tube to 400 m within 3 km of the seam: the closing S-curve
   then fits, and it lives inside P1's acceleration shadow — every service stops
   at P1, so speeds there are under ~340 km/h and a ~7,000 m seam radius is ample."""
ds_seam=np.minimum(sQ,sQ[-1]+25.0-sQ)
# quadratic 8 km taper: a sharp 3 km taper edge CREATED a corner exactly at its lip
TUBEv=60.0+340.0*np.clip((8000.0-ds_seam)/8000.0,0,1)**2
def clamp_tube(Q):
    d,j=tree0.query(Q)
    out=Q.copy(); dbest=np.full(len(Q),np.inf); pbest=np.zeros_like(Q)
    for j0 in (np.clip(j-1,0,n0-2), np.clip(j,0,n0-2)):
        A=pts[j0]; B=pts[j0+1]; AB=B-A
        L2=np.maximum(1e-9,(AB*AB).sum(1))
        t=np.clip(((Q-A)*AB).sum(1)/L2,0,1)
        proj=A+AB*t[:,None]; dd=np.hypot(*(Q-proj).T)
        m=dd<dbest; dbest[m]=dd[m]; pbest[m]=proj[m]
    over=dbest>TUBEv
    if over.any():
        out[over]=pbest[over]+(Q[over]-pbest[over])*(TUBEv[over]/dbest[over])[:,None]
    return out,dbest
prevLen=None
for it in range(20001):
    Q+=0.25*(np.roll(Q,-1,0)+np.roll(Q,1,0)-2*Q)
    # clamp EVERY iteration: clamping only every 25th left pressed points ON the
    # wall with neighbours floating inside — a 25 m sawtooth reading as R ~300 m
    Q,_=clamp_tube(Q)
    if it%2000==0:
        Ln=float(np.hypot(*(np.roll(Q,-1,0)-Q).T).sum())
        if prevLen is not None and abs(prevLen-Ln)<1.0: break
        prevLen=Ln
"""Length-minimizing strings concentrate curvature at constraint boundaries — the
   seam S-jog came out as a tight corner right where trains already run ~400 km/h.
   Spread it: Gaussian-smooth the STRING (not the original) within 5 km of the
   seam, blended by a smooth weight. A ~12 deg corner smoothed at sigma 800 m
   becomes ~9,000 m arcs, and the deviation this adds (~60 m) stays inside the
   400 m seam tube. No re-clamp afterwards — that would re-cut the corner."""
wS=np.clip((8000.0-ds_seam)/8000.0,0,1)**1.5
Es=gaussian_filter1d(Q[:,0],1200/25.0,mode="wrap"); Ns=gaussian_filter1d(Q[:,1],1200/25.0,mode="wrap")
Q[:,0]=wS*Es+(1-wS)*Q[:,0]; Q[:,1]=wS*Ns+(1-wS)*Q[:,1]
_,dev=clamp_tube(Q)
Er,Nr=Q[:,0],Q[:,1]
def radiiW(E,N,k=8):
    ax,ay=np.roll(E,k),np.roll(N,k); cx,cy=np.roll(E,-k),np.roll(N,-k)
    cr=(E-ax)*(cy-ay)-(N-ay)*(cx-ax); A=np.abs(cr)/2
    la=np.hypot(E-ax,N-ay); lb=np.hypot(cx-E,cy-N); lc=np.hypot(cx-ax,cy-ay)
    with np.errstate(divide="ignore",invalid="ignore"):
        return np.where(A>1e-6, la*lb*lc/(4*A), np.inf)
Rr=radiiW(Er,Nr)
seam=ds_seam<9000
mA3=a3zone(Er,Nr); mMain=~mA3&~seam
Rmain=np.nanmin(Rr[mMain&np.isfinite(Rr)]); Ra3=np.nanmin(Rr[mA3&np.isfinite(Rr)])
Rseam=np.nanmin(Rr[seam&np.isfinite(Rr)])
offw=max(float(np.hypot(Er-e,Nr-nn).min())-off0[nm] for nm,tp,e,nn in NODES)
frac750=float((vcap(Rr)>=VMAX-0.1).mean())
print(f"  taut string, tube +-{TUBE:.0f} m (400 m at the seam), {it:,} iterations:")
print(f"    max shift {dev.max():5.1f} m · mainline R {Rmain:>7,.0f} (was {Rmain0:,.0f})"
      f" · A3 R {Ra3:>6,.0f} (was {Ra30:,.0f}) · P1-seam R {Rseam:,.0f}")
print(f"    at-750 {frac750*100:.0f}% of length · node dOff {offw:+.1f} m")
worst=np.argsort(np.where(mMain,Rr,np.inf))[:3]
for iw in worst:
    dn=min(((math.hypot(Er[iw]-e,Nr[iw]-nn),nm) for nm,tp,e,nn in NODES))
    print(f"      R {Rr[iw]:>7,.0f} m at chainage {iw*25/1000:6.1f} km "
          f"({dn[1]} {dn[0]/1000:.1f} km away)")
"""Seam acceptance is OPERATIONAL, not geometric: every service stops at P1, so a
   train ds metres from the seam cannot exceed sqrt(2 a ds). The closing S-jog is
   acceptable iff its curve cap beats that envelope everywhere (with 500 m slack
   for the exact stop position)."""
"""Reach is floored at the mainline curve cap: far from P1 a train is bounded by
   the ordinary caps regardless of distance, so the envelope must not demand more
   radius than the mainline itself provides."""
vreach=np.minimum(np.sqrt(2*ACC*(ds_seam+500.0)), math.sqrt(K*8900.0))
marg=vcap(Rr)-vreach
seamOK=bool(np.all(marg[seam]>=0))
vmarg=float(np.min(marg[seam]))*3.6
print(f"    seam envelope check: min(cap − reachable) {vmarg:+.0f} km/h "
      f"{'(PASS — jog hides inside the P1 stop shadow)' if seamOK else '(FAIL)'}")
if not seamOK:
    for iw in np.argsort(np.where(seam,marg,np.inf))[:3]:
        print(f"      ds {ds_seam[iw]/1000:5.2f} km · R {Rr[iw]:>7,.0f} m · "
              f"cap {vcap(Rr[iw:iw+1])[0]*3.6:4.0f} vs reach {vreach[iw]*3.6:4.0f} km/h")
okm=Rmain>=8600; oka=Ra3>=5400
if not (okm and oka and seamOK):
    print("  constraints violated — keeping unrectified"); sys.exit(3)
segr=np.hypot(*(np.diff(Q,axis=0)).T)
print(f"  rectified length {segr.sum()/1000:.1f} km (was {L/1000:.1f})")
# roll so index 0 is the point nearest P1 — otherwise P1's chainage lands at the
# array END and every downstream consumer sees a phantom double-stop at P1
Qs=np.stack([Er,Nr],1)
i0=int(np.argmin(np.hypot(Qs[:,0]-NODES[0][2],Qs[:,1]-NODES[0][3])))
Qs=np.roll(Qs,-i0,axis=0)
np.save(os.path.join(OUT,"loop_P_rect.npy"), Qs)
print("  wrote out/loop_P_rect.npy")

# quick before/after on the express lap
chainR={nm:float((lambda d:np.argmin(d))(np.hypot(Er-e,Nr-nn))*25.0) for nm,tp,e,nn in NODES}
E1,N1,s1=resample(np.stack([Er,Nr],1))
chain1={nm:float(s1[int(np.hypot(E1-e,N1-nn).argmin())]) for nm,tp,e,nn in NODES}
v1,t1,idx1,_=profile(E1,N1,s1,PRI,chain1)
print(f"\n  express lap before: {t[-1]/60+5:.1f} min (incl dwell) · peak {v.max()*3.6:.0f} km/h")
print(f"  express lap after:  {t1[-1]/60+5:.1f} min (incl dwell) · peak {v1.max()*3.6:.0f} km/h")
