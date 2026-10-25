// OWNER: plates agent (R13). Where the slicer actually put each part: OrcaSlicer's EXCLUDE_OBJECT_DEFINE lines
// (name, CENTER, POLYGON = footprint hull in bed mm), mapped back to the job's parts (entry + instance + letter), and
// the rotation/translation that takes the part's own mesh onto that footprint (OrcaSlicer may rotate when arranging).
import { readFileSync } from "node:fs"
import type { PlacedObject } from "../../shared/types"

type Pt = [number, number]

export interface ExcludeObjectDef {
  name: string // e.g. "tag-a.stl_id_1_copy_0"
  center: Pt | null
  polygon: Pt[]
}

/** Every `EXCLUDE_OBJECT_DEFINE NAME=… CENTER=x,y POLYGON=[[x,y],…]` line, in file order. */
export function parseExcludeObjects(text: string): ExcludeObjectDef[] {
  const out: ExcludeObjectDef[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(/^EXCLUDE_OBJECT_DEFINE NAME=(\S+)([^\n]*)$/gm)) {
    // names are unique per file; a repeat means the text holds the same part twice (e.g. overlapping head + tail reads)
    if (seen.has(m[1])) continue
    seen.add(m[1])
    const rest = m[2]
    const c = rest.match(/CENTER=([\d.eE+-]+),([\d.eE+-]+)/)
    const poly = rest.match(/POLYGON=(\[\[.*\]\])/)
    let polygon: Pt[] = []
    if (poly) {
      try {
        polygon = (JSON.parse(poly[1]) as number[][]).filter((p) => p.length >= 2 && p.every(Number.isFinite)).map((p) => [p[0], p[1]] as Pt)
      } catch {
        polygon = []
      }
    }
    // OrcaSlicer closes the ring (last point = first); drop the duplicate.
    if (polygon.length > 1 && polygon[0][0] === polygon.at(-1)![0] && polygon[0][1] === polygon.at(-1)![1]) polygon.pop()
    out.push({ name: m[1], center: c ? [Number(c[1]), Number(c[2])] : null, polygon })
  }
  return out
}

/** "<part>.stl_id_<n>_copy_<c>" -> part id (also accepts plain "<part>.stl" / "<part>"). */
export const partOfObjectName = (name: string) => name.replace(/\.stl_id_\d+_copy_\d+$/, "").replace(/\.stl$/, "")
/** The object index OrcaSlicer gave it (sort key for copies of the same part; not the input order). */
export const objectIndexOf = (name: string) => Number(name.match(/_id_(\d+)_copy_(\d+)$/)?.slice(1).join(".") ?? NaN)

/** "A", "B", … "Z", "AA", "AB", … */
export function letterFor(i: number): string {
  let s = ""
  let n = i
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

export interface Entry {
  partId: string
  qty: number
  overrides?: Record<string, string | number | boolean>
}

/**
 * Map each plate's objects to the job's entries. Instances are numbered over the entries in order
 * (key 1 = entry 0's first copy, …), which is also the letter order (A = key 1) and the assemble_index the
 * per-part/multicolour path uses. `keys[plate][name]` (from that path) pins an object to its key exactly; otherwise
 * copies of the same part are matched in plate order then OrcaSlicer's object index (the plain path only runs when
 * every copy of a part is identical, so which copy is which doesn't change what prints).
 */
export function mapPlateObjects(
  plates: ExcludeObjectDef[][],
  entries: Entry[],
  keys?: (Record<string, number> | undefined)[],
): Omit<PlacedObject, "rotationDeg" | "translate">[][] {
  const slots: { key: number; entry: number; instance: number; partId: string }[] = []
  entries.forEach((e, entry) => {
    for (let i = 0; i < Math.max(1, e.qty); i++) slots.push({ key: slots.length + 1, entry, instance: i + 1, partId: e.partId })
  })
  const used = new Set<number>()
  const byKey = new Map(slots.map((s) => [s.key, s]))
  const result: Omit<PlacedObject, "rotationDeg" | "translate">[][] = plates.map(() => [])
  const pending: { plate: number; idx: number; def: ExcludeObjectDef }[] = []
  plates.forEach((defs, plate) => {
    defs.forEach((def, idx) => {
      const k = keys?.[plate]?.[def.name]
      const s = k != null ? byKey.get(k) : undefined
      if (s && !used.has(s.key)) {
        used.add(s.key)
        result[plate][idx] = build(def, s)
      } else pending.push({ plate, idx, def })
    })
  })
  pending.sort((a, b) => a.plate - b.plate || objectIndexOf(a.def.name) - objectIndexOf(b.def.name) || a.idx - b.idx)
  for (const p of pending) {
    const partId = partOfObjectName(p.def.name)
    const s = slots.find((x) => x.partId === partId && !used.has(x.key))
    if (s) used.add(s.key)
    result[p.plate][p.idx] = build(p.def, s ?? null, partId)
  }
  // Objects the entries don't account for (shouldn't happen) get letters after the known ones.
  let extra = slots.length
  for (const plate of result) for (const o of plate) if (o.entry == null) o.label = letterFor(extra++)
  return result

  function build(def: ExcludeObjectDef, s: (typeof slots)[number] | null, partId = s?.partId ?? partOfObjectName(def.name)) {
    const e = s ? entries[s.entry] : undefined
    return {
      name: def.name,
      partId,
      entry: s ? s.entry : null,
      instance: s ? s.instance : 1,
      label: s ? letterFor(s.key - 1) : "?",
      center: def.center ?? centroid(def.polygon),
      polygon: def.polygon,
      ...(e?.overrides && Object.keys(e.overrides).length ? { overrides: e.overrides } : {}),
    }
  }
}

function centroid(poly: Pt[]): Pt {
  if (!poly.length) return [0, 0]
  const b = bbox(poly)
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]
}

