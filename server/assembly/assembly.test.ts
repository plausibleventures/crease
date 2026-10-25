import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateSync } from "node:zlib"
import { afterAll, describe, expect, it } from "vitest"

// PRINTSTUDIO_HOME must be set before server/config is imported.
const home = mkdtempSync(join(tmpdir(), "printstudio-asm-"))
process.env.PRINTSTUDIO_HOME = home
const OPENSCAD = "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD"
const FIXTURE = join(import.meta.dirname, "fixtures", "parts-bin")
afterAll(() => rmSync(home, { recursive: true, force: true }))

const base = () => JSON.parse(readFileSync(join(FIXTURE, "assembly.json"), "utf8"))

describe("assembly.json validation", () => {
  it("accepts the fixture without warnings", async () => {
    const { validateAssembly } = await import("./schema")
    const v = validateAssembly(base(), ["base", "lid", "divider"])
    expect(v.errors).toEqual([])
    expect(v.warnings).toEqual([])
  })
  it("reports unknown ids, bad numbering, unknown parts and qty mismatches", async () => {
    const { validateAssembly } = await import("./schema")
    const a = base()
    a.steps[1].n = 5
    a.steps[0].adds.push("nope")
    a.steps[2].adds = ["lid", { id: "magnet", qty: 1 }]
    const v = validateAssembly(a, ["base", "lid"])
    expect(v.errors.join("\n")).toMatch(/numbered 1..N/)
    expect(v.errors.join("\n")).toMatch(/unknown id "nope"/)
    expect(v.errors.join("\n")).toMatch(/"divider" is not a project part/)
    expect(v.warnings.join("\n")).toMatch(/"magnet": qty is 4 but steps add 3/)
  })
  it("validates placements, motions and checks", async () => {
    const { validateAssembly } = await import("./schema")
    const a = base()
    a.placements.push({ part: "lid", translate: [0, 0, 0] }, { part: "nope", translate: [0, 0, 0] })
    a.motions.push({ id: "bad-id", label: "x", type: "rotate", parts: ["lid"], axis: [0, 0, 0], range: [10, 0] })
    a.steps[4].showMotion = "missing"
    delete a.steps[0].check
    const v = validateAssembly(a, ["base", "lid", "divider"])
    const errs = v.errors.join("\n")
    expect(errs).toMatch(/motion ids use letters/)
    const b = base()
    b.placements.push({ part: "lid", translate: [0, 0, 0] }, { part: "nope", translate: [0, 0, 0] })
    b.motions.push({ id: "spin", label: "x", type: "rotate", parts: ["lid#3"], axis: [0, 0, 0], range: [10, 0], rest: 50 })
    b.steps[4].showMotion = "missing"
    delete b.steps[0].check
    const w = validateAssembly(b, ["base", "lid", "divider"])
    const e = w.errors.join("\n")
    expect(e).toMatch(/"lid#0" is placed twice/)
    expect(e).toMatch(/unknown part "nope"/)
    expect(e).toMatch(/"lid#3" but qty is 1/)
    expect(e).toMatch(/axis is zero/)
    expect(e).toMatch(/max > min/)
    expect(e).toMatch(/showMotion "missing"/)
    expect(w.warnings.join("\n")).toMatch(/step 1: add a check/)
  })
  it("generates OpenSCAD placement/motion data", async () => {
    const { scadData } = await import("./scaddata")
    const src = scadData(base())
    expect(src).toContain("motion_lid = 0;")
    expect(src).toContain('if (id == "lid" && i == 0) translate([0, 0, 36]) rotate([180, 0, 0]) part("lid");')
    expect(src).toContain('if (id == "lid") translate([0, 26, 32.5]) rotate(a = (0 + motion_lid * 110), v = [-1, 0, 0])')
    expect(src).toContain('if (id == "lid" && i == 0) moving("lid") placed(id, i);')
  })
  it("parses thread and length from size", async () => {
    const { threadOf, lengthOf } = await import("./schema")
    expect(threadOf({ size: "M2.5x8" })).toBe(2.5)
    expect(lengthOf({ size: "M3 x 10" })).toBe(10)
  })
})

