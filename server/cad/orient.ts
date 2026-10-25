// Orientation suggestions (R23): try a few ways to lay the part on the bed (as it is now, and each large flat face
// down), measure each on the mesh (overhangs past 45° that need supports, flat undersides that bridge, bed contact,
// height, rough time) and suggest a clearly better one in plain words. Applying one never edits the mesh: the part's
// .scad gets a documented transform, `print_orientation = [x, y, z];` + `rotate(print_orientation) { … }` around its
// geometry (see writeOrientation).
import type { OrientationAdvice, OrientationCandidate } from "../../shared/types"
import type { IndexedMesh } from "./mesh"

type Vec = [number, number, number]
type Mat = [Vec, Vec, Vec] // rows

const DEG = Math.PI / 180
const I3: Mat = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]

const mul = (a: Mat, b: Mat): Mat =>
  [0, 1, 2].map((r) => [0, 1, 2].map((c) => a[r][0] * b[0][c] + a[r][1] * b[1][c] + a[r][2] * b[2][c])) as Mat
const apply = (m: Mat, v: Vec): Vec => [0, 1, 2].map((r) => m[r][0] * v[0] + m[r][1] * v[1] + m[r][2] * v[2]) as Vec

/** OpenSCAD rotate([a, b, c]) = Rz(c) · Ry(b) · Rx(a). */
export function eulerToMat([a, b, c]: Vec): Mat {
  const [ca, sa, cb, sb, cc, sc] = [Math.cos(a * DEG), Math.sin(a * DEG), Math.cos(b * DEG), Math.sin(b * DEG), Math.cos(c * DEG), Math.sin(c * DEG)]
  const rx: Mat = [
    [1, 0, 0],
    [0, ca, -sa],
    [0, sa, ca],
  ]
  const ry: Mat = [
    [cb, 0, sb],
    [0, 1, 0],
    [-sb, 0, cb],
  ]
  const rz: Mat = [
    [cc, -sc, 0],
    [sc, cc, 0],
    [0, 0, 1],
  ]
  return mul(rz, mul(ry, rx))
}

const clean = (deg: number) => {
  let d = Math.round(deg * 100) / 100
  if (Object.is(d, -0) || Math.abs(d) < 0.005) d = 0
  if (d <= -180) d += 360
  if (d > 180) d -= 360
  return d
}

/** Angles for OpenSCAD's rotate() from a rotation matrix (inverse of eulerToMat). */
export function matToEuler(m: Mat): Vec {
  const sb = -m[2][0]
  if (Math.abs(sb) > 0.99999) {
    const b = sb > 0 ? 90 : -90
    const a = Math.atan2(-m[1][2], m[1][1]) / DEG
    return [clean(a), b, 0]
  }
  const b = Math.asin(sb) / DEG
  const a = Math.atan2(m[2][1], m[2][2]) / DEG
  const c = Math.atan2(m[1][0], m[0][0]) / DEG
  return [clean(a), clean(b), clean(c)]
}

/** Rotation that turns direction n to point straight down (-Z). */
function faceDown(n: Vec): Mat {
  const d = -n[2] // n · (0,0,-1)
  if (d > 0.999999) return I3
  if (d < -0.999999) return eulerToMat([180, 0, 0])
  // axis = n × (0,0,-1) = (-n.y, n.x, 0)
  const ax = -n[1], ay = n[0]
  const s = Math.hypot(ax, ay)
  const [x, y] = [ax / s, ay / s]
  const angle = Math.acos(Math.max(-1, Math.min(1, d)))
  const c = Math.cos(angle), si = Math.sin(angle), t = 1 - c
  return [
    [t * x * x + c, t * x * y, si * y],
    [t * x * y, t * y * y + c, -si * x],
    [-si * y, si * x, c],
  ]
}

function sideName(n: Vec, i: number): { id: string; label: string } {
  const near = (v: Vec) => n[0] * v[0] + n[1] * v[1] + n[2] * v[2] > 0.995
  if (near([0, 0, 1])) return { id: "upside-down", label: "Upside down (top face on the bed)" }
  if (near([0, 1, 0])) return { id: "on-its-back", label: "On its back" }
  if (near([0, -1, 0])) return { id: "on-its-front", label: "On its front" }
  if (near([-1, 0, 0])) return { id: "on-its-left", label: "On its left side" }
  if (near([1, 0, 0])) return { id: "on-its-right", label: "On its right side" }
  return { id: `tilted-${i}`, label: "Tilted, with a sloped face on the bed" }
}

