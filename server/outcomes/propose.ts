// OWNER: feedback (R15). Turn a print outcome into one proposed lesson line for the printer's lessons.md (the design
// agent reads it). Deterministic and plain-worded; the user accepts, edits or dismisses it.
import type { PrintFailureCategory, PrintIntent, PrintOutcome } from "../../shared/types"

export const CATEGORY_LABEL: Record<PrintFailureCategory, string> = {
  didnt_stick: "didn't stick",
  stringing: "stringing",
  warping: "warping",
  layer_shift: "layer shift",
  spaghetti: "spaghetti",
  rough_top: "rough top",
  wrong_size: "wrong size / fit",
  broke: "broke",
  other: "other",
}

const INTENT_LABEL: Record<PrintIntent, string> = { display: "Display", strong: "Strong", fast: "Fast", draft: "Draft", standard: "Standard" }

const r2 = (v: number) => Math.round(v * 100) / 100
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

type Input = Pick<PrintOutcome, "rating" | "categories" | "measurements" | "fits" | "scope" | "partIds" | "notes">

/** One lesson line (≤ 300 chars, no trailing period), or null when there's nothing reusable to learn. */
export function proposeLesson(o: Input): string | null {
  const material = o.scope?.material ?? "PLA"
  const intent = o.scope ? INTENT_LABEL[o.scope.intent] : null
  const settings = intent ? ` with ${intent} settings` : ""
  const part = o.partIds.length === 1 ? ` (${o.partIds[0]})` : ""

  // Measured numbers first: they're the most reusable.
  const holes = o.measurements.filter((m) => m.kind === "hole" && m.measuredMm != null)
  const holeErr = holes.length ? avg(holes.map((m) => m.expectedMm - (m.measuredMm as number))) : 0
  if (holes.length && Math.abs(holeErr) >= 0.1) {
    return holeErr > 0
      ? `Holes print about ${r2(holeErr)} mm small in diameter in ${material}${settings}; make holes ${r2(holeErr)} mm bigger${part}`
      : `Holes print about ${r2(-holeErr)} mm big in diameter in ${material}${settings}${part}`
  }
  const tight = o.fits.filter((f) => f.result === "too_tight")
  const loose = o.fits.filter((f) => f.result === "too_loose")
  const right = o.fits.filter((f) => f.result === "just_right")
  const cl = (f: (typeof o.fits)[number]) => (f.clearanceMm != null ? ` at ${r2(f.clearanceMm)} mm clearance per side` : "")
  if (tight.length) {
    const f = tight[0]
    return `${f.kind === "press" ? "Press" : "Sliding"} fit "${f.name}" was too tight${cl(f)} in ${material}; add about 0.1 mm more clearance${part}`
  }
  if (loose.length) {
    const f = loose[0]
    return `${f.kind === "press" ? "Press" : "Sliding"} fit "${f.name}" was too loose${cl(f)} in ${material}; use about 0.05 mm less clearance${part}`
  }
  const outside = o.measurements.filter((m) => m.kind === "outside" && m.measuredMm != null)
  const outErr = outside.length ? avg(outside.map((m) => (m.measuredMm as number) - m.expectedMm)) : 0
  if (outside.length && Math.abs(outErr) >= 0.2) {
    return `Outer sizes print about ${r2(Math.abs(outErr))} mm ${outErr > 0 ? "large" : "small"} in ${material}${settings}${part}`
  }
  if (right.length && right[0].clearanceMm != null) {
    return `${right[0].kind === "press" ? "Press" : "Sliding"} fit${cl(right[0])} was just right in ${material}${settings}`
  }

  const cat = o.categories.find((c) => c !== "other" && c !== "wrong_size")
  switch (cat) {
    case "didnt_stick":
      return `First layer didn't stick${settings}${part}: clean the plate and add a brim for small or narrow footprints`
    case "stringing":
      return `Stringing between separate features in ${material}${settings}${part}: dry the filament or increase retraction`
    case "warping":
      return `Corners lifted (warping) in ${material}${part}: add a brim and round sharp corners on long flat parts`
    case "layer_shift":
      return `Layer shift${part}: check the belts and slow travel moves if it happens again`
    case "spaghetti":
      return `Print came loose mid-print (spaghetti)${part}: needs better bed grip, a brim or supports under overhangs`
    case "rough_top":
      return `Rough top surface${settings}${part}: use Display (ironing, concentric top) for show faces`
    case "broke":
      return `Part broke at a thin section${part}: thicken walls there or use the Strong intent for parts under load`
  }
  // Nothing structured: offer the user's own words when there are any.
  const note = o.notes?.replace(/\s+/g, " ").trim().replace(/\.$/, "")
  if (note && o.rating !== "great") return note.slice(0, 240)
  return null
}