describe("guide drawings", () => {
  it("draws wall anchors and adhesive strips at real size (also when typed as other)", async () => {
    const { hardwareDrawing } = await import("./hardware")
    const anchor = hardwareDrawing({ id: "a", type: "wall-anchor", qty: 4, size: "6x30" })
    expect(anchor.trueScale).toBe(true)
    expect(anchor.svg).toContain("30 mm")
    const strip = hardwareDrawing({ id: "s", type: "other", qty: 2, name: "Command strip", size: "20x50" })
    expect(strip.trueScale).toBe(true)
    expect(strip.svg).toContain("50 × 20 mm")
    const magnet = hardwareDrawing({ id: "m", type: "magnet", qty: 2, size: "10x2" })
    expect(magnet.svg).toContain("10 mm")
  })
  it("draws screws at true scale in mm", async () => {
    const { drawingSvg, hardwareDrawing } = await import("./hardware")
    const svg = drawingSvg(hardwareDrawing({ id: "s", type: "screw", qty: 1, size: "M3x10", head: "button" }), "true")
    expect(svg).toMatch(/width="[\d.]+mm"/)
    expect(svg).toContain("10 mm")
  })
})

describe("sourcing", () => {
  it("builds encoded search links in store order, filtered by type", async () => {
    const { storeLinks, packSuggestion } = await import("./stores")
    const sourcing = { country: "US", stores: ["amazon-us", "aliexpress", "boltdepot", "mcmaster"] as const }
    const screw = storeLinks({ type: "screw" }, "M3x10 button head (A2)", { ...sourcing, stores: [...sourcing.stores] })
    expect(screw.map((l) => l.store)).toEqual(["amazon-us", "aliexpress", "boltdepot", "mcmaster"])
    expect(screw[0].url).toBe("https://www.amazon.com/s?k=M3x10%20button%20head%20%28A2%29")
    expect(screw[3].url).toBe("https://www.mcmaster.com/products/m3x10-button-head-a2/")
    const magnet = storeLinks({ type: "magnet" }, "6x3mm magnet", { ...sourcing, stores: [...sourcing.stores] })
    expect(magnet.map((l) => l.store)).not.toContain("boltdepot")
    expect(packSuggestion("screw", 8)).toMatch(/50–100/)
  })
  it("consolidates identical hardware and writes md/csv", async () => {
    const { buildShoppingList, shoppingMarkdown, shoppingCsv } = await import("./shopping")
    const a = base()
    a.hardware.push({ ...a.hardware[1], id: "pin2", qty: 2 })
    a.steps[4].adds.push("pin2")
    const list = buildShoppingList(a, { country: "US", stores: ["amazon-us"] })
    const pins = list.items.find((i) => i.ids.includes("pin"))!
    expect(pins.need).toBe(3)
    expect(pins.steps).toEqual([4, 5])
    expect(shoppingMarkdown("Bin", list)).toContain("[Search on Amazon](https://www.amazon.com/s?k=")
    expect(shoppingCsv(list).split("\n")[0]).toBe("need,item,spec,suggested_pack,search_term,search_Amazon,verified_listings")
  })
})

