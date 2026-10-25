# Metric hardware for 3D-printed parts

Nominal sizes from the ISO/DIN standards. Printed holes come out ~0.1-0.2 mm small on FDM:
the "print" columns already include that allowance for a typical 0.4 mm nozzle; tune per printer profile.

## Screws and holes (mm)

| Thread | Clearance hole (print) | Close fit | Self-tap into plastic (print) | Tap drill | Hex key: socket / button & CSK | Socket head Ø × h (ISO 4762) | Button head Ø × h (ISO 7380) | CSK head Ø (ISO 10642) | Counterbore Ø × depth for socket head |
|---|---|---|---|---|---|---|---|---|---|
| M2   | 2.4 | 2.2 | 1.8 | 1.6  | 1.5 / 1.3 | 3.8 × 2   | 3.5 × 1.3  | 4.0   | 4.4 × 2.3 |
| M2.5 | 2.9 | 2.7 | 2.2 | 2.05 | 2 / 1.5   | 4.5 × 2.5 | 4.7 × 1.5  | 5.0   | 5.2 × 2.8 |
| M3   | 3.4 | 3.2 | 2.7 | 2.5  | 2.5 / 2   | 5.5 × 3   | 5.7 × 1.65 | 6.72  | 6.2 × 3.3 |
| M4   | 4.5 | 4.3 | 3.6 | 3.3  | 3 / 2.5   | 7 × 4     | 7.6 × 2.2  | 8.96  | 7.8 × 4.3 |
| M5   | 5.5 | 5.3 | 4.5 | 4.2  | 4 / 3     | 8.5 × 5   | 9.5 × 2.75 | 11.2  | 9.4 × 5.3 |
| M6   | 6.6 | 6.4 | 5.4 | 5.0  | 5 / 4     | 10 × 6    | 10.5 × 3.3 | 13.44 | 11 × 6.3  |
| M8   | 9.0 | 8.4 | 7.2 | 6.8  | 6 / 5     | 13 × 8    | 14 × 4.4   | 17.92 | 14 × 8.3  |

- Clearance (ISO 273 medium) for screws that pass through a part; close fit only for locating.
- Self-tapping metric screws into plastic: fine for a few assemblies; use heat-set inserts or nuts for anything opened repeatedly.
- Countersunk: 90° cone, head Ø + 0.4 mm at the surface. Print the countersink facing up or it needs support.
- Thread engagement: at least 1.5 × d into plastic, at least 1 × d into a nut/insert. Screw length = clamped thickness + engagement; round to stock lengths 4, 5, 6, 8, 10, 12, 14, 16, 20, 25, 30 mm.
- Bosses for screws: outer Ø ≥ 2 × hole Ø (≥ 2.5 × for heat-set inserts), wall ≥ 1.6 mm.

## Heat-set inserts (typical "standard" CNC Kitchen / Ruthex size; check the supplier's sheet)

| Thread | Hole Ø (print) | Insert length | Hole depth | Insert OD | Min boss Ø |
|---|---|---|---|---|---|
| M2   | 3.2 | 4.0 | 5 (+ screw run-out) | 3.6 | 6   |
| M2.5 | 4.0 | 5.7 | 6.7 | 4.6 | 7.5 |
| M3   | 4.0 (short M3x3: 4.0) | 5.7 (or 3.0 / 4.0 short) | 6.7 | 5.0 | 8   |
| M4   | 5.6 | 8.1 | 9.1 | 6.3 | 10  |
| M5   | 6.4 | 9.5 | 10.5| 7.1 | 11  |

- Hole depth = insert length + 1 mm, plus extra if the screw goes past the insert. Straight (not tapered) hole, small chamfer on top.
- Insert with a soldering iron and insert tip: PLA ~220 °C, PETG ~250 °C, ABS/ASA ~260 °C. Press straight, stop flush; let cool.
- Inserts go in before parts that block the iron or melt nearby (step 1 of the build).

## Nuts and washers

