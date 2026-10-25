// The assembled scene for step art (R14): every placed part instance and placed hardware item as world-space
// triangles (placement, then each motion at rest or at a given pose), with its colour and bounding box.
// Same conventions as check_motion (motion.ts) and the 3D viewer: rotate X, Y, Z then translate; motions in
// assembly coordinates; hardware stands head-up on z = 0 in its own frame.
import type { Assembly, AssemblyHardware, AssemblyMotion, Vec3 } from "../../shared/types"
import { add, axisAngleMatrix, eulerMatrix, instKey, mulMat3, norm, sub } from "../../shared/assembly-art"
import { BRASS, cssRgb, partRgb, RUBBER, STEEL } from "./colors"
import { motionsFor, restValue } from "./scaddata"

export interface Mesh {
  verts: ArrayLike<number>
  tris: ArrayLike<number>
}

export interface Box {
  min: Vec3
  max: Vec3
}

export interface SceneInst {
  key: string // "id#i"
  kind: "part" | "hardware"
  id: string
  index: number
  color: [number, number, number]
  tris: Float32Array // world, 9 floats per triangle
  box: Box
  /** Hardware: its own +Z axis in the world (head-up frame) — it goes in along the opposite way. */
  axis?: Vec3
  hardware?: AssemblyHardware
}

export interface SceneProblem {
  key: string
  reason: string
}

type Xf = (p: Vec3) => Vec3

function motionXf(m: AssemblyMotion, value: number): Xf {
  if (m.type === "rotate") {
    const R = axisAngleMatrix(m.axis, value)
    const o = (m.origin ?? [0, 0, 0]) as Vec3
    return (p) => add(mulMat3(R, sub(p, o)), o)
  }
  const d = norm(m.axis)
  return (p) => [p[0] + d[0] * value, p[1] + d[1] * value, p[2] + d[2] * value]
}

export function placedXf(rotate: readonly number[] | undefined, translate: readonly number[], motions: AssemblyMotion[], pose: Record<string, number>): Xf {
  const R = eulerMatrix(rotate)
  const t = translate as Vec3
  const ms = motions.map((m) => {
    const f = pose[m.id]
    const v = f === undefined ? restValue(m) : m.range[0] + (m.range[1] - m.range[0]) * Math.max(0, Math.min(1, f))
    return motionXf(m, v)
  })
  return (p) => {
    let q = add(mulMat3(R, p), t)
    for (const x of ms) q = x(q)
    return q
  }
}

function bake(mesh: Mesh, xf: Xf): { tris: Float32Array; box: Box } {
  const n = mesh.tris.length / 3
  const out = new Float32Array(n * 9)
  const vcount = mesh.verts.length / 3
  const wv = new Float64Array(vcount * 3)
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (let v = 0; v < vcount; v++) {
    const q = xf([mesh.verts[v * 3], mesh.verts[v * 3 + 1], mesh.verts[v * 3 + 2]])
    for (let k = 0; k < 3; k++) {
      wv[v * 3 + k] = q[k]
      if (q[k] < min[k]) min[k] = q[k]
      if (q[k] > max[k]) max[k] = q[k]
    }
  }
  for (let t = 0; t < n; t++)
    for (let c = 0; c < 3; c++) {
      const v = mesh.tris[t * 3 + c]
      out[t * 9 + c * 3] = wv[v * 3]
      out[t * 9 + c * 3 + 1] = wv[v * 3 + 1]
      out[t * 9 + c * 3 + 2] = wv[v * 3 + 2]
    }
  return { tris: out, box: { min, max } }
}

export function hardwareColor(h: AssemblyHardware): [number, number, number] {
  if (h.color) return cssRgb(h.color)
  if (/black/i.test(h.material ?? "")) return [0.25, 0.26, 0.28]
  if (/brass/i.test(h.material ?? "") || h.type === "heat-set-insert" || h.type === "threaded-insert") return BRASS
  if (h.type === "rubber-foot" || h.type === "o-ring") return RUBBER
  if (h.type === "filament-offcut") return [0.93, 0.92, 0.88]
  if (h.type === "adhesive-strip") return [0.95, 0.95, 0.95]
  return STEEL
}

/** Hardware types the guide never draws (no shape): they appear as pictures in the step's item boxes only. */
export const UNDRAWN_HARDWARE = new Set(["glue", "tape", "zip-tie", "electronics", "other"])

/**
 * Place everything that has a position. `partMesh(id)` = the part's exported mesh (print orientation);
 * `hardwareMesh(h)` = its proxy shape (null when it has none). `pose` = {motionId: 0..1} (others at rest).
 */
export function buildScene(
  a: Assembly,
  partMesh: (id: string) => Mesh | null,
  hardwareMesh: (h: AssemblyHardware) => Mesh | null,
  pose: Record<string, number> = {},
): { insts: SceneInst[]; problems: SceneProblem[] } {
  const insts: SceneInst[] = []
  const problems: SceneProblem[] = []
  for (const p of a.parts) {
    const mesh = partMesh(p.id)
    for (let i = 0; i < Math.max(1, p.qty); i++) {
      const key = instKey(p.id, i)
      const pl = (a.placements ?? []).find((x) => x.part === p.id && (x.instance ?? 0) === i)
      if (!pl) {
        problems.push({ key, reason: "no placement" })
        continue
      }
      if (!mesh) {
        problems.push({ key, reason: "mesh not available" })
        continue
      }
      const { tris, box } = bake(mesh, placedXf(pl.rotate, pl.translate, motionsFor(a, p.id, i), pose))
      insts.push({ key, kind: "part", id: p.id, index: i, color: partRgb(p.color, p.id), tris, box })
    }
  }
  for (const h of a.hardware) {
    for (let i = 0; i < Math.max(1, h.qty); i++) {
      const key = instKey(h.id, i)
      const pl = (a.hardwarePlacements ?? []).find((x) => x.hardware === h.id && (x.instance ?? 0) === i)
      if (!pl) {
        if (!UNDRAWN_HARDWARE.has(h.type)) problems.push({ key, reason: "no hardware placement" })
        continue
      }
      const mesh = hardwareMesh(h)
      if (!mesh) {
        problems.push({ key, reason: "no shape for this hardware" })
        continue
      }
      const [pid, pi] = (pl.movesWith ?? "").split("#")
      const motions = pl.movesWith ? motionsFor(a, pid, Number(pi ?? 0)) : []
      const xf = placedXf(pl.rotate, pl.translate, motions, pose)
      const { tris, box } = bake(mesh, xf)
      const axis = norm(sub(xf([0, 0, 1]), xf([0, 0, 0])))
      insts.push({ key, kind: "hardware", id: h.id, index: i, color: hardwareColor(h), tris, box, axis, hardware: h })
    }
  }
  return { insts, problems }
}
