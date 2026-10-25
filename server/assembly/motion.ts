// check_motion: pose the assembled parts (placements + motions) and bought hardware (simple proxy shapes) with
// manifold-3d and look for collisions. Each motion gets a coarse sweep, then extra poses where a collision could
// still hide between two checked poses (close calls, sharp clearance drops, collision edges), up to a pose budget.
// Selected pairs of motions that could meet are also posed together at the ends of their ranges.
// Results say exactly what was covered; missing or broken geometry makes the result "incomplete", never "ok".
import { readFile } from "node:fs/promises"
import Module from "manifold-3d"
import type {
  Assembly,
  AssemblyMotion,
  MotionCheck,
  MotionCheckScope,
  MotionCollision,
  MotionCoverage,
  MotionReport,
  MotionScenario,
} from "../../shared/types"
import { exportPart } from "../cad/index"
import { parseStl } from "../cad/mesh"
import { hardwareName } from "./hardware"
import { hardwareProxy } from "./proxies"
import { motionsFor, restValue } from "./scaddata"

export type { MotionCheck, MotionReport } from "../../shared/types"
export type Collision = MotionCollision

type Wasm = Awaited<ReturnType<typeof Module>>
type Manifold = InstanceType<Wasm["Manifold"]>
type Mat4 = Parameters<Manifold["transform"]>[0]

let wasmP: Promise<Wasm> | null = null
export const manifoldWasm = () =>
  (wasmP ??= Module().then((w) => {
    w.setup()
    return w
  }))

/** Overlap below this is treated as touching (coincident faces, rounding). */
export const COLLISION_EPS_MM3 = 0.5
/** Gaps are measured up to this distance; anything further counts as "far". */
const GAP_SEARCH_MM = 10
/** Pairs closer than this at rest rest against each other (a lid on its box): their contact isn't a "closest gap". */
const TOUCH_MM = 0.05
/** ...so their gap is only measured once the move is this far (fraction of its range) from rest. */
const SEPARATING = 0.1
/** Below this gap the summary warns that printed parts may rub. */
import { RUB_MM } from "../../shared/motion-text"
export { RUB_MM }
export const DEFAULT_COARSE = 9
export const DEFAULT_MAX_POSITIONS = 48
const MAX_COMBO_PAIRS = 6

export interface MotionCheckOptions {
  coarse?: number // evenly spaced poses in the first pass (default 9, ends included)
  maxPositions?: number // pose budget per motion, coarse + refined (default 48)
  adaptive?: boolean // refine between poses (default true)
  /** Load a part's mesh (default: export the part to STL with OpenSCAD). Tests pass primitives. */
  loadMesh?: (partId: string) => Promise<{ verts: ArrayLike<number>; tris: ArrayLike<number> }>
}

/** One solid in the scene: a placed part instance or a placed hardware proxy. */
interface Body {
  key: string
  kind: "part" | "hardware"
  mesh: Manifold // placed (motions not applied)
  motions: AssemblyMotion[]
}

