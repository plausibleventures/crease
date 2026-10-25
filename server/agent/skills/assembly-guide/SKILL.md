---
name: assembly-guide
description: Assembly for Crease designs - placements and motions in assembly.json while designing, check_motion for moving parts, and the IKEA-style build guide (parts page, real-size hardware with shopping links, one picture + check per step). Always applies when a design has more than one part, any bought hardware (screws, inserts, nuts, magnets, springs, bearings, pins, wall anchors, adhesive strips, glue...) or anything that moves (hinge, slider, spinning part, latch).
---

# Assembly: reference

A design whose parts go together, that needs any hardware, or that has anything that moves works best with an
`assembly.json` from its first version, kept in sync as it changes. It lets the user see the parts fit and move while
designing (the 3D view builds the assembled scene from `placements` + `motions`). It also gives them a guide they can
build from without asking a question.

Independent pieces that only share a plate (test pieces, variants, a set of coasters) don't need an assembly or a
guide.

## What good looks like
- Holes sized for real hardware (`references/hardware.md`), as Customizer parameters.
- `placements` (where each part sits when built) and `motions` (everything that moves) written alongside the first
  parts via `update_assembly`, and updated when the geometry changes.
- **Motions collision-checked:** `check_motion` status is OK (not PROBLEMS or INCOMPLETE) with no clearances under
  0.2 mm. Fixes: move the hinge axis, add clearance, cut a relief, or shrink the range. INCOMPLETE means some geometry
  wasn't checked (a part without a placement, a part that isn't a closed solid, placed hardware without a size): fix
  it and re-run. Give `hardwarePlacements` for hardware near moving parts (hinge pins, screws whose heads stick out,
  magnets, springs) so it is included: each item stands upright on z = 0 centred on Z (screws head-up), rotated then
  translated like a part; one in a moving part gets `"movesWith": "lid"`. The check samples positions;
  it does not check strength, friction or spring force. Tell the user what was checked, with its scope ("I checked
  the lid in 24 positions from closed to 110° open and nothing hits"), never just "moves freely".
- An `assembly.scad` (conventions below) whose steps look right in `render_assembly_step`.
- `build_assembly_guide` run on the current assembly. It writes the picture guide and the shopping list.

## assembly.json
```json
{
  "title": "Parts bin with hinged lid",
  "summary": "One or two sentences: what it is and how it holds together.",
  "timeMinutes": 10,
  "parts": [ { "id": "base", "qty": 1, "color": "royalblue", "name": "Base" },
             { "id": "lid", "qty": 1, "color": "orange", "name": "Lid" } ],
  "hardware": [
    { "id": "magnet", "type": "magnet", "qty": 4, "purchaseHint": "6x3mm N52 neodymium disc magnet",
      "magnet": { "shape": "disc", "diaMm": 6, "thicknessMm": 3, "grade": "N52" } },
    { "id": "pin", "type": "dowel-pin", "qty": 1, "size": "3x60", "purchaseHint": "3mm x 60mm steel dowel pin" }
  ],
  "tools": [], "consumables": [],
  "hardwarePlacements": [
    { "hardware": "magnet", "instance": 0, "translate": [-26, -16, 29.2] },
    { "hardware": "magnet", "instance": 1, "translate": [26, -16, 29.2] },
    { "hardware": "magnet", "instance": 2, "translate": [-26, -16, 32.8], "rotate": [180, 0, 0], "movesWith": "lid" },
    { "hardware": "magnet", "instance": 3, "translate": [26, -16, 32.8], "rotate": [180, 0, 0], "movesWith": "lid" },
    { "hardware": "pin", "translate": [-30, 26, 32.5], "rotate": [0, 90, 0] }
  ],
  "placements": [
    { "part": "base", "translate": [0, 0, 0] },
    { "part": "lid", "translate": [0, 0, 36], "rotate": [180, 0, 0] }
  ],
  "motions": [
    { "id": "lid", "label": "Lid opens", "type": "rotate", "parts": ["lid"], "axis": [-1, 0, 0],
      "origin": [0, 26, 32.5], "range": [0, 110], "check": "Swings open to about 110° without rubbing." }
  ],
  "steps": [
    { "n": 1, "title": "Press in the base magnets", "adds": ["base", { "id": "magnet", "qty": 2 }], "action": "push",
      "text": "Press one magnet into each front corner post.",
      "check": "Both magnets sit flush with the top of the posts." },
    { "n": 2, "title": "Fit the hinge pin", "adds": ["lid", { "id": "magnet", "qty": 2 }, "pin"],
      "explodeDirection": [1, 0, 0], "explodeDistance": 70, "action": "slide",
      "glue": [{ "kind": "no-glue", "at": [0, 26, 32.5], "size": [36, 7, 7], "label": "the pin must turn" }],
      "text": "Line up the hinge loops and push the pin through from the side.",
      "check": "The lid swings open and shut smoothly.", "showMotion": "lid" }
  ]
}
```
- `placements`: one per part instance (`instance` 0-based when qty > 1). The part's exported mesh (print orientation)
  is rotated (X, then Y, then Z, degrees) then translated into its built position. Same convention as OpenSCAD
  `translate(t) rotate(r)`.
- `motions`: `type` rotate (degrees about `axis` through `origin`) or translate (mm along `axis`); `parts` = part ids
  (all instances) or `"part#i"`; `range` is relative to the placed pose (0 = as placed); `rest` = default pose
  (defaults to range[0]); `continuous` for things that spin freely. Ids use letters/digits/_ (they become
  `motion_<id>` in OpenSCAD). `label` in a beginner's words ("Lid opens", "Drawer slides out"); `check` says how it
  should feel ("Slides out 40 mm and stops without falling out").
- A part in two motions (a lid hinged on a sliding drawer): motions apply in the order listed, first one first, all
  axes/origins as placed. List the inner one (the hinge) before the one that carries it (the drawer).
- `parts[].id` must be a project part. `color` is the filament colour (CSS name or `#hex`).
- Ids are unique across parts, hardware and consumables. Every part and hardware item is added in some step, and step
  quantities sum to `qty`. `adds`: a bare id means "all of them"; split over steps with `{ "id", "qty" }`.
- Steps are numbered 1..N. `explodeDirection` (default `[0,0,1]`, model coordinates) / `explodeDistance` (mm, default 30)
  pull the new items back. `view` = camera rotation `[rx, ry, rz]` (default `[55, 0, 25]`; rx 0 = top, 90 = level).
- `showMotion` on the step after which the thing can move: the guide shows a small "How it moves" strip (3 poses).

### Step pictures drawn from geometry
When every part instance has a `placement` and every bought item with a shape (screws, nuts, inserts, magnets, pins,
rods, offcuts, feet, bearings, springs, strips…) has a `hardwarePlacement`, `render_assembly_step` and
`build_assembly_guide` draw each step from the geometry instead of rendering assembly.scad: earlier parts grey, the
step's new items in colour pulled back along the way they go in, a camera chosen to show that, typed arrows,
callouts with leader lines to the actual parts (printed parts get letters A, B, C… in `parts` order, the same as the
plate labels), hatched glue / no-glue regions and a close-up circle when the joint is small. So give
`hardwarePlacements` for **all** such hardware, not only near moving parts. The build result says which way the
pictures were made (`stepPictures`) and, if from assembly.scad, why. Fill these per step:
- `action`: what the hands do. `place` / `insert` (straight arrow), `slide` (pins, drawers, rails), `push` (press fits,
  magnets, inserts, feet), `snap` (clips: "click!"), `twist` (bayonets, lids that screw on), `screw`. Defaults: screw for
  screws/bolts, push for magnets/inserts/feet, insert otherwise.
- `insert`: the direction the new items travel to go in, in assembly coordinates (`[0, 0, -1]` = down into it). Default:
  opposite `explodeDirection`, else a placed hardware item's own axis (it stands head-up, so it goes in along its -Z),
  else inferred from the placements. Give it whenever the inference could guess wrong (a part that slides in sideways).
- `glue`: `[{ "kind": "glue", "at": [x, y, z], "size": [w, d, h], "part": "handle", "label": "a drop in each hole" },
  { "kind": "no-glue", "at": [...], "size": [...], "label": "keep the middle loops dry" }]` — boxes in assembled mm
  around where glue goes / must not go (`part` = the item it is on, so it moves with it). Use them whenever a step
  uses glue, and a `no-glue` region wherever glue would stop something moving.
- `closeUp`: `true` to force a close-up of the joint, `false` to suppress it, or `{ "at": [x, y, z], "size": 20 }`.
- `focus`: part refs a step acts on when it adds nothing new ("Click it shut" → `["lid"]`, `action: "snap"`).
- Leave `view` out unless the automatic camera shows the wrong side; with `view` set the camera is fixed.
Look at every step with `render_assembly_step`: the arrow must point the way the item goes in and the labels must sit
on the right parts. assembly.scad is still used for steps that can't be drawn from geometry and for posing checks.

### Hardware: always give a buyable spec
Every bought item needs enough detail to order the right thing and match it against the 1:1 drawing:
- `type`: screw | bolt | nut | washer | heat-set-insert | threaded-insert | magnet | spring | bearing | rod | dowel-pin |
  standoff | o-ring | rubber-foot | wall-anchor | adhesive-strip | zip-tie | glue | tape | electronics | other.
- Threaded items: `size` "M3x10" (thread x length; under the head, overall for countersunk), `head`
  (socket | button | countersunk | pan | hex | flange | cheese | grub), `drive`, `standard` (ISO 4762 / DIN 912 socket,
  ISO 7380 button, ISO 10642 / DIN 7991 countersunk, ISO 7045 pan, ISO 4017 hex bolt, ISO 4032 nut, ISO 7089 washer, DIN 985 nylock),
  `material` (A2 stainless, steel 8.8 zinc, 12.9 black oxide, brass, nylon).
- Springs: `spring` {kind, wireDiaMm, outerDiaMm, freeLengthMm, rateNPerMm if known, solidLengthMm, material}.
- Bearings: `bearing` {designation (608, 625, 623, MR85...), boreMm, outerDiaMm, widthMm, seal (2RS, ZZ)}.
- Magnets: `magnet` {shape disc|block|ring, diaMm or lengthMm x widthMm, thicknessMm, grade}; polarity goes in a warning.
- Rods / dowel pins: `size` "3x20" (dia x length). O-rings: `size` "10x1.5" (ID x cross-section). Rubber feet: `size`
  "10 x 3 mm". Wall anchors: `size` "6x30" (plug dia x length, = drill size) plus the screw that goes with them.
  Adhesive strips: `size` "20x50" (width x length mm) and the load rating in `notes`.
- Make-it-yourself pins and axles: when a pin is cut from the user's filament (1.75 mm filament makes a good hinge pin),
  use `type: "filament-offcut"`, `size: "1.75x40"` (diameter x length to cut). It is drawn at real size with
  "Cut 40 mm from your 1.75 mm filament" and never gets store links. Prefer it over a bought pin when 1.75 mm is strong
  enough (light hinges, lid pins, alignment pegs); model it in assembly.scad as `rod(1.75, 40)`.
- `purchaseHint`: a clean generic search term ("M3x10 button head screw ISO 7380 A2"), never a brand link.
- `substitutes` (optional): other sizes that genuinely work in THIS design, so a builder can use what they have:
  `[{ "size": "M3x10", "purchaseHint": "M3x10 button head screw", "note": "hole is 11 mm deep: still 4 threads engaged" }]`.
  Only list one after checking the geometry (hole depth, pocket size, clearance); never as a guess. The shopping list
  shows exactly these and nothing else.
- `fit` (optional): one plain dimensional note for buyers ("pockets are 6.2 mm across, 3.2 mm deep: 6x3 discs only").
- Prefer few distinct sizes and hardware from common assortment kits (M2-M5 6-20 mm, standard inserts, 6x3 magnets, 608 bearings).
- List the tools (hex key size per screw head, screwdriver PH0-PH2, spanner size, soldering iron with insert tip for
  heat-set inserts, drill + bit size for wall anchors) and consumables (CA glue, epoxy, threadlocker, grease).

## assembly.scad conventions
```openscad
include <lib/studio_assembly.scad>   // written by the app: stage(), at(), moving(), part(), screw(), nut(), washer(),
                                     // heat_insert(), spring(), rod(), bearing(), magnet(), o_ring(), wall_anchor(), adhesive_strip()
stage(1, "royalblue", dist = 0) at("base");                    // part at its placement; anchor does not move
for (p = [[-26, -16], [26, -16]]) stage(1, STEEL, at = [p[0], p[1], 32], line = true) magnet(6, 3);
stage(3, "orange") at("lid");                                   // at() = placement + the lid's motion pose
moving("lid") for (p = ...) stage(3, STEEL, at = [p[0], p[1], 32], dist = 0.55) mirror([0, 0, 1]) magnet(6, 3);
stage(4, STEEL, at = [-30, 26, 32.5], line = true) rotate([0, 90, 0]) rod(3, 60);
```
- `at("<id>", i)` places a printed part from assembly.json `placements` and applies its motions (generated
  `lib/studio_assembly_data.scad`). Never position parts by hand and never wrap `at()` in `moving()` (it would move twice).
- Hardware that rides on a moving part goes inside `moving("<motion id>")`, outside `stage()`.
- `motion_<id>` (0..1 across the range) poses the moving parts; renders default to each motion's rest.
  `render_assembly_step(step, pose = {"lid": 1})` shows it fully open.
- Wrap every item in `stage(n, colour, ...)`, n = the step that adds it. Earlier steps turn grey, the current step is
  coloured and pulled back along explodeDirection. Step 0 in `render_assembly_step` = the finished assembly.
- `stage` options: `at` = where the item sits (children modelled at the origin; needed for `line`); `line = true` draws a
  dashed guide line into the hole (screws, inserts, pins, magnets); `dist` multiplies the explode distance (0 = stays
  put; >1 so screws clear the part they pass through); `dir` overrides the direction per item.
- Hardware modules point down -Z with their seating face at z = 0; `spring()`, `rod()`, `bearing()` go up +Z.
- Colours: filament colour per part; `STEEL`, `BLACK_STEEL`, `BRASS`, `RUBBER` for hardware. White parts: pick a
  `view` where their big face is lit.
- To show the underside, flip the model for that step only (`rotate(step == 5 ? [180, 0, 0] : [0, 0, 0]) { ... }`,
  "turn it over") rather than a camera from below.

## Steps: simple enough for a first-timer
- **At most ~8 steps.** Group trivial actions (all four feet = one step). One step = one thing the hands do.
- `title`: 2-4 words, imperative ("Fit the hinge pin"). `text`: **1-2 short sentences**, concrete: what goes where and
  which way round ("lip down", "notch up"). The picture carries the rest.
- **Every step has a `check`**: what they see or feel when it is right, completing "You got it right when…"
  ("both magnets sit flush with the top of the posts", "the lid clicks shut"). Shown in a green box under the text.
- `warnings` only for real risk (hot iron, overtightening into plastic, magnet polarity, glue time). `tips` are optional.
- **A step shows what it uses**: every hardware item, offcut or supply the step's hands touch is in that step's `adds`
  (the first time it is used). `update_assembly` warns when the text mentions an item no step has added yet, or a step
  adds nothing and shows no motion; fix both (add it, or merge the step).
- Write `check` as the end of the sentence "You got it right when…", starting lowercase ("the lid clicks shut").
- Quantities appear as "4×" callouts automatically. Name parts the same way everywhere, in the user's words.
- Use `showMotion` on the step where a moving part first works, so the builder sees how it should move.

## Where to buy
The guide and `build/shopping-list.md` / `.csv` (written by `build_assembly_guide`) link every hardware item to store
**searches** for its `purchaseHint`, in the user's configured stores (Settings → sourcing; default US: Amazon, AliExpress,
Bolt Depot for fasteners, McMaster-Carr), with a suggested pack size. So make each `purchaseHint` a clean search term
for the exact spec, no notes or brackets: "M3x10 button head screw ISO 7380 A2", "608 2RS bearing",
"6x3mm N52 neodymium magnet". Put fit notes (hole sizes etc.) in `notes`.

## Finding exact parts (on request)
Default guides use search links only. When the user asks for specific products:
- Use WebSearch / WebFetch to find listings, and open each listing page before using it.
- Only record a part number, price or link that you saw on a page you actually opened. Never guess or reconstruct
  part numbers (McMaster numbers, ASINs) or prices; if a page would not load, say so and keep the search link.
- Prefer listings that match the exact spec: standard (ISO 7380 etc.), thread and length, material/finish, and a pack size
  close to the suggestion. Say when a listing differs (e.g. DIN 912 instead of ISO 4762 is fine; 12.9 black vs A2 is not the same).
- Add them to the item as `listings`: `[{ "store": "McMaster-Carr", "title": "...", "url": "https://...",
  "partNumber": "...", "price": "$x.xx / 100", "packSize": 100, "retrievedAt": "YYYY-MM-DD" }]` (today's date), then rebuild the guide.
  Tell the user prices change and were checked on that date.

See `references/hardware.md` for hole sizes and hardware dimensions, and `references/example.md` for a complete project.
