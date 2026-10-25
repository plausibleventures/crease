// R14 step art: projection math, insertion directions from placements, callouts on the right instances, and a
// golden-ish check that a sample project's step SVG carries the expected arrows / callouts / glue regions.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Assembly, AssemblyHardware, Vec3 } from "../../shared/types"
import {
  cameraBasis,
  dirFromScadView,
  dot,
  instanceSteps,
  letterRange,
  partLetters,
  project,
  rectsOverlap,
  unproject,
  type OrthoView,
  type Rect,
} from "../../shared/assembly-art"
import { validateAssembly } from "./schema"
import { buildScene, type Mesh } from "./scene"
import { drawStep, inferInsert, overlaySvg, stepRoles, stepSvg } from "./illustrate"

const FIXTURE = join(import.meta.dirname, "fixtures", "parts-bin")
const close = (a: number[], b: number[], eps = 1e-6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], -Math.log10(eps)))

/** Axis-aligned box mesh from (x0,y0,z0) to (x1,y1,z1). */
function cube(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Mesh {
  const verts = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]
  const tris = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]
  return { verts, tris }
}

describe("projection math", () => {
  it("maps OpenSCAD views to eye directions", () => {
    close(dirFromScadView([0, 0, 0]), [0, 0, 1]) // top
    close(dirFromScadView([90, 0, 0]), [0, -1, 0]) // front
    close(dirFromScadView([55, 0, 25]), [0.3462, -0.7424, 0.5736], 1e-3) // default iso: front-right, from above
    close(dirFromScadView([90, 0, 90]), [1, 0, 0], 1e-9) // right side
  })
  it("projects orthographically with +Z up and round-trips through unproject", () => {
    const b = cameraBasis([1, -1, 1])
    expect(dot(b.right, b.up)).toBeCloseTo(0)
    expect(dot(b.right, b.dir)).toBeCloseTo(0)
    const v: OrthoView = { ...b, s: 4, ox: 600, oy: 450 }
    const [x0, y0] = project(v, [0, 0, 0])
    expect([x0, y0]).toEqual([600, 450])
    const [, yUp] = project(v, [0, 0, 10])
    expect(yUp).toBeLessThan(450) // higher in the world = higher on the page
    const p: Vec3 = [12, -7, 30]
    const [x, y, z] = project(v, p)
    close(unproject(v, x, y, z), p, 1e-9)
  })
})

describe("instances, steps and letters", () => {
  const a = JSON.parse(readFileSync(join(FIXTURE, "assembly.json"), "utf8")) as Assembly
  it("assigns split quantities to their own steps and letters in parts order", () => {
    const steps = instanceSteps(a)
    expect([steps.get("magnet#0"), steps.get("magnet#1"), steps.get("magnet#2"), steps.get("magnet#3")]).toEqual([1, 1, 3, 3])
    expect(steps.get("lid#0")).toBe(3)
    expect(Object.fromEntries(partLetters(a))).toEqual({ "base#0": "A", "divider#0": "B", "lid#0": "C" })
    expect(letterRange(["C", "D", "E", "F"])).toBe("C–F")
    expect(letterRange(["A", "C"])).toBe("A, C")
    expect(letterRange(["B", "A"])).toBe("A, B")
  })
  it("validates the new step fields additively", () => {
    const b = structuredClone(a)
    b.steps[1].action = "slide"
    b.steps[1].insert = [0, 0, -1]
    b.steps[2].glue = [{ kind: "no-glue", at: [0, 26, 32.5], size: [30, 6, 6], part: "lid" }]
    b.steps[3].closeUp = true
    expect(validateAssembly(b, ["base", "lid", "divider"]).errors).toEqual([])
    b.steps[1].insert = [0, 0, 0]
    b.steps[2].glue = [{ kind: "glue", at: [0, 0, 0], size: [1, 1, 1], part: "nope" }]
    b.steps[3].focus = ["lid#4"]
    const errs = validateAssembly(b, ["base", "lid", "divider"]).errors.join("\n")
    expect(errs).toMatch(/step 2: insert is zero/)
    expect(errs).toMatch(/glue region: unknown part or hardware "nope"/)
    expect(errs).toMatch(/focus: "lid#4" but qty is 1/)
  })
})

