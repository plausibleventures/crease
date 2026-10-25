import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { CAPABILITIES, PRINTER_FAMILIES, renderSupportDoc, supportFor, supportForMachine, supportHeadline } from "../../shared/printer-support"

describe("printer support matrix", () => {
  it("only the SPARKX i7 claims anything verified on real hardware", () => {
    for (const f of PRINTER_FAMILIES) {
      const verified = CAPABILITIES.filter((c) => f.caps[c.key].level === "verified")
      if (f.id === "sparkx-i7") expect(verified.length).toBeGreaterThan(0)
      else expect(verified, f.id).toEqual([])
      if (verified.length) expect(f.verifiedOn).toBeTruthy()
    }
  })

  it("every family has every capability with a note", () => {
    for (const f of PRINTER_FAMILIES) for (const c of CAPABILITIES) expect(f.caps[c.key].note.length, `${f.id}.${c.key}`).toBeGreaterThan(5)
  })

  it("matches models to families", () => {
    expect(supportFor({ model: "Creality SPARKX i7", vendor: "Creality", klipper: true }).id).toBe("sparkx-i7")
    expect(supportFor({ model: "Creality K2 Plus", vendor: "Creality", klipper: true }).id).toBe("creality-cfs")
    expect(supportFor({ model: "Creality K1 Max", vendor: "Creality", klipper: true }).id).toBe("creality-klipper")
    expect(supportFor({ model: "Bambu Lab X1 Carbon", vendor: "BBL", klipper: false }).id).toBe("bambu")
    expect(supportFor({ model: "Voron 2.4 350", vendor: "Voron", klipper: true }).id).toBe("klipper")
    expect(supportFor({ model: "Prusa MK4", vendor: "Prusa", klipper: false }).id).toBe("other")
    expect(supportFor({ model: "Mystery printer" }).id).toBe("other")
    expect(supportFor({ model: "Creality SPARKX i7", isPractice: true }).id).toBe("practice")
  })

  it("a generic profile downgrades slicing", () => {
    const s = supportFor({ model: "Acme Printomatic", slicerProfile: "generic" })
    expect(s.generic).toBe(true)
    expect(s.caps.slicing.level).toBe("untested")
  })

  it("saved machines on the network count as Klipper", () => {
    expect(supportForMachine({ model: "Acme Printomatic", connection: { type: "moonraker" } }).id).toBe("klipper")
    expect(supportForMachine({ model: "Acme Printomatic", connection: { type: "none" } }).id).toBe("other")
  })

  it("headlines", () => {
    const i7 = supportFor({ model: "Creality SPARKX i7" })
    expect(supportHeadline(i7, "network").text).toBe("Works: slicing ✓ · sending ✓ · colours ✓ · camera ✓ (verified on SPARKX i7)")
    expect(supportHeadline(i7, "network").tone).toBe("ok")
    expect(supportHeadline(i7, "none").text).toMatch(/^Slicing only — save the file and print from the printer's screen$/)
    const bambu = supportFor({ model: "Bambu Lab A1", klipper: false })
    expect(supportHeadline(bambu, "network").text).toMatch(/Slicing only.*can't connect/)
    const voron = supportFor({ model: "Voron 2.4", klipper: true })
    const h = supportHeadline(voron, "network")
    expect(h.text).toMatch(/^Works: slicing \? · sending ~ · camera ~ \(untested on this printer/)
    expect(h.tone).toBe("warn")
    expect(supportHeadline(supportFor({ model: "x", isPractice: true }), "practice").text).toMatch(/simulated: nothing really prints/)
  })

  it("docs/printer-support.md is generated from the data (run npx tsx tools/gen-printer-support.ts)", () => {
    const doc = readFileSync(join(__dirname, "../../docs/printer-support.md"), "utf8")
    expect(doc).toBe(renderSupportDoc())
  })
})
