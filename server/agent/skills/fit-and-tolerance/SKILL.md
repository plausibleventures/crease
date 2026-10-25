---
name: fit-and-tolerance
description: Sizing mating features for Crease parts — read clearances from the printer profile (or the defaults), hole compensation, sliding/press/running fits, printed threads with BOSL2, screw clearance and self-tapping holes, heat-set inserts, nut traps, bearing seats, and fit-test coupons. Use whenever two parts (or a part and hardware) have to fit together.
---

# Fit and tolerance

Use this skill when a part mates with something: another printed part, a screw, a nut, an insert, a bearing, a shaft, or
an off-the-shelf object. For the reasoning behind the numbers, see `fits-and-clearances` (ISO fits, diametral tables),
`snap-fits` and `print-in-place`.

## 1. Where the numbers come from

The system prompt includes the **printer profile**. Its `tolerances` block holds the calibrated values for this printer:

| Profile field | Meaning in this app | Default while `null` |
|---|---|---|
| `slidingFitMm` | clearance **per side** for parts that must slide or rotate by hand | **0.2** |
| `pressFitMm` | clearance **per side** for a press or locating fit (can be 0 or negative after calibration) | **0.1** |
| `holeCompensationMm` | added to the **diameter** of every round hole, because printed holes come out small | **0.2** |

- `null` means the printer is not calibrated yet. Use the default, and say once in your reply that the fit relies on
  uncalibrated defaults.
- Measured values always win over this skill, over `fits-and-clearances`, and over anything in another vendored skill.
- Never hard-code these numbers inside module bodies. Put them in `lib/params.scad` as Customizer parameters, so one edit
  re-sizes every part in the project. Write the profile's value in, or the default if the value is `null`:

```openscad
// lib/params.scad
/* [Fit] */
fit_slide = 0.2;      // [0:0.05:0.6] clearance per side, sliding fit (printer profile slidingFitMm)
fit_press = 0.1;      // [-0.1:0.05:0.3] clearance per side, press/locating fit (pressFitMm)
hole_comp = 0.2;      // [0:0.05:0.5] added to hole diameters (holeCompensationMm)
```

- **Per side vs diametral.** These values are per side, so a pin in a bore gets `2 * fit_slide` on the diameter.
  `fits-and-clearances` quotes FDM clearances as **diametral**. Convert once, and never halve or double twice.

## 2. Fit classes (0.4 mm nozzle, PLA/PETG)

| Function | Per-side clearance | Notes |
|---|---|---|
| Press / interference (stays put) | `fit_press` (default 0.1; calibrated may be 0 to -0.05) | Plastic creeps. If it must carry torque, add a flat, key or screw. Add a 0.5 mm × 45° lead-in chamfer. |
| Locating / snug (by hand, no play) | `(fit_press + fit_slide) / 2` ≈ 0.15 | dowels, alignment pegs, lids that must not rattle |
| Sliding (moves by hand) | `fit_slide` (0.2) | drawers, sliders, telescoping tubes, lid lips |
| Running / rotating | `fit_slide + 0.1` ≈ 0.3 | printed hinges and axles. Print-in-place needs more (see `print-in-place`). |
| Drop-in around a bought object | 0.5 short contact, 1.0 long contact | a friction sleeve over a motor, a pocket for a phone or tool |
| Loose pocket, easy lift-out | 1.0–1.5 | organisers and inserts |

- Small features need more margin than large ones. Pins under ~5 mm vary about twice as much as 20 mm features.
- Long contact lengths need more clearance than short ones: warp and seam bulges accumulate along the length.

## 3. Holes

Two separate errors make holes tight. Correct each one once, in its own place.

1. **Tessellation (OpenSCAD).** Circles are inscribed polygons, so a hole is `d·cos(180/n)` across the flats. At
   OpenSCAD's default `$fa=12, $fs=2` that loses ~0.1 mm on a 20 mm hole. Keep facets fine in export
   (`$fn = $preview ? 32 : 96;`, or `$fa = 2; $fs = 0.3;`), or correct exactly with a polyhole-style diameter:

   ```openscad
   // Model diameter whose polygon measures d across the flats (holes only, never pins).
   function true_hole_d(d, n) = d / cos(180 / n);
   // usage: cylinder(d = true_hole_d(5 + hole_comp, 64), h = 10, $fn = 64);
   ```