describe("supplies-only builds and make-it-yourself items", () => {
  const variant = () => {
    const a = base()
    a.hardware = [{ id: "pin", type: "filament-offcut", qty: 1, size: "1.75x60" }]
    a.consumables = [{ id: "ca", name: "Superglue (CA)", qty: "one drop" }]
    a.steps = [
      { n: 1, title: "Slide in the divider", adds: ["base", "divider"], text: "Slide the divider in.", check: "It stands straight." },
      { n: 2, title: "Put on the lid", adds: ["lid"], text: "Set the lid on.", check: "The hinge loops line up." },
      { n: 3, title: "Push in the pin", adds: ["pin", "ca"], text: "Push the filament pin in. Add a drop of glue.", check: "The lid swings.", showMotion: "lid" },
    ]
    return a
  }
  it("validates without purchase hints and warns about steps that use items they don't add", async () => {
    const { validateAssembly } = await import("./schema")
    expect(validateAssembly(variant(), ["base", "lid", "divider"]).warnings).toEqual([])
    const a = variant()
    a.steps[1].text = "Set the lid on and push the pin through."
    a.steps[2].adds = ["pin", "ca"]
    a.steps.push({ n: 4, title: "Admire it", adds: [], text: "Look at it.", check: "It looks nice." })
    const w = validateAssembly(a, ["base", "lid", "divider"]).warnings.join("\n")
    expect(w).toMatch(/step 2: text mentions "pin" but "pin" is not added yet/)
    expect(w).toMatch(/step 4: adds nothing and shows no motion/)
  })
  it("draws offcuts at real size with a cut instruction and no store links", async () => {
    const { hardwareDrawing, hardwareName, makeInstruction } = await import("./hardware")
    const { storeLinks } = await import("./stores")
    const h = { id: "pin", type: "filament-offcut" as const, qty: 1, size: "1.75x40" }
    expect(hardwareDrawing(h).trueScale).toBe(true)
    expect(hardwareDrawing(h).svg).toContain("cut 40 mm")
    expect(hardwareName(h)).toBe("1.75 mm filament, 40 mm piece")
    expect(makeInstruction(h)).toMatch(/^Cut 40 mm from your 1.75 mm filament/)
    expect(storeLinks(h, "x")).toEqual([])
  })
  it("hides empty hardware sections and says what is there", async () => {
    const { buildShoppingList, shoppingMarkdown } = await import("./shopping")
    const { buildGuideHtml } = await import("./guide")
    const a = variant()
    const list = buildShoppingList(a, { country: "US", stores: ["amazon-us"] })
    expect(list.items).toEqual([])
    expect(list.make).toHaveLength(1)
    const md = shoppingMarkdown("Bin", list)
    expect(md).not.toContain("| Need |")
    expect(md).toContain("## Make it yourself")
    const px = "data:image/png;base64,"
    const html = buildGuideHtml(a, { complete: px, steps: {}, parts: {}, motions: {} }, { projectName: "Bin" })
    expect(html).not.toMatch(/hardware item/)
    expect(html).not.toMatch(/>Hardware</)
    expect(html).toContain(">superglue<")
    expect(html).toContain("Cut 60 mm from your 1.75 mm filament")
    expect(html).not.toContain("amazon.com/s?k=1.75")
  })
  it("lowercases the check's first word but keeps acronyms", async () => {
    const { lowerFirst } = await import("./guide")
    expect(lowerFirst("Both magnets sit flush")).toBe("both magnets sit flush")
    expect(lowerFirst("A click means it is in")).toBe("a click means it is in")
    expect(lowerFirst("M3 screws are snug")).toBe("M3 screws are snug")
    expect(lowerFirst("PLA tab bends back")).toBe("PLA tab bends back")
  })
})

describe("png background", () => {
  it("whitens the border-connected background only", async () => {
    const { whitenBackground } = await import("./png")
    // 5x5 RGB: background 248, a red ring enclosing one 248 pixel
    const w = 5, h = 5
    const rows: number[] = []
    for (let y = 0; y < h; y++) {
      rows.push(0)
      for (let x = 0; x < w; x++) {
        const ring = x >= 1 && x <= 3 && y >= 1 && y <= 3 && !(x === 2 && y === 2)
        rows.push(...(ring ? [200, 0, 0] : [248, 248, 248]))
      }
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
    const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); return Buffer.concat([l, Buffer.from(t), d, Buffer.alloc(4)]) }
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from(rows))), chunk("IEND", Buffer.alloc(0))])
    const out = whitenBackground(png)
    const again = whitenBackground(out) // decodes our own output
    expect(again.length).toBeGreaterThan(0)
    const { inflateSync } = await import("node:zlib")
    // signature (8) + IHDR chunk (25) + IDAT length/type (8); IDAT CRC (4) + IEND (12) at the end
    const raw = inflateSync(out.subarray(41, out.length - 16))
    // undo filter 2 ("up") to read back pixels
    const stride = w * 3
    const px = Buffer.alloc(h * stride)
    for (let y = 0; y < h; y++) for (let i = 0; i < stride; i++) px[y * stride + i] = (raw[y * (stride + 1) + 1 + i] + (y ? px[(y - 1) * stride + i] : 0)) & 0xff
    expect([...px.subarray(0, 3)]).toEqual([255, 255, 255]) // corner: background
    expect([...px.subarray(2 * stride + 6, 2 * stride + 9)]).toEqual([248, 248, 248]) // enclosed: untouched
  })
})

