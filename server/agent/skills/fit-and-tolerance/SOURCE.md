# Source

First-party Crease skill (written 2026-10-06), project license.

Adapted input (MIT, attribution required; license text in LICENSE-Altern92):
- Altern92/openscad-cad-skills, commit 37cf6952d7ba3bc5a43ff44f663b6fe89ccd1bf5, © 2026 Gytis Miliauskas
  - `openscad-cad/references/tolerances.md`: the tessellation-vs-process split for hole error, "don't stack
    compensations", "compensate holes not pins", drop-in clearances (0.5 / 1.0 / 1.5 mm per side).
  - `openscad-cad/references/patterns.scad`: the `true_hole_d()` polyhole correction (simplified here) and the
    stepped-hole calibration coupon idea (rewritten).
- Numbers cross-checked against the vendored `fits-and-clearances` / `enclosures` skills (AgentCAD, Apache-2.0):
  heat-set insert table, boss proportions.
- BOSL2 APIs (`threaded_rod`, `threaded_nut`, `screw_hole`, `nut_trap_*`, `teardrop`, `$slop`) were checked against the
  bundled BOSL2 v2.0.766 source. The thread, screw-hole and coupon examples were rendered through the app's OpenSCAD
  runner.
