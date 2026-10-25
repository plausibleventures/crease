---
name: verifying-assembly-fit
description: >-
  Verifies that a multi-part FDM kit will actually assemble in real life: measures
  every declared joint from the built meshes, applies an as-printed tolerance model
  (holes print undersized, seams bulge pins, horizontal bores sag, first layers
  flare), classifies each fit against its intent (press / snug / slide / running),
  and sweeps every part along its insertion path in assembly order. Use when
  validating a kit of mating printed parts, checking press/clearance fits, joint
  tolerances, whether parts will jam or rattle, or insertion/assembly order, after
  the per-part manufacturability gate passes.
---

## Crease notes (read first)

- The upstream checker (`scripts/check_assembly_fit.py`, trimesh ray-probing + insertion sweep driven by an
  `assembly.json`) was not vendored: it needs a Python geometry stack installed by a bootstrap that runs pip.
  Do the same procedure by reasoning over the parts' Customizer parameters, using the numbers in
  `references/fit-tolerances.md` (the upstream `fit_rules.py` constants are transcribed there):
  1. List every joint between parts: which part holds the inner feature (bore/slot), which the outer (pin/rail),
     nominal dimensions (read the `.scad` parameters), and the intent (press / snug / slide / running).
  2. For each feature, decide axial vs lateral from its OWN part's print orientation (the `.scad` is modelled in
     print pose, Z up).
  3. Compute the effective clearance band and verdict with the formulas in the reference; report the sized edit for
     every FAIL and apply it to the shared parameters (e.g. `lib/params.scad`) so both parts regenerate.
  4. Insertion check: in assembly order, reason (and `render_part` if helpful) about whether each part can travel
     from outside to its seat without passing through already-placed geometry; flag blocked paths.
  5. Re-run `render_part` + `check_part` on every edited part.
- The upstream "calibrated" class means a tuned modern CoreXY; until the Creality SPARKX i7 profile has measured
  tolerances, use the "generic" scaling, and say so. Measured printer-profile tolerances override these numbers.
- Precedence: ISO fits and hardware (bearings, inserts, dowels) -> `fits-and-clearances`; this skill is for
  printed-to-printed joints. Default sliding clearance in `printable-openscad` (0.2 mm/side) is a starting value;
  this skill is how to check it against the as-printed error.
- If Crease gains assembly tools, prefer their measurements over hand reasoning.

# Verifying assembly fit

The manufacturability gate proves each part prints; this skill proves the *kit
assembles*. It is deterministic and measure-first: every number in the report is
either measured from the parts (upstream: ray-probed from the built mesh; Crease: read from the Customizer
parameters) or taken from the tolerance tables in `references/fit-tolerances.md`. Do not re-derive fits ad hoc;
declare the joints and follow the procedure in the Crease notes.

## When to use
- After every part of a multi-part kit passes `check_part`.
- When choosing or auditing press/slip/running clearances between printed parts.
- Before `slice_part`, so a kit that cannot assemble never ships.

## When NOT to use
- Single parts with no mating features.
- Fits against non-printed parts (bearings, inserts, screws): the heat-set and
  clearance tables in `fits-and-clearances` already encode those.

## How to run (upstream; not available in Crease)
Upstream declared the kit in an `assembly.json` (parts with print pose + placement, joints with nominal dims +
intent, insertion sequence + travel) and ran `scripts/check_assembly_fit.py`. Use the manual procedure in the
Crease notes instead; the sections below describe what the checker evaluated, which is what to reason about.

## What it checks, and how to read it

**placement** - each print-pose mesh, rotated and aligned to its declared
assembly box, must land within 0.2 mm. A miss means the manifest and the
geometry disagree; fix that before trusting anything else.

**joints** - for each declared joint the checker ray-measures the real inner
(bore/slot) and outer (pin/rail) dimensions, classifies each feature
axial/lateral against its own part's build axis, applies the as-printed error
model, and reports the effective clearance band `[lo, mid, hi]` (95%). A
hollow rail (a tube whose outer faces are the fit surface) must declare
`"probe": "outer"` so its width is probed from outside the part; a centered
origin would measure the bore instead. The
verdict compares that band to the intent's window:
- `PASS` - the whole band sits inside the window.
- `WARN` - the nominal lands inside but printer spread spills out; fine on a
  calibrated machine, marginal on an untuned one.
- `FAIL` - comes with a concrete edit ("open the bore by 0.12", "shrink the
  rail by 0.08") sized to re-center the band.
Per-feature `print_notes` carry the orientation consequences: horizontal bores
sag and may need a ream, vertical pins carry a seam ridge, features touching
the bed plane flare (elephant foot) unless chamfered or de-flared.

**insertions** - in declared sequence order, each moving part is swept along
its insertion axis from its exploded start to its seat against everything
already assembled. Penetration beyond 0.10 mm (0.35 mm against its own
press/snug partners, whose interference is the point) at any step FAILs: the
seated fit can be perfect and the part still impossible to get there.

## Failure -> edit (loop contract)
- Joint FAIL tight/jam -> grow the inner or shrink the outer nominal by the
  reported delta in the kit's shared parameters file; regenerate both parts.
- Joint FAIL loose -> the reverse; or change intent (a rattling "snug" may
  honestly be a "slide" plus glue).
- WARN + `calibration: generic` -> either accept (note it in the kit README) or
  re-run with `calibrated` if the target printer is tuned.
- Insertion FAIL -> the path is blocked: change the insertion direction, the
  assembly order, or relieve the blocking geometry. Re-run; the sweep tells you
  at which travel fraction the collision happens.
- Elephant-foot note on a joint feature -> chamfer that first edge (0.3-0.4)
  or enable first-layer compensation in the slicer.

Stop conditions mirror the other verifiers: stop on all-PASS, after 5
iterations, when the failing set repeats (stuck), or when an edit grows the
failure count (revert and escalate).

## Caveats
- The model is statistical, not a guarantee: bands are ~95% for the declared
  `calibration` class. A first article print of the tightest joint is still
  the final word; the report names which joint that is (smallest `lo`).
- Measurements come from the exported mesh, so slicer-side compensation
  (hole expansion, elephant-foot removal) is deliberately NOT assumed; if you
  rely on it, the real fit lands looser than reported.
- Assumes rigid parts. Long thin printed springs/clips flex their way past
  interferences this checker would flag; declare those joints `press` only if
  you mean a true interference.

