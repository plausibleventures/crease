// R23 end to end with OpenSCAD: STL/3MF/SCAD imports (units, licence/source, R09 paths, 3MF settings ignored) and
// applying an orientation suggestion through the part's .scad.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const home = mkdtempSync(join(tmpdir(), "printstudio-r23-"))
process.env.PRINTSTUDIO_HOME = home

type Store = typeof import("../projects/store")
type Cad = typeof import("./index")
type Imports = typeof import("./imports")
let store: Store
let cad: Cad
let imp: Imports
let id: string

beforeAll(async () => {
  store = await import("../projects/store")
  cad = await import("./index")
  imp = await import("./imports")
  id = (await store.createProject("Imports")).id
})
afterAll(async () => {
  await cad.unwatchProject()
  rmSync(home, { recursive: true, force: true })
})

/** Binary STL of an axis-aligned box. */
function boxStl(x: number, y: number, z: number): Buffer {
  const v = [
    [0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0],
    [0, 0, z], [x, 0, z], [x, y, z], [0, y, z],
  ]
  const f = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ]
  const b = Buffer.alloc(84 + f.length * 50)
  b.writeUInt32LE(f.length, 80)
  f.forEach((t, i) => t.forEach((vi, k) => v[vi].forEach((c, a) => b.writeFloatLE(c, 84 + i * 50 + 12 + k * 12 + a * 4))))
  return b
}

