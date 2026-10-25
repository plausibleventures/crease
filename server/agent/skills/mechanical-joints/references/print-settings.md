# Print Settings & Materials Reference
<!-- Vendored reference from obelisk-complex/claude-skills src/3d-print-design/references/print-settings.md (MIT). Crease: slicing runs only through `slice_part` (OrcaSlicer, Creality SPARKX i7 profile); treat the slicer settings below as background for explaining or choosing settings, not as steps to run. -->

Material selection, slicer settings, and post-processing guidance.

## Table of Contents

1. [Material Selection Guide](#material-selection-guide)
2. [Material Properties Table](#material-properties-table)
3. [Slicer Settings by Material](#slicer-settings-by-material)
4. [Layer Height Selection](#layer-height-selection)
5. [Infill Strategy](#infill-strategy)
6. [First Layer and Bed Adhesion](#first-layer-and-bed-adhesion)
7. [Support Settings](#support-settings)
8. [Post-Processing](#post-processing)
9. [Troubleshooting Common Issues](#troubleshooting)
10. [Print Time Estimation](#print-time-estimation)

---

## Material Selection Guide

### Decision tree

```
Is the part structural or cosmetic?
├─ Cosmetic/prototype → PLA (cheapest, easiest, looks great)
└─ Structural/functional
    ├─ Will it see temperatures >50°C?
    │   ├─ Yes → ABS, ASA, or PETG (PETG up to ~70°C, ABS/ASA up to ~100°C)
    │   └─ No → PETG (tougher than PLA, no enclosure needed)
    ├─ Will it be outdoors (UV exposure)?
    │   ├─ Yes → ASA (UV-resistant ABS alternative)
    │   └─ No → PLA or PETG
    ├─ Does it need flexibility?
    │   ├─ Yes → TPU (flexible, impact-resistant)
    │   └─ No → continue
    ├─ Does it need chemical resistance?
    │   ├─ Yes → PETG or nylon
    │   └─ No → continue
    └─ Does it need maximum strength?
        ├─ Yes → Nylon (PA6/PA12), CF-filled nylon, or PETG
        └─ No → PETG for general functional parts
```

### Quick recommendation

| Use case | Material | Why |
|---|---|---|
| First prototype | PLA | Cheap, easy, fast |
| Functional prototype | PETG | Tough, temperature-resistant enough for most indoor uses |
| Outdoor enclosure | ASA | UV-stable, weather-resistant |
| Snap fits / flexible features | PETG or nylon | PLA is too brittle |
| High-temperature (near heatsinks) | ABS or ASA | Higher Tg than PETG |
| Impact resistance | PETG or TPU | PLA shatters, PETG bends |
| Gears / bearings / wear parts | Nylon or POM | Low friction, self-lubricating |
| Gaskets / bumpers / grips | TPU (85A-95A shore) | Flexible, grippy |

## Material Properties Table

| Property | PLA | PETG | ABS | ASA | Nylon (PA12) | TPU (95A) |
|---|---|---|---|---|---|---|
| Tensile strength (MPa) | 50-60 | 45-55 | 35-45 | 40-50 | 40-55 | 30-40 |
| Elongation at break | 3-6% | 15-25% | 10-20% | 10-20% | 30-100% | 300-500% |
| Impact resistance | Low | High | Medium | Medium | Very high | Very high |
| Heat deflection (°C) | 50-55 | 65-75 | 95-105 | 95-105 | 80-90 | 60-80 |
| UV resistance | Poor | Fair | Poor | Good | Poor | Fair |
| Moisture absorption | Low | Low | Low | Low | High | Medium |
| Print difficulty | Easy | Easy | Medium | Medium | Hard | Medium |
| Needs heated bed? | Optional | Yes | Yes | Yes | Yes | Optional |
| Needs enclosure? | No | No | Yes | Yes | Yes | No |
| Bed temp (°C) | 50-60 | 70-80 | 95-110 | 95-110 | 70-80 | 50-60 |
| Nozzle temp (°C) | 190-220 | 225-245 | 230-250 | 235-255 | 240-270 | 220-240 |

### Filament storage

Hygroscopic materials (nylon, TPU, PVA, PETG to a lesser degree) absorb
moisture from the air, causing printing defects (stringing, bubbles, poor
surface quality). Store these in sealed containers with desiccant. Dry before
printing if they have been exposed: 4-6 hours at 50-70°C in a filament dryer
or low-temperature oven.

## Engineering and Specialty Materials

Materials beyond the core six. These fill specific niches where the standard
materials fall short. Most require a hardened steel nozzle, all-metal hotend,
or enclosed printer.

### Polycarbonate (PC)

The strongest common FDM filament. Extremely tough, high heat resistance,
optically transparent in natural form. Very difficult to print.

| Property | Value |
|---|---|
| Tensile strength | 55-75 MPa |
| Elongation at break | 80-120% |
| Heat deflection | 130-140°C |
| Nozzle temp | 260-310°C |
| Bed temp | 105-120°C |
| Enclosure | Required (high warp risk) |
| Print difficulty | Hard |
| Nozzle | All-metal hotend required |

Use for: high-impact enclosures, transparent covers, automotive parts,
safety-critical parts needing combination of toughness and heat resistance.

PC/ABS blends are easier to print and retain most of the toughness.

### PCTG

A copolyester related to PETG but with improved toughness, clarity, and heat
resistance. Easier to print than PC, tougher than PETG.

| Property | Value |
|---|---|
| Tensile strength | 45-55 MPa |
| Elongation at break | 100-200% |
| Heat deflection | 70-80°C |
| Nozzle temp | 235-255°C |
| Bed temp | 70-85°C |
| Enclosure | Not required |
| Print difficulty | Easy-medium |

Use for: functional parts needing PETG-like ease with better impact
performance and clarity. Growing in popularity as a "better PETG".

### PEI / ULTEM (Polyetherimide)

High-performance engineering polymer. Chemically resistant, inherently
flame-retardant (UL94 V-0), very high heat resistance. Expensive filament,
requires a capable printer with high-temperature hotend and heated chamber.

| Property | Value |
|---|---|
| Tensile strength | 85-100 MPa |
| Heat deflection | 200-215°C |
| Nozzle temp | 350-390°C |
| Bed temp | 120-160°C |
| Enclosure | Required (heated to 80-100°C+) |
| Print difficulty | Expert |

Use for: aerospace brackets, high-temperature jigs, autoclave tooling,
electrical insulators, parts near engines or heaters. One of the few
FDM-printable materials suitable for continuous use above 150°C.

### PEEK (Polyether Ether Ketone)

The highest-performing FDM-printable polymer. Comparable to some metals in
strength-to-weight ratio. Biocompatible (medical implants). Extremely
expensive ($300-800/kg) and requires specialised high-temperature printers.

| Property | Value |
|---|---|
| Tensile strength | 90-120 MPa |
| Heat deflection | 250-300°C |
| Nozzle temp | 370-430°C |
| Bed temp | 120-160°C |
| Chamber temp | 120-200°C |
| Print difficulty | Expert, specialised machine required |

Use for: aerospace, medical implants, oil/gas, semiconductor tooling. Not
practical on consumer printers; requires machines from Apium, Roboze,
Intamsys, or similar. Mention for completeness and when the user's
requirements genuinely demand it.

### Carbon Fibre Composites (CF-PLA, CF-PETG, CF-Nylon)

Short chopped carbon fibres mixed into a base polymer. Dramatically increases
stiffness and reduces warping/shrinkage. Gives a matte black finish that
hides layer lines. Requires hardened steel nozzle (carbon fibre is abrasive
and will destroy brass nozzles in hours).

| Composite | Stiffness gain | Strength gain | Print difficulty |
|---|---|---|---|
| CF-PLA | High stiffness, reduced impact | Marginal | Easy (same as PLA + hardened nozzle) |
| CF-PETG | High stiffness, good toughness | Moderate | Easy-medium |
| CF-Nylon (CF-PA) | Very high stiffness, excellent fatigue | Significant | Hard (hygroscopic, needs enclosure + dry box) |

CF-Nylon is the premier engineering FDM material for stiffness-critical parts:
drone frames, robot arms, jigs, fixtures, structural brackets. Brands like
Polymaker PA6-CF are well-regarded.

Key limitation: carbon fibres increase brittleness in PLA base. CF-PLA snaps
rather than bending. For parts needing both stiffness and impact resistance,
CF-Nylon is the answer.

### Glass Fibre Composites (GF-Nylon, GF-PETG)

Similar concept to CF composites but using chopped glass fibres. Less stiff
than CF but less brittle, lower cost, and does not affect electrical
properties (glass is non-conductive; carbon fibre is conductive).

| Property | GF-Nylon | GF-PETG |
|---|---|---|
| Stiffness | High | Medium-high |
| Impact resistance | Better than CF-Nylon | Better than CF-PETG |
| Abrasion on nozzle | Yes (hardened nozzle required) | Yes |
| Print difficulty | Hard | Medium |

Use for: electrical enclosures (non-conductive), parts needing stiffness
without the conductivity of carbon fibre, cost-sensitive structural parts.

### PVB (Polyvinyl Butyral)

Similar to PLA in printability but dissolves in isopropyl alcohol. Used as a
support material for PLA in dual-extrusion setups, or as a primary material
that can be vapour-smoothed in IPA for a glossy, layer-line-free surface.

| Property | Value |
|---|---|
| Nozzle temp | 195-215°C |
| Bed temp | 50-60°C |
| Print difficulty | Easy |
| Special feature | IPA vapour smoothing for glass-like finish |

Use for: display models needing smooth finish, support material for PLA.

### Metal-Filled Filaments (e.g., copper-fill, bronze-fill, steel-fill)

PLA or PETG base loaded with fine metal particles (50-80% by weight). Parts
feel heavy and metallic. Can be polished to a genuine metal appearance.
Purely aesthetic; not structural metal.

| Property | Value |
|---|---|
| Nozzle temp | 195-220°C (PLA base) |
| Print difficulty | Easy-medium |
| Special notes | Heavy, abrasive (hardened nozzle recommended at 0.5mm+), fragile |

Use for: decorative items, sculptures, jewellery display, props, artistic
pieces that need a metal look and feel without actual metal printing.

### Wood-Filled Filament

PLA base with wood flour/particles. Prints look and feel like wood, including
grain-like texture from layer lines. Varying nozzle temperature changes the
"burn" colour, allowing wood-tone gradients.

| Property | Value |
|---|---|
| Nozzle temp | 185-220°C (higher = darker tone) |
| Print difficulty | Easy |
| Special notes | Strings easily, needs retraction tuning. Use ≥0.5mm nozzle to prevent clogging. |

Use for: decorative items, plant pots, picture frames, architectural models.
Purely cosmetic; lower strength than standard PLA.

### HIPS (High Impact Polystyrene)

Properties similar to ABS. Primary use is as a dissolvable support material
for ABS (dissolves in D-limonene). Can be used as a primary material for
lightweight, low-cost parts.

| Property | Value |
|---|---|
| Nozzle temp | 220-240°C |
| Bed temp | 90-110°C |
| Dissolves in | D-limonene (citrus-based solvent) |

## Slicer Settings by Material

### PLA

```
Nozzle temperature:     200-210°C (start at 205)
Bed temperature:        55-60°C
Print speed:            50-80 mm/s (60 is a safe default)
Cooling fan:            100% after first layer
Retraction distance:    0.8-1.5mm (direct drive) / 4-6mm (Bowden)
Retraction speed:       35-45 mm/s
First layer speed:      20-25 mm/s
```

### PETG

```
Nozzle temperature:     230-240°C (start at 235)
Bed temperature:        75-80°C
Print speed:            40-60 mm/s (PETG is less forgiving of speed than PLA)
Cooling fan:            50-70% (too much fan causes poor layer adhesion)
Retraction distance:    1.0-2.0mm (direct) / 5-7mm (Bowden)
Retraction speed:       25-35 mm/s (slower than PLA to avoid stringing)
First layer speed:      15-20 mm/s
Z-hop:                  Enable, 0.2mm (PETG is sticky and catches on parts)
Notes:                  PETG strings more than PLA. Increasing travel speed
                        and enabling wipe/coasting helps. Avoid over-squishing
                        the first layer — PETG sticks TOO well to some beds
                        and can tear the surface.
```

### ABS / ASA

```
Nozzle temperature:     235-250°C (ABS) / 240-255°C (ASA)
Bed temperature:        100-110°C
Print speed:            40-60 mm/s
Cooling fan:            0-30% (minimal fan prevents cracking and warping)
Retraction:             0.8-1.5mm (direct) / 4-6mm (Bowden)
Enclosure:              Required (maintain 40-60°C ambient)
First layer speed:      15-20 mm/s
Notes:                  ABS releases fumes — print in a ventilated area or
                        enclosed printer with filtration. ASA has similar
                        properties but better UV resistance and slightly
                        less odour.
```

### TPU (flexible)

```
Nozzle temperature:     220-235°C
Bed temperature:        50-60°C (or no heat for some formulations)
Print speed:            20-30 mm/s (slow is critical for flexible filament)
Cooling fan:            50-80%
Retraction:             Minimal or disabled (flexible filament buckles in
                        the extruder if retracted too much)
Direct drive:           Strongly recommended (Bowden setups struggle with TPU)
Notes:                  Print slowly. If using a Bowden setup, ensure the
                        path is as short as possible and there are no gaps
                        where the filament can buckle.
```

## Layer Height Selection

| Layer height | Quality | Speed | Use for |
|---|---|---|---|
| 0.08-0.12mm | Very high detail | Very slow | Display models, fine text, miniatures |
| 0.16-0.20mm | Good quality | Moderate | Default for functional parts, enclosures |
| 0.24-0.28mm | Visible layers | Fast | Prototypes, internal parts, jigs |
| 0.32-0.40mm | Coarse | Very fast | Draft prints, large structural parts |

### Variable layer height

Most modern slicers support variable layer height: thin layers where detail
matters (curves, text) and thick layers on straight vertical sections. This
gives the best balance of quality and speed.

### Layer height vs nozzle diameter

Maximum layer height ≈ 75-80% of nozzle diameter:
- 0.4mm nozzle → max ~0.32mm layer height
- 0.6mm nozzle → max ~0.48mm layer height
- 0.8mm nozzle → max ~0.64mm layer height

Minimum layer height ≈ 25% of nozzle diameter:
- 0.4mm nozzle → min ~0.08-0.10mm

## Infill Strategy

See the `fdm-design-rules` skill for orientation/strength guidance (upstream pointed at a file not vendored here). Quick
summary:

| Part type | Infill % | Perimeters | Pattern |
|---|---|---|---|
| Visual prototype | 10-15% | 2-3 | Lightning or gyroid |
| Enclosure (general) | 20-25% | 3-4 | Gyroid |
| Structural bracket | 30-50% | 4-5 | Gyroid or cubic |
| Maximum strength | 50-80% | 5+ | Gyroid |
| Watertight vessel | 100% | 4+ | Rectilinear |

## First Layer and Bed Adhesion

The first layer is the foundation. A bad first layer means a failed print.

### Bed adhesion methods

| Method | When to use | Notes |
|---|---|---|
| Clean bed (no adhesive) | PLA on textured PEI | Usually sufficient |
| Glue stick | PETG on smooth PEI | Prevents PETG from bonding too well |
| Hairspray | ABS, ASA | Provides grip on glass beds |
| PEI sheet (textured) | Most materials | Best general-purpose surface |
| PEI sheet (smooth) | PLA, PETG | Very good adhesion, smooth bottom |
| Painters tape | Nylon, PLA | Budget option, disposable |
| Brim | Large or tall parts, small footprint parts | Extra adhesion ring |
| Raft | Very warpy materials (ABS), poor bed adhesion | Wastes material but reliable |

### First layer settings

```
First layer height:  0.20-0.25mm (thicker than other layers for squish)
First layer speed:   15-25 mm/s (slow for reliable adhesion)
First layer width:   120-150% of normal (wider for more contact area)
Cooling fan:         0% for first 1-3 layers (let it stick before cooling)
```

### Bed levelling

Proper bed levelling (or auto bed levelling mesh) is the most impactful
thing for first-layer quality. The nozzle should be close enough that the
first layer is slightly squished (wide and flat) but not so close that it
scrapes or drags. The visual test: first layer lines should touch each other
with no gaps, and the top surface should be smooth, not rough or translucent.

## Support Settings

When supports are unavoidable, these settings help:

### Support parameters

| Parameter | Value | Why |
|---|---|---|
| Support type | Tree (preferred) or normal | Tree supports use less material and are easier to remove |
| Support angle threshold | 50-55° | Below this angle, supports are generated |
| Support Z distance | 0.2mm (1 layer height) | Gap between support top and part. Larger = easier removal, rougher surface |
| Support XY distance | 0.7-1.0mm | Gap between support and part walls |
| Support density | 10-20% | Lower = less material and easier removal |
| Support interface layers | 2-3 | Dense layers at the contact point for smoother surface |
| Support interface density | 75-100% | Creates a flat platform for the part to rest on |

### Soluble supports (multi-material printers)

If the printer has two extruders, use PVA (dissolves in water) or HIPS
(dissolves in limonene) as support material. This allows complex overhangs
with perfect surface finish and no manual support removal.

## Post-Processing

### Support removal

1. Let the part cool completely first
2. Use needle-nose pliers and flush cutters
3. For tree supports: twist and snap at the base
4. For dense supports: use a craft knife or deburring tool at the interface
5. Light sanding (120-220 grit) where supports contacted the part

### Sanding

| Grit | Purpose |
|---|---|
| 80-120 | Remove heavy support marks, reshape |
| 180-220 | General smoothing, layer line reduction |
| 320-400 | Fine finish before painting |
| 600-1000 | Polishing (wet sand) |

Sand in the direction of layer lines, not across them. Wet sanding (400+
grit with water) produces the best surface finish.

### Painting

1. Sand to 220-320 grit
2. Apply filler primer (spray) — fills layer lines
3. Sand primer with 400 grit
4. Repeat primer + sand until smooth
5. Apply paint (spray or brush)
6. Clear coat for durability

PLA and PETG accept acrylic and spray paint well. ABS can be primed with
automotive primers.

### Vapour smoothing (ABS only)

Expose ABS parts to acetone vapour in a sealed container. The surface melts
slightly, filling layer lines and creating a glossy finish. Dangerous if
done improperly (acetone is flammable) — research the process thoroughly.

### Heat-set insert installation

1. Heat soldering iron to recommended temperature (200-230°C for PLA, higher
   for PETG/ABS)
2. Place insert on the hole, knurled end down
3. Press iron into the insert (use a flat or dedicated tip)
4. Push slowly and straight — the plastic melts and the insert sinks in
5. Stop when the insert is 0.2mm below the surface
6. Remove iron, let cool for 30 seconds
7. Test with a screw

### Threading and tapping

For printed threads that are too tight:
- Run a real tap through the hole (M3, M4, etc.) to clean up the thread
- For external threads: use a die
- This is called "chasing" the thread and dramatically improves function

## Troubleshooting

### Common print failures and fixes

| Problem | Likely cause | Fix |
|---|---|---|
| Part detaches from bed mid-print | Poor adhesion, warping | Clean bed, lower first layer speed, add brim, increase bed temp |
| Stringing (thin threads between parts) | Retraction too low, temp too high | Increase retraction, lower temp by 5°C, enable wipe/coasting |
| Layer separation / delamination | Temp too low, fan too high, draft | Increase temp, reduce fan, check for enclosure drafts |
| Elephant's foot (bottom bulge) | First layer over-squished | Raise nozzle slightly, enable elephant foot compensation |
| Warping / corners lifting | Temp differential, no enclosure (ABS) | Use enclosure, increase bed temp, add brim, use mouse ears |
| Rough overhangs | Overhang too steep, insufficient cooling | Reduce overhang angle in design, increase fan, lower speed |
| Weak parts (break easily) | Under-extrusion, low temp, low infill | Calibrate extrusion multiplier, increase temp, increase infill/perimeters |
| Holes undersized | Nozzle path intrusion | Oversize holes by 0.2mm in design, or enable hole compensation in slicer |
| Ghosting / ringing (surface ripples) | Speed too high, frame vibration | Lower speed, tighten belts, reduce acceleration |
| Blobs / zits on surface | Seam placement, pressure issues | Set seam to sharpest corner, enable pressure advance/linear advance |

### Dimensional accuracy calibration

If parts are consistently too large or small:

1. Print a calibration cube (20mm × 20mm × 20mm)
2. Measure with calipers
3. If 20mm cube measures 20.3mm in X: adjust X steps/mm down by 1.5%
   Or apply scaling compensation in the slicer: 100 × (20/20.3) = 98.5%
4. Repeat for Y and Z

For hole accuracy specifically, most slicers have a "hole horizontal
expansion" setting — set to -0.1mm to make holes slightly larger.

## Print Time Estimation

Rough guidelines for estimating print time:

| Factor | Impact on time |
|---|---|
| Layer height halved | ~2× longer |
| Infill doubled | ~10-20% longer |
| Speed halved | ~1.5-1.8× longer (not 2× due to acceleration limits) |
| Extra perimeter | ~5-10% longer per perimeter |
| Supports | +20-50% depending on coverage |
| Size doubled (all axes) | ~8× longer (volume scales cubically) |

Most slicers give accurate time estimates after slicing. Use the slicer's
estimate, not mental math, for any print over 1 hour.

### Slicer recommendations

| Slicer | Platform | Cost | Notes |
|---|---|---|---|
| PrusaSlicer | All | Free | Excellent, open-source, good defaults |
| OrcaSlicer | All | Free | Fork of PrusaSlicer with extra features, very active development |
| Bambu Studio | All | Free | For Bambu printers, fork of PrusaSlicer |
| Cura | All | Free | Ultimaker's slicer, huge user base |
| SuperSlicer | All | Free | PrusaSlicer fork with advanced tuning options |

**Recommendation**: OrcaSlicer or PrusaSlicer. Both are open-source,
well-maintained, and produce excellent results. OrcaSlicer has more bleeding-
edge features; PrusaSlicer is slightly more conservative.
