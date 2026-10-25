import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Assembly, AssemblyHardware, AssemblyMotion } from "../../shared/types"

// PRINTSTUDIO_HOME must be set before server/config is imported (motion.ts pulls in the CAD module).
const home = mkdtempSync(join(tmpdir(), "printstudio-motion-"))
process.env.PRINTSTUDIO_HOME = home
afterAll(() => rmSync(home, { recursive: true, force: true }))

const asm = (over: Partial<Assembly>): Assembly => ({ parts: [], hardware: [], tools: [], consumables: [], steps: [], ...over })

// A 40 mm arm that swings 0–90° about Z, and a thin post standing at 45° on its path: they only meet between about
// 42° and 48°, which falls between the 8 evenly spaced positions (38.6° and 51.4°) of the old check.
const armMotion: AssemblyMotion = { id: "swing", label: "Arm swings", type: "rotate", parts: ["arm"], axis: [0, 0, 1], origin: [0, 0, 0], range: [0, 90] }
async function armAndPost() {
  const { manifoldWasm, testBody } = await import("./motion")
  const w = await manifoldWasm()
  const arm = w.Manifold.cube([40, 2, 4]).translate([5, -1, -2])
  const r = 30
  const post = w.Manifold.cylinder(10, 0.75, 0.75, 24, true).translate([r * Math.cos(Math.PI / 4), r * Math.sin(Math.PI / 4), 0])
  const a = asm({ parts: [{ id: "arm", qty: 1, color: "red" }, { id: "post", qty: 1, color: "blue" }], motions: [armMotion] })
  return { w, a, bodies: [testBody("arm", arm, [armMotion]), testBody("post", post)] }
}

describe("adaptive motion sampling", () => {
  it("misses the narrow collision with 8 evenly spaced positions", async () => {
    const { checkBodies } = await import("./motion")
    const { a, bodies } = await armAndPost()
    const r = checkBodies(a, bodies, { coarse: 8, adaptive: false })
    expect(r.motions[0].samples).toHaveLength(8)
    expect(r.ok).toBe(true) // the blind spot this change fixes
    expect(r.motions[0].text).toMatch(/^No collisions found in 8 positions from 0° to 90°/)
  })

  it("finds it by refining between positions where the clearance is too small to rule a hit out", async () => {
    const { checkBodies } = await import("./motion")
    const { a, bodies } = await armAndPost()
    const r = checkBodies(a, bodies, { coarse: 8 })
    expect(r.ok).toBe(false)
    expect(r.status).toBe("problems")
    const m = r.motions[0]
    expect(m.collisions).toHaveLength(1)
    expect(m.collisions[0]).toMatchObject({ a: "arm", b: "post" })
    for (const v of m.collisions[0].atValues) {
      expect(v).toBeGreaterThan(41)
      expect(v).toBeLessThan(49)
    }
    expect(m.coverage.coarse).toBe(8)
    expect(m.coverage.refined).toBeGreaterThan(0)
    expect(m.coverage.positions).toBeLessThanOrEqual(48)
    expect(m.freeRange?.[0]).toBe(0)
    expect(m.freeRange![1]).toBeLessThan(45)
    expect(m.text).toMatch(/arm hits post at .*° \(checked \d+ positions from 0° to 90°\)/)
    expect(r.summary).toMatch(/^PROBLEMS/)
  })

  it("reports the smallest gap and where, and stays within the pose budget", async () => {
    const { checkBodies, manifoldWasm, testBody } = await import("./motion")
    const w = await manifoldWasm()
    // Same arm, post moved just outside its reach: never touches, closest at 45°.
    const arm = w.Manifold.cube([40, 2, 4]).translate([5, -1, -2])
    const post = w.Manifold.cylinder(10, 0.75, 0.75, 24, true).translate([47 * Math.cos(Math.PI / 4), 47 * Math.sin(Math.PI / 4), 0])
    const a = asm({ parts: [{ id: "arm", qty: 1, color: "red" }, { id: "post", qty: 1, color: "blue" }], motions: [armMotion] })
    const r = checkBodies(a, [testBody("arm", arm, [armMotion]), testBody("post", post)], { maxPositions: 20 })
    expect(r.status).toBe("ok")
    const m = r.motions[0]
    expect(m.coverage.positions).toBeLessThanOrEqual(20)
    expect(m.minClearanceMm).toBeGreaterThan(0.5)
    expect(m.minClearanceMm).toBeLessThan(2)
    expect(m.clearancePair).toEqual(["arm", "post"])
    expect(Math.abs(m.clearanceAt! - 45)).toBeLessThan(6)
    expect(m.text).toMatch(/^No collisions found in \d+ positions from 0° to 90°; closest gap/)
    expect(r.summary).not.toMatch(/moves freely over/)
    expect(m.text).not.toMatch(/freely/)
    expect(r.notChecked.join(" ")).toMatch(/strength/)
    expect(r.notChecked.join(" ")).toMatch(/friction/)
  })
})

