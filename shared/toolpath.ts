// The whole sliced plate's toolpath as one compact binary blob, for the Layers tab's 3D view.
// The server encodes it from the parsed G-code (server/gcode/parse.ts, cached per file); the renderer decodes it
// with zero copies into GPU instance buffers. One record per extrusion segment, grouped by feature + tool and sorted
// by layer inside each group, so "everything up to layer n" is a prefix of each group (found by binary search).
//
// Layout (little-endian):
//   u32 magic "TPV1" · u32 header byte length · header JSON (UTF-8, padded to 4 bytes) · Float32 records
// Extrusion record (STRIDE floats): x1, y1, x2, y2, z (top of the layer), height, width, layer
// Travel record (STRIDE floats):    x1, y1, x2, y2, z, 0, 0, layer
import type { ToolpathFeature } from "./types"

export const TOOLPATH_MAGIC = 0x31565054 // "TPV1" read as a little-endian u32
export const STRIDE = 8

export interface ToolpathGroupInfo {
  feature: ToolpathFeature
  tool: number
  count: number // records
  offset: number // float index of the first record in the data block
}

export interface ToolpathHeader {
  version: 1
  bed: [number, number] // printable width × depth (mm); bed coordinates run 0..bed
  layers: { z: number; height: number; bbox: [number, number, number, number] | null }[] // bbox = minX, minY, maxX, maxY
  groups: ToolpathGroupInfo[]
  travel: { count: number; offset: number }
  toolColours: string[] // filament colour per tool (T0…), from the slicer's settings; may be empty
  segments: number // extrusion records in this blob
  sourceSegments: number // extrusion segments in the G-code (more than `segments` when simplified)
  simplified: boolean // segments were merged or inner lines thinned to stay under the cap
}

export interface DecodedToolpath {
  header: ToolpathHeader
  data: Float32Array // all records; groups and travel index into it
}

/* ---------- encode (server) ---------- */

/** What the encoder needs from a parsed G-code (a subset of server/gcode/parse.ts ParsedGcode). */
export interface ToolpathSource {
  layers: {
    z: number
    height: number
    segments: { feature: ToolpathFeature; tool: number; lineWidth: number; coords: number[] }[]
    travels?: { x1: number; y1: number; x2: number; y2: number }[]
  }[]
  settings: Record<string, string>
}

export interface EncodeOptions {
  maxSegments?: number // cap on extrusion records (default 1.2 M ≈ 38 MB of records)
  maxTravels?: number // cap on travel records (default 400 k; dropped evenly beyond it)
}

/** Features that sit inside the part: thinned first when a plate is over the cap. */
const INNER: ReadonlySet<string> = new Set(["Sparse infill", "Internal solid infill", "Gap infill"])

