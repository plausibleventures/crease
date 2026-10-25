// U1 × U3: a fresh install has no saved printer, so slicing and printing use the unsaved practice printer. The print
// path still works: colours map to its slots, Print approves and prints, the overview follows the printer that is
// printing, and practice prints aren't rated. Practice printer only: nothing real.
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"

const home = mkdtempSync(join(tmpdir(), "ps-print-noprinter-"))
process.env.PRINTSTUDIO_HOME = home
process.env.PRACTICE_PRINT_SECONDS = "1"

const ORCA = "/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer"
const OPENSCAD = "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD"

const machines = await import("../machines")
const store = await import("../projects/store")
const printer = await import("../printer/index")
const approval = await import("../agent/approval")
const { projectOverview } = await import("../projects/overview")
const { stopPractice } = await import("../printer/practice")

afterAll(async () => {
  printer.stopPrinterPolling()
  await stopPractice()
  rmSync(home, { recursive: true, force: true })
})

describe("no saved printer", () => {
  it("the unsaved practice printer counts as practice (no rating) and can be looked up by id", () => {
    expect(machines.getMachines()).toEqual([])
    const def = machines.getDefaultMachine()
    expect(def.isPractice).toBe(true)
    expect(printer.machineById(def.id)?.name).toBe("Practice printer")
    expect(printer.machineById("removed-printer")).toBeUndefined()
    expect(printer.isPracticePrint({ machineId: def.id })).toBe(true)
  })

  it.skipIf(!existsSync(ORCA) || !existsSync(OPENSCAD))(
    "a Black template slices with the Black slot, Print approves and prints, the overview follows that printer",
    { timeout: 300_000 },
    async () => {
      printer.setApprovalHooks({ isApproved: approval.isApproved, approve: (id) => approval.setApproved(id, true) })
      const { slicePart } = await import("../slicer/index")
      const p = await store.createProjectFromStarter(join(__dirname, "../../resources/starters/phone-stand"), "Phone stand, no printer")
      const r = await slicePart(p.id, "stand")
      expect(r.filamentBySlot?.map((s) => s.colorName)).toEqual(["Black"])
      const { request } = await printer.createPrintRequest(p.id, r.gcodePath, "user")
      expect(request).toMatchObject({ needsApproval: true, designColors: ["black"] })
      const ok = await printer.answerPrintRequest(request.requestId, true, true, undefined, { approveDesign: true })
      expect(ok).toMatchObject({ ok: true, machineId: "practice-printer" })
      expect(approval.isApproved(p.id)).toBe(true)
      const o = await projectOverview(p.id)
      expect(o.printingOn).toEqual({ machineId: "practice-printer", name: "Practice printer" })
      expect(o.next.kind).toBe("printing")
      // UX round 2: the plate says "Practice", not "Printed"
      expect(o.plates[0].practice).toBe(true)
    },
  )
})