function rotationAbout(axis: readonly number[], origin: readonly number[], deg: number): Mat4 {
  const n = Math.hypot(axis[0], axis[1], axis[2])
  const [x, y, z] = [axis[0] / n, axis[1] / n, axis[2] / n]
  const t = (deg * Math.PI) / 180
  const c = Math.cos(t)
  const s = Math.sin(t)
  const C = 1 - c
  // Row-major rotation R; translation = o - R o
  const R = [
    [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
    [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
    [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
  ]
  const [ox, oy, oz] = origin
  const tr = [0, 1, 2].map((i) => [ox, oy, oz][i] - (R[i][0] * ox + R[i][1] * oy + R[i][2] * oz))
  // Column-major 4x4
  return [R[0][0], R[1][0], R[2][0], 0, R[0][1], R[1][1], R[2][1], 0, R[0][2], R[1][2], R[2][2], 0, tr[0], tr[1], tr[2], 1] as Mat4
}

export function poseOf(m: Manifold, motions: AssemblyMotion[], values: Map<string, number>): Manifold {
  let out = m
  for (const mo of motions) {
    const v = values.get(mo.id) ?? restValue(mo)
    const prev = out
    if (mo.type === "rotate") out = out.transform(rotationAbout(mo.axis, mo.origin ?? [0, 0, 0], v))
    else {
      const n = Math.hypot(...mo.axis)
      out = out.translate([(mo.axis[0] / n) * v, (mo.axis[1] / n) * v, (mo.axis[2] / n) * v])
    }
    if (prev !== m) prev.delete()
  }
  return out
}

type Box = { min: number[]; max: number[] }
const boxOf = (m: Manifold): Box => {
  const b = m.boundingBox()
  return { min: [...b.min], max: [...b.max] }
}
function boxesNear(A: Box, B: Box, pad = 0): boolean {
  for (let i = 0; i < 3; i++) if (A.min[i] - pad > B.max[i] || B.min[i] - pad > A.max[i]) return false
  return true
}
const unionBox = (a: Box | null, b: Box): Box =>
  a ? { min: a.min.map((v, i) => Math.min(v, b.min[i])), max: a.max.map((v, i) => Math.max(v, b.max[i])) } : b

function overlapVolume(a: Manifold, b: Manifold): number {
  if (!boxesNear(boxOf(a), boxOf(b))) return 0
  const x = a.intersect(b)
  const v = x.volume()
  x.delete()
  return v
}

const r1 = (n: number) => +n.toFixed(1)
const r2 = (n: number) => Math.round(n * 100) / 100
const unitOf = (m: AssemblyMotion): "°" | "mm" => (m.type === "rotate" ? "°" : "mm")
const withUnit = (v: number, u: "°" | "mm") => `${r1(v)}${u === "°" ? "°" : " mm"}`

/** Evenly spaced values across a motion's range (ends included), plus the rest pose. */
export function sampleValues(m: AssemblyMotion, n = DEFAULT_COARSE): number[] {
  const out = new Set<number>()
  for (let k = 0; k < n; k++) out.add(r2(m.range[0] + ((m.range[1] - m.range[0]) * k) / Math.max(1, n - 1)))
  out.add(r2(restValue(m)))
  return [...out].sort((a, b) => a - b)
}

/** Largest distance any point of `box` can be from the motion's axis line (bounds how far it travels per degree). */
function maxRadius(m: AssemblyMotion, box: Box): number {
  const n = Math.hypot(...m.axis)
  const u = m.axis.map((v) => v / n)
  const o = m.origin ?? [0, 0, 0]
  let r = 0
  for (let k = 0; k < 8; k++) {
    const p = [0, 1, 2].map((i) => ((k >> i) & 1 ? box.max[i] : box.min[i]) - o[i])
    const along = p[0] * u[0] + p[1] * u[1] + p[2] * u[2]
    r = Math.max(r, Math.sqrt(Math.max(0, p[0] ** 2 + p[1] ** 2 + p[2] ** 2 - along ** 2)))
  }
  return r
}

interface PoseResult {
  hits: { i: number; j: number; vol: number }[]
  gap: number // smallest gap over checked pairs (GAP_SEARCH_MM if none closer); 0 if anything collides
  gapPair: [number, number] | null
  movingBox: Box | null // bounds of the bodies that the varied motions move
}

/** Core check over already placed bodies. Exported for tests; `checkMotion` loads the project's geometry. */
export function checkBodies(
  a: Assembly,
  bodies: Body[],
  opts: MotionCheckOptions = {},
  pre: { incomplete?: string[]; warnings?: string[]; scope?: MotionCheckScope } = {},
): MotionCheck {
  const incomplete = [...(pre.incomplete ?? [])]
  const warnings = [...(pre.warnings ?? [])]
  const scope = pre.scope ?? { parts: bodies.filter((b) => b.kind === "part").map((b) => b.key), hardware: bodies.filter((b) => b.kind === "hardware").map((b) => b.key), skipped: [] }
  const motions = a.motions ?? []
  const coarseN = Math.max(2, opts.coarse ?? DEFAULT_COARSE)
  const budget = Math.max(coarseN + 1, opts.maxPositions ?? DEFAULT_MAX_POSITIONS)
  const adaptive = opts.adaptive ?? true
  const n = bodies.length

  const posed = (values: Map<string, number>) => bodies.map((b) => (b.motions.length ? poseOf(b.mesh, b.motions, values) : b.mesh))
  const release = (pose: Manifold[]) => pose.forEach((m, i) => m !== bodies[i].mesh && m.delete())

  // Rest pose: overlaps between any two bodies (the baseline) and which pairs rest against each other.
  const rest = posed(new Map())
  const restBoxes = rest.map(boxOf)
  const restOverlap: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
  const touching: boolean[][] = Array.from({ length: n }, () => new Array(n).fill(false))
  const restCollisions: MotionCollision[] = []
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (!boxesNear(restBoxes[i], restBoxes[j], TOUCH_MM * 2)) continue
      const v = overlapVolume(rest[i], rest[j])
      restOverlap[i][j] = restOverlap[j][i] = v
      const t = v > 0 || rest[i].minGap(rest[j], TOUCH_MM * 2) < TOUCH_MM
      touching[i][j] = touching[j][i] = t
      if (v > COLLISION_EPS_MM3) restCollisions.push({ a: bodies[i].key, b: bodies[j].key, volumeMm3: r1(v) })
    }
  }
  release(rest)

  /** Pose the varied motions at `values` (others at rest) and test every pair whose relative position changes. */
  function evalPose(values: Map<string, number>, varied: Set<string>, measureTouching: boolean): PoseResult {
    const sig = bodies.map((b) => b.motions.filter((m) => varied.has(m.id)).map((m) => m.id).join(","))
    const pose = posed(values)
    const boxes = pose.map(boxOf)
    const hits: PoseResult["hits"] = []
    let gap = GAP_SEARCH_MM
    let gapPair: [number, number] | null = null
    let movingBox: Box | null = null
    for (let i = 0; i < n; i++) if (sig[i]) movingBox = unionBox(movingBox, boxes[i])
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (sig[i] === sig[j]) continue // move together (or both still): nothing changes between them
        if (!boxesNear(boxes[i], boxes[j], GAP_SEARCH_MM)) continue
        const base = restOverlap[i][j]
        const vol = boxesNear(boxes[i], boxes[j]) ? overlapVolume(pose[i], pose[j]) : 0
        if (vol > base + COLLISION_EPS_MM3) hits.push({ i, j, vol })
        else if (base <= COLLISION_EPS_MM3 && (!touching[i][j] || measureTouching)) {
          const g = pose[i].minGap(pose[j], GAP_SEARCH_MM)
          if (g < gap) {
            gap = g
            gapPair = [i, j]
          }
        }
      }
    }
    release(pose)
    return { hits, gap: hits.length ? 0 : gap, gapPair, movingBox }
  }

  // ---- one motion at a time (others at rest), coarse then adaptive ----
  const reports: MotionReport[] = []
  const swept = new Map<string, Box | null>()
  for (const mo of motions) {
    const movingIdx = bodies.map((b, i) => (b.motions.some((x) => x.id === mo.id) ? i : -1)).filter((i) => i >= 0)
    const u = unitOf(mo)
    const [lo, hi] = mo.range
    if (!movingIdx.length) incomplete.push(`"${mo.label}" doesn't move any part that could be checked, so it wasn't tested.`)
    const varied = new Set([mo.id])
    const results = new Map<number, PoseResult>()
    const evalAt = (v: number) => results.set(v, evalPose(new Map([[mo.id, v]]), varied, Math.abs(v - restValue(mo)) >= SEPARATING * (hi - lo)))
    for (const v of sampleValues(mo, coarseN)) evalAt(v)
    const coarse = results.size

    // How far any moving point can travel between two poses `width` apart (mm).
    let R = 0
    for (const i of movingIdx) R = Math.max(R, mo.type === "rotate" ? maxRadius(mo, restBoxes[i]) : 0)
    const travel = (width: number) => (mo.type === "rotate" ? (R * width * Math.PI) / 180 : width)
    const minStep = Math.max(mo.type === "rotate" ? 0.1 : 0.02, (hi - lo) / 1000)
    const done = new Set<number>() // intervals (by left value) that can't be split further
    let capped = false
    while (adaptive && movingIdx.length) {
      const vals = [...results.keys()].sort((x, y) => x - y)
      let best: { a: number; b: number; score: number } | null = null
      for (let k = 0; k + 1 < vals.length; k++) {
        const [va, vb] = [vals[k], vals[k + 1]]
        if (vb - va < minStep * 2 || done.has(va)) continue
        const A = results.get(va)!
        const B = results.get(vb)!
        const hitA = A.hits.length > 0
        const hitB = B.hits.length > 0
        if (hitA && hitB) continue
        // Collision edge: find where it starts. Otherwise: could a collision hide between these two poses?
        // Nothing can if the gaps at both ends add up to more than the farthest any point travels in between.
        const score = hitA !== hitB ? 0 : (A.gap + B.gap) / Math.max(1e-9, travel(vb - va))
        if (score >= 1) continue
        if (!best || score < best.score || (score === best.score && vb - va > best.b - best.a)) best = { a: va, b: vb, score }
      }
      if (!best) break
      if (results.size >= budget) {
        capped = true
        break
      }
      const mid = r2((best.a + best.b) / 2)
      if (mid <= best.a || mid >= best.b || results.has(mid)) done.add(best.a)
      else evalAt(mid)
    }

    const samples = [...results.keys()].sort((x, y) => x - y)
    const hits = new Map<string, { a: string; b: string; atValues: number[]; maxVolumeMm3: number; worstAt: number }>()
    let minGap: number | null = null
    let gapPair: [string, string] | null = null
    let gapAt: number | null = null
    let box: Box | null = null
    for (const v of samples) {
      const r = results.get(v)!
      if (r.movingBox) box = unionBox(box, r.movingBox)
      for (const h of r.hits) {
        const [mi, oj] = movingIdx.includes(h.i) ? [h.i, h.j] : [h.j, h.i]
        const key = `${bodies[mi].key}|${bodies[oj].key}`
        const e = hits.get(key) ?? { a: bodies[mi].key, b: bodies[oj].key, atValues: [], maxVolumeMm3: 0, worstAt: v }
        e.atValues.push(v)
        if (h.vol > e.maxVolumeMm3) {
          e.maxVolumeMm3 = r1(h.vol)
          e.worstAt = v
        }
        hits.set(key, e)
      }
      if (!r.hits.length && r.gapPair && r.gap < GAP_SEARCH_MM && (minGap === null || r.gap < minGap)) {
        minGap = r.gap
        const [i, j] = movingIdx.includes(r.gapPair[0]) ? r.gapPair : [r.gapPair[1], r.gapPair[0]]
        gapPair = [bodies[i].key, bodies[j].key]
        gapAt = v
      }
    }
    swept.set(mo.id, box)
    // Longest collision-free run of samples containing the rest pose.
    const free = samples.map((v) => results.get(v)!.hits.length === 0)
    const ri = samples.indexOf(r2(restValue(mo)))
    let freeRange: [number, number] | null = null
    if (ri >= 0 && free[ri]) {
      let a0 = ri
      let b0 = ri
      while (a0 > 0 && free[a0 - 1]) a0--
      while (b0 < samples.length - 1 && free[b0 + 1]) b0++
      freeRange = [samples[a0], samples[b0]]
    }
    let smallestStep = Infinity
    for (let k = 0; k + 1 < samples.length; k++) smallestStep = Math.min(smallestStep, samples[k + 1] - samples[k])
    const coverage: MotionCoverage = {
      from: lo,
      to: hi,
      positions: samples.length,
      coarse,
      refined: samples.length - coarse,
      smallestStep: Number.isFinite(smallestStep) ? r2(smallestStep) : 0,
      capped,
    }
    const report: MotionReport = {
      id: mo.id,
      label: mo.label,
      unit: u,
      samples,
      ok: hits.size === 0,
      collisions: [...hits.values()],
      minClearanceMm: minGap === null ? null : r2(minGap),
      clearancePair: gapPair,
      clearanceAt: gapAt,
      freeRange,
      coverage,
      text: "",
    }
    report.text = motionText(report, movingIdx.length > 0)
    reports.push(report)
  }

  // ---- motions that can happen together: pose selected pairs at the ends of their ranges ----
  const pairs: { A: AssemblyMotion; B: AssemblyMotion; nested: boolean }[] = []
  for (let x = 0; x < motions.length; x++) {
    for (let y = x + 1; y < motions.length; y++) {
      const [A, B] = [motions[x], motions[y]]
      const nested = bodies.some((b) => b.motions.includes(A) && b.motions.includes(B))
      const bA = swept.get(A.id)
      const bB = swept.get(B.id)
      if (nested || (bA && bB && boxesNear(bA, bB, GAP_SEARCH_MM))) pairs.push({ A, B, nested })
    }
  }
  pairs.sort((p, q) => Number(q.nested) - Number(p.nested))
  if (pairs.length > MAX_COMBO_PAIRS) warnings.push(`${pairs.length} pairs of moves could meet; only ${MAX_COMBO_PAIRS} were checked together`)
  const combined: MotionScenario[] = []
  const ends = (m: AssemblyMotion) => [...new Set([m.range[0], m.range[1]])].filter((v) => r2(v) !== r2(restValue(m)))
  for (const { A, B } of pairs.slice(0, MAX_COMBO_PAIRS)) {
    for (const va of ends(A)) {
      for (const vb of ends(B)) {
        const r = evalPose(
          new Map([
            [A.id, va],
            [B.id, vb],
          ]),
          new Set([A.id, B.id]),
          true,
        )
        combined.push({
          values: [
            { id: A.id, value: va },
            { id: B.id, value: vb },
          ],
          label: `${A.label} at ${withUnit(va, unitOf(A))} + ${B.label} at ${withUnit(vb, unitOf(B))}`,
          ok: r.hits.length === 0,
          collisions: r.hits.map((h) => ({ a: bodies[h.i].key, b: bodies[h.j].key, volumeMm3: r1(h.vol) })),
        })
      }
    }
  }

  const problems = restCollisions.length > 0 || reports.some((r) => !r.ok) || combined.some((c) => !c.ok)
  const status = problems ? "problems" : incomplete.length ? "incomplete" : "ok"
  const notChecked = [
    "strength (how much weight or force it can take)",
    "friction (how stiff or loose it will feel)",
    "how exactly your printer makes the parts (real parts come out a little bigger or smaller)",
  ]
  if (a.hardware.some((h) => h.type === "spring")) notChecked.push("spring force, and how far springs squash or stretch")
  const out: MotionCheck = {
    ok: status === "ok",
    status,
    incomplete,
    restCollisions,
    motions: reports,
    combined,
    scope,
    notChecked,
    warnings,
    summary: "",
  }
  out.summary = motionSummary(out, motions.length)
  return out
}

