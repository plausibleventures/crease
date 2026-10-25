// R14: deterministic, geometry-based step art. For each step: the parts already assembled (muted), the parts being
// added (in colour, pulled back along their insertion direction), a camera chosen to show that direction, and typed
// overlays computed in 3D and projected to 2D: insertion arrows (straight / slide / push / snap / twist / screw),
// callouts with leader lines to the actual instances (part letters as on the plates), hatched glue / no-glue regions
// and a close-up inset when the joint is small. The 3D plan (StepArt) also drives the app's 3D step-through.
import type {
  ArtArrow,
  ArtCallout,
  ArtGlue,
  ArtInstance,
  Assembly,
  AssemblyStep,
  StepAction,
  StepArt,
  Vec3,
} from "../../shared/types"
import {
  arcPoints,
  add,
  cameraBasis,
  cross,
  dirFromAngles,
  dirFromScadView,
  dot,
  instanceSteps,
  instKey,
  labelCandidates,
  len,
  letterRange,
  norm,
  parseRef,
  partLetters,
  placeLabels,
  project,
  scale,
  stepOf,
  sub,
  unproject,
  type OrthoView,
  type Rect,
} from "../../shared/assembly-art"
import { hardwareName } from "./hardware"
import { encodePng, rasterIds, rasterize, type RasterMesh, type RasterResult } from "./raster"
import type { Box, SceneInst } from "./scene"

export const ART_VERSION = 4 // 2: collision-free labels (print + 3D); 3: face-down show faces, dark colours lifted, studio hero; 4: filament tones
export const STEP_SIZE: [number, number] = [1200, 900]
export const DEFAULT_VIEW: Vec3 = dirFromScadView([55, 0, 25])

const GUTTER = 236 // label column each side (px at 1200 wide)
const MARGIN = 44
const INK = "#16171a"
const MUTED_INK = "#8d929b"
const GLUE = "#c98a00"
const NO_GLUE = "#d0342c"

/* ---------- small geometry ---------- */

const center = (b: Box): Vec3 => scale(add(b.min, b.max), 0.5)
const size = (b: Box): Vec3 => sub(b.max, b.min)
const vol = (b: Box) => Math.max(0, size(b)[0]) * Math.max(0, size(b)[1]) * Math.max(0, size(b)[2])
const diag = (b: Box) => len(size(b))
const moveBox = (b: Box, d: Vec3): Box => ({ min: add(b.min, d), max: add(b.max, d) })
const unionBox = (a: Box | null, b: Box): Box =>
  a ? { min: a.min.map((v, i) => Math.min(v, b.min[i])) as Vec3, max: a.max.map((v, i) => Math.max(v, b.max[i])) as Vec3 } : b
function overlap(a: Box, b: Box): number {
  let v = 1
  for (let i = 0; i < 3; i++) {
    const d = Math.min(a.max[i], b.max[i]) - Math.max(a.min[i], b.min[i])
    if (d <= 0) return 0
    v *= d
  }
  return v
}
const expand = (b: Box, k: number): Box => ({ min: b.min.map((v) => v - k) as Vec3, max: b.max.map((v) => v + k) as Vec3 })
/** Half the box's extent along unit direction d. */
const halfExtent = (b: Box, d: Vec3) => 0.5 * size(b).reduce((s, v, i) => s + Math.abs(v * d[i]), 0)
const corners = (b: Box): Vec3[] =>
  [0, 1, 2, 3, 4, 5, 6, 7].map((k) => [k & 1 ? b.max[0] : b.min[0], k & 2 ? b.max[1] : b.min[1], k & 4 ? b.max[2] : b.min[2]])
const angleBetween = (a: Vec3, b: Vec3) => Math.acos(Math.max(-1, Math.min(1, dot(norm(a), norm(b)))))

function translated(tris: Float32Array, d: Vec3): Float32Array {
  if (!d[0] && !d[1] && !d[2]) return tris
  const out = new Float32Array(tris.length)
  for (let k = 0; k < tris.length; k += 3) {
    out[k] = tris[k] + d[0]
    out[k + 1] = tris[k + 1] + d[1]
    out[k + 2] = tris[k + 2] + d[2]
  }
  return out
}

/* ---------- step roles and insertion ---------- */

const AXES: Vec3[] = [
  [0, 0, -1],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
]

/**
 * Insertion direction from the placements: the axis direction along which the item can come in while its swept
 * bounding box overlaps the already-assembled parts least (beyond what it overlaps once seated). Ties prefer
 * coming down from above, then sideways, then up from below.
 */
export function inferInsert(item: Box, done: Box[], reach: number): Vec3 {
  let best: Vec3 = [0, 0, -1]
  let bestCost = Infinity
  AXES.forEach((e, rank) => {
    const exploded = moveBox(item, scale(e, -reach))
    const swept = unionBox(item, exploded)
    let cost = 0
    for (const d of done) cost += Math.max(0, overlap(swept, d) - overlap(item, d))
    const score = cost + rank * 1e-6 * (vol(item) + 1)
    if (score < bestCost) {
      bestCost = score
      best = e
    }
  })
  return best
}

const PUSH_TYPES = new Set(["magnet", "heat-set-insert", "threaded-insert", "rubber-foot", "adhesive-strip", "wall-anchor", "bearing"])
const SLIDE_TYPES = new Set(["rod", "dowel-pin", "filament-offcut"])

export function defaultAction(s: AssemblyStep | null, inst: SceneInst): StepAction {
  const t = inst.hardware?.type
  if (t === "screw" || t === "bolt") return "screw"
  if (s?.action) return s.action
  if (t && PUSH_TYPES.has(t)) return "push"
  if (t && SLIDE_TYPES.has(t)) return "insert"
  return "insert"
}

export interface Mover {
  inst: SceneInst
  insert: Vec3
  dist: number
  offset: Vec3
  action: StepAction
}

export interface StepRoles {
  role: Map<string, ArtInstance["role"]>
  movers: Mover[]
  focusArrows: Mover[] // focus items the step's action is drawn on (they don't move)
  allPlain: boolean // nothing new or focused: draw everything in colour
}

