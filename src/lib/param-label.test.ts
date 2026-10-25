import { describe, expect, it } from "vitest"
import { humanParamName, paramLabel } from "./param-label"

describe("Customizer labels", () => {
  it("reads common suffixes as words", () => {
    expect(humanParamName("box_d")).toBe("Box depth")
    expect(humanParamName("box_h")).toBe("Box height")
    expect(humanParamName("box_w")).toBe("Box width")
    expect(humanParamName("lid_t")).toBe("Lid thickness")
    expect(humanParamName("knuckle_r")).toBe("Knuckle radius")
    expect(humanParamName("arm_len")).toBe("Arm length")
  })
  it("a round thing's _d is its diameter", () => {
    expect(humanParamName("hole_d")).toBe("Hole diameter")
    expect(humanParamName("pot_top_d")).toBe("Pot top diameter")
    expect(humanParamName("screw_d")).toBe("Screw diameter")
  })
  it("keeps plain names and single letters readable", () => {
    expect(humanParamName("width")).toBe("Width")
    expect(humanParamName("d")).toBe("D")
    expect(humanParamName("rib_count")).toBe("Rib count")
    expect(humanParamName("n_holes")).toBe("Holes")
    expect(humanParamName("wallThickness")).toBe("Wall thickness")
  })
  it("prefers the description comment", () => {
    expect(paramLabel({ name: "box_d", description: "Depth (mm)" })).toBe("Depth (mm)")
    expect(paramLabel({ name: "box_d", description: "  " })).toBe("Box depth")
  })
})
