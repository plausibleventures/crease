---
name: printable-openscad
description: Reference for writing OpenSCAD designs in Crease that render, pass the printability checks and print without supports. Covers file conventions, design rules, printer limits used creatively, moving parts, efficiency and common pitfalls.
---

# Printable OpenSCAD: reference

## Files and structure
- One printable part per file in `parts/<part-id>.scad`. The part id is the file name without `.scad`.
  New files in `parts/` are registered in `project.json` automatically; do not edit `project.json` yourself.
- Shared constants and modules go in `lib/params.scad` / `lib/*.scad`, pulled in with `include <../lib/params.scad>`.
- Put every key dimension at the top of the file as an OpenSCAD Customizer parameter, with a range
  comment and a group, before any module definitions:
  ```
  /* [Size] */
  width = 80;    // [20:1:200]
  depth = 40;    // [20:1:200]
  wall = 1.6;    // [1.2:0.1:4]
  /* [Hidden] */
  $fn = $preview ? 32 : 96;
  ```
- Parameters are plain literals (numbers, strings, booleans) so the Customizer and `set_parameters` can change them.
- Use `$fn = $preview ? 32 : 96;` style resolution: low in preview, high in export.
- Model in millimetres, Z up, the part resting on Z = 0 in its print orientation, roughly centred on X/Y.
- Colour via `color("name")` per filament slot; at most as many distinct colours as the printer has slots.
- BOSL2 is available (bundled, pinned release): `include <BOSL2/std.scad>` for rounding/chamfered shapes and
  attachments, plus `threading.scad`, `screws.scad`, `gears.scad`, `hinges.scad`, `joiners.scad` as needed. Plain OpenSCAD is
  fine for simple parts. See the `fit-and-tolerance`, `multicolor` and `bosl2-*` skills.

## Constraints: know them up front, use them creatively
Limits (also in your instructions, with the live values):
- **Build volume:** 260 × 260 × 255 mm, about 10.2 × 10.2 × 10 in. Keep a 5 mm margin.
- **Detail:** the 0.4 mm nozzle gives a finest detail of about 0.8 mm. Text must be at least 6 mm tall and 0.6 mm
  deep.
- **Colours:** at most 4, and only the loaded ones (`printer_status` → `loadedFilaments`).
- **Heat:** PLA softens around 55 °C. For heat, suggest PETG.
- **Overhangs and bridges:** overhangs up to 45° need no supports. Bridges (flat spans between two supports) work
  up to about 30 mm.

Before designing, name to yourself the 2-3 limits that shape this design, then design with them instead of
around them:
- **Too big for the bed?** Split it into parts that join (dovetails, snap fits, alignment pins with a 0.2 mm
  clearance) rather than refusing or shrinking it. Each part should print flat without supports.
- **Moving parts:** prefer print-in-place hinges and clips (0.3-0.4 mm gaps) over screws or other hardware.
- **Colour as a feature:** put each colour in its own body (inlays, stripes, labels) using only the loaded slots.
  One colour is fine; fewer colour changes print faster.
- **Strength:** layers are weakest when pulled apart, so orient the part so loads run along the layers (e.g.
  print hooks on their side).
- **No supports:** chamfer downward edges at 45°, use teardrop or diamond-topped horizontal holes, keep bridges
  short, and put the flattest face on the bed.

