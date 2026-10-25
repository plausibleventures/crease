"""Crease sculpting helpers for Blender part scripts (parts/<id>.blend.py).

    import printstudio as ps

Units are millimetres, Z is up, the front faces -Y, and the part should stand on Z = 0. Every helper returns a Blender
object linked to the scene. After the script ends, Crease exports every visible mesh-like object in the scene
(objects whose name starts with "_" or that are hidden are left out; give an object a colour with ps.color()).
Fuse overlapping pieces into one watertight solid with ps.fuse() before the script ends.

Shipped with Crease (server/cad/sculpt-py/); the blender-sculpting skill documents it.
"""
import math

import bmesh
import bpy
from mathutils import Matrix, Vector

# Set by the runner: the project folder (read-only) for loading refs/ images.
PROJECT = None


def _scene():
    return bpy.context.scene


def _link(ob):
    _scene().collection.objects.link(ob)
    return ob


def _mesh_object(name, bm):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return _link(bpy.data.objects.new(name, me))


def _place(ob, loc=(0, 0, 0), rot=(0, 0, 0), scale=None):
    ob.location = loc
    ob.rotation_euler = [math.radians(a) for a in rot]
    if scale is not None:
        ob.scale = scale
    return ob


def project_path(rel):
    """Absolute path of a project file (e.g. "refs/face.png"), for bpy.data.images.load. Read-only."""
    import os

    if not PROJECT:
        raise RuntimeError("project folder unknown")
    p = os.path.normpath(os.path.join(PROJECT, rel))
    if not p.startswith(os.path.normpath(PROJECT) + os.sep):
        raise ValueError("path must stay inside the project")
    return p


def clear():
    """Remove every object (the runner starts from an empty scene already)."""
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)


# ---------- primitives (rot in degrees) ----------


def ellipsoid(loc, radii, segs=48, rot=(0, 0, 0), name="ellipsoid"):
    """A ball stretched to radii (rx, ry, rz) (or one number), centred at loc."""
    r = radii if isinstance(radii, (tuple, list)) else (radii, radii, radii)
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=max(8, segs // 2), radius=1)
    return _place(_mesh_object(name, bm), loc, rot, r)


def cylinder(loc, r1, r2, h, segs=64, rot=(0, 0, 0), name="cylinder"):
    """A cylinder or cone from radius r1 (bottom) to r2 (top), height h, its BOTTOM centre at loc."""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=segs, radius1=r1, radius2=r2, depth=h)
    bmesh.ops.translate(bm, verts=bm.verts, vec=(0, 0, h / 2))
    return _place(_mesh_object(name, bm), loc, rot)


def box(loc, size, rot=(0, 0, 0), name="box"):
    """A box of size (x, y, z) centred at loc."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1)
    return _place(_mesh_object(name, bm), loc, rot, size)


def torus(loc, R, r, segs=96, ring=24, rot=(0, 0, 0), name="torus"):
    """A ring: R from the centre to the tube's middle, r the tube radius, lying flat (axis = Z)."""
    bm = bmesh.new()
    rows = []
    for i in range(segs):
        a = 2 * math.pi * i / segs
        row = []
        for j in range(ring):
            b = 2 * math.pi * j / ring
            row.append(bm.verts.new(((R + r * math.cos(b)) * math.cos(a), (R + r * math.cos(b)) * math.sin(a), r * math.sin(b))))
        rows.append(row)
    for i in range(segs):
        for j in range(ring):
            bm.faces.new((rows[i][j], rows[(i + 1) % segs][j], rows[(i + 1) % segs][(j + 1) % ring], rows[i][(j + 1) % ring]))
    return _place(_mesh_object(name, bm), loc, rot)


