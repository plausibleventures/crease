# Crease — UX design philosophy

Binding for anyone (human or agent) changing the UI. Wording rules live in [writing.md](writing.md).

Act as a senior product designer specialising in human–computer interaction, interaction design, information
architecture and usability engineering.

Crease is a free, open-source, local-first creation and 3D-printing app for everyone, including people who do
not own a 3D printer. The objective: make a technically powerful product feel effortless, approachable and enjoyable
without compromising expert capability.

**Complexity should be available on demand, not imposed by default.**

## Core principles
1. **Progressive disclosure over feature exposure.** Show the controls needed for the current task. Reveal advanced
   options in context, without making them hard for experienced users to reach.
2. **Task-first, not feature-first.** Structure the experience around what users want to accomplish, not around
   the software's modules.
3. **Clarity over cleverness.** Recognisable interactions, plain language, meaningful defaults, predictable behaviour.
4. **Minimise cognitive load.** Fewer choices, less visual competition, less context switching, less to remember.
5. **Progressive mastery.** An approachable first run that grows into shortcuts and sophisticated workflows. Beginner
   and expert are two depths of the same product, not two products.
6. **Respect the canvas.** In the workspace, the user's work dominates the visual hierarchy; tooling supports it.
7. **Contextual complexity.** Tools and settings appear where they become relevant. Exploring and creating never
   require printer setup.
8. **Design for confidence.** Clear feedback, reversible operations, understandable errors, reliable state, safe
   experimentation.
9. **Consistency and restraint.** A small, coherent interaction and visual system. No new card, panel, control,
   dialog or decoration without a demonstrated purpose.
10. **Simplicity must not cost capability.** Reduce the burden of using complex features, not the features.

## Required process for significant UI changes
- Inspect the existing experience and trace its main user journeys.
- For each screen, name the primary action, the competing actions, unnecessary decisions and sources of cognitive load.
- Evaluate for first-time, occasional and experienced users.
- Separate verified issues from untested hypotheses.
- Propose specific improvements with rationale and trade-offs.
- Preserve working functionality. Avoid unnecessary onboarding, artificial modes or extra navigation layers.
- After implementing, verify the rendered interaction, including empty, error and recovery states.

## Every major screen must answer
- What am I looking at?
- What can I do here?
- What should I do next?
- What happened after my last action?
- Where do I find advanced capabilities when I need them?

Do not mistake a visually minimal interface for a usable one. Hiding everything in menus can make expert use worse.
Optimise for comprehension, task completion, discoverability and long-term fluency.

## Skills
Project skills in `.claude/skills/` (reviewed before install), each with one job:
1. **Diagnose:** UX audit of screens and journeys. Findings only, no code changes.
2. **Rethink:** product design and UX: information architecture, task flows, fewer decisions.
3. **Refine:** distil and critique the UI once the structure is right.
4. **Verify:** web interface guidelines as the final review pass on frontend changes.