interface FaceData {
  n: Vec[] // unit normals (current orientation)
  area: number[]
  centroid: Vec[]
}

function faceData(mesh: IndexedMesh): FaceData {
  const { verts, tris } = mesh
  const n: Vec[] = []
  const area: number[] = []
  const centroid: Vec[] = []
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3
    const ux = verts[b] - verts[a], uy = verts[b + 1] - verts[a + 1], uz = verts[b + 2] - verts[a + 2]
    const vx = verts[c] - verts[a], vy = verts[c + 1] - verts[a + 1], vz = verts[c + 2] - verts[a + 2]
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz)
    n.push(len ? [nx / len, ny / len, nz / len] : [0, 0, 0])
    area.push(len / 2)
    centroid.push([(verts[a] + verts[b] + verts[c]) / 3, (verts[a + 1] + verts[b + 1] + verts[c + 1]) / 3, (verts[a + 2] + verts[b + 2] + verts[c + 2]) / 3])
  }
  return { n, area, centroid }
}

const SHORT_BRIDGE_MM = 10 // anchored spans this short bridge cleanly (print journal)
const LAYER_MM = 0.2

interface Metrics {
  heightMm: number
  bedContactMm2: number
  overhangMm2: number
  bridgeMm2: number
  supportMm2: number
  timeS: number
  tippy: boolean
  footprint: [number, number]
}

/** Measure the mesh laid down with rotation r (the slicer drops it onto the bed). */
export function measure(mesh: IndexedMesh, r: Mat, f = faceData(mesh), volumeMm3?: number): Metrics {
  const { verts, tris } = mesh
  const nv = verts.length / 3
  const rv = new Float64Array(verts.length)
  const min: Vec = [Infinity, Infinity, Infinity]
  const max: Vec = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < nv; i++) {
    const p = apply(r, [verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]])
    for (let k = 0; k < 3; k++) {
      rv[i * 3 + k] = p[k]
      min[k] = Math.min(min[k], p[k])
      max[k] = Math.max(max[k], p[k])
    }
  }
  const zTol = 0.05
  const overNz = -Math.sin(Math.PI / 4)
  let contact = 0
  let overhang = 0
  let surface = 0
  let supportVol = 0 // rough: overhang area × height above the bed
  const flatDown: number[] = []
  for (let t = 0; t < f.n.length; t++) {
    const nz = r[2][0] * f.n[t][0] + r[2][1] * f.n[t][1] + r[2][2] * f.n[t][2]
    const area = f.area[t]
    surface += area
    if (!area) continue
    const zs = [rv[tris[t * 3] * 3 + 2], rv[tris[t * 3 + 1] * 3 + 2], rv[tris[t * 3 + 2] * 3 + 2]]
    const onBed = Math.max(...zs) <= min[2] + zTol
    if (onBed && nz < -0.99) contact += area
    else if (!onBed && nz < -0.99) flatDown.push(t)
    else if (!onBed && nz < overNz) {
      overhang += area
      supportVol += area * Math.abs(nz) * ((zs[0] + zs[1] + zs[2]) / 3 - min[2])
    }
  }
  // Flat undersides: group touching ones; narrow ones bridge, wide ones need supports.
  let bridge = 0
  let wideFlat = 0
  if (flatDown.length) {
    const parent = new Map<number, number>()
    const find = (x: number): number => {
      let p = parent.get(x) ?? x
      while (p !== (parent.get(p) ?? p)) p = parent.get(p) ?? p
      parent.set(x, p)
      return p
    }
    for (const t of flatDown) {
      const [a, b, c] = [tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]]
      parent.set(find(a), find(b))
      parent.set(find(b), find(c))
    }
    const groups = new Map<number, { area: number; lo: [number, number]; hi: [number, number]; z: number }>()
    for (const t of flatDown) {
      const root = find(tris[t * 3])
      const g = groups.get(root) ?? { area: 0, lo: [Infinity, Infinity] as [number, number], hi: [-Infinity, -Infinity] as [number, number], z: 0 }
      g.area += f.area[t]
      for (let k = 0; k < 3; k++) {
        const v = tris[t * 3 + k] * 3
        g.lo = [Math.min(g.lo[0], rv[v]), Math.min(g.lo[1], rv[v + 1])]
        g.hi = [Math.max(g.hi[0], rv[v]), Math.max(g.hi[1], rv[v + 1])]
        g.z = rv[v + 2]
      }
      groups.set(root, g)
    }
    for (const g of groups.values()) {
      const span = Math.min(g.hi[0] - g.lo[0], g.hi[1] - g.lo[1])
      if (span <= SHORT_BRIDGE_MM) bridge += g.area
      else {
        wideFlat += g.area
        supportVol += g.area * (g.z - min[2])
      }
    }
  }
  const height = max[2] - min[2]
  const fx = max[0] - min[0]
  const fy = max[1] - min[1]
  // Rough time: shells + some infill at ~8 mm³/s, ~2.5 s per layer change, supports at 15% density.
  const vol = volumeMm3 ?? surface * 0.6
  const timeS = (surface * 0.8 + vol * 0.15) / 8 + (height / LAYER_MM) * 2.5 + (supportVol * 0.15) / 8
  return {
    heightMm: height,
    bedContactMm2: contact,
    overhangMm2: overhang,
    bridgeMm2: bridge,
    supportMm2: overhang + wideFlat,
    timeS,
    tippy: Math.min(fx, fy) > 0 && height > 4 * Math.min(fx, fy),
    footprint: [fx, fy],
  }
}

