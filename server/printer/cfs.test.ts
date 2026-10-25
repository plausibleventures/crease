import { describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readdirSync, readFileSync } from "node:fs"
import { baseMaterial, CREALITY_MATERIALS, crealityFilamentId, gcodeSlotsUsed, materialForCode, parseBox, slotBlockers } from "./cfs"

// Trimmed from the real SPARKX i7 (fw 1.1.5.10) `box` object.
const box = {
  state: "connect",
  type: "CFS-lite",
  same_material: [
    ["001001", "0FFFFFF", ["T1A"], "PLA"],
    ["001001", "0000000", ["T1B"], "PLA"],
    ["001001", "01743ED", ["T1C"], "PLA"],
  ],
  T1: {
    state: "connect",
    color_value: ["0FFFFFF", "0000000", "01743ED", "none"],
    material_type: ["001001", "001001", "001001", "none"],
  },
  T2: { state: "None" },
}

describe("CFS box", () => {
  it("maps T1 A–D to slots 1–4 with colour, name and material; unset slots aren't loaded", () => {
    const slots = parseBox(box, 4, [{ slot: 2, colorName: "Jet black", colorHex: "#000000", material: "PLA", loaded: true }])!
    expect(slots.map((s) => [s.slot, s.colorHex, s.colorName, s.material, s.loaded])).toEqual([
      [1, "#ffffff", "White", "PLA", true],
      [2, "#000000", "Jet black", "PLA", true], // user's name kept: same colour
      [3, "#1743ed", "Blue", "PLA", true],
      [4, "#000000", "Not set", "unknown", false],
    ])
    expect(parseBox(undefined, 4)).toBeNull()
    expect(parseBox({ T1: { state: "None" } }, 4)).toBeNull()
  })

  it("finds the slots a G-code file uses and explains unset ones", () => {
    const f = join(mkdtempSync(join(tmpdir(), "cfs-")), "x.gcode")
    writeFileSync(f, "M8200 P S0\nT0\nG1 X1\nM8200 P S3\nM8200 L I3\nT3\n")
    expect(gcodeSlotsUsed(f)).toEqual([1, 4])
    const slots = parseBox(box, 4)!
    expect(slotBlockers([1, 4], slots)).toEqual([
      "Slot 4 isn't set up on the printer — choose its colour and material on the printer's screen, then try again.",
    ])
    expect(slotBlockers([1], slots)).toEqual([])
    expect(slotBlockers([1, 4], null)).toEqual([]) // printer doesn't report filaments: no check
  })

  it("maps Creality material codes (CFS 6-digit ↔ filament_id 5-digit)", () => {
    expect(materialForCode("001001")).toMatchObject({ material: "PLA", product: "Hyper PLA", verified: true })
    expect(materialForCode("01001")?.material).toBe("PLA")
    expect(materialForCode("006002")).toMatchObject({ material: "PETG", verified: false })
    expect(materialForCode("003001")?.material).toBe("ABS") // Hyper ABS (the old guess said PETG)
    expect(materialForCode("010001")?.material).toBe("TPU")
    expect(materialForCode("019001")?.material).toBe("ASA")
    expect(materialForCode("none")).toBeNull()
    expect(materialForCode("099999")).toBeNull()
    // only PLA has been seen on hardware
    expect(CREALITY_MATERIALS.filter((m) => m.verified).map((m) => m.id)).toEqual(["01001"])
  })

  it("writes the printer's own code, else the Creality default for the material", () => {
    expect(crealityFilamentId({ material: "PETG", materialCode: "006001" })).toBe("06001")
    expect(crealityFilamentId({ material: "PLA" })).toBe("01001")
    expect(crealityFilamentId({ material: "PETG" })).toBe("06002")
    expect(crealityFilamentId({ material: "Hyper ABS" })).toBe("03001")
    expect(crealityFilamentId({ material: "TPU" })).toBe("10001")
    expect(crealityFilamentId({ material: "ASA" })).toBe("19001")
    expect(crealityFilamentId({ material: "Wood" })).toBeNull()
    expect(crealityFilamentId(undefined)).toBe("01001")
  })

  it("names base materials", () => {
    expect(baseMaterial("Hyper PETG")).toBe("PETG")
    expect(baseMaterial("CR-PLA Matte")).toBe("PLA")
    expect(baseMaterial("Hyper PLA-CF")).toBe("PLA-CF")
    expect(baseMaterial("CR-Nylon")).toBe("PA")
    expect(baseMaterial("petg")).toBe("PETG")
    expect(baseMaterial("Wood")).toBeNull()
  })

  it("non-PLA slots read from the printer get their base material", () => {
    const slots = parseBox({ T1: { state: "connect", color_value: ["0FF0000", "000FF00"], material_type: ["006002", "010001"] } }, 2)!
    expect(slots.map((s) => [s.material, s.materialProduct, s.loaded])).toEqual([
      ["PETG", "Hyper PETG", true],
      ["TPU", "HP-TPU", true],
    ])
  })

  it("the table agrees with OrcaSlicer's Creality filament profiles when they're installed", () => {
    const dir = "/Applications/OrcaSlicer.app/Contents/Resources/profiles/Creality/filament"
    let files: string[]
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json"))
    } catch {
      return // OrcaSlicer not installed here
    }
    const seen = new Map<string, string[]>()
    for (const f of files) {
      try {
        const j = JSON.parse(readFileSync(join(dir, f), "utf8")) as { filament_id?: string; name?: string }
        if (j.filament_id && j.name) seen.set(j.filament_id, [...(seen.get(j.filament_id) ?? []), j.name])
      } catch {
        /* skip */
      }
    }
    for (const m of CREALITY_MATERIALS) {
      const names = seen.get(m.id)
      expect(names, m.id).toBeTruthy()
      expect(names!.some((n) => baseMaterial(n.split(" @")[0]) === m.material || n.includes(m.product.split(" ").pop()!)), `${m.id} ${m.product}: ${names}`).toBe(true)
    }
  })
})