/** Who is new / done / hidden in step n, and how each new item moves in. */
export function stepRoles(a: Assembly, scene: SceneInst[], n: number, explode = 1): StepRoles {
  const steps = instanceSteps(a)
  const s = n ? stepOf(a, n) : null
  const role = new Map<string, ArtInstance["role"]>()
  const focus = new Set<string>()
  for (const ref of s?.focus ?? []) {
    const [id, i] = parseRef(ref)
    for (const x of scene) if (x.id === id && (i === null || x.index === i)) focus.add(x.key)
  }
  for (const x of scene) {
    const at = steps.get(x.key) ?? 0 // never added: there from the start
    role.set(x.key, n === 0 ? "done" : at > n ? "hidden" : at === n ? "new" : focus.has(x.key) ? "focus" : "done")
  }
  const news = scene.filter((x) => role.get(x.key) === "new")
  const done = scene.filter((x) => role.get(x.key) === "done" || role.get(x.key) === "focus")
  const allPlain = n === 0 || (!news.length && !focus.size)
  // With nothing assembled yet, the biggest new part is the base the others go onto: it stays put.
  let base: SceneInst | null = null
  if (!done.length && news.length) {
    const parts = news.filter((x) => x.kind === "part")
    base = (parts.length ? parts : news).reduce((m, x) => (vol(x.box) > vol(m.box) ? x : m))
  }
  const sceneBox = scene.reduce<Box | null>((b, x) => unionBox(b, x.box), null)
  const sceneDiag = sceneBox ? diag(sceneBox) : 100
  const staying = [...done, ...(base ? [base] : [])].map((x) => x.box)
  const movers: Mover[] = []
  for (const x of news) {
    if (x === base) continue
    const insert = insertFor(s, x, staying, sceneDiag)
    const ext = halfExtent(x.box, insert)
    const dist = s?.explodeDistance !== undefined ? Math.max(s.explodeDistance, ext + 4) : 2 * ext + Math.max(12, 0.14 * sceneDiag)
    movers.push({ inst: x, insert, dist, offset: scale(insert, -dist * explode), action: defaultAction(s, x) })
  }
  const focusArrows: Mover[] = []
  if (!movers.length && s?.action && s.action !== "place") {
    for (const x of scene.filter((y) => focus.has(y.key))) {
      const insert = s.insert ? norm(s.insert) : s.explodeDirection ? norm(scale(s.explodeDirection, -1)) : ([0, 0, -1] as Vec3)
      focusArrows.push({ inst: x, insert, dist: 0, offset: [0, 0, 0], action: s.action })
    }
  }
  return { role, movers, focusArrows, allPlain }
}

function insertFor(s: AssemblyStep | null, x: SceneInst, staying: Box[], sceneDiag: number): Vec3 {
  if (s?.insert) return norm(s.insert)
  if (s?.explodeDirection) return norm(scale(s.explodeDirection, -1))
  if (x.axis) return scale(x.axis, -1)
  return inferInsert(x.box, staying, Math.max(10, sceneDiag * 0.3))
}

/* ---------- arrows in 3D ---------- */

/** The arrow for one moving item: in the gap between the lifted item and its seat, or behind it when it is
 *  only partly out (long pins). `minLen` mm keeps it readable. */
export function moverArrow(m: Mover, minLen: number): ArtArrow {
  const ins = m.insert
  const c = add(center(m.inst.box), m.offset) // exploded centre
  const ext = halfExtent(m.inst.box, ins)
  const gap = m.dist - 2 * ext
  const g = Math.max(1.5, minLen * 0.12)
  let from: Vec3
  let to: Vec3
  if (m.dist > 0 && gap >= minLen + 2 * g) {
    from = add(c, scale(ins, ext + g)) // just past the lifted item's leading face
    to = add(c, scale(ins, ext + gap - g)) // just short of where its trailing face ends up
  } else {
    const L = Math.max(minLen, Math.min(gap > 0 ? gap : 0, minLen * 2))
    to = add(c, scale(ins, -(ext + g)))
    from = add(to, scale(ins, -L))
  }
  const arrow: ArtArrow = { kind: m.action, from, to, targets: [m.inst.key] }
  if (m.action === "twist" || m.action === "screw") {
    const radial = radialExtent(m.inst.box, ins)
    arrow.axis = ins
    arrow.center = m.action === "screw" ? add(c, scale(ins, -ext * 0.6)) : c
    arrow.radius = Math.max(minLen * 0.45, m.action === "screw" ? radial * 1.6 : radial * 0.75)
  }
  return arrow
}

const radialExtent = (b: Box, axis: Vec3) => {
  const s3 = size(b)
  const along = halfExtent(b, axis)
  return Math.max(0.5, Math.sqrt(Math.max(0, (s3[0] ** 2 + s3[1] ** 2 + s3[2] ** 2) / 4 - along ** 2)) * 0.75)
}

/* ---------- camera ---------- */

function unitView(dir: Vec3): OrthoView {
  const b = cameraBasis(dir)
  return { ...b, s: 1, ox: 0, oy: 0 }
}

function fitView(dir: Vec3, pts: Vec3[], area: [number, number, number, number]): OrthoView {
  const v = unitView(dir)
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const p of pts) {
    const [x, y] = project(v, p)
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  const [ax0, ay0, ax1, ay1] = area
  const s = Math.min((ax1 - ax0) / Math.max(1e-6, x1 - x0), (ay1 - ay0) / Math.max(1e-6, y1 - y0))
  return { ...v, s, ox: (ax0 + ax1) / 2 - s * ((x0 + x1) / 2), oy: (ay0 + ay1) / 2 - s * ((y0 + y1) / 2) }
}

const vertsOf = (tris: Float32Array, off: Vec3, step = 1): Vec3[] => {
  const out: Vec3[] = []
  for (let k = 0; k + 2 < tris.length; k += 3 * step) out.push([tris[k] + off[0], tris[k + 1] + off[1], tris[k + 2] + off[2]])
  return out
}

export interface CameraChoice {
  dir: Vec3
  auto: boolean
  score?: number
}

/**
 * Pick the view: the step's own `view` when given; otherwise the candidate (12 azimuths x 3 elevations) that best
 * shows the new items (unoccluded), their insertion directions (not end-on) and where they go, staying close to
 * the previous step's view (or the default iso) so the build doesn't jump around.
 */
export function chooseCamera(a: Assembly, scene: SceneInst[], n: number, roles: StepRoles, prev: Vec3 | null, home: Vec3 = DEFAULT_VIEW): CameraChoice {
  const s = n ? stepOf(a, n) : null
  if (s?.view) return { dir: dirFromScadView(s.view), auto: false }
  const prefer = prev ?? home
  const movers = [...roles.movers, ...roles.focusArrows]
  if (!movers.length) return { dir: prefer, auto: true }
  const visible = scene.filter((x) => roles.role.get(x.key) !== "hidden")
  const off = new Map(roles.movers.map((m) => [m.inst.key, m.offset]))
  const meshes: RasterMesh[] = visible.map((x) => ({ tris: translated(x.tris, off.get(x.key) ?? [0, 0, 0]), color: x.color, style: "plain" }))
  const idxOf = new Map(visible.map((x, i) => [x.key, i]))
  const pts = visible.flatMap((x) => corners(moveBox(x.box, off.get(x.key) ?? [0, 0, 0])))
  // sample points inside each moving item (works for thin pins as well as big parts)
  const sceneBox = visible.reduce<Box | null>((u, x) => unionBox(u, x.box), null)
  const allow = sceneBox ? 0.04 * diag(sceneBox) : 4
  const inside = (b: Box): Vec3[] => {
    const c = center(b)
    const h = scale(size(b), 0.35)
    const ps: Vec3[] = [c]
    for (let ax = 0; ax < 3; ax++)
      for (const sg of [-1, 1]) {
        const p: Vec3 = [...c]
        p[ax] += sg * h[ax]
        ps.push(p)
      }
    return ps
  }
  const thick = (b: Box) => 1 + 0.5 * Math.min(...size(b))
  // the lifted items themselves...
  const samples = movers.flatMap((m) => {
    const b = moveBox(m.inst.box, m.offset)
    return inside(b).map((p) => ({ p, tol: thick(b), own: idxOf.get(m.inst.key) ?? -1 }))
  })
  // ...and where they go (seated position, not drawn) + glue regions: other parts must not hide them
  const seats = [
    ...movers.flatMap((m) => inside(m.inst.box).map((p) => ({ p, tol: thick(m.inst.box) + allow }))),
    ...(s?.glue ?? []).map((g) => ({ p: g.at as Vec3, tol: 1 + 0.5 * Math.min(...g.size) + allow })),
  ]
  const W = 200
  const H = 150
  let best: CameraChoice = { dir: prefer, auto: true, score: -Infinity }
  for (const el of [22, 38, 54]) {
    for (const az of [-160, -135, -110, -70, -45, -20, 20, 45, 70, 110, 135, 160]) {
      const dir = dirFromAngles(az, el)
      const v = fitView(dir, pts, [8, 8, W - 8, H - 8])
      const all = rasterIds(meshes, v, W, H)
      let seen = 0
      for (const q of samples) {
        const [px, py, pz] = project(v, q.p)
        const i = Math.floor(py) * W + Math.floor(px)
        if (i < 0 || i >= W * H || px < 0 || px >= W) continue
        if (all.id[i] === q.own || all.depth[i] <= pz + q.tol) seen++
      }
      const vis = samples.length ? seen / samples.length : 0
      let target = 0
      for (const q of seats) {
        const [px, py, pz] = project(v, q.p)
        const i = Math.floor(py) * W + Math.floor(px)
        const d = i >= 0 && i < W * H && px >= 0 && px < W ? all.depth[i] : -Infinity
        if (d <= pz + q.tol) target++
      }
      target = seats.length ? target / seats.length : 1
      let ins = 0
      for (const m of movers) ins += Math.min(1, Math.sqrt(Math.max(0, 1 - dot(m.insert, dir) ** 2)) / 0.8)
      ins /= movers.length
      // stay near the previous view so the build doesn't jump around (cameras from below are never offered)
      const prior = angleBetween(dir, prefer) / Math.PI
      const score = 1.5 * vis + 1.2 * ins + 2 * target - 1.0 * prior
      if (score > (best.score ?? -Infinity) + 1e-9) best = { dir, auto: true, score }
    }
  }
  return best
}

