"""Write the routed loop to DXF R12 ASCII for Rhino.

Layers
  RAIL_CL      3D polyline, rail level (m AOD)         — the alignment
  GROUND_CL    3D polyline, existing ground level      — for the cut/fill read
  TUNNEL / CUTTING / EMBANKMENT / VIADUCT / AT_GRADE   — structure runs, rail level
  STATIONS     point + text at each of the 16 nodes
All coordinates are EPSG:27700 metres, so it lands in Rhino at true scale and
true position. Z is metres AOD, unexaggerated.
"""
import os, sys, json
import numpy as np
from scipy.ndimage import gaussian_filter1d
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE=os.path.dirname(os.path.abspath(__file__)); os.chdir(HERE)
OUT=os.path.abspath(os.path.join(HERE,"..","out"))
from solve_loop import DEM,NODES,bilinear,W

NL=chr(10)                      # never a literal escape — the linter un-escapes it
P=np.load((lambda p: p if os.path.exists(p) else os.path.join(OUT,"loop_P.npy"))(os.path.join(OUT,"loop_P_rect.npy")))
seg=np.hypot(*(P[1:]-P[:-1]).T); ds=float(np.median(seg))
ground=np.array([bilinear(DEM,e,n) for e,n in P])
lo,hi=1.0,4000.0
for _ in range(46):
    mid=(lo+hi)/2; z=gaussian_filter1d(ground,mid/ds,mode="nearest")
    if (np.abs(np.gradient(np.gradient(z,ds),ds)).max()<=1/W["vCurveR"]
        and np.abs(np.gradient(z,ds)).max()<=W["maxGrade"]/100): hi=mid
    else: lo=mid
z=gaussian_filter1d(ground,hi/ds,mode="nearest")
d=z-ground
kind=np.where(d>18,3,np.where(d>3,2,np.where(d<-28,0,np.where(d<-3,1,4))))
LAY=["TUNNEL","CUTTING","EMBANKMENT","VIADUCT","AT_GRADE"]
ACI=[  216,     34,        42,          5,        3    ]

o=[]
def g(c,v): o.append(str(c)); o.append(str(v))
g(0,"SECTION"); g(2,"TABLES"); g(0,"TABLE"); g(2,"LAYER"); g(70,8+len(LAY))
for nm,col in [("RAIL_CL",1),("GROUND_CL",8),("STATIONS",7)]+list(zip(LAY,ACI)):
    g(0,"LAYER"); g(2,nm); g(70,0); g(62,col); g(6,"CONTINUOUS")
g(0,"ENDTAB"); g(0,"ENDSEC")
g(0,"SECTION"); g(2,"ENTITIES")

def poly(pts,zs,layer,closed=False):
    g(0,"POLYLINE"); g(8,layer); g(66,1); g(70,8+(1 if closed else 0))
    g(10,0.0); g(20,0.0); g(30,0.0)
    for (x,y),zz in zip(pts,zs):
        g(0,"VERTEX"); g(8,layer); g(70,32)
        g(10,f"{x:.3f}"); g(20,f"{y:.3f}"); g(30,f"{zz:.3f}")
    g(0,"SEQEND"); g(8,layer)

poly(P,z,"RAIL_CL",closed=True)
poly(P,ground,"GROUND_CL",closed=True)
runs=0; i=0
while i<len(kind):
    j=i
    while j+1<len(kind) and kind[j+1]==kind[i]: j+=1
    if j>i: poly(P[i:j+1],z[i:j+1],LAY[kind[i]]); runs+=1
    i=j+1
for nm,tp,e,n in NODES:
    k=int(np.hypot(P[:,0]-e,P[:,1]-n).argmin())
    g(0,"POINT"); g(8,"STATIONS"); g(10,f"{e:.3f}"); g(20,f"{n:.3f}"); g(30,f"{z[k]:.3f}")
    g(0,"TEXT"); g(8,"STATIONS"); g(10,f"{e+320:.3f}"); g(20,f"{n+320:.3f}")
    g(30,f"{z[k]:.3f}"); g(40,900.0); g(1,f"{nm} ({tp})")
g(0,"ENDSEC"); g(0,"EOF")

p=os.path.join(OUT,"london2100_loop.dxf")
open(p,"w",encoding="ascii",errors="replace").write(NL.join(o)+NL)
print(f"wrote {p}  ({os.path.getsize(p)/1e6:.1f} MB, {len(P):,} vertices, {runs} structure runs)")
