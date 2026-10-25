# Agent skills: what we vendored and why

Skills live in `server/agent/skills/<name>/`. `installProjectSkills` (server/agent/prompt.ts) copies every
directory there into `<project>/.claude/skills/`. Each vendored skill has the upstream `LICENSE` and a `SOURCE.md`
that records the upstream URL, commit, license, review notes and adaptations. Review date: 2026-10-06.

Review rules (SPEC "Skills" and "Risks"):
- Read every file.
- Reject anything that makes network calls, downloads, runs installers, writes outside the project, touches
  credentials or contains prompt-injection text.
- Vendor only permissive licenses (MIT / Apache / BSD / CC). GPL and no-license skills are listed here, never vendored.
- Drop low-value, duplicate or off-stack skills.

Our stack: OpenSCAD driven through the MCP tools (`render_part` / `check_part`), a SPARKX i7 with a 0.4 mm nozzle, and the 4-slot CFS.

Vendored skills:
- **Scripts:** none. Every upstream script was dropped, and script steps were replaced with MCP tool calls or a
  manual procedure.
- **Wrong engine in examples:** AgentCAD code samples are build123d. A "Crease notes" header tells the agent to
  translate them to OpenSCAD.

## Vendored

| Skill | Source | License | Verdict / notes |
|---|---|---|---|
| fdm-design-rules | https://github.com/n3r/AgentCAD/tree/4b00aa5/agentcad/skills/fdm-design-rules | Apache-2.0 | Vendored. Cited FDM rule set (line-width walls, teardrop holes, elephant foot, warping, orientation for strength, materials). |
| snap-fits | https://github.com/n3r/AgentCAD/tree/4b00aa5/agentcad/skills/snap-fits | Apache-2.0 | Vendored. Bayer/BASF cantilever math, strain per material with FDM derating, undercut/angle rules, annular snaps. |
| fits-and-clearances | https://github.com/n3r/AgentCAD/tree/4b00aa5/agentcad/skills/fits-and-clearances | Apache-2.0 | Vendored. ISO 286 fits, printed clearance table, bearing seats, heat-set insert holes. |
| enclosures | https://github.com/n3r/AgentCAD/tree/4b00aa5/agentcad/skills/enclosures | Apache-2.0 | Vendored. Walls, lid lips/grooves, screw bosses, PCB standoffs, vents. |
| bosl2-attachment | https://github.com/Ranch-Hand-Robotics/openscad_skills/tree/c073883/skills/bosl2-attachment | MIT | Vendored. BOSL2 anchors/attach/spin/diff. **Needs BOSL2** (not installed). Falls back to plain OpenSCAD. |
| bosl2-joiners | https://github.com/Ranch-Hand-Robotics/openscad_skills/tree/c073883/skills/bosl2-joiners | MIT | Vendored. BOSL2 half_joiner pairs for splitting parts that are too big for the bed. **Needs BOSL2.** Lower confidence (not verified against BOSL2 source). |
| print-in-place | https://github.com/AaronGoldsmith/mcp-printable/tree/2810b94/.claude/skills/print-in-place (+ its docs/design/print-in-place.md) | MIT | Vendored. Says each moving part needs its own path to the bed, and gives gap tables. The upstream snap-fit formula was wrong; replaced with a pointer to snap-fits. |
| mechanical-joints | https://github.com/obelisk-complex/claude-skills/tree/71b402f/src/3d-print-design | MIT | Vendored, renamed. Only the joints reference (pilot holes, nut pockets, press fits, printed threads, adhesives) and print-settings were kept. The rest duplicated other skills or was off-stack. |
| fdm-structural-review | https://github.com/V0v1kkk/freecad-engineering/tree/6d48362/skills/fdm-structural-review (+ mechanical-strength-review) | MIT | Vendored, two skills merged. Load-bearing parts: walls vs infill, anisotropy, creep, hand formulas, coupons. Python helpers dropped. |
| analyzing-print-failures | https://github.com/Eli-code1/printagent/tree/98cf2d5/skills/analyzing-print-failures | MIT | Vendored. Failure → design fix vs slicer/printer fix table. Router script dropped. |
| verifying-assembly-fit | https://github.com/Eli-code1/printagent/tree/98cf2d5/skills/verifying-assembly-fit | MIT | Vendored. As-printed fit model and insertion-order check. The trimesh checker (pip bootstrap) was replaced by a manual procedure, with its constants transcribed. |

## First-party skills (written for Crease)

