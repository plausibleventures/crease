"""Crease's Blender runner (ships with the app; trusted). server/cad/blender.ts starts it inside the sandbox:

    Blender -b --factory-startup ... --python runner.py -- job.json

It runs one part script (parts/<id>.blend.py, with the part's settings already written in), then exports every
visible mesh-like object as binary STL, one file per colour, into the job's output folder with report.json:
    {"bodies": [{"file": "body-1.stl", "color": null, "faces": 123}], "notes": ["..."], "seconds": 3.2}
A script error leaves error.txt (the traceback, script frames only) and exits with --python-exit-code.
"""
import json
import os
import runpy
import sys
import time
import traceback

import bpy

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
job = json.load(open(argv[0]))
OUT = job["out"]
MAX_FACES = int(job.get("maxFaces", 300000))
t0 = time.time()

bpy.ops.wm.read_factory_settings(use_empty=True)
sys.path.insert(0, job["helpers"])
if job.get("lib"):
    sys.path.insert(1, job["lib"])
import printstudio as ps  # noqa: E402

ps.PROJECT = job.get("project")

notes = []


def fail(msg):
    with open(os.path.join(OUT, "error.txt"), "w") as f:
        f.write(msg)
    print("PS_ERROR " + msg.replace("\n", "\\n"), file=sys.stderr)
    sys.exit(3)


try:
    runpy.run_path(job["script"], run_name="__main__")
except SystemExit as e:
    if e.code not in (None, 0):
        fail("The script stopped with exit code %s." % e.code)
except BaseException:
    et, ev, tb = sys.exc_info()
    frames = [f for f in traceback.extract_tb(tb) if f.filename in (job["script"],) or f.filename.endswith("printstudio.py") or (job.get("lib") and f.filename.startswith(job["lib"]))]
    lines = ["Traceback (most recent call last):\n"] + traceback.format_list(frames) + traceback.format_exception_only(et, ev)
    fail("".join(lines).replace(job["script"], job.get("scriptName", "part script")))

import bmesh  # noqa: E402
import numpy as np  # noqa: E402

MESHLIKE = {"MESH", "CURVE", "SURFACE", "META", "FONT"}
objs = [o for o in bpy.context.scene.objects if o.type in MESHLIKE and not o.name.startswith("_") and not o.hide_render and not o.hide_viewport and not o.hide_get()]
if not objs:
    fail("The script made no shape: leave at least one visible mesh object in the scene (names starting with _ and hidden objects are left out).")

groups = {}
for o in objs:
    c = o.get("color")
    groups.setdefault(str(c) if c else None, []).append(o)

bpy.context.view_layer.update()
dg = bpy.context.evaluated_depsgraph_get()


def joined(objs):
    bm = bmesh.new()
    for o in objs:
        me = bpy.data.meshes.new_from_object(o.evaluated_get(dg), depsgraph=dg)
        me.transform(o.matrix_world)
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    me = bpy.data.meshes.new("_export")
    bm.to_mesh(me)
    bm.free()
    return me


meshes = [(c, joined(os_)) for c, os_ in groups.items()]
total = sum(len(me.polygons) for _, me in meshes)
if total == 0:
    fail("The script's objects have no faces (an empty mesh, or a curve without depth).")
if total > MAX_FACES:
    ratio = MAX_FACES / total
    for i, (c, me) in enumerate(meshes):
        ob = bpy.data.objects.new("_dec", me)
        bpy.context.scene.collection.objects.link(ob)
        m = ob.modifiers.new("dec", "DECIMATE")
        m.ratio = ratio
        bpy.context.view_layer.update()
        d = bpy.context.evaluated_depsgraph_get()
        me2 = bpy.data.meshes.new_from_object(ob.evaluated_get(d), depsgraph=d)
        bpy.data.objects.remove(ob, do_unlink=True)
        bm = bmesh.new()
        bm.from_mesh(me2)
        bmesh.ops.triangulate(bm, faces=bm.faces)
        bm.to_mesh(me2)
        bm.free()
        meshes[i] = (c, me2)
    after = sum(len(me.polygons) for _, me in meshes)
    notes.append("Simplified from %d to %d triangles (limit %d) so checks and slicing stay quick." % (total, after, MAX_FACES))


def islands(tri, nverts):
    """Connected-component label per triangle (label propagation with pointer jumping)."""
    lab = np.arange(nverts)
    while True:
        m = lab[tri].min(axis=1)
        new = lab.copy()
        for k in range(3):
            np.minimum.at(new, tri[:, k], m)
        new = new[new]
        if np.array_equal(new, lab):
            return lab[tri[:, 0]]
        lab = new


dropped = 0


def tris(me):
    """Triangles (n, 3, 3), without the tiny loose specks simplifying and remeshing leave behind (< 1 mm, or flat)."""
    global dropped
    me.calc_loop_triangles()
    co = np.empty(len(me.vertices) * 3, dtype=np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    idx = np.empty(len(me.loop_triangles) * 3, dtype=np.int32)
    me.loop_triangles.foreach_get("vertices", idx)
    tri = idx.reshape(-1, 3)
    t = co[tri]
    if len(tri):
        comp = islands(tri, len(co))
        ids, counts = np.unique(comp, return_counts=True)
        if len(ids) > 1:
            keep = np.ones(len(tri), dtype=bool)
            for i, cnt in zip(ids, counts):
                m = comp == i
                pts = t[m].reshape(-1, 3)
                diag = float(np.linalg.norm(pts.max(axis=0) - pts.min(axis=0)))
                vol = abs(float(np.einsum("ij,ij->i", t[m][:, 0], np.cross(t[m][:, 1], t[m][:, 2])).sum()) / 6)
                if diag < 1.0 or vol < 0.05:
                    keep &= ~m
                    dropped += 1
            t = t[keep]
    return t


data = [(c, tris(me)) for c, me in meshes]
if dropped:
    notes.append("Removed %d tiny loose speck%s (under 1 mm) left by smoothing." % (dropped, "" if dropped == 1 else "s"))
zmin = min(float(t[:, :, 2].min()) for _, t in data if len(t))
if abs(zmin) > 0.01:
    for _, t in data:
        t[:, :, 2] -= zmin
    notes.append("Moved %s by %.1f mm so the lowest point sits on the bed (Z = 0)." % ("up" if zmin < 0 else "down", abs(zmin)))

dt = np.dtype([("n", "<f4", (3,)), ("v", "<f4", (9,)), ("a", "<u2")])
bodies = []
for i, (c, t) in enumerate(sorted(data, key=lambda e: (e[0] is not None, e[0] or ""))):
    n = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    ln[ln == 0] = 1
    rec = np.zeros(len(t), dtype=dt)
    rec["n"] = n / ln
    rec["v"] = t.reshape(-1, 9)
    name = "body-%d.stl" % (i + 1)
    with open(os.path.join(OUT, name), "wb") as f:
        header = b"Crease sculpt (Blender)"
        f.write(header + b" " * (80 - len(header)))
        f.write(np.uint32(len(t)).tobytes())
        f.write(rec.tobytes())
    lo = t.reshape(-1, 3).min(axis=0)
    hi = t.reshape(-1, 3).max(axis=0)
    bodies.append({"file": name, "color": c, "faces": int(len(t)), "size": [round(float(v), 2) for v in (hi - lo)]})

with open(os.path.join(OUT, "report.json"), "w") as f:
    json.dump({"bodies": bodies, "notes": notes, "seconds": round(time.time() - t0, 2)}, f)
print("PS_DONE %d bodies, %d triangles, %.1f s" % (len(bodies), sum(b["faces"] for b in bodies), time.time() - t0))