describe("insertion directions", () => {
  it("infers the free direction from the placements", () => {
    // lid above a box: comes down from above
    expect(inferInsert({ min: [-30, -20, 32], max: [30, 20, 36] }, [{ min: [-32, -22, 0], max: [32, 22, 32] }], 40)).toEqual([0, 0, -1])
    // a drawer in a cabinet open at the front (-Y): it slides in along +Y
    const cabinet = [
      { min: [-30, -20, 0], max: [30, 20, 2] }, // floor
      { min: [-30, -20, 30], max: [30, 20, 32] }, // top
      { min: [-32, -20, 0], max: [-30, 20, 32] }, // left
      { min: [30, -20, 0], max: [32, 20, 32] }, // right
      { min: [-30, 20, 0], max: [30, 22, 32] }, // back
    ] as { min: Vec3; max: Vec3 }[]
    expect(inferInsert({ min: [-29, -19, 3], max: [29, 19, 29] }, cabinet, 40)).toEqual([0, 1, 0])
  })
  it("uses insert > explodeDirection > the hardware's own axis", () => {
    const a = {
      parts: [{ id: "plate", qty: 1, color: "red" }],
      hardware: [{ id: "screw", type: "screw", qty: 2, size: "M3x10" }],
      tools: [],
      consumables: [],
      placements: [{ part: "plate", translate: [0, 0, 0] }],
      hardwarePlacements: [
        { hardware: "screw", instance: 0, translate: [-10, 0, 0] }, // head-up: goes in downwards
        { hardware: "screw", instance: 1, translate: [10, 0, 0], rotate: [0, 90, 0] }, // lying along +X
      ],
      steps: [
        { n: 1, title: "Plate", adds: ["plate"], text: "Lay it down." },
        { n: 2, title: "Screws", adds: ["screw"], text: "Screw them in." },
      ],
    } as unknown as Assembly
    const sc = buildScene(a, () => cube(-20, -10, -5, 20, 10, 0), () => cube(-1.5, -1.5, 0, 1.5, 1.5, 10)).insts
    const r = stepRoles(a, sc, 2)
    const ins = Object.fromEntries(r.movers.map((m) => [m.inst.key, m.insert.map((v) => Math.round(v * 1e6) / 1e6 + 0)]))
    expect(ins["screw#0"]).toEqual([0, 0, -1])
    expect(ins["screw#1"]).toEqual([-1, 0, 0])
    expect(r.movers.every((m) => m.action === "screw")).toBe(true)
    a.steps[1].explodeDirection = [0, 1, 0]
    close(stepRoles(a, sc, 2).movers[0].insert, [0, -1, 0])
    a.steps[1].insert = [1, 0, 0]
    expect(stepRoles(a, sc, 2).movers[0].insert).toEqual([1, 0, 0])
    // the moving items are pulled back against their insertion direction, by at least their own length
    const m = stepRoles(a, sc, 2).movers[0]
    expect(dot(m.offset, m.insert)).toBeLessThan(-10)
  })
})