2. **Process bias (printer).** FDM lays holes down undersized. Add `hole_comp` to the **diameter** of round holes.
   Do not add it to pins or outer surfaces.

Rules:
- **Vertical holes print round. Horizontal holes sag at the top.** For a horizontal bore over ~5 mm, use a teardrop
  (BOSL2 `teardrop(d=..., l=...)`, or a circle hulled with a 45° point) so it prints without support.
- Holes under 2 mm do not print reliably. Model them as a pilot and drill them out.
- Do not stack compensations. If the profile's `holeCompensationMm` came from a calibration coupon printed with the
  same `$fn`, it already includes the tessellation error.

### Screw holes (metric, `hole_comp` already included)

| Screw | Clearance hole Ø | Self-tap pilot Ø (PLA/PETG) | Head counterbore Ø × depth (socket cap) | Hex nut trap (across flats + 2·fit_slide) |
|---|---|---|---|---|
| M2 | 2.4 | 1.6 | 4.2 × 2.2 | 4.0 + 0.4 |
| M2.5 | 2.9 | 2.0 | 5.0 × 2.7 | 5.0 + 0.4 |
| M3 | 3.4 | 2.5 | 6.0 × 3.2 | 5.5 + 0.4 |
| M4 | 4.5 | 3.3 | 7.5 × 4.2 | 7.0 + 0.4 |
| M5 | 5.5 | 4.2 | 9.0 × 5.2 | 8.0 + 0.4 |

- Self-tapping screws need ≥ 2 × nominal of engagement and a boss with OD ≈ 2 × nominal (see `enclosures`).
- Nut traps: a hex pocket that is `nut_af + 2*fit_slide` across the flats and `nut_thickness + 0.3` deep. On a side
  pocket the nut slides in from an edge; on an inline trap, put the flats parallel to the bed. BOSL2 provides
  `nut_trap_side()` and `nut_trap_inline()`.

### Heat-set inserts

The insert vendor's hole size is already an as-printed size. **Do not add `hole_comp`.** The undersize is the
interference that the melted plastic fills.

| Insert (typical brass, M-size) | Hole Ø | Hole depth | Min boss OD |
|---|---|---|---|
| M2 | 3.2 | insert length + 1 | 6.5 |
| M2.5 | 3.5 | insert length + 1 | 7.0 |
| M3 (4.0 OD × 5.7) | 4.0 | 6.7 | 8.0 |
| M4 | 5.6 | insert length + 1 | 11.0 |
| M5 | 6.4 | insert length + 1 | 13.0 |

Put the hole axis vertical (insert pressed from the top), and add a 0.5 mm × 45° entry chamfer. If the user names the
insert brand, ask for its datasheet hole size: that size wins over this table.

## 4. Threads

- **Below M6, do not print threads.** Use a heat-set insert, a self-tapping pilot, or a captive nut.
- **M6 and up**, and coarse custom threads (jar lids, knobs, tripod adapters) print well with **BOSL2**. BOSL2 is bundled
  with Crease (`include <BOSL2/std.scad>`, then `include <BOSL2/threading.scad>` or `<BOSL2/screws.scad>`).
- BOSL2's `$slop` is its printer clearance per side. BOSL2 applies it to internal threads and holes only. Set it from
  the profile: `$slop = fit_slide / 2;` (≈0.1) for threads, so the clearance is not doubled on both flanks. Raise it if
  a test nut binds.
- Use a coarse pitch: ≥ 1.5 mm for M8–M12 and ≥ 2 mm above that. Fine pitches smear at a 0.2 mm layer height.
- Print threaded rods **vertical**. Threads printed lying down have a flat, weak underside.
- Add a bevel/lead-in: `bevel=true` on rods and nuts, or `blunt_start=true`.

