// R22: Customizer overrides (.studio/params) are per idea: switching ideas swaps them, a new idea starts with a copy,
// compare builds each side with its own, and the old flat (per project) layout is migrated to every idea.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const home = mkdtempSync(join(tmpdir(), "ps-idea-params-"))
process.env.PRINTSTUDIO_HOME = home
afterAll(() => rmSync(home, { recursive: true, force: true }))

const OPENSCAD = "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD"

const store = await import("./store")
const rev = await import("./revision")

describe("per-idea Customizer overrides", () => {
  let id = ""
  let root = ""
  let first = ""
  beforeAll(async () => {
    const p = await store.createProject("Idea params")
    id = p.id
    root = store.projectDir(id)
    first = await store.currentBranch(id)
  })

  it("a new idea starts with a copy; each idea keeps its own; switching swaps them", async () => {
    expect(rev.savePartOverrides(root, "main", { width: 50 })).toBe(true)
    expect(rev.currentIdeaAt(root)).toBe(first)
    const { branch } = await store.createVariantBranch(id)
    expect(rev.currentIdeaAt(root)).toBe(branch)
    expect(rev.partOverridesAt(root, "main")).toEqual({ width: 50 }) // copied from the idea it came from
    rev.savePartOverrides(root, "main", { width: 80, height: 20 })
    expect(rev.partOverridesAt(root, "main")).toEqual({ height: 20, width: 80 })
    expect(rev.partOverridesAt(root, "main", first)).toEqual({ width: 50 }) // the other idea is untouched

    await store.switchToBranch(id, first)
    expect(rev.partOverridesAt(root, "main")).toEqual({ width: 50 })
    await store.switchToBranch(id, branch)
    expect(rev.partOverridesAt(root, "main")).toEqual({ height: 20, width: 80 })
    expect(rev.partsWithOverrides(root, first)).toEqual(["main"])
    await store.switchToBranch(id, first)
  }, 60_000)

  it("an idea with no saved overrides doesn't pick up another idea's last render", async () => {
    mkdirSync(join(root, "build"), { recursive: true })
    writeFileSync(join(root, "build", "lid.render.json"), JSON.stringify({ params: { width: 99 } }))
    expect(rev.partOverridesAt(root, "lid")).toBeNull()
  })

  it.skipIf(!existsSync(OPENSCAD))("compare builds each side with its own idea's overrides", async () => {
    const { compareIdeas } = await import("./compare")
    const c = await compareIdeas(id, first, "variant-1")
    expect(c.a.params.main).toMatchObject({ width: 50 })
    expect(c.b.params.main).toMatchObject({ width: 80, height: 20 })
    expect(c.a.parts.find((p) => p.id === "main")?.sizeMm?.[0]).toBeCloseTo(50, 0)
    expect(c.b.parts.find((p) => p.id === "main")?.sizeMm?.[0]).toBeCloseTo(80, 0)
    expect(c.diff.params).toContainEqual(expect.objectContaining({ partId: "main", name: "width", a: 50, b: 80 }))
  }, 180_000)
})

describe("migrating the old per-project layout", () => {
  it("every idea gets a copy of the flat overrides; the flat files go", async () => {
    const p = await store.createProject("Old params")
    const root = store.projectDir(p.id)
    const first = await store.currentBranch(p.id)
    await store.createVariantBranch(p.id) // variant-1 (no overrides yet)
    await store.switchToBranch(p.id, first)
    // what an older version of the app left behind
    rmSync(join(root, ".studio", "params"), { recursive: true, force: true })
    mkdirSync(join(root, ".studio", "params"), { recursive: true })
    writeFileSync(join(root, ".studio", "params", "main.json"), JSON.stringify({ params: { width: 33 } }))
    expect(rev.partOverridesAt(root, "main")).toEqual({ width: 33 })
    expect(rev.partOverridesAt(root, "main", "variant-1")).toEqual({ width: 33 })
    expect(readdirSync(join(root, ".studio", "params")).sort()).toEqual([encodeURIComponent(first), "variant-1"].sort())
    // after the migration each idea changes on its own
    await store.switchToBranch(p.id, "variant-1")
    rev.savePartOverrides(root, "main", { width: 44 })
    expect(rev.partOverridesAt(root, "main", first)).toEqual({ width: 33 })
  }, 60_000)
})
