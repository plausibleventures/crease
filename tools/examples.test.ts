import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"

// The example build packs in examples/ (tools/make-examples.ts) must stay valid packs with no private data.
const home = mkdtempSync(join(tmpdir(), "ps-examples-test-"))
process.env.PRINTSTUDIO_HOME = home
afterAll(() => rmSync(home, { recursive: true, force: true }))

const EXAMPLES = join(import.meta.dirname, "..", "examples")
const packs = readdirSync(EXAMPLES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) =>
    readdirSync(join(EXAMPLES, d.name))
      .filter((f) => f.endsWith(".buildpack.zip"))
      .map((f) => join(EXAMPLES, d.name, f)),
  )

describe("example build packs (R21)", () => {
  it("exist", () => expect(packs.length).toBeGreaterThanOrEqual(2))
  it.each(packs)("%s verifies and carries no private data", async (file) => {
    const { verifyPack } = await import("../server/pack/index")
    const { manifest, files } = verifyPack(readFileSync(file))
    expect(manifest.project.license).toMatch(/Crease repository/)
    expect(manifest.gcode).toEqual([])
    const all = [...files.values()].map((b) => b.toString("latin1")).join("\n")
    expect(all).not.toMatch(/\/Users\/|\/home\/|\/var\/folders|ps-examples|sk-ant-/)
  })
})
