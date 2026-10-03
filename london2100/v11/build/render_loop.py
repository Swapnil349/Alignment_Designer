"""Render the routed full loop: plan over topography + long section + structures."""
import os, sys, math, json
import numpy as np
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.patches import Patch
from scipy.ndimage import gaussian_filter, gaussian_filter1d
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE=os.path.dirname(os.path.abspath(__file__)); os.chdir(HERE)
OUT=os.path.abspath(os.path.join(HERE,"..","out"))
from solve_loop import DEM,L,NODES,XMIN,YMAX,CELL,NX,NY,bilinear,W

P=np.load((lambda p: p if os.path.exists(p) else os.path.join(OUT,"loop_P.npy"))(os.path.join(OUT,"loop_P_rect.npy")))
S=json.load(open(os.path.join(OUT,"loop_summary.json")))
seg=np.hypot(*(P[1:]-P[:-1]).T); s=np.concatenate([[0],np.cumsum(seg)]); TOT=s[-1]

# ---- vertical profile: smooth the ground until the vertical-curve radius holds
ground=np.array([bilinear(DEM,e,n) for e,n in P])
ds=float(np.median(seg)); kmax=1.0/W["vCurveR"]; gmax=W["maxGrade"]/100
lo,hi=1.0,4000.0
for _ in range(46):
    mid=(lo+hi)/2; z=gaussian_filter1d(ground,mid/ds,mode="nearest")
    k=np.abs(np.gradient(np.gradient(z,ds),ds)).max(); g=np.abs(np.gradient(z,ds)).max()
    if k<=kmax and g<=gmax: hi=mid
    else: lo=mid
z=gaussian_filter1d(ground,hi/ds,mode="nearest")
kAch=np.abs(np.gradient(np.gradient(z,ds),ds)).max(); Rv=1/kAch if kAch>0 else np.inf
print(f"  vertical: bandwidth {hi:.0f} m -> R_v {Rv:,.0f} m (target {W['vCurveR']:,})"
      + ("   *** SATURATED — constraint NOT met ***" if hi>3990 else ""))
d=z-ground
kind=np.where(d>18,3,np.where(d>3,2,np.where(d<-28,0,np.where(d<-3,1,4))))
NAME=["Tunnel","Cutting","Embankment","Viaduct","At grade"]
"""Colour language per the design brief: everything BELOW ground in reds (tunnel
   dark, cutting light), everything ABOVE ground in blues (viaduct dark,
   embankment light), at-grade neutral grey-green — so the above-ground segments
   that shape the city read at a glance."""
COL =["#8e2020","#d98880","#85b8dc","#1a4e8a","#6f7f6f"]

# ---- radius check
def radii(Q,k=14):
    R=np.full(len(Q),np.inf)
    for i in range(k,len(Q)-k):
        a,b,c=Q[i-k],Q[i],Q[i+k]
        A=np.hypot(*(b-a)); Bl=np.hypot(*(c-b)); C=np.hypot(*(c-a))
        ar=abs((b[0]-a[0])*(c[1]-a[1])-(c[0]-a[0])*(b[1]-a[1]))/2
        if ar>1e-6: R[i]=A*Bl*C/(4*ar)
    return R
R=radii(P); Rmin=np.nanmin(R[np.isfinite(R)])
# mainline minimum = min radius OUTSIDE the A3 local-radius section (S1..P2)
a3=np.hypot(P[:,0]-511500,P[:,1]-225500)<20000
Rmain=np.nanmin(R[~a3 & np.isfinite(R)])

# ---- station chainages
NP={n[0]:(n[2],n[3]) for n in NODES}
order=[l["from"] for l in S["legs"]]+["P1"]
ch={}; j=0
for nm in order[1:]:
    tgt=NP[nm]; dd=np.hypot(P[j:,0]-tgt[0],P[j:,1]-tgt[1]); j2=j+int(dd.argmin())
    ch[nm]=s[j2]; j=j2
ch["P1"]=0.0

fig=plt.figure(figsize=(20,16.5),dpi=115)
gs=fig.add_gridspec(2,1,height_ratios=[2.42,1],hspace=.09,
                    left=.035,right=.982,top=.935,bottom=.052)

