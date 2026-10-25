---
name: "fdm-structural-review"
description: "Review load-bearing FDM/material-extrusion parts using process-specific evidence, printed orientation, walls and infill, anisotropy, creep, fatigue, environmental exposure, and coupon planning. Use when sizing a functional printed bracket, enclosure, boss, insert, snap-fit, beam, or lattice; when choosing walls versus sparse or solid infill; when interpreting PLA, PETG, ABS, ASA, nylon, or composite data; or when deciding whether effective properties, explicit lattice FEM, coupons, proof tests, or an engineer are required."
---

## Crease notes (read first)

- Merged from two upstream skills in V0v1kkk/freecad-engineering: `fdm-structural-review` (this file and
  `references/structural-method.md`, `references/material-evidence.md`) and its declared dependency
  `mechanical-strength-review` (its workflow is inlined as step 1 below; its references are
  `references/first-order-models.md` and `references/evidence-and-report.md`).
- Upstream Python helpers (`validate_material_profile.py`, `mechanics_check.py`) were not vendored. Do the
  first-order calculations by hand from `references/first-order-models.md` in N-mm-MPa and show the working;
  use the material-profile JSON shape in `references/material-evidence.md` as a checklist, not as a script input.
- Geometry facts (wall thickness, cross-sections, orientation) come from the part's Customizer parameters and
  `render_part` / `check_part`; do not shell out to OpenSCAD, FreeCAD or a slicer. Wall counts / infill are
  slicer settings applied through `slice_part`.
- Default printer: Creality SPARKX i7, 0.4 mm nozzle. Print orientation is set in the `.scad` (part resting on
  Z = 0); if strength needs a different orientation than `printable-openscad`'s "largest face on bed" default,
  say so and explain the trade-off.

# FDM Structural Review

Treat the sliced, printed structure as the engineering material. Do not substitute filament-family marketing values for part properties.

## Workflow

1. Use the "Strength review workflow" section below (inlined from upstream `mechanical-strength-review`) to establish requirements, load cases, load path, failure modes, deformation limits, duration, cycles, temperature, environment, and consequence of failure.
2. Record the exact material, lot if available, printer, nozzle, temperatures, layer height, line width, wall count or wall thickness, top/bottom shells, infill pattern and density, build orientation, raster strategy, conditioning, and service state.
3. Fill in the profile fields listed in [material-evidence.md](references/material-evidence.md) and list every missing field as an evidence gap. Treat completeness as evidence readiness, never as a safety verdict. [Crease: upstream ran `scripts/validate_material_profile.py`; not vendored.]
4. Choose the structural idealization from [structural-method.md](references/structural-method.md): explicit walls with conservative infill treatment, calibrated effective material, homogenized lattice, or explicit lattice geometry.
5. Establish directional allowables from the hierarchy in [material-evidence.md](references/material-evidence.md). Require process-matched coupons when the load-bearing claim depends on uncertain layer welds, sparse infill, creep, fatigue, inserts, or snap-fit cycling.
6. Size geometry with explicit section properties and named allowables. Place material along the load path; add radii and local solid regions at load introduction, holes, bosses, and inserts.
7. Plan coupons and an assembly or proof test using the same printer, material, orientation, wall/infill rules, conditioning, and service-relevant load mode.
8. Report assumptions, process profile, material evidence, predicted modes, margins, uncertainty, and required validation separately.

## Non-negotiable rules

- Do not map `15% infill` to `15% modulus` or `15% strength`.
- Do not assume slicer percentage equals measured relative density.
- Do not call `100% infill` isotropic or equivalent to injection-molded stock.
- Do not invent universal PLA, PETG, gyroid, wall-count, or safety-factor values.
- Do not use a tensile coupon alone to claim creep, fatigue, insert pullout, impact, or snap-fit life.
- Require human engineering and qualification for serious safety or regulatory consequences.

## Resources

- [structural-method.md](references/structural-method.md) — walls, infill, gyroid, homogenization, and sizing workflow.
- [material-evidence.md](references/material-evidence.md) — evidence hierarchy and profile template.
- [first-order-models.md](references/first-order-models.md) — equations, units, and stop conditions (from `mechanical-strength-review`).
- [evidence-and-report.md](references/evidence-and-report.md) — evidence ladder and report contract (from `mechanical-strength-review`).

## Strength review workflow (inlined from upstream `mechanical-strength-review`)

Produce a preliminary engineering check, not a certification or an unconditional safety verdict.

### Workflow

1. Define the consequence of failure. Escalate pressure, lifting people or loads over people, high stored energy, regulated products, and other serious hazards to a qualified engineer.
2. Record units, service environment, load cases, load directions, duration, cycles, impact or misuse factors, supports, and interfaces. Draw or describe a free-body diagram and verify equilibrium.
3. Enumerate plausible failure modes before calculating: yielding or rupture, excessive deflection, bearing, shear-out, pullout, local buckling, global buckling, creep, fatigue, joint slip, or loss of retention.
4. Select the smallest defensible model from [first-order-models.md](references/first-order-models.md). State every applicability condition and violated assumption.
5. Calculate the supported models by hand from [first-order-models.md](references/first-order-models.md), showing inputs and working in N-mm-MPa. [Crease: upstream ran `scripts/mechanics_check.py`; not vendored.]
6. Compare against an allowable only when its source, material condition, direction, temperature, and process are recorded. Never substitute a generic material-family value silently.
7. Choose the next evidence level: geometry correction, refined analytical model, FEM verification, process-matched coupon, assembly test, or engineer review.
8. Return the contract in [evidence-and-report.md](references/evidence-and-report.md). Keep untested claims visible.

### Claim discipline

- Treat a hand calculation as screening within its stated idealization.
- Do not apply circular-shaft torsion formulas to arbitrary sections.
- Do not treat von Mises stress as a universal failure criterion.
- Do not report a margin when the allowable lacks provenance.
- Do not turn missing loads, material evidence, or boundary conditions into a pass.
- Separate model verification from validation against the manufactured part.

