import { describe, expect, it } from "vitest"
import type { FilamentSlot } from "../../shared/types"
import { colorValueToHex, mapColorsToSlots } from "./colors"

const slots: FilamentSlot[] = [
  { slot: 1, colorName: "White", colorHex: "#f5f5f5", material: "PLA", loaded: true },
  { slot: 2, colorName: "Black", colorHex: "#1a1a1a", material: "PLA", loaded: true },
  { slot: 3, colorName: "Red", colorHex: "#d32f2f", material: "PLA", loaded: true },
  { slot: 4, colorName: "Blue", colorHex: "#1e5bd8", material: "PLA", loaded: true },
]

describe("colour values", () => {
  it("parses names, hex and vectors as OpenSCAD echoes them", () => {
    expect(colorValueToHex('"Red"')).toBe("#ff0000")
    expect(colorValueToHex('"#f00"')).toBe("#ff0000")
    expect(colorValueToHex('"#d32f2f80"')).toBe("#d32f2f")
    expect(colorValueToHex("[1, 0.5, 0]")).toBe("#ff8000")
    expect(colorValueToHex("[0, 0, 1, 0.5]")).toBe("#0000ff")
    expect(colorValueToHex("undef")).toBeNull()
  })
})

describe("mapColorsToSlots", () => {
  it("matches by name, then nearest colour", () => {
    const m = mapColorsToSlots(['"white"', '"red"', "[0.1, 0.35, 0.85]", '"black"'], slots, 4)
    expect(m.map((x) => x.slot)).toEqual([1, 3, 4, 2])
  })
  it("rejects colours that aren't loaded, with the loaded list", () => {
    expect(() => mapColorsToSlots(['"orange"', '"white"'], slots, 4)).toThrow(/"orange".*isn't loaded.*slot 1: White/)
  })
  it("rejects two different colours on one slot and too many colours", () => {
    expect(() => mapColorsToSlots(['"red"', '"darkred"'], slots, 4)).toThrow(/both print with slot 3/)
    expect(() => mapColorsToSlots(['"white"', '"red"', '"blue"'], slots, 2)).toThrow(/3 colours.*2 filament slots/)
  })
})
