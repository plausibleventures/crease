// Thin-wall check (R23): how thick the part is behind each side wall, measured on the mesh by shooting a ray inward
// from points on the walls to the opposite face. Walls under two extrusion lines may print with gaps between the
// lines; features under one line may not print at all. Thresholds come from the machine's nozzle.
import type { CheckMarker } from "../../shared/types"
import type { IndexedMesh } from "./mesh"

/** Extrusion line width the slicer uses for a nozzle (OrcaSlicer's default: ~112% of the nozzle). */
export const lineWidthFor = (nozzleMm: number) => Math.round(nozzleMm * 1.125 * 100) / 100

export interface ThinSpot {
  at: [number, number, number] // part coordinates (the STL's), centre of the thin area
  thicknessMm: number // thinnest measured there
  areaMm2: number // wall area that thin (one side)
  vanishes: boolean // thinner than one line
}

export interface ThicknessReport {
  lineWidthMm: number
  minWallMm: number // 2 lines
  spots: ThinSpot[] // thinnest first
  samples: number
}

interface Tri {
  a: number
  b: number
  c: number
  n: [number, number, number] // unit outward normal
  area: number
}

/** Uniform grid of triangle indexes for short-range ray queries. */
class TriGrid {
  private cells = new Map<number, number[]>()
  constructor(
    private verts: Float64Array,
    private tris: Uint32Array,
    private min: [number, number, number],
    private size: number,
  ) {
    for (let t = 0; t < tris.length / 3; t++) {
      const [lo, hi] = this.triBox(t)
      for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) this.add(this.key(x, y, z), t)
    }
  }
  private key(x: number, y: number, z: number) {
    return (x * 4096 + y) * 4096 + z
  }
  private add(k: number, t: number) {
    const l = this.cells.get(k)
    if (l) l.push(t)
    else this.cells.set(k, [t])
  }
  cellOf(v: number, axis: number) {
    return Math.floor((v - this.min[axis]) / this.size)
  }
  private triBox(t: number): [[number, number, number], [number, number, number]] {
    const lo: [number, number, number] = [Infinity, Infinity, Infinity]
    const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity]
    for (let k = 0; k < 3; k++) {
      const v = this.tris[t * 3 + k] * 3
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], this.cellOf(this.verts[v + a], a))
        hi[a] = Math.max(hi[a], this.cellOf(this.verts[v + a], a))
      }
    }
    return [lo, hi]
  }
  /** Triangles in the cells around the segment p -> p + d * len (deduplicated). */
  near(p: [number, number, number], d: [number, number, number], len: number): Set<number> {
    const out = new Set<number>()
    const q = [p[0] + d[0] * len, p[1] + d[1] * len, p[2] + d[2] * len]
    const lo = [0, 1, 2].map((a) => this.cellOf(Math.min(p[a], q[a]), a))
    const hi = [0, 1, 2].map((a) => this.cellOf(Math.max(p[a], q[a]), a))
    for (let x = lo[0]; x <= hi[0]; x++)
      for (let y = lo[1]; y <= hi[1]; y++)
        for (let z = lo[2]; z <= hi[2]; z++) for (const t of this.cells.get(this.key(x, y, z)) ?? []) out.add(t)
    return out
  }
}

/** Möller–Trumbore: distance along the ray to the triangle, or -1. */
function rayTri(verts: Float64Array, tri: Tri, o: [number, number, number], d: [number, number, number]): number {
  const a = tri.a * 3, b = tri.b * 3, c = tri.c * 3
  const e1 = [verts[b] - verts[a], verts[b + 1] - verts[a + 1], verts[b + 2] - verts[a + 2]]
  const e2 = [verts[c] - verts[a], verts[c + 1] - verts[a + 1], verts[c + 2] - verts[a + 2]]
  const px = d[1] * e2[2] - d[2] * e2[1], py = d[2] * e2[0] - d[0] * e2[2], pz = d[0] * e2[1] - d[1] * e2[0]
  const det = e1[0] * px + e1[1] * py + e1[2] * pz
  if (Math.abs(det) < 1e-12) return -1
  const inv = 1 / det
  const tx = o[0] - verts[a], ty = o[1] - verts[a + 1], tz = o[2] - verts[a + 2]
  const u = (tx * px + ty * py + tz * pz) * inv
  if (u < -1e-9 || u > 1 + 1e-9) return -1
  const qx = ty * e1[2] - tz * e1[1], qy = tz * e1[0] - tx * e1[2], qz = tx * e1[1] - ty * e1[0]
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv
  if (v < -1e-9 || u + v > 1 + 1e-9) return -1
  return (e2[0] * qx + e2[1] * qy + e2[2] * qz) * inv
}

