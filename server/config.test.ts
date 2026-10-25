import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"

// config.ts creates its folders at import time: point it at a temp folder, never the user's data.
const tmp = mkdtempSync(join(tmpdir(), "printstudio-config-test-"))
process.env.PRINTSTUDIO_HOME = tmp
const { chooseStudioHome, STUDIO_HOME } = await import("./config")
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const home = "/Users/someone"
const has =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p)

describe("chooseStudioHome (the data folder after the Crease rename)", () => {
  it("PRINTSTUDIO_HOME wins", () => {
    expect(chooseStudioHome({ PRINTSTUDIO_HOME: "/tmp/x" }, home, has(join(home, "PrintStudio")))).toBe("/tmp/x")
    expect(STUDIO_HOME).toBe(tmp)
  })

  it("an existing install keeps ~/PrintStudio", () => {
    expect(chooseStudioHome({}, home, has(join(home, "PrintStudio")))).toBe(join(home, "PrintStudio"))
    expect(chooseStudioHome({}, home, has(join(home, "PrintStudio"), join(home, "Crease")))).toBe(join(home, "PrintStudio"))
  })

  it("a new install gets ~/Crease", () => {
    expect(chooseStudioHome({}, home, has())).toBe(join(home, "Crease"))
    expect(chooseStudioHome({ PRINTSTUDIO_HOME: "" }, home, has())).toBe(join(home, "Crease"))
  })
})
