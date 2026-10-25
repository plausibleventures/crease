// Blender part scripts (parts/<id>.blend.py): the settings block, its Customizer view, orientation, lib deps.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { parseCustomizer } from "./customizer"
import { readOrientation } from "./orient"
import { applyPyParameters, effectiveScript, isPartFile, partIdOf, pySettings, readPyOrientation, sculptLibDeps, sculptView, writePyOrientation } from "./sculpt"
import { declaredFront, showsFaceDown } from "./preview"

const SCRIPT = `# printstudio:sculpt
# @front: +y
# @show: plate
import printstudio as ps
from king_body import build

# --- settings ---
# [Size]
# How tall the king stands
height = 110  # [80:1:140] Height (mm)
crown_points = 5  # [3:1:9]
# [Style]
cape = True  # Cape
style = "gothic"  # [gothic, roman] Crown style
label = 'K#1'  # text with a hash
# --- end settings ---

height = 3  # not a setting: outside the block
build(height)
`

describe("settings block", () => {
  it("reads one setting per line between the markers", () => {
    expect(pySettings(SCRIPT).map((s) => [s.name, s.literal])).toEqual([
      ["height", "110"],
      ["crown_points", "5"],
      ["cape", "True"],
      ["style", '"gothic"'],
      ["label", "'K#1'"],
    ])
  })

  it("reads as Customizer parameters (ranges, groups, booleans, enums, descriptions)", () => {
    const p = parseCustomizer(sculptView(SCRIPT))
    expect(p.map((x) => x.name)).toEqual(["height", "crown_points", "cape", "style", "label"])
    expect(p[0]).toMatchObject({ type: "number", value: 110, min: 80, step: 1, max: 140, group: "Size", description: "How tall the king stands" })
    expect(p[2]).toMatchObject({ type: "boolean", value: true, group: "Style" })
    expect(p[3]).toMatchObject({ type: "enum", value: "gothic", options: ["gothic", "roman"] })
    expect(p[4]).toMatchObject({ type: "string", value: "K#1" })
  })

  it("writes values into the block only, keeping each line's annotation", () => {
    const { source, missing } = applyPyParameters(SCRIPT, { height: 125.5, cape: false, style: "roman", nope: 1 })
    expect(missing).toEqual(["nope"])
    expect(source).toContain("height = 125.5  # [80:1:140] Height (mm)")
    expect(source).toContain("cape = False  # Cape")
    expect(source).toContain('style = "roman"  # [gothic, roman] Crown style')
    expect(source).toContain("height = 3  # not a setting: outside the block") // untouched
    expect(source.split("\n").length).toBe(SCRIPT.split("\n").length) // tracebacks keep their line numbers
  })

  it("the script Blender runs has the saved values; unknown names are ignored", () => {
    const e = effectiveScript(SCRIPT, { crown_points: 7, other_part_setting: 2 })
    expect(e).toContain("crown_points = 7  # [3:1:9]")
    expect(effectiveScript(SCRIPT, null)).toBe(SCRIPT)
  })

  it("a script without a block has no settings", () => {
    expect(pySettings("import printstudio as ps\nx = 1\n")).toEqual([])
    expect(applyPyParameters("x = 1\n", { x: 2 }).missing).toEqual(["x"])
  })
})

describe("view hints and orientation", () => {
  it("passes @front / @show to the preview code", () => {
    const v = sculptView(SCRIPT)
    expect(declaredFront(v)).toBe("+y")
    expect(showsFaceDown(v, [10, 10, 10])).toBe(true)
  })

  it("set_orientation writes a documented line after the settings; the wrapper applies it", () => {
    const once = writePyOrientation(SCRIPT, [90, 0, 0])
    expect(readPyOrientation(once)).toEqual([90, 0, 0])
    expect(once.indexOf("print_orientation")).toBeGreaterThan(once.indexOf("# --- end settings ---"))
    const twice = writePyOrientation(once, [0, 180, 0])
    expect(twice.match(/print_orientation =/g)?.length).toBe(1)
    expect(readPyOrientation(twice)).toEqual([0, 180, 0])
    const wrapper = sculptView(twice, [{ file: "sculpt/k/abc/body-1.stl", color: null }, { file: "sculpt/k/abc/body-2.stl", color: "gold" }])
    expect(readOrientation(wrapper)).toEqual([0, 180, 0])
    expect(wrapper).toContain('import("sculpt/k/abc/body-1.stl", convexity = 10);')
    expect(wrapper).toContain('color("gold") import("sculpt/k/abc/body-2.stl", convexity = 10);')
    expect(wrapper).toMatch(/rotate\(print_orientation\)/)
  })

  it("`# @color:` colours bodies the script didn't colour", () => {
    const w = sculptView("# @color: red\n", [{ file: "a.stl", color: null }])
    expect(w).toContain('color("red") import("a.stl"')
  })
})

describe("files", () => {
  const root = mkdtempSync(join(tmpdir(), "ps-sculpt-"))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it("registers .scad and .blend.py, with ids from the name", () => {
    expect(isPartFile("king.blend.py")).toBe(true)
    expect(isPartFile("helper.py")).toBe(false)
    expect(partIdOf("parts/king.blend.py")).toBe("king")
    expect(partIdOf("parts/tray.scad")).toBe("tray")
  })

  it("follows the lib/ modules a script imports (recursively), not the standard ones", () => {
    mkdirSync(join(root, "parts"))
    mkdirSync(join(root, "lib"))
    writeFileSync(join(root, "parts", "king.blend.py"), SCRIPT)
    writeFileSync(join(root, "lib", "king_body.py"), "import math, robe\nfrom bpy import ops\n")
    writeFileSync(join(root, "lib", "robe.py"), "import king_body\n")
    writeFileSync(join(root, "lib", "unused.py"), "")
    expect(sculptLibDeps(join(root, "parts", "king.blend.py"), root).map((f) => f.slice(root.length + 1))).toEqual(["lib/king_body.py", "lib/robe.py"])
  })
})