export function encodeToolpath(src: ToolpathSource, opts: EncodeOptions = {}): Uint8Array {
  const maxSegments = opts.maxSegments ?? 1_200_000
  const maxTravels = opts.maxTravels ?? 400_000
  let sourceSegments = 0
  for (const l of src.layers) for (const s of l.segments) sourceSegments += s.coords.length / 4

  // 1) over the cap: merge runs of nearly straight joined segments (curves sliced into many tiny chords),
  //    with a growing tolerance; 2) still over: keep inner features (infill) on every k-th layer only.
  let simplified = false
  let coordsOf = (seg: { coords: number[] }) => seg.coords
  let total = sourceSegments
  for (const tol of [0.02, 0.06, 0.15]) {
    if (total <= maxSegments) break
    simplified = true
    const cache = new Map<number[], number[]>()
    coordsOf = (seg) => {
      let c = cache.get(seg.coords)
      if (!c) cache.set(seg.coords, (c = mergeRuns(seg.coords, tol)))
      return c
    }
    total = 0
    for (const l of src.layers) for (const s of l.segments) total += coordsOf(s).length / 4
  }
  let innerEvery = 1
  if (total > maxSegments) {
    let inner = 0
    for (const l of src.layers) for (const s of l.segments) if (INNER.has(s.feature)) inner += coordsOf(s).length / 4
    const outer = total - inner
    innerEvery = outer >= maxSegments ? Infinity : Math.max(2, Math.ceil(inner / Math.max(1, maxSegments - outer)))
  }
  const keep = (feature: string, layer: number) =>
    !INNER.has(feature) || innerEvery === 1 || (Number.isFinite(innerEvery) && layer % innerEvery === 0)

  // group by feature|tool, in layer order
  const groups = new Map<string, { feature: ToolpathFeature; tool: number; recs: number[][] }>()
  const layers: ToolpathHeader["layers"] = []
  let segments = 0
  src.layers.forEach((l, li) => {
    let bbox: [number, number, number, number] | null = null
    for (const s of l.segments) {
      const c = coordsOf(s)
      if (!c.length) continue
      for (let i = 0; i < c.length; i += 2) {
        if (!bbox) bbox = [c[i], c[i + 1], c[i], c[i + 1]]
        else {
          if (c[i] < bbox[0]) bbox[0] = c[i]
          if (c[i + 1] < bbox[1]) bbox[1] = c[i + 1]
          if (c[i] > bbox[2]) bbox[2] = c[i]
          if (c[i + 1] > bbox[3]) bbox[3] = c[i + 1]
        }
      }
      if (!keep(s.feature, li)) {
        simplified = true
        continue
      }
      const key = `${s.feature}|${s.tool}`
      let g = groups.get(key)
      if (!g) groups.set(key, (g = { feature: s.feature, tool: s.tool, recs: [] }))
      g.recs.push(c, [l.z, l.height, s.lineWidth, li])
      segments += c.length / 4
    }
    layers.push({ z: l.z, height: l.height, bbox })
  })

  let travelCount = 0
  for (const l of src.layers) travelCount += l.travels?.length ?? 0
  const travelKept = Math.min(travelCount, maxTravels)

  const groupInfo: ToolpathGroupInfo[] = []
  let offset = 0
  for (const g of groups.values()) {
    let count = 0
    for (let i = 0; i < g.recs.length; i += 2) count += g.recs[i].length / 4
    groupInfo.push({ feature: g.feature, tool: g.tool, count, offset })
    offset += count * STRIDE
  }
  const travelOffset = offset
  const header: ToolpathHeader = {
    version: 1,
    bed: bedOf(src.settings),
    layers,
    groups: groupInfo,
    travel: { count: travelKept, offset: travelOffset },
    toolColours: (src.settings.filament_colour ?? src.settings.extruder_colour ?? "")
      .split(";")
      .map((c) => c.trim())
      .filter((c) => /^#[0-9a-f]{6}$/i.test(c)),
    segments,
    sourceSegments,
    simplified,
  }
  const json = new TextEncoder().encode(JSON.stringify(header))
  const headerBytes = Math.ceil(json.length / 4) * 4
  const floats = travelOffset + travelKept * STRIDE
  const buf = new ArrayBuffer(8 + headerBytes + floats * 4)
  const dv = new DataView(buf)
  dv.setUint32(0, TOOLPATH_MAGIC, true)
  dv.setUint32(4, headerBytes, true)
  const bytes = new Uint8Array(buf)
  bytes.set(json, 8)
  bytes.fill(0x20, 8 + json.length, 8 + headerBytes) // pad with spaces (still valid JSON)
  const out = new Float32Array(buf, 8 + headerBytes, floats)
  let o = 0
  for (const g of groups.values())
    for (let i = 0; i < g.recs.length; i += 2) {
      const c = g.recs[i]
      const [z, h, w, li] = g.recs[i + 1]
      for (let k = 0; k + 3 < c.length; k += 4) {
        out[o++] = c[k]
        out[o++] = c[k + 1]
        out[o++] = c[k + 2]
        out[o++] = c[k + 3]
        out[o++] = z
        out[o++] = h
        out[o++] = w
        out[o++] = li
      }
    }
  // evenly thinned to exactly travelKept records (t is kept when floor(t·K/N) steps up)
  let t = 0
  src.layers.forEach((l, li) => {
    for (const tr of l.travels ?? []) {
      const keepIt = Math.floor(((t + 1) * travelKept) / travelCount) > Math.floor((t * travelKept) / travelCount)
      t++
      if (!keepIt) continue
      out.set([tr.x1, tr.y1, tr.x2, tr.y2, l.z, 0, 0, li], o)
      o += STRIDE
    }
  })
  return bytes
}

/** Bed size from OrcaSlicer's "printable_area = 0x0,260x0,260x260,0x260" (falls back to 260 × 260). */
export function bedOf(settings: Record<string, string>): [number, number] {
  const pts = (settings.printable_area ?? "")
    .split(",")
    .map((p) => p.split("x").map(Number))
    .filter((p) => p.length === 2 && p.every(Number.isFinite))
  if (pts.length < 3) return [260, 260]
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return [Math.max(...xs) - Math.min(0, ...xs), Math.max(...ys) - Math.min(0, ...ys)]
}

/**
 * Merge runs of joined segments ([x1,y1,x2,y2, …], where one segment starts where the last ended) into longer
 * chords while every point of the run stays within `tol` mm of the chord. Unjoined segments are kept as they are.
 */
export function mergeRuns(c: number[], tol: number): number[] {
  const out: number[] = []
  let i = 0
  const n = c.length
  while (i + 3 < n) {
    const ax = c[i]
    const ay = c[i + 1]
    // the run: points a, p1, p2, … while each next segment starts at the previous end
    const pts: number[] = [c[i + 2], c[i + 3]]
    let j = i + 4
    while (j + 3 < n && c[j] === c[j - 2] && c[j + 1] === c[j - 1] && pts.length < 128) {
      pts.push(c[j + 2], c[j + 3])
      j += 4
    }
    // greedy: extend the chord from `start` as far as all points in between stay within tol
    let sx = ax
    let sy = ay
    let from = 0 // index (in pts, by point) of the first point after start
    let k = 0
    while (k < pts.length / 2) {
      let end = k
      for (let e = k + 1; e < pts.length / 2; e++) {
        if (!within(sx, sy, pts[e * 2], pts[e * 2 + 1], pts, from, e, tol)) break
        end = e
      }
      out.push(sx, sy, pts[end * 2], pts[end * 2 + 1])
      sx = pts[end * 2]
      sy = pts[end * 2 + 1]
      from = end + 1
      k = end + 1
    }
    i = j
  }
  return out
}

function within(ax: number, ay: number, bx: number, by: number, pts: number[], from: number, to: number, tol: number) {
  const dx = bx - ax
  const dy = by - ay
  const len = Math.hypot(dx, dy)
  for (let p = from; p < to; p++) {
    const px = pts[p * 2] - ax
    const py = pts[p * 2 + 1] - ay
    const d = len < 1e-9 ? Math.hypot(px, py) : Math.abs(px * dy - py * dx) / len
    if (d > tol) return false
  }
  return true
}

/* ---------- decode (renderer) ---------- */

export function decodeToolpath(buf: ArrayBuffer): DecodedToolpath {
  if (buf.byteLength < 8) throw new Error("toolpath: empty response")
  const dv = new DataView(buf)
  if (dv.getUint32(0, true) !== TOOLPATH_MAGIC) throw new Error("toolpath: not a toolpath file")
  const headerBytes = dv.getUint32(4, true)
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, headerBytes))) as ToolpathHeader
  const data = new Float32Array(buf, 8 + headerBytes, (buf.byteLength - 8 - headerBytes) / 4)
  return { header, data }
}

/**
 * Records of a group (or the travel block) on layers ≤ `layer`: the group is sorted by layer, so this is a prefix;
 * binary search over the layer column. `offset`/`count` as in ToolpathGroupInfo.
 */
export function countUpTo(data: Float32Array, offset: number, count: number, layer: number): number {
  let lo = 0
  let hi = count
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (data[offset + mid * STRIDE + 7] <= layer) lo = mid + 1
    else hi = mid
  }
  return lo
}
