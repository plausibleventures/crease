---
name: blender-sculpting
description: How to sculpt organic parts from code with Blender in Crease (parts/<id>.blend.py) - figures, chess pieces with characters, animals, busts, creatures, capes, hair, flowing vases - and make them print on FDM. Covers the file convention, the printstudio helper API, techniques (skin skeletons, metaballs, sweeps, sheets, displacement, voxel fusing), detail and thickness floors, overhangs, splitting tall figures, the review loop against a reference photo, and a template script.
---

# Sculpting with Blender: reference

Use this for anything that should look sculpted rather than machined: people, animals, faces, cloth, hair,
creatures, chess pieces with characters, organic vases and ornaments. Use OpenSCAD for precise bits (threads,
fits, snap joints, magnet pockets) and combine parts when a design needs both.

## How it works
- Write the part as **`parts/<id>.blend.py`**: a Blender Python script. It registers itself like a .scad part.
- **You never run Blender.** `render_part` runs the script headless in a sandbox, turns the result into the part's
  mesh, then renders the usual pictures plus a **back** view, and `check_part`, sliders, slicing, plates, colours and
  versions all work as for any part. A script error comes back from `render_part` as the error, with the
  traceback's line numbers in your file.
- The sandbox: no network, no other programs, no files except reading the project's `parts/`, `lib/` and `refs/`.
  About 4 minutes and a few GB of memory per run. Meshes over 300,000 triangles are simplified automatically
  (`notes` in the render result says so).
- If Blender isn't installed, `render_part` says so. Then follow `what-you-can-make` → "When a tool is missing".

## File convention
```python
# printstudio:sculpt  (a Blender part: Crease runs this script)
# @front: -y            optional: which side the previews treat as the front (-y default, +y, -x, +x)
import math
import printstudio as ps

# --- settings ---
# [Size]
height = 110  # [80:1:140] Height (mm)
# [Look]
cape = True  # Cape
crown_points = 8  # [5:1:10] Crown points
# --- end settings ---

s = height / 110        # draw at a reference size, scale everything by s
...
ps.fuse(voxel=0.28 * s) # one watertight solid
```
- **Units mm, Z up, front faces -Y, the part stands on Z = 0** (anything below is lifted automatically; a note
  says so).
- **Settings** are one per line between the two markers: `name = literal  # [min:step:max] Label (mm)`, with
  `# [Group]` headers and an optional description line above. Literals: numbers, `True`/`False`, `"strings"`
  (`# [a, b, c]` makes a choice). They become sliders; `set_parameters` and saved values work as in OpenSCAD.
  Lengths end their label with "(mm)".
- **What gets printed:** every visible mesh, curve or metaball object left in the scene when the script ends.
  Objects named `_something` and hidden objects are left out (use them for cutters and guides).
- **Colours:** one colour by default. `ps.color(obj, "gold")` makes that object its own colour body (fuse each
  colour separately); `# @color: black` colours everything else. Only loaded filaments (see `multicolor`).
- **Orientation** on the bed is `set_orientation`'s job (it adds a `print_orientation` line the app applies).
- **Shared code** goes in `lib/<name>.py` and is imported normally (`from king_body import build`); a change to it
  rebuilds every part that imports it. Use this for a chess set's shared base and style, or a figure split into
  pieces.
- Never write files, open images from outside the project, or use the network: the sandbox refuses it.

## The printstudio helpers (`import printstudio as ps`)
All take mm and degrees, return a Blender object, and link it to the scene.

| Helper | Use it for |
|---|---|
| `ps.skin(verts, edges, radii, subdiv=2)` | Bodies, limbs, tails, necks, branches: a skeleton of points (radius `r` or `(rx, ry)` each) skinned and smoothed. `verts[0]` is the root. The best start for figures and animals. |
| `ps.metaballs([((x, y, z), r), ...], resolution=0.6)` | Soft blobby masses that melt together: torsos of round animals, clouds, muscles, hair buns. |
| `ps.ellipsoid(loc, radii, segs=48, rot=)` | Heads, eyes, cheeks, pearls, orbs, muscles. |
| `ps.cylinder(loc, r1, r2, h, segs=64, rot=)` | Cones and cylinders from their **bottom centre**: noses, crown points, horns, limbs, sword grips. |
| `ps.box(loc, size, rot=)` | Centred boxes: blades, guards, belts, books. |
| `ps.torus(loc, R, r, rot=)` | Rings: belts, collars, bead mouldings, bracelets. |
| `ps.lathe([(r, z), ...], segs=96)` | Turned shapes (radius, height pairs from the bottom): plinths, chess bases, vases, goblets, columns. |
| `ps.tube(points, radius or [radii], segs=24)` | A round tube swept along points, tapering: hair strands, beards, ribbons, tails, vines, horns, staffs. |
| `ps.sheet(fn(u, v) -> (x, y, z), nu, nv, thickness=2)` | Cloth and thin shells from a surface: capes, flags, banners, leaves, wings, scrolls. Keep thickness ≥ 1.6 mm. |
| `ps.displace(obj, fn(co, normal) -> mm)` | Surface detail along the normals: robe folds, fur grooves, scales, bark, wrinkles. |
| `ps.mirror_x(obj)` | Model the left side, get both. |
| `ps.smooth(obj, iterations=4)` | Soften lumpy shapes. |
| `ps.boolean(target, cutter, "DIFFERENCE"/"UNION"/"INTERSECT")` | Eye sockets, mouth lines, a hollow, a magnet pocket. Cut small things before `fuse` (it is slow on dense meshes). |
| `ps.fuse(objs=None, voxel=0.25, smooth_iterations=3)` | **Always, at the end:** fuses every visible piece into one watertight solid (voxel remesh) and softens the voxel steps. |
| `ps.flat_base(obj, z=0)` | Cuts the bottom dead flat after fusing (fusing rounds the bottom edge). |
| `ps.keep_part(obj, z, keep="below"/"above", peg=(d, h))` | Split a tall figure at height z with a peg / matching hole. |
| `ps.decimate(obj, faces)`, `ps.size(obj)`, `ps.join(objs)`, `ps.apply(obj)`, `ps.color(obj, name)` | Housekeeping. |
| `ps.project_path("refs/face.png")` | Load a user's image read-only (`bpy.data.images.load(...)`), e.g. as a displacement map for a relief. |

