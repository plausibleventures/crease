import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import type { MotionCheck } from "../../shared/types"
import { deps } from "./deps"
import { assemblyStampAt, currentPartStampAt } from "../projects/revision"
import { writeGuideStamp, writeMotionRecord } from "../projects/validity"
import { doneChecklist, guideRequired, notePlan, notePreview, noteSliceResult } from "./done"

let root = ""
let parts: { id: string; file: string; qty: number; colors: string[] }[] = []
let assembly: unknown = null
const P = "done-test"
const okMotion = (): MotionCheck => ({ ok: true, status: "ok", incomplete: [], restCollisions: [], motions: [], combined: [], scope: { parts: [], hardware: [], skipped: [] }, notChecked: [], warnings: [], summary: "OK" })

/** A check report of the part as it is now (records the source stamp, like checkPart does). */
function check(partId: string, items: { rule: string; severity: string; measured?: string; message?: string }[]) {
  mkdirSync(join(root, ".studio", "checks"), { recursive: true })
  const source = currentPartStampAt(root, { id: partId, file: `parts/${partId}.scad` })
  writeFileSync(join(root, ".studio", "checks", `${partId}.json`), JSON.stringify({ partId, source, items: items.map((i) => ({ message: i.rule, measured: "", ...i })) }))
}
function part(id: string) {
  mkdirSync(join(root, "parts"), { recursive: true })
  writeFileSync(join(root, "parts", `${id}.scad`), "cube(1);")
  parts.push({ id, file: `parts/${id}.scad`, qty: 1, colors: [] })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "done-"))
  parts = []
  assembly = null
  Object.assign(deps, {
    projectDir: () => root,
    getProject: async () => ({ id: P, parts }),
    readAssembly: async () => ({ assembly }),
  })
})

