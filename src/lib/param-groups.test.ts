import { describe, expect, it } from "vitest"
import type { ScadParameter } from "@shared/types"
import { groupParams, partsNamed, sharedLabel, splitUnit } from "./param-groups"

const n = (name: string, group?: string, file?: string): ScadParameter => ({ name, type: "number", value: 1, group, ...(file ? { file } : {}) })
const parts = [{ id: "pot" }, { id: "saucer", name: "Saucer" }]

describe("partsNamed", () => {
  it("matches a part by id or name, ignoring case and plurals", () => {
    expect(partsNamed("Pot", parts)).toEqual(["pot"])
    expect(partsNamed("Saucers", parts)).toEqual(["saucer"])
    expect(partsNamed("Fit between parts", parts)).toEqual([])
    expect(partsNamed("Pot and saucer", parts)).toEqual(["pot", "saucer"])
  })
  it("needs every word of a multi-word part", () => {
    expect(partsNamed("Lid", [{ id: "lid_hinge" }])).toEqual([])
    expect(partsNamed("Lid hinge", [{ id: "lid_hinge" }])).toEqual(["lid_hinge"])
  })
})

describe("groupParams", () => {
  const params = [n("drain", "Pot"), n("saucer_h", "Saucer", "lib/p.scad"), n("fit_gap", "Fit between parts", "lib/p.scad"), n("pot_h", "Pot", "lib/p.scad")]
  it("merges a part's own and shared settings of one section, the selected part's first", () => {
    const g = groupParams(params, parts, "saucer")
    expect(g.map((x) => [x.title, x.about])).toEqual([
      ["Saucer", "mine"],
      ["Fit between parts", "general"],
      ["Pot", "other"],
    ])
    expect(g[2].ps.map((p) => p.name)).toEqual(["drain", "pot_h"])
    expect(g[2].files).toEqual(["lib/p.scad"])
  })
  it("names untitled groups", () => {
    expect(groupParams([n("a"), n("b", undefined, "lib/x.scad")], parts, "pot").map((g) => g.title)).toEqual(["Settings", "Shared settings"])
  })
})

describe("shared settings", () => {
  const sh = (name: string, group: string, sharedWith?: string[]): ScadParameter => ({ ...n(name, group, "lib/p.scad"), ...(sharedWith ? { sharedWith } : {}) })
  it("a group says which parts it changes when every setting in it is shared by the same parts", () => {
    const g = groupParams([sh("fit_gap", "Fit between parts", ["pot", "saucer"]), sh("wall", "Fit between parts", ["pot", "saucer"]), n("drain", "Pot"), sh("pot_h", "Pot", ["pot", "saucer"])], parts, "pot")
    expect(g.map((x) => [x.title, x.sharedWith])).toEqual([
      ["Pot", null], // mixed: the rows say it
      ["Fit between parts", ["pot", "saucer"]],
    ])
  })
  it("names the parts in a few words", () => {
    const named = [{ id: "pot", name: "Pot" }, { id: "saucer", name: "Saucer" }, { id: "lid", name: "Lid" }, { id: "led", name: "LED strip" }, { id: "x" }]
    expect(sharedLabel(["pot", "saucer"], named)).toBe("Pot and saucer")
    expect(sharedLabel(["pot", "saucer", "led"], named)).toBe("Pot, saucer and LED strip")
    expect(sharedLabel(["pot", "saucer", "lid", "led"], named)).toBe("Pot, saucer and 2 more")
    expect(sharedLabel(["pot", "saucer", "lid", "led", "x"], named)).toBe("All 5 parts")
    expect(sharedLabel(["x", "pot"], named)).toBe("X and pot")
  })
})

describe("splitUnit", () => {
  it("moves a trailing unit out of the label", () => {
    expect(splitUnit("Pot height (mm)")).toEqual({ text: "Pot height", unit: "mm" })
    expect(splitUnit("Tilt (degrees)")).toEqual({ text: "Tilt", unit: "°" })
    expect(splitUnit("Gap in mm")).toEqual({ text: "Gap", unit: "mm" })
    expect(splitUnit("Number of holes")).toEqual({ text: "Number of holes", unit: null })
    expect(splitUnit("(mm)")).toEqual({ text: "(mm)", unit: null })
  })
})
