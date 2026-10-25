import { describe, expect, it } from "vitest"
import { plainWords } from "./plain"

describe("plainWords (Beginner mode: no file names, no raw variable names)", () => {
  it("rewrites the server's staleness reasons", () => {
    expect(plainWords("assembly.json changed")).toBe("the assembly plan changed")
    expect(plainWords("main: parts/main.scad changed since it was sliced")).toBe("the main design changed since it was sliced")
    expect(plainWords("lib/params.scad changed")).toBe("a shared design file changed")
    expect(plainWords("pen_holder's Customizer values changed (wall_thickness, hole_d)")).toBe("the pen holder's sizes or options changed")
    expect(plainWords("Customizer values changed (scale_percent)")).toBe("sizes or options changed")
    expect(plainWords("the design changed since it was sliced")).toBe("the design changed since it was sliced")
    expect(plainWords("imports/x/model.stl is missing")).toBe("a design file is missing")
  })
})
