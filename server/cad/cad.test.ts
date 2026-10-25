import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { ServerEvent } from "../../shared/types"

// PRINTSTUDIO_HOME must be set before server/config is imported.
const home = mkdtempSync(join(tmpdir(), "printstudio-cad-"))
process.env.PRINTSTUDIO_HOME = home
const OPENSCAD = "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD"

type Store = typeof import("../projects/store")
type Cad = typeof import("./index")
let store: Store
let cad: Cad
const events: ServerEvent[] = []

beforeAll(async () => {
  store = await import("../projects/store")
  cad = await import("./index")
  const { onEvent } = await import("../events")
  onEvent((e) => events.push(e))
})
afterAll(async () => {
  await cad.unwatchProject()
  rmSync(home, { recursive: true, force: true })
})

describe("customizer parsing", () => {
  it("parses ranges, enums, groups, hidden", async () => {
    const { parseCustomizer } = await import("./openscad")
    const ps = parseCustomizer(`/* [Size] */
// Width of thing
w = 10; // [1:100]
s = 0.4; // [0.2:0.1:2]
shape = "round"; // [round, square]
n = 20; // [10:Small, 20:Large]
flag = true;
label = "hi";
/* [Hidden] */
secret = 3;
module m() { inner = 4; }
after = 5;
`)
    expect(ps.map((p) => p.name)).toEqual(["w", "s", "shape", "n", "flag", "label"])
    expect(ps[0]).toMatchObject({ type: "number", min: 1, max: 100, group: "Size", description: "Width of thing" })
    expect(ps[1]).toMatchObject({ min: 0.2, step: 0.1, max: 2 })
    expect(ps[2]).toMatchObject({ type: "enum", options: ["round", "square"] })
    expect(ps[3]).toMatchObject({ type: "enum", options: [10, 20] })
    expect(ps[4]).toMatchObject({ type: "boolean", value: true })
    expect(ps[5]).toMatchObject({ type: "string", value: "hi" })
  })

  it("uses a trailing note as the description when there is no comment above (not a range)", async () => {
    const { parseCustomizer } = await import("./openscad")
    const ps = parseCustomizer(`box_w = 80;      // outside width (mm)
// Above wins
box_h = 40; // under
n = 3; // [1:6]
`)
    expect(ps.map((p) => p.description)).toEqual(["Outside width (mm)", "Above wins", undefined])
    expect(ps[2]).toMatchObject({ min: 1, max: 6 })
  })
})