/** Large flat faces (by summed area per normal direction), biggest first. */
function flatFaces(f: FaceData, totalArea: number): Vec[] {
  const bins = new Map<string, { n: Vec; area: number }>()
  for (let t = 0; t < f.n.length; t++) {
    const n = f.n[t]
    if (!f.area[t] || (!n[0] && !n[1] && !n[2])) continue
    const k = n.map((v) => Math.round(v * 50)).join(",")
    const b = bins.get(k)
    if (b) {
      b.area += f.area[t]
      for (let i = 0; i < 3; i++) b.n[i] += n[i] * f.area[t]
    } else bins.set(k, { n: [n[0] * f.area[t], n[1] * f.area[t], n[2] * f.area[t]], area: f.area[t] })
  }
  return [...bins.values()]
    .filter((b) => b.area >= Math.max(0.04 * totalArea, 20))
    .sort((a, b) => b.area - a.area)
    .slice(0, 6)
    .map((b) => {
      const l = Math.hypot(...b.n)
      return [b.n[0] / l, b.n[1] / l, b.n[2] / l] as Vec
    })
}

const r0 = (v: number) => Math.round(v)
const fmtArea = (a: number) => (a >= 1000 ? `${(a / 100).toFixed(0)} cm²` : `${r0(a)} mm²`)

/**
 * Evaluate the current orientation and each large flat face down; suggest one only when it's clearly better: it
 * needs much less support, or (with no more support) prints much faster, and it still sits well on the bed. Ties keep
 * the current orientation (e.g. a flat display piece face up vs face down: the printer's lessons decide that).
 * `current` = the rotation already written in the part's .scad (print_orientation), so suggestions are absolute.
 */
