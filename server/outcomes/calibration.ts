// OWNER: feedback (R15). Calibration math from real prints: a per-machine time factor (actual vs estimated print
// time) and fit/tolerance suggestions from measured features. Pure functions (tested in calibration.test.ts) plus
// small readers over the print log. Scope = printer + nozzle + material + intent: what changes both.
import type {
  AdjustedTime,
  CalibrationScope,
  Machine,
  PrintJob,
  PrintOutcome,
  PrintRecord,
  TimeCalibration,
  ToleranceSuggestion,
} from "../../shared/types"

// ---------------------------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------------------------

/** The material a job prints with: its first used slot, else the first loaded filament, else PLA. */
export function jobMaterial(job: Pick<PrintJob, "filamentBySlot" | "machine">): string {
  const used = job.filamentBySlot?.find((s) => (s.grams ?? s.mm ?? 1) > 0)?.slot
  const fil = job.machine?.filaments ?? []
  const f = (used != null ? fil.find((x) => x.slot === used) : undefined) ?? fil.find((x) => x.loaded)
  return (f?.material || "PLA").toUpperCase()
}

export function scopeOfJob(job: PrintJob): CalibrationScope {
  return { machineId: job.machineId, nozzleMm: job.machine?.nozzleMm ?? 0.4, material: jobMaterial(job), intent: job.intent }
}

export const sameScope = (a: CalibrationScope | null | undefined, b: CalibrationScope) =>
  !!a && a.machineId === b.machineId && a.nozzleMm === b.nozzleMm && a.material.toUpperCase() === b.material.toUpperCase() && a.intent === b.intent

// ---------------------------------------------------------------------------------------------
// Time factor
// ---------------------------------------------------------------------------------------------

export interface TimeSample {
  estimatedS: number
  actualS: number
  at: string // when it finished (newest first wins)
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const n = s.length
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN
}

export const TIME_WINDOW = 10 // newest prints considered
const MIN_ESTIMATE_S = 60 // tiny jobs are dominated by heating/homing
const RATIO_RANGE: [number, number] = [0.5, 3] // outside: a stalled/aborted job or a clock problem
const MAX_DEVIATION = 0.25 // > 25% from the median of the window: outlier (paused, heated up from cold, ...)

/**
 * actual / estimated over the newest prints: drop impossible ratios, then (with 3+ samples) ratios more than 25%
 * from the median, and take the median of what's left. null factor = nothing usable.
 */
export function timeFactor(samples: TimeSample[]): Omit<TimeCalibration, "scope"> {
  const usable = samples
    .filter((s) => s.estimatedS >= MIN_ESTIMATE_S && s.actualS > 0)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, TIME_WINDOW)
  const ratios = usable.map((s) => s.actualS / s.estimatedS)
  let kept = ratios.filter((r) => r >= RATIO_RANGE[0] && r <= RATIO_RANGE[1])
  if (kept.length >= 3) {
    const m = median(kept)
    kept = kept.filter((r) => Math.abs(r - m) / m <= MAX_DEVIATION)
  }
  if (!kept.length) return { factor: null, prints: 0, ignored: ratios.length }
  return { factor: Math.round(median(kept) * 100) / 100, prints: kept.length, ignored: ratios.length - kept.length }
}

const sampleOf = (r: PrintRecord): TimeSample | null =>
  r.state === "complete" && r.estimatedTimeS && r.actualDurationS ? { estimatedS: r.estimatedTimeS, actualS: r.actualDurationS, at: r.finishedAt ?? r.startedAt } : null

/** Time calibration for a scope from a machine's print log: same scope first, else every print on the machine. */
export function timeCalibration(prints: PrintRecord[], scope: CalibrationScope): TimeCalibration {
  const onMachine = prints.filter((r) => r.machineId === scope.machineId)
  const exact = timeFactor(onMachine.filter((r) => sameScope(r.scope, scope)).map(sampleOf).filter((s): s is TimeSample => !!s))
  if (exact.factor != null) return { ...exact, scope: "exact" }
  const any = timeFactor(onMachine.map(sampleOf).filter((s): s is TimeSample => !!s))
  if (any.factor != null) return { ...any, scope: "machine" }
  return { factor: null, prints: 0, ignored: Math.max(exact.ignored, any.ignored), scope: "none" }
}

