// Pure helpers shared by the server's step illustrations (server/assembly/illustrate.ts) and the Assembly tab's
// 3D step-through: which step adds each instance, the instance letters, and the orthographic camera math.
// No Node or DOM dependencies.
import type { Assembly, AssemblyStep, Vec3 } from "./types"

export const itemIdOf = (x: string | { id: string }) => (typeof x === "string" ? x : x.id)
export const instKey = (id: string, i: number) => `${id}#${i}`

/** "lid" -> ["lid", null], "clip#1" -> ["clip", 1] */
export function parseRef(ref: string): [string, number | null] {
  const [id, i] = ref.split("#")
  return [id, i === undefined ? null : Number(i)]
}

/**
 * Step that adds each part / hardware instance ("id#i" -> n). Steps consume instances in order: a bare id adds
 * all remaining ones, `{id, qty}` the next qty. Consumables have no instances.
 */
export function instanceSteps(a: Assembly): Map<string, number> {
  const qty = new Map<string, number>()
  for (const p of a.parts) qty.set(p.id, Math.max(1, p.qty))
  for (const h of a.hardware) qty.set(h.id, Math.max(1, h.qty))
  const next = new Map<string, number>()
  const out = new Map<string, number>()
  for (const s of a.steps) {
    for (const x of s.adds) {
      const id = itemIdOf(x)
      const total = qty.get(id)
      if (total === undefined) continue
      const from = next.get(id) ?? 0
      const n = typeof x === "string" ? total - from : x.qty
      for (let i = from; i < Math.min(total, from + n); i++) out.set(instKey(id, i), s.n)
      next.set(id, Math.min(total, from + n))
    }
  }
  return out
}

/** "A", "B", … "Z", "AA", "AB", … (same as the plate labels, server/slicer/placement.ts letterFor). */
export function letterFor(i: number): string {
  let s = ""
  let n = i
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

/** Letter per printed-part instance: assembly.json parts in order, copies in order (A = parts[0]#0). */
export function partLetters(a: Assembly): Map<string, string> {
  const out = new Map<string, string>()
  let k = 0
  for (const p of a.parts) for (let i = 0; i < Math.max(1, p.qty); i++) out.set(instKey(p.id, i), letterFor(k++))
  return out
}

/** ["C","D","E","F"] -> "C–F"; ["A","C"] -> "A, C". Letters must come from letterFor order. */
export function letterRange(letters: string[]): string {
  const idx = (l: string) => [...l].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1
  const sorted = [...new Set(letters)].sort((x, y) => idx(x) - idx(y))
  const out: string[] = []
  for (let k = 0; k < sorted.length; ) {
    let e = k
    while (e + 1 < sorted.length && idx(sorted[e + 1]) === idx(sorted[e]) + 1) e++
    out.push(e - k >= 2 ? `${sorted[k]}–${sorted[e]}` : sorted.slice(k, e + 1).join(", "))
    k = e + 1
  }
  return out.join(", ")
}

/* ---------- vectors ---------- */

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2])
export function norm(a: Vec3): Vec3 {
  const l = len(a)
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1]
}

/** 3x3 rotation (row-major) of OpenSCAD rotate([x, y, z]) = Rz · Ry · Rx. */
export function eulerMatrix(r: readonly number[] | undefined): number[] {
  const [x, y, z] = (r ?? [0, 0, 0]).map((d) => (d * Math.PI) / 180)
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(x), Math.sin(x), Math.cos(y), Math.sin(y), Math.cos(z), Math.sin(z)]
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ]
}
export const mulMat3 = (m: number[], v: readonly number[]): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
]

/** Rotation by `deg` about unit-ish `axis` (Rodrigues), row-major. */
export function axisAngleMatrix(axis: Vec3, deg: number): number[] {
  const [x, y, z] = norm(axis)
  const t = (deg * Math.PI) / 180
  const c = Math.cos(t)
  const s = Math.sin(t)
  const C = 1 - c
  return [
    c + x * x * C, x * y * C - z * s, x * z * C + y * s,
    y * x * C + z * s, c + y * y * C, y * z * C - x * s,
    z * x * C - y * s, z * y * C + x * s, c + z * z * C,
  ]
}

