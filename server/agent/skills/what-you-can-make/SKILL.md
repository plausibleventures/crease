---
name: what-you-can-make
description: Map of what the Crease designer can make and with which tool - OpenSCAD with BOSL2 (precise, functional, smooth sweeps and textures), Blender sculpting scripts (figures, animals, faces, cloth, flowing forms), imported meshes, photos and SVG - what quality to expect, the printer's limits, and what genuinely can't be done. Read it before telling a user something can't be made, before suggesting any outside service or download site, and whenever a request is artistic, organic or unusual.
---

# What you can make: capability map

**Rule:** never tell the user "I can't make that" and never send them to another service or download site before
checking this map. You have a full CAD language, a sculpting tool and the user's own files. Outside services are
a last resort and always the user's choice (see the end).

## Your toolkits
| Toolkit | Best at | How |
|---|---|---|
| **OpenSCAD + BOSL2** (always there) | Exact sizes, fits, mechanisms, enclosures, text, logos, patterns. Also smooth shapes: BOSL2 rounding and sweeps are underused, use them. | `parts/<id>.scad`; `printable-openscad`, `bosl2-*`, `fit-and-tolerance` |
| **Blender sculpting** (free; optional install) | Anything that looks sculpted: people, animals, faces, busts, creatures, cloth, hair, chess pieces with characters, flowing vases. | `parts/<id>.blend.py`, run by the app; `blender-sculpting` |
| **The user's files** | A model they downloaded or made (STL, 3MF, SCAD), photos of things to fit or copy, SVG logos. | import dialog (`parts/imported/`), `refs/` photos; `measure-from-photo` |

Combine them: a sculpted figure (Blender) on a base with a magnet pocket (OpenSCAD) is two parts placed together in
`assembly.json`. A .scad part can `import("imported/<id>.stl")` an imported mesh and add a base, a hole or a hook to
it (difference/union work on meshes).

**Smooth shapes in OpenSCAD (BOSL2):** `cuboid(…, rounding=)`, `cyl(…, rounding=)` and `spheroid()` for soft
primitives; `rotate_sweep(profile)` for turned shapes (vases, chess bases, knobs); `path_sweep(shape, path)` and
`smooth_path()` for handles, rails and tubes; `skin([profiles], z=…)` for lofts that change shape (a square
base melting into a round top); `offset_sweep()` / `rounded_prism()` for rounded extrusions; `texture=` on
`cyl`, `linear_sweep` and `rotate_sweep` (`"knurled"`, `"diamonds"`, `"bricks"`, `"wave_ribs"`, `"hex_grid"`, …);
`heightfield()` and OpenSCAD's `surface(file = "…png")` for reliefs and lithophanes.

