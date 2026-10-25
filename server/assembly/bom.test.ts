import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Assembly } from "../../shared/types"
import { buildBom, readBin, readHave, setHave, setInBin } from "./bom"

const tmp = mkdtempSync(join(tmpdir(), "ps-bom-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const fixture = (): Assembly => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "parts-bin", "assembly.json"), "utf8"))
const US = { country: "US", stores: ["amazon-us" as const, "mcmaster" as const] }
const project = { name: "Bin", parts: [] }

describe("practical BOM (R17)", () => {
  it("separates printed, purchased, make-yourself, consumables and tools", () => {
    const a = fixture()
    a.hardware.push({ id: "hinge", type: "filament-offcut", qty: 2, size: "1.75x30" })
    a.steps[4].adds.push("hinge")
    a.tools.push({ id: "hex", type: "hex-key", name: "2.5 mm hex key", size: "2.5 mm" })
    const bom = buildBom({ project, assembly: a, sourcing: US, have: {}, bin: [] })
    const by = (c: string) => bom.items.filter((i) => i.category === c).map((i) => i.name)
    expect(by("printed")).toEqual(["Base", "Divider", "Lid"])
    expect(by("purchased")).toHaveLength(3)
    expect(by("make")).toEqual(["1.75 mm filament, 30 mm piece"])
    expect(by("consumable")).toEqual(["Superglue (CA)"])
    expect(by("tool")).toEqual(["2.5 mm hex key"])
    const make = bom.items.find((i) => i.category === "make")!
    expect(make.links).toEqual([])
    expect(make.note).toMatch(/^Cut 30 mm from your 1.75 mm filament \(2 pieces\)/)
  })

  it("shows pack size vs need and labels search links apart from verified listings", () => {
    const a = fixture()
    a.hardware[0].listings = [
      { store: "Amazon", title: "6x3 mm magnets, 50 pcs", url: "https://www.amazon.com/dp/X", price: "$9.99 / 50", packSize: 50, retrievedAt: "2026-10-01" },
    ]
    const bom = buildBom({ project, assembly: a, sourcing: US, have: {}, bin: [] })
    const magnet = bom.items.find((i) => i.key.startsWith("magnet:"))!
    expect(magnet.pack?.text).toBe("This listing is a pack of 50: you need 4 (46 spare)")
    expect(magnet.links[0]).toMatchObject({ kind: "listing", checkedAt: "2026-10-01", price: "$9.99 / 50" })
    expect(magnet.links.slice(1).every((l) => l.kind === "search" && l.label.startsWith("Search on "))).toBe(true)
    expect(magnet.links[1].label).toBe("Search on Amazon")
    expect(magnet.estCost).toEqual({ usd: 9.99, basis: "listing" })
    const feet = bom.items.find((i) => i.key.startsWith("rubber-foot:"))!
    expect(feet.pack?.text).toBe("Usually sold in packs of ~50: you need 4")
    expect(feet.links.every((l) => l.kind === "search")).toBe(true)
  })

  it("offers substitutions only when the assembly data gives them, plus fit notes", () => {
    const a = fixture()
    a.hardware.push({ id: "screw", type: "screw", qty: 4, size: "M3x12", head: "button", purchaseHint: "M3x12 button head screw" })
    a.steps[4].adds.push("screw")
    let bom = buildBom({ project, assembly: a, sourcing: US, have: {}, bin: [] })
    const screw = () => bom.items.find((i) => i.key === "screw:m3x12:button")!
    expect(screw().substitutes).toBeUndefined()
    expect(screw().fit?.[0]).toMatch(/M3 thread, 12 mm long measured under the head/)
    a.hardware.at(-1)!.substitutes = [{ size: "M3x10", note: "hole is 11 mm deep: still 4 threads engaged" }]
    a.hardware.at(-1)!.fit = "Clearance hole 3.4 mm, insert 4 mm deep"
    bom = buildBom({ project, assembly: a, sourcing: US, have: {}, bin: [] })
    expect(screw().substitutes).toEqual([{ size: "M3x10", note: "hole is 11 mm deep: still 4 threads engaged" }])
    expect(screw().fit?.[0]).toBe("Clearance hole 3.4 mm, insert 4 mm deep")
    expect(bom.items.find((i) => i.key.startsWith("magnet:"))!.fit?.[0]).toBe("6 mm across × 3 mm thick: has to match the pocket; bigger won't fit, smaller rattles")
  })

  it("persists 'already have' per project, pre-ticks parts-bin items, and totals what's left to buy", () => {
    const root = join(tmp, "proj")
    const binFile = join(tmp, "parts-bin.json")
    const a = fixture()
    const all = buildBom({ project, assembly: a, sourcing: US, have: readHave(root), bin: readBin(binFile) })
    expect(all.totals.toBuy).toBe(4) // magnets, pin, feet, glue
    expect(all.totals.estUsd).toBeGreaterThan(0)
    expect(all.priceNote).toMatch(/Rough US prices/)

    const magnetKey = all.items.find((i) => i.key.startsWith("magnet:"))!.key
    setHave(root, magnetKey, true)
    setInBin(binFile, { key: "consumable:superglueca", name: "Superglue (CA)" }, true)
    expect(readHave(root)).toEqual({ [magnetKey]: true })

    const next = buildBom({ project, assembly: a, sourcing: US, have: readHave(root), bin: readBin(binFile) })
    const glue = next.items.find((i) => i.category === "consumable")!
    expect(glue).toMatchObject({ have: true, haveSource: "bin", inBin: true })
    expect(next.items.find((i) => i.key === magnetKey)).toMatchObject({ have: true, haveSource: "project" })
    expect(next.totals.toBuy).toBe(2)
    expect(next.totals.have).toBe(2)
    expect(next.totals.estUsd!).toBeLessThan(all.totals.estUsd!)

    // a project "I need to buy it" overrides the bin; clearing goes back to the bin's answer
    setHave(root, "consumable:superglueca", false)
    expect(buildBom({ project, assembly: a, sourcing: US, have: readHave(root), bin: readBin(binFile) }).items.find((i) => i.category === "consumable")).toMatchObject({ have: false, haveSource: "project" })
    setHave(root, "consumable:superglueca", null)
    expect(buildBom({ project, assembly: a, sourcing: US, have: readHave(root), bin: readBin(binFile) }).items.find((i) => i.category === "consumable")!.have).toBe(true)

    // the same spec in another project (different id, other notes) is pre-ticked by the bin too
    setInBin(binFile, { key: magnetKey, name: "6x3 magnet" }, true)
    const other = fixture()
    other.hardware[0].id = "mag"
    other.hardware[0].notes = "different"
    other.steps.forEach((s) => (s.adds = s.adds.map((x) => (typeof x === "string" ? x : x.id === "magnet" ? { ...x, id: "mag" } : x))))
    const ob = buildBom({ project, assembly: other, sourcing: US, have: {}, bin: readBin(binFile) })
    expect(ob.items.find((i) => i.key === magnetKey)).toMatchObject({ have: true, haveSource: "bin" })
  })

  it("gives no typical-price estimate outside the US", () => {
    const bom = buildBom({ project, assembly: fixture(), sourcing: { country: "DE", stores: ["amazon-de"] }, have: {}, bin: [] })
    expect(bom.totals.estUsd).toBeNull()
    expect(bom.priceNote).toBeNull()
    expect(bom.items.find((i) => i.category === "purchased")!.links[0].label).toBe("Search on Amazon.de")
  })
})