/* ---------- the drawing ---------- */

export interface DrawOptions {
  width?: number
  height?: number
  prevDir?: Vec3 | null
  home?: Vec3 // the view with no previous one (default DEFAULT_VIEW; turned round to face-down show faces)
  explode?: number // 0..1 (default 1)
  pose?: Record<string, number>
  ss?: number // supersampling (default 2)
  overlays?: boolean // default true
}

export interface StepDrawing {
  art: Omit<StepArt, "image" | "svg">
  raster: RasterResult
  png: Buffer
  overlay: string // <g>…</g> overlay elements (image pixel coordinates)
  defs: string // <defs> content the overlay uses
  width: number
  height: number
  view: OrthoView
  /** Label boxes in image px (tests: none may overlap). print = gutter callouts + glue labels; view3d = the 3D callouts + glue labels in the art camera. */
  labels: { print: Rect[]; view3d: Rect[] }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
const f1 = (n: number) => (Math.round(n * 10) / 10).toString()

export function drawStep(a: Assembly, scene: SceneInst[], n: number, opts: DrawOptions = {}): StepDrawing {
  const [W, H] = [opts.width ?? STEP_SIZE[0], opts.height ?? STEP_SIZE[1]]
  const k = W / STEP_SIZE[0] // overlay scale for smaller renders
  const overlays = opts.overlays ?? true
  const s = n ? stepOf(a, n) : null
  const roles = stepRoles(a, scene, n, opts.explode ?? 1)
  const cam = chooseCamera(a, scene, n, roles, opts.prevDir ?? null, opts.home)
  const offsets = new Map(roles.movers.map((m) => [m.inst.key, m.offset]))
  const offOf = (key: string): Vec3 => offsets.get(key) ?? [0, 0, 0]
  const visible = scene.filter((x) => roles.role.get(x.key) !== "hidden")
  const letters = partLetters(a)

  // ---- callout groups (which instances get a label) ----
  type Group = { insts: SceneInst[]; tone: "new" | "context"; label: string; letters?: string; qty?: number }
  const groups: Group[] = []
  if (overlays && n > 0) {
    const highlighted = visible.filter((x) => ["new", "focus"].includes(roles.role.get(x.key)!))
    const byId = new Map<string, SceneInst[]>()
    for (const x of highlighted) byId.set(x.id, [...(byId.get(x.id) ?? []), x])
    for (const [id, insts] of byId) {
      const part = a.parts.find((p) => p.id === id)
      if (part) groups.push({ insts, tone: "new", label: part.name ?? id, letters: letterRange(insts.map((x) => letters.get(x.key)!)) })
      else {
        const h = a.hardware.find((y) => y.id === id)!
        groups.push({ insts, tone: "new", label: hardwareName(h), qty: insts.length })
      }
    }
    // context: earlier parts the new ones go into (touching their seated boxes)
    const seated = roles.movers.map((m) => expand(m.inst.box, 1.5))
    const ctx = visible
      .filter((x) => x.kind === "part" && roles.role.get(x.key) === "done")
      .map((x) => ({ x, o: seated.reduce((t, b) => t + overlap(b, x.box), 0) }))
      .filter((c) => c.o > 0.004 * Math.min(vol(c.x.box), ...roles.movers.map((m) => vol(m.inst.box))))
      .sort((p, q) => q.o - p.o)
      .slice(0, 2)
    for (const { x } of ctx) {
      const part = a.parts.find((p) => p.id === x.id)!
      groups.push({ insts: [x], tone: "context", label: part.name ?? x.id, letters: letters.get(x.key) })
    }
  }

  // ---- framing (two passes: arrows need the scale for their minimum length) ----
  const gutters = groups.length ? GUTTER * k : MARGIN * k
  const area: [number, number, number, number] = [gutters, MARGIN * k, W - gutters, H - MARGIN * k]
  const geomPts = visible.flatMap((x) => vertsOf(x.tris, offOf(x.key), Math.max(1, Math.floor(x.tris.length / 9 / 4000))))
  const glue = overlays ? glueRegions(s, scene) : []
  const gluePts = glue.flatMap((g) => corners({ min: add(g.min, offOf(g.ownerKey ?? "")), max: add(g.max, offOf(g.ownerKey ?? "")) }))
  let view = fitView(cam.dir, [...geomPts, ...gluePts], area)
  let arrows: ArtArrow[] = []
  const arrowPts = (list: ArtArrow[]) =>
    list.flatMap((r) => [r.from, r.to, ...(r.axis && r.center && r.radius ? arcPoints(r.center, r.axis, r.radius, 12) : [])])
  if (overlays) {
    for (let pass = 0; pass < 2; pass++) {
      const minLen = (72 * k) / view.s
      arrows = [...roles.movers, ...roles.focusArrows].map((m) => moverArrow(m, minLen))
      view = fitView(cam.dir, [...geomPts, ...gluePts, ...arrowPts(arrows)], area)
    }
  }

  // ---- main raster ----
  const meshes: RasterMesh[] = visible.map((x) => ({
    tris: translated(x.tris, offOf(x.key)),
    color: x.color,
    style: roles.allPlain ? "plain" : roles.role.get(x.key) === "done" ? "muted" : "new",
  }))
  const raster = rasterize(meshes, view, W, H, opts.ss ?? 2)
  const png = encodePng(raster.rgb, W, H)
  // An arrow drawn over the item it moves (a big part lifted end-on) is hard to read: move it beside the item.
  if (overlays) {
    const idxOf = new Map(visible.map((x, i) => [x.key, i]))
    const movers = [...roles.movers, ...roles.focusArrows]
    arrows = arrows.map((r, ai) => {
      if (r.kind === "twist") return r
      const m = movers[ai]
      const own = new Set(r.targets.map((t) => idxOf.get(t)))
      const coverage = (q: ArtArrow, any: boolean) => {
        let hit = 0
        for (let t = 0; t <= 10; t++) {
          const p = add(q.from, scale(sub(q.to, q.from), t / 10))
          const [x, y] = project(view, p)
          if (x < area[0] || x >= area[2] || y < area[1] || y >= area[3]) return 99
          const id = raster.id[Math.floor(y) * W + Math.floor(x)]
          if (any ? id >= 0 : own.has(id)) hit++
        }
        return hit
      }
      if (coverage(r, false) < 4) return r
      const lat = norm(cross(m.insert, view.dir))
      const reach = halfExtent(moveBox(m.inst.box, m.offset), lat) + (26 * k) / view.s
      const options = [1, -1].map((sg) => {
        const d = scale(lat, sg * reach)
        return { ...r, from: add(r.from, d), to: add(r.to, d) }
      })
      const scored = options.map((q) => ({ q, s: coverage(q, true) })).sort((p, q) => p.s - q.s)
      return scored[0].s < 99 ? scored[0].q : r
    })
  }

  // ---- anchors: the visible pixel of each instance nearest its projected centre ----
  const anchorOf = new Map<string, { x: number; y: number; p: Vec3 }>()
  if (groups.length) {
    const want = new Map<number, { key: string; cx: number; cy: number; best: number; at: number }>()
    visible.forEach((x, i) => {
      if (!groups.some((g) => g.insts.includes(x))) return
      const [cx, cy] = project(view, add(center(x.box), offOf(x.key)))
      want.set(i, { key: x.key, cx, cy, best: Infinity, at: -1 })
    })
    for (let i = 0; i < W * H; i++) {
      const w = want.get(raster.id[i])
      if (!w) continue
      const x = i % W
      const y = (i - x) / W
      const d = (x + 0.5 - w.cx) ** 2 + (y + 0.5 - w.cy) ** 2
      if (d < w.best) {
        w.best = d
        w.at = i
      }
    }
    for (const [mi, w] of want) {
      const inst = visible[mi]
      if (w.at >= 0) {
        const x = (w.at % W) + 0.5
        const y = Math.floor(w.at / W) + 0.5
        anchorOf.set(w.key, { x, y, p: sub(unproject(view, x, y, raster.depth[w.at]), offOf(inst.key)) })
      } else {
        const c = add(center(inst.box), offOf(inst.key))
        const [x, y] = project(view, c)
        anchorOf.set(w.key, { x, y, p: center(inst.box) })
      }
    }
  }

  // ---- callout layout (print): label columns left / right, ordered by anchor height, never overlapping ----
  const targetDepth = dotCenter(visible, offOf, view)
  type Placed = Group & { side: "l" | "r"; y: number; mx: number; my: number; w: number; h: number; anchors: { key: string; x: number; y: number; p: Vec3 }[]; lines: string[] }
  const placed: Placed[] = groups.map((g) => {
    const picks = spread(g.insts, 6)
    const anchors = picks.map((x) => ({ key: x.key, ...anchorOf.get(x.key)! }))
    const mx = anchors.reduce((t, q) => t + q.x, 0) / anchors.length
    const my = anchors.reduce((t, q) => t + q.y, 0) / anchors.length
    const lines = wrap(g.label, 19)
    const { w, h } = calloutSize({ ...g, lines }, k)
    return { ...g, side: mx < W / 2 ? "l" : "r", y: my, mx, my, w, h, anchors, lines }
  })
  layoutColumns(placed, H, k)
  const labelX = (side: "l" | "r") => (side === "l" ? 18 * k : W - 18 * k)
  const calloutRects: Rect[] = placed.map((p) => {
    const left = p.side === "l" ? labelX("l") : labelX("r") - p.w
    return [left, p.y - p.h / 2, left + p.w, p.y + p.h / 2]
  })

  // ---- glue labels (print + 3D): beside their region, clear of the callouts and of each other ----
  const glueGeo = glue.map((g) => glueGeometry(g, view, offOf(g.ownerKey ?? ""), k))
  const regionRects: Rect[] = glueGeo.filter((gg) => gg.poly.length >= 3).map((gg) => [gg.left, gg.top, gg.right, gg.bottom])
  const glueRects = placeLabels(
    glueGeo.map((gg) => ({
      w: gg.tw,
      h: 26 * k,
      // first choice: up and to the right of the region (as before), then rings around it
      candidates: (gg.poly.length < 3
        ? [[0, 0]]
        : [
            [gg.right + 10 * k, gg.top - 30 * k],
            ...labelCandidates((gg.left + gg.right) / 2, (gg.top + gg.bottom) / 2, gg.tw, 26 * k, [1, -1], 14 * k + Math.max(gg.right - gg.left, gg.bottom - gg.top) / 2, 8),
          ]) as [number, number][],
    })),
    // clear of the callouts and of every glue region (a label must not hide the spot it or another one marks)
    [...calloutRects, ...regionRects],
    [0, 0, W, H],
    6 * k,
  )

  // ---- callout labels in 3D (step-through viewer): near their parts in the art camera's view, not the print gutters ----
  const mid: [number, number] = [(area[0] + area[2]) / 2, (area[1] + area[3]) / 2]
  const rects3d = placeLabels(
    placed.map((p) => ({
      w: p.w,
      h: p.h,
      candidates: labelCandidates(p.mx, p.my, p.w, p.h, [p.mx - mid[0], p.my - mid[1]], 30 * k, 10),
    })),
    [...glueRects.filter((_, i) => glueGeo[i].poly.length >= 3), ...regionRects],
    [0, 0, W, H],
    8 * k,
  )
  const callouts: ArtCallout[] = placed.map((p, i) => ({
    label: p.label,
    ...(p.letters ? { letters: p.letters } : {}),
    ...(p.qty ? { qty: p.qty } : {}),
    tone: p.tone,
    anchors: p.anchors.map((q) => ({ key: q.key, point: q.p })),
    labelAt: unproject(view, (rects3d[i][0] + rects3d[i][2]) / 2, (rects3d[i][1] + rects3d[i][3]) / 2, targetDepth),
  }))
  glue.forEach((g, i) => {
    if (glueGeo[i].poly.length < 3) return
    const r = glueRects[i]
    // owner offset removed: the viewer adds offset × explode, like the region itself
    const off = offOf(g.ownerKey ?? "")
    g.labelAt = sub(unproject(view, (r[0] + r[2]) / 2, (r[1] + r[3]) / 2, dot(add(center({ min: g.min, max: g.max }), off), view.dir)), off)
  })

  // ---- close-up ----
  const closeUp = overlays ? planCloseUp(s, roles, glue, offOf, view, area, k) : null

  // ---- SVG overlay ----
  let overlay = ""
  let defs = ""
  if (overlays) {
    defs = svgDefs(k)
    const parts: string[] = []
    parts.push(`<g class="glue">${glue.map((g, i) => glueSvg(g, view, offOf(g.ownerKey ?? ""), k, glueRects[i])).join("")}</g>`)
    parts.push(`<g class="arrows">${arrows.map((r) => arrowSvg(r, view, k)).join("")}</g>`)
    const labelBoxes: Rect[] = [...calloutRects, ...glueRects.filter((_, i) => glueGeo[i].poly.length >= 3)]
    if (closeUp) parts.push(closeUpSvg(closeUp, meshes, view, arrows, glue, offOf, raster, W, H, area, k, opts.ss ?? 2, labelBoxes))
    parts.push(
      `<g class="callouts">${placed
        .map((p) => calloutSvg(p, labelX(p.side), p.side === "l" ? gutters - 12 * k : W - gutters + 12 * k, k))
        .join("")}</g>`,
    )
    overlay = parts.join("\n")
  }

  const instances: ArtInstance[] = scene.map((x) => ({
    key: x.key,
    kind: x.kind,
    id: x.id,
    index: x.index,
    ...(letters.has(x.key) ? { letter: letters.get(x.key) } : {}),
    role: roles.allPlain && roles.role.get(x.key) !== "hidden" ? "focus" : roles.role.get(x.key)!,
    offset: offsets.get(x.key) ?? [0, 0, 0],
    ...(x.kind === "hardware" ? { box: x.box } : {}),
  }))
  const art: StepDrawing["art"] = {
    n,
    camera: { dir: view.dir, up: view.up, target: unproject(view, (area[0] + area[2]) / 2, (area[1] + area[3]) / 2, targetDepth), auto: cam.auto },
    instances,
    arrows,
    callouts,
    glue,
    closeUp: closeUp ? { center: closeUp.center, radius: closeUp.radius } : null,
  }
  const labels = { print: [...calloutRects, ...glueRects.filter((_, i) => glueGeo[i].poly.length >= 3)], view3d: [...rects3d, ...glueRects.filter((_, i) => glueGeo[i].poly.length >= 3)] }
  return { art, raster, png, overlay, defs, width: W, height: H, view, labels }
}

function dotCenter(visible: SceneInst[], offOf: (k: string) => Vec3, view: OrthoView): number {
  const b = visible.reduce<Box | null>((u, x) => unionBox(u, moveBox(x.box, offOf(x.key))), null)
  return b ? dot(center(b), view.dir) : 0
}

/** Up to n instances, evenly spread through the list. */
function spread<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs
  return Array.from({ length: n }, (_, i) => xs[Math.round((i * (xs.length - 1)) / (n - 1))])
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let cur = ""
  for (const w of words) {
    if (!cur) cur = w
    else if ((cur + " " + w).length <= width) cur += " " + w
    else {
      lines.push(cur)
      cur = w
    }
  }
  if (cur) lines.push(cur)
  if (lines.length > 2) return [lines[0], lines.slice(1).join(" ").slice(0, width - 1) + "…"]
  return lines
}