def lathe(profile, segs=96, loc=(0, 0, 0), name="lathe"):
    """A solid of revolution about Z: profile = [(radius, z), ...] from bottom to top (vases, plinths, chess bases).
    Ends at radius 0 close themselves; otherwise the bottom and top are capped flat."""
    bm = bmesh.new()
    rings = []
    for r, z in profile:
        if r <= 1e-6:
            rings.append([bm.verts.new((0, 0, z))])
        else:
            rings.append([bm.verts.new((r * math.cos(2 * math.pi * i / segs), r * math.sin(2 * math.pi * i / segs), z)) for i in range(segs)])
    for a, b in zip(rings, rings[1:]):
        if len(a) == 1 and len(b) == 1:
            continue
        for i in range(segs):
            if len(a) == 1:
                bm.faces.new((a[0], b[i], b[(i + 1) % segs]))
            elif len(b) == 1:
                bm.faces.new((a[i], a[(i + 1) % segs], b[0]))
            else:
                bm.faces.new((a[i], a[(i + 1) % segs], b[(i + 1) % segs], b[i]))
    if len(rings[0]) > 1:
        bm.faces.new(list(reversed(rings[0])))
    if len(rings[-1]) > 1:
        bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return _place(_mesh_object(name, bm), loc)


def skin(verts, edges, radii, subdiv=2, name="skin"):
    """An organic tube network (bodies, limbs, tails, branches): points joined by edges, each point with a radius
    (r or (rx, ry)), smoothed by subdivision. verts[0] is the root. The best start for figures and animals."""
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [tuple(e) for e in edges], [])
    ob = _link(bpy.data.objects.new(name, me))
    ob.modifiers.new("skin", "SKIN")
    for v, r in zip(me.skin_vertices[0].data, radii):
        v.radius = tuple(r) if isinstance(r, (tuple, list)) else (r, r)
    me.skin_vertices[0].data[0].use_root = True
    if subdiv:
        s = ob.modifiers.new("subdiv", "SUBSURF")
        s.levels = subdiv
        s.render_levels = subdiv
    return ob


def tube(points, radius, segs=24, name="tube"):
    """A round tube swept along points [(x, y, z), ...] (ribbons, sword grips, hair strands, horns). radius: one
    number, or one per point (tapers)."""
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = 1.0
    cu.bevel_resolution = max(2, segs // 4)
    cu.use_fill_caps = True
    sp = cu.splines.new("POLY")
    sp.points.add(len(points) - 1)
    rs = radius if isinstance(radius, (tuple, list)) else [radius] * len(points)
    for p, co, r in zip(sp.points, points, rs):
        p.co = (co[0], co[1], co[2], 1)
        p.radius = r
    return _link(bpy.data.objects.new(name, cu))


def sheet(fn, nu=48, nv=48, thickness=2.0, name="sheet"):
    """A thin solid from a surface: fn(u, v) -> (x, y, z) for u, v in 0..1, thickened to `thickness` mm (centred)
    (capes, flags, leaves, wings, scrolls). Keep thickness >= 1.6 mm so it prints."""
    bm = bmesh.new()
    grid = [[bm.verts.new(fn(i / nu, j / nv)) for i in range(nu + 1)] for j in range(nv + 1)]
    for j in range(nv):
        for i in range(nu):
            bm.faces.new((grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]))
    ob = _mesh_object(name, bm)
    s = ob.modifiers.new("thick", "SOLIDIFY")
    s.thickness = thickness
    s.offset = 0
    s.use_even_offset = True
    return ob


def metaballs(balls, resolution=0.6, threshold=0.6, name="meta"):
    """A blobby, melted-together shape from balls [((x, y, z), radius), ...] (clouds, bodies of soft animals, drips).
    Converted to a mesh object right away."""
    mb = bpy.data.metaballs.new(name)
    mb.resolution = resolution
    mb.render_resolution = resolution
    mb.threshold = threshold
    for co, r in balls:
        el = mb.elements.new()
        el.co = co
        el.radius = r
    ob = _link(bpy.data.objects.new(name, mb))
    bpy.context.view_layer.update()
    return apply(ob)


