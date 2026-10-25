# Source

- **Upstream:** https://github.com/Ranch-Hand-Robotics/openscad_skills/tree/c073883b2e92d4c0ada4a3422ba173ab6a05c488/skills/bosl2-attachment
- **Path in repo:** skills/bosl2-attachment/SKILL.md
- **Commit:** c073883b2e92d4c0ada4a3422ba173ab6a05c488
- **Fetched:** 2026-10-06
- **License:** MIT (repo-root LICENSE, "Copyright (c) 2026 Ranch Hand Robotics, LLC"; no per-directory license; copied here as LICENSE)
- **Author:** Ranch Hand Robotics (git author; repo owner Ranch-Hand-Robotics)

## Review notes
- The upstream skill directory has exactly one file (SKILL.md); there are no scripts, references or examples. The repo also has only README.md and LICENSE.
- Security: no network calls, downloads, install commands, file writes, credential/env access or shell steps. The only URL is a markdown link to the BOSL2 GitHub repo. Checked for non-ASCII or hidden characters (none) and for prompt-injection-style text (none).
- Content: Explains BOSL2 anchors (faces/edges/corners as TOP+RIGHT etc.), attachable parent/child blocks, the chaining pitfall (use { } block form), two-anchor attach(parent, child, spin=), single-arg attach with child anchor/orient, diff()+attach, and a troubleshooting list. Content checked against BOSL2 attachment semantics; accurate. One example uses isogrid_rect(), which is not a BOSL2 module (noted in the skill).
- Value for Crease: BOSL2 *knowledge* our printable-openscad skill does not cover. This is not a tooling workflow.

## Adaptations
Replaced the two 'determine if BOSL2 is available / suggest it to the user' bullets with a '## Crease notes' section (BOSL2 not bundled -> probe with render_part, fall back to plain OpenSCAD; use render_part/check_part MCP tools, never shell out; one part per parts/<id>.scad; Customizer params), plus a note that isogrid_rect() is not a BOSL2 module. Body otherwise unchanged.

## Dependencies
- **Requires the BOSL2 library (https://github.com/BelfrySCAD/BOSL2), which is NOT installed/bundled with Crease.** The agent must check that `include <BOSL2/std.scad>` resolves (via render_part) and otherwise fall back to plain OpenSCAD. Do not auto-download BOSL2; ask the user first. BOSL2 is BSD-2-Clause, so bundling it later would be licence-compatible.

## Update 2026-10-06
BOSL2 v2.0.766 is now bundled (resources/openscad-libraries/BOSL2, on OPENSCADPATH); the Crease note was updated to say so.
