// R13: EXCLUDE_OBJECT parsing + mapping objects back to parts, against real OrcaSlicer 2.4.2 output.
// Fixtures (server/slicer/fixtures/): the first lines (header + EXCLUDE_OBJECT_DEFINE block) of two plates sliced by
// the app's own slicePlate with the bundled SPARKX i7 profile, and the part STLs they were sliced from:
//   plate-plain:   main, tag-a ×2, tag-b, tag-c  (plain multi-STL path, --arrange with rotations)
//   plate-perpart: tag-a (ironing_type=top), tag-a, tag-b  (assemble-list path, per-part overrides)
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { convexHull, fitPlacement, letterFor, mapPlateObjects, parseExcludeObjects, partOfObjectName, placeObjects, stlPoints } from "./placement"
import { parsePlateObjects } from "./index"

const fx = (f: string) => join(import.meta.dirname, "fixtures", f)
const plain = readFileSync(fx("plate-plain.head.gcode"), "utf8")
const perpart = readFileSync(fx("plate-perpart.head.gcode"), "utf8")
const mesh = (id: string) => stlPoints(readFileSync(fx(`${id}.stl`)))

const rotate = (p: [number, number], deg: number): [number, number] => {
  const r = (deg * Math.PI) / 180
  return [p[0] * Math.cos(r) - p[1] * Math.sin(r), p[0] * Math.sin(r) + p[1] * Math.cos(r)]
}

describe("parseExcludeObjects", () => {
  it("reads name, centre and footprint polygon of every object (ring not closed twice)", () => {
    const defs = parseExcludeObjects(plain)
    expect(defs.map((d) => d.name)).toEqual([
      "main.stl_id_0_copy_0",
      "tag-a.stl_id_1_copy_0",
      "tag-a.stl_id_2_copy_0",
      "tag-c.stl_id_3_copy_0",
      "tag-b.stl_id_4_copy_0",
    ])
    const b = defs[4]
    expect(b.center).toEqual([112.767, 118.955])
    expect(b.polygon).toEqual([
      [102.767, 103.955],
      [122.767, 103.955],
      [122.767, 133.955],
    ])
    // CENTER is the middle of the footprint's bounding box
    for (const d of defs) {
      const xs = d.polygon.map((p) => p[0]), ys = d.polygon.map((p) => p[1])
      expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(d.center![0], 2)
      expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(d.center![1], 2)
    }
  })
  it("tolerates lines without POLYGON/CENTER and keeps the old parsePlateObjects shape", () => {
    expect(parseExcludeObjects("EXCLUDE_OBJECT_DEFINE NAME=foo.stl_id_0_copy_0\n")).toEqual([{ name: "foo.stl_id_0_copy_0", center: null, polygon: [] }])
    expect(parsePlateObjects(perpart)).toEqual([
      { partId: "tag-a", center: [141.082, 143.5] },
      { partId: "tag-a", center: [141.082, 116.5] },
      { partId: "tag-b", center: [109.082, 129.914] },
    ])
    expect(partOfObjectName("apple-face.v2.stl_id_12_copy_3")).toBe("apple-face.v2")
    // a small file read as head + tail contains the block twice: each object once
    expect(parseExcludeObjects(perpart + "\n" + perpart)).toHaveLength(3)
  })
})

