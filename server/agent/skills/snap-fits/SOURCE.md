# Source

- Skill: `snap-fits`
- Upstream: https://github.com/n3r/AgentCAD/tree/4b00aa503776eef9404bea9e489f3a244f423d3c/agentcad/skills/snap-fits
- Commit: 4b00aa503776eef9404bea9e489f3a244f423d3c (upstream commit date 2026-08-26), fetched 2026-10-06
- License: Apache-2.0 (repo root LICENSE, copied here as LICENSE; skill frontmatter also declares Apache-2.0). No NOTICE file upstream.
- Author: AgentCAD core (Nikita Fedorov / n3r)
- Vendored files: SKILL.md, tables/material_strain.json

## Review (2026-10-06)

- Read every vendored file. No scripts vendored. No network calls, downloads, shell commands, credential access,
  or prompt-injection text. External links are only citations to build123d / standards documentation.
- Content: cantilever beam sizing (Bayer/BASF formulas incl. 1.64 taper factor), permissible strain per material with FDM derating, undercut rules, insertion/return angles, annular snaps, FDM orientation. tables/material_strain.json is pure data (checked: valid JSON, no code).
- Quality: high. Numbers are sourced and the rules are engine-agnostic; complements `printable-openscad`.

## Adaptations

- Added a "Crease notes (read first)" section after the frontmatter: code samples are build123d +
  AgentCAD toolkit APIs that do not exist here; translate to OpenSCAD with Customizer params; verify with
  `render_part` + `check_part`; printer profile tolerances override; unvendored cross-references listed.
- Body text otherwise unchanged. Upstream `snippets/*.py` (build123d example parts importing the AgentCAD
  toolkit) not vendored: they cannot run in this app and would invite the agent to run Python.
- Frontmatter kept as upstream (extra keys `triggers`, `version`, `license`, `author`, `requires` are ignored by Claude Code).
- 2026-10-09: added the line "Modified for Crease; see SOURCE.md." under the frontmatter (the change notice
  Apache-2.0 §4(b) asks for). Crease itself is Apache-2.0 too.

## Dependencies

None (no OpenSCAD libraries required).