```openscad
include <BOSL2/std.scad>
include <BOSL2/threading.scad>
include <../lib/params.scad>
/* [Thread] */
thread_d = 12;      // [6:1:40]
pitch = 1.75;       // [1:0.25:4]
length = 20;        // [5:1:80]
/* [Hidden] */
$fn = $preview ? 32 : 96;
$slop = fit_slide / 2;

// male part (one part per file; the nut goes in its own parts/<id>.scad)
threaded_rod(d = thread_d, l = length, pitch = pitch, bevel = true, anchor = BOTTOM);
// female: threaded_nut(nutwidth = thread_d * 1.8, id = thread_d, h = 8, pitch = pitch, bevel = true, anchor = BOTTOM);
```

- Standard screw holes with real threads: `screw_hole("M8", l = 10, thread = true, bevel = true)`. For an unthreaded
  clearance hole, use `screw_hole("M3", l = 10, head = "socket", counterbore = 3)` with `$slop` set.

## 5. Bearings, shafts and pins

- **608 bearing** (8 × 22 × 7): model the housing bore at Ø22.0 + `hole_comp`, with a lead-in chamfer and a shoulder that
  touches only the outer ring. A slotted housing or a clamp screw lets the user tune it. On the shaft side, use an M8 bolt or
  steel rod. Do not print the shaft.
- **Steel dowel or pin pressed into print:** bore = pin Ø + `hole_comp` − 0.05, then tune with a coupon.
- **Two locating pins:** make one a round hole and the other a slot, so spacing error cannot jam the assembly.

## 6. When a fit really matters: print a coupon

If the user cares about a fit and the profile is uncalibrated, offer a small coupon before the real part. It is quick to
print and saves a failed big print. Make it its own part (`parts/fit-coupon.scad`): a bar with stepped holes or pegs,
each step labelled with engraved text (6 mm tall, per `printable-openscad`):

```openscad
/* [Coupon] */
target_d = 5.0;   // [2:0.1:30] nominal hole
step = 0.1;       // [0.05:0.05:0.3]
n = 6;            // [3:1:9]
/* [Hidden] */
$fn = $preview ? 32 : 96;
pitch = max(target_d + 8, 18);
difference() {
  cube([n * pitch, 26, 4]);
  for (i = [0 : n - 1]) {
    d = target_d + (i - 2) * step;
    translate([pitch / 2 + i * pitch, 7, -0.01]) cylinder(d = d, h = 4.02);
    translate([pitch / 2 + i * pitch, 19, 3.4]) linear_extrude(0.61)
      text(str(d), size = 6, halign = "center", valign = "center");
  }
}
```

After printing, ask the user which hole fits as a slide and which as a press. Derive per-side clearances from the
answers, and tell the user the values to record in the printer profile (`tolerances` in
`printers/<printer-id>.json` in the Crease data folder, `~/PrintStudio` or `~/Crease`; there is no in-app editor yet). Do not edit that file yourself: it is
outside the project. Once recorded, future sessions pick the values up automatically. Meanwhile, set them in this
project's `lib/params.scad`.

## 7. Checklist before reporting a mating part done

- [ ] Every fit uses `fit_slide` / `fit_press` / `hole_comp` from `lib/params.scad`, not hard-coded numbers.
- [ ] Clearance applied per side exactly once. Holes compensated, pins not.
- [ ] Horizontal holes are teardrops. Bores that must be round are printed with their axis vertical.
- [ ] Lead-in chamfers on entering edges. Elephant-foot chamfer (0.4 mm) on edges that sit on the bed and also mate with
      something.
- [ ] Threads ≥ M6, coarse pitch, BOSL2 `$slop` set. Otherwise inserts or self-tapping screws.
- [ ] `render_part` (look closely at the mating features) and `check_part` with no `fail`, for **every** part in the
      pair.
- [ ] The reply states the clearances used and whether they are calibrated or defaults.

Attribution: the tessellation/process split, the `true_hole_d` idea and the drop-in clearances are adapted from
Altern92/openscad-cad-skills `references/tolerances.md` and `patterns.scad` (MIT, © 2026 Gytis Miliauskas). See SOURCE.md.
