---
name: multicolor
description: Designing multicolour parts for Crease's 4-slot Creality CFS — one color() per filament slot, colour regions as separate non-overlapping bodies, at most filamentSlots colours, layer-aware design that minimises colour changes and purge waste, and how to hand a multicolour part to the slicer. Use whenever a part has more than one colour (logos, labels, inlays, two-tone parts, multi-material).
---

# Multicolour design (CFS, up to 4 filament slots)

The SPARKX i7 has a CFS unit with `filamentSlots` (4) spools and a single nozzle. Every colour change on a layer
means a filament swap, which costs time and purge waste: typically ~0.1–0.5 g per change, depending on the slicer's
flush volumes. That is often more than the colour feature itself weighs. Good multicolour design is mostly about **fewer swaps**.

## 1. How colour works in this app

- Colour comes from OpenSCAD `color()`. Each distinct colour is one filament slot. The 3MF export keeps it: every
  triangle carries its colour (verified with OpenSCAD 2026.10 + Manifold), and `render_part` images show the colours.
- `check_part` fails when the part file has more distinct `color()` values than the printer's `filamentSlots`. It
  counts only **literal** `color("name")` / `color([r,g,b])` calls in the part file itself, so:
  - Write colours as literals in the part file, e.g. `color("white")`. Colours set through variables, or inside `lib/`
    modules, are invisible to the check.
  - Use the same spelling every time. `"White"`, `"white"` and `[1,1,1]` are counted as different colours.
- Put the slot map as a comment at the top of the part, so the user can load the right spools:

```openscad
// Filament slots (CFS): 1 = "white" (body), 2 = "black" (text), 3 = "red" (logo)
```

- Use colour names the user can match to real spools (white, black, red, blue, orange, grey, …). Ask which filaments
  they have loaded if it matters.

## 2. Geometry rules

- **Each colour region is its own solid, and different-coloured solids must never overlap.** Where two colours share a
  volume, the colour in the overlap is undefined. Carve the inlay out of the base with the **same** shape you use for the
  inlay, so the two meet exactly:

```openscad
/* [Badge] */
w = 60;          // [30:1:120]
h = 30;          // [15:1:80]
t = 3;           // [2:0.2:6]
label = "PS";
inlay = 0.6;     // [0.4:0.2:1.2] colour depth (3 layers at 0.2)
/* [Hidden] */
$fn = $preview ? 32 : 96;

module text_shape() linear_extrude(inlay + 0.01) text(label, size = h * 0.5, halign = "center", valign = "center");

// slot 1: body
color("white") difference() {
  translate([-w / 2, -h / 2, 0]) cube([w, h, t]);
  translate([0, 0, t - inlay]) text_shape();
}
// slot 2: text, flush with the top
color("black") translate([0, 0, t - inlay]) intersection() {
  text_shape();
  translate([-w / 2, -h / 2, 0]) cube([w, h, inlay]);
}
```

- **Flush inlays beat raised ones.** A flush inlay on the top face, 2–4 layers deep (0.4–0.8 mm), gives a crisp
  colour, a flat top and only a few swap layers. Raised text works too, but every layer it spans is a swap layer.
- **Minimum colour feature:** strokes ≥ 0.8 mm wide (2 lines), text ≥ 6 mm tall, colour depth ≥ 0.4 mm (2 layers).
  Anything thinner gets lost in purge smear or line-width rounding.
- Bodies of different colours that touch exactly (face to face) are fine: they export as one connected mesh per colour
  region. A colour body floating on its own fails the floating-bodies check.

## 3. Minimise colour changes per layer (purge waste)

Every layer that contains N colours costs N−1 swaps or more. Design so that as few layers as possible contain more
than one colour:

- **Put colour on faces that are parallel to the bed.** The best is the top face (a few layers with swaps) or the
  bottom face (a first-layer inlay, which looks crisp from below and suits nameplates or coasters). Colour running up a
  vertical wall forces swaps on *every* layer of that height.
- **Stack colours in Z instead of side by side:** a two-tone part split at a Z height (e.g. a white base with a black
  top band) costs **one** swap in total.
- **Thin colour skins:** colour only the visible 0.4–0.8 mm of a surface, and print the bulk in the body colour.
- **Group colours by height.** Two colour features on the same few layers cost about the same as one. Spreading them
  over different heights multiplies the swaps.
- **Fewer colours.** Each extra colour on a layer adds a swap. If 3 colours would do, don't use 4.
- Estimate and mention the cost: swap layers × (colours per layer − 1) × ~0.3 g of purge (a rough figure; the slicer's flush settings decide). If the purge waste is more than
  the part, say so and suggest a cheaper layout (Z-split, bottom-face inlay, or fewer colours).

## 4. Multi-material

- A slot can hold a different material (for example TPU feet on a PLA body). Only combine materials that bond (PLA+PLA,
  PETG+PETG, PLA+TPU is fair). PLA and PETG don't bond, which makes them useful as an easy-release support interface
  but never as a structural joint.
- Treat each material as its own colour/slot and note the material in the slot comment.

## 5. Slicing and printing

- `slice_part` / `slice_plate` slice multicolour parts for the CFS automatically. Each distinct `color()` value is
  matched to a loaded filament slot (exact name first, then the nearest colour); every body must sit inside exactly
  one `color()`. The result includes `filamentBySlot` (grams per slot, including purge) and `colorChanges`.
- If slicing fails because a colour isn't loaded, or geometry is outside every `color()`, the error lists the loaded
  slots. Change the `color()` values to the loaded colours, or ask the user to load the filament.
- Report `colorChanges` and the per-slot grams. Many changes mean lots of purge and time: suggest moving colour into
  Z bands or onto top faces. Multicolour CLI slicing is not yet verified on the real i7 (first print: a small 2-colour test).
- Keep a wipe/prime tower in mind for the bed fit. It needs roughly 30 × 30 mm of free plate.

## 6. Checklist

- [ ] Colour count ≤ `filamentSlots`, literal `color()` calls in the part file, consistent spellings, slot-map comment.
- [ ] Colour bodies do not overlap: base carved with the same shape as the inlay.
- [ ] Colour features ≥ 0.8 mm wide and ≥ 0.4 mm deep. Text ≥ 6 mm tall.
- [ ] Colour lives on bed-parallel faces or in Z bands where possible. Purge estimate given if swaps are many.
- [ ] `render_part`: are the colours visible and in the right places? `check_part`: no `fail` (colours, floating bodies).
- [ ] Reply gives the slot mapping, `colorChanges` and grams per slot from the slice result.