describe("combined motions", () => {
  it("poses two moves that can meet together at the ends of their ranges", async () => {
    const { checkBodies, manifoldWasm, testBody } = await import("./motion")
    const w = await manifoldWasm()
    const left: AssemblyMotion = { id: "left", label: "Left latch slides", type: "translate", parts: ["l"], axis: [1, 0, 0], range: [0, 15] }
    const right: AssemblyMotion = { id: "right", label: "Right latch slides", type: "translate", parts: ["r"], axis: [-1, 0, 0], range: [0, 15] }
    const a = asm({ parts: [{ id: "l", qty: 1, color: "red" }, { id: "r", qty: 1, color: "blue" }], motions: [left, right] })
    const bodies = [testBody("l", w.Manifold.cube([10, 5, 5]), [left]), testBody("r", w.Manifold.cube([10, 5, 5]).translate([30, 0, 0]), [right])]
    const r = checkBodies(a, bodies)
    // Each alone is fine...
    expect(r.motions.every((m) => m.ok)).toBe(true)
    // ...but both slid out at once they meet.
    expect(r.combined).toHaveLength(1)
    expect(r.combined[0].ok).toBe(false)
    expect(r.combined[0].label).toBe("Left latch slides at 15 mm + Right latch slides at 15 mm")
    expect(r.status).toBe("problems")
    expect(r.summary).toMatch(/Together \(each at the ends of its range\): 1 combination checked, 1 with collisions/)
    expect(r.summary).toMatch(/Each move was checked with the other moves at rest, plus the combinations above/)
  })
})

