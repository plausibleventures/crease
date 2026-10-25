// U2: slider (Customizer) changes become versions, one per settled burst; versions record their slider values, so
// "Go back" restores them and Compare builds each version with its own.
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const home = mkdtempSync(join(tmpdir(), "ps-param-versions-"))
process.env.PRINTSTUDIO_HOME = home
afterAll(() => rmSync(home, { recursive: true, force: true }))

const OPENSCAD = "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD"

const store = await import("./store")
const rev = await import("./revision")
const snap = await import("./param-snapshot")

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** What the Parameters panel does: note the edit, then save the new values. */
function slide(id: string, root: string, values: Record<string, number> | null, idleMs = 60_000) {
  store.noteParamEdit(id, store.currentParamSnapshot(id), idleMs)
  rev.savePartOverrides(root, "main", values)
}

describe("describeParamChange / trailer", () => {
  it("names what a burst changed", () => {
    expect(snap.describeParamChange({}, { main: { width: 90 } })).toBe("change width to 90")
    expect(snap.describeParamChange({ main: { back_angle: 60 } }, { main: { back_angle: 70 } })).toBe("change back angle to 70")
    expect(snap.describeParamChange({}, { main: { width: 90, height: 2 } })).toBe("change width and height")
    expect(snap.describeParamChange({}, { main: { a: 1, b: 2, c: 3, d: 4 } })).toBe("change a, b and 2 more")
    expect(snap.describeParamChange({ main: { width: 90 } }, {})).toBe("reset settings")
    expect(snap.describeParamChange({ main: { width: 90 } }, { main: { width: 90 } })).toBeNull()
  })

  it("reads the trailer back; garbage and old versions read as unknown", () => {
    const s = { main: { width: 90, label: "Hi", on: true } }
    expect(snap.parseParamsTrailer(`user: x\n\n${snap.paramsTrailer(s)}\n`)).toEqual(s)
    expect(snap.parseParamsTrailer(`user: x\n\n${snap.paramsTrailer({})}`)).toEqual({})
    expect(snap.parseParamsTrailer("user: x")).toBeNull()
    expect(snap.parseParamsTrailer("user: x\n\nStudio-Params: {not json")).toBeNull()
    expect(snap.parseParamsTrailer('Studio-Params: {"main":{"w":{"x":1}}}')).toEqual({})
  })
})

describe("slider versions", () => {
  let id = ""
  let root = ""
  const subjects = async () => (await store.listCheckpoints(id)).checkpoints.map((c) => c.message)

  beforeAll(async () => {
    const p = await store.createProject("Slider versions")
    id = p.id
    root = store.projectDir(id)
  })

  it("a settled burst of slider edits is one version named after the change", async () => {
    const n = (await subjects()).length
    slide(id, root, { width: 60 })
    slide(id, root, { width: 75 })
    slide(id, root, { width: 90 })
    expect((await subjects()).length).toBe(n) // still sliding: no version yet
    expect(await store.flushParamVersion(id)).toMatch(/^[0-9a-f]{40}$/)
    const s = await subjects()
    expect(s.length).toBe(n + 1)
    expect(s[0]).toBe("change width to 90")
    expect(await store.flushParamVersion(id)).toBeNull() // nothing pending
  })

  it("the version is made by itself after the sliders are still", async () => {
    const n = (await subjects()).length
    slide(id, root, { width: 100 }, 30)
    await wait(400)
    expect((await subjects()).length).toBe(n + 1)
  })

  it("a burst that ends where it started makes no version", async () => {
    const n = (await subjects()).length
    slide(id, root, { width: 101 })
    slide(id, root, { width: 100 })
    expect(await store.flushParamVersion(id)).toBeNull()
    expect((await subjects()).length).toBe(n)
  })

  it("Go back restores that version's values (and saves the current ones first)", async () => {
    const list = (await store.listCheckpoints(id)).checkpoints
    const at90 = list.find((c) => c.message === "change width to 90")!
    slide(id, root, { width: 120 }) // pending burst: saved as its own version before going back
    await store.restoreCheckpoint(id, at90.commit)
    expect(rev.partOverridesAt(root, "main")).toEqual({ width: 90 })
    const s = await subjects()
    expect(s[1]).toBe("change width to 120")
    expect(s[0]).toMatch(/^restore change width to 90/)
  })

  it("a version from before values were recorded keeps today's values", async () => {
    const first = (await store.listCheckpoints(id)).checkpoints.at(-1)!
    expect(first.message).toBe("create project")
    await store.restoreCheckpoint(id, first.commit)
    expect(rev.partOverridesAt(root, "main")).toEqual({ width: 90 })
  })

  it("a saved version records the values even when only files changed", async () => {
    await store.saveCheckpoint(id, "user: nothing new")
    expect(await store.commitWorkInProgress(id)).toBe(false)
    rev.savePartOverrides(root, "main", { width: 91 }) // e.g. the designer set a value: work in progress
    expect(await store.commitWorkInProgress(id)).toBe(true)
  })

  it.skipIf(!existsSync(OPENSCAD))("Compare builds each version with its own values", async () => {
    const { compareIdeas } = await import("./compare")
    const list = (await store.listCheckpoints(id)).checkpoints
    const a = list.find((c) => c.message === "change width to 90")!
    const b = list.find((c) => c.message === "change width to 120")!
    const c = await compareIdeas(id, a.commit, b.commit)
    expect(c.a.parts.find((p) => p.id === "main")?.sizeMm?.[0]).toBeCloseTo(90, 0)
    expect(c.b.parts.find((p) => p.id === "main")?.sizeMm?.[0]).toBeCloseTo(120, 0)
    expect(c.diff.params).toContainEqual(expect.objectContaining({ partId: "main", name: "width", a: 90, b: 120 }))
  }, 180_000)
})