export function adviseOrientation(mesh: IndexedMesh, current: Vec = [0, 0, 0], volumeMm3?: number): OrientationAdvice {
  const f = faceData(mesh)
  const totalArea = f.area.reduce((a, b) => a + b, 0)
  const base = eulerToMat(current)
  const tried: { id: string; label: string; r: Mat; m: Metrics }[] = [{ id: "current", label: "As it is now", r: I3, m: measure(mesh, I3, f, volumeMm3) }]
  flatFaces(f, totalArea).forEach((n, i) => {
    if (n[2] < -0.995) return // already face down: that's the current orientation
    const r = faceDown(n)
    const name = sideName(n, i + 1)
    if (tried.some((t) => t.id === name.id)) return
    tried.push({ ...name, r, m: measure(mesh, r, f, volumeMm3) })
  })
  const cur = tried[0].m
  const toCandidate = (t: (typeof tried)[number]): OrientationCandidate => ({
    id: t.id,
    label: t.label,
    rotate: t.id === "current" ? current.map(clean) as Vec : matToEuler(mul(t.r, base)),
    heightMm: round1(t.m.heightMm),
    bedContactMm2: r0(t.m.bedContactMm2),
    overhangMm2: r0(t.m.overhangMm2),
    bridgeMm2: r0(t.m.bridgeMm2),
    supportMm2: r0(t.m.supportMm2),
    relTime: Math.round((t.m.timeS / Math.max(cur.timeS, 1e-6)) * 100) / 100,
    tippy: t.m.tippy,
  })
  const candidates = tried.map(toCandidate)
  const current_ = candidates[0]

  // Minimum bed contact: the same rule as the first_layer check (1% of the footprint, at most 50 mm²).
  const sitsWell = (m: Metrics) => m.bedContactMm2 >= Math.min(m.footprint[0] * m.footprint[1] * 0.01, 50) && m.bedContactMm2 > 0
  const better = tried
    .slice(1)
    .map((t, i) => ({ t, c: candidates[i + 1] }))
    .filter(({ t }) => sitsWell(t.m) && (!t.m.tippy || cur.tippy))
    .filter(({ t }) => {
      const lessSupport = t.m.supportMm2 <= cur.supportMm2 * 0.6 && cur.supportMm2 - t.m.supportMm2 >= 50
      const faster = t.m.supportMm2 <= cur.supportMm2 + 10 && t.m.timeS <= cur.timeS * 0.75
      const steadier = cur.tippy && !t.m.tippy && t.m.supportMm2 <= cur.supportMm2 + 10
      const grips = !sitsWell(cur) && t.m.supportMm2 <= cur.supportMm2 + 10
      return lessSupport || faster || steadier || grips
    })
    .sort((a, b) => a.t.m.supportMm2 - b.t.m.supportMm2 || a.t.m.timeS - b.t.m.timeS)
  const pick = better[0]?.c ?? null

  const reasons: string[] = []
  let summary: string
  if (pick) {
    const pm = better[0].t.m
    if (pm.supportMm2 < 1) reasons.push(cur.supportMm2 >= 1 ? `no supports needed (as it is now, about ${fmtArea(cur.supportMm2)} of overhangs need them)` : "no supports needed")
    else if (pm.supportMm2 < cur.supportMm2) reasons.push(`much less support (${fmtArea(pm.supportMm2)} instead of ${fmtArea(cur.supportMm2)})`)
    const faster = 1 - pm.timeS / cur.timeS
    if (faster >= 0.15) reasons.push(`about ${Math.round((faster * 100) / 5) * 5}% faster (${round1(pm.heightMm)} mm tall instead of ${round1(cur.heightMm)} mm)`)
    if (cur.tippy && !pm.tippy) reasons.push("steadier: it no longer stands tall and narrow on the bed")
    if (!sitsWell(cur)) reasons.push("a flat face on the bed, so it sticks")
    else if (pm.bedContactMm2 > cur.bedContactMm2 * 1.5) reasons.push("a bigger flat face on the bed holds it better")
    if (pm.bridgeMm2 > 0) reasons.push(`its flat undersides are short bridges (up to ${SHORT_BRIDGE_MM} mm), which print cleanly`)
    reasons.push("the face on the bed comes out flat and takes the plate's finish")
    summary = `${actionFor(pick)}: ${reasons.slice(0, 2).join(", ")}.`
  } else {
    if (cur.supportMm2 < 1) reasons.push("no supports needed as it is")
    else reasons.push(`no other flat side down needs less support (about ${fmtArea(cur.supportMm2)} needs it now)`)
    if (cur.bridgeMm2 > 0) reasons.push(`flat undersides are short bridges (up to ${SHORT_BRIDGE_MM} mm), which print cleanly`)
    summary = `Keep it as it is: ${reasons[0]}.`
  }
  return { current: current_, suggestion: pick, reasons, summary, candidates }
}

const round1 = (v: number) => Math.round(v * 10) / 10

/** "Lay it on its back", "Turn it upside down", … */
export function actionFor(c: { id: string; label: string }): string {
  if (c.id === "upside-down") return "Turn it upside down"
  if (c.id.startsWith("on-its-")) return `Lay it ${c.label.charAt(0).toLowerCase()}${c.label.slice(1)}`
  if (c.id.startsWith("tilted")) return "Tip it so a sloped face is on the bed"
  return "Keep it as it is"
}

/* ---------- writing the transform into the .scad ---------- */

export const ORIENTATION_MARK = "printstudio:orientation"
const VEC_RE = /^(\s*print_orientation\s*=\s*)\[[^\]]*\](\s*;)/m

/** The rotation the part's source already applies (print_orientation), or [0,0,0]. */
export function readOrientation(src: string): Vec {
  if (!src.includes(ORIENTATION_MARK)) return [0, 0, 0]
  const m = src.match(/^\s*print_orientation\s*=\s*\[([^\]]*)\]\s*;/m)
  const v = m?.[1].split(",").map((s) => Number(s.trim())) ?? []
  return v.length === 3 && v.every(Number.isFinite) ? (v as Vec) : [0, 0, 0]
}