describe("STL import", () => {
  it("asks mm vs inch for a tiny part, records source + licence, wraps the mesh (not editable by parameters)", async () => {
    const ins = await imp.inspectImport(id, "Bracket Inch.stl", boxStl(2, 1, 0.5))
    expect(ins.kind).toBe("mesh")
    expect(ins.suggestedId).toBe("bracket-inch")
    expect(ins.units).toMatchObject({ known: null, ask: true, recommended: "inch" })
    expect(ins.sizeIfInch).toEqual([50.8, 25.4, 12.7])
    const r = await imp.commitImport(id, {
      token: ins.token,
      units: "inch",
      source: { kind: "web", url: "https://www.printables.com/model/123" },
      licence: "CC BY 4.0",
    })
    expect(r.files).toEqual(["parts/imported/bracket-inch.stl", "parts/imported/bracket-inch.json", "parts/imported/bracket-inch.scad"])
    expect(r.part.file).toBe("parts/imported/bracket-inch.scad")
    expect(r.part.imported).toMatchObject({ kind: "mesh", format: "stl", units: "inch", licence: "CC BY 4.0", source: { kind: "web", url: "https://www.printables.com/model/123" }, sizeMm: [50.8, 25.4, 12.7] })
    const dir = store.projectDir(id)
    expect(JSON.parse(readFileSync(join(dir, "parts/imported/bracket-inch.json"), "utf8")).licence).toBe("CC BY 4.0")
    const wrapper = readFileSync(join(dir, "parts/imported/bracket-inch.scad"), "utf8")
    expect(wrapper).toMatch(/printstudio:imported-mesh/)
    expect(wrapper).toMatch(/not reshape|can't reshape/)
    // registered and still there after a resync of parts/*.scad
    expect((await store.getProject(id)).parts.find((p) => p.id === "bracket-inch")?.imported?.kind).toBe("mesh")
    // only scale is a parameter
    expect((await cad.listParameters(id, "bracket-inch")).map((p) => p.name)).toEqual(["scale_percent"])
    const rr = await cad.renderPart(id, "bracket-inch")
    expect(rr.error).toBeUndefined()
    expect(rr.stats?.sizeMm).toEqual([50.8, 25.4, 12.7])
    const half = await cad.renderPart(id, "bracket-inch", { scale_percent: 50 })
    expect(half.stats?.sizeMm).toEqual([25.4, 12.7, 6.35])
    // the mesh is part of what the part is made from (render cache / validity)
    const before = await cad.sourceHash(join(dir, r.part.file), undefined, dir)
    writeFileSync(join(dir, "parts/imported/bracket-inch.stl"), boxStl(2, 1, 0.6))
    expect(await cad.sourceHash(join(dir, r.part.file), undefined, dir)).not.toBe(before)
  }, 60000)

  it("a normal-sized STL is millimetres without asking; an expired token is refused", async () => {
    const ins = await imp.inspectImport(id, "plate.stl", boxStl(60, 40, 3))
    expect(ins.units).toMatchObject({ ask: false, recommended: "mm" })
    await expect(imp.commitImport(id, { token: "nope", source: { kind: "self" }, licence: "" })).rejects.toMatchObject({ statusCode: 410 })
    const r = await imp.commitImport(id, { token: ins.token, source: { kind: "self" }, licence: "" })
    expect(r.part.imported).toMatchObject({ units: "mm", licence: "I made it", source: { kind: "self" } })
  })

  it("refuses non-geometry files", async () => {
    await expect(imp.inspectImport(id, "notes.txt", Buffer.from("hello"))).rejects.toMatchObject({ statusCode: 415 })
    await expect(imp.inspectImport(id, "x.stl", Buffer.from("solid x\nendsolid x\n"))).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe("3MF import", () => {
  it("reads mesh + metadata (licence, designer), applies transforms and units, ignores the 3MF's own settings", async () => {
    const { writeZip } = await import("../pack/zip")
    const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Title">Cable clip</metadata>
  <metadata name="Designer">Ada &amp; Co</metadata>
  <metadata name="LicenseTerms">CC BY-SA 4.0</metadata>
  <resources>
    <object id="1" type="model"><mesh>
      <vertices>
        <vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="10" y="5" z="0"/><vertex x="0" y="5" z="0"/>
        <vertex x="0" y="0" z="2"/><vertex x="10" y="0" z="2"/><vertex x="10" y="5" z="2"/><vertex x="0" y="5" z="2"/>
      </vertices>
      <triangles>
        <triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="3" v3="2"/><triangle v1="4" v2="5" v3="6"/><triangle v1="4" v2="6" v3="7"/>
        <triangle v1="0" v2="1" v3="5"/><triangle v1="0" v2="5" v3="4"/><triangle v1="1" v2="2" v3="6"/><triangle v1="1" v2="6" v3="5"/>
        <triangle v1="2" v2="3" v3="7"/><triangle v1="2" v2="7" v3="6"/><triangle v1="3" v2="0" v3="4"/><triangle v1="3" v2="4" v3="7"/>
      </triangles>
    </mesh></object>
    <object id="2" type="model"><components><component objectid="1" transform="2 0 0 0 2 0 0 0 2 5 5 0"/></components></object>
  </resources>
  <build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 100 100 0"/></build>
</model>`
    const zip = writeZip([
      { path: "[Content_Types].xml", data: Buffer.from("<Types/>") },
      { path: "3D/3dmodel.model", data: Buffer.from(model) },
      { path: "Metadata/project_settings.config", data: Buffer.from('{"nozzle_temperature": ["300"], "post_process": ["rm -rf ~"]}') },
    ])
    const ins = await imp.inspectImport(id, "clip.3mf", zip)
    expect(ins.format).toBe("3mf")
    expect(ins.units).toMatchObject({ known: "mm", ask: false })
    expect(ins.sizeIfMm).toEqual([20, 10, 4])
    expect(ins.metadata).toMatchObject({ title: "Cable clip", designer: "Ada & Co", licence: "CC BY-SA 4.0" })
    expect(ins.warnings.join(" ")).toMatch(/print settings .* were not used/)
    const r = await imp.commitImport(id, { token: ins.token, source: { kind: "web" }, licence: ins.metadata.licence! })
    expect(r.part.imported).toMatchObject({ format: "3mf", licence: "CC BY-SA 4.0", designer: "Ada & Co", title: "Cable clip" })
    expect(r.part.imported?.ignored?.[0]).toMatch(/print settings/)
    // nothing from the 3MF's settings lands in the project
    expect(existsSync(join(store.projectDir(id), "parts/imported/clip.config"))).toBe(false)
    const rr = await cad.renderPart(id, r.part.id)
    expect(rr.stats?.sizeMm).toEqual([20, 10, 4])
  }, 60000)

  it("rejects a damaged 3MF", async () => {
    await expect(imp.inspectImport(id, "bad.3mf", Buffer.from("PK not really"))).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe("SCAD import", () => {
  it("BOSL2 files import editable and render with the bundled BOSL2", async () => {
    const src = `include <BOSL2/std.scad>\n/* [Size] */\nsize = 12; // [5:40]\ncuboid([size, size, size], rounding = 1, anchor = BOTTOM);\n`
    const ins = await imp.inspectImport(id, "Rounded Cube.scad", Buffer.from(src))
    expect(ins).toMatchObject({ kind: "scad", libraries: ["BOSL2"] })
    const r = await imp.commitImport(id, { token: ins.token, source: { kind: "person", author: "Grandpa" }, licence: "Unknown" })
    expect(r.part.imported).toMatchObject({ kind: "scad", source: { kind: "person", author: "Grandpa" } })
    expect(readFileSync(join(store.projectDir(id), r.part.file), "utf8")).toBe(src)
    expect((await cad.listParameters(id, r.part.id)).map((p) => p.name)).toEqual(["size"])
    const rr = await cad.renderPart(id, r.part.id)
    expect(rr.error).toBeUndefined()
    expect(rr.stats?.sizeMm).toEqual([12, 12, 12])
  }, 60000)

  it("warns about missing include files and refuses files that read outside the project", async () => {
    const ins = await imp.inspectImport(id, "uses-lib.scad", Buffer.from(`use <mylib.scad>\nthing();\n`))
    expect(ins.warnings.join(" ")).toMatch(/"mylib.scad", which wasn't imported/)
    await expect(imp.inspectImport(id, "sneaky.scad", Buffer.from(`import("/etc/hosts.stl");\n`))).rejects.toMatchObject({ statusCode: 422 })
    await expect(imp.inspectImport(id, "sneaky2.scad", Buffer.from(`include <../../secrets.scad>\n`))).rejects.toMatchObject({ statusCode: 422 })
  })
})

describe("R09 paths", () => {
  it("won't write through a parts/imported link that leads outside the project", async () => {
    const other = await store.createProject("Linked")
    const outside = mkdtempSync(join(tmpdir(), "printstudio-r23-outside-"))
    mkdirSync(join(store.projectDir(other.id), "parts"), { recursive: true })
    symlinkSync(outside, join(store.projectDir(other.id), "parts/imported"))
    const ins = await imp.inspectImport(other.id, "a.stl", boxStl(20, 20, 2))
    await expect(imp.commitImport(other.id, { token: ins.token, source: { kind: "self" }, licence: "" })).rejects.toMatchObject({ statusCode: 403 })
    expect(existsSync(join(outside, "a.stl"))).toBe(false)
    rmSync(outside, { recursive: true, force: true })
  })
})

describe("orientation, applied through the .scad", () => {
  it("checks a shelf bracket, suggests laying it on its front, applies it, then it's happy", async () => {
    const dir = store.projectDir(id)
    writeFileSync(join(dir, "parts/shelf.scad"), `/* [Size] */\nwidth = 40; // [10:100]\ncube([width, 4, 40]);\ntranslate([0, 4, 36]) cube([width, 20, 4]);\n`)
    await store.getProject(id) // registers parts/shelf.scad
    const rep = await cad.checkPart(id, "shelf")
    const by = Object.fromEntries(rep.items.map((i) => [i.rule, i]))
    expect(by.thin_walls.severity).toBe("pass")
    expect(by.orientation.severity).toBe("info")
    expect(by.orientation.message).toMatch(/^Lay it on its front: no supports needed/)
    expect(rep.orientation?.suggestion?.id).toBe("on-its-front")
    const applied = await cad.setPartOrientation(id, "shelf", rep.orientation!.suggestion!.rotate)
    expect(applied.rotate).toEqual(rep.orientation!.suggestion!.rotate)
    const src = readFileSync(join(dir, "parts/shelf.scad"), "utf8")
    expect(src).toMatch(/^width = 40; \/\/ \[10:100\]$/m) // parameters untouched
    const rr = await cad.renderPart(id, "shelf", { width: 50 })
    expect(rr.stats?.sizeMm).toEqual([50, 40, 24])
    const again = await cad.checkPart(id, "shelf")
    expect(again.orientation?.suggestion).toBeNull()
    expect(again.items.find((i) => i.rule === "orientation")?.severity).toBe("pass")
    expect(again.items.find((i) => i.rule === "overhangs")?.severity).toBe("pass")
  }, 60000)

  it("thin walls show up in the check with a marker and a plain fix", async () => {
    const dir = store.projectDir(id)
    writeFileSync(join(dir, "parts/fins.scad"), `cube([30, 20, 2]);\ntranslate([5, 2, 2]) cube([0.6, 15, 8]);\ntranslate([20, 2, 2]) cube([0.3, 15, 8]);\n`)
    await store.getProject(id)
    const rep = await cad.checkPart(id, "fins")
    const thin = rep.items.find((i) => i.rule === "thin_walls")!
    expect(thin.severity).toBe("warn")
    expect(thin.message).toMatch(/^This wall is 0\.6 mm thick \(.+\)\. Make it at least 0\.9 mm, or it may print with gaps/)
    expect(thin.markers?.[0].at[0]).toBeCloseTo(5.3, 0)
    const vanish = rep.items.find((i) => i.rule === "thin_features")!
    expect(vanish.message).toMatch(/0\.3 mm thick .*thinner than one 0\.45 mm line, so it may not print at all/)
    expect(vanish.markers?.[0].severity).toBe("fail")
  }, 60000)
})

describe("units prompt (E2E #2 P3)", () => {
  it("the 'if in inches' size is the one the dialog shows (measured, not the rounded size × 25.4)", () => {
    // 2.756 in across: the raw size rounds to 2.8, which × 25.4 would say 71.1 mm next to a 70.0 mm header
    const u = imp.guessUnits([2.8, 1, 1], [260, 260, 255], [70, 25.4, 25.4])
    expect(u.ask).toBe(true)
    expect(u.why).toContain("70 mm if the file is in inches")
  })
})