/* ---------- glue ---------- */

export function glueRegions(s: AssemblyStep | null, scene: SceneInst[]): ArtGlue[] {
  return (s?.glue ?? []).map((g) => {
    const half = scale(g.size, 0.5)
    const min = sub(g.at, half)
    const max = add(g.at, half)
    let ownerKey: string | undefined
    if (g.part) {
      const [id, i] = parseRef(g.part)
      const cands = scene.filter((x) => x.id === id && (i === null || x.index === i))
      // a bare id with several copies: the copy the region sits on
      const pick = cands.sort((p, q) => len(sub(center(p.box), g.at)) - len(sub(center(q.box), g.at)))[0]
      ownerKey = pick?.key ?? instKey(id, i ?? 0)
    }
    return { ...g, min, max, ...(ownerKey ? { ownerKey } : {}) }
  })
}

function hull(pts: [number, number][]): [number, number][] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const crossZ = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: [number, number][] = []
  for (const q of p) {
    while (lower.length >= 2 && crossZ(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper: [number, number][] = []
  for (const q of p.reverse()) {
    while (upper.length >= 2 && crossZ(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop()
    upper.push(q)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

/** A glue region's outline on the image (tiny regions grown to stay visible) and its label's text and width. */
function glueGeometry(g: ArtGlue, view: OrthoView, off: Vec3, k: number) {
  const raw = hull(corners({ min: add(g.min, off), max: add(g.max, off) }).map((c) => project(view, c).slice(0, 2) as [number, number]))
  const cx = raw.reduce((t, q) => t + q[0], 0) / Math.max(1, raw.length)
  const cy = raw.reduce((t, q) => t + q[1], 0) / Math.max(1, raw.length)
  const r = Math.max(0, ...raw.map((q) => Math.hypot(q[0] - cx, q[1] - cy)))
  const grow = r < 10 * k ? (10 * k) / Math.max(r, 0.1) : 1
  const poly = raw.map((q): [number, number] => [cx + (q[0] - cx) * grow, cy + (q[1] - cy) * grow])
  const xs = poly.map((q) => q[0])
  const ys = poly.map((q) => q[1])
  const tag = g.kind === "glue" ? "GLUE" : "NO GLUE"
  const text = g.label ? `${tag}: ${g.label}` : tag
  return { poly, left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys), text, tw: text.length * 9.4 * k + 18 * k }
}

/** `label` = where its label box goes (placeLabels); without one (the close-up inset) the region is drawn unlabelled. */
function glueSvg(g: ArtGlue, view: OrthoView, off: Vec3, k: number, label?: Rect): string {
  const gg = glueGeometry(g, view, off, k)
  if (gg.poly.length < 3) return ""
  const pts = gg.poly.map((q) => `${f1(q[0])},${f1(q[1])}`).join(" ")
  const glue = g.kind === "glue"
  const c = glue ? GLUE : NO_GLUE
  const region = `<polygon points="${pts}" fill="url(#${glue ? "hatch-glue" : "hatch-noglue"})" stroke="${c}" stroke-width="${f1(2.2 * k)}" stroke-dasharray="${glue ? "none" : `${f1(7 * k)} ${f1(4 * k)}`}"/>`
  if (!label) return `<g class="glue-region ${g.kind}" data-kind="${g.kind}">${region}</g>`
  const [tx, ty, tr, tb] = label
  // leader: from the region's box to the nearest point of the label
  const lx = Math.max(tx, Math.min((gg.left + gg.right) / 2, tr))
  const ly = Math.max(ty, Math.min((gg.top + gg.bottom) / 2, tb))
  const sx = Math.max(gg.left, Math.min(lx, gg.right))
  const sy = Math.max(gg.top, Math.min(ly, gg.bottom))
  return `<g class="glue-region ${g.kind}" data-kind="${g.kind}">${region}
<line x1="${f1(sx)}" y1="${f1(sy)}" x2="${f1(lx)}" y2="${f1(ly)}" stroke="${c}" stroke-width="${f1(1.6 * k)}"/>
<rect x="${f1(tx)}" y="${f1(ty)}" width="${f1(tr - tx)}" height="${f1(tb - ty)}" fill="#fff" stroke="${c}" stroke-width="${f1(1.6 * k)}"/>
<text x="${f1(tx + 9 * k)}" y="${f1(ty + 18.5 * k)}" font-size="${f1(16 * k)}" font-weight="600" fill="${c}">${esc(gg.text)}</text></g>`
}

/* ---------- arrows ---------- */

type P2 = [number, number]

function arrowHead(tip: P2, dirx: number, diry: number, hl: number, hw: number): string {
  const bx = tip[0] - dirx * hl
  const by = tip[1] - diry * hl
  const nx = -diry
  const ny = dirx
  return `${f1(tip[0])},${f1(tip[1])} ${f1(bx + nx * hw)},${f1(by + ny * hw)} ${f1(bx - nx * hw)},${f1(by - ny * hw)}`
}

function straight(a: P2, b: P2, k: number, kind: StepAction): string {
  let dx = b[0] - a[0]
  let dy = b[1] - a[1]
  let L = Math.hypot(dx, dy)
  if (L < 1e-3) return ""
  dx /= L
  dy /= L
  // keep it readable even when the direction is nearly end-on
  if (L < 40 * k) {
    const c: P2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    a = [c[0] - dx * 20 * k, c[1] - dy * 20 * k]
    b = [c[0] + dx * 20 * k, c[1] + dy * 20 * k]
    L = 40 * k
  }
  const w = 4.6 * k
  const hl = Math.min(26 * k, L * 0.5)
  const hw = 13 * k
  const nx = -dy
  const ny = dx
  const sx = b[0] - dx * hl
  const sy = b[1] - dy * hl
  const body = [
    [a[0] + nx * w, a[1] + ny * w],
    [sx + nx * w, sy + ny * w],
    [sx + nx * hw, sy + ny * hw],
    [b[0], b[1]],
    [sx - nx * hw, sy - ny * hw],
    [sx - nx * w, sy - ny * w],
    [a[0] - nx * w, a[1] - ny * w],
  ]
    .map((q) => `${f1(q[0])},${f1(q[1])}`)
    .join(" ")
  const extras: string[] = []
  if (kind === "slide") {
    for (const sgn of [-1, 1]) {
      const o = sgn * (w + 9 * k)
      const x0 = a[0] - dx * 8 * k + nx * o
      const y0 = a[1] - dy * 8 * k + ny * o
      const x1 = a[0] + dx * L * 0.45 + nx * o
      const y1 = a[1] + dy * L * 0.45 + ny * o
      extras.push(`<line x1="${f1(x0)}" y1="${f1(y0)}" x2="${f1(x1)}" y2="${f1(y1)}" stroke="${INK}" stroke-width="${f1(2.4 * k)}" stroke-linecap="round"/>`)
    }
  } else if (kind === "push") {
    for (const d of [0, 9 * k]) {
      const cx = a[0] - dx * (6 * k + d)
      const cy = a[1] - dy * (6 * k + d)
      extras.push(`<line x1="${f1(cx + nx * 15 * k)}" y1="${f1(cy + ny * 15 * k)}" x2="${f1(cx - nx * 15 * k)}" y2="${f1(cy - ny * 15 * k)}" stroke="${INK}" stroke-width="${f1(3.6 * k)}" stroke-linecap="round"/>`)
    }
  } else if (kind === "snap") {
    for (const ang of [-55, 0, 55]) {
      const t = (ang * Math.PI) / 180
      const ux = dx * Math.cos(t) - dy * Math.sin(t)
      const uy = dx * Math.sin(t) + dy * Math.cos(t)
      extras.push(
        `<line x1="${f1(b[0] + ux * 9 * k)}" y1="${f1(b[1] + uy * 9 * k)}" x2="${f1(b[0] + ux * 21 * k)}" y2="${f1(b[1] + uy * 21 * k)}" stroke="${INK}" stroke-width="${f1(2.6 * k)}" stroke-linecap="round"/>`,
      )
    }
    extras.push(`<text x="${f1(b[0] + 26 * k)}" y="${f1(b[1] - 4 * k)}" font-size="${f1(19 * k)}" font-style="italic" font-weight="600" fill="${INK}" stroke="#fff" stroke-width="${f1(4 * k)}" paint-order="stroke">click!</text>`)
  }
  return `<polygon class="arrow-body" points="${body}" fill="${INK}" stroke="#fff" stroke-width="${f1(3.2 * k)}" stroke-linejoin="round" paint-order="stroke"/>${extras.join("")}`
}

function arcSvg(r: ArtArrow, view: OrthoView, k: number): string {
  const pts = arcPoints(r.center!, r.axis!, r.radius!).map((p) => project(view, p).slice(0, 2) as P2)
  const tip = pts[pts.length - 1]
  const prev = pts[pts.length - 3]
  let dx = tip[0] - prev[0]
  let dy = tip[1] - prev[1]
  const L = Math.hypot(dx, dy) || 1
  dx /= L
  dy /= L
  const hl = 18 * k
  const d = pts
    .slice(0, -2)
    .map((q, i) => `${i ? "L" : "M"}${f1(q[0])},${f1(q[1])}`)
    .join(" ")
  return `<path class="arrow-arc" d="${d}" fill="none" stroke="#fff" stroke-width="${f1(9 * k)}" stroke-linecap="round"/><path d="${d}" fill="none" stroke="${INK}" stroke-width="${f1(4.4 * k)}" stroke-linecap="round"/><polygon points="${arrowHead([tip[0] + dx * 4 * k, tip[1] + dy * 4 * k], dx, dy, hl, 10 * k)}" fill="${INK}" stroke="#fff" stroke-width="${f1(2.5 * k)}" paint-order="stroke"/>`
}

export function arrowSvg(r: ArtArrow, view: OrthoView, k: number): string {
  const a = project(view, r.from).slice(0, 2) as P2
  const b = project(view, r.to).slice(0, 2) as P2
  const parts: string[] = []
  if (r.kind !== "twist") parts.push(straight(a, b, k, r.kind))
  if ((r.kind === "twist" || r.kind === "screw") && r.axis && r.center && r.radius) parts.push(arcSvg(r, view, k))
  return `<g class="arrow ${r.kind}" data-kind="${r.kind}" data-targets="${esc(r.targets.join(" "))}">${parts.join("")}</g>`
}

/* ---------- callouts ---------- */

/** A callout's box: letter chip + one or two text lines. */
function calloutSize(p: { letters?: string; qty?: number; lines: string[] }, k: number) {
  const chipText = p.letters ?? (p.qty ? `${p.qty}×` : "")
  const chipW = chipText ? Math.max(34, chipText.length * 13 + 14) * k : 0
  const chipH = 34 * k
  const fs = 18 * k
  const textW = Math.max(...p.lines.map((l) => l.length)) * fs * 0.54
  const w = chipW + (chipW ? 10 * k : 0) + textW
  const h = Math.max(chipH, p.lines.length * fs * 1.15 + 6 * k)
  return { chipText, chipW, chipH, fs, w, h }
}

/**
 * Print callouts in two label columns (left / right gutters), each ordered by its anchors' height. Box heights set
 * the spacing, so labels never overlap; a column with more labels than fit hands its most central ones to the other.
 */
function layoutColumns(placed: { side: "l" | "r"; y: number; mx: number; h: number }[], H: number, k: number) {
  const gap = 10 * k
  const room = H - 2 * MARGIN * k
  const need = (side: "l" | "r") => placed.filter((p) => p.side === side).reduce((t, p) => t + p.h + gap, 0)
  for (const side of ["l", "r"] as const) {
    const other = side === "l" ? "r" : "l"
    while (need(side) > room && need(other) + Math.min(...placed.filter((p) => p.side === side).map((p) => p.h + gap)) <= room) {
      // the label nearest the middle moves across
      const col = placed.filter((p) => p.side === side).sort((p, q) => (side === "l" ? q.mx - p.mx : p.mx - q.mx))
      col[0].side = other
    }
  }
  for (const side of ["l", "r"] as const) {
    const col = placed.filter((p) => p.side === side).sort((p, q) => p.y - q.y)
    const top = (p: (typeof col)[number]) => MARGIN * k + p.h / 2
    const bottom = (p: (typeof col)[number]) => H - MARGIN * k - p.h / 2
    const sep = (i: number) => (col[i - 1].h + col[i].h) / 2 + gap
    for (let i = 0; i < col.length; i++) col[i].y = Math.max(col[i].y, i ? col[i - 1].y + sep(i) : top(col[i]))
    for (let i = col.length - 1; i >= 0; i--) col[i].y = Math.min(col[i].y, i < col.length - 1 ? col[i + 1].y - sep(i + 1) : bottom(col[i]))
    // an overfull column: push down again from the top (never overlap; may run past the bottom margin)
    for (let i = 0; i < col.length; i++) col[i].y = Math.max(col[i].y, i ? col[i - 1].y + sep(i) : top(col[i]))
  }
}

function calloutSvg(
  p: { tone: "new" | "context"; letters?: string; qty?: number; lines: string[]; side: "l" | "r"; y: number; anchors: { key: string; x: number; y: number }[] },
  x: number,
  elbowX: number,
  k: number,
): string {
  const ink = p.tone === "new" ? INK : MUTED_INK
  const { chipText, chipW, chipH, fs, w: boxW } = calloutSize(p, k)
  const left = p.side === "l" ? x : x - boxW
  const top = p.y - chipH / 2
  const chip = chipText
    ? p.tone === "new"
      ? `<rect x="${f1(left)}" y="${f1(top)}" width="${f1(chipW)}" height="${f1(chipH)}" fill="${INK}"/><text x="${f1(left + chipW / 2)}" y="${f1(top + chipH * 0.7)}" text-anchor="middle" font-family="Geist Mono, Menlo, monospace" font-size="${f1(20 * k)}" font-weight="600" fill="#fff">${esc(chipText)}</text>`
      : `<rect x="${f1(left)}" y="${f1(top)}" width="${f1(chipW)}" height="${f1(chipH)}" fill="#fff" stroke="${MUTED_INK}" stroke-width="${f1(1.6 * k)}"/><text x="${f1(left + chipW / 2)}" y="${f1(top + chipH * 0.7)}" text-anchor="middle" font-family="Geist Mono, Menlo, monospace" font-size="${f1(20 * k)}" font-weight="600" fill="${MUTED_INK}">${esc(chipText)}</text>`
    : ""
  const tx = left + chipW + (chipW ? 10 * k : 0)
  const lh = fs * 1.15
  const ty0 = p.y + fs * 0.36 - ((p.lines.length - 1) * lh) / 2
  const text = p.lines
    .map((l, i) => `<text x="${f1(tx)}" y="${f1(ty0 + i * lh)}" font-size="${f1(fs)}" font-weight="${p.tone === "new" ? 600 : 400}" fill="${ink}">${esc(l)}</text>`)
    .join("")
  const startX = p.side === "l" ? left + boxW + 8 * k : left - 8 * k
  const leaders = p.anchors
    .map(
      (q) =>
        `<polyline points="${f1(startX)},${f1(p.y)} ${f1(elbowX)},${f1(p.y)} ${f1(q.x)},${f1(q.y)}" fill="none" stroke="#fff" stroke-width="${f1(4.5 * k)}" stroke-linejoin="round"/><polyline points="${f1(startX)},${f1(p.y)} ${f1(elbowX)},${f1(p.y)} ${f1(q.x)},${f1(q.y)}" fill="none" stroke="${ink}" stroke-width="${f1(1.7 * k)}" stroke-linejoin="round"/><circle cx="${f1(q.x)}" cy="${f1(q.y)}" r="${f1(4.6 * k)}" fill="${ink}" stroke="#fff" stroke-width="${f1(1.8 * k)}"/>`,
    )
    .join("")
  return `<g class="callout ${p.tone}" data-tone="${p.tone}" data-letters="${esc(p.letters ?? "")}" data-targets="${esc(p.anchors.map((q) => q.key).join(" "))}">${leaders}${chip}${text}</g>`
}

/* ---------- close-up inset ---------- */

interface CloseUpPlan {
  center: Vec3
  radius: number // mm (in the image plane)
  cx: number // region circle in the main image
  cy: number
  r: number
  ix: number // inset circle centre / radius
  iy: number
  ir: number
}

function planCloseUp(
  s: AssemblyStep | null,
  roles: StepRoles,
  glue: ArtGlue[],
  offOf: (k: string) => Vec3,
  view: OrthoView,
  area: [number, number, number, number],
  k: number,
): CloseUpPlan | null {
  if (!s || s.closeUp === false) return null
  let region: Box | null = null
  if (s.closeUp && typeof s.closeUp === "object") {
    const h = (s.closeUp.size ?? 24) / 2
    region = { min: sub(s.closeUp.at, [h, h, h]), max: add(s.closeUp.at, [h, h, h]) }
  } else {
    // one representative joint (the first item that moves; repeats look the same), with its glue regions
    const m = [...roles.movers, ...roles.focusArrows][0]
    if (m) region = expand(m.inst.box, Math.max(1.5, 0.2 * diag(m.inst.box))) // the seat and around it; the arrow points into it
    for (const g of glue) if (!m || g.ownerKey === m.inst.key || (region && overlap(expand(region, 2), { min: g.min, max: g.max }) > 0)) region = unionBox(region, { min: add(g.min, offOf(g.ownerKey ?? "")), max: add(g.max, offOf(g.ownerKey ?? "")) })
  }
  if (!region) return null
  const c = center(region)
  const [pcx, pcy] = project(view, c)
  const rPx = Math.max(...corners(region).map((q) => Math.hypot(project(view, q)[0] - pcx, project(view, q)[1] - pcy)))
  const areaMin = Math.min(area[2] - area[0], area[3] - area[1])
  const first = [...roles.movers, ...roles.focusArrows][0]
  const small = first ? diag(first.inst.box) * view.s < 0.12 * areaMin : 2 * rPx < 0.24 * areaMin
  const moving = new Set(roles.movers.map((m) => m.inst.key))
  const anyDone = [...roles.role].some(([key, r]) => r === "done" || r === "focus" || (r === "new" && !moving.has(key)))
  if (!(s.closeUp === true || (typeof s.closeUp === "object" && s.closeUp) || (small && anyDone))) return null
  const ir = 150 * k
  if ((ir * 0.82) / Math.max(rPx, 1) < 1.3 && s.closeUp === undefined) return null // not much bigger: skip
  const r = Math.max(rPx * 1.15, 14 * k)
  return { center: c, radius: rPx / view.s, cx: pcx, cy: pcy, r, ix: 0, iy: 0, ir }
}

function closeUpSvg(
  cu: CloseUpPlan,
  meshes: RasterMesh[],
  view: OrthoView,
  arrows: ArtArrow[],
  glue: ArtGlue[],
  offOf: (k: string) => Vec3,
  main: RasterResult,
  W: number,
  H: number,
  area: [number, number, number, number],
  k: number,
  ss: number,
  avoid: [number, number, number, number][], // label boxes
): string {
  const ir = cu.ir
  // corner with the least drawing under it, away from the region itself
  const cands: P2[] = [
    [area[0] + ir + 6 * k, area[3] - ir],
    [area[2] - ir - 6 * k, area[3] - ir],
    [area[0] + ir + 6 * k, area[1] + ir],
    [area[2] - ir - 6 * k, area[1] + ir],
    [W - ir - 8 * k, H - ir - 8 * k],
    [ir + 8 * k, H - ir - 8 * k],
    [W - ir - 8 * k, ir + 8 * k],
    [ir + 8 * k, ir + 8 * k],
  ]
  let best = cands[0]
  let bestScore = Infinity
  for (const q of cands) {
    let covered = 0
    for (let y = Math.max(0, Math.floor(q[1] - ir)); y < Math.min(H, q[1] + ir); y += 3)
      for (let x = Math.max(0, Math.floor(q[0] - ir)); x < Math.min(W, q[0] + ir); x += 3)
        if ((x - q[0]) ** 2 + (y - q[1]) ** 2 < ir * ir && main.id[y * W + x] >= 0) covered++
    const dRegion = Math.hypot(q[0] - cu.cx, q[1] - cu.cy)
    const hitsLabel = avoid.some((b) => b[0] < q[0] + ir && b[2] > q[0] - ir && b[1] < q[1] + ir && b[3] > q[1] - ir)
    const score = covered + (dRegion < ir + cu.r ? 1e6 : 0) + (hitsLabel ? 4000 : 0) - dRegion * 0.01
    if (score < bestScore) {
      bestScore = score
      best = q
    }
  }
  const [ix, iy] = best
  const D = Math.round(2 * ir)
  const s2 = (ir * 0.8) / Math.max(cu.radius, 0.5)
  const [ccx, ccy] = project({ ...view, s: 1, ox: 0, oy: 0 }, cu.center)
  const iv: OrthoView = { ...view, s: s2, ox: D / 2 - s2 * ccx, oy: D / 2 - s2 * ccy }
  const inset = rasterize(meshes, iv, D, D, ss)
  const uri = `data:image/png;base64,${encodePng(inset.rgb, D, D).toString("base64")}`
  // overlays in the inset: same arrows / glue, projected with the inset view and moved to the inset's corner
  const shifted: OrthoView = { ...iv, ox: iv.ox + ix - D / 2, oy: iv.oy + iy - D / 2 }
  const inner = [
    ...glue.map((g) => glueSvg({ ...g, label: undefined }, shifted, offOf(g.ownerKey ?? ""), k * 0.8)),
    ...arrows.map((r) => arrowSvg(r, shifted, k * 0.85)),
  ].join("")
  // connector from the region circle to the inset circle
  const dx = ix - cu.cx
  const dy = iy - cu.cy
  const dl = Math.hypot(dx, dy) || 1
  const x1 = cu.cx + (dx / dl) * cu.r
  const y1 = cu.cy + (dy / dl) * cu.r
  const x2 = ix - (dx / dl) * ir
  const y2 = iy - (dy / dl) * ir
  return `<g class="closeup"><circle cx="${f1(cu.cx)}" cy="${f1(cu.cy)}" r="${f1(cu.r)}" fill="none" stroke="#fff" stroke-width="${f1(5 * k)}"/><circle cx="${f1(cu.cx)}" cy="${f1(cu.cy)}" r="${f1(cu.r)}" fill="none" stroke="${INK}" stroke-width="${f1(2.2 * k)}"/>
<line x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}" stroke="${INK}" stroke-width="${f1(2 * k)}"/>
<clipPath id="inset-clip-${Math.round(ix)}-${Math.round(iy)}"><circle cx="${f1(ix)}" cy="${f1(iy)}" r="${f1(ir)}"/></clipPath>
<circle cx="${f1(ix)}" cy="${f1(iy)}" r="${f1(ir)}" fill="#fff"/>
<g clip-path="url(#inset-clip-${Math.round(ix)}-${Math.round(iy)})"><image x="${f1(ix - D / 2)}" y="${f1(iy - D / 2)}" width="${D}" height="${D}" href="${uri}"/>${inner}</g>
<circle cx="${f1(ix)}" cy="${f1(iy)}" r="${f1(ir)}" fill="none" stroke="${INK}" stroke-width="${f1(3 * k)}"/></g>`
}

function svgDefs(k: number): string {
  const s = f1(9 * k)
  return `<pattern id="hatch-glue" patternUnits="userSpaceOnUse" width="${s}" height="${s}" patternTransform="rotate(45)"><rect width="${s}" height="${s}" fill="${GLUE}" fill-opacity="0.18"/><line x1="0" y1="0" x2="0" y2="${s}" stroke="${GLUE}" stroke-width="${f1(3 * k)}"/></pattern>
<pattern id="hatch-noglue" patternUnits="userSpaceOnUse" width="${s}" height="${s}"><rect width="${s}" height="${s}" fill="${NO_GLUE}" fill-opacity="0.10"/><path d="M0,0 L${s},${s} M${s},0 L0,${s}" stroke="${NO_GLUE}" stroke-width="${f1(1.6 * k)}"/></pattern>`
}

/** Self-contained SVG: the raster as an <image> (data URI or a relative href) plus the vector overlay. */
export function stepSvg(d: Pick<StepDrawing, "width" | "height" | "overlay" | "defs">, imageHref: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${d.width} ${d.height}" width="${d.width}" height="${d.height}" font-family="Geist, Helvetica Neue, Helvetica, Arial, sans-serif" class="step-art">
<defs>${d.defs}</defs>
<image x="0" y="0" width="${d.width}" height="${d.height}" href="${imageHref}"/>
${d.overlay}
</svg>`
}

/** Overlay-only SVG (transparent background) for compositing onto the PNG. */
export function overlaySvg(d: Pick<StepDrawing, "width" | "height" | "overlay" | "defs">): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${d.width} ${d.height}" width="${d.width}" height="${d.height}" font-family="Geist, Helvetica Neue, Helvetica, Arial, sans-serif"><defs>${d.defs}</defs>${d.overlay}</svg>`
}

/** Render one item alone (parts list thumbnails), assembled orientation, default iso view. */
export function drawThumb(inst: SceneInst, width: number, height: number, dir: Vec3 = DEFAULT_VIEW): Buffer {
  const view = fitView(dir, vertsOf(inst.tris, [0, 0, 0]), [10, 10, width - 10, height - 10])
  const r = rasterize([{ tris: inst.tris, color: inst.color, style: "plain" }], view, width, height, 2)
  return encodePng(r.rgb, width, height)
}
