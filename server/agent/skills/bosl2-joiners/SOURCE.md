# Source

- **Upstream:** https://github.com/Ranch-Hand-Robotics/openscad_skills/tree/c073883b2e92d4c0ada4a3422ba173ab6a05c488/skills/bosl2-joiners
- **Path in repo:** skills/bosl2-joiners/SKILL.md
- **Commit:** c073883b2e92d4c0ada4a3422ba173ab6a05c488
- **Fetched:** 2026-10-06
- **License:** MIT (repo-root LICENSE, "Copyright (c) 2026 Ranch Hand Robotics, LLC"; no per-directory license; copied here as LICENSE)
- **Author:** Ranch Hand Robotics (git author; repo owner Ranch-Hand-Robotics)

## Review notes
- The upstream skill directory has exactly one file (SKILL.md); there are no scripts, references or examples. The repo also has only README.md and LICENSE.
- Security: no network calls, downloads, install commands, file writes, credential/env access or shell steps. The only URL is a markdown link to the BOSL2 GitHub repo. Checked for non-ASCII or hidden characters (none) and for prompt-injection-style text (none).
- Content: Explains half_joiner()/half_joiner2() from BOSL2/joiners.scad, pairing a tab half with a socket half via attach(), corner behaviour by joiners on two faces, placement rules, and common errors (e.g. corner_joiner2 unknown). Lower confidence than bosl2-attachment: upstream text implies only the socket half needs diff(); BOSL2's joiners may carry remove-tagged screw holes on both halves, so the adaptation says to diff() both (safe either way). Could not verify against BOSL2 source locally (BOSL2 not installed).
- Value for Crease: BOSL2 *knowledge* our printable-openscad skill does not cover. This is not a tooling workflow.

## Adaptations
Replaced the two 'determine if BOSL2 is available' bullets with a '## Crease notes' section (same BOSL2 probe/fallback, MCP-tool, one-part-per-file and Customizer notes as bosl2-attachment), plus: include BOSL2/joiners.scad; wrap both halves' parents in diff() and confirm screw hole via render_part; split Part A/Part B into separate parts/<id>.scad files; use case = splitting parts too big for the SPARKX i7 bed. Body otherwise unchanged.

## Dependencies
- **Requires the BOSL2 library (https://github.com/BelfrySCAD/BOSL2), which is NOT installed/bundled with Crease.** The agent must check that `include <BOSL2/std.scad>` resolves (via render_part) and otherwise fall back to plain OpenSCAD. Do not auto-download BOSL2; ask the user first. BOSL2 is BSD-2-Clause, so bundling it later would be licence-compatible.

## Update 2026-10-06
BOSL2 v2.0.766 is now bundled (resources/openscad-libraries/BOSL2, on OPENSCADPATH); the Crease note was updated to say so.
