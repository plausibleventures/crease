# Source

- Skill: `verifying-assembly-fit`
- Upstream: https://github.com/Eli-code1/printagent/tree/98cf2d5d3da5ef851d32938e5a3d09684f59c6e5/skills/verifying-assembly-fit
- Commit: 98cf2d5d3da5ef851d32938e5a3d09684f59c6e5 (upstream commit date 2026-09-22), fetched 2026-10-06
- License: MIT, Copyright (c) 2026 Eli-code1 (repo root LICENSE; copied as LICENSE)
- Author: Eli-code1
- Vendored files: SKILL.md, references/fit-tolerances.md

## Review (2026-10-06)

- Read all 6 files. Scripts (`check_assembly_fit.py`, `fit_rules.py`, `assembly_schema.py`, tests) use
  trimesh/numpy/rtree and a re-exec into a venv created by the repo's `bootstrap_env.py` (which runs pip install);
  no network calls of their own. Not vendored.
- Value: an as-printed error model for printed-to-printed joints (holes/slots shrink, pins/rails grow, horizontal
  bore sag, seam bulge, elephant foot), fit-class windows (press/snug/slide/running), a band-based verdict, and an
  insertion-path/assembly-order check. Complements fits-and-clearances (ISO + hardware) rather than duplicating it;
  timely for Crease's assembly work.

## Adaptations

- Added "Crease notes (read first)" with a manual 5-step procedure over Customizer parameters; replaced the
  "How to run" script section; repointed skill names (check_part, slice_part, fits-and-clearances).
- fit-tolerances.md: transcribed the constants and verdict logic from `fit_rules.py` into a new "Error model and
  verdict rules" section; first paragraph annotated. Rationale text verbatim.

## Dependencies

None.
