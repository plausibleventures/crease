import { describe, expect, it } from "vitest"
import { printFileName } from "./filename"

describe("print file name", () => {
  it("uses the project's current name, not its folder id", () => {
    expect(printFileName("Desk Hook v2", "plate.gcode")).toBe("desk-hook-v2_plate.gcode")
  })
  it("keeps only safe characters", () => {
    expect(printFileName("Pot & Pan (big)", "main-2.gcode")).toBe("pot-pan-big_main-2.gcode")
    expect(printFileName("!!!", "part.3mf")).toBe("project_part.3mf")
  })
})