/* ---------- orthographic camera ---------- */

/**
 * Screen mapping of an orthographic view: x = ox + s·(p·right), y = oy − s·(p·up) (SVG/PNG pixels, y down),
 * depth = p·dir (larger = nearer the eye).
 */
export interface OrthoView {
  dir: Vec3 // unit, from the scene toward the eye
  right: Vec3
  up: Vec3
  s: number // px per mm
  ox: number
  oy: number
}

/** Right/up for an eye direction; "up" stays world +Z (world +Y when looking straight down/up). */
export function cameraBasis(dir: Vec3): { dir: Vec3; right: Vec3; up: Vec3 } {
  const d = norm(dir)
  const worldUp: Vec3 = Math.abs(d[2]) > 0.995 ? [0, 1, 0] : [0, 0, 1]
  const right = norm(cross(worldUp, d))
  const up = cross(d, right)
  return { dir: d, right, up }
}

export function project(v: OrthoView, p: Vec3): [number, number, number] {
  return [v.ox + v.s * dot(p, v.right), v.oy - v.s * dot(p, v.up), dot(p, v.dir)]
}

/** Inverse of project for a given depth (mm along dir). */
export function unproject(v: OrthoView, x: number, y: number, depth: number): Vec3 {
  const a = (x - v.ox) / v.s
  const b = (v.oy - y) / v.s
  return add(add(scale(v.right, a), scale(v.up, b)), scale(v.dir, depth))
}

/** Eye direction for azimuth (0 = from the front, -Y; +90 = from the right, +X) and elevation above the horizon. */
export function dirFromAngles(azDeg: number, elDeg: number): Vec3 {
  const az = (azDeg * Math.PI) / 180
  const el = (elDeg * Math.PI) / 180
  return [Math.sin(az) * Math.cos(el), -Math.cos(az) * Math.cos(el), Math.sin(el)]
}

/**
 * Eye direction of an OpenSCAD camera rotation [rx, ry, rz] (assembly.json `view`; [0,0,0] = top, [55,0,25] =
 * the default iso). OpenSCAD views from −Y after rotating the scene by Rx(90−rx)·Ry(−ry)·Rz(−rz).
 */
export function dirFromScadView(view: readonly number[]): Vec3 {
  const [rx, ry, rz] = view
  // eye = (Rx(90-rx) Ry(-ry) Rz(-rz))^T (0,-1,0) = Rz(rz) Ry(ry) Rx(rx-90) (0,-1,0)
  let v: Vec3 = [0, -1, 0]
  v = mulMat3(axisAngleMatrix([1, 0, 0], rx - 90), v)
  v = mulMat3(axisAngleMatrix([0, 1, 0], ry), v)
  v = mulMat3(axisAngleMatrix([0, 0, 1], rz), v)
  return norm(v)
}

/**
 * How far to turn the default view (degrees about Z, a multiple of 90) so it looks at the show faces of face-down
 * pieces: a face-down piece's show face is its plate side (−Z of its own mesh), which its placement may stand up
 * facing back or sideways. 0 when there are none or they lie flat. The camera goes round by this angle: rotate
 * the default eye direction (or the viewer's camera position) by it about Z.
 */
export function showFaceYaw(a: Assembly, faceDownParts: readonly string[]): number {
  const down = new Set(faceDownParts)
  const ns = (a.placements ?? []).filter((p) => down.has(p.part)).map((p) => mulMat3(eulerMatrix(p.rotate), [0, 0, -1]))
  if (!ns.length) return 0
  const sx = ns.reduce((t, n) => t + n[0], 0) / ns.length
  const sy = ns.reduce((t, n) => t + n[1], 0) / ns.length
  if (Math.hypot(sx, sy) < 0.5) return 0 // lying flat (or facing every way): keep the default
  // The default camera looks from −Y: turn it to face the normal's side.
  const deg = (Math.atan2(sy, sx) * 180) / Math.PI + 90
  return ((Math.round(deg / 90) * 90) % 360 + 360) % 360
}