describe.skipIf(!existsSync(OPENSCAD))("guide end to end (OpenSCAD)", () => {
  it("builds a parts page and one page per step for the 3-part fixture", async () => {
    const store = await import("../projects/store")
    const asm = await import("./index")
    const p = await store.createProject("Parts bin")
    const root = store.projectDir(p.id)
    rmSync(join(root, "parts", "main.scad"))
    cpSync(join(FIXTURE, "parts"), join(root, "parts"), { recursive: true })
    cpSync(join(FIXTURE, "assembly.scad"), join(root, "assembly.scad"))
    const w = await asm.writeAssembly(p.id, base())
    expect(w.warnings).toEqual([])

    // No collisions in the checked positions, with a real clearance between the knuckles; the result says its scope.
    const t0 = Date.now()
    const ok = await asm.checkAssemblyMotion(p.id)
    console.log(`check_motion (parts bin, 3 parts): ${Date.now() - t0} ms, ${ok.motions[0].coverage.positions} positions`)
    expect(ok.restCollisions).toEqual([])
    expect(ok.status).toBe("ok")
    expect(ok.ok).toBe(true)
    expect(ok.motions[0].coverage.positions).toBeGreaterThanOrEqual(10)
    expect(ok.motions[0].minClearanceMm).toBeGreaterThanOrEqual(0.3)
    expect(ok.summary).toMatch(/Lid opens \(lid\): No collisions found in \d+ positions from 0° to 110°/)
    expect(ok.summary).toMatch(/Not included: magnet ×4 \(no position given\); pin \(no position given\); feet ×4 \(no position given\)/)
    expect(ok.summary).not.toMatch(/moves freely over/)
    // Saved for the app (Moves panel) and fresh until something changes.
    const saved = (await asm.getAssemblyInfo(p.id)).motionCheck
    expect(saved?.status).toBe("ok")
    expect(saved?.stale).toBe(false)

    const r = await asm.buildAssemblyGuide(p.id)
    expect(r.url).toMatch(new RegExp(`^/api/projects/${p.id}/artifacts/build/assembly-guide.html`))
    const html = readFileSync(r.path, "utf8")
    expect(html.match(/class="page step"/g)?.length).toBe(5)
    expect(html).toContain("Everything you need")
    expect(html).toContain("What moves")
    expect(html).toContain("You got it right when")
    expect(html).toContain("How it moves")
    for (const n of [1, 2, 3, 4, 5]) expect(existsSync(join(root, `renders/assembly-step-${n}.png`))).toBe(true)
    for (const k of [0, 1, 2]) expect(existsSync(join(root, `renders/assembly-motion-lid-${k}.png`))).toBe(true)
    const info = await asm.getAssemblyInfo(p.id)
    expect(info.guideUrl).toBeTruthy()
    expect(info.stepImages).toHaveLength(5)
    expect(info.shoppingListUrl).toMatch(/build\/shopping-list.md/)
    expect(Object.keys(info.partModels).sort()).toEqual(["base", "divider", "lid"])
    expect(html).toContain("Shopping list")
    expect(html).toContain("https://www.amazon.com/s?k=6x3mm%20N52%20neodymium%20disc%20magnet")
    const again = await asm.buildAssemblyGuide(p.id)
    expect(again.rendered).toBe(0) // cached

    expect(html).toContain("Checked on screen: no collisions found in")

    // Deliberate mistake: hinge pivot in the middle of the lid -> the lid swings through the box.
    const bad = base()
    bad.motions[0].origin = [0, 0, 34]
    await asm.writeAssembly(p.id, bad)
    expect((await asm.getAssemblyInfo(p.id)).motionCheck?.stale).toBe(true)
    const hit = await asm.checkAssemblyMotion(p.id)
    expect(hit.ok).toBe(false)
    const lid = hit.motions[0]
    expect(lid.collisions.some((c) => c.a === "lid" && ["base", "divider"].includes(c.b))).toBe(true)
    expect(lid.freeRange?.[0]).toBe(0)
    expect(hit.summary).toMatch(/Lid opens \(lid\): lid hits (base|divider) at/)

    // Overlap at rest (placement mistake) is reported separately.
    const sunk = base()
    sunk.placements[2].translate = [0, 0, 30]
    await asm.writeAssembly(p.id, sunk)
    const rest = await asm.checkAssemblyMotion(p.id)
    expect(rest.restCollisions.some((c) => [c.a, c.b].includes("lid"))).toBe(true)
  }, 240_000)
})
