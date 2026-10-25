---
name: print-finish
description: Reference for making prints look good, not just print. Why top surfaces go rough on curved outlines, concentric tops, ironing, edge chamfers, printing the show face on the plate, stems and spans that start in mid-air, minimum feature sizes when scaling down, stringing, respecting the user's artwork, and cheap 1-inch A/B test plates. Includes real cases from the apple-logo prints. Use for decorative or display pieces, logos, signs, badges, and whenever the finish matters.
---

# Print finish: reference

A part can pass every check and still look rough. Almost all finish problems come from how the slicer fills the
**top and bottom layers** and what the nozzle does **when a layer starts over air**. Decide these with the design,
not after.

## Top surfaces on curved outlines
- **Why it goes rough:** a standard top layer is straight parallel lines. Where they meet a curved wall, every line
  ends at a slightly different place. That leaves a sawtooth of line ends (about 0.5 per mm of curve) in a band
  1-2 mm inside the edge, plus slivers of "gap infill" along it. Ironing at 10% flow can't hide that band.
- **Concentric tops** follow the outline, so there are no line ends at the edge. Best for organic shapes: logos,
  leaves, circles, hearts. The Display intent switches to concentric by itself when the analyzer finds
  `top_lines_hit_curves`.
- **Straight outlines** (boxes, rectangles) look better with the default lines. Concentric leaves diagonal seams
  in square corners.
- **Ironing** smooths the top area inside the walls. It does not cover the wall ring, so the edge still shows the
  walls.

## Edges of decorative pieces
- A **0.4-0.6 mm chamfer on the top edge** of a face-up show face hides the seam where walls meet the top. Add it
  to face-up show faces unless the user wants sharp edges (face-down faces don't need it). The analyzer flags its absence as `no_edge_chamfer_display`.
- Prefer chamfers to fillets on downward edges: fillets droop.

## The plate side is the cleanest face
- The first layer is pressed flat against the build plate, so it copies the plate's finish (smooth or textured PEI)
  with crisp edges and no top-layer artefacts.
- **Flat display pieces** (logos, badges, signs, coasters, standing cut-outs): **default to face down**, mirrored
  (`mirror([1,0,0])`) so it reads right. On the SparkX textured plate the face-down face (1-inch apples F, H, I) was
  the best finish of every test: even sparkle, no marks at concave corners. Face up kept marks at the concave
  corners (bite, notches) whatever the speed, flow or ironing. Mark the part with `// @show: plate` in its .scad:
  the app's previews, assembled view and guide then show the show face (turned over); the plate view shows it as
  printed. In the assembly, place it so the show face looks where the user will see it.
- **Standing pieces show both sides.** Put the front on the plate; the back is the top and gets the concentric,
  ironed finish.
- **Curved outlines, plate side:** straight first-layer lines ending against a curved wall left a thin groove about
  1 mm inside the edge (F). Concentric bottom lines (H) don't. The Display intent switches the first layer to
  concentric by itself when the analyzer finds `bottom_lines_hit_curves`.
- Raised detail on the show face doesn't work face down. Use an inlay of the same height (multicolour) or print it
  face up.

## Nothing starts in mid-air
- A layer whose first lines have nothing under them sags into strings. Round pins or diamond-shaped stems spanning
  a gap at mid-height are the classic case: their lowest point is a line over air.
- Instead:
  - make thin connectors **square or flat-bottomed**, so their first layer is a bridge between two anchored ends;
  - or bring them **down to the bed**. On a face-down piece that's free: put the connector flush with the show face,
    so it starts on the plate and prints solid from layer 1. From the front it looks the same. A 2 mm square rod
    centred in a 10 mm thick standing logo bridged in mid-air and came out stringy and flimsy (Testdrive, 2026-10-10);
  - or **split and assemble**.
- **Anchored spans up to about 10 mm** bridge cleanly when both ends rest on printed material. Longer ones need a
  chamfer, support or a different orientation. The analyzer reports `starts_mid_air` (design issue) and
  `long_bridge` (info).

## Minimums when scaling down
- **Thin features** (stems, pins, text strokes, leaf tips) stay at least about **1.6 mm**, which is 4 line widths
  at 0.4 mm.
- **Walls** stay at least **1.2 mm**.
- Text stays at least 6 mm tall and 0.6 mm deep.
- When someone asks for a small version, scale everything else and keep these floors. Say so in one line if that's
  why it can't get smaller.

## Stringing
- **Causes:**
  - many separate islands per layer (letters, dots, a leaf beside an apple), with travel moves between them;
  - hot nozzles;
  - wet or stringy filament (PETG especially).
- **Design fixes:**
  - join islands with a bed-level base plate or bridges;
  - keep separate parts far enough apart on the plate that travel crosses empty bed rather than a model.
- **Slicer fixes** belong to the intent or overrides: retraction, travel avoidance, a few °C cooler. The analyzer
  notes `stringing_risk`.

## Respect the artwork
- The user's logo, drawing or reference is the design. Don't flatten curves, shave lobes or thicken strokes to make
  printing easier.
- Solve printing with orientation, intent, supports, splitting or a base plate. If the artwork itself can't print
  as-is, explain the smallest change and ask.

## When unsure: a 1-inch test plate
If finish matters and the right choice isn't clear (face up or down, concentric or lines, chamfer size), offer a
cheap test before the full-size print:
- **Make it:** two or three 1-inch (25 mm) versions on one plate, each labelled A/B/C on the back (engraved
  0.6 mm). About 10-15 minutes and a few grams.
- **Different settings per version:** keep the versions' geometry identical (only the label differs) and give each
  its own slicer settings with `slice_plate` `parts[].overrides`, e.g. `{"ironing_type": "no ironing"}` for one and
  `{"ironing_pattern": "concentric"}` for another. Never change a version's shape or height to fake a setting.
- **Ask:** which one they like, then print the real thing that way. Record what won with `add_printer_lesson`.

## Real cases: the apple logo
- **v1, stock settings:**
  - Ragged gap infill along the curved top edge: one top wall, fast walls, no ironing.
  - A round 2 mm stem joining the leaf started in mid-air at half height, so it drooped and strung.
- **v2:**
  - The agent shaved the bottom lobes flat "so it stands" and fattened the stem: it changed the artwork. Don't.
- **v3, Display intent with lines:**
  - Ironed top, but a rough band 1-2 mm inside the edge where top lines ended against the curve. Concentric fixes
    it.
- **1-inch test plate A/B/C:** face down (A) looked worse than face up on both faces; concentric tops fixed the
  line-end band, but straight 90° ironing left drag marks where each pass ended at the curved edge (use concentric
  ironing with concentric tops); a stepped 0.4 mm chamfer made no visible difference at 1 inch.
  - The plate side was the cleanest face of all.
- **D/E (face up, concentric top):** concentric ironing (D) beat no ironing (E). Both kept short stacked marks at
  the concave corners, where every concentric loop turns sharply.
- **F/G:** F face down: best face yet, but a thin groove ~1 mm inside the edge (straight first-layer lines). G face
  up with a slower, thinner top: same corner marks as D.
- **H/I (both face down):** H concentric first layer and I straight lines with 50% wall overlap both came out
  clean. Concentric (H) is the default because it removes the cause.
- **Testdrive (standing logo, 2 inches, 10 mm thick, face down, separate slotted base):** clean faces on both sides
  and the base fit first time. The 2 mm square rod to the leaf was centred in the thickness, so it bridged from
  mid-height and showed gaps and a hair of string: flimsy. Put such connectors flush with the plate face.