Tell the user about a limit only when it changes the design, in one plain sentence ("It's split into 2 pieces
that slide together, because it's bigger than your printer's bed."). In `share_plan`, mention the constraint
that drove a choice.

## Moving parts: the motion is part of the design
For hinges, lids, drawers, sliders, spinners, latches and springs, describing the motion from the first version is
what lets the user see it move in the viewer, and lets `check_motion` catch collisions before they print:
- In `assembly.json` (via `update_assembly`), add a `placements` entry for every part (where it sits in the finished
  build) and a `motions` entry for everything that moves. Give each motion a plain-word `label` ("Lid opens", "Drawer
  slides out"), its axis, its pivot `origin` for rotations, a `range` (degrees or mm) and a `check` ("Swings open to
  about 110° without rubbing").
- Re-run `check_motion` after geometry changes and fix collisions or binding through the whole range (an INCOMPLETE
  result is not a pass: fix what it lists). It checks sampled positions only, not strength or friction. Print-in-place
  pieces (several bodies in one part) count too: describe them as motions. Clearances: print-in-place joints 0.3-0.4 mm, sliding fits 0.2 mm per side.
- In the guide, a step can demonstrate a motion (`showMotion`) and say how the builder knows it's right (`check`).
- The user can press ▶ on "Moves" in the viewer to see it move. Worth a one-line mention.

## Design rules (defaults until the printer profile has measured tolerances)
- Walls at least 1.2 mm (3 lines at 0.4 mm); smallest feature 0.8 mm.
- Clearance between mating parts: 0.2 mm per side for a sliding fit, 0.1 mm for a press fit.
- Holes print undersize: add 0.2 mm to hole diameters.
- Overhangs up to 45 degrees without support; chamfer instead of fillet on downward-facing edges.
- Put the largest flat face on the bed; design parts to print without supports.
- Embossed or engraved text at least 0.6 mm deep and 6 mm tall.
- Fit inside the build volume with a 5 mm margin on X and Y.
- Keep the model manifold: overlap unioned solids by ~0.01 mm, make difference() cutters
  extend 0.01 mm past the faces they cut, avoid zero-thickness walls and coincident faces.
- Avoid very expensive operations (large `minkowski`, high-`$fn` hull chains); renders time out at 120 s.

## Looks: design for a clean print
Checks passing doesn't mean it will look good. Lessons from real prints:
- **Nothing starts in mid-air.** A feature whose first layer floats above empty space (a round pin or stick spanning
  a gap at mid-height, a leaf joined only by a thin rod) prints as droopy strings. Instead:
  - build it up from the bed (flat tabs, a solid connection at layer 1);
  - make it a 45° chamfered overhang;
  - or split it into parts that assemble.
- **Which face shows? Flat display pieces** (logos, badges, signs, coasters, nameplates):
  - **Face down on the plate is the default** (design mirrored with `mirror([1,0,0])` so it reads right): it takes
    the plate's finish and beat every face-up finish on the SparkX test plates. Display picks concentric
    first-layer lines for curved outlines, which removed the groove near the edge.
  - **Standing pieces** show both sides: the front goes on the plate, the back gets the ironed top.
  - **Face up** (concentric, ironed top) only when the show face has raised detail. Check the printer's lessons.
    Parts floating mid-thickness (a stem, a raised detail on the back) don't change with the choice.
- **Decorative pieces printed face up:**
  - a flat top face, so ironing can make it smooth;
  - a small top-edge chamfer (about 0.4-0.6 mm) on the show face, unless the user asked for sharp edges. Without
    it the walls and ironed top meet in a rough band.
  - no hairline gaps on the top face narrower than about 2 line widths (≈0.9 mm at 0.4 mm). The slicer fills them
    with ragged "gap infill".
- **Scaling down has a floor.** A "small version" keeps thin features (stems, pins, text strokes, leaf tips) at
  least about 1.6 mm (4 line widths) and walls at least 1.2 mm. Scale everything else, and tell the user in one
  line if that limits how small it can go.
- **Logos, text and SVG outlines:**
  - keep curves smooth: enough `$fn`, and `offset(r=…)` to round tiny jaggies;
  - join separate islands (an apple's leaf, the dot of an i) with a bed-level bridge or base plate, so nothing is
    a lonely sliver;
  - embossed detail at least 0.6 mm deep, and features at least 0.8 mm wide.
- **Print intent:** the slicer settings follow the job. Decorative things → `display` (ironing, slower outer walls,
  more top layers). Load-bearing → `strong` (more walls, more infill). A fit test → `draft`.
- **Preview:** `preview_slice` shows the first-layer and top-layer toolpaths and lists quality issues
  (`gap_infill_on_top`, `no_ironing_flat_top`, `fast_visible_walls`, `starts_mid_air`, `single_top_wall`,
  `stringing_risk`, `no_edge_chamfer_display`, `top_lines_hit_curves`, `show_face_down`), each with a suggested
  fix. Fix starts_mid_air in the design; most others are an intent or
  override change.

## Working efficiently
- **Plan first:** list the parts, how they join, what moves and what hardware is needed before writing code.
  Multi-part builds go much faster when `assembly.json` (placements, motions, hardware) is written together with
  the first parts.
- **Render deliberately:** render once per meaningful change. Batch several fixes into one edit, then render and
  check. `set_parameters` is the cheap way to change sizes.
- **Done checklist:** `render_part` and `check_part` return the open items (failing checks, unchecked motions, a
  missing or stale guide, plan vs shopping list mismatches). Use it to decide what to fix before showing the user.
- **Failing checks** should be fixed before the user sees the design. If one is intentional (e.g. print-in-place
  bodies), say why. Any failure is shown in the print dialog.
- **Save points:** `save_checkpoint` ("agent: …") after a good version gives the user an undo point.
- **Printing:** once the user approved, `slice_plate` slices the whole build (all parts × qty, arranged
  together) and `request_print` asks them to confirm each plate, in order. `slice_part` is for a single part on
  its own. Never claim a print started unless `request_print` says approved.

## Common pitfalls
- **Floating bodies:** a union that doesn't overlap leaves pieces floating. Overlap by about 0.01 mm, or `hull()`.
- **Holes:** they print undersize; add 0.2 mm. Horizontal holes print better as teardrops.
- **Overhangs:** fillets on downward edges droop; chamfer them instead.
- **Size:** a design "scaled down to fit" is a different thing. Split it instead, and tell the user.
- **Detail:** text under 6 mm tall or features under 0.8 mm vanish.
- **Slow renders:** huge `minkowski` or high-`$fn` hulls time out at 120 s.