describe.skipIf(!existsSync(OPENSCAD))("project + render + check", () => {
  let id: string
  it("creates a project with git and a starter part", async () => {
    const p = await store.createProject("Desk Cable Tray")
    id = p.id
    expect(id).toBe("desk-cable-tray")
    const dir = store.projectDir(id)
    expect(existsSync(join(dir, ".git"))).toBe(true)
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain("build/")
    expect(p.parts).toEqual([{ id: "main", file: "parts/main.scad", qty: 1, colors: [] }])
    expect((await store.createProject("Desk Cable Tray")).id).toBe("desk-cable-tray-2")
  })

  it("lists parameters", async () => {
    const ps = await cad.listParameters(id, "main")
    expect(ps.map((p) => p.name)).toEqual(["width", "depth", "height", "wall", "corner"])
  })

  it("renders STL + 5 PNGs, then serves from cache", async () => {
    const r = await cad.renderPart(id, "main")
    expect(r.error).toBeUndefined()
    expect(r.cached).toBe(false)
    expect(r.images.map((i) => i.view)).toEqual(["iso", "front", "top", "right", "bed"])
    const dir = store.projectDir(id)
    expect(statSync(join(dir, "build/main.stl")).size).toBeGreaterThan(1000)
    for (const v of ["iso", "front", "top", "right", "bed"]) {
      const png = readFileSync(join(dir, `renders/main-${v}.png`))
      expect(png.subarray(1, 4).toString()).toBe("PNG")
      expect(png.readUInt32BE(16)).toBe(800)
      expect(png.readUInt32BE(20)).toBe(600)
    }
    expect(r.stats?.sizeMm).toEqual([40, 30, 15])
    expect(r.stats?.manifold).toBe(true)
    expect(r.stats?.bodies).toBe(1)
    expect(r.stlUrl).toMatch(/^\/api\/projects\/desk-cable-tray\/artifacts\/build\/main\.stl\?v=/)
    expect(events.some((e) => e.type === "render.started")).toBe(true)
    const again = await cad.renderPart(id, "main")
    expect(again.cached).toBe(true)
    const withParams = await cad.renderPart(id, "main", { width: 60 })
    expect(withParams.cached).toBe(false)
    expect(withParams.stats?.sizeMm[0]).toBe(60)
  })

  it("checks the part", async () => {
    const rep = await cad.checkPart(id, "main")
    const by = Object.fromEntries(rep.items.map((i) => [i.rule, i.severity]))
    expect(by).toMatchObject({ manifold: "pass", fits_bed: "pass", bodies: "pass", first_layer: "pass", overhangs: "pass", tall_thin: "pass", estimates: "info" })
    expect(rep.summary).toBe("pass")
    expect(existsSync(join(store.projectDir(id), ".studio/checks/main.json"))).toBe(true)
    expect(events.some((e) => e.type === "check.done")).toBe(true)
  })

  it("flags oversize, floating bodies, overhangs, tall-thin", async () => {
    const dir = store.projectDir(id)
    writeFileSync(
      join(dir, "parts/bad.scad"),
      `cube([300, 10, 10]);\ntranslate([0, 50, 20]) cube([60, 60, 2]);\ntranslate([0,100,0]) cylinder(d=5, h=80);\n`,
    )
    const p = await store.getProject(id)
    expect(p.parts.map((pt) => pt.id)).toEqual(["main", "bad"])
    const rep = await cad.checkPart(id, "bad")
    const by = Object.fromEntries(rep.items.map((i) => [i.rule, i.severity]))
    expect(by).toMatchObject({ fits_bed: "fail", bodies: "fail", overhangs: "warn" })
    expect(rep.summary).toBe("fail")
  })

  it("reports OpenSCAD errors as a RenderResult error", async () => {
    writeFileSync(join(store.projectDir(id), "parts/broken.scad"), `cube([10,10,10]\n`)
    const r = await cad.renderPart(id, "broken")
    expect(r.error).toMatch(/ERROR|error/)
    expect(r.images).toEqual([])
  })

  it("watcher re-renders on change, keeping the part's Customizer values", async () => {
    await cad.watchProject(id)
    const dir = store.projectDir(id)
    const before = events.length
    // width = 60 was set as a Customizer value above: a file change must not drop it (E2E bug: 22 -> 18)
    const src = join(dir, "parts/main.scad")
    writeFileSync(src, readFileSync(src, "utf8").replace("depth = 30", "depth = 35"))
    // Wait for THIS change's render + its check (a late check.done from an earlier test must not end the wait).
    // If the watcher wasn't armed yet when we wrote, touch the file again.
    const seen = () => {
      const f = events.slice(before)
      const r = f.findIndex((e) => e.type === "render.done" && e.result.stats?.sizeMm[1] === 35)
      return r >= 0 && f.slice(r).some((e) => e.type === "check.done")
    }
    const deadline = Date.now() + 25000
    let retouched = false
    while (Date.now() < deadline && !seen()) {
      await new Promise((r) => setTimeout(r, 100))
      if (!retouched && Date.now() > deadline - 20000 && !events.slice(before).some((e) => e.type === "project.changed")) {
        writeFileSync(src, readFileSync(src, "utf8"))
        retouched = true
      }
    }
    const fresh = events.slice(before)
    expect(fresh.some((e) => e.type === "project.changed" && e.paths.includes("parts/main.scad"))).toBe(true)
    // the toolbar refetches job staleness on every source change
    expect(fresh.some((e) => e.type === "jobs.changed" && e.projectId === id)).toBe(true)
    const done = fresh.find((e) => e.type === "render.done" && e.result.stats?.sizeMm[1] === 35)
    expect(done && done.type === "render.done" && done.result.stats?.sizeMm.slice(0, 2)).toEqual([60, 35])
    // the check of the new STL is of those values too
    const check = fresh.slice(fresh.indexOf(done!)).find((e) => e.type === "check.done")
    expect(check && check.type === "check.done" && check.report.source?.params).toEqual({ width: 60 })
  }, 35000)

  it("Customizer values persist per part: plain renders and exports use them; {} clears them", async () => {
    const dir = store.projectDir(id)
    // saved per idea (R22): .studio/params/<idea>/<part>.json
    const idea = encodeURIComponent(await store.currentBranch(id))
    expect(JSON.parse(readFileSync(join(dir, ".studio/params", idea, "main.json"), "utf8"))).toEqual({ params: { width: 60 } })
    const before = events.length
    const plain = await cad.renderPart(id, "main") // e.g. a restore / toolbar Render: no params given
    expect(plain.stats?.sizeMm[0]).toBe(60)
    expect(events.slice(before).some((e) => e.type === "jobs.changed")).toBe(false) // nothing changed
    expect((await cad.partSource(id, "main")).params).toEqual({ width: 60 })
    const changed = events.length
    const reset = await cad.renderPart(id, "main", {})
    expect(reset.stats?.sizeMm[0]).toBe(40)
    expect(events.slice(changed).some((e) => e.type === "jobs.changed" && e.projectId === id)).toBe(true)
    expect((await cad.partSource(id, "main")).params).toBeUndefined()
    expect((await cad.renderPart(id, "main")).stats?.sizeMm[0]).toBe(40)
  }, 30000)

  it("checkpoints and lists", async () => {
    const commit = await store.saveCheckpoint(id, "agent: widen tray")
    expect(commit).toMatch(/^[0-9a-f]{40}$/)
    const list = await store.listProjects()
    const s = list.find((x) => x.id === id)!
    expect(s.thumbnailUrl).toMatch(/renders\/main-iso\.png/)
  })

  it("a restore re-renders with the saved Customizer values, so artifacts built with them read fresh (R07)", async () => {
    const dir = store.projectDir(id)
    await cad.unwatchProject(id) // drive the watcher's steps by hand (render, then check) so nothing races
    await cad.renderPart(id, "main", { width: 70 })
    await cad.checkPart(id, "main")
    const cp = await store.saveCheckpoint(id, "user: width 70")
    // an edit on disk (the watcher re-renders it), then restore the checkpoint (the route re-renders every part)
    const src = readFileSync(join(dir, "parts/main.scad"), "utf8")
    writeFileSync(join(dir, "parts/main.scad"), src.replace(/height\s*=\s*\d+/, "height = 9"))
    expect((await cad.renderPart(id, "main")).stats?.sizeMm[0]).toBe(70)
    await store.restoreCheckpoint(id, cp)
    const r = await cad.renderPart(id, "main") // what the watcher and the restore route call: no params given
    expect(r.stats?.sizeMm[0]).toBe(70)
    await cad.checkPart(id, "main") // the watcher checks after a successful render
    const { projectValidity } = await import("../projects/validity")
    const v = await projectValidity(id)
    expect(v.parts.main.overrides).toEqual({ width: 70 })
    expect([v.parts.main.render, v.parts.main.check].map((x) => [x.state, ...(x.reasons ?? [])])).toEqual([["fresh"], ["fresh"]])
  }, 60000)
})
