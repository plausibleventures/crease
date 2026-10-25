// UX round 2: adding a printer never changes the default silently; existing projects keep their printer.
import { afterAll, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const home = mkdtempSync(join(tmpdir(), "printstudio-machines-default-test-"))
process.env.PRINTSTUDIO_HOME = home
const m = await import("./machines")
const store = await import("./projects/store")
const config = await import("./config")

afterAll(() => rmSync(home, { recursive: true, force: true }))

const garage = { name: "Garage", model: "Creality SPARKX i7", connection: { type: "moonraker" as const, host: "192.0.2.9", port: 7125 } }

describe("default printer", () => {
  it("a fresh install prints on the practice printer, and new projects name it explicitly", async () => {
    expect(m.getMachines()).toEqual([])
    expect(m.getDefaultMachine()).toMatchObject({ id: "practice-printer", isPractice: true })
    const p = await store.createProject("Before any printer")
    expect(p.printer).toBe("practice-printer")
    expect(m.getMachine(p.printer).isPractice).toBe(true)
  })

  it("the first printer becomes the default; the practice printer is not saved", () => {
    const g = m.createMachine(garage)
    expect(g.isDefault).toBe(true)
    expect(m.getDefaultMachine().id).toBe("garage")
    expect(m.getMachines().map((x) => [x.id, x.isDefault])).toEqual([["garage", true]])
    // the legacy Settings.printer view follows the same default
    expect(config.getSettings().printer.host).toBe("192.0.2.9")
  })

  it("a second printer doesn't change the default by itself", () => {
    const attic = m.createMachine({ ...garage, name: "Attic" })
    expect(attic.isDefault).toBe(false)
    expect(m.getDefaultMachine().id).toBe("garage")
    m.deleteMachine("attic")
  })

  it("only an explicit request makes a new printer the default", () => {
    const shop = m.createMachine({ ...garage, name: "Shop", isDefault: true })
    expect(shop.isDefault).toBe(true)
    expect(m.getDefaultMachine().id).toBe("shop")
    expect(m.getMachines().filter((x) => x.isDefault).map((x) => x.id)).toEqual(["shop"])
  })

  it("changing the default pins projects that followed it, so they keep their printer", async () => {
    const p = await store.createProject("Old project")
    // an older project with no printer of its own (follows the default)
    const pf = join(store.projectDir(p.id), "project.json")
    writeFileSync(pf, JSON.stringify({ ...JSON.parse(readFileSync(pf, "utf8")), printer: "" }))
    const pinned = await store.pinProjectsToCurrentDefault()
    expect(pinned).toEqual([p.id])
    m.setDefaultMachine("garage")
    expect((await store.getProject(p.id)).printer).toBe("shop")
    // projects with their own printer are untouched
    expect((await store.getProject("before-any-printer")).printer).toBe("practice-printer")
  })
})