| Skill | Notes |
|---|---|
| printable-openscad | Core conventions and render/check loop. Now mentions bundled BOSL2. |
| fit-and-tolerance | Clearances read from the printer profile `tolerances` (defaults 0.2 / 0.1 / +0.2), holes, screws, nut traps, heat-set inserts, BOSL2 threads with `$slop`, bearing seats, fit coupon. Adapts ideas from Altern92/openscad-cad-skills (MIT, attributed; LICENSE-Altern92). |
| multicolor | `color()` per CFS slot (≤ filamentSlots, literal colours), non-overlapping colour bodies, minimising swap layers and purge, 3MF hand-off for multicolour slicing. |
| assembly-guide | Written by the assembly agent. |
| what-you-can-make | Capability map: request kind → toolkit (OpenSCAD + BOSL2 sweeps/textures, Blender sculpting, imported files) → expected quality, printer limits, what can't be done. Rule: read it before saying "I can't" or suggesting an outside service; a missing free tool is an install question (recommended first). |
| blender-sculpting | Sculpted parts as `parts/<id>.blend.py` (run by the app in Blender's sandbox): the `printstudio` helper API (server/cad/sculpt-py/printstudio.py), techniques, FDM floors, review loop, and `template-king.blend.py`. |

## Not vendored: no license (listed only)

| Skill | Source | License | Notes |
|---|---|---|---|
| openscad (andreahaku) | https://github.com/andreahaku/openscad_claude_skill | none | The user named this one. Rich: Quick/Modify/Reconstruct (STL→SCAD) modes, printer-profile templates, calibration comb. Also ships 9 render/analyze shell and Python scripts that duplicate our tools. **Ask the author for a license**; the templates and code guidelines would be worth having. |
| openscad-skill (ModelRift) | https://github.com/ModelRift/openscad-skill | none | Render/inspect/export workflow plus scripts. Mostly duplicates our tools. |
| openscad-bosl2 (swh) | https://github.com/swh/openscad-skill | none | Large BOSL2 reference (473 lines). Strongest BOSL2 candidate if it gets licensed. |
| openscad (iancanderson/openscad-agent) | https://github.com/iancanderson/openscad-agent | none | Tooling workflow. |
| openscad-bosl2 (elentok/dotfiles) | https://github.com/elentok/dotfiles/tree/main/core/ai/skills/openscad-bosl2 | none | Personal dotfiles. |
| openscad-skill / openscad-bosl2-skill (wuwx) | https://github.com/wuwx/openscad-bosl2-skill | none | — |
| parametric-3d-printing (flowful-ai) | https://github.com/flowful-ai/cad-skill | PolyForm Noncommercial | Not open source. CadQuery-based. |
| part-forge fdm-structural-design | https://github.com/RB-chrismandich/part-forge | none | — |
| claude-skill-registry-data mirrors | https://github.com/majiayu000/claude-skill-registry-data | none | Scraped mirror of other people's skills. |

## Not vendored: GPL

| Skill | Source | License | Notes |
|---|---|---|---|
| kobra-print-skill / kobra-s1-mcp-toolkit | https://github.com/gsasouza/ai-3d-printing | GPL-2.0-only (toolkit) | Anycubic Kobra cloud helpers. GPL, and off-stack. |
| orca-profiles / orca-wxwidgets | https://github.com/OrcaSlicer/OrcaSlicer/tree/main/.claude/skills | AGPL-3.0 | Skills for OrcaSlicer's own development, not for users. |

## Rejected (permissive license)

| Skill | Source | License | Reason |
|---|---|---|---|
| openscad (mitsuhiko) | https://github.com/mitsuhiko/agent-stuff/tree/main/skills/openscad | Apache-2.0 | Duplicates our tools: render/preview/export shell scripts. render_part/check_part do this already. |
| openscad (goncalossilva/tau) | https://github.com/goncalossilva/tau/tree/main/skills/openscad | MIT | Fork of mitsuhiko's; same reason. |
| openscad / 3d-print-design (Stab-Rabbit-coding/SecureControllers) | https://github.com/Stab-Rabbit-coding/SecureControllers | CC-BY-4.0 | Derivative copies of mitsuhiko and obelisk. We vendored from the MIT originals. |
| threads-and-fasteners, holes, ribs-bosses-draft, brackets-and-mounts, etc. (AgentCAD) | https://github.com/n3r/AgentCAD/tree/main/agentcad/skills | Apache-2.0 | Tied to the AgentCAD toolkit / bd_warehouse, or off-stack (sheet metal, FEM, sketch solver). |
| scad-library-* / scad-* (Kevoyuan/AgentSCAD) | https://github.com/Kevoyuan/AgentSCAD/tree/main/skills | MIT | Thin and app-specific. **Red flags:** `install_scad_libraries.py` downloads libraries through subprocesses, and scad-improvement curls a cron endpoint with `$CRON_SECRET`. |
| openscad-bosl2-mastery (+3) | https://github.com/joaorura/openscad-skills | MIT | Very thin generated summaries. |
| openscad-design | https://github.com/RobertCoop/openscad-mcp/tree/main/skills/openscad-design | MIT | Tied to its own MCP tools; duplicates our loop. |
| use-openscad | https://github.com/FradSer/dotclaude/tree/main/hardware/skills/use-openscad | MIT | CLI/Docker tooling. |
| openscad-cad / scad-modeler / openscad-organic | https://github.com/Altern92/openscad-cad-skills | MIT | Tells the agent to git clone, brew and pip install. ~20 Python checkers. Multi-file layout conflicts with ours. Worth reusing: `references/tolerances.md` and `true_hole_d()` / `calibration_coupon()` in `patterns.scad`. |
| jj-openscad-skill | https://github.com/jacobjennings/jj-openscad-skill | MIT | Generic language reference. Says "never render", which conflicts with our loop. |
| model-viewer / openscad-language / parametric-design | https://github.com/fingerskier/openscad-claude-plugin | MIT | Basics only. **Red flag:** `npx -y openscad-viewer` auto-download. |
| openscad-modeling | https://github.com/Ranbaixin/openSCAD-skill | MIT | Script-based. Its examples are wrong (the "print-in-place" hinge isn't one). |
| openscad (openharness) | https://github.com/autonomous-ai/openharness/tree/main/store/agents/openscad | MIT | Tied to its platform's builder. **Red flag:** runtimes.sh curls uv/micromamba. |
| orcaslicer (openharness) | https://github.com/autonomous-ai/openharness/tree/main/store/agents/orca-slicer | MIT | Drives OrcaSlicer directly (Marlin only); duplicates slice_part. |
| openscad-mechanical | https://github.com/BlueAndi/Pixelix/tree/master/.github/skills/openscad-mechanical | MIT | Specific to the Pixelix project; broken references. |
| homeracker skills | https://github.com/kellerlabs/homeracker/tree/main/.claude/skills | MIT | Specific to the HomeRacker project, or not CAD. |
| orienting-for-fdm, reviewing-manufacturability-fdm, reviewing-structural-loads, designing-in-plain-language, generating-build123d, slicing-handoff-bambu, publishing-onshape | https://github.com/Eli-code1/printagent/tree/main/skills | MIT | Script-only or build123d/Bambu/Onshape. **Red flag:** publishing-onshape reads ONSHAPE keys and writes a credentials file. bootstrap_env.py runs pip. |
| dfam-check, dfm, gcode, cad, step-parts | https://github.com/earthtojake/text-to-cad/tree/main/skills | MIT | Need Python packages. dfm covers CNC/sheet metal. gcode runs brew install and OrcaSlicer directly. step-parts downloads files. |
| print-design-rules | https://github.com/seehiong/blender-mcp-bridge/tree/main/.claude/skills/print-design-rules | MIT | Blender data file; duplicates other skills. |
| fdm-printing | https://github.com/ShreddyKrueger75/claude-orcaslicer-mcp/tree/main/.claude/skills/fdm-printing | MIT | Specific to the Elegoo Centauri; tied to its own tools. Calibration content is decent. |
| bambu-print-optimizer | https://github.com/d4nielantoni/claude-skills | MIT | Bambu Studio GUI automation. |
| fdm-print-preflight, bambu-print-troubleshoot | https://github.com/CarlosZiegler/bambu-h2c-skills | MIT | Portuguese, Bambu-specific, script-based. |
| fdm-printing | https://github.com/asermas/claude-engineering-skills/tree/main/skills/fdm-printing | MIT | Short; already covered. |
| configure-fdm-slicer, optimize-fdm-model | https://github.com/gsasouza/ai-3d-printing/tree/main/fdm-skills | MIT (this dir only) | Kobra-specific and script-heavy. `multimaterial-and-pauses.md` is a runner-up for our own `multicolor` skill. |
| CadQuery skills | julianubico/cadquery-3d-printing (MIT), gAmUssA/cadquery-skills (MIT), szymansk/cadquery-expert-skill (Apache-2.0) | — | Wrong engine; no new print knowledge. Revisit if build123d/CadQuery becomes a second engine. |
| snap-fits, design-for-assembly, locking-mechanisms, polymer-engineering, gear-rating-agma | https://github.com/MP-AI-20/mechanical-engineering-skills | MIT | Generated content aimed at industrial moulding and steel. Noisy references. |
| print-in-place siblings (blender-*) | https://github.com/AaronGoldsmith/mcp-printable | MIT | Blender only. |

## Gaps and recommendations

- **BOSL2:** done. v2.0.766 is bundled (`resources/openscad-libraries/BOSL2`) and put on `OPENSCADPATH` for every render.
- **Still missing (no good permissive skill found):** gears and living hinges in OpenSCAD. BOSL2's `gears.scad` /
  `hinges.scad` are now available. Threads and multicolour are covered by our first-party skills.
- **Licensing:** ask andreahaku and swh to add licenses. They are the strongest unlicensed candidates.