## Request → tool → what to expect
| They ask for | Use | Expect / watch |
|---|---|---|
| Hooks, brackets, holders, stands, adapters, replacement parts | OpenSCAD | Exact. Fit from a photo or a measurement; offer a quick fit test for tight fits. |
| Boxes, cases with lids, enclosures, organisers | OpenSCAD (`enclosures`) | Exact; lids and snaps need the printer's clearances. |
| Things that move: hinges, latches, gears, print-in-place toys, chains | OpenSCAD (`print-in-place`, `mechanical-joints`, `snap-fits`) | Works with 0.3-0.4 mm gaps; describe the motion in `assembly.json`. |
| Bigger than the bed (helmets, lamps, big vases, models) | Split into parts with pegs or joiners (`bosl2-joiners`; Blender `ps.keep_part`) | Glue or snap together; a picture guide. |
| Logos, names, signs, badges, cookie-cutter outlines | OpenSCAD: `text()`, `import("../refs/logo.svg")`, traced outlines | Sharp and clean face down (`print-finish`). Strokes ≥ 0.8 mm, text ≥ 6 mm. |
| Something that fits around a real object (a knob cover, a phone stand for their phone) | OpenSCAD + `measure-from-photo` | Within a few % from a photo with a card or coin; keep the size on a slider. |
| Classic turned shapes: Staunton chess pieces, goblets, candlesticks, vases | OpenSCAD `rotate_sweep` / `rotate_extrude` (or Blender `ps.lathe`) | Smooth, crisp. |
| **Figures, statues, characters, chess pieces with faces and robes, animals, pets, creatures, busts, dragons, trees** | **Blender** (`blender-sculpting`) | A hand-sculpted look like a museum-shop miniature: clear silhouette, bold features, smooth surfaces. Detail floor about 0.8 mm. Iterate against the reference 3-6 times. |
| A likeness of a person or a pet | Blender, from their photos | A stylised figurine: hair shape, glasses, ears, coat pattern, pose and colours make it recognisable. Not a portrait; say so in one line. |
| Flowing, melted, organic, "like a sculpture" vases and ornaments | Blender (metaballs, sheets, displacement) or BOSL2 `skin`/`rotate_sweep` with a `texture` | Smooth if the walls stay ≥ 1.2 mm. |
| Terrain, relief maps, lithophanes, embossed photos | OpenSCAD `surface()` / `heightfield()` from a PNG in `refs/`, or Blender displacement | Lithophanes print upright, 0.8-3 mm thick, in white. |
| Surface textures (knurling, wood grain, scales, bricks, fur) | BOSL2 `texture=`, or Blender `ps.displace` | Texture depth ≥ 0.6 mm, spacing ≥ 2 mm. |
| Several colours | `color()` per body (OpenSCAD) or `ps.color()` (Blender), loaded filaments only (`multicolor`) | Up to the printer's slots. |
| A specific existing model ("the Benchy", "that dragon on Printables") | The user downloads it and drops the file in (import) | You can't download for them. Keep its licence. Offer to modify or add to it. |

## The printer's limits (shape the design, don't refuse it)
- Detail ≥ about 0.8 mm (0.4 mm nozzle); text ≥ 6 mm tall; anything sticking out ≥ 1.6 mm thick, long thin things
  ≥ 2.4 mm and anchored at both ends.
- Overhangs up to 45° and bridges up to about 30 mm print without supports; figures often need tree supports or a
  lean. Say it in one line when it applies.
- Layer lines show on gentle curves and smaller prints look rougher: bigger is crisper (figures ≥ 60 mm show faces).
- Size: the build volume in your brief; split anything bigger.
- PLA softens around 55 °C; suggest PETG for heat or outdoors.

## What genuinely can't be done (say it plainly, offer the nearest thing)
- Detail finer than the nozzle: eyelashes, hair-thin filigree, readable 2 mm text → make it bigger, or paint it.
- A photographic likeness → a stylised figure.
- Food-safe items, toys with small parts for under-3s, anything load-bearing for people (seats, ladders, climbing,
  helmets), car or safety parts, medical devices, weapons → don't make them; offer a safe alternative (a display
  replica, a decorative piece).
- Clear like glass, strong like metal, rubbery (unless TPU is loaded), electronics → the printed part only (the case,
  not the circuit).

## When a tool is missing
If Blender isn't installed (render_part says so) and the request needs sculpting, ask once with AskUserQuestion,
recommended first:
1. **"Install Blender (Recommended)"**: "Free, about 5 minutes. It lets me sculpt the figure properly." In the
   description add how: blender.org/download (or, if they use Homebrew, `brew install --cask blender`). When they
   say it's done, render again.
2. **"Simpler shapes for now"**: "I'll make a chunkier version from smooth basic shapes right away."
3. **"Use a ready-made model"**: "Download one (e.g. from Printables) and drop the file in; I'll adapt it."
Never install anything yourself. Explain why in one plain line, not a lecture.

## Outside services are a last resort
Paid generators, commissions, marketplaces and uploading the user's photos anywhere: only if the user asks for
them, or after they turned down the options above. Never the first answer.
