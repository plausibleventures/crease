import { describe, expect, it } from "vitest"
import { liftDark, partFace, previewParams, previewSource, showsFaceDown, turnedOverCamera } from "./preview"
import { paletteFor } from "../../shared/filament-tones"
import { showFaceYaw, turnZ } from "../../shared/assembly-art"
import type { Assembly } from "../../shared/types"

describe("dark parts in previews", () => {
  it("lifts dark colours held in variables, not text", () => {
    const out = previewSource(`body = "black";\ncolor(body) cube(1);\ntext("black");\nlabel = "Black";`, "/tmp")
    expect(out).toContain(`body = "#333333";`)
    expect(out).toContain(`text("black")`)
    expect(out).not.toContain(`"Black"`)
  })

  it("lifts black only a little, once, and keeps darker shades darker", () => {
    const out = previewSource(`color("black") cube(1);\ncolor(c = "#1a1a1a") cube(1);`, "/tmp")
    expect(out).toContain(`color("#333333")`)
    expect(out).toContain(`color(c = "#3c3c3c")`)
    expect(liftDark([0, 0, 0])).toEqual([51, 51, 51])
    expect(liftDark([79, 79, 79])![0]).toBeGreaterThanOrEqual(79) // no jump below the cut-off
    expect(liftDark([80, 80, 80])).toBeNull()
    expect(liftDark([0, 0, 128])).toBeNull() // navy keeps its hue
  })

  it("lifts a dark colour chosen in a setting", () => {
    expect(previewParams({ colour: "black", size: 10, label: "Hi" })).toEqual({ colour: "#333333", size: 10, label: "Hi" })
  })
})

describe("filament tones in previews", () => {
  it("draws screen primaries as PLA tones, in source and settings", () => {
    const out = previewSource(`color("blue") cube(1);\ncolor("#FF0000") cube(1);\nc = "navy";\ntext("blue");`, "/tmp")
    expect(out).toContain(`color("#2b5fd9")`)
    expect(out).toContain(`color("#d62839")`)
    expect(out).toContain(`c = "#1f2f6b"`)
    expect(out).toContain(`text("blue")`)
    expect(previewParams({ colour: "orange" })).toEqual({ colour: "#f26b1d" })
  })

  it("colours geometry without color() like the 3D viewer", () => {
    expect(partFace("Teal", "a")).toBe("#12a4a0")
    expect(partFace("#00f", "a")).toBe("#2b5fd9")
    expect(partFace("#000000", "a")).toBe("#333333")
    expect(partFace("white", "a")).toBe("#f5f5f5")
    expect(partFace(undefined, "lid")).toBe(paletteFor("lid"))
    expect(partFace(undefined, "lid", "#f5f5f5")).toBe("#f5f5f5") // no colour: the filament it prints in
    expect(partFace("teal", "lid", "#f5f5f5")).toBe("#12a4a0")
    expect(partFace("no-such-colour", "lid")).toBe(paletteFor("lid"))
  })
})

describe("face-down pieces", () => {
  const flat = [50, 40, 6]
  it("are marked, or flat, mirrored and said to be face down", () => {
    expect(showsFaceDown(`// @show: plate\ncube(1);`, null)).toBe(true)
    expect(showsFaceDown(`// printed face down, mirrored\nmirror([1, 0, 0]) logo();`, flat)).toBe(true)
    expect(showsFaceDown(`mirror([1, 0, 0]) half(); half();`, flat)).toBe(false) // a symmetric copy, no comment
    expect(showsFaceDown(`// face down\nmirror([1, 0, 0]) logo();`, [20, 20, 30])).toBe(false) // not flat
  })

  it("turn the camera over: same viewpoint, part flipped about Y", () => {
    expect(turnedOverCamera([55, 0, 25])).toEqual([235, 0, 155])
    expect(turnedOverCamera([0, 0, 0])).toEqual([180, 0, 180])
  })

  const asm = (rotate: [number, number, number]): Assembly =>
    ({ version: 1, name: "t", parts: [{ id: "logo", qty: 1 }, { id: "base", qty: 1 }], hardware: [], tools: [], consumables: [], steps: [], placements: [{ part: "logo", translate: [0, 0, 0], rotate }, { part: "base", translate: [0, 0, 0] }] }) as unknown as Assembly

  it("the default view turns round to a standing piece's show face", () => {
    expect(showFaceYaw(asm([90, 0, 0]), ["logo"])).toBe(180) // stood up with the show face to the back
    expect(showFaceYaw(asm([-90, 0, 0]), ["logo"])).toBe(0) // already facing the front
    expect(showFaceYaw(asm([90, 0, 90]), ["logo"])).toBe(270) // facing −X
    expect(showFaceYaw(asm([0, 0, 0]), ["logo"])).toBe(0) // lying flat
    expect(showFaceYaw(asm([90, 0, 0]), [])).toBe(0)
    const d = turnZ([0, -1, 0], 180)
    expect(d[0]).toBeCloseTo(0)
    expect(d[1]).toBeCloseTo(1)
  })
})
