# Source

- Skill: `analyzing-print-failures`
- Upstream: https://github.com/Eli-code1/printagent/tree/98cf2d5d3da5ef851d32938e5a3d09684f59c6e5/skills/analyzing-print-failures
- Commit: 98cf2d5d3da5ef851d32938e5a3d09684f59c6e5 (upstream commit date 2026-09-22), fetched 2026-10-06
- License: MIT, Copyright (c) 2026 Eli-code1 (repo root LICENSE; copied as LICENSE)
- Author: Eli-code1
- Vendored files: SKILL.md, references/failure-modes.md

## Review (2026-10-06)

- Read all 4 files. `scripts/failure_db.py` (data dict mirroring the reference table) and `scripts/route_failure.py`
  (stdlib lookup) are harmless but redundant; not vendored. No network, credentials or prompt-injection text.
- Value: compact symptom -> cause -> fix table that classifies each failure as design-time vs process and gives the
  geometry fix (the part a design agent can act on), plus photo-matching cues.
- Repo-level note: other printagent skills use `scripts/bootstrap_env.py --install` (creates a venv and runs pip),
  and publishing-onshape reads ONSHAPE_ACCESS_KEY/SECRET env vars and writes a credentials file - not vendored.

## Adaptations

- Added "Crease notes (read first)": route mapping to `.scad` edits + render/check vs `slice_part`/user actions,
  Klipper/CFS specifics, never start/cancel prints. Replaced the `route_failure.py` call with a table lookup and
  annotated the build123d route. Reference table verbatim.

## Dependencies

None.