/** `v` turned by `deg` about Z. */
export function turnZ(v: Vec3, deg: number): Vec3 {
  if (!deg) return v
  return mulMat3(axisAngleMatrix([0, 0, 1], deg), v)
}

/** Step lookup by number (null for 0 = finished assembly). */
export const stepOf = (a: Assembly, n: number): AssemblyStep | null => a.steps.find((s) => s.n === n) ?? null
/** Points of a twist arc (270°) around `axis` through `c`. */
export function arcPoints(c: Vec3, axis: Vec3, r: number, n = 36): Vec3[] {
  const a = norm(axis)
  const helper: Vec3 = Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  const u = norm(cross(a, helper))
  const v = cross(a, u)
  const out: Vec3[] = []
  for (let k = 0; k <= n; k++) {
    const t = (k / n) * 1.5 * Math.PI - 0.25 * Math.PI
    out.push(add(c, add(scale(u, r * Math.cos(t)), scale(v, r * Math.sin(t)))))
  }
  return out
}

/* ---------- label placement (R14) ---------- */

/** Screen-space box: [left, top, right, bottom] in px (y down). */
export type Rect = [number, number, number, number]

export const rectsOverlap = (a: Rect, b: Rect, pad = 0): boolean => a[0] < b[2] + pad && b[0] < a[2] + pad && a[1] < b[3] + pad && b[1] < a[3] + pad

const overlapArea = (a: Rect, b: Rect): number => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))

/**
 * Candidate top-left corners for a w×h label around an anchor point: rings of growing distance, the preferred
 * direction (unit [dx, dy], e.g. away from the drawing's centre) first, then the others by how close they are to it.
 */
export function labelCandidates(ax: number, ay: number, w: number, h: number, prefer: [number, number], step: number, rings = 6): [number, number][] {
  const dirs: [number, number][] = [[1, 0], [-1, 0], [0, -1], [0, 1], [0.7, -0.7], [-0.7, -0.7], [0.7, 0.7], [-0.7, 0.7]]
  const pl = Math.hypot(prefer[0], prefer[1]) || 1
  const p: [number, number] = [prefer[0] / pl, prefer[1] / pl]
  dirs.sort((a, b) => b[0] * p[0] + b[1] * p[1] - (a[0] * p[0] + a[1] * p[1]))
  const out: [number, number][] = []
  for (let r = 1; r <= rings; r++) {
    const d = step * r
    for (const [dx, dy] of dirs) {
      // the box sits on the side of the anchor it points to, centred across that direction
      const cx = ax + dx * (d + w / 2)
      const cy = ay + dy * (d + h / 2)
      out.push([cx - w / 2, cy - h / 2])
    }
  }
  return out
}

/**
 * Greedy collision-avoiding label placement. Labels are placed in order; each takes its first candidate whose box
 * stays inside `bounds` and clears `fixed` and every label placed before it (with `pad` between boxes). If none
 * does, it takes the candidate with the least overlap (out of bounds counts as overlap).
 */
export function placeLabels(labels: { w: number; h: number; candidates: [number, number][] }[], fixed: Rect[], bounds: Rect, pad = 4): Rect[] {
  const placed: Rect[] = []
  for (const l of labels) {
    let best: Rect | null = null
    let bestCost = Infinity
    for (const [x, y] of l.candidates) {
      const r: Rect = [x, y, x + l.w, y + l.h]
      const outside = l.w * l.h - overlapArea(r, bounds)
      const grown: Rect = [r[0] - pad / 2, r[1] - pad / 2, r[2] + pad / 2, r[3] + pad / 2]
      const hits = [...fixed, ...placed].reduce((t, b) => t + overlapArea(grown, [b[0] - pad / 2, b[1] - pad / 2, b[2] + pad / 2, b[3] + pad / 2]), 0)
      const cost = hits + outside * 2
      if (cost < bestCost) {
        best = r
        bestCost = cost
        if (cost === 0) break
      }
    }
    placed.push(best ?? [0, 0, l.w, l.h])
  }
  return placed
}