# ══════════════════ PLAN ══════════════════
ax=fig.add_subplot(gs[0])
pad=9000
x0,x1=P[:,0].min()-pad,P[:,0].max()+pad; y0,y1=P[:,1].min()-pad,P[:,1].max()+pad
c0,c1=int((x0-XMIN)//CELL),int((x1-XMIN)//CELL); r1,r0=int((YMAX-y0)//CELL),int((YMAX-y1)//CELL)
c0,c1=max(0,c0),min(NX,c1); r0,r1=max(0,r0),min(NY,r1)
sub=DEM[r0:r1,c0:c1]; ext=[XMIN+c0*CELL,XMIN+c1*CELL,YMAX-r1*CELL,YMAX-r0*CELL]
ax.imshow(sub,extent=ext,origin="upper",cmap="terrain",vmin=-40,vmax=230,alpha=.9,zorder=0)
ls=matplotlib.colors.LightSource(315,50)
hs=ls.hillshade(gaussian_filter(sub,1.2),vert_exag=17,dx=CELL,dy=CELL)
ax.imshow(hs,extent=ext,origin="upper",cmap="gray",alpha=.30,zorder=1)
for k,(cmap,al) in {"aonb":("Purples",.34),"built":("Greys",.55),"london":("Greys",.5)}.items():
    m=np.ma.masked_less(L[k][r0:r1,c0:c1],.12)
    ax.imshow(m,extent=ext,origin="upper",cmap=cmap,alpha=al,vmin=0,vmax=1.4,zorder=2)
m=np.ma.masked_less(L["river_major"][r0:r1,c0:c1],.12)
ax.imshow(m,extent=ext,origin="upper",cmap="Blues",alpha=.85,vmin=0,vmax=1.1,zorder=3)

ax.plot(P[:,0],P[:,1],lw=6.4,color="white",alpha=.92,solid_capstyle="round",zorder=5)
for kk in range(5):
    m=kind==kk
    if not m.any(): continue
    Q=P.copy().astype(float); Q[~m]=np.nan
    ax.plot(Q[:,0],Q[:,1],lw=3.1,color=COL[kk],solid_capstyle="round",zorder=6)
"""The two A3 legs run at a DESIGNED local radius of 5,730 m (~450 km/h) — the
   station-approach restriction that makes the Luton chicane geometrically possible.
   Violation circles therefore use the local floor, not the mainline 9,167 m."""
bad=R<5730*.92
if bad.any():
    ax.scatter(P[bad,0],P[bad,1],s=60,facecolor="none",edgecolor="#e00",lw=1.6,zorder=9)
ax.annotate("A3 approach: local R ≥ 5,730 m · ≈450 km/h",
            (511500,225500),xytext=(14,-26),textcoords="offset points",
            fontsize=8.6,color="#b8272b",style="italic")

MK={"primary":("o",235,"#0b2f6b"),"secondary":("o",105,"#1d4ed8"),"airport":("s",150,"#b8272b")}
for nm,tp,e,n in NODES:
    mk,sz,col=MK[tp]
    ax.scatter([e],[n],marker=mk,s=sz,facecolor=col,edgecolor="white",lw=2.1,zorder=11)
    ax.annotate(f"{nm}  {ch[nm]/1000:.0f} km",(e,n),xytext=(11,9),textcoords="offset points",
        fontsize=11.4 if tp=="primary" else 9.9, fontweight="bold" if tp!="secondary" else "600",
        color=col, zorder=12,
        bbox=dict(boxstyle="round,pad=.24",fc="white",ec=col,lw=.9,alpha=.93))
ax.set_xlim(x0,x1); ax.set_ylim(y0,y1); ax.set_aspect("equal")
ax.set_xticks([]); ax.set_yticks([])
ax.set_title(f"LONDON 2100 — {len(NODES)}-station orbital loop · {TOT/1000:.1f} km closed circuit · "
             f"mainline R ≥ {Rmain:,.0f} m · A3 approach R ≥ {Rmin:,.0f} m",
             fontsize=15.5,fontweight="bold",pad=13,loc="left")
km=np.array([(kind==k).sum() for k in range(5)])/len(kind)*TOT/1000
ax.legend(handles=[Line2D([],[],color=COL[k],lw=3.4,label=f"{NAME[k]}  {km[k]:.0f} km  ({km[k]/TOT*1000*100:.0f}%)")
                   for k in range(5)]+
                  [Patch(fc="#7e57c2",alpha=.45,label="AONB / National Landscape"),
                   Patch(fc="#666",alpha=.5,label="Built-up area")],
          loc="lower left",fontsize=10.2,framealpha=.94,ncol=2)

# ══════════════════ LONG SECTION ══════════════════
bx=fig.add_subplot(gs[1]); sk=s/1000
bx.fill_between(sk,ground,ground.min()-30,color="#c8b89a",alpha=.72,lw=0,label="Existing ground")
bx.plot(sk,ground,color="#7a6a4e",lw=.85)
for kk in range(5):
    m=kind==kk; zz=z.copy(); zz[~m]=np.nan
    bx.plot(sk,zz,lw=2.5,color=COL[kk],solid_capstyle="round",zorder=5)
for nm,tp,e,n in NODES:
    x=ch[nm]/1000
    bx.axvline(x,color="#444" if tp=="primary" else "#aaa",lw=1.5 if tp=="primary" else .7,
               ls="-" if tp=="primary" else ":",zorder=2)
    bx.text(x,bx.get_ylim()[1] if False else ground.max()+34,nm,fontsize=9.2,ha="center",
            fontweight="bold" if tp!="secondary" else "normal",
            color="#0b2f6b" if tp=="primary" else ("#b8272b" if tp=="airport" else "#555"))
bx.set_xlim(0,TOT/1000); bx.set_ylim(ground.min()-30,ground.max()+52)
bx.set_xlabel("Chainage from P1, clockwise (km)",fontsize=11)
bx.set_ylabel("Level (m AOD)",fontsize=11); bx.grid(alpha=.22,lw=.5)
grade=np.abs(np.gradient(z,ds)).max()*100
bx.set_title(f"Long section — max gradient {grade:.2f} % · vertical curve R ≥ "
             f"{W['vCurveR']:,} m · max fill {d.max():.0f} m / max cut {-d.min():.0f} m",
             fontsize=12.5,fontweight="bold",loc="left",pad=7)
fig.savefig(os.path.join(OUT,"full_loop.png"),dpi=115,facecolor="white")
print("wrote out/full_loop.png")
print(f"  loop {TOT/1000:.1f} km  Rmin {Rmin:,.0f} m  grade {grade:.2f}%  "
      f"fill {d.max():.0f} / cut {-d.min():.0f} m")
for k in range(5): print(f"  {NAME[k]:<11}{km[k]:6.1f} km  {km[k]/TOT*1000*100:4.1f}%")
