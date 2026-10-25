import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import type { Machine } from "../../shared/types"
import { CrealityStartError, crealitySlotId, crealityStartMessages, startViaCreality } from "./creality"
import { createSimPrinter } from "./sim"

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port
      s.close(() => resolve(p))
    })
  })

const machine = (port: number, wsPort: number): Machine => ({
  id: "sim",
  name: "Sim i7",
  model: "Creality SPARKX i7",
  slicerProfile: "sparkx-i7",
  buildVolumeMm: [260, 260, 255],
  nozzleMm: 0.4,
  maxNozzleC: 300,
  filamentSlots: 4,
  filaments: [],
  filamentsConfirmed: true,
  tolerances: { slidingFitMm: null, pressFitMm: null, holeCompensationMm: null },
  connection: { type: "moonraker", host: "127.0.0.1", port, crealityWsPort: wsPort, crealityStart: true },
  enabled: true,
  isDefault: true,
})

describe("Creality start messages", () => {
  it("single colour: opGcodeFile with the printer's full path", () => {
    expect(crealityStartMessages("/mnt/UDISK/printer_data/gcodes/a.gcode", null)).toEqual([
      { method: "set", params: { opGcodeFile: "printprt:/mnt/UDISK/printer_data/gcodes/a.gcode", enableSelfTest: 0 } },
    ])
  })
  it("CFS: colorMatch for the used slots, then multiColorPrint", () => {
    const m = crealityStartMessages("/g/a.gcode", [
      { slot: 1, material: "PLA", colorHex: "#FFFFFF" },
      { slot: 4, material: "PETG", colorHex: "#BE1C1C" },
    ])
    expect(m).toEqual([
      {
        method: "set",
        params: {
          colorMatch: {
            path: "/g/a.gcode",
            list: [
              { id: "T1A", type: "PLA", color: "#ffffff", boxId: 1, materialId: 0 },
              { id: "T1D", type: "PETG", color: "#be1c1c", boxId: 1, materialId: 3 },
            ],
          },
        },
      },
      { method: "set", params: { multiColorPrint: { gcode: "/g/a.gcode", enableSelfTest: 0 } } },
    ])
    expect([1, 4, 5, 8, 9].map(crealitySlotId)).toEqual(["T1A", "T1D", "T2A", "T2D", "T3A"])
  })
})

describe("starting through Creality's service (simulator only)", () => {
  let sim: Awaited<ReturnType<typeof createSimPrinter>>
  let port = 0
  let wsPort = 0
  beforeAll(async () => {
    wsPort = await freePort()
    sim = await createSimPrinter({ creality: true, crealityWsPort: wsPort, prepSeconds: 2, printSeconds: 5, hostname: "mock-creality" })
    await sim.app.listen({ port: 0, host: "127.0.0.1" })
    port = (sim.app.server.address() as { port: number }).port
  })
  afterAll(async () => {
    await sim.app.close()
  })

  it("the simulated printer starts the file and reports it running", async () => {
    writeFileSync(join(sim.gcodesDir, "cube.gcode"), "; test\nSTART_PRINT EXTRUDER_TEMP=220 BED_TEMP=55\nM8200 P S0\nT0\n;LAYER_CHANGE\nG1 X1\n")
    await startViaCreality(machine(port, wsPort), `/mnt/UDISK/printer_data/gcodes/cube.gcode`, [{ slot: 1, material: "PLA", colorHex: "#ffffff" }], { settleMs: 200 })
    expect(sim.crealityReceived.map((p) => Object.keys(p)[0])).toEqual(["colorMatch", "multiColorPrint"])
    const r = await fetch(`http://127.0.0.1:${port}/printer/objects/query?virtual_sdcard&print_stats`)
    const { result } = (await r.json()) as { result: { status: { virtual_sdcard: { is_active: boolean; file_position: number }; print_stats: { filename: string } } } }
    expect(result.status.virtual_sdcard.is_active).toBe(true)
    expect(result.status.print_stats.filename).toBe("cube.gcode")
    // preparing: still just after START_PRINT, before the first layer
    expect(result.status.virtual_sdcard.file_position).toBeLessThan(55)
  })

  it("nothing listening → CrealityStartError with notSent (safe to fall back to Moonraker)", async () => {
    const closed = await freePort()
    const err = await startViaCreality(machine(port, closed), "/x.gcode", null, { connectMs: 1500 }).catch((e) => e)
    expect(err).toBeInstanceOf(CrealityStartError)
    expect((err as CrealityStartError).notSent).toBe(true)
  })
})