function bbox(pts: Pt[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of pts) {
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  return [x0, y0, x1, y1]
}

// ---------------------------------------------------------------------------------------------
// Mesh footprint + rotation fit
// ---------------------------------------------------------------------------------------------

/** XY of every vertex of an STL (binary or ASCII) and its lowest Z. */
export function stlPoints(buf: Buffer): { xy: Pt[]; minZ: number; maxZ: number } {
  const xy: Pt[] = []
  let minZ = Infinity
  let maxZ = -Infinity
  const n = buf.length >= 84 ? buf.readUInt32LE(80) : 0
  if (buf.length >= 84 && 84 + n * 50 === buf.length) {
    for (let t = 0; t < n; t++) {
      const o = 84 + t * 50 + 12
      for (let v = 0; v < 3; v++) {
        const x = buf.readFloatLE(o + v * 12)
        const y = buf.readFloatLE(o + v * 12 + 4)
        const z = buf.readFloatLE(o + v * 12 + 8)
        xy.push([x, y])
        if (z < minZ) minZ = z
        if (z > maxZ) maxZ = z
      }
    }
  } else {
    for (const m of buf.toString("utf8").matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) {
      xy.push([Number(m[1]), Number(m[2])])
      const z = Number(m[3])
      if (z < minZ) minZ = z
      if (z > maxZ) maxZ = z
    }
  }
  return { xy, minZ: Number.isFinite(minZ) ? minZ : 0, maxZ: Number.isFinite(maxZ) ? maxZ : 0 }
}

/** Convex hull (monotone chain), counter-clockwise, no repeated end point. */
export function convexHull(points: Pt[]): Pt[] {
  const pts = [...new Map(points.map((p) => [`${p[0].toFixed(4)},${p[1].toFixed(4)}`, p])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (pts.length < 3) return pts
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Pt[] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Pt[] = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

const rot = (p: Pt, c: number, s: number): Pt => [p[0] * c - p[1] * s, p[0] * s + p[1] * c]

function segDist2(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const L = dx * dx + dy * dy
  let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0
  t = Math.max(0, Math.min(1, t))
  const x = a[0] + t * dx - p[0], y = a[1] + t * dy - p[1]
  return x * x + y * y
}

/** Mean distance of `pts` to the closed polygon `poly`'s boundary. */
function meanDist(pts: Pt[], poly: Pt[]): number {
  let sum = 0
  for (const p of pts) {
    let best = Infinity
    for (let i = 0; i < poly.length; i++) {
      const d = segDist2(p, poly[i], poly[(i + 1) % poly.length])
      if (d < best) best = d
    }
    sum += Math.sqrt(best)
  }
  return pts.length ? sum / pts.length : Infinity
}

/** Resample a closed polygon so long edges count as much as short ones in the shape comparison. */
function densify(poly: Pt[], step: number): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step))
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n])
  }
  return out
}

