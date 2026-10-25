# Third-party agent skills

Vendored, markdown-only copies of third-party Claude Code skills used for the UX workflow
(Audit -> Rethink -> Refine -> Verify, see `docs/ux-principles.md`). Installed by reading the
upstream files, not by running their installers (`npx skills`, `npx impeccable`). No scripts,
binaries or hooks are vendored. Each skill directory carries its upstream licence file.

To update: re-fetch the files at a newer commit, diff them, re-review, and update the SHA here.

| Skill dir | Upstream | Path in upstream | Commit | Licence |
|---|---|---|---|---|
| `product-design-and-ux/` | https://github.com/magnus919/agent-skills | `product-design-and-ux/` | `b45615b81418bd55fb32d66f31c833beb73f1b3f` | MIT (c) 2026 Magnus Hedemark (`LICENSE.md`) |
| `ux-audit/` | https://github.com/paulunemoon/ux-audit-skill | repo root | `f07ff7607039a846fba1e711bb99716a68b12f34` | MIT (c) 2026 Pauline Mila Alonso (`LICENSE`) |
| `impeccable/` | https://github.com/pbakaus/impeccable | `.claude/skills/impeccable/` | `d631a8827f99414d2b6daba4ef08b7f8701751d7` (skill v4.5.2) | Apache-2.0 (`LICENSE`, `NOTICE.md`) |
| `web-design-guidelines/` | https://github.com/vercel-labs/agent-skills | `skills/web-design-guidelines/SKILL.md` | `063bee94c3f4df8453406c830b0a7df0f2860278` | MIT (stated in the repo README; the repo has no LICENSE file) |
| `web-design-guidelines/references/web-interface-guidelines.md` | https://github.com/vercel-labs/web-interface-guidelines | `command.md` | `434b7f91364665f2f733b310ec54809bf8f37937` | MIT (c) 2025 Vercel Labs (`LICENSE`) |

## Local changes

- **product-design-and-ux**: unmodified. Left out: `README.md`, `evals/`. Its SKILL.md links to
  sibling skills from the same upstream repo (`product-discovery`, `web-accessibility`,
  `spec-driven-development`, ...) that are not installed; those routing links are dead here.
- **ux-audit**: SKILL.md "Scripts" section rewritten: `scripts/contrast-check.py` (dependency-free
  Python WCAG contrast calculator, no network) is not vendored; the skill computes ratios with the
  formula in `references/accessibility.md` instead. Reference files that still mention the script
  are unmodified. Left out: `scripts/`, `.claude/commands/` (six thin slash-command wrappers for
  audit/flow/quick/a11y/tokens/web3 modes), `README.md`, `CHANGELOG.md`, `SKILL-BRIEF.md`.
  Note: the skill writes its report as `ux-audit-<scope>-<date>.md` in the working directory
  (or `~/Documents/ux-audits/` when not in a project) unless told where.
- **impeccable** (modified, per Apache-2.0 section 4(b); each modified file has a header comment):
  - `SKILL.md`: rewritten Setup and Routing; command table cut to critique, distill, clarify,
    layout, onboard; removed the `scripts/impeccable` launcher, pin, hooks and doctor sections.
    Frontmatter description/argument-hint narrowed to the vendored commands.
  - `reference/critique.md`: detector, live-server overlay and critique-storage steps replaced
    with a manual scan (web-design-guidelines + craft-floor) and optional file archive.
  - `reference/layout.md`: detector step replaced with a manual scan; live-mode section removed.
  - Unmodified: `reference/distill.md`, `clarify.md`, `onboard.md`, `craft-floor.md`, `operate.md`.
  - Left out: `scripts/` (the `impeccable` launcher downloads a native binary from GitHub releases
    on first run and execs it; plus browser-injected JS), all other references, sub-agents, and
    the upstream `.claude/settings.json` hooks (SessionStart / PostToolUse Edit|Write / Stop, each
    running the binary). Upstream's installer puts those hooks in `.claude/settings.local.json`.
- **web-design-guidelines**: upstream SKILL.md tells the agent to WebFetch
  `raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md` before every
  review (unpinned remote instructions). That file is vendored at the commit above as
  `references/web-interface-guidelines.md` and SKILL.md is rewritten to read it locally.