/**
 * Measure side-wall thickness (faces within ~55° of vertical; floors and roofs are the layer height's business) and
 * group the thin spots. A spot counts only where the ray meets a face pointing back at it (the other side of a wall
 * or pin), so wedge tips and fillets don't read as thin walls.
 */
export function measureThinWalls(mesh: IndexedMesh, nozzleMm: number, opts: { maxSamples?: number; minSpotAreaMm2?: number } = {}): ThicknessReport {
  const lineW = lineWidthFor(nozzleMm)
  const minWall = Math.round(lineW * 2 * 100) / 100
  const reach = minWall * 1.05
  const { verts, tris } = mesh
  const nt = tris.length / 3
  const empty: ThicknessReport = { lineWidthMm: lineW, minWallMm: minWall, spots: [], samples: 0 }
  if (!nt) return empty

  // Triangles with unit normals; flip everything if the mesh is wound inside-out (negative volume).
  const list: Tri[] = []
  let vol = 0
  for (let t = 0; t < nt; t++) {
    const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3
    const ux = verts[b] - verts[a], uy = verts[b + 1] - verts[a + 1], uz = verts[b + 2] - verts[a + 2]
    const vx = verts[c] - verts[a], vy = verts[c + 1] - verts[a + 1], vz = verts[c + 2] - verts[a + 2]
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz)
    vol += verts[a] * (verts[b + 1] * verts[c + 2] - verts[b + 2] * verts[c + 1]) - verts[a + 1] * (verts[b] * verts[c + 2] - verts[b + 2] * verts[c]) + verts[a + 2] * (verts[b] * verts[c + 1] - verts[b + 1] * verts[c])
    list.push({ a: tris[t * 3], b: tris[t * 3 + 1], c: tris[t * 3 + 2], n: len ? [nx / len, ny / len, nz / len] : [0, 0, 0], area: len / 2 })
  }
  if (vol < 0) for (const t of list) t.n = [-t.n[0], -t.n[1], -t.n[2]]

  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < verts.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], verts[i + k])
      max[k] = Math.max(max[k], verts[i + k])
    }
  const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2])
  const grid = new TriGrid(verts, tris, min, Math.max(reach, extent / 64))

  // Sample points on side walls: about one per 0.5 mm² (big flat faces get several), capped overall.
  const side = list.map((t, i) => ({ t, i })).filter(({ t }) => t.area > 1e-6 && Math.abs(t.n[2]) < 0.82)
  const totalArea = side.reduce((s, x) => s + x.t.area, 0)
  const budget = opts.maxSamples ?? 40000
  const density = Math.min(2, budget / Math.max(totalArea, 1e-6))
  let samples = 0
  let seed = 1
  const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
  // mid: the middle of the wall (between this face and the one opposite); axis: the wall's normal, sign-free (both faces
  // of one wall agree) — used to tell neighbouring walls apart
  const thin: { p: [number, number, number]; d: number; area: number; mid: [number, number, number]; axis: [number, number, number] }[] = []
  for (const { t, i } of side) {
    const n = Math.max(1, Math.min(64, Math.round(t.area * density)))
    const a = t.a * 3, b = t.b * 3, c = t.c * 3
    const dir: [number, number, number] = [-t.n[0], -t.n[1], -t.n[2]]
    for (let s = 0; s < n; s++) {
      // centroid first, then random points inside the triangle
      let r1 = 1 / 3, r2 = 1 / 3
      if (s > 0) {
        r1 = rnd()
        r2 = rnd()
        if (r1 + r2 > 1) {
          r1 = 1 - r1
          r2 = 1 - r2
        }
      }
      const p: [number, number, number] = [0, 1, 2].map((k) => verts[a + k] + r1 * (verts[b + k] - verts[a + k]) + r2 * (verts[c + k] - verts[a + k])) as [number, number, number]
      const o: [number, number, number] = [p[0] + dir[0] * 1e-4, p[1] + dir[1] * 1e-4, p[2] + dir[2] * 1e-4]
      samples++
      let best = Infinity
      let opposite = false
      for (const j of grid.near(o, dir, reach)) {
        if (j === i) continue
        const other = list[j]
        const d = rayTri(verts, other, o, dir)
        if (d <= 1e-6 || d >= best) continue
        best = d
        opposite = other.n[0] * t.n[0] + other.n[1] * t.n[1] + other.n[2] * t.n[2] < -0.5
      }
      if (best < minWall && opposite) {
        const big = [0, 1, 2].reduce((b, k) => (Math.abs(t.n[k]) > Math.abs(t.n[b]) ? k : b), 0)
        const sgn = t.n[big] < 0 ? -1 : 1
        thin.push({
          p,
          d: best + 1e-4,
          area: t.area / n,
          mid: [p[0] + (dir[0] * best) / 2, p[1] + (dir[1] * best) / 2, p[2] + (dir[2] * best) / 2],
          axis: [t.n[0] * sgn, t.n[1] * sgn, t.n[2] * sgn],
        })
      }
    }
  }

  // Group thin samples into spots: samples of one wall have their wall middles near each other (2 mm cells and their
  // neighbours) AND in the same plane locally, so two walls side by side (a slot, a pen hole's sides) stay two spots.
  const cell = 2
  const planeTol = 0.5
  const cellOf = (p: [number, number, number]) => [0, 1, 2].map((k) => Math.floor((p[k] - min[k]) / cell))
  const byCell = new Map<string, number[]>()
  thin.forEach((s, i) => {
    const k = cellOf(s.mid).join(",")
    const l = byCell.get(k)
    if (l) l.push(i)
    else byCell.set(k, [i])
  })
  const parent = thin.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]]
    return i
  }
  thin.forEach((s, i) => {
    const [x, y, z] = cellOf(s.mid)
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const j of byCell.get(`${x + dx},${y + dy},${z + dz}`) ?? []) {
            if (j <= i) continue
            const o = thin[j]
            const off = (o.mid[0] - s.mid[0]) * s.axis[0] + (o.mid[1] - s.mid[1]) * s.axis[1] + (o.mid[2] - s.mid[2]) * s.axis[2]
            if (Math.abs(off) <= planeTol) parent[find(j)] = find(i)
          }
  })
  const groups = new Map<number, number[]>()
  thin.forEach((_, i) => {
    const r = find(i)
    const g = groups.get(r)
    if (g) g.push(i)
    else groups.set(r, [i])
  })
  const spots: ThinSpot[] = []
  const minArea = opts.minSpotAreaMm2 ?? 0.5
  for (const members of groups.values()) {
    const area = members.reduce((s, i) => s + thin[i].area, 0)
    if (area < minArea) continue
    const thinnest = Math.min(...members.map((i) => thin[i].d))
    // Report the typical thickness of the spot (median), so one grazing ray doesn't set the number.
    const ds = members.map((i) => thin[i].d).sort((a, b) => a - b)
    const typical = ds[Math.floor(ds.length / 2)]
    const at = [0, 1, 2].map((k) => members.reduce((s, i) => s + thin[i].p[k] * thin[i].area, 0) / area) as [number, number, number]
    // snap the marker onto the nearest real sample so it sits on the surface
    const near = members.reduce((b, i) => (dist(thin[i].p, at) < dist(thin[b].p, at) ? i : b), members[0])
    spots.push({
      at: thin[near].p.map((v) => round2(v)) as [number, number, number],
      thicknessMm: round2(typical),
      areaMm2: round2(area),
      vanishes: thinnest < lineW && typical < lineW,
    })
  }
  spots.sort((a, b) => a.thicknessMm - b.thicknessMm || b.areaMm2 - a.areaMm2)
  return { lineWidthMm: lineW, minWallMm: minWall, spots, samples }
}

