// P2-d (desktop E2E run #2): a plate of two single-colour parts in different colours swapped colour on every layer
// (4h06 / 58 g vs 1h56 / 43 g sliced separately). slicePlate now compares swaps / print by object / one plate per
// colour and keeps the cheapest safe one. Measured with the real OrcaSlicer CLI on the box-with-lid starter.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"

const ORCA = "/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer"
const OPENSCAD = "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD"
const home = mkdtempSync(join(tmpdir(), "printstudio-colorplan-test-"))
process.env.PRINTSTUDIO_HOME = home
// Imported only after PRINTSTUDIO_HOME points at the temp folder: a static import resolved ~/PrintStudio first.
const { chooseColorPlan } = await import("./index")

afterAll(async () => {
  const { stopPractice } = await import("../printer/practice")
  await stopPractice()
  rmSync(home, { recursive: true, force: true })
})

describe("chooseColorPlan", () => {
  const swaps = { strategy: "swaps" as const, ok: true, plates: 1, estimatedTimeS: 8100, filamentG: 56.4, colorChanges: 35 }
  it("picks print-by-object when it is safe and cheapest, in plain words", () => {
    const p = chooseColorPlan([
      swaps,
      { strategy: "by_object", ok: true, plates: 1, estimatedTimeS: 5100, filamentG: 48.3, colorChanges: 1 },
      { strategy: "per_colour", ok: true, plates: 2, estimatedTimeS: 5030, filamentG: 48.1, colorChanges: 0 },
    ])
    expect(p.chosen).toBe("by_object") // 70 s quicker on two plates isn't worth clearing the bed
    expect(p.summary).toMatch(/^Printing them one colour at a time saves 50 min and 8 g/)
  })
  it("falls back to one plate per colour when printing by object isn't safe", () => {
    const p = chooseColorPlan([
      swaps,
      { strategy: "by_object", ok: false, reason: '"tall" is too tall, and collisions will be caused.' },
      { strategy: "per_colour", ok: true, plates: 2, estimatedTimeS: 5000, filamentG: 48, colorChanges: 0 },
    ])
    expect(p.chosen).toBe("per_colour")
    expect(p.summary).toMatch(/2 plates, one per colour/)
    expect(p.summary).toMatch(/wasn't possible: "tall" is too tall/)
  })
  it("keeps the swaps when nothing else is cheaper", () => {
    const p = chooseColorPlan([
      { ...swaps, estimatedTimeS: 1000 },
      { strategy: "by_object", ok: false, reason: "too close" },
      { strategy: "per_colour", ok: true, plates: 2, estimatedTimeS: 950, filamentG: 50, colorChanges: 0 },
    ])
    expect(p.chosen).toBe("swaps")
    expect(p.summary).toMatch(/^Kept one plate that swaps colour on every layer \(35 swaps\)/)
  })
})

describe.skipIf(!existsSync(ORCA) || !existsSync(OPENSCAD))("colour plan with the real OrcaSlicer CLI", () => {
  async function setup(name: string, write: (root: string, hex: (slot: number) => string) => void, starter?: string) {
    const machines = await import("../machines")
    const store = await import("../projects/store")
    const m = machines.ensurePracticeMachine({ makeDefault: true })
    const hex = (slot: number) => m.filaments.find((f) => f.slot === slot)!.colorHex
    const p = starter ? await store.createProjectFromStarter(starter, name) : await store.createProject(name)
    await store.updateProject(p.id, { printer: m.id })
    const root = store.projectDir(p.id)
    mkdirSync(join(root, "parts"), { recursive: true })
    if (!starter) rmSync(join(root, "parts/main.scad"), { force: true })
    write(root, hex)
    await store.getProject(p.id)
    return { id: p.id, root, m }
  }

  it("box + lid in two colours: prints by object (one swap) instead of swapping every layer", { timeout: 300_000 }, async () => {
    const { slicePlate } = await import("./index")
    const { id, root } = await setup(
      "Box two colours",
      (root, hex) => {
        for (const [part, slot] of [["base", 1], ["lid", 3]] as const) {
          const f = join(root, "parts", `${part}.scad`)
          writeFileSync(f, readFileSync(f, "utf8").replace(/^difference\(\) \{/m, `color("${hex(slot)}") difference() {`))
        }
      },
      join(__dirname, "../../resources/starters/box-with-lid"),
    )
    const r = await slicePlate(id)
    const opt = Object.fromEntries(r.colorPlan!.options.map((o) => [o.strategy, o]))
    console.log("[colour plan] box+lid", JSON.stringify(r.colorPlan))
    expect(opt.swaps.colorChanges).toBeGreaterThan(10)
    expect(opt.by_object.ok).toBe(true)
    expect(opt.by_object.colorChanges).toBe(1)
    expect(opt.per_colour.plates).toBe(2)
    expect(opt.by_object.estimatedTimeS!).toBeLessThan(opt.swaps.estimatedTimeS! * 0.8)
    expect(r.colorPlan!.chosen).toBe("by_object")
    expect(r.colorPlan!.summary).toMatch(/one colour at a time saves/)
    expect(r.plates).toHaveLength(1)
    expect(r.overrides?.print_sequence).toBe("by object")
    const g = readFileSync(join(root, "build/plate.gcode"), "utf8")
    expect(g).toMatch(/^; print_sequence = by object$/m)
    // the short lid first, the tall box last (only the last part may be taller than the gantry clearance)
    expect(g.indexOf("EXCLUDE_OBJECT_START NAME=lid")).toBeLessThan(g.indexOf("EXCLUDE_OBJECT_START NAME=base"))
    expect(readdirSync(join(root, "build")).filter((f) => f.startsWith(".plan-"))).toEqual([])
  })

  it("a real printer not yet checked for one-at-a-time printing gets one plate per colour", { timeout: 300_000 }, async () => {
    const { slicePlate } = await import("./index")
    const machines = await import("../machines")
    const store = await import("../projects/store")
    const { id, m } = await setup(
      "Box two colours unchecked",
      (root, hex) => {
        for (const [part, slot] of [["base", 1], ["lid", 3]] as const) {
          const f = join(root, "parts", `${part}.scad`)
          writeFileSync(f, readFileSync(f, "utf8").replace(/^difference\(\) \{/m, `color("${hex(slot)}") difference() {`))
        }
      },
      join(__dirname, "../../resources/starters/box-with-lid"),
    )
    const real = machines.createMachine({ name: "Garage i7", model: "Creality SPARKX i7", filaments: m.filaments, filamentSlots: m.filamentSlots, connection: { type: "none" } } as never)
    expect(real.isPractice).toBeFalsy()
    await store.updateProject(id, { printer: real.id })
    const r = await slicePlate(id)
    const opt = Object.fromEntries(r.colorPlan!.options.map((o) => [o.strategy, o]))
    expect(opt.by_object.ok).toBe(false)
    expect(opt.by_object.reason).toMatch(/hasn't been checked on this printer/)
    expect(r.colorPlan!.chosen).toBe("per_colour")
    expect(r.overrides?.print_sequence).toBeUndefined()
  })

  it("two big parts: no room to print them one by one, so one plate per colour", { timeout: 300_000 }, async () => {
    const { slicePlate } = await import("./index")
    const { id, root } = await setup("Two walls", (root, hex) => {
      writeFileSync(join(root, "parts/white.scad"), `color("${hex(1)}") cube([100, 100, 50]);\n`)
      writeFileSync(join(root, "parts/red.scad"), `color("${hex(3)}") cube([100, 100, 50]);\n`)
    })
    const r = await slicePlate(id)
    const opt = Object.fromEntries(r.colorPlan!.options.map((o) => [o.strategy, o]))
    console.log("[colour plan] walls", JSON.stringify(r.colorPlan))
    expect(opt.by_object.ok).toBe(false)
    expect(opt.by_object.reason).toMatch(/room for the print head/)
    expect(r.colorPlan!.chosen).toBe("per_colour")
    expect(r.plates.map((p) => p.gcodeName)).toEqual(["plate-1.gcode", "plate-2.gcode"])
    for (const p of r.plates) {
      expect(p.objects).toHaveLength(1)
      expect(p.preview?.gcodePath).toBe(p.gcodePath)
      const tools = new Set(readFileSync(join(root, p.gcodePath), "utf8").match(/^T\d+$/gm))
      expect(tools.size).toBe(1) // no swaps within a plate
    }
  })

  it("an explicit print_sequence skips the comparison", { timeout: 300_000 }, async () => {
    const { slicePlate } = await import("./index")
    const { id } = await setup("Forced swaps", (root, hex) => {
      writeFileSync(join(root, "parts/a.scad"), `color("${hex(1)}") cube([20, 20, 3]);\n`)
      writeFileSync(join(root, "parts/b.scad"), `color("${hex(3)}") cube([20, 20, 3]);\n`)
    })
    const r = await slicePlate(id, undefined, undefined, undefined, { overrides: { print_sequence: "by layer" } })
    expect(r.colorPlan).toBeUndefined()
    expect(r.plates).toHaveLength(1)
  })
})