const vecLit = (v: Vec) => `[${v.map((x) => clean(x)).join(", ")}]`

/** The documented block: geometry inside rotate(print_orientation). `body` is already indented. */
export function orientationBlock(rot: Vec, body: string): string {
  return `// ${ORIENTATION_MARK}: how this part lies on the print bed (degrees about x, y, z), set by Crease.
// The design itself is unchanged; [0, 0, 0] prints it exactly as modelled.
print_orientation = ${vecLit(rot)};
rotate(print_orientation) { // ${ORIENTATION_MARK}
${body}
} // ${ORIENTATION_MARK} end
`
}

interface Stmt {
  start: number
  end: number // exclusive
  kind: "geometry" | "other"
}

/**
 * Split OpenSCAD source into top-level statements (comments, strings and nesting aware). Assignments, module and
 * function definitions, include/use lines are "other"; everything else (calls, blocks, if/for, modifiers) is
 * geometry. Exported for tests.
 */
export function topLevelStatements(src: string): Stmt[] {
  const out: Stmt[] = []
  let i = 0
  const n = src.length
  const skipSpace = () => {
    for (;;) {
      while (i < n && /\s/.test(src[i])) i++
      if (src.startsWith("//", i)) {
        while (i < n && src[i] !== "\n") i++
      } else if (src.startsWith("/*", i)) {
        const e = src.indexOf("*/", i + 2)
        i = e < 0 ? n : e + 2
      } else return
    }
  }
  /** Advance past one statement starting at i (handles if/else chains and nested blocks). */
  const scanStatement = () => {
    let depth = 0
    for (;;) {
      if (i >= n) return
      const ch = src[i]
      if (src.startsWith("//", i) || src.startsWith("/*", i)) {
        skipSpace()
        continue
      }
      if (ch === '"') {
        i++
        while (i < n && src[i] !== '"') i += src[i] === "\\" ? 2 : 1
        i++
        continue
      }
      if (ch === "(" || ch === "[" || ch === "{") depth++
      else if (ch === ")" || ch === "]" || ch === "}") {
        depth--
        if (depth === 0 && ch === "}") {
          i++
          // `} else …` continues the statement
          const save = i
          skipSpace()
          if (/^else\b/.test(src.slice(i, i + 5))) {
            i += 4
            continue
          }
          i = save
          return
        }
      } else if (ch === ";" && depth === 0) {
        i++
        return
      }
      i++
    }
  }
  for (;;) {
    skipSpace()
    if (i >= n) break
    const start = i
    const head = src.slice(i, i + 200)
    if (/^(include|use)\s*</.test(head)) {
      const e = src.indexOf(">", i)
      i = e < 0 ? n : e + 1
      out.push({ start, end: i, kind: "other" })
      continue
    }
    const isDef = /^(module|function)\b/.test(head)
    const isAssign = /^\$?[A-Za-z_][A-Za-z0-9_]*\s*=(?!=)/.test(head)
    if (head.startsWith(";")) {
      i++
      continue
    }
    scanStatement()
    out.push({ start, end: i, kind: isDef || isAssign ? "other" : "geometry" })
  }
  return out
}

/**
 * Set the part's print orientation in its source. With the block already there, only the vector changes. Otherwise
 * every top-level geometry statement moves (in order) into the block at the end of the file; assignments, modules,
 * functions and includes stay where they are, so Customizer values and -D overrides keep working (OpenSCAD evaluates
 * top-level assignments before geometry wherever they are written).
 */
export function writeOrientation(src: string, rot: Vec): string {
  if (src.includes(ORIENTATION_MARK) && VEC_RE.test(src)) return src.replace(VEC_RE, (_m, a: string, b: string) => `${a}${vecLit(rot)}${b}`)
  const stmts = topLevelStatements(src).filter((s) => s.kind === "geometry")
  if (!stmts.length) throw new Error("no top-level geometry found to rotate")
  let rest = ""
  let at = 0
  for (const s of stmts) {
    rest += src.slice(at, s.start)
    at = s.end
  }
  rest += src.slice(at)
  const body = stmts
    .map((s) =>
      src
        .slice(s.start, s.end)
        .split("\n")
        .map((l) => (l.trim() ? `  ${l}` : l))
        .join("\n"),
    )
    .join("\n")
  return `${rest.replace(/\s+$/, "")}\n\n${orientationBlock(rot, body)}`
}
