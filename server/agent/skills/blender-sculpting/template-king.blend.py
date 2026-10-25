# printstudio:sculpt  (a Blender part: Crease runs this script; see the blender-sculpting skill)
# A standing king on a round plinth: robe with folds, cape, beard, crown, hands resting on a sword.
import math
import printstudio as ps

# --- settings ---
# [Size]
height = 110  # [80:1:140] Height (mm)
# [Look]
crown_points = 8  # [5:1:10] Crown points
fold_depth = 1.6  # [0.6:0.1:2.5] Robe fold depth (mm)
cape = True  # Cape
# --- end settings ---

s = height / 110  # everything below is drawn for a 110 mm king, then scaled

def S(*v):
    return tuple(x * s for x in v)

# Plinth: a turned base (radius, z) from the bed up, with a bead moulding.
ps.lathe([(0, 0), (25 * s, 0), (25 * s, 4 * s), (23.5 * s, 5.5 * s), (24.2 * s, 7 * s), (21 * s, 8.5 * s), (19 * s, 10 * s), (0, 10 * s)])

# Body: one skin skeleton (spine and both arms). Radii are (left-right, front-back).
body = ps.skin(
    [S(0, 0, 7), S(0, 0, 22), S(0, 0, 42), S(0, 0, 54), S(0, 0, 66), S(0, 0, 75), S(0, 0, 82),
     S(11, 0.5, 74), S(13.5, -3, 63), S(3.5, -10.5, 56),
     S(-11, 0.5, 74), S(-13.5, -3, 63), S(-3.5, -10.5, 56)],
    [(0, 1), (1, 2), (2, 3), (3, 4), (4, 5), (5, 6), (5, 7), (7, 8), (8, 9), (5, 10), (10, 11), (11, 12)],
    [S(20.5, 19), S(15.5, 14), S(11.5, 10), S(10, 8.5), S(11.5, 9), S(12, 8.5), S(4.2, 4.2),
     S(4.8, 4.8), S(4, 4), S(3.4, 3.4), S(4.8, 4.8), S(4, 4), S(3.4, 3.4)],
    subdiv=3,
)
# Robe folds: vertical ripples that deepen toward the hem.
def folds(co, n):
    if not (10 * s < co.z < 52 * s) or abs(n.z) > 0.7:
        return 0
    t = (52 * s - co.z) / (42 * s)
    a = math.atan2(co.y, co.x)
    return fold_depth * s * t ** 1.2 * (0.5 + 0.5 * math.cos(13 * a + 0.7 * math.sin(3 * a)))
body = ps.displace(body, folds)
ps.lathe([(0, 9 * s), (20 * s, 9 * s), (19 * s, 11 * s), (16.5 * s, 14 * s), (0, 14 * s)])  # hem: robe meets the plinth

ps.torus(S(0, 0, 52), 10.2 * s, 1.5 * s)   # belt
ps.torus(S(0, 0, 78), 7.0 * s, 2.2 * s)    # fur collar

# Cape: a sheet hanging from the shoulders down to the plinth, wrapping round the back with folds.
if cape:
    def cape_surface(u, v):
        z = (77 - v * 67) * s
        r = (13 + v * 9) * s
        span = math.radians(160 + v * 50)
        a = math.radians(90) - span / 2 + span * u          # centred on the back (+Y)
        fold = (0.5 + 2.4 * v) * s * math.sin(11 * a + 1.3) * math.sin(math.pi * u)
        return ((r + fold) * math.cos(a), (r + fold) * math.sin(a), z)
    ps.sheet(cape_surface, nu=64, nv=48, thickness=2.2 * s)

# Sword: point resting on the plinth, both hands on the pommel (anchored at both ends, so it prints).
ps.box(S(0, -12, 33), S(3.2, 2.4, 44))            # blade (2.4 mm thick: prints solid)
ps.box(S(0, -12, 55.5), S(15, 3, 2.8))            # cross guard
ps.cylinder(S(0, -12, 56.5), 1.8 * s, 1.8 * s, 4 * s)
ps.ellipsoid(S(0, -12, 61.5), 2.8 * s)            # pommel under the hands

# Head and face: big, simple forms (anything under 0.8 mm won't print).
ps.ellipsoid(S(0, 0.5, 90), S(6.8, 7.4, 8.4))     # skull
ps.ellipsoid(S(0, -5.6, 92.2), S(5.4, 1.8, 1.4))  # brow ridge
ps.cylinder(S(0, -6.2, 87.4), 1.5 * s, 0.6 * s, 4 * s, segs=24, rot=(-62, 0, 0))  # nose
for x in (-3, 3):
    ps.ellipsoid(S(x, -5.2, 88.2), S(2.0, 1.6, 1.5))  # cheeks
ps.ellipsoid(S(0, -6.8, 86.6), S(4.4, 1.6, 1.1))  # moustache
# Beard: tapered strands swept down the chest.
for x in (-3.2, -1.6, 0, 1.6, 3.2):
    ps.tube([S(x, -5.4, 86.5), S(x * 1.05, -7.2, 82), S(x * 0.8, -7.4, 77.5), S(x * 0.35, -6.8, 74.5)], [1.9 * s, 1.8 * s, 1.4 * s, 0.9 * s])

# Crown: a band with points and pearls, a cap and a cross on an orb.
ps.cylinder(S(0, 0.5, 95), 7.6 * s, 8.1 * s, 5 * s)
ps.torus(S(0, 0.5, 95.4), 7.7 * s, 1.0 * s)
for k in range(crown_points):
    a = 2 * math.pi * (k + 0.5) / crown_points
    x, y = 7.6 * s * math.cos(a), 0.5 * s + 7.6 * s * math.sin(a)
    ps.cylinder((x, y, 99.5 * s), 1.8 * s, 0.9 * s, 4.5 * s, segs=16)   # points stay >= 1.6 mm wide
    ps.ellipsoid((x, y, 104.3 * s), 1.2 * s, segs=16)
ps.ellipsoid(S(0, 0.5, 98.5), S(6.8, 6.8, 4.6))
ps.ellipsoid(S(0, 0.5, 104), 2.4 * s)
ps.box(S(0, 0.5, 107.6), S(1.8, 1.8, 5.6))
ps.box(S(0, 0.5, 108.2), S(4.8, 1.8, 1.8))

# One watertight solid, softened, flat on the bed.
king = ps.fuse(voxel=0.28 * s, smooth_iterations=3)
ps.flat_base(king, 0)