describe("incomplete results", () => {
  const cubeMesh = async (size: number) => {
    const { manifoldWasm } = await import("./motion")
    const w = await manifoldWasm()
    const m = w.Manifold.cube([size, size, size])
    const mesh = m.getMesh()
    m.delete()
    return { verts: Array.from(mesh.vertProperties), tris: Array.from(mesh.triVerts) }
  }
  const lidMotion: AssemblyMotion = { id: "lid", label: "Lid opens", type: "rotate", parts: ["lid"], axis: [1, 0, 0], origin: [0, 0, 10], range: [0, 90] }

  it("a part without a placement makes the check incomplete, not ok", async () => {
    const { checkMotion } = await import("./motion")
    const a = asm({
      parts: [{ id: "base", qty: 1, color: "red" }, { id: "lid", qty: 1, color: "blue" }],
      placements: [{ part: "base", translate: [0, 0, 0] }],
      motions: [lidMotion],
    })
    const r = await checkMotion("unused", a, { loadMesh: () => cubeMesh(10) })
    expect(r.ok).toBe(false)
    expect(r.status).toBe("incomplete")
    expect(r.incomplete.join("\n")).toMatch(/"lid" has no position/)
    expect(r.incomplete.join("\n")).toMatch(/"Lid opens" doesn't move any part/)
    expect(r.scope.parts).toEqual(["base"])
    expect(r.scope.skipped).toEqual([{ id: "lid", reason: "no position given" }])
    expect(r.summary).toMatch(/^INCOMPLETE/)
    expect(r.summary).toMatch(/don't tell the user it moves freely/)
  })

  it("no placements at all, a part that isn't a closed solid, or one that fails to load: incomplete", async () => {
    const { checkMotion } = await import("./motion")
    const parts = [{ id: "base", qty: 1, color: "red" }, { id: "lid", qty: 1, color: "blue" }]
    const none = await checkMotion("unused", asm({ parts, motions: [lidMotion] }), { loadMesh: () => cubeMesh(10) })
    expect(none.status).toBe("incomplete")
    expect(none.incomplete[0]).toMatch(/no positions yet/)

    const placements = [{ part: "base", translate: [0, 0, 0] as [number, number, number] }, { part: "lid", translate: [0, 0, 10] as [number, number, number] }]
    const open = await checkMotion("unused", asm({ parts, placements, motions: [lidMotion] }), {
      loadMesh: async (id) => (id === "lid" ? { verts: [0, 0, 0, 1, 0, 0, 0, 1, 0], tris: [0, 1, 2] } : cubeMesh(10)),
    })
    expect(open.status).toBe("incomplete")
    expect(open.incomplete.join("\n")).toMatch(/Part "lid" (isn't a closed solid|couldn't be loaded)/)

    const failed = await checkMotion("unused", asm({ parts, placements, motions: [lidMotion] }), {
      loadMesh: async (id) => {
        if (id === "lid") throw new Error("render failed: syntax error")
        return cubeMesh(10)
      },
    })
    expect(failed.status).toBe("incomplete")
    expect(failed.incomplete.join("\n")).toMatch(/Part "lid" couldn't be loaded for the check: render failed/)
  })
})

describe("hardware proxies", () => {
  const hw = (h: Partial<AssemblyHardware>): AssemblyHardware => ({ id: "h", type: "other", qty: 1, ...h }) as AssemblyHardware

  it("sizes simple shapes from the hardware metadata", async () => {
    const { manifoldWasm } = await import("./motion")
    const { hardwareProxy } = await import("./proxies")
    const w = await manifoldWasm()
    const box = (h: AssemblyHardware) => {
      const p = hardwareProxy(w, h)
      if (!p.mesh) throw new Error(p.reason)
      const b = p.mesh.boundingBox()
      const vol = p.mesh.volume()
      p.mesh.delete()
      return { size: [0, 1, 2].map((i) => +(b.max[i] - b.min[i]).toFixed(2)), minZ: +b.min[2].toFixed(2), vol }
    }
    // M3x10 socket head: 3 mm shank 10 mm long, head 5.5 x 3 on top.
    const screw = box(hw({ type: "screw", size: "M3x10", head: "socket" }))
    expect(screw.size[2]).toBeCloseTo(13, 1)
    expect(screw.size[0]).toBeCloseTo(5.5, 1)
    expect(screw.minZ).toBe(0)
    // 6 x 3 disc magnet
    const mag = box(hw({ type: "magnet", magnet: { shape: "disc", diaMm: 6, thicknessMm: 3 } }))
    expect(mag.size[2]).toBeCloseTo(3, 2)
    expect(mag.vol).toBeGreaterThan(0.95 * Math.PI * 9 * 3 * 0.97)
    // 608 bearing: 22 OD ring, 8 bore, 7 wide
    const brg = box(hw({ type: "bearing", bearing: { designation: "608", boreMm: 8, outerDiaMm: 22, widthMm: 7 } }))
    expect(brg.size[0]).toBeCloseTo(22, 0)
    expect(brg.size[2]).toBeCloseTo(7, 2)
    expect(brg.vol).toBeLessThan(Math.PI * 11 * 11 * 7) // hollow
    // Spring at its free length
    const spr = box(hw({ type: "spring", spring: { kind: "compression", wireDiaMm: 0.5, outerDiaMm: 6, freeLengthMm: 15 } }))
    expect(spr.size[2]).toBeCloseTo(15, 2)
    // Pins / filament offcuts
    expect(box(hw({ type: "dowel-pin", size: "3x60" })).size[2]).toBeCloseTo(60, 2)
    expect(box(hw({ type: "filament-offcut", size: "1.75x40" })).size[0]).toBeCloseTo(1.75, 1)
    // No size, no shape: a plain reason instead
    const p = hardwareProxy(w, hw({ type: "electronics" }))
    expect(p.mesh).toBeNull()
    expect(p.mesh === null && p.reason).toMatch(/no simple shape for electronics/)
  })

  it("includes placed hardware in the sweep; hardware that moves with a part travels with it", async () => {
    const { checkMotion, manifoldWasm } = await import("./motion")
    const w = await manifoldWasm()
    const meshOf = (m: InstanceType<typeof w.Manifold>) => {
      const mesh = m.getMesh()
      m.delete()
      return { verts: Array.from(mesh.vertProperties), tris: Array.from(mesh.triVerts) }
    }
    const a = asm({
      parts: [{ id: "arm", qty: 1, color: "red" }],
      hardware: [
        { id: "screw", type: "screw", qty: 2, size: "M3x10", head: "socket" },
        { id: "magnet", type: "magnet", qty: 1, magnet: { shape: "disc", diaMm: 6, thicknessMm: 3 } },
        { id: "board", type: "electronics", qty: 1 },
      ],
      placements: [{ part: "arm", translate: [0, 0, 0] }],
      motions: [armMotion],
      hardwarePlacements: [
        { hardware: "screw", instance: 0, translate: [21.2, 21.2, -5] }, // stands in the arm's path at 45°
        { hardware: "screw", instance: 1, translate: [20, 0, -5], movesWith: "arm" }, // through the arm, rides along
      ],
    })
    const r = await checkMotion("unused", a, { loadMesh: async () => meshOf(w.Manifold.cube([40, 2, 4]).translate([5, -1, -2])) })
    expect(r.scope.hardware).toEqual(["screw#0", "screw#1"])
    expect(r.scope.skipped).toEqual([
      { id: "magnet", reason: "no position given" },
      { id: "board", reason: "no position given" },
    ])
    const m = r.motions[0]
    expect(m.collisions.map((c) => `${c.a}|${c.b}`)).toEqual(["arm|screw#0"]) // screw#1 rides with the arm
    expect(r.restCollisions.some((c) => [c.a, c.b].includes("screw#1"))).toBe(true) // through the solid test arm
    expect(r.summary).toMatch(/Included: arm, screw#0, screw#1\. Not included: magnet \(no position given\); board \(no position given\)/)
  })

  it("placed hardware that can't be modelled makes the result incomplete", async () => {
    const { checkMotion, manifoldWasm } = await import("./motion")
    const w = await manifoldWasm()
    const c = w.Manifold.cube([40, 2, 4]).translate([5, -1, -2])
    const mesh = c.getMesh()
    c.delete()
    const a = asm({
      parts: [{ id: "arm", qty: 1, color: "red" }],
      hardware: [{ id: "board", type: "electronics", qty: 1 }],
      placements: [{ part: "arm", translate: [0, 0, 0] }],
      motions: [armMotion],
      hardwarePlacements: [{ hardware: "board", translate: [0, 50, 0] }],
    })
    const r = await checkMotion("unused", a, { loadMesh: async () => ({ verts: Array.from(mesh.vertProperties), tris: Array.from(mesh.triVerts) }) })
    expect(r.status).toBe("incomplete")
    expect(r.incomplete.join("\n")).toMatch(/Couldn't make a shape for .*"board".*no simple shape for electronics/)
  })
})

describe("hardwarePlacements validation", () => {
  it("checks ids, instances and movesWith", async () => {
    const { validateAssembly } = await import("./schema")
    const a = {
      parts: [{ id: "lid", qty: 1, color: "red" }],
      hardware: [{ id: "screw", type: "screw", qty: 2, size: "M3x10", purchaseHint: "M3x10" }],
      steps: [{ n: 1, title: "x", adds: ["lid", "screw"], text: "Do it.", check: "ok" }],
      placements: [{ part: "lid", translate: [0, 0, 0] }],
      hardwarePlacements: [
        { hardware: "screw", instance: 0, translate: [0, 0, 0], movesWith: "lid" },
        { hardware: "screw", instance: 0, translate: [1, 0, 0] },
        { hardware: "screw", instance: 2, translate: [1, 0, 0] },
        { hardware: "nope", translate: [1, 0, 0] },
        { hardware: "screw", instance: 1, translate: [1, 0, 0], movesWith: "base" },
      ],
    }
    const e = validateAssembly(a, ["lid"]).errors.join("\n")
    expect(e).toMatch(/"screw#0" is placed twice/)
    expect(e).toMatch(/"screw" instance 2 but qty is 2/)
    expect(e).toMatch(/unknown hardware "nope"/)
    expect(e).toMatch(/movesWith unknown part "base"/)
  })
})