/** "40–46°" style bands of consecutive colliding samples. */
function bands(atValues: number[], samples: number[], u: "°" | "mm"): string {
  const idx = atValues.map((v) => samples.indexOf(v)).sort((x, y) => x - y)
  const out: string[] = []
  for (let k = 0; k < idx.length; ) {
    let e = k
    while (e + 1 < idx.length && idx[e + 1] === idx[e] + 1) e++
    const [a, b] = [samples[idx[k]], samples[idx[e]]]
    out.push(a === b ? withUnit(a, u) : `${r1(a)}–${withUnit(b, u)}`)
    k = e + 1
  }
  return out.join(", ")
}

/** One plain line per motion, always with its scope. */
function motionText(r: MotionReport, moves: boolean): string {
  const u = r.unit
  const c = r.coverage
  const span = `${c.positions} positions from ${withUnit(c.from, u)} to ${withUnit(c.to, u)}`
  if (!moves) return `Not checked: it doesn't move any part that could be checked.`
  if (!r.ok) {
    const hits = r.collisions.map((h) => `${h.a} hits ${h.b} at ${bands(h.atValues, r.samples, u)}`).join("; ")
    return `${hits} (checked ${span}).`
  }
  let s = `No collisions found in ${span}`
  if (r.minClearanceMm !== null) {
    s += `; closest gap ${r.minClearanceMm} mm (${r.clearancePair!.join(" / ")}${r.clearanceAt !== null ? ` at ${withUnit(r.clearanceAt, u)}` : ""})`
    if (r.minClearanceMm < RUB_MM) s += `, under ${RUB_MM} mm so it may rub once printed`
  }
  return s + "."
}

