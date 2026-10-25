import { afterAll, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// config.ts reads PRINTSTUDIO_HOME at import time: set it (and legacy single-printer files) first.
const home = mkdtempSync(join(tmpdir(), "printstudio-machines-test-"))
process.env.PRINTSTUDIO_HOME = home
mkdirSync(join(home, "printers"), { recursive: true })
writeFileSync(
  join(home, "settings.json"),
  JSON.stringify({ printer: { host: "192.168.1.50", port: 7125, filamentsConfirmed: true, filaments: [{ slot: 1, colorName: "Green", colorHex: "#00aa00", material: "PETG", loaded: true }] } }),
)
writeFileSync(
  join(home, "printers", "sparkx-i7.json"),
  JSON.stringify({ id: "sparkx-i7", name: "Creality SPARKX i7", machineName: "Garage i7", tolerances: { slidingFitMm: 0.25, pressFitMm: null, holeCompensationMm: null } }),
)
const m = await import("./machines")
const config = await import("./config")

afterAll(() => rmSync(home, { recursive: true, force: true }))

describe("machines", () => {
  it("migrates the single legacy printer on first read", () => {
    const [first, ...rest] = m.getMachines()
    expect(rest).toEqual([])
    expect(first).toMatchObject({
      id: "sparkx-i7",
      name: "Garage i7",
      slicerProfile: "sparkx-i7",
      isDefault: true,
      filamentsConfirmed: true,
      connection: { type: "moonraker", host: "192.168.1.50", port: 7125 },
      tolerances: { slidingFitMm: 0.25 },
    })
    expect(first.filaments[0].colorName).toBe("Green")
    expect(existsSync(join(home, "machines.json"))).toBe(true)
  })

  it("adds, defaults, updates and removes machines; Settings.printer mirrors the default", () => {
    const b = m.createMachine({ name: "Farm B", model: "Creality SPARKX i7", connection: { type: "moonraker", host: "10.0.0.2", port: 7125 } })
    expect(b.id).toBe("farm-b")
    expect(b.isDefault).toBe(false)
    expect(m.createMachine({ name: "Farm B" }).id).toBe("farm-b-2")
    m.setDefaultMachine("farm-b")
    expect(m.getDefaultMachine().id).toBe("farm-b")
    expect(config.getSettings().printer.host).toBe("10.0.0.2")
    config.saveSettings({ printer: { ...config.getSettings().printer, host: "10.0.0.3" } })
    expect(m.getMachine("farm-b").connection).toMatchObject({ host: "10.0.0.3" })
    expect(m.updateMachine("farm-b", { tolerances: { slidingFitMm: null, pressFitMm: 0.1, holeCompensationMm: null } }).tolerances.pressFitMm).toBe(0.1)
    m.deleteMachine("farm-b")
    expect(m.getDefaultMachine().id).not.toBe("farm-b")
    expect(m.getMachine("nope").isDefault).toBe(true) // unknown id -> default
  })

  it("adds the practice printer as its own machine, leaving real machines untouched", () => {
    const before = m.getMachine("sparkx-i7")
    expect(before.isDefault).toBe(true)
    const p = m.ensurePracticeMachine()
    expect(p).toMatchObject({ id: "practice-printer", name: "Practice printer", isPractice: true, isDefault: false })
    expect(m.getMachine("sparkx-i7")).toEqual(before) // name, address, default all unchanged
    // Nothing can turn the real machine into the practice one.
    m.updateMachine("sparkx-i7", { isPractice: true, connection: { type: "moonraker", host: "practice", port: 0 } } as never)
    config.saveSettings({ printer: { ...config.getSettings().printer, host: "practice" } })
    const after = m.getMachine("sparkx-i7")
    expect(after.isPractice).toBeFalsy()
    expect(after.connection).toMatchObject(before.connection)
    expect(after.name).toBe(before.name)
    expect(m.ensurePracticeMachine().id).toBe(p.id)
    expect(m.getMachines().filter((x) => x.isPractice)).toHaveLength(1)
  })
})

describe("practice printer on an empty home", () => {
  it("becomes the default when no other machine is", () => {
    for (const x of m.getMachines()) if (!x.isPractice) m.deleteMachine(x.id)
    m.updateMachine("practice-printer", { isDefault: false })
    expect(m.ensurePracticeMachine().isDefault).toBe(true)
  })
})
