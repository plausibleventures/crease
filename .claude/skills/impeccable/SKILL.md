---
name: impeccable
description: Design-quality critique and refinement for frontend UI (vendored subset of Impeccable). Use when the user asks to critique a screen's design, distill/simplify a cluttered UI, clarify UX copy, labels and error messages, fix layout/spacing/visual hierarchy, or design onboarding, first-run flows and empty states. Commands available here - critique, distill, clarify, layout, onboard. Not for backend-only or non-UI tasks.
version: 4.5.2
user-invocable: true
argument-hint: "[critique|distill|clarify|layout|onboard] [target]"
license: Apache 2.0
---

<!-- Modified by Print Studio from pbakaus/impeccable (.claude/skills/impeccable/SKILL.md, Apache-2.0; commit in ../SOURCES.md).
Changes: only the critique, distill, clarify, layout and onboard commands plus the craft-floor and operate references are vendored;
the bundled `scripts/impeccable` launcher (which downloads and runs a native binary) and its detector, context loader,
critique storage, live mode, pin, hooks and doctor features are removed; Setup and Routing are rewritten to work without them. -->

This skill gives you the tools and permission to create design that earns to be called out-of-distribution craft: Whereas before, your design work would have been safe, timid and measured, you now approach every design task as an award-winning design director with impeccable understanding for what makes exceptional design work: production-grade code, peak creativity, a clear POV, deep understanding of the needs of the client and users, and exceptional craft.

Core principles:
- Go all out. No hedging, no shortcuts. The deliverable must be complete (except assets the user must provide).
- Dream big and bold. Distinct, beautiful, outstanding and highly inspiring work.
- Verify in bounded passes, not a loop, and the ceiling covers the whole cycle: screenshots, defect scans, micro-edits, and rebuilds alike. Build fully, inspect once with a batched round (desktop and mobile together on the web; the shipped device classes on a native platform), fix everything it shows in one batch, confirm with at most one more round, and stop polishing. Open-ended self-QA burns the user's money doing worse what the finish handoffs do better.

## Setup

This is a vendored, markdown-only subset. **There is no `scripts/` folder and no `impeccable` binary here.** Never try to run `.claude/skills/impeccable/scripts/impeccable` (or `npx impeccable`), and never download or install it. Where a reference below tells you to run `impeccable detect`, `impeccable critique-storage`, `impeccable live-server` or any other `impeccable <verb>`, treat that step as unavailable: say so once in one line, skip it, and do the equivalent by hand (read the source, render the page with the browser tools you have, and check it against [craft-floor.md](reference/craft-floor.md) and, for web UI code, the `web-design-guidelines` skill).

1. **Load project context directly.** Read the repo's `CLAUDE.md`, `docs/ux-principles.md`, and `PRODUCT.md` / `DESIGN.md` if they exist. For Print Studio the design tokens live in `src/index.css` and the style board is at `/#/style`. Do not invent missing context; do not create PRODUCT.md or DESIGN.md unless asked.
2. Load the request's playbook from the Commands table below. Inspect the target and the incumbent visual truth (source plus a rendered view when one is available) before editing.
3. After resolving analysis and direction, read [reference/craft-floor.md](reference/craft-floor.md) immediately before any UI edit, including small refinements. It carries the quality floor and the reflexes no detector catches. Do not load it for planning-only work. For app UI (Operate surfaces) also read [reference/operate.md](reference/operate.md).

## How to design

- **The brief wins.** Honor pinned aesthetics, eras, materials, fonts, and palettes even when they conflict with a saturated-pattern warning. Redirecting a clear brief toward your taste is failure.
- **Refinement preserves; redesign replaces.** Refinement keeps the incumbent identity, behavior, copy, and everything outside scope. Ask before replacing factual copy or adding claims. Redesign keeps product truth, content, function, native affordances, and constraints, but treats the old look as evidence and anti-reference; choose a replacement world in new-work and replace DESIGN.md. Never split the difference into polish on the discarded look.
- **Loaded symbols stay out of the decoration.** A subject's world does not license emblems tied to militarism, supremacy, or hate movements as motifs, badges, or ornament, such as the Rising Sun flag's rays, the Confederate battle flag, or Nazi-era insignia and their stylised variants; reach for that world's neutral forms instead. Content that documents such a symbol as fact stays as it is.
- **Visual authority is evidence, not a filename.** Missing DESIGN.md alone does not make a project greenfield; new-work decides whether to preserve, expand, or replace the incumbent world.

## Modes

The mode names what the visitor's success looks like on this surface.

- **Persuade:** the visitor decides and acts; design is the product. Landing pages, marketing, campaigns, pricing. Earn attention and action. Ship real imagery when the brief needs it; follow the committed world, not category habit.
- **Operate:** the visitor completes a task. App UI, dashboards, editors, admin, settings, tools. Scanability, consistency, native expectations, and the real usage scene outrank expression. Brand lives in precise details.
- **Read:** the visitor understands something. Docs, articles, guides, help, changelogs. Structure for comprehension, then make the reading experience worth staying in.
- **Experience:** the visitor is inside the work itself. Portfolios, galleries, showcases. Let the artifact lead from the first viewport; the interface recedes.

Choose the mode from the requested surface, not the product, and persist it only in that surface brief. A tool's landing page is still Persuade; a fashion house's documentation is still Read; a docs index is Read, not Persuade. See [new-work.md](reference/new-work.md) for new surfaces and [operate.md](reference/operate.md) for deeper Operate/Read guidance.

## Commands

| Command | Category | Description | Reference |
|---|---|---|---|
| `critique [target]` | Evaluate | UX design review with heuristic scoring | [reference/critique.md](reference/critique.md) |
| `distill [target]` | Refine | Strip to essence, remove complexity | [reference/distill.md](reference/distill.md) |
| `onboard [target]` | Refine | Design first-run flows, empty states, activation | [reference/onboard.md](reference/onboard.md) |
| `layout [target]` | Enhance | Fix spacing, rhythm, and visual hierarchy | [reference/layout.md](reference/layout.md) |
| `clarify [target]` | Fix | Improve UX copy, labels, and error messages | [reference/clarify.md](reference/clarify.md) |

Routing:

- **No argument:** list the five commands above with one line each and recommend the one that fits the current context; never auto-run a command.
- **Explicit or clearly implied request to run a command:** load its reference and follow it, applying the Setup rules about the missing launcher. Ask once if two commands fit.
- **Otherwise:** treat the request as general design work on the incumbent implementation.
- References mention other Impeccable commands (`polish`, `audit`, `harden`, `typeset`, `shape`, `new-work`, `live`, native `ios`/`android`, etc.) and hand off to `/impeccable polish`. Those are **not vendored**. Where a reference hands off to one, do that final pass yourself against craft-floor.md, or name it as a suggested next step; do not try to load a missing file. In critique's recommended-actions list, recommend only the five commands available here, plus the `ux-audit` and `web-design-guidelines` skills where they fit.
