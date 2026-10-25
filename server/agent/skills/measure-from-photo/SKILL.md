---
name: measure-from-photo
description: Reference for estimating real sizes from a user's photo using a known object in the shot (credit card, coin, paper, ruler, phone), with perspective caveats, honest uncertainty, a single confirm question, and designing so the measurement is easy to tweak after a test print. Use when the user attaches a photo of something the design must fit.
---

# Measuring from a photo: reference

People rarely own calipers, but almost everyone has a credit card. A photo with a known object next to the thing
is usually enough to get within a few percent, which is plenty when the design has sensible clearance and the
size stays easy to adjust.

## Reference objects (real sizes)
| Object | Size |
|---|---|
| Credit / debit / ID card (ISO ID-1) | 85.6 × 53.98 mm, corners r ≈ 3 mm, 0.76 mm thick |
| US quarter | 24.26 mm across |
| US penny | 19.05 mm · nickel 21.21 mm · dime 17.91 mm |
| 1 € coin | 23.25 mm · 2 € 25.75 mm · UK £1 23.43 mm |
| US Letter paper | 215.9 × 279.4 mm |
| A4 paper | 210 × 297 mm |
| AA battery | 14.5 mm × 50.5 mm · AAA 10.5 × 44.5 mm |
| iPhone 15 / 15 Pro | 147.6 × 71.6 mm (15) / 146.6 × 70.6 mm (15 Pro), without case |
| iPhone 13 / 14 | 146.7 × 71.5 mm |
| Standard LEGO brick 2×4 | 31.8 × 15.8 mm, 9.6 mm tall (without studs) |
| A ruler | read the marks directly; best of all |

If you can't tell what the reference is, ask. Don't guess a coin's country.

## Estimating
1. **Find the reference's length in pixels along its longest clear edge.** For a card that's the 85.6 mm side.
   Use the long side: a 2 px error matters less over 400 px than over 40.
2. **Find the target's length in pixels** along the dimension you need: a pipe's width, a gap, a handle's
   thickness.
3. **Scale:** mm = target_px × (reference_mm / reference_px).
   Example: card 412 px for 85.6 mm, pipe 154 px wide → 154 × 85.6 / 412 ≈ 32 mm.
4. **Sanity-check** against what such things usually measure. Pipes come in standard sizes (15, 22, 25, 28, 32,
   40 mm, ½–1¼ in), and shelves are usually 16-19 mm or 18-25 mm thick. If the estimate is close to a standard size,
   say so; it's probably that.

## Why photos mislead (and how to be honest about it)
- **Same plane:** the reference only gives the scale at its own distance. If the card lies on a desk and the pipe
  is 10 cm closer to the camera, the pipe looks bigger. Measure things that are side by side, at the same distance,
  ideally touching.
- **Straight-on:** a tilted shot shortens lengths along the tilt (foreshortening). Compare the card's sides: they
  should be 85.6 : 54 ≈ 1.59. If the photo shows 1.3, the shot is tilted along the long side. Measure along the axis
  that looks least squashed, or ask for a straighter photo.
- **Round things:** a cylinder's visible width is its diameter only when seen side-on. Seen end-on, measure the
  circle across its widest point.
- **Wide-angle phone lenses** stretch things near the edges of the frame. Prefer measurements near the middle.
- **Shadows and soft edges:** measure to the object's edge, not its shadow.

Typical uncertainty with a card in the same plane and a straight shot is ±3-5%. A tilted or mismatched-plane photo
is ±10% or worse. Say which applies.

## Confirming (one question)
Give a single AskUserQuestion with the estimate as the recommended answer, in both units, and a tolerance hint:
- "Looks like about 32 mm (1¼ in) across. Use that? (Recommended)", with a one-line reason: "Measured against your
  card; probably a standard 32 mm pipe."
- "It's a bit bigger": you'll add 2-3 mm.
- "It's a bit smaller"
- "I'll measure it": they type a number.

If two dimensions matter, ask both in the same round (at most 2-3).

## Designing for a measured size
- **Clearance on top of the estimate**, roughly:
  - snap-on clips for pipes: diameter +0.3-0.5 mm, opening 85-90% of the diameter;
  - sliding fits: +0.4-0.6 mm;
  - "rests on" or "holds loosely": +1-2 mm.
- **Make the measurement a top-level Customizer parameter** named for what it is (`pipe_diameter = 32; //
  [10:0.5:60]`, `shelf_thickness = 18; // [8:0.5:40]`). The user can then nudge it on the Parameters slider
  after a test print without asking you.
- **Suggest a quick test print** of just the fitting part (a thin ring, a short clip) when the fit really matters.
- In share_plan, say what you measured and how sure you are: "Pipe looks about 32 mm across (±1 mm). There's a
  slider if it's a little off."
