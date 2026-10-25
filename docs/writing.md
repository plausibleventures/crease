# Writing for the UI

Crease is for beginners aged 10 to 100. Most screens show too many words. These rules apply to every label,
hint, card, toast, dialog and agent-facing message the app writes. Based on Simple English
(github.com/AminBlg/SimpleEnglish) and Plain English (github.com/b1rdmania/claude-plain-english-skill).

## Budget
- A label is 1 to 3 words. A button is a verb plus at most two words ("Approve", "Slice again").
- A hint is one sentence of at most 12 words. Most things need no hint.
- A card or panel shows at most one sentence of body text. Put more behind a "?" tooltip, a "Details" disclosure or
  a modal.
- An empty state is one short line plus one button.
- Numbers beat words: "18 min · 8 g", not "It will take about 18 minutes and use 8 grams".
- Show a thing once. If the toolbar shows the print time, the card does not repeat it.

## Words
- Say what to do, then why only if needed. Put the condition first: "If it looks right, approve it."
- Active voice, simple tense. "can", "will", "must"; not "should", "might", "may".
- One word for one thing. Use the glossary below and never rotate synonyms.
- No em-dashes in UI text. Use a period or a middle dot (·).
- No filler: "just", "simply", "basically", "actually", "please note". No "not just X, it's Y".
- Define a term in a few words the first time a beginner meets it, in a tooltip, not inline.
- Headings and labels are plain sentence case in the interface font ("Planned plate", not "› planned plate"). Monospace
  is for code, G-code, file paths and numbers that line up in a table, never for labels or buttons.

## Show less at once
- The simple view hides what a beginner does not need now: code, layer tools, raw settings, file names, costs. They open in place: a per-panel "Details" (remembered), the Code toggle, a hover. No modes.
- One "show more" control everywhere: a label and a chevron, plus an optional one-line summary of what is inside
  ("All settings · 8", "Tools · All found"). In place it is `DetailsToggle`; on long pages it is the accordion, whose
  header shows the same summary while closed. Never an unlabelled icon, never "Show/Hide" swapping labels.
- Confirmation dialogs (the print dialog) always open short: their Details are never remembered.
- Lists of similar things are tables (name · status · one number · action), not stacks of cards.
- Several steps in order are a stepper: one step visible at a time, with Back and Next.
- A choice or form that interrupts the flow is a modal, not an inline block that pushes content around.
- Long pages are accordions: only the most useful section starts open; the rest show a title and a count.
- Warnings group by severity and collapse to one line each; details on click.

## Glossary
| Use | Not |
|---|---|
| designer | agent, AI, model, runtime |
| print | job, run |
| slice | prepare, process |
| plate | bed layout, build plate |
| part | piece, object, model |
| check | verify, validate, confirm |
| approve | accept, sign off |
| printer | machine (in text; "Machines" is the page name) |
| Not set up (a designer without a working key or sign-in) | Needs a key, Not signed in, Pick how to pay |
| Offline (the state word); "No answer from <name>" (the sentence) | disconnected, unreachable, unavailable, can't use: offline |
| Stop (a running print) | Cancel (a print) |
| Display piece | Display intent |
| Print guide (the paper assembly guide) | Print (for anything but the 3D printer) |
