# Source

- Skill: `fdm-structural-review` (merged with its dependency `mechanical-strength-review`)
- Upstream: https://github.com/V0v1kkk/freecad-engineering/tree/6d4836236cc857353afa419d148028c71677eefd/skills/fdm-structural-review
  and https://github.com/V0v1kkk/freecad-engineering/tree/6d4836236cc857353afa419d148028c71677eefd/skills/mechanical-strength-review
- Commit: 6d4836236cc857353afa419d148028c71677eefd (upstream commit date 2026-08-12), fetched 2026-10-06
- License: MIT, Copyright (c) 2026 Vladimir Rogozhin (repo root LICENSE; these two skill dirs carry no own LICENSE;
  copied as LICENSE)
- Author: Vladimir Rogozhin (V0v1kkk)
- Vendored files: SKILL.md, references/structural-method.md, references/material-evidence.md (from
  fdm-structural-review); references/first-order-models.md, references/evidence-and-report.md (from
  mechanical-strength-review)

## Review (2026-10-06)

- Read every file in both skill dirs (SKILL.md, references, agents/openai.yaml, scripts). Scripts
  (`validate_material_profile.py`, `mechanics_check.py`, tests) are stdlib-only, no network/subprocess, but were not
  vendored. No credential access or prompt-injection text. External links are citations (ASTM/ISO/NIST/MIT/DOI).
- Value: structural-loads knowledge we lacked - evidence-graded FDM structural method (walls vs infill, gyroid
  caveats, 100%-infill myths, coupon planning), first-order formulas (cantilever, torsion, Euler buckling, thermal,
  pin bearing/shear) with applicability limits, and a report contract with explicit claim discipline.

## Adaptations

- Kept upstream name/description; dropped the `metadata` frontmatter block (Python dependency, sources list).
- Added "Crease notes (read first)"; inlined mechanical-strength-review's workflow/claim discipline as a section;
  replaced the two script steps with hand-calculation/checklist steps (marked "[Crease: ...]");
  material-evidence.md script mention annotated. Equations and rules otherwise verbatim.

## Dependencies

None.
