// Regression (E2E key hook): a part printed from filament slot 2+ (black, in the practice printer's slot 2) came out
// with ironing_type = top but no ;TYPE:Ironing moves. OrcaSlicer 2.4.2 reads per-filament ironing overrides
// (filament_ironing_*) for the ironing filament; our filament profiles didn't set them, and filament 2+ got padded
// values that turned ironing off. slotFilamentFile now writes them as nil (= use the process / intent values).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"

const ORCA = "/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer"
const OPENSCAD = "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD"
const home = mkdtempSync(join(tmpdir(), "printstudio-ironing-test-"))
process.env.PRINTSTUDIO_HOME = home

afterAll(async () => {
  const { stopPractice } = await import("../printer/practice")
  await stopPractice()
  rmSync(home, { recursive: true, force: true })
})

describe.skipIf(!existsSync(ORCA) || !existsSync(OPENSCAD))("Display ironing with the real OrcaSlicer CLI", () => {
  it("irons a part whose colour sits in slot 2", { timeout: 300_000 }, async () => {
    const machines = await import("../machines")
    const store = await import("../projects/store")
    const slicer = await import("./index")
    const m = machines.ensurePracticeMachine({ makeDefault: true })
    const slot = m.filaments.find((f) => f.slot >= 2)
    expect(slot, "the practice printer has a second slot").toBeTruthy()
    const p = await store.createProject("Ironing slot 2")
    await store.updateProject(p.id, { printer: m.id })
    const root = store.projectDir(p.id)
    mkdirSync(join(root, "parts"), { recursive: true })
    writeFileSync(join(root, "parts/main.scad"), `color("${slot!.colorHex}") cube([30, 20, 4]);\n`)
    await store.getProject(p.id)
    const r = await slicer.slicePart(p.id, "main", undefined, { intent: "display" })
    const g = readFileSync(join(root, r.gcodePath), "utf8")
    expect(g).toMatch(new RegExp(`^T${slot!.slot - 1}$`, "m")) // printed from that slot
    expect(g).toMatch(/^; ironing_type = top$/m)
    expect((g.match(/^;TYPE:Ironing/gm) ?? []).length).toBeGreaterThan(0)
    expect(r.preview?.issues.map((i) => i.code) ?? []).not.toContain("no_ironing_flat_top")
  })
})