Plain `bpy` / `bmesh` / `mathutils` (and `numpy`) work too: Blender's full API, with the default scene emptied
before your script runs.

## Techniques
- **Proportions first.** Decide the silhouette and proportions before details: head height, shoulder width,
  how far arms and capes stand out. A chess king is about 6 heads tall on a plinth one third of its width; a
  heroic figure 7-8 heads. Write the key heights as variables and derive the rest.
- **Figures:** one `skin` skeleton for spine, neck and arms (and legs if visible), radii as `(rx, ry)` so torsos
  are wider than deep. Robes: a wide root radius flaring onto the plinth, then `displace` folds that deepen toward
  the hem. Hands holding something touch it (a pommel, a staff) so both print together.
- **Animals:** skin skeleton along the spine with legs as branches; metaballs for round bellies and cheeks;
  ellipsoid heads; `tube` tails and ears; `mirror_x` for symmetric parts.
- **Faces** read only as big forms at this scale: brow ridge, nose, cheekbones, moustache, beard, hair. Eyes are
  small sockets (an ellipsoid cut ≥ 1 mm deep with `ps.boolean`) or a brow shadow, not eyeballs. Exaggerate like a
  carver: deeper sockets, bigger nose and brow than real. A head under about 12 mm tall shows no face detail.
- **Cloth:** `sheet` for capes and banners, folds as `sin` terms in the surface function (amplitude grows toward
  the free edge). Let a cape touch the body along its top and the plinth at its hem: a free-hanging sheet droops.
- **Hair and beards:** several tapered `tube` strands or an ellipsoid with `displace` grooves (≥ 0.6 mm deep,
  ≥ 2 mm apart).
- **Ornament:** crowns as a band (`cylinder`) plus points and pearls; belts and collars as `torus`; jewels as
  ellipsoids proud of the surface by ≥ 0.8 mm.
- **Fusing:** `ps.fuse(voxel=…)`: 0.25-0.3 mm for a figure about 100 mm tall, 0.4-0.6 for big pieces, 0.15-0.2 for a
  small detailed one (slower). Gaps narrower than about 2 voxels close up, so keep intended gaps ≥ 1 mm; features
  thinner than about 3 voxels vanish.

## Make it print (0.4 mm nozzle)
- **Detail floor:** nothing finer than about 0.8 mm shows: folds, grooves and jewels ≥ 0.8 mm wide and ≥ 0.6 mm
  deep or proud.
- **Thickness floor:** anything that sticks out ≥ 1.6 mm thick (crown points, fingers, ears, horns, antennae), and
  ≥ 2.4 mm for long thin things (swords, spears, staffs, tails). Anchor long thin things at both ends (a sword's
  point on the plinth, the hilt in the hands).
- **Stands on the bed:** a plinth or flat feet, `ps.flat_base(obj, 0)` last. Tall figures need a base at least
  about a third of their height wide (chess pieces: 40-50 mm for a 110 mm king).
- **Overhangs:** FDM prints up to 45° from vertical without supports. Keep arms close to the body, chins on beards,
  capes touching what's under them, outstretched parts sloping up ≥ 45°. Where that would spoil the design, keep the
  design and say in one line that it prints with tree supports (or split it). `check_part` shows overhangs and thin
  walls with markers.
- **Too tall or too complex:** split with `ps.keep_part` (a 6 mm peg, 0.2 mm clearance) into two part files that
  share a `lib/` build function, and place them in `assembly.json`.
- **Display finish:** print intent `display`; organic figures have no flat top to iron, so the side that matters
  faces the front (-Y).

## The review loop (this is where the quality comes from)
1. Write the whole figure roughly first (all masses in place), `render_part`, and look at **every** view, back
   included.
2. With a reference photo, compare side by side: silhouette, proportions (head to body, base width), pose, and the
   2-3 signature features (crown, beard, sword, cape). Name the three biggest differences to yourself.
3. Fix the **worst** one first, a few related edits per render; don't polish details while proportions are off.
4. Repeat until the silhouette and signature features read at a glance. 3-6 rounds is normal for a figure. A render
   that merely runs is round 0: do at least two look-and-fix rounds after it before showing the user, and don't
   ship the template's face, hands or collar unchanged.
5. `check_part`: fix thin features and floating bits; decide supports vs. reshaping overhangs. Then show the user
   ("How does this look?") and `save_checkpoint`.
Ask for a reference photo if there is none and the look matters ("Do you have a picture of the style you like?"),
with a recommended default style if they don't.

## Template
`template-king.blend.py` (next to this file) is a complete, printable 110 mm king: turned plinth, skin-skeleton
body and arms, robe folds by displacement, a cape sheet, beard strands, face forms, crown with points, a sword
anchored on the plinth, fused at 0.28 mm with a flat base. Start from it for figures: copy it to
`parts/<id>.blend.py` and change the forms, don't start from an empty file.

## Performance
- One build takes seconds: a 110 mm figure fused at 0.28 mm builds in about 2-4 s.
- `subdiv` above 3, hundreds of separate objects, `EXACT` booleans on fused meshes and voxels under 0.15 mm are
  what make it slow.
- Each render rebuilds only when the script, its settings or its `lib/` imports change.
