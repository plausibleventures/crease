// R06: one canonical order for nested motions. A lid hinged on a sliding drawer moves with both motions; check_motion,
// the step-art scene, the 3D viewer and the generated studio_assembly_data.scad must pose it the same way:
// assembly.motions order, the first listed applied first (the hinge, then the drawer carries the opened lid).
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Assembly, AssemblyMotion } from "../../shared/types"

const home = mkdtempSync(join(tmpdir(), "printstudio-motion-order-"))
process.env.PRINTSTUDIO_HOME = home
afterAll(() => rmSync(home, { recursive: true, force: true }))

const OPENSCAD = "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD"

// The hinge is listed first (inner), the drawer second (carries the hinge).
const hinge: AssemblyMotion = { id: "hinge", label: "Lid opens", type: "rotate", parts: ["lid"], axis: [1, 0, 0], origin: [0, 20, 10], range: [0, 90] }
const drawer: AssemblyMotion = { id: "drawer", label: "Drawer slides out", type: "translate", parts: ["box", "lid"], axis: [0, -1, 0], range: [0, 50] }
const a: Assembly = {
  parts: [
    { id: "box", qty: 1, color: "white" },
    { id: "lid", qty: 1, color: "blue" },
  ],
  hardware: [],
  tools: [],
  consumables: [],
  steps: [],
  placements: [
    { part: "box", translate: [0, 0, 0] },
    { part: "lid", translate: [0, 0, 10] },
  ],
  motions: [hinge, drawer],
}
const pose = { hinge: 1, drawer: 1 } // fully open and fully out
const lidCentre: [number, number, number] = [0, 10, 1] // a 2 mm cube centred here, in the lid's own frame

/** Canonical answer: hinge 90° about the rest hinge axis, then the drawer moves the lot 50 mm along -Y. */
const expected = (() => {
  const p = [lidCentre[0], lidCentre[1], lidCentre[2] + 10] // placed: (0, 10, 11)
  const [y, z] = [p[1] - 20, p[2] - 10] // about the hinge at (y 20, z 10): rotate +90° about X
  return [p[0], 20 - z - 50, 10 + y] // (0, 20 - 1 - 50, 10 - 10) = (0, -31, 0)
})()

describe("nested motions: one canonical order", () => {
  it("the step-art scene (and the 3D viewer, same order) applies the first-listed motion first", async () => {
    const { placedXf } = await import("./scene")
    const { motionsFor } = await import("./scaddata")
    const ms = motionsFor(a, "lid", 0)
    expect(ms.map((m) => m.id)).toEqual(["hinge", "drawer"])
    const q = placedXf(undefined, [0, 0, 10], ms, pose)(lidCentre)
    q.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 6))
  })

  it("check_motion poses it the same way", async () => {
    const { manifoldWasm, poseOf } = await import("./motion")
    const { motionsFor } = await import("./scaddata")
    const w = await manifoldWasm()
    const cube = w.Manifold.cube([2, 2, 2], true).translate([lidCentre[0], lidCentre[1], lidCentre[2] + 10])
    const posed = poseOf(cube, motionsFor(a, "lid", 0), new Map([["hinge", 90], ["drawer", 50]]))
    const b = posed.boundingBox()
    const c = [0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2)
    c.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 4))
    posed.delete()
    cube.delete()
  })

  it("studio_assembly_data.scad wraps the first-listed motion innermost", async () => {
    const { scadData } = await import("./scaddata")
    expect(scadData(a)).toContain(`if (id == "lid" && i == 0) moving("drawer") moving("hinge") placed(id, i);`)
  })

  it.skipIf(!existsSync(OPENSCAD))("and OpenSCAD renders it where the check and viewer put it", { timeout: 60_000 }, async () => {
    const { scadData } = await import("./scaddata")
    const dir = mkdtempSync(join(tmpdir(), "ps-motion-order-"))
    try {
      writeFileSync(join(dir, "data.scad"), scadData(a))
      writeFileSync(
        join(dir, "main.scad"),
        `include <data.scad>\nmodule part(id) translate(${JSON.stringify(lidCentre)}) cube(2, center = true);\nat("lid");\n`,
      )
      execFileSync(OPENSCAD, ["-o", "out.stl", "--export-format", "asciistl", "-D", "motion_hinge=1", "-D", "motion_drawer=1", "main.scad"], { cwd: dir, stdio: "ignore" })
      const vs = [...readFileSync(join(dir, "out.stl"), "utf8").matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].map((m) => [1, 2, 3].map((k) => Number(m[k])))
      const c = [0, 1, 2].map((i) => (Math.min(...vs.map((v) => v[i])) + Math.max(...vs.map((v) => v[i]))) / 2)
      c.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 3))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
