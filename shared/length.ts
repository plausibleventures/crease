// One way to show and read lengths in the user's unit (Settings.units). Designs, files and the API stay in mm;
// only what the user reads and types is converted. Used by the renderer (src/lib/units.ts) and by the server where it
// builds user-facing size strings (overview "Too big for …").
import type { Units } from "./types"

export const MM_PER_IN = 25.4

const trim = (s: string) => (s.includes(".") ? s.replace(/\.?0+$/, "") : s)

/** A number in the given unit, no unit suffix: mm "70" / "2.4" / "260"; inches "2.76" / "10.2". */
export function lenNumber(mm: number, units: Units): string {
  if (!isFinite(mm)) return "–"
  if (units === "in") {
    const v = mm / MM_PER_IN
    const a = Math.abs(v)
    return trim(v.toFixed(a >= 10 ? 1 : a >= 1 ? 2 : 3))
  }
  return Math.abs(mm) >= 100 ? Math.round(mm).toString() : trim(mm.toFixed(1))
}

export const unitLabel = (units: Units) => (units === "in" ? "in" : "mm")

/** "70 mm" / "2.76 in". */
export const fmtLen = (mm: number, units: Units) => `${lenNumber(mm, units)} ${unitLabel(units)}`

/** "70 × 85 × 95 mm" / "2.76 × 3.35 × 3.74 in" (unit once, at the end). */
export function fmtDims(v: readonly number[], units: Units, unit = true): string {
  const s = v.map((x) => lenNumber(x, units)).join(" × ")
  return unit ? `${s} ${unitLabel(units)}` : s
}

/** A signed change: "+2.5 mm" / "−0.1 in" ("0" when it rounds away). */
export function fmtLenDelta(mm: number, units: Units, unit = true): string {
  const n = lenNumber(Math.abs(mm), units)
  if (Number(n) === 0) return unit ? `0 ${unitLabel(units)}` : "0"
  return `${mm > 0 ? "+" : "−"}${n}${unit ? ` ${unitLabel(units)}` : ""}`
}

/**
 * Read a typed length back to mm. A bare number is in `units`; "mm", "cm", "in", `"` override. Inches accept
 * fractions: `1/16`, `2 1/2`, `2-1/2"`. Null when it isn't a length.
 */
export function parseLen(text: string, units: Units): number | null {
  let s = text.trim().toLowerCase().replace(/,/g, ".")
  if (!s) return null
  let unit: "mm" | "cm" | "in" = units === "in" ? "in" : "mm"
  const m = s.match(/(mm|cm|in(?:ch(?:es)?)?|"|”)$/)
  if (m) {
    unit = m[1] === "mm" ? "mm" : m[1] === "cm" ? "cm" : "in"
    s = s.slice(0, -m[1].length).trim()
  }
  let value: number | null = null
  const mixed = s.match(/^(-?\d+(?:\.\d+)?)?(?:[\s-]+)?(?:(\d+)\/(\d+))?$/)
  if (mixed && (mixed[1] !== undefined || mixed[2] !== undefined)) {
    const whole = mixed[1] !== undefined ? Number(mixed[1]) : 0
    const frac = mixed[2] !== undefined ? Number(mixed[2]) / Number(mixed[3]) : 0
    if (mixed[2] !== undefined && !(Number(mixed[3]) > 0)) return null
    // "1/16" alone, "2 1/2" mixed; "2.5" plain
    value = whole < 0 ? whole - frac : whole + frac
  }
  if (value == null || !isFinite(value)) return null
  return unit === "in" ? value * MM_PER_IN : unit === "cm" ? value * 10 : value
}

/** Inch slider steps people can read: decimal inches (0.05", 0.1"…), plus 1/8", 1/4", 1/2". */
const INCH_STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.125, 0.25, 0.5, 1]

/** The readable inch step closest (on a log scale) to a mm step. */
export function inchStep(stepMm: number): number {
  const want = Math.max(stepMm, 1e-6) / MM_PER_IN
  let best = INCH_STEPS[0]
  for (const s of INCH_STEPS) if (Math.abs(Math.log(s / want)) < Math.abs(Math.log(best / want))) best = s
  return best
}

const decimalsOf = (step: number) => {
  const s = String(step)
  return s.includes(".") ? s.split(".")[1].length : 0
}

export interface SliderRange {
  min: number
  max: number
  step: number
  /** decimals that show one step */
  decimals: number
}

/**
 * A length slider in the user's unit, from the design's mm range. mm: unchanged. Inches: a readable step and the
 * mm limits rounded inwards to it, so every slider position converts back inside the design's own range.
 */
export function sliderRange(r: { min: number; max: number; step: number }, units: Units): SliderRange {
  if (units !== "in") return { ...r, decimals: decimalsOf(r.step) }
  const step = inchStep(r.step)
  const decimals = decimalsOf(step)
  const round = (v: number) => Number(v.toFixed(decimals + 2))
  let min = round(Math.ceil(r.min / MM_PER_IN / step - 1e-9) * step)
  let max = round(Math.floor(r.max / MM_PER_IN / step + 1e-9) * step)
  if (max < min) [min, max] = [r.min / MM_PER_IN, r.max / MM_PER_IN] // a range narrower than one step: keep its ends
  return { min, max, step, decimals }
}

/** A value in the user's unit (for the slider and its box) from mm. */
export const toUnit = (mm: number, units: Units) => (units === "in" ? mm / MM_PER_IN : mm)

/**
 * A value the user set (slider or box, in their unit) back to mm for the design, clamped to the design's own range
 * and rounded to 0.01 mm (inch values otherwise land on long decimals like 69.85000000000001).
 */
export function fromUnit(v: number, units: Units, range?: { min?: number; max?: number }): number {
  let mm = units === "in" ? v * MM_PER_IN : v
  if (range?.min != null) mm = Math.max(range.min, mm)
  if (range?.max != null) mm = Math.min(range.max, mm)
  return Math.round(mm * 100) / 100
}

/**
 * Is this Customizer setting a length? The designer (and the bundled templates) mark them in the comment:
 * "Width (mm)". A name ending in `_mm` counts too. Counts, angles and ratios have no "(mm)".
 */
export function isLengthParam(p: { type: string; name: string; description?: string }): boolean {
  if (p.type !== "number") return false
  return /\(\s*mm\s*\)|\bin mm\b/i.test(p.description ?? "") || /(^|_)mm$/i.test(p.name)
}

/** A setting's label in the user's unit: "Width (mm)" -> "Width (in)". */
export const labelInUnits = (label: string, units: Units) => (units === "in" ? label.replace(/\(\s*mm\s*\)/gi, "(in)").replace(/\bin mm\b/gi, "in inches") : label)