describe("done checklist (soft, advisory)", () => {
  it("reports failing checks and print-in-place bodies without motions", async () => {
    part("main")
    check("main", [{ rule: "bodies", severity: "fail", measured: "3 bodies", message: "3 separate bodies" }])
    const items = await doneChecklist(P)
    expect(items.some((i) => i.startsWith("Failing check: main"))).toBe(true)
    expect(items.some((i) => /3 separate bodies.*motions/.test(i))).toBe(true)
  })

  it("flags a plan that promised no hardware when the shopping list has some", async () => {
    part("main")
    check("main", [])
    assembly = { parts: [{ id: "main" }], hardware: [{ id: "s", purchaseHint: "M3x10 screw" }], motions: [], steps: [] }
    notePlan(P, "Prints as one piece. No screws needed.")
    const items = await doneChecklist(P)
    expect(items.some((i) => /no hardware.*M3x10/.test(i))).toBe(true)
  })

  it("flags hardware in the plan that isn't on the shopping list", async () => {
    part("main")
    check("main", [])
    notePlan(P, "Sticks to the wall with adhesive strips")
    expect((await doneChecklist(P)).some((i) => /adhesive strips.*shopping list/.test(i))).toBe(true)
  })

  it("asks for check_motion after geometry changes, and a guide for moving designs", async () => {
    part("main")
    check("main", [])
    notePlan(P, "A spinning stand")
    assembly = { parts: [{ id: "main" }], hardware: [], motions: [{ id: "spin" }], steps: [] }
    expect((await doneChecklist(P)).some((i) => /haven't been checked for collisions/.test(i))).toBe(true)
    writeMotionRecord(root, assemblyStampAt(root, parts), okMotion())
    expect((await doneChecklist(P)).some((i) => /check_motion/.test(i))).toBe(false)
    writeFileSync(join(root, "parts", "main.scad"), "cube(2);")
    const items = await doneChecklist(P)
    expect(items.some((i) => /check_motion hasn't run since the last change: parts\/main.scad changed/.test(i))).toBe(true)
    expect(items.some((i) => /main hasn't been checked since its last change: parts\/main.scad changed/.test(i))).toBe(true)
    expect(items.some((i) => /guide/.test(i))).toBe(true)
  })

  it("is empty when everything is in order", async () => {
    part("main")
    check("main", [{ rule: "fits_bed", severity: "pass" }])
    notePlan(P, "A simple phone stand, no hardware")
    expect(await doneChecklist(P)).toEqual([])
  })
})

describe("guide required at the print boundary", () => {
  /** A guide built from the project as it is now (records the assembly stamp, like buildAssemblyGuide does). */
  const guide = () => {
    mkdirSync(join(root, "build"), { recursive: true })
    writeFileSync(join(root, "build", "assembly-guide.html"), "<html/>")
    writeGuideStamp(root, assemblyStampAt(root, parts))
  }

  it("leaves single-part, nothing-to-buy prints alone", async () => {
    part("main")
    notePlan(P, "One piece, nothing to buy")
    expect(await guideRequired(P)).toBeNull()
  })

  it("doesn't ask for a guide for independent pieces sharing a plate", async () => {
    part("test-a")
    part("test-b")
    part("test-c")
    notePlan(P, "Three 1-inch test pieces, printed together, nothing to buy")
    expect(await guideRequired(P)).toBeNull()
  })

  it("doesn't ask for a guide for a test plate even when assembly.json lists the pieces and has steps", async () => {
    part("test-a")
    part("test-b")
    part("test-c")
    notePlan(P, "Three 1-inch test pieces, printed together, nothing to buy")
    assembly = { parts: [{ id: "test-a" }, { id: "test-b" }, { id: "test-c" }], hardware: [], consumables: [], motions: [], steps: [{ n: 1, title: "Compare them" }] }
    expect(await guideRequired(P)).toBeNull()
    check("test-a", [])
    check("test-b", [])
    check("test-c", [])
    expect((await doneChecklist(P)).some((i) => /guide/.test(i))).toBe(false)
  })

  it("asks for a guide for separate pieces that share hardware or supplies", async () => {
    part("hook-a")
    part("hook-b")
    notePlan(P, "Two hooks")
    assembly = { parts: [{ id: "hook-a" }, { id: "hook-b" }], hardware: [], consumables: [{ id: "tape", name: "double-sided tape" }], motions: [], steps: [] }
    expect(await guideRequired(P)).toMatch(/hardware or supplies/)
  })

  it("asks for a guide for multi-part builds, then accepts a current one", async () => {
    part("base")
    part("lid")
    assembly = { parts: [{ id: "base" }, { id: "lid" }], placements: [{ part: "base", translate: [0, 0, 0] }], hardware: [], motions: [], steps: [] }
    expect(await guideRequired(P)).toMatch(/parts go together/)
    guide()
    expect(await guideRequired(P)).toBeNull()
  })

  it("treats a guide built before a shared lib change as out of date, and current again after undoing it", async () => {
    part("base")
    part("lid")
    mkdirSync(join(root, "lib"), { recursive: true })
    writeFileSync(join(root, "lib", "params.scad"), "wall = 2;")
    writeFileSync(join(root, "parts", "lid.scad"), "include <../lib/params.scad>\ncube(wall);")
    assembly = { parts: [{ id: "base" }, { id: "lid" }], placements: [{ part: "base", translate: [0, 0, 0] }], hardware: [], motions: [], steps: [{ n: 1 }] }
    guide()
    expect(await guideRequired(P)).toBeNull()
    writeFileSync(join(root, "lib", "params.scad"), "wall = 3;") // the parts' own files are untouched
    expect(await guideRequired(P)).toMatch(/out of date: lib\/params.scad changed/)
    writeFileSync(join(root, "lib", "params.scad"), "wall = 2;")
    expect(await guideRequired(P)).toBeNull()
  })

  it("asks when the plan mentions hardware even without assembly.json", async () => {
    part("main")
    notePlan(P, "Sticks to the wall with two adhesive strips")
    expect(await guideRequired(P)).toMatch(/adhesive strips/)
  })

  it("counts hardware the plan mentions even next to a negation elsewhere", async () => {
    part("main")
    notePlan(P, "The pipe snaps in from the front, no extra parts\nTwo M4 screws go through the back plate")
    expect(await guideRequired(P)).toMatch(/screws/)
  })

  it("asks when assembly.json lists hardware or motions", async () => {
    part("main")
    notePlan(P, "A rack")
    assembly = { parts: [{ id: "main" }], hardware: [{ id: "s" }], motions: [], steps: [] }
    expect(await guideRequired(P)).toMatch(/hardware/)
    assembly = { parts: [{ id: "main" }], hardware: [], motions: [{ id: "spin" }], steps: [] }
    expect(await guideRequired(P)).toMatch(/moving parts/)
  })
})

describe("slice preview items", () => {
  it("asks for a preview after each slice and lists unresolved quality warnings", async () => {
    part("main")
    check("main", [])
    notePlan(P, "A logo, nothing to buy")
    const issue = { code: "gap_infill_on_top", severity: "warn", message: "Ragged gap infill on the top face.", fix: "Use the Display intent" }
    noteSliceResult(P, { gcodePath: "build/main.gcode", intent: "standard", preview: { gcodePath: "build/main.gcode", issues: [issue] } })
    let items = await doneChecklist(P)
    expect(items.some((i) => /hasn't been reviewed since the last slice/.test(i))).toBe(true)
    expect(items.some((i) => /Quality warning.*Ragged gap infill.*Display intent/.test(i))).toBe(true)

    notePreview(P, "build/main.gcode", { gcodePath: "build/main.gcode", issues: [] })
    items = await doneChecklist(P)
    expect(items.some((i) => /hasn't been reviewed/.test(i))).toBe(false)
    expect(items.some((i) => /Quality warning/.test(i))).toBe(false)

    // look issues are raised even as info
    noteSliceResult(P, { gcodePath: "build/main.gcode", preview: { issues: [{ code: "no_edge_chamfer_display", severity: "info", message: "Show face has no edge chamfer." }] } })
    notePreview(P, "build/main.gcode", null)
    expect((await doneChecklist(P)).some((i) => /no edge chamfer/.test(i))).toBe(true)

    // re-slicing needs a fresh look
    noteSliceResult(P, { plates: [{ gcodePath: "build/main.gcode", preview: { issues: [] } }] })
    expect((await doneChecklist(P)).some((i) => /hasn't been reviewed/.test(i))).toBe(true)
  })
})