# ---------- modifying ----------


def apply(ob):
    """Bake an object's modifiers (and curve / metaball shape) into a plain mesh object; returns the mesh object."""
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=False, depsgraph=dg)
    if ob.type == "MESH":
        ob.modifiers.clear()
        old = ob.data
        ob.data = me
        if old.users == 0:
            bpy.data.meshes.remove(old)
        return ob
    new = _link(bpy.data.objects.new(ob.name + "_mesh", me))
    new.matrix_world = ob.matrix_world.copy()
    for k in ob.keys():
        if k == "color":
            new[k] = ob[k]
    bpy.data.objects.remove(ob, do_unlink=True)
    return new


def displace(ob, fn):
    """Move every vertex along its normal by fn(co, normal) mm (co/normal in world space): folds, scales, bark,
    fur grooves, wrinkles. Detail finer than about 0.8 mm won't print on a 0.4 mm nozzle."""
    ob = apply(ob)
    mw = ob.matrix_world
    inv = mw.inverted()
    nm = mw.to_3x3().inverted().transposed()
    me = ob.data
    for v in me.vertices:
        co = mw @ v.co
        n = (nm @ v.normal).normalized()
        d = fn(co, n)
        if d:
            v.co = inv @ (co + n * d)
    me.update()
    return ob


def smooth(ob, iterations=4, factor=0.5):
    """Soften an object (applied)."""
    m = ob.modifiers.new("smooth", "SMOOTH")
    m.iterations = iterations
    m.factor = factor
    return apply(ob)


def mirror_x(ob):
    """Make an object symmetric left/right by mirroring it across X = 0 (model one side, get both)."""
    m = ob.modifiers.new("mirror", "MIRROR")
    m.use_axis = (True, False, False)
    m.use_clip = True
    return apply(ob)


def boolean(target, cutter, op="DIFFERENCE"):
    """Cut (DIFFERENCE), add (UNION) or keep the overlap (INTERSECT) of two objects. The cutter is removed."""
    target = apply(target)
    cutter = apply(cutter)
    m = target.modifiers.new("bool", "BOOLEAN")
    m.operation = op
    m.object = cutter
    m.solver = "EXACT"
    out = apply(target)
    bpy.data.objects.remove(cutter, do_unlink=True)
    return out


def color(ob, name):
    """Print this object in a colour (a loaded filament's name or "#rrggbb"). Objects with different colours stay
    separate bodies; fuse each colour on its own."""
    ob["color"] = str(name)
    return ob


def _visible_meshlike(objs=None):
    objs = list(objs) if objs is not None else list(_scene().objects)
    return [o for o in objs if o.type in {"MESH", "CURVE", "SURFACE", "META", "FONT"} and not o.name.startswith("_") and not o.hide_render]


def join(objs=None, name="joined"):
    """Join objects into one mesh object (no fusing: overlaps stay overlaps)."""
    objs = _visible_meshlike(objs)
    bm = bmesh.new()
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    colour = None
    for o in objs:
        me = bpy.data.meshes.new_from_object(o.evaluated_get(dg), depsgraph=dg)
        me.transform(o.matrix_world)
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
        colour = colour or o.get("color")
    for o in objs:
        bpy.data.objects.remove(o, do_unlink=True)
    ob = _mesh_object(name, bm)
    if colour:
        ob["color"] = colour
    return ob


def fuse(objs=None, voxel=0.25, smooth_iterations=3, name="sculpt"):
    """Fuse overlapping pieces (default: every visible object) into ONE watertight solid with a voxel remesh, then
    soften the voxel steps. voxel = detail size in mm: 0.2-0.3 for figures about 100 mm tall, 0.4-0.6 for big ones
    (smaller = finer but slower and heavier). Gaps narrower than about 2 x voxel close up."""
    ob = join(objs, name)
    m = ob.modifiers.new("remesh", "REMESH")
    m.mode = "VOXEL"
    m.voxel_size = voxel
    m.adaptivity = 0
    m.use_smooth_shade = True
    ob = apply(ob)
    if smooth_iterations:
        c = ob.modifiers.new("smooth", "CORRECTIVE_SMOOTH")
        c.iterations = smooth_iterations
        c.scale = 1.0
        c.smooth_type = "SIMPLE"
        c.rest_source = "ORCO"
        ob = apply(ob)
    return ob