const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const round2 = (v: number) => Math.round(v * 100) / 100

/** Plain-words position of a point in the part's box: "near the top of the left side". */
export function describePoint(p: [number, number, number], bbox: { min: [number, number, number]; max: [number, number, number] }): string {
  const rel = [0, 1, 2].map((k) => {
    const s = bbox.max[k] - bbox.min[k]
    return s > 1e-6 ? (p[k] - bbox.min[k]) / s : 0.5
  })
  const words: string[] = []
  words.push(rel[2] > 0.75 ? "near the top" : rel[2] < 0.25 ? "near the bottom" : "halfway up")
  const xy: string[] = []
  if (rel[1] < 0.2) xy.push("front")
  else if (rel[1] > 0.8) xy.push("back")
  if (rel[0] < 0.2) xy.push("left")
  else if (rel[0] > 0.8) xy.push("right")
  words.push(xy.length ? `at the ${xy.join("-")}` : "in the middle")
  return words.join(", ")
}

/** Check-panel markers for thin spots (at most `max`). */
export function thinMarkers(spots: ThinSpot[], max = 12): CheckMarker[] {
  return spots.slice(0, max).map((s) => ({ at: s.at, label: `${s.thicknessMm.toFixed(2)} mm`, severity: "warn" as const }))
}
