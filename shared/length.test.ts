import { describe, expect, it } from "vitest"
import { fmtDims, fmtLen, fmtLenDelta, fromUnit, inchStep, isLengthParam, labelInUnits, lenNumber, parseLen, sliderRange, toUnit } from "./length"

describe("length formatter", () => {
  it("shows mm like the rest of the app", () => {
    expect(fmtLen(70, "mm")).toBe("70 mm")
    expect(fmtLen(2.4, "mm")).toBe("2.4 mm")
    expect(fmtLen(260.4, "mm")).toBe("260 mm")
    expect(fmtDims([300, 85, 86.1], "mm")).toBe("300 × 85 × 86.1 mm")
  })
  it("shows inches with sensible decimals", () => {
    expect(fmtLen(25.4, "in")).toBe("1 in")
    expect(fmtLen(70, "in")).toBe("2.76 in")
    expect(fmtLen(300, "in")).toBe("11.8 in")
    expect(fmtLen(2, "in")).toBe("0.079 in")
    expect(fmtDims([250, 250, 250], "in")).toBe("9.84 × 9.84 × 9.84 in")
    expect(fmtDims([25.4, 50.8], "in", false)).toBe("1 × 2")
  })
  it("signs changes", () => {
    expect(fmtLenDelta(2.5, "mm")).toBe("+2.5 mm")
    expect(fmtLenDelta(-25.4, "in")).toBe("−1 in")
    expect(fmtLenDelta(0.01, "mm")).toBe("0 mm")
  })
  it("never shows NaN", () => {
    expect(lenNumber(NaN, "in")).toBe("–")
  })
})

describe("parseLen", () => {
  it("reads a bare number in the user's unit", () => {
    expect(parseLen("70", "mm")).toBe(70)
    expect(parseLen("2.5", "in")).toBeCloseTo(63.5)
    expect(parseLen("2,5", "in")).toBeCloseTo(63.5)
  })
  it("reads inch fractions", () => {
    expect(parseLen("1/16", "in")).toBeCloseTo(1.5875)
    expect(parseLen("2 1/2", "in")).toBeCloseTo(63.5)
    expect(parseLen('2-1/2"', "mm")).toBeCloseTo(63.5)
    expect(parseLen("3/4 in", "mm")).toBeCloseTo(19.05)
  })
  it("honours a typed unit", () => {
    expect(parseLen("70 mm", "in")).toBe(70)
    expect(parseLen("7cm", "in")).toBe(70)
    expect(parseLen("1 inch", "mm")).toBeCloseTo(25.4)
  })
  it("rejects what isn't a length", () => {
    expect(parseLen("", "mm")).toBeNull()
    expect(parseLen("abc", "in")).toBeNull()
    expect(parseLen("1/0", "in")).toBeNull()
    expect(parseLen("-", "in")).toBeNull()
  })
})

describe("slider conversion", () => {
  it("leaves mm sliders alone", () => {
    expect(sliderRange({ min: 50, max: 120, step: 1 }, "mm")).toEqual({ min: 50, max: 120, step: 1, decimals: 0 })
  })
  it("picks readable inch steps", () => {
    expect(inchStep(1)).toBe(0.05)
    expect(inchStep(0.5)).toBe(0.02)
    expect(inchStep(0.2)).toBe(0.01)
    expect(inchStep(5)).toBe(0.25)
    expect(inchStep(1.5875)).toBe(0.05) // a 1/16" mm step lands on the nearest decimal step
    expect(inchStep(25.4)).toBe(1)
  })
  it("keeps the inch range inside the design's mm range", () => {
    const r = sliderRange({ min: 50, max: 120, step: 1 }, "in")
    expect(r.step).toBe(0.05)
    expect(r.decimals).toBe(2)
    expect(r.min).toBe(2) // 1.9685 rounded up
    expect(r.max).toBe(4.7) // 4.724 rounded down
    expect(fromUnit(r.min, "in")).toBeGreaterThanOrEqual(50)
    expect(fromUnit(r.max, "in")).toBeLessThanOrEqual(120)
  })
  it("round-trips mm -> in -> mm", () => {
    for (const mm of [0.4, 1.6, 2, 12, 63.5, 70, 85, 160, 250]) {
      expect(fromUnit(toUnit(mm, "in"), "in")).toBeCloseTo(mm, 2)
      expect(fromUnit(toUnit(mm, "mm"), "mm")).toBe(mm)
    }
  })
  it("rounds and clamps what goes back to the design", () => {
    expect(fromUnit(2.75, "in")).toBe(69.85)
    expect(fromUnit(10, "in", { min: 50, max: 120 })).toBe(120)
    expect(fromUnit(0.5, "in", { min: 50 })).toBe(50)
  })
  it("keeps a range narrower than one step usable", () => {
    const r = sliderRange({ min: 1.8, max: 2.4, step: 0.1 }, "in")
    expect(r.max).toBeGreaterThan(r.min)
  })
})

describe("length settings", () => {
  it("knows lengths by their (mm) note", () => {
    expect(isLengthParam({ type: "number", name: "width", description: "Width (mm)" })).toBe(true)
    expect(isLengthParam({ type: "number", name: "gap_mm" })).toBe(true)
    expect(isLengthParam({ type: "number", name: "count", description: "How many cables" })).toBe(false)
    expect(isLengthParam({ type: "number", name: "angle", description: "Lean angle (°)" })).toBe(false)
    expect(isLengthParam({ type: "string", name: "label_mm" })).toBe(false)
  })
  it("relabels in the user's unit", () => {
    expect(labelInUnits("Width (mm)", "in")).toBe("Width (in)")
    expect(labelInUnits("Width (mm)", "mm")).toBe("Width (mm)")
  })
})