describe("mapPlateObjects", () => {
  const entries = [
    { partId: "main", qty: 1 },
    { partId: "tag-a", qty: 2 },
    { partId: "tag-b", qty: 1 },
    { partId: "tag-c", qty: 1 },
  ]
  it("maps OrcaSlicer's objects (not in input order) to entries, copies and letters in parts[] order", () => {
    const [objs] = mapPlateObjects([parseExcludeObjects(plain)], entries)
    const by = Object.fromEntries(objs.map((o) => [o.name, `${o.label}:${o.partId}#${o.entry}.${o.instance}`]))
    expect(by).toEqual({
      "main.stl_id_0_copy_0": "A:main#0.1",
      "tag-a.stl_id_1_copy_0": "B:tag-a#1.1",
      "tag-a.stl_id_2_copy_0": "C:tag-a#1.2",
      "tag-b.stl_id_4_copy_0": "D:tag-b#2.1", // OrcaSlicer numbered tag-c before tag-b; letters still follow parts[]
      "tag-c.stl_id_3_copy_0": "E:tag-c#3.1",
    })
  })
  it("per-part variants: the assemble_index map decides which copy has which settings", () => {
    const variants = [
      { partId: "tag-a", qty: 1, overrides: { ironing_type: "top" } },
      { partId: "tag-a", qty: 1 },
      { partId: "tag-b", qty: 1 },
    ]
    const defs = parseExcludeObjects(perpart)
    // as recorded by runOrcaMulticolor: key 2 (the plain copy) got OrcaSlicer id 0 this time
    const [objs] = mapPlateObjects([defs], variants, [{ "tag-a.stl_id_0_copy_0": 2, "tag-a.stl_id_1_copy_0": 1, "tag-b.stl_id_2_copy_0": 3 }])
    expect(objs.map((o) => [o.name, o.label, o.entry, o.overrides ?? null])).toEqual([
      ["tag-a.stl_id_0_copy_0", "B", 1, null],
      ["tag-a.stl_id_1_copy_0", "A", 0, { ironing_type: "top" }],
      ["tag-b.stl_id_2_copy_0", "C", 2, null],
    ])
    // without the map (older jobs) copies of a part are taken in OrcaSlicer's id order
    const [guess] = mapPlateObjects([defs], variants)
    expect(guess.map((o) => o.label)).toEqual(["A", "B", "C"])
  })
  it("numbers letters across plates (A on plate 1 stays A; plate 2 continues)", () => {
    const p1 = parseExcludeObjects("EXCLUDE_OBJECT_DEFINE NAME=box.stl_id_0_copy_0 CENTER=50,50\nEXCLUDE_OBJECT_DEFINE NAME=box.stl_id_1_copy_0 CENTER=150,50\n")
    const p2 = parseExcludeObjects("EXCLUDE_OBJECT_DEFINE NAME=box.stl_id_0_copy_0 CENTER=50,50\nEXCLUDE_OBJECT_DEFINE NAME=lid.stl_id_1_copy_0 CENTER=150,50\n")
    const out = mapPlateObjects([p1, p2], [{ partId: "box", qty: 3 }, { partId: "lid", qty: 1 }])
    expect(out.map((pl) => pl.map((o) => `${o.label}${o.instance}`))).toEqual([["A1", "B2"], ["C3", "D1"]])
  })
  it("letters go A..Z, AA, AB", () => {
    expect([0, 1, 25, 26, 27, 51, 52].map(letterFor)).toEqual(["A", "B", "Z", "AA", "AB", "AZ", "BA"])
  })
})

describe("fitPlacement: the slicer's rotation + position of each mesh", () => {
  it("recovers OrcaSlicer's arrange rotations (0°, 90°, 45°, arbitrary) from the real plate", () => {
    const [objs] = placeObjects(mapPlateObjects([parseExcludeObjects(plain)], [
      { partId: "main", qty: 1 },
      { partId: "tag-a", qty: 2 },
      { partId: "tag-b", qty: 1 },
      { partId: "tag-c", qty: 1 },
    ]), mesh)
    const rot = Object.fromEntries(objs.map((o) => [o.label, o.rotationDeg]))
    expect(rot.A).toBe(0) // main: symmetric box, closest to 0 wins
    expect(rot.B).toBeCloseTo(90, 0)
    expect(rot.C).toBeCloseTo(45, 0)
    expect(rot.D).toBeCloseTo(90, 0)
    expect(Math.abs(rot.E! - 289)).toBeLessThan(1) // tag-c: its tab points front-right
    // Applying the transform to the mesh hull lands it on the slicer's polygon.
    for (const o of objs) {
      const hull = convexHull(mesh(o.partId).xy).map((p) => {
        const r = rotate(p, o.rotationDeg!)
        return [r[0] + o.translate![0], r[1] + o.translate![1]]
      })
      const xs = hull.map((p) => p[0]), ys = hull.map((p) => p[1])
      expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(o.center[0], 1)
      expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(o.center[1], 1)
    }
  })
  it("returns null for a mesh that doesn't match the footprint (part changed since slicing)", () => {
    const b = parseExcludeObjects(plain).find((d) => d.name.startsWith("tag-b"))!
    expect(fitPlacement(mesh("main").xy, b.polygon, b.center)).toBeNull()
  })
  it("reads binary STL vertices and the lowest Z", () => {
    const m = mesh("tag-b")
    expect(m.xy.length).toBe(8 * 3) // 8 triangles
    expect(m.minZ).toBe(0)
  })
})
