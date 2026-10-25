import { describe, expect, it } from "vitest"
import { printLine } from "./print-line"

describe("printLine", () => {
  it("names the plate of a multi-plate build, with progress and time left", () => {
    expect(printLine({ plate: 1, plates: 2, state: "printing", progress: 0.587, timeLeftS: 7140 })).toBe("Plate 1 printing · 59% · 1h 59m left")
  })
  it("leaves the plate out of a one-plate build", () => {
    expect(printLine({ plate: 1, plates: 1, state: "printing", progress: 0.1, timeLeftS: null })).toBe("Printing · 10%")
  })
  it("says when it is getting ready or paused", () => {
    expect(printLine({ plate: 2, plates: 3, state: "preparing", progress: 0, timeLeftS: 100 })).toBe("Plate 2 getting ready")
    expect(printLine({ plate: null, plates: 0, state: "paused", progress: 0.5, timeLeftS: 100 })).toBe("Paused · 50%")
  })
})