describe("step art for the parts-bin fixture (primitive meshes)", () => {
  const a = JSON.parse(readFileSync(join(FIXTURE, "assembly.json"), "utf8")) as Assembly
  // magnets in the corner posts / under the lid, the pin along the hinge, feet underneath
  a.hardwarePlacements = [
    { hardware: "magnet", instance: 0, translate: [-26, -16, 29] },
    { hardware: "magnet", instance: 1, translate: [26, -16, 29] },
    { hardware: "magnet", instance: 2, translate: [-26, -16, 32], movesWith: "lid" },
    { hardware: "magnet", instance: 3, translate: [26, -16, 32], movesWith: "lid" },
    { hardware: "pin", translate: [-30, 26, 32.5], rotate: [0, 90, 0] },
    ...[0, 1, 2, 3].map((i) => ({ hardware: "feet", instance: i, translate: [i % 2 ? 26 : -26, i < 2 ? -16 : 16, -3] as Vec3 })),
  ]
  a.steps[3].action = "slide"
  a.steps[3].glue = [
    { kind: "glue", at: [-29, 26, 32.5], size: [2, 7, 7], part: "pin", label: "a drop at the end" },
    { kind: "no-glue", at: [0, 26, 32.5], size: [36, 7, 7] },
  ]
  const parts: Record<string, Mesh> = {
    base: cube(-32, -22, 0, 32, 22, 32), // modelled at the origin; placements move them
    divider: cube(-1, 0, 0, 1, 40, 28),
    lid: cube(-32, -22, 0, 32, 22, 4),
  }
  const hw = (h: AssemblyHardware): Mesh =>
    h.type === "magnet" ? cube(-3, -3, 0, 3, 3, 3) : h.type === "dowel-pin" ? cube(-1.5, -1.5, 0, 1.5, 1.5, 60) : cube(-5, -5, 0, 5, 5, 3)
  const { insts, problems } = buildScene(a, (id) => parts[id], hw)

  it("places every instance", () => {
    expect(problems).toEqual([])
    expect(insts.map((x) => x.key).sort()).toEqual(
      ["base#0", "divider#0", "lid#0", "magnet#0", "magnet#1", "magnet#2", "magnet#3", "pin#0", "feet#0", "feet#1", "feet#2", "feet#3"].sort(),
    )
  })

  it("points each arrow at where its item goes and labels the actual instances", () => {
    const d = drawStep(a, insts, 3, { width: 600, height: 450, ss: 1 })
    const roles = Object.fromEntries(d.art.instances.map((x) => [x.key, x.role]))
    expect(roles["lid#0"]).toBe("new")
    expect(roles["magnet#2"]).toBe("new")
    expect(roles["magnet#0"]).toBe("done")
    expect(roles["pin#0"]).toBe("hidden")
    // fixture step 3: explodeDirection +Z, so everything goes in downwards; arrows run tail -> tip downwards
    for (const r of d.art.arrows) {
      expect(r.to[2]).toBeLessThan(r.from[2])
      expect(r.kind).toBe(r.targets[0] === "lid#0" ? "insert" : "push") // magnets default to push
    }
    // the lid and both new magnets get one arrow each
    expect(d.art.arrows.map((r) => r.targets[0]).sort()).toEqual(["lid#0", "magnet#2", "magnet#3"])
    // callouts: the lid as "C", 2× magnet, and the base (context, "A") the lid goes onto
    const byLabel = Object.fromEntries(d.art.callouts.map((c) => [c.label, c]))
    expect(byLabel["Lid"].letters).toBe("C")
    expect(byLabel["Lid"].tone).toBe("new")
    expect(byLabel["Base"].tone).toBe("context")
    expect(byLabel["Base"].letters).toBe("A")
    const mag = d.art.callouts.find((c) => c.qty === 2)!
    expect(mag.anchors.map((q) => q.key).sort()).toEqual(["magnet#2", "magnet#3"])
    // every anchor is on (or in) its own instance at its seated position
    for (const c of d.art.callouts)
      for (const q of c.anchors) {
        const b = insts.find((x) => x.key === q.key)!.box
        for (let i = 0; i < 3; i++) {
          expect(q.point[i]).toBeGreaterThanOrEqual(b.min[i] - 0.6)
          expect(q.point[i]).toBeLessThanOrEqual(b.max[i] + 0.6)
        }
      }
  })

  it("writes the expected SVG elements (golden-ish)", () => {
    const d = drawStep(a, insts, 4, { width: 600, height: 450, ss: 1 })
    const svg = stepSvg(d, "assembly-step-4.art.png")
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/)
    expect(svg).toContain('<image x="0" y="0" width="600" height="450" href="assembly-step-4.art.png"/>')
    expect(svg.match(/<g class="arrow slide" data-kind="slide" data-targets="pin#0">/g)).toHaveLength(1)
    expect(svg).toContain('class="callout new" data-tone="new" data-letters="" data-targets="pin#0"')
    expect(svg).toContain(">1×</text>")
    expect(svg).toMatch(/<g class="glue-region glue" data-kind="glue">[\s\S]*GLUE: a drop at the end/)
    expect(svg).toMatch(/<g class="glue-region no-glue" data-kind="no-glue">[\s\S]*NO GLUE/)
    expect(svg).toContain('id="hatch-glue"')
    // the pin is long and thin: a close-up of the hinge isn't needed (it's not small), so no inset here
    expect(d.art.closeUp).toBeNull()
    // the pin's arrow runs along the hinge (+X after explodeDirection [1,0,0] means it comes in along -X)
    const r = d.art.arrows[0]
    expect(Math.sign(r.to[0] - r.from[0])).toBe(-1)
    expect(overlaySvg(d)).not.toContain("<image x=\"0\"")

    // step 1: two small magnets on a big base -> automatic close-up inset with its own image
    const d1 = drawStep(a, insts, 1, { width: 600, height: 450, ss: 1 })
    expect(d1.art.instances.find((x) => x.key === "base#0")!.offset).toEqual([0, 0, 0]) // the base stays put
    expect(d1.art.arrows.map((x) => x.targets[0]).sort()).toEqual(["magnet#0", "magnet#1"])
    expect(d1.art.closeUp).not.toBeNull()
    expect(d1.overlay).toMatch(/<g class="closeup">[\s\S]*<image [^>]*href="data:image\/png;base64,/)
  })

  it("no two labels overlap, on the printed step or in 3D (callouts, glue labels)", () => {
    const overlaps = (rs: Rect[]) => rs.flatMap((r, i) => rs.slice(i + 1).filter((q) => rectsOverlap(r, q)).map((q) => [r, q]))
    // a crowded variant: three glue regions side by side along the hinge, so their labels would land on each other
    const crowded: Assembly = JSON.parse(JSON.stringify(a))
    crowded.steps[3].glue = [
      { kind: "glue", at: [-29, 26, 32.5], size: [2, 7, 7], part: "pin", label: "a drop at the end" },
      { kind: "no-glue", at: [-10, 26, 32.5], size: [10, 7, 7], label: "keep it turning" },
      { kind: "glue", at: [8, 26, 32.5], size: [4, 7, 7], label: "a drop here too" },
      { kind: "no-glue", at: [24, 26, 32.5], size: [8, 7, 7] },
    ]
    for (const [asm, steps] of [[a, a.steps.map((s) => s.n)], [crowded, [4]]] as const)
      for (const n of steps)
        for (const size of [{ width: 1200, height: 900 }, { width: 600, height: 450 }]) {
          const d = drawStep(asm, insts, n, { ...size, ss: 1 })
          expect(d.labels.print.length, `step ${n}`).toBeGreaterThan(0)
          expect(overlaps(d.labels.print), `print labels, step ${n} at ${size.width}`).toEqual([])
          expect(overlaps(d.labels.view3d), `3D labels, step ${n} at ${size.width}`).toEqual([])
          // the 3D label points are where the boxes were placed (art camera), and the glue ones are set
          d.art.callouts.forEach((c, i) => {
            const [x, y] = project(d.view, c.labelAt)
            const r = d.labels.view3d[i]
            expect(x).toBeCloseTo((r[0] + r[2]) / 2, 3)
            expect(y).toBeCloseTo((r[1] + r[3]) / 2, 3)
          })
          for (const g of d.art.glue) expect(g.labelAt).toBeDefined()
        }
  })

  it("is deterministic", () => {
    const x = drawStep(a, insts, 2, { width: 300, height: 225, ss: 1 })
    const y = drawStep(a, insts, 2, { width: 300, height: 225, ss: 1 })
    expect(x.png.equals(y.png)).toBe(true)
    expect(x.overlay).toBe(y.overlay)
  })
})
