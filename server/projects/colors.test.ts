import { afterAll, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { partDesignColors, sourceColors } from "./colors"

const root = mkdtempSync(join(tmpdir(), "printstudio-colors-test-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
mkdirSync(join(root, "parts"))

describe("design colours", () => {
  it("reads named color() calls, skipping comments and vectors", () => {
    const src = `// color("red") in a comment\n/* color("blue") */\ncolor("black") cube(1);\ncolor(c = "#FFFFFF") sphere(1);\ncolor([1,0,0]) cube(2);`
    expect(sourceColors(src)).toEqual(["black", "#FFFFFF"])
  })

  it("the source's colour wins over project.json, as in the slicer (the Overview said White for a black design)", () => {
    writeFileSync(join(root, "parts", "logo.scad"), `color("black") cube(10);`)
    expect(partDesignColors(root, { id: "logo", file: "parts/logo.scad", qty: 1, colors: [] })).toEqual(["black"])
    expect(partDesignColors(root, { id: "logo", file: "parts/logo.scad", qty: 1, colors: ["white"] })).toEqual(["black"])
  })

  it("an uncoloured source uses the declared colours, else none (the first loaded filament)", () => {
    writeFileSync(join(root, "parts", "plain.scad"), `cube(10);`)
    expect(partDesignColors(root, { id: "plain", file: "parts/plain.scad", qty: 1, colors: ["red"] })).toEqual(["red"])
    expect(partDesignColors(root, { id: "plain", file: "parts/plain.scad", qty: 1, colors: [] })).toEqual([])
    expect(partDesignColors(root, { id: "gone", file: "parts/gone.scad", qty: 1, colors: [] })).toEqual([])
  })
})
