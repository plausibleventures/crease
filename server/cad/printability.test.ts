// R23: thin walls, orientation suggestions (validated against the print-journal cases) and the documented transform.
import Module from "manifold-3d"
import { beforeAll, describe, expect, it } from "vitest"
import type { IndexedMesh } from "./mesh"
import { measureThinWalls } from "./thickness"
import { adviseOrientation, eulerToMat, matToEuler, measure, readOrientation, topLevelStatements, writeOrientation } from "./orient"
import { parseCustomizer } from "./openscad"

type W = Awaited<ReturnType<typeof Module>>
let w: W
type Solid = InstanceType<W["Manifold"]>
const mesh = (m: Solid): IndexedMesh => {
  const g = m.getMesh()
  const verts = new Float64Array((g.vertProperties.length / g.numProp) * 3)
  for (let i = 0; i < g.vertProperties.length / g.numProp; i++) for (let k = 0; k < 3; k++) verts[i * 3 + k] = g.vertProperties[i * g.numProp + k]
  return { verts, tris: Uint32Array.from(g.triVerts) }
}
const box = (x: number, y: number, z: number, at: [number, number, number] = [0, 0, 0]) => w.Manifold.cube([x, y, z]).translate(at)

beforeAll(async () => {
  w = await Module()
  w.setup()
})

describe("thin walls", () => {
  it("finds a 0.6 mm fin (2-line rule) and a 0.3 mm fin (thinner than one line), not solid or chamfered blocks", () => {
    const base = box(30, 20, 2)
    const fin06 = box(0.6, 15, 8, [5, 2, 2])
    const fin03 = box(0.3, 15, 8, [20, 2, 2])
    const r = measureThinWalls(mesh(base.add(fin06).add(fin03)), 0.4)
    expect(r.lineWidthMm).toBe(0.45)
    expect(r.minWallMm).toBe(0.9)
    const near = (x: number) => r.spots.find((s) => Math.abs(s.at[0] - x) < 1)
    expect(near(5.3)?.thicknessMm).toBeCloseTo(0.6, 1)
    expect(near(5.3)?.vanishes).toBe(false)
    expect(near(20.15)?.thicknessMm).toBeCloseTo(0.3, 1)
    expect(near(20.15)?.vanishes).toBe(true)
    // marker is on the fin, in part coordinates
    expect(near(5.3)!.at[2]).toBeGreaterThan(2)

    expect(measureThinWalls(mesh(box(20, 20, 20)), 0.4).spots).toEqual([])
    // a 45° chamfered block: the wedge-shaped edges are not "thin walls"
    const chamfered = box(20, 20, 10).subtract(box(10, 40, 10, [-5, -10, 0]).rotate([0, 45, 0]).translate([-7.07 + 2, 0, 10]))
    expect(measureThinWalls(mesh(chamfered), 0.4).spots).toEqual([])
  })

  it("two thin walls close together are two spots, one long wall is one (E2E #2 P3)", () => {
    // a slot: two 0.6 mm walls 1.5 mm apart on a base
    const slot = mesh(box(30, 20, 2).add(box(0.6, 15, 8, [5, 2, 2])).add(box(0.6, 15, 8, [7.1, 2, 2])))
    expect(measureThinWalls(slot, 0.4).spots).toHaveLength(2)
    expect(measureThinWalls(mesh(box(30, 20, 2).add(box(0.6, 18, 10, [5, 1, 2]))), 0.4).spots).toHaveLength(1)
    // a curved wall (a 0.6 mm tube) is one spot too
    const tube = w.Manifold.cylinder(10, 6, 6, 96).subtract(w.Manifold.cylinder(10, 5.4, 5.4, 96))
    expect(measureThinWalls(mesh(tube), 0.4).spots).toHaveLength(1)
  })

  it("thresholds follow the nozzle", () => {
    const part = mesh(box(20, 20, 2).add(box(1.2, 15, 8, [5, 2, 2])))
    expect(measureThinWalls(part, 0.4).spots).toEqual([]) // 1.2 mm >= 0.9
    const big = measureThinWalls(part, 0.8) // 0.9 mm lines -> 1.8 mm walls
    expect(big.minWallMm).toBe(1.8)
    expect(big.spots[0].thicknessMm).toBeCloseTo(1.2, 1)
  })
})

