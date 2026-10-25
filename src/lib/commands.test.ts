import { describe, expect, it, vi } from "vitest"
import { fuzzyScore } from "./fuzzy"

// commands.ts imports the store, which only needs window.location / addEventListener and localStorage
vi.stubGlobal("window", { location: { hash: "", protocol: "http:", host: "test" }, addEventListener: () => {} })
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} })
const { commandForKey } = await import("./commands")

const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}, target: EventTarget | null = null) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  target,
  ...mods,
})

describe("fuzzyScore", () => {
  it("matches substrings, word starts best", () => {
    expect(fuzzyScore("New project", "new")).toBeGreaterThan(fuzzyScore("Renew plan", "new")!)
    expect(fuzzyScore("Printer: Garage i7", "garage")).not.toBeNull()
  })
  it("matches letters in order and rejects the rest", () => {
    expect(fuzzyScore("New project", "nwprj")).not.toBeNull()
    expect(fuzzyScore("New project", "xyz")).toBeNull()
    expect(fuzzyScore("Slice", "")).toBe(0)
  })
  it("needs every word", () => {
    expect(fuzzyScore("Open Phone stand", "phone stand")).not.toBeNull()
    expect(fuzzyScore("Open Phone stand", "phone lamp")).toBeNull()
  })
})

describe("commandForKey", () => {
  it("maps the browser shortcuts (mac)", () => {
    expect(commandForKey(key("k", { metaKey: true }), false, true)).toBe("palette")
    expect(commandForKey(key("n", { metaKey: true }), false, true)).toBe("new-project")
    expect(commandForKey(key(",", { metaKey: true }), false, true)).toBe("settings")
    expect(commandForKey(key("o", { metaKey: true }), false, true)).toBe("open-library")
    expect(commandForKey(key("2", { metaKey: true }), false, true)).toBe("go-machines")
    expect(commandForKey(key("k", { ctrlKey: true }), false, true)).toBeNull()
  })
  it("uses Ctrl elsewhere", () => {
    expect(commandForKey(key("k", { ctrlKey: true }), false, false)).toBe("palette")
    expect(commandForKey(key("k", { metaKey: true }), false, false)).toBeNull()
  })
  it("leaves ⌘ shortcuts to the desktop menu", () => {
    expect(commandForKey(key("n", { metaKey: true }), true, true)).toBeNull()
    expect(commandForKey(key("?"), true, true)).toBe("shortcuts")
  })
  it("has no bare letter shortcuts (no more 'd' for theme)", () => {
    for (const k of "abcdefghijklmnopqrstuvwxyz") expect(commandForKey(key(k), false, true)).toBeNull()
  })
})
