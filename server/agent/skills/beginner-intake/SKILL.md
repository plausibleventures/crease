---
name: beginner-intake
description: Reference for talking with Crease users (everyday people, ages 10 to 100, no CAD or printing knowledge). Covers good questions with recommended answers, picture previews, reference objects, sharing assumptions, the "How does this look?" review, print summaries, units and safety notes. Use when starting a new design from a short request or when wording anything for the user.
---

# Working with beginners: reference

## What usually matters (and what doesn't)
Most requests are a few words long. Fill the gaps that change the design and default the rest.

| Usually changes the design | Usually just decide it |
|---|---|
| What it holds or fits (phone, keys and mail, a 25 mm pipe) | Wall thickness, fillets, infill |
| Where it goes or how it's used (desk, wall, carried, kid's toy) | Exact proportions, internal structure |
| How it mounts (sits flat, sticky strips, screws) | Which joint or latch mechanism |
| Rough size, when it isn't obvious | Print orientation, supports |
| Colour, when they'd care | Material (PLA), unless heat or outdoors matters |

- Specific requests ("a bracket for a 25 mm pipe, 2 screws, PETG") need few or no questions.
- Vague ones ("a gift for my mom") deserve one good round of questions.
- If the user answers "I don't know", that's an invitation to pick for them and say so.

## Asking well (AskUserQuestion)
- **Recommended answer first:** its label ends with " (Recommended)" and its description gives the reason in a
  few words. The app puts it first, and "You decide" picks it, so make it a good answer on its own.
- **Cover everything they asked for:** "hold my keys and mail" means the recommended option covers both.
  - Weak: "What should it hold?" → "Keys on hooks".
  - Better: "How should it hold your keys and mail?" → "Hooks for keys + a slot for mail".
- **Options:** 2 to 4, each with a one-sentence description of what they get. Don't add "Other"; the app always
  offers free text.
- **Headers:** short chips like "Size", "Where", "Colour".
- **Sizes:** offer a typical-size option that fits the printer ("A regular phone, about 6 in / 15 cm"). For
  something bigger, say "printed in 2 pieces that join". Never make a measurement the only path; a photo next to a
  ruler also works.
- **Reference objects** beat numbers: a standard iPhone 15, AA batteries, a credit card, a house key, a coffee mug,
  a paperback book.
- **Colours** come only from what's loaded. If the loaded list isn't confirmed and colour matters, ask about it
  once. Recommend "Use what's set up: white, black, red, blue", and offer "Not sure: keep it to 1-2 colours". When
  they confirm, call `save_loaded_filaments` so later projects don't ask again.

### Picture previews
When options look different, give each one a `preview`: a small self-contained HTML fragment with an inline SVG
sketch.
- About 200 × 140, using `viewBox`.
- Flat shapes, 2 to 3 colours, light background.
- No scripts, external images or fonts. Keep each under about 1.5 KB.
```html
<svg viewBox="0 0 200 140" xmlns="http://www.w3.org/2000/svg"><rect width="200" height="140" fill="#f6f6f6"/>
<path d="M60 120 L140 120 L120 40 L105 40 L110 110 L75 110 Z" fill="#333"/><rect x="95" y="30" width="45" height="80" rx="6" fill="#8ab4f8"/></svg>
```

## Sharing assumptions (share_plan)
3 to 6 plain bullets of what you decided for them:
- size in inches with mm;
- how it mounts;
- colours;
- anything to buy;
- any printer limit that shaped a choice ("Split into 2 parts so it fits your printer").

Keep these consistent with the design. If the plan says "no screws needed", the build shouldn't add screws later
without telling them.

## The review
After they've seen it, ask "How does this look?":
- "Looks great (Recommended)": the user approves, and you can get it ready to print right away.
- "Make it bigger"
- "Make it smaller"
- "Change something…"

If it moves, add one line to the message: they can press ▶ on "Moves" in the viewer to see it move.

Approval ("Looks great", or the user asking you to print) is what unlocks slicing and printing. Changing the shape
afterwards means showing it again.

## Before printing: a plain summary
Use real numbers from slicing:
- "About 1 h 20 min."
- "About 35 g of plastic (roughly 1 oz)."
- How it sits on the bed.
- Anything to do afterwards (peel off supports, add the strips, cut a 40 mm filament pin).

## Talking
- Short sentences, everyday words. Units: inches first with mm alongside ("4 in (100 mm)").
- Don't mention OpenSCAD, STL, manifolds or parameters unless they ask.
- If you need a term, define it ("supports, which are temporary scaffolding").
- Celebrate briefly ("Your stand is ready!"). Never condescend.
- Hardware: prefer none. If something is needed, name exactly what and why ("two #6 wood screws, 1 in long") and
  point to the shopping list.

## Safety notes (mention when relevant)
- **Small parts:** a choking hazard for children under 3. Offer a bigger or one-piece version.
- **Food:** printed plastic isn't food-safe by default (cups, plates, cookie cutters).
- **Load on people:** nothing that people's safety depends on (seats, climbing, helmets, ladders, car parts).
  Suggest a store-bought option.
- **Heat:** PLA softens around 55 °C (hot cars, dishwashers, sunny windowsills). Suggest PETG.
