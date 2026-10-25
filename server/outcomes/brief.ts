// OWNER: feedback (R15). Plain-text summaries of print outcomes for the design agent (brief + read_print_outcomes),
// so "the last one was too tight" is grounded in what was measured.
import type { Machine, PrintOutcome } from "../../shared/types"
import { CATEGORY_LABEL } from "./propose"
import { projectOutcomes } from "./index"
import { timeCalibrationFor } from "./time"

const RATING: Record<PrintOutcome["rating"], string> = { great: "came out great", ok: "OK", problem: "had a problem", failed: "failed" }
const FIT: Record<string, string> = { too_tight: "too tight", just_right: "just right", too_loose: "too loose" }
const r2 = (v: number) => Math.round(v * 100) / 100
const mins = (s: number | null) => (s ? `${Math.round(s / 60)} min` : "?")

/** One outcome in a few plain lines. */
export function describeOutcome(o: PrintOutcome): string {
  const head = `- ${o.updatedAt.slice(0, 10)} ${o.partIds.join(", ") || "print"}${o.scope ? ` (${o.scope.intent}, ${o.scope.material})` : ""}: ${RATING[o.rating]}`
  const bits: string[] = []
  if (o.categories.length) bits.push(`problems: ${o.categories.map((c) => CATEGORY_LABEL[c]).join(", ")}`)
  for (const m of o.measurements) {
    if (m.measuredMm == null) continue
    const d = m.measuredMm - m.expectedMm
    bits.push(`${m.name} (${m.kind}) designed ${r2(m.expectedMm)} mm, measured ${r2(m.measuredMm)} mm (${d >= 0 ? "+" : ""}${r2(d)})`)
  }
  for (const f of o.fits) bits.push(`fit "${f.name}" ${FIT[f.result]}${f.clearanceMm != null ? ` at ${r2(f.clearanceMm)} mm/side` : ""}`)
  if (o.estimatedTimeS && o.actualDurationS) bits.push(`took ${mins(o.actualDurationS)} vs ${mins(o.estimatedTimeS)} estimated`)
  if (o.notes) bits.push(`notes: "${o.notes.replace(/\s+/g, " ").slice(0, 200)}"`)
  if (o.photos.length) bits.push(`${o.photos.length} photo${o.photos.length === 1 ? "" : "s"}`)
  if (o.lesson?.status === "accepted") bits.push(`lesson recorded: ${o.lesson.text}`)
  return bits.length ? `${head}; ${bits.join("; ")}` : head
}

/** The newest few outcomes of this project, for the session brief ("" when none). */
export function outcomesBrief(projectId: string, max = 3): string {
  try {
    const list = projectOutcomes(projectId).slice(0, max)
    return list.map(describeOutcome).join("\n")
  } catch {
    return ""
  }
}

/** Calibrated numbers for the target machine in one line ("" when nothing is calibrated yet). */
export function calibrationBrief(m: Machine): string {
  const t = m.tolerances
  const bits: string[] = []
  if (t.slidingFitMm != null) bits.push(`sliding fit ${t.slidingFitMm} mm/side`)
  if (t.pressFitMm != null) bits.push(`press fit ${t.pressFitMm} mm/side`)
  if (t.holeCompensationMm != null) bits.push(`holes +${t.holeCompensationMm} mm`)
  try {
    const cal = timeCalibrationFor({ machineId: m.id, nozzleMm: m.nozzleMm, material: "PLA", intent: "standard" })
    if (cal.factor != null) bits.push(`prints take about ${cal.factor}× the slicer's estimate (from ${cal.prints} print${cal.prints === 1 ? "" : "s"})`)
  } catch {
    /* no log */
  }
  return bits.join("; ")
}