/** Group skipped instances ("magnet#0".."magnet#3") by item and reason for a short sentence. */
export function skippedText(skipped: MotionCheckScope["skipped"]): string[] {
  const groups = new Map<string, { id: string; reason: string; n: number }>()
  for (const s of skipped) {
    const id = s.id.replace(/#\d+$/, "")
    const k = `${id}|${s.reason}`
    const g = groups.get(k) ?? { id, reason: s.reason, n: 0 }
    g.n++
    groups.set(k, g)
  }
  return [...groups.values()].map((g) => `${g.id}${g.n > 1 ? ` ×${g.n}` : ""} (${g.reason})`)
}

function motionSummary(c: MotionCheck, motionCount: number): string {
  const lines: string[] = []
  if (c.status === "ok") lines.push("OK: no collisions found in the positions checked below.")
  else if (c.status === "problems") lines.push("PROBLEMS: collisions found (details below).")
  else lines.push("INCOMPLETE: this check could not cover everything, so don't tell the user it moves freely.")
  for (const r of c.incomplete) lines.push(`- ${r}`)
  const inc = [...c.scope.parts, ...c.scope.hardware]
  lines.push(`Included: ${inc.length ? inc.join(", ") : "nothing"}.` + (c.scope.skipped.length ? ` Not included: ${skippedText(c.scope.skipped).join("; ")}.` : ""))
  for (const r of c.restCollisions) lines.push(`At rest, ${r.a} and ${r.b} overlap by ${r.volumeMm3} mm³: fix the placement or the geometry.`)
  for (const r of c.motions) {
    let s = `${r.label} (${r.id}): ${r.text}`
    if (!r.ok && r.freeRange) s += ` Free range is about ${r.freeRange[0]}–${withUnit(r.freeRange[1], r.unit)}: shrink the range there or change the geometry/axis.`
    if (r.coverage.refined) s += ` (${r.coverage.coarse} evenly spaced + ${r.coverage.refined} extra near close calls; spacing down to ${withUnit(r.coverage.smallestStep, r.unit)})`
    lines.push(s)
  }
  if (!motionCount) lines.push("No motions defined.")
  if (c.combined.length) {
    const bad = c.combined.filter((s) => !s.ok)
    lines.push(
      `Together (each at the ends of its range): ${c.combined.length} combination${c.combined.length > 1 ? "s" : ""} checked, ${bad.length ? `${bad.length} with collisions` : "no collisions"}.`,
    )
    for (const s of bad) lines.push(`- ${s.label}: ${s.collisions.map((x) => `${x.a} hits ${x.b}`).join(", ")}`)
  }
  if (motionCount > 1) lines.push(`Each move was checked with the other moves at rest${c.combined.length ? ", plus the combinations above" : ""}.`)
  for (const w of c.warnings) lines.push(`Note: ${w}`)
  lines.push(`Not checked: ${c.notChecked.join("; ")}.`)
  lines.push('When telling the user, say what was checked ("no collisions found in 24 positions from 0° to 110°"), not "moves freely".')
  return lines.join("\n")
}

/** Load the project's parts and placed hardware, then run the check. */
export async function checkMotion(projectId: string, a: Assembly, opts: MotionCheckOptions = {}): Promise<MotionCheck> {
  const w = await manifoldWasm()
  const incomplete: string[] = []
  const warnings: string[] = []
  const scope: MotionCheckScope = { parts: [], hardware: [], skipped: [] }
  const placements = a.placements ?? []
  const instanceCount = a.parts.reduce((s, p) => s + p.qty, 0)
  const unplaced = !placements.length && instanceCount > 1
  if (unplaced) incomplete.push("The parts have no positions yet (placements in assembly.json), so they can't be put together and checked.")
  const load =
    opts.loadMesh ??
    (async (partId: string) => {
      const stl = await exportPart(projectId, partId, "stl")
      return parseStl(await readFile(stl))
    })

  const base = new Map<string, Manifold>()
  for (const p of a.parts) {
    try {
      const mesh = await load(p.id)
      const m = new w.Manifold(new w.Mesh({ numProp: 3, vertProperties: Float32Array.from(mesh.verts), triVerts: Uint32Array.from(mesh.tris) }))
      if (m.status() !== "NoError" || !(m.volume() > 0)) {
        incomplete.push(`Part "${p.id}" isn't a closed solid${m.status() !== "NoError" ? ` (${m.status()})` : ""}, so its collisions can't be checked.`)
        m.delete()
      } else base.set(p.id, m)
    } catch (e) {
      // Mesh constructor errors on open/broken meshes, or the export failed.
      incomplete.push(`Part "${p.id}" couldn't be loaded for the check: ${String((e as Error)?.message ?? e).split("\n")[0]}`)
    }
  }

  const bodies: Body[] = []
  for (const p of a.parts) {
    for (let i = 0; i < p.qty; i++) {
      const key = p.qty > 1 ? `${p.id}#${i}` : p.id
      const m = base.get(p.id)
      if (!m) {
        scope.skipped.push({ id: key, reason: "couldn't be loaded" })
        continue
      }
      const pl = placements.find((x) => x.part === p.id && (x.instance ?? 0) === i)
      if (!pl && (placements.length || unplaced)) {
        if (placements.length) incomplete.push(`"${key}" has no position (placement), so it wasn't checked.`)
        scope.skipped.push({ id: key, reason: "no position given" })
        continue
      }
      const rotated = m.rotate(pl?.rotate ?? [0, 0, 0])
      bodies.push({ key, kind: "part", mesh: rotated.translate(pl?.translate ?? [0, 0, 0]), motions: motionsFor(a, p.id, i) })
      rotated.delete()
      scope.parts.push(key)
    }
  }
  for (const m of base.values()) m.delete()

  const hp = a.hardwarePlacements ?? []
  for (const h of a.hardware) {
    for (let i = 0; i < h.qty; i++) {
      const key = h.qty > 1 ? `${h.id}#${i}` : h.id
      const pl = hp.find((x) => x.hardware === h.id && (x.instance ?? 0) === i)
      if (!pl) {
        if (["glue", "tape", "zip-tie"].includes(h.type)) continue
        scope.skipped.push({ id: key, reason: "no position given" })
        continue
      }
      const proxy = hardwareProxy(w, h)
      if (!proxy.mesh) {
        incomplete.push(`Couldn't make a shape for ${hardwareName(h)} ("${key}"): ${proxy.reason}.`)
        scope.skipped.push({ id: key, reason: proxy.reason })
        continue
      }
      const rotated = proxy.mesh.rotate(pl.rotate ?? [0, 0, 0])
      proxy.mesh.delete()
      const [pid, pi] = (pl.movesWith ?? "").split("#")
      bodies.push({
        key,
        kind: "hardware",
        mesh: rotated.translate(pl.translate),
        motions: pl.movesWith ? motionsFor(a, pid, Number(pi ?? 0)) : [],
      })
      rotated.delete()
      scope.hardware.push(key)
    }
  }

  try {
    return checkBodies(a, bodies, opts, { incomplete, warnings, scope })
  } finally {
    for (const b of bodies) b.mesh.delete()
  }
}

/** Wrap a ready-made manifold as a body (tests). */
export function testBody(key: string, mesh: Manifold, motions: AssemblyMotion[] = [], kind: "part" | "hardware" = "part"): Body {
  return { key, kind, mesh, motions }
}
