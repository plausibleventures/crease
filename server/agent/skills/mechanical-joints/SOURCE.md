# Source

- Skill: `mechanical-joints` (renamed; upstream skill is `3d-print-design`)
- Upstream: https://github.com/obelisk-complex/claude-skills/tree/71b402f693e0daf9007b976a93aba60e1662f590/src/3d-print-design
- Commit: 71b402f693e0daf9007b976a93aba60e1662f590 (upstream commit date 2026-09-07), fetched 2026-10-06
- License: MIT, Copyright (c) 2026 obelisk-complex (repo root LICENSE; copied as LICENSE)
- Author: obelisk-complex
- Vendored files: SKILL.md (new frontmatter + notes + body = upstream `references/mechanical-joints.md`),
  references/print-settings.md (upstream `references/print-settings.md`)
- Note: Stab-Rabbit-coding/SecureControllers contains a derivative copy at `.claude/skills/3d-print-design`
  under its repo-wide CC-BY-4.0 LICENSE.md; we vendor from the MIT original instead.

## Review (2026-10-06)

- Read all 9 files (SKILL.md + 8 references). No scripts. No network calls, downloads, credential access or
  prompt-injection text. Only shell content is OpenSCAD/FreeCAD CLI examples in references not vendored.
- Not vendored (duplicative or off-stack): upstream SKILL.md (generic FreeCAD-first workflow, PCB-skill coupling),
  fdm-design-rules.md (dup of accepted fdm-design-rules), enclosure-design.md (dup of enclosures),
  openscad-reference.md (dup of printable-openscad), freecad-scripting.md, resin-printing.md, advanced-processes.md
  (SLS/MJF/metal; off-stack).
- Value: self-tapping pilot-hole table, through-hole and captive hex/square-nut pocket sizes, press-fit interference,
  printed-thread limits, adhesive selection, joint selection guide; print-settings.md adds an engineering-material
  survey (PC, PCTG, CF/GF, PVB, HIPS), per-material slicer starting points, supports, post-processing, troubleshooting.

## Adaptations

- Renamed to `mechanical-joints` with a new description (the upstream name/description describe the whole broad
  skill, of which only the joints/settings knowledge is kept). Added "Crease notes (read first)".
- Snap-fit section replaced with a pointer to `snap-fits` (avoid conflicting numbers).
- Living-hinge orientation wording clarified; press-fit example annotated (as-printed vs nominal holes).
- print-settings.md: added a header comment (slicing only via `slice_part`) and repointed a dangling reference to
  `fdm-design-rules.md` at our `fdm-design-rules` skill. Otherwise verbatim.

## Dependencies

None. BOSL2/NopSCADlib are mentioned as optional OpenSCAD libraries only.
