import { afterAll, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const home = mkdtempSync(join(tmpdir(), "printstudio-params-test-"))
process.env.PRINTSTUDIO_HOME = home
const { includedParameters } = await import("./index")
afterAll(() => rmSync(home, { recursive: true, force: true }))

describe("Customizer: parameters of included lib files (E2E #2 P3)", () => {
  it("lists include<>d project files' parameters with their file; not use<>, not outside files, not duplicates", async () => {
    const root = join(home, "proj")
    mkdirSync(join(root, "parts"), { recursive: true })
    mkdirSync(join(root, "lib"), { recursive: true })
    writeFileSync(join(root, "lib/params.scad"), '/* [Sizes] */\n// Wall thickness\nwall = 2; // [1:0.5:5]\n// Width\nwidth = 40;\ninclude <more.scad>\n')
    writeFileSync(join(root, "lib/more.scad"), "// Hole size\nhole_d = 5;\n")
    writeFileSync(join(root, "lib/helpers.scad"), "// Not shared\nunused = 3;\nmodule m() {}\n")
    const part = join(root, "parts/base.scad")
    writeFileSync(part, "include <../lib/params.scad>\nuse <../lib/helpers.scad>\ninclude <BOSL2/std.scad>\n// Width here\nwidth = 50;\ncube(width);\n")
    const ps = await includedParameters(part, root, new Set(["width"]))
    expect(ps.map((p) => [p.name, p.file, p.group ?? null])).toEqual([
      ["wall", "lib/params.scad", "Sizes"],
      ["hole_d", "lib/more.scad", null],
    ])
    expect(ps[0]).toMatchObject({ description: "Wall thickness", min: 1, max: 5 })
  })
})
