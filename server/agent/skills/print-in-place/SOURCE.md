# Source

- Skill: `print-in-place`
- Upstream: https://github.com/AaronGoldsmith/mcp-printable/tree/2810b946cb8a42b022ac34d31e8b168e3fc48bd1/.claude/skills/print-in-place
  (shim) + https://github.com/AaronGoldsmith/mcp-printable/blob/2810b946cb8a42b022ac34d31e8b168e3fc48bd1/docs/design/print-in-place.md (body)
- Commit: 2810b946cb8a42b022ac34d31e8b168e3fc48bd1 (upstream commit date 2026-07-05), fetched 2026-10-06
- License: MIT, Copyright (c) 2026 Aaron Goldsmith (repo root LICENSE covers .claude/ and docs/; copied as LICENSE)
- Author: Aaron Goldsmith
- Vendored files: SKILL.md (shim frontmatter + inlined docs/design/print-in-place.md)

## Review (2026-10-06)

- Read all 4 skills in `.claude/skills/` and the referenced doc. Other three skills (blender-app, blender-design-loop,
  image-displacement) are Blender-only and were not vendored. No scripts, network calls, credential access or
  prompt-injection text in the vendored content.
- Value: distinct knowledge not in our accepted skills - the "cardinal rule" (every moving part needs its own print
  path to the bed that does not pass through the static part), LLM failure modes (floating trapped part, uniform
  clearance, coplanar faces), gap table for captive parts, ball-and-socket / pin-barrel / chain patterns, checklist.
- Quality issues found upstream: snap-fit subsection had a nonsensical deflection formula and inverted orientation
  advice; living-hinge orientation wording was ambiguous; checklist item 2 seemed to contradict Mistake 2.

## Adaptations

- Added "Crease notes (read first)" (one-file-per-part convention, Customizer gap params, render/check, SPARKX i7,
  precedence vs printable-openscad sliding fit, living-hinge orientation clarified).
- Replaced the snap-fit subsection with a pointer to `snap-fits`, keeping only the wedge-barb rule.
- Clarified living-hinge orientation and checklist item 2 in bracketed "[Crease: ...]" notes.
- Replaced the "Worked recipes" paragraph (referenced Blender MCP tools `blender_check_*`) with render_part/check_part.

## Dependencies

None.
