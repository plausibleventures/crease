// Slice failures in plain words (U1). The slicer's own message (OrcaSlicer exit codes, OpenSCAD errors, colour
// mapping) stays available as the detail; the overview and toasts lead with one short sentence a beginner can act on.

export type SliceErrorKind = "fit" | "colour" | "shape" | "slicer" | "other"

const RULES: [RegExp, SliceErrorKind, string][] = [
  [/nothing to be sliced|no object is fully inside the print volume|outside (of )?the (print|build) volume|exceeds? the (print|build) volume|too (big|large) for/i, "fit", "The part doesn't fit on the plate."],
  [/no filaments are loaded/i, "colour", "No filament is set up on the printer."],
  [/colours? but the printer has \d+ filament slots|more colours than filament slots/i, "colour", "The design uses more colours than the printer holds."],
  [/isn't loaded \(closest is|needs every color\(\) to match a loaded filament/i, "colour", "A colour in the design isn't loaded on the printer."],
  [/would both print with slot/i, "colour", "Two colours in the design would print with the same filament."],
  [/outside every color\(\)/i, "colour", "Part of the design has no colour, so it has no filament."],
  [/not manifold|non-manifold|empty (mesh|stl)|top level object is empty|produced no geometry/i, "shape", "The shape can't be sliced. Ask the designer to fix it."],
  [/enoent|not found|no such file|spawn/i, "slicer", "The slicer program wasn't found. Check it in Settings."],
  [/timed? ?out|etimedout|killed|sigterm/i, "slicer", "Slicing took too long and stopped."],
]

/** One short sentence for a slice error, and what kind of problem it is. */
export function plainSliceError(raw: string): { message: string; kind: SliceErrorKind } {
  for (const [re, kind, message] of RULES) if (re.test(raw)) return { message, kind }
  return { message: "Slicing didn't work.", kind: "other" }
}
