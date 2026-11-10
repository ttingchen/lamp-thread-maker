import numpy as np, trimesh, manifold3d as mf, sys
from manifold3d import Manifold, CrossSection

W, OUT = sys.argv[1], sys.argv[2]

# ---------------- parameters (mm) ----------------
LED_D, LED_H = 59.4, 7.89       # measured puck
CABLE_Z = 1.6                   # cable centre above puck bottom
CABLE_D = 2.8
POCKET_R = LED_D / 2 + 0.30     # Ø60.0
FLOOR = 1.5
PUSH_HOLE_R = 8.0               # finger hole underneath to push the LED out

PITCH, TH_DEPTH = 2.0, 0.9
ROOT_R = POCKET_R + 1.5         # 31.5
TH_CLR = 0.30
CREST_R = ROOT_R + TH_DEPTH     # 32.4

LED_TOP = FLOOR + LED_H                          # 9.39
CABLE_TOP = FLOOR + CABLE_Z + CABLE_D / 2        # 4.5
COLLAR_Z = 5.5                                   # cover sits here -> visible base band = 5.5 mm
WALL_TOP = 14.0                                  # LED fully below rim (~4.6 mm recess)
THREAD_H = WALL_TOP - COLLAR_Z                   # 8.5 mm ≈ 4 turns

COLLAR_R_OUT = CREST_R + TH_CLR + 2.6            # ≈35.3
COLLAR_H = THREAD_H
CUT_R = COLLAR_R_OUT - 0.4
SEG = 256

def thread_section(root, depth, pitch, n=360):
    c, fl, ro = 0.3, 0.7, 0.3
    def f(u):
        if u < c: return depth
        u -= c
        if u < fl: return depth * (1 - u / fl)
        u -= fl
        if u < ro: return 0.0
        return depth * ((u - ro) / fl)
    pts = []
    for i in range(n):
        th = 2 * np.pi * i / n
        r = root + f((-pitch * th / (2 * np.pi)) % pitch)
        pts.append([r * np.cos(th), r * np.sin(th)])
    return CrossSection([pts])

def threaded(root, h, z0=0.0, extra=0.0):
    turns = h / PITCH
    return Manifold.extrude(thread_section(root + extra, TH_DEPTH, PITCH), h,
                            n_divisions=int(turns * 90), twist_degrees=360.0 * turns).translate([0, 0, z0])

def cyl(r, h, z0=0.0, r2=None):
    return Manifold.cylinder(h, r, r if r2 is None else r2, SEG).translate([0, 0, z0])

def box(x0, x1, y0, y1, z0, z1):
    return Manifold.cube([x1 - x0, y1 - y0, z1 - z0]).translate([x0, y0, z0])

# ---------------- BASE ----------------
band = cyl(CREST_R, COLLAR_Z) - cyl(CREST_R + 5, 0.6, -0.01) + cyl(CREST_R - 0.6, 0.6, 0, CREST_R)  # 0.6 bottom chamfer
neck = threaded(ROOT_R, THREAD_H, COLLAR_Z) + cyl(ROOT_R + 0.01, THREAD_H, COLLAR_Z)
neck = neck ^ Manifold.cylinder(THREAD_H + 40, ROOT_R - 0.2 + THREAD_H + 40, ROOT_R - 0.2, SEG).translate([0, 0, WALL_TOP - THREAD_H - 40])
base = band + neck
base = base - cyl(POCKET_R, WALL_TOP, FLOOR)
base = base - cyl(PUSH_HOLE_R, FLOOR + 1, -0.5)
# cable slot: open from below so the cable (and its plug) just drops in, exits straight out the back
base = base - box(-(CREST_R + 5), -(POCKET_R - 4), -1.8, 1.8, -1, WALL_TOP + 1)  # full-height slot: LED + attached cable drop in from the top

# ---------------- COVER ----------------
cm = trimesh.load(f"{W}/ac4e2da3-lamp_cover_proto.stl"); cm.apply_scale(1000)
cm.apply_translation([0, 0, -cm.bounds[0][2]])
cover = Manifold(mf.Mesh(vert_properties=np.asarray(cm.vertices, np.float32),
                         tri_verts=np.asarray(cm.faces, np.uint32)))
cover = cover - cyl(CUT_R, 6.0, -1)
collar = cyl(COLLAR_R_OUT, COLLAR_H) - threaded(ROOT_R, COLLAR_H + 2 * PITCH, -PITCH, extra=TH_CLR)
collar = collar - Manifold.cylinder(1.0, CREST_R + TH_CLR + 0.6, ROOT_R + TH_CLR - 0.4, SEG).translate([0, 0, -0.01])
collar = collar - Manifold.cylinder(1.0, ROOT_R + TH_CLR - 0.4, CREST_R + TH_CLR + 0.6, SEG).translate([0, 0, COLLAR_H - 0.99])
cover = cover + collar

def to_tm(m):
    me = m.to_mesh()
    t = trimesh.Trimesh(me.vert_properties[:, :3], me.tri_verts, process=True)
    b = max(t.split(only_watertight=False), key=lambda b: len(b.faces)); b.remove_unreferenced_vertices()
    return b

bt, ct = to_tm(base), to_tm(cover)
bt.export(f"{OUT}/lamp_base_threaded.stl"); ct.export(f"{OUT}/lamp_cover_threaded.stl")
for n, t in [("base", bt), ("cover", ct)]:
    print(n, t.bounds.round(2).tolist(), "wt", t.is_watertight, "vol cm3", round(t.volume / 1000, 1))
print("LED top", LED_TOP, "wall top", WALL_TOP, "collar z", COLLAR_Z, "cable top", CABLE_TOP)

# ---------------- checks ----------------
cov_asm = cover.translate([0, 0, COLLAR_Z])
print("base ∩ cover:", round((base ^ cov_asm).volume(), 3))
dz = FLOOR + 1.4
lt = trimesh.load(f"{W}/122b3db8-led_top.stl"); lt.apply_scale(1000); lt.apply_translation([0.27, -0.17, dz])
lb = trimesh.load(f"{W}/4bb1efb6-led_base.stl"); lb.apply_scale(1000); lb.apply_translation([0.27, -0.17, dz])
print("LED z range", round(lb.bounds[0][2], 2), round(lt.bounds[1][2], 2))
puck = cyl(LED_D / 2, LED_H, FLOOR)
cable = Manifold.cylinder(80, CABLE_D / 2, CABLE_D / 2, 64).rotate([0, -90, 0]).translate([-27.0, -0.17, FLOOR + CABLE_Z])
print("base ∩ puck:", round((base ^ puck).volume(), 3), " base ∩ cable (straight out back):", round((base ^ cable).volume(), 3))
print("cover ∩ cable:", round((cov_asm ^ cable).volume(), 3), " cover ∩ puck:", round((cov_asm ^ puck).volume(), 3))
trimesh.util.concatenate([bt, to_tm(cov_asm), lb, lt]).export(f"{OUT}/assembly_preview.stl")