describe("orientation", () => {
  // Upright back plate with a 20 mm shelf at the top: the shelf's underside needs supports as modelled.
  const shelf = () => mesh(box(40, 4, 40).add(box(40, 20, 4, [0, 4, 36])))

  it("suggests laying a shelf bracket on its front: no supports, shorter", () => {
    const a = adviseOrientation(shelf())
    expect(a.current.supportMm2).toBeGreaterThan(700)
    expect(a.suggestion?.id).toBe("on-its-front")
    expect(a.suggestion?.supportMm2).toBe(0)
    expect(a.suggestion?.heightMm).toBe(24)
    expect(a.summary).toMatch(/^Lay it on its front: no supports needed/)
    expect(a.reasons.join(" ")).toMatch(/faster/)
    // the rotation to write is absolute and puts the -Y face down
    const r = eulerToMat(a.suggestion!.rotate)
    expect(r[2][1]).toBeCloseTo(1) // y -> z: the -Y face ends up facing -Z
  })

  it("applying it twice is stable: relative to the rotation already in the .scad", () => {
    const first = adviseOrientation(shelf()).suggestion!
    // the mesh as rendered after applying `first`
    const m = shelf()
    const r = eulerToMat(first.rotate)
    for (let i = 0; i < m.verts.length; i += 3) {
      const [x, y, z] = [m.verts[i], m.verts[i + 1], m.verts[i + 2]]
      for (let k = 0; k < 3; k++) m.verts[i + k] = r[k][0] * x + r[k][1] * y + r[k][2] * z
    }
    const again = adviseOrientation(m, first.rotate)
    expect(again.suggestion).toBeNull()
    expect(again.current.rotate).toEqual(first.rotate)
    expect(again.summary).toMatch(/^Keep it as it is/)
  })

  // Print journal: the apple logo prints face up; a stem across a gap needs a flat underside.
  const apple = (stem: "round" | "flat") => {
    const leaf = box(30, 20, 6)
    const body = box(30, 20, 6, [0, 24, 0])
    let stick = w.Manifold.cylinder(8, 1.3, 1.3, 48).rotate([-90, 0, 0]).translate([15, 18, 3])
    if (stem === "flat") stick = stick.subtract(box(4, 10, 2, [13, 17, 3 - 1.3 + 0.3 - 2]))
    return mesh(leaf.add(body).add(stick))
  }

  it("apple-style flat piece: keeps it face up (face down is no better)", () => {
    for (const stem of ["round", "flat"] as const) {
      const a = adviseOrientation(apple(stem))
      expect(a.suggestion, stem).toBeNull()
      expect(a.candidates.map((c) => c.id)).toContain("upside-down")
    }
    // flat underside: flipping it puts the round side down, which is worse
    const flat = adviseOrientation(apple("flat"))
    const down = flat.candidates.find((c) => c.id === "upside-down")!
    expect(down.overhangMm2).toBeGreaterThan(flat.current.overhangMm2)
  })

  it("stick underside: round starts as an overhang, a flat underside is a short bridge", () => {
    const I: Parameters<typeof measure>[1] = eulerToMat([0, 0, 0])
    const round = measure(apple("round"), I)
    const flat = measure(apple("flat"), I)
    expect(round.overhangMm2).toBeGreaterThan(flat.overhangMm2)
    expect(flat.bridgeMm2).toBeGreaterThan(2)
    expect(round.bridgeMm2).toBeLessThan(flat.bridgeMm2)
  })

  it("euler round trip", () => {
    for (const e of [
      [90, 0, 0],
      [0, -90, 0],
      [180, 0, 0],
      [30, 20, 10],
      [0, 90, 45],
    ] as [number, number, number][]) {
      const back = eulerToMat(matToEuler(eulerToMat(e)))
      const orig = eulerToMat(e)
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) expect(back[r][c]).toBeCloseTo(orig[r][c], 6)
    }
  })
})

describe("orientation transform in the .scad", () => {
  const src = `// Shelf bracket
/* [Size] */
// Width
width = 40; // [10:100]
shelf = 20; // [5:40]

module plate() cube([width, 4, 40]);
function half(x) = x / 2;

plate();
// the shelf
translate([0, 4, 36]) cube([width, shelf, 4]);
if (shelf > 30) { cube(1); } else { cube(2); }
$fn = 32;
`
  it("splits top-level statements", () => {
    const kinds = topLevelStatements(src).map((s) => [s.kind, src.slice(s.start, s.end).split(/[\s(]/)[0]])
    expect(kinds).toEqual([
      ["other", "width"],
      ["other", "shelf"],
      ["other", "module"],
      ["other", "function"],
      ["geometry", "plate"],
      ["geometry", "translate"],
      ["geometry", "if"],
      ["other", "$fn"],
    ])
  })

  it("wraps the geometry once, keeps parameters, then only changes the numbers", () => {
    const once = writeOrientation(src, [90, 0, 0])
    expect(readOrientation(once)).toEqual([90, 0, 0])
    expect(once).toMatch(/print_orientation = \[90, 0, 0\];\nrotate\(print_orientation\) \{ \/\/ printstudio:orientation\n {2}plate\(\);/)
    expect(once).toContain("  translate([0, 4, 36]) cube([width, shelf, 4]);")
    expect(once).toContain("  if (shelf > 30) { cube(1); } else { cube(2); }")
    expect(once).toContain("$fn = 32;")
    expect(parseCustomizer(once)).toEqual(parseCustomizer(src))
    const twice = writeOrientation(once, [0, 0, 0])
    expect(readOrientation(twice)).toEqual([0, 0, 0])
    expect(twice.replace("print_orientation = [0, 0, 0]", "print_orientation = [90, 0, 0]")).toBe(once)
    expect(() => writeOrientation("x = 1;\nmodule m() cube(1);\n", [90, 0, 0])).toThrow(/no top-level geometry/)
  })
})