| Thread | Hex nut AF × height (ISO 4032) | Nylock height (DIN 985) | Nut trap (print): AF × depth | Spanner | Washer ID × OD × t (ISO 7089) |
|---|---|---|---|---|---|
| M2   | 4 × 1.6   | 2.8 | 4.3 × 1.9 | 4  | 2.2 × 5 × 0.3  |
| M2.5 | 5 × 2     | 3.5 | 5.3 × 2.3 | 5  | 2.7 × 6 × 0.5  |
| M3   | 5.5 × 2.4 | 4   | 5.8 × 2.7 | 5.5| 3.2 × 7 × 0.5  |
| M4   | 7 × 3.2   | 5   | 7.3 × 3.5 | 7  | 4.3 × 9 × 0.8  |
| M5   | 8 × 4.7   | 5   | 8.3 × 5.0 | 8  | 5.3 × 10 × 1   |
| M6   | 10 × 5.2  | 6   | 10.3 × 5.5| 10 | 6.4 × 12 × 1.6 |
| M8   | 13 × 6.8  | 8   | 13.4 × 7.1| 13 | 8.4 × 16 × 1.6 |

- Hexagon across corners = AF / cos(30°) = 1.155 × AF. In OpenSCAD: `cylinder(d = AF / cos(30), h = depth, $fn = 6)`.
- Nut traps: hexagonal pocket (nut can't spin) or a side-loading slot (AF + 0.3 wide) for nuts that would otherwise be unreachable.
  Orient the trap so the nut is inserted before the part that covers it, and say so in that step.

## Magnets
- Press-fit pocket: Ø + 0.1-0.15 mm, depth + 0.2 mm; or Ø + 0.3 and glue (CA). Common: 6×3, 8×3, 10×2, 10×3, 12×3 mm discs, N35-N52.
- Magnets pairs must face opposite poles: warn in the step, suggest marking one face with a pen first.
- A print-in-place pause (embed a magnet mid-print) is not an assembly step; mention it in the part notes instead.

## Springs (compression)
- Specify wire Ø, outer Ø (OD), free length L0, and the rate k (N/mm) if it matters. Solid length ≈ total coils × wire Ø.
- Pocket Ø = OD + 0.5 mm (the coil grows when compressed); a guide pin inside = ID − 0.5 mm.
- Working stroke ≤ ~70 % of (L0 − solid length). Force at a deflection x is k × x.
- Generic sizes are sold in assortment boxes ("compression spring assortment 0.5 mm wire"); give a size the user can measure.

## Bearings and shafts

| Bearing | Bore × OD × width | Use |
|---|---|---|
| 623  | 3 × 10 × 4  | small idlers |
| 625  | 5 × 16 × 5  | small idlers |
| MR85 | 5 × 8 × 2.5 | tiny pivots |
| 688  | 8 × 16 × 5  | thin 8 mm |
| 608  | 8 × 22 × 7  | skateboard bearing, spinners, rollers |
| 6001 | 12 × 28 × 8 | larger shafts |

- Press-fit seat for the outer race: OD − 0.05 to OD + 0.05 (print test first); slip fit OD + 0.15. Add a 0.5 mm shoulder so it seats square.
- Shaft through the bore: printed shaft = bore − 0.1 (tight) or use a steel rod / bolt.
- Steel rod / dowel pin (ISO 8734 / ISO 2338): slip hole d + 0.2, press hole d (printed holes shrink); length in the size ("3x20").

## O-rings
- Specify ID × cross-section (CS), e.g. 10 × 1.5 (metric) or an AS568 dash number.
- Static face seal groove: depth ≈ 0.75 × CS, width ≈ 1.3-1.5 × CS. Printed grooves are rough; seals need a smooth (top) surface.

## Other common items
- Rubber feet: self-adhesive bumpers 8-12 mm × 2-4 mm; recess Ø + 0.5, depth 0.5-1 mm so they stay put.
- Zip ties: slot = tie width + 0.5 × tie thickness + 0.5 (e.g. 3.6 mm wide ties → 4.2 × 2 mm slot).
- Threaded rod and standoffs: M3 brass standoffs (5.5 AF hex) for PCBs; PCB mounting holes 3.2 mm.
- Glue: CA for PLA/PETG small bonds (seconds), 2-part epoxy for structural or gap-filling (5-30 min), never on PP/PE.
