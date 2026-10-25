import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Machine } from "../../shared/types"

const mk = (id: string, name: string, bed: number, slots: number, colours: string[]): Machine => ({
  id,
  name,
  model: name,
  slicerProfile: id,
  buildVolumeMm: [bed, bed, 250],
  nozzleMm: 0.4,
  maxNozzleC: 300,
  filamentSlots: slots,
  filaments: colours.map((c, i) => ({ slot: i + 1, colorName: c, colorHex: "#000000", material: "PLA", loaded: true })),
  filamentsConfirmed: true,
  tolerances: { slidingFitMm: null, pressFitMm: null, holeCompensationMm: null },
  connection: { type: "none" },
  enabled: true,
  isDefault: id === "mini",
})
const machines = [mk("mini", "Mini", 180, 1, ["White"]), mk("i7", "Garage i7", 260, 4, ["White", "Black", "Red", "Blue"])]
vi.mock("../machines", () => ({
  getMachines: () => machines,
  getMachine: (id?: string) => machines.find((m) => m.id === id) ?? machines[0],
}))

const { coloursUsed, machineChecklist, machineLine } = await import("./machines")
const { deps } = await import("./deps")

let root = ""
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mach-"))
  mkdirSync(join(root, "parts"), { recursive: true })
  mkdirSync(join(root, "build"), { recursive: true })
  Object.assign(deps, {
    projectDir: () => root,
    getProject: async () => ({ id: "p", printer: "mini", parts: [{ id: "main", file: "parts/main.scad", qty: 1, colors: [] }] }),
  })
})
const scad = (src: string) => writeFileSync(join(root, "parts", "main.scad"), src)
const size = (s: [number, number, number]) => writeFileSync(join(root, "build", "main.render.json"), JSON.stringify({ stats: { sizeMm: s } }))

describe("target machine checks", () => {
  it("finds literal colours in a part", () => {
    expect(coloursUsed('color("Red") cube(1); color( "white" ) sphere(1); colour("Red") x();')).toEqual(["Red", "white"])
  })

  it("flags colours the target hasn't loaded and names the machine that has them", async () => {
    scad('color("White") a(); color("Red") b(); color("Blue") c();')
    size([60, 40, 30])
    const items = await machineChecklist("p")
    expect(items.some((i) => /uses 3 colours but Mini holds 1/.test(i))).toBe(true)
    expect(items.some((i) => /Red, Blue, not loaded on Mini; Garage i7 has them loaded/.test(i))).toBe(true)
  })

  it("flags a part too big for the target and suggests a machine it fits", async () => {
    scad("cube(200);")
    size([200, 120, 40])
    const items = await machineChecklist("p")
    expect(items.some((i) => /doesn't fit Mini's 180×180×250 mm bed; it would fit Garage i7/.test(i))).toBe(true)
  })

  it("is quiet when the part fits and its colours are loaded", async () => {
    scad('color("white") cube(10);')
    size([50, 50, 20])
    expect(await machineChecklist("p")).toEqual([])
  })

  it("describes a machine in one line", () => {
    expect(machineLine(machines[1])).toMatch(/Garage i7 \[i7\]: bed 260×260×250 mm .*4 colour slots loaded with White PLA, Black PLA, Red PLA, Blue PLA, not connected/)
  })
})