export interface PlacementFit {
  rotationDeg: number // about Z, counter-clockwise seen from above
  translate: Pt // bed = rotate(part xy) + translate
  errorMm: number // mean hull mismatch after fitting
}

/**
 * The rotation about Z (and translation) that puts a part's footprint hull onto the slicer's polygon. Searches every
 * 0.5° then refines to 0.05°. Footprints with symmetry fit several angles equally well; the one closest to 0° wins
 * (OrcaSlicer only rotates when it helps the arrangement). Null when the footprint doesn't match (wrong mesh).
 */
export function fitPlacement(meshXY: Pt[], polygon: Pt[], center: Pt | null): PlacementFit | null {
  const hull = convexHull(meshXY)
  if (hull.length < 3 || polygon.length < 3) return null
  const target = bbox(polygon)
  const tc: Pt = center ?? [(target[0] + target[2]) / 2, (target[1] + target[3]) / 2]
  const tw = target[2] - target[0], th = target[3] - target[1]
  const size = Math.max(tw, th, 1)
  const tDense = densify(polygon, size / 40)
  const evalAt = (deg: number) => {
    const r = (deg * Math.PI) / 180
    const c = Math.cos(r), s = Math.sin(r)
    const h = hull.map((p) => rot(p, c, s))
    const b = bbox(h)
    // quick reject on bbox size
    const dSize = Math.abs(b[2] - b[0] - tw) + Math.abs(b[3] - b[1] - th)
    if (dSize > size * 0.25) return { deg, err: Infinity, t: [0, 0] as Pt }
    const t: Pt = [tc[0] - (b[0] + b[2]) / 2, tc[1] - (b[1] + b[3]) / 2]
    const placed = h.map((p) => [p[0] + t[0], p[1] + t[1]] as Pt)
    const err = (meanDist(tDense, placed) + meanDist(densify(placed, size / 40), polygon)) / 2
    return { deg, err, t }
  }
  const coarse: { deg: number; err: number; t: Pt }[] = []
  for (let d = 0; d < 360; d += 0.5) coarse.push(evalAt(d))
  const best = Math.min(...coarse.map((x) => x.err))
  if (!Number.isFinite(best)) return null
  const tol = Math.max(0.05, best * 1.5)
  // Equally good angles (symmetric footprints): prefer the one nearest 0°.
  const near = (d: number) => Math.min(d, 360 - d)
  const pick = coarse.filter((x) => x.err <= best + tol).sort((a, b) => near(a.deg) - near(b.deg) || a.err - b.err)[0]
  let fine = pick
  for (let d = pick.deg - 0.5; d <= pick.deg + 0.5; d += 0.05) {
    const e = evalAt(((d % 360) + 360) % 360)
    if (e.err < fine.err - 1e-9) fine = e
  }
  if (fine.err > Math.max(1, size * 0.05)) return null
  const deg = Math.round(fine.deg * 100) / 100
  return { rotationDeg: deg >= 360 ? deg - 360 : deg, translate: [round3(fine.t[0]), round3(fine.t[1])], errorMm: round3(fine.err) }
}

const round3 = (x: number) => Math.round(x * 1000) / 1000

/** Mapped objects + the transform of each part's mesh (null when the mesh is missing or doesn't match). */
export function placeObjects(
  plates: Omit<PlacedObject, "rotationDeg" | "translate">[][],
  meshOf: (partId: string) => { xy: Pt[]; minZ: number } | null,
): PlacedObject[][] {
  const cache = new Map<string, { xy: Pt[]; minZ: number } | null>()
  return plates.map((objs) =>
    objs.map((o) => {
      if (!cache.has(o.partId)) {
        let m: { xy: Pt[]; minZ: number } | null
        try {
          m = meshOf(o.partId)
        } catch {
          m = null
        }
        cache.set(o.partId, m ? { xy: convexHull(m.xy), minZ: m.minZ } : null)
      }
      const mesh = cache.get(o.partId)
      const fit = mesh ? fitPlacement(mesh.xy, o.polygon, o.center) : null
      return { ...o, rotationDeg: fit?.rotationDeg ?? null, translate: fit?.translate ?? null }
    }),
  )
}

export const stlMesh = (abs: string) => stlPoints(readFileSync(abs))
