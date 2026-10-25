# As-printed FDM fit tolerances: the numbers and why

Upstream kept authoritative values in `../scripts/fit_rules.py` (not vendored; its numbers are copied into the
"Error model" section at the end of this file). This file records the
reasoning. All numbers are millimetres, diametral (or full width), for a 0.4 mm
nozzle at 0.2 mm layers in PLA. "Calibrated" means a tuned modern CoreXY
(Bambu X1C/P1S class with flow calibration); "generic" scales mu by 1.4 and
sigma by 2 for untuned machines.

## Where the error comes from

**Holes print undersized** (bore axial: mu -0.15). Three stacking effects, all
one-directional: the slicer polygonizes the circle with chords that cut inside
the ideal curve; extruded plastic bulges inward on concave paths (die swell);
and perimeter shrink pulls toward the center. The community rule of thumb of
"drill or model +0.2 on holes" matches this band. Horizontal bores (lateral:
mu -0.25) add gravity sag of bridged top spans and layer quantization of the
vertical diameter, which is why printed horizontal bores read oval.

**Outer surfaces print slightly oversized** (pin axial: mu +0.05). Convex
perimeter bulge is smaller than the concave case. The perimeter seam adds a
local ridge on top (~0.12 diametral at the seam line), which matters for
running and sliding fits that must swallow it every revolution; press fits
just bite harder locally. Lying cylinders (lateral: mu +0.10) gain width from
first-layer squish and lose height to the bed flat.

**Slots shrink, rails grow** for the same reasons as bores and pins; widths
measured across layers (lateral) additionally quantize to the layer height,
hence the sigma term added in quadrature (layer_height / 4).

**Elephant foot**: the first ~0.5 mm above the bed flares outward up to
~0.2 mm on a squished first layer. Any joint feature living in that band
(a rail standing on the bed, a socket opening at the bottom face) sees it
directly, so the checker flags those with "chamfer or de-flare".

## Fit class windows (effective diametral clearance)

| intent  | window          | feel |
|---------|-----------------|------|
| press   | -0.32 .. -0.02  | seats by hand or light tap, holds without glue |
| snug    | -0.12 .. +0.20  | locational; friction holds, fingers remove |
| slide   | +0.03 .. +0.40  | dovetail/tongue glides without slop |
| running | +0.12 .. +0.60  | spins or slides freely, forever |
| (jam)   | below -0.35 expected | PLA cracks or will not seat by hand |

A PASS tolerates up to 0.08 of 95%-band tail outside the window (`BAND_GRACE`):
demanding the whole band inside would make every honest window unreachable,
since the spread of two stacked features is comparable to the window widths.

**Anisotropy of lateral/lateral pairs.** A horizontal bore sags vertically but
holds near nominal horizontally; a lying pin prints short vertically and fat
horizontally. When both sides of a cylinder joint are lateral the checker
evaluates the vertical gap (sagged bore vs squished-short pin) and the
horizontal gap (near-nominal bore vs fattened pin) separately and judges the
smaller one - a scalar worst-vs-worst stack would wrongly combine the bore's
vertical loss with the pin's horizontal gain.

These windows are deliberately wide bands, not machining-grade fits: FDM
repeatability across machines is the dominant term. The band edges come from
the common printed-fit heuristics (0.1-0.2 interference press fits in PLA;
0.3-0.5 clearance for free motion; 0.15-0.25 for snug locating features) that
the community and printed-fit test coupons converge on.

## Why measure-then-model, not model-only

The checker measures the *actual exported mesh* first because modeling errors
(a socket drilled at the wrong depth, a rail wider than its slot) are far
larger than printer tolerances and must not hide under them. The tolerance
model is then applied to the measured value. The report's clearance band is
therefore: (measured geometry) + (expected printing transformation), which is
exactly what lands in your hands.

## Error model and verdict rules (copied from upstream `scripts/fit_rules.py`)

[Crease: transcribed from the upstream Python so the numbers survive without the script. Values are
diametral / full-width mm for a calibrated 0.4 mm nozzle, 0.2 mm layers, PLA.]

| feature | orientation | mu (systematic) | sigma (1-sigma) |
|---|---|---|---|
| bore (internal cylinder) | axial | -0.15 | 0.05 |
| bore | lateral | -0.25 | 0.08 |
| pin (external cylinder) | axial | +0.05 | 0.05 |
| pin | lateral | +0.10 | 0.07 |
| slot (internal width) | axial | -0.12 | 0.05 |
| slot | lateral | -0.18 | 0.08 |
| rail (external width) | axial | +0.05 | 0.05 |
| rail | lateral | +0.08 | 0.07 |

- "axial" = the controlling dimension lies in the layer plane (bore with vertical axis, slot between vertical
  walls); "lateral" = the controlling dimension crosses layers (horizontal bore's vertical diameter).
- Generic (untuned) printer: multiply mu by 1.4 and sigma by 2.0.
- Lateral features: sigma = sqrt(sigma^2 + (layer_height/4)^2).
- Seam bulge: +0.12 mm local diameter where the perimeter seam lands. Elephant foot: +0.20 mm flare within
  0.6 mm of the feature's bed plane.
- Horizontal cylinder pairs (both lateral), per axis: bore vertical -0.25 / horizontal -0.10; pin vertical
  -0.10 / horizontal +0.10. Judge the smaller of the vertical and horizontal gaps.
- Effective clearance: mid = (inner_nominal + mu_inner) - (outer_nominal + mu_outer);
  band = 2 * sqrt(sigma_inner^2 + sigma_outer^2); report [mid - band, mid, mid + band].
- Verdict: FAIL if mid < -0.35 (jam). PASS if mid is inside the intent window and the band spills at most 0.08
  outside it. WARN if mid is inside but the band spills more, or mid is within 0.06 outside the window. Otherwise
  FAIL, with the edit "open the bore/slot" or "shrink the pin/rail" by |window_centre - mid|.
