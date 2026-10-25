---
name: analyzing-print-failures
description: >-
  Diagnoses FDM 3D-print failures from a photo or a symptom description, warping, stringing,
  layer shifting, under-extrusion, elephant's foot, delamination, ghosting, pillowing, clogs,
  support and bridging failures, identifies the failure mode, classifies it as design-time
  preventable vs a process/printer setting, and returns the remedy plus where to route the fix.
  Use when a print failed, looks wrong, or the user asks why a print came out badly or how to
  troubleshoot it.
---

## Crease notes (read first)

- Upstream routes fixes to its own skills (`generating-build123d`, a Bambu slicing handoff) and looks causes up with
  `scripts/route_failure.py`. Neither exists here. Read the table in `references/failure-modes.md` directly (the
  upstream script was a lookup over the same data).
- Route mapping in Crease:
  - `design_time` / `generating-build123d` -> edit the part's `parts/<id>.scad` (prefer changing Customizer
    parameters; `set_parameters` for value-only changes), then `render_part` + `check_part`, then `save_checkpoint`.
  - `process` / `slicer_printer` -> a slicer setting for `slice_part` (OrcaSlicer) or a printer/material action the
    user performs on the Creality SPARKX i7 (Klipper) / CFS. Recommend it; never claim to have changed the printer.
  - `both` -> do the geometry edit and state the process recommendation.
- Printer specifics: the SPARKX i7 runs Klipper, so "input shaping (ADXL345)" and "pressure advance" are Klipper
  features the user tunes on the printer; for CFS multi-colour prints also consider filament-change purge/wipe
  issues and wet filament in a CFS slot.
- Never start, resume or cancel a print from this skill; printing goes only through `request_print` with user
  confirmation.

# Analyzing print failures

This skill is the post-print diagnostic. It maps a symptom (often a photo) to a failure mode,
then routes the fix: geometric causes go back to `generating-build123d`; process causes become
a setting recommendation for the slicing/printer agent, which the design loop cannot apply
itself. Many design-time-preventable failures should already have been caught by the
manufacturability gate before printing, if one appears post-print, it usually means the part
skipped the gate or was printed in a different orientation.

## How to use
1. **Identify the failure mode.** From a photo, match against the visual fingerprints in
   `references/failure-modes.md`. From a description, match the symptom. If a part shows
   "spaghetti," treat it as a *secondary* failure and diagnose from what is left on the bed.
2. **Classify and route.** Look the failure up in `references/failure-modes.md`. [Crease: upstream called
   `python scripts/route_failure.py warping`; not vendored.] The row gives the classification (`design_time` | `process` | `mixed`), the visual signs, the
   geometric and process causes, the design fix, the process fix, and the route.
3. **Act on the route.**
   - `generating-build123d` (Crease: edit the `.scad`) → make a concrete geometry edit (reorient, chamfer, vent,
     thicken, fillet). Then re-run the manufacturability gate.
   - `slicer_printer` → emit a setting recommendation for `slice_part` or the user (temperature, retraction, speed, cooling,
     bed adhesion, belt tension, input shaping). The design loop is advisory here; it does not
     drive the slicer or printer.
   - `both` → do the geometry edit you can *and* emit the process hint, so the downstream
     slicing agent can complement it.

## Vision guidance (matching from a photo)
Look for the discriminating sign, not the overall mess: a single abrupt horizontal step at one
height is a layer shift; a base wider than the body that is smooth (not curling) is elephant's
foot; horizontal cracks mid-height are delamination; hairy strands between features are
stringing; repeating wave echoes fading from sharp corners are ghosting; top-surface
depressions following the infill pattern below are pillowing; lifted corners with a gap under
the base are warping.

## Scope
- This skill diagnoses; it does not implement process fixes (no slicer/printer control).
- It is advisory. Material, printer model, and environment change the likely cause, so present
  the ranked causes from the lookup rather than asserting a single one.
- This is a sensitive-failure-free domain, but if a user is frustrated, lead with the most
  likely fix, not a lecture.