def flat_base(ob, z=0.0):
    """Cut the object flat at height z (everything below goes) and close the cut, so it sits on the bed."""
    ob = apply(ob)
    me = ob.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.transform(bm, matrix=ob.matrix_world, verts=bm.verts)
    geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
    res = bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(0, 0, z), plane_no=(0, 0, 1), clear_inner=True)
    cut_edges = [e for e in res["geom_cut"] if isinstance(e, bmesh.types.BMEdge)]
    if cut_edges:
        bmesh.ops.holes_fill(bm, edges=cut_edges, sides=0)
        bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob.matrix_world = Matrix.Identity(4)
    bm.to_mesh(me)
    bm.free()
    me.update()
    return ob


def keep_part(ob, z, keep="below", peg=None, clearance=0.2):
    """Split a tall figure at height z and keep one side. peg = (diameter, height) adds a round peg on top of the
    lower piece (keep="below") or a matching hole (diameter + 2 x clearance, 0.5 mm deeper) in the bottom of the
    upper piece (keep="above"), which is then moved down to stand on Z = 0. Two part files can share one build
    function (lib/<name>.py) and keep one side each."""
    ob = apply(ob)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.transform(bm, matrix=ob.matrix_world, verts=bm.verts)
    geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
    res = bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(0, 0, z), plane_no=(0, 0, 1), clear_outer=(keep == "below"), clear_inner=(keep != "below"))
    cut = [e for e in res["geom_cut"] if isinstance(e, bmesh.types.BMEdge)]
    if cut:
        bmesh.ops.holes_fill(bm, edges=cut, sides=0)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob.matrix_world = Matrix.Identity(4)
    bm.to_mesh(ob.data)
    bm.free()
    if peg:
        d, h = peg
        if keep == "below":
            p = cylinder((0, 0, z - 0.5), d / 2, d / 2 * 0.92, h + 0.5, segs=48, name="_peg")
            p.hide_render = False
            ob = boolean(ob, p, "UNION")
        else:
            hole = cylinder((0, 0, z - 1), d / 2 + clearance, d / 2 + clearance, h + 1.5, segs=48, name="_hole")
            ob = boolean(ob, hole, "DIFFERENCE")
    if keep != "below":
        ob.location.z -= z
        ob = apply(ob)
    return ob


def decimate(ob, faces):
    """Reduce an object to about `faces` triangles (keeps the shape; for very heavy meshes)."""
    ob = apply(ob)
    n = len(ob.data.polygons)
    if n > faces:
        m = ob.modifiers.new("decimate", "DECIMATE")
        m.ratio = max(0.01, faces / n)
        ob = apply(ob)
    return ob


def size(ob):
    """(x, y, z) size in mm of an object as it is now (modifiers included)."""
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), depsgraph=dg)
    pts = [ob.matrix_world @ v.co for v in me.vertices]
    bpy.data.meshes.remove(me)
    if not pts:
        return (0.0, 0.0, 0.0)
    return tuple(max(p[i] for p in pts) - min(p[i] for p in pts) for i in range(3))


__all__ = [
    "PROJECT", "project_path", "clear", "ellipsoid", "cylinder", "box", "torus", "lathe", "skin", "tube", "sheet",
    "metaballs", "apply", "displace", "smooth", "mirror_x", "boolean", "color", "join", "fuse", "flat_base",
    "keep_part", "decimate", "size", "Vector", "Matrix",
]
