import { describe, expect, it } from "vitest"
import type { CalibrationScope, PrintOutcome, PrintRecord } from "../../shared/types"
import { adjustTime, jobMaterial, timeCalibration, timeFactor, toleranceSuggestions, type TimeSample } from "./calibration"
import { proposeLesson } from "./propose"

const at = (i: number) => new Date(Date.UTC(2026, 9, 1 + i)).toISOString()
const s = (estimatedS: number, actualS: number, i: number): TimeSample => ({ estimatedS, actualS, at: at(i) })

describe("time factor", () => {
  it("is the median actual/estimated ratio (the i7 journal: 35→42 min, 16→21 min)", () => {
    const r = timeFactor([s(35 * 60, 42 * 60, 1), s(16 * 60, 21 * 60, 2), s(20 * 60, 25 * 60, 3)])
    expect(r.prints).toBe(3)
    expect(r.ignored).toBe(0)
    expect(r.factor).toBe(1.25) // median of 1.2, 1.31, 1.25
  })

  it("drops outliers: impossible ratios and ones far from the median (a paused or cold-start print)", () => {
    const r = timeFactor([
      s(1000, 1250, 1),
      s(1000, 1200, 2),
      s(1000, 1300, 3),
      s(1000, 2600, 4), // paused overnight-ish: 2.6, > 25% off the median
      s(1000, 100, 5), // aborted: 0.1, outside 0.5–3
      s(1000, 9000, 6), // clock problem: 9.0
    ])
    expect(r.factor).toBe(1.25)
    expect(r.prints).toBe(3)
    expect(r.ignored).toBe(3)
  })

  it("ignores tiny jobs, keeps the newest 10, and is null with nothing usable", () => {
    expect(timeFactor([s(30, 90, 1)])).toEqual({ factor: null, prints: 0, ignored: 0 })
    const old = Array.from({ length: 10 }, (_, i) => s(1000, 2000, i)) // ratio 2.0, older
    const recent = Array.from({ length: 10 }, (_, i) => s(1000, 1100, 20 + i)) // ratio 1.1, newer
    expect(timeFactor([...old, ...recent]).factor).toBe(1.1)
  })

  it("prefers prints of the same scope, falls back to the machine, and labels the adjusted estimate", () => {
    const scope: CalibrationScope = { machineId: "i7", nozzleMm: 0.4, material: "PLA", intent: "display" }
    const rec = (i: number, est: number, actual: number, sc: Partial<CalibrationScope>): PrintRecord => ({
      id: `p${i}`,
      projectId: "x",
      machineId: "i7",
      partIds: [],
      gcodeName: "a.gcode",
      printerFilename: null,
      startedAt: at(i),
      finishedAt: at(i),
      state: "complete",
      result: null,
      notes: null,
      estimatedTimeS: est,
      filamentG: null,
      actualDurationS: actual,
      scope: { ...scope, ...sc },
    })
    const log = [rec(1, 1000, 1300, {}), rec(2, 1000, 1000, { intent: "draft" }), rec(3, 1000, 1000, { intent: "draft" })]
    const exact = timeCalibration(log, scope)
    expect(exact).toMatchObject({ factor: 1.3, prints: 1, scope: "exact" })
    expect(adjustTime(35 * 60, exact)).toEqual({ estimatedTimeS: 2730, rawEstimateS: 2100, factor: 1.3, prints: 1, scope: "exact" })
    const other = timeCalibration(log, { ...scope, intent: "strong" })
    expect(other).toMatchObject({ factor: 1, scope: "machine", prints: 2, ignored: 1 }) // 1.3 is > 25% off the median
    expect(adjustTime(600, other)).toBeNull() // ≈ 1: nothing to adjust
    expect(timeCalibration(log, { ...scope, machineId: "other" })).toMatchObject({ factor: null, scope: "none" })
    // a cancelled print never counts
    expect(timeCalibration([{ ...rec(4, 1000, 300, {}), state: "cancelled" }], scope).factor).toBeNull()
  })
})