/** An estimate scaled by the calibration (null when uncalibrated or the factor is within 3% of 1). */
export function adjustTime(estimatedS: number | null | undefined, cal: TimeCalibration): AdjustedTime | null {
  if (!estimatedS || cal.factor == null || cal.scope === "none" || Math.abs(cal.factor - 1) < 0.03) return null
  return {
    estimatedTimeS: Math.round(estimatedS * cal.factor),
    rawEstimateS: estimatedS,
    factor: cal.factor,
    prints: cal.prints,
    scope: cal.scope,
  }
}

// ---------------------------------------------------------------------------------------------
// Tolerances
// ---------------------------------------------------------------------------------------------

const DEFAULT_CLEARANCE = { slidingFitMm: 0.2, pressFitMm: 0.1 } // printable-openscad defaults (per side)
const round05 = (v: number) => Math.round(v * 20) / 20
const mm = (v: number) => `${Math.round(v * 100) / 100} mm`

/**
 * Suggestions from measured features and fit tests:
 *  - holeCompensationMm: median of how much smaller holes came out than designed (diameter), ≥ 0.
 *  - slidingFitMm / pressFitMm: the clearance that was "just right"; else 0.1 more than the tightest "too tight";
 *    else 0.05 less than the loosest "too loose". A fit with no recorded clearance used the machine's current value
 *    (or the default).
 * Only suggestions that differ from the current value by ≥ 0.05 mm are returned.
 */
export function toleranceSuggestions(outcomes: Pick<PrintOutcome, "measurements" | "fits">[], current: Machine["tolerances"]): ToleranceSuggestion[] {
  const out: ToleranceSuggestion[] = []
  const holes = outcomes.flatMap((o) => o.measurements).filter((m) => m.kind === "hole" && m.measuredMm != null && m.expectedMm > 0)
  // Ignore wild entries (typos, a different feature): a hole more than 2 mm or 20% off isn't a tolerance problem.
  const shortfalls = holes.map((m) => m.expectedMm - (m.measuredMm as number)).filter((d, i) => Math.abs(d) <= Math.min(2, holes[i].expectedMm * 0.2))
  if (shortfalls.length) {
    const s = Math.max(0, round05(median(shortfalls)))
    if (Math.abs(s - (current.holeCompensationMm ?? 0)) >= 0.05) {
      const avg = shortfalls.reduce((a, b) => a + b, 0) / shortfalls.length
      out.push({
        key: "holeCompensationMm",
        current: current.holeCompensationMm,
        suggested: s,
        samples: shortfalls.length,
        reason:
          avg > 0
            ? `${shortfalls.length} hole${shortfalls.length === 1 ? "" : "s"} came out ${mm(avg)} small on average: make holes ${mm(s)} bigger`
            : `holes came out right or a little big: no extra hole size needed`,
      })
    }
  }
  for (const [kind, key] of [["sliding", "slidingFitMm"], ["press", "pressFitMm"]] as const) {
    const fits = outcomes.flatMap((o) => o.fits).filter((f) => (f.kind ?? "sliding") === kind)
    if (!fits.length) continue
    const base = current[key] ?? DEFAULT_CLEARANCE[key]
    const c = (f: (typeof fits)[number]) => (f.clearanceMm != null && isFinite(f.clearanceMm) ? f.clearanceMm : base)
    const right = fits.filter((f) => f.result === "just_right").map(c)
    const tight = fits.filter((f) => f.result === "too_tight").map(c)
    const loose = fits.filter((f) => f.result === "too_loose").map(c)
    let suggested: number
    let reason: string
    if (right.length) {
      suggested = round05(median(right))
      reason = `${right.length} ${kind} fit${right.length === 1 ? " was" : "s were"} just right at ${mm(suggested)} per side`
    } else if (tight.length) {
      suggested = round05(Math.max(...tight) + 0.1)
      reason = `${kind} fit${tight.length === 1 ? " was" : "s were"} too tight at ${mm(Math.max(...tight))} per side: try ${mm(suggested)}`
    } else {
      suggested = Math.max(0.05, round05(Math.min(...loose) - 0.05))
      reason = `${kind} fit${loose.length === 1 ? " was" : "s were"} too loose at ${mm(Math.min(...loose))} per side: try ${mm(suggested)}`
    }
    suggested = Math.min(1, Math.max(0, suggested))
    if (current[key] == null || Math.abs(suggested - (current[key] as number)) >= 0.05) {
      out.push({ key, current: current[key], suggested, samples: right.length + tight.length + loose.length, reason })
    }
  }
  return out
}
