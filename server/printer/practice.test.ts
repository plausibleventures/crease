import { afterAll, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// config.ts reads PRINTSTUDIO_HOME at import time. A legacy settings.json with four colours loaded: none of them may
// leak into the practice printer the user adds with only White.
const home = mkdtempSync(join(tmpdir(), "printstudio-practice-test-"))
process.env.PRINTSTUDIO_HOME = home
const colour = (slot: number, colorName: string, colorHex: string) => ({ slot, colorName, colorHex, material: "PLA", loaded: true })
writeFileSync(
  join(home, "settings.json"),
  JSON.stringify({
    printer: { host: "192.0.2.1", port: 7125, filamentsConfirmed: true, filaments: [colour(1, "White", "#fff"), colour(2, "Black", "#000"), colour(3, "Blue", "#00f"), colour(4, "Red", "#f00")] },
  }),
)

const machines = await import("../machines")
const printer = await import("./index")
const { stopPractice } = await import("./practice")

afterAll(async () => {
  await stopPractice()
  rmSync(home, { recursive: true, force: true })
})

const white = [{ slot: 1, colorName: "White", colorHex: "#f5f5f5", material: "PLA", loaded: true }]

describe("practice printer (Add a printer)", () => {
  it("is the built-in one (no address), with the form's own filaments", () => {
    const p = machines.ensurePracticeMachine({ fields: { name: "My practice", filaments: white, filamentSlots: 4, filamentsConfirmed: true } })
    expect(p).toMatchObject({ id: "practice-printer", isPractice: true, name: "My practice", connection: { type: "moonraker", host: "practice" } })
    expect(p.filaments).toEqual(white)
    // adding it again updates the same machine instead of making a second one
    const again = machines.ensurePracticeMachine({ fields: { name: "Practice printer" } })
    expect(again.id).toBe(p.id)
    expect(again.name).toBe("Practice printer")
    expect(again.filaments).toEqual(white)
    expect(machines.getMachines().filter((m) => m.isPractice)).toHaveLength(1)
  })

  it("its simulated CFS never overwrites the machine's slots: status reports the machine's own", async () => {
    const st = await printer.getPrinterStatus("practice-printer")
    expect(st.connected).toBe(true)
    expect(st.isMock).toBe(true)
    expect(st.filaments).toEqual(white)
    expect(machines.getMachine("practice-printer").filaments).toEqual(white)
  })
})