describe("tolerance suggestions", () => {
  const none = { slidingFitMm: null, pressFitMm: null, holeCompensationMm: null }
  const o = (p: Partial<Pick<PrintOutcome, "measurements" | "fits">>) => ({ measurements: [], fits: [], ...p })

  it("holes that print small suggest hole compensation (median, rounded to 0.05; typos ignored)", () => {
    const r = toleranceSuggestions(
      [
        o({ measurements: [{ name: "pen hole", kind: "hole", expectedMm: 10, measuredMm: 9.78 }] }),
        o({ measurements: [{ name: "screw", kind: "hole", expectedMm: 3.4, measuredMm: 3.15 }, { name: "typo", kind: "hole", expectedMm: 8, measuredMm: 0.8 }] }),
        o({ measurements: [{ name: "magnet", kind: "hole", expectedMm: 6, measuredMm: 5.8 }, { name: "width", kind: "outside", expectedMm: 50, measuredMm: 50.3 }] }),
      ],
      none,
    )
    expect(r).toEqual([expect.objectContaining({ key: "holeCompensationMm", current: null, suggested: 0.2, samples: 3 })])
    expect(r[0].reason).toMatch(/3 holes came out 0.2\d? mm small/)
    // already calibrated to that: nothing to suggest
    expect(toleranceSuggestions([o({ measurements: [{ name: "h", kind: "hole", expectedMm: 10, measuredMm: 9.8 }] })], { ...none, holeCompensationMm: 0.2 })).toEqual([])
  })

  it("fits: just right wins; too tight adds 0.1 to the tightest; too loose takes 0.05 off", () => {
    expect(toleranceSuggestions([o({ fits: [{ name: "lid", result: "too_tight", clearanceMm: 0.15 }] })], none)).toEqual([
      expect.objectContaining({ key: "slidingFitMm", suggested: 0.25 }),
    ])
    expect(
      toleranceSuggestions([o({ fits: [{ name: "lid", result: "too_tight", clearanceMm: 0.15 }] }), o({ fits: [{ name: "lid v2", result: "just_right", clearanceMm: 0.3 }] })], none),
    ).toEqual([expect.objectContaining({ key: "slidingFitMm", suggested: 0.3, samples: 2 })])
    expect(toleranceSuggestions([o({ fits: [{ name: "peg", kind: "press", result: "too_loose", clearanceMm: 0.1 }] })], none)).toEqual([
      expect.objectContaining({ key: "pressFitMm", suggested: 0.05 }),
    ])
    // no clearance recorded: the machine's current value was used
    expect(toleranceSuggestions([o({ fits: [{ name: "lid", result: "too_tight" }] })], { ...none, slidingFitMm: 0.2 })).toEqual([
      expect.objectContaining({ key: "slidingFitMm", current: 0.2, suggested: 0.3 }),
    ])
  })
})

describe("proposed lessons", () => {
  const base = { rating: "problem" as const, categories: [], measurements: [], fits: [], partIds: ["lid"], notes: null, scope: { machineId: "i7", nozzleMm: 0.4, material: "PLA", intent: "display" as const } }
  it("prefers measured numbers, then fits, then the failure category, then the user's words", () => {
    expect(proposeLesson({ ...base, measurements: [{ name: "pen", kind: "hole", expectedMm: 10, measuredMm: 9.75 }] })).toBe(
      "Holes print about 0.25 mm small in diameter in PLA with Display settings; make holes 0.25 mm bigger (lid)",
    )
    expect(proposeLesson({ ...base, fits: [{ name: "Lid on box", result: "too_tight", clearanceMm: 0.2 }] })).toMatch(/^Sliding fit "Lid on box" was too tight at 0.2 mm clearance per side in PLA/)
    expect(proposeLesson({ ...base, categories: ["didnt_stick"] })).toMatch(/^First layer didn't stick with Display settings \(lid\)/)
    expect(proposeLesson({ ...base, notes: "The hinge pin snapped off." })).toBe("The hinge pin snapped off")
    expect(proposeLesson({ ...base, rating: "great" })).toBeNull()
  })
})

describe("scope material", () => {
  it("uses the first used slot's material", () => {
    const machine = { filaments: [{ slot: 1, material: "pla", loaded: true }, { slot: 2, material: "PETG", loaded: true }] } as never
    expect(jobMaterial({ machine, filamentBySlot: [{ slot: 2, colorName: "", colorHex: "", grams: 3, mm: null, modelColors: [] }] })).toBe("PETG")
    expect(jobMaterial({ machine })).toBe("PLA")
  })
})
