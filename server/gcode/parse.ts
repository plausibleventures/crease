// Streaming-style parser for OrcaSlicer G-code: layers (";LAYER_CHANGE" / ";Z:" / ";HEIGHT:"), feature types
// (";TYPE:"), line widths (";WIDTH:"), G0/G1 moves and G2/G3 arcs, tool changes (T<n>), and the settings footer.
// Output is compact per-layer segment lists (bed mm) plus per-feature speed and travel/retraction stats.
import { readFileSync, statSync } from "node:fs"
import type { ToolpathFeature, ToolpathLayer } from "../../shared/types"

export interface Travel {
  x1: number
  y1: number
  x2: number
  y2: number
  retracted: boolean
}

export interface ParsedLayer extends ToolpathLayer {
  maxSpeed: Record<string, number> // feature -> highest feed rate (mm/s) of its extrusions
  length: Record<string, number> // feature -> extruded path length (mm)
  travels: Travel[]
}

export interface ParsedGcode {
  layers: ParsedLayer[]
  settings: Record<string, string> // "; key = value" footer (OrcaSlicer config dump) + our header comments
  bbox: [number, number, number, number] // minX, minY, maxX, maxY of all extrusions in layers
}

const cache = new Map<string, { mtimeMs: number; parsed: ParsedGcode }>()

/** Parse (cached by path + mtime). */
export function parseGcodeFile(abs: string): ParsedGcode {
  const { mtimeMs } = statSync(abs)
  const hit = cache.get(abs)
  if (hit && hit.mtimeMs === mtimeMs) return hit.parsed
  const parsed = parseGcode(readFileSync(abs, "utf8"))
  cache.set(abs, { mtimeMs, parsed })
  if (cache.size > 8) cache.delete(cache.keys().next().value!)
  return parsed
}

export function parseGcode(text: string): ParsedGcode {
  const layers: ParsedLayer[] = []
  const settings: Record<string, string> = {}
  let cur: ParsedLayer | null = null
  let feature: ToolpathFeature = "Custom"
  let width = 0.45
  let tool = 0
  let x = 0
  let y = 0
  let f = 0 // mm/min
  let absE = false
  let absXY = true
  let lastE = 0
  let retracted = false
  const bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]
  // Segments for the current layer grouped by feature|tool|width
  let groups = new Map<string, { feature: ToolpathFeature; tool: number; lineWidth: number; coords: number[] }>()

  const flush = () => {
    if (cur) cur.segments = [...groups.values()]
    groups = new Map()
  }
  const addSeg = (x1: number, y1: number, x2: number, y2: number) => {
    if (!cur) return
    const w = Math.round(width * 100) / 100
    const key = `${feature}|${tool}|${w}`
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { feature, tool, lineWidth: w, coords: [] }))
    g.coords.push(r2(x1), r2(y1), r2(x2), r2(y2))
    const len = Math.hypot(x2 - x1, y2 - y1)
    cur.length[feature] = (cur.length[feature] ?? 0) + len
    cur.maxSpeed[feature] = Math.max(cur.maxSpeed[feature] ?? 0, f / 60)
    if (x1 < bbox[0]) bbox[0] = x1
    if (x2 < bbox[0]) bbox[0] = x2
    if (y1 < bbox[1]) bbox[1] = y1
    if (y2 < bbox[1]) bbox[1] = y2
    if (x1 > bbox[2]) bbox[2] = x1
    if (x2 > bbox[2]) bbox[2] = x2
    if (y1 > bbox[3]) bbox[3] = y1
    if (y2 > bbox[3]) bbox[3] = y2
  }

  let start = 0
  const n = text.length
  while (start < n) {
    let end = text.indexOf("\n", start)
    if (end < 0) end = n
    const line = text.slice(start, end).trim()
    start = end + 1
    if (!line) continue
    const c0 = line.charCodeAt(0)
    if (c0 === 59 /* ; */) {
      if (line.startsWith(";TYPE:")) feature = line.slice(6).trim() as ToolpathFeature
      else if (line.startsWith(";WIDTH:")) width = Number(line.slice(7)) || width
      else if (line === ";LAYER_CHANGE") {
        flush()
        cur = { index: layers.length, z: 0, height: 0, segments: [], maxSpeed: {}, length: {}, travels: [] }
        layers.push(cur)
      } else if (line.startsWith(";Z:")) {
        if (cur) cur.z = Number(line.slice(3))
      } else if (line.startsWith(";HEIGHT:")) {
        if (cur) cur.height = Number(line.slice(8))
      } else {
        const m = line.match(/^; ([A-Za-z0-9_]+) = (.*)$/)
        if (m) settings[m[1]] = m[2]
      }
      continue
    }
    const code = line.split(";")[0].trim()
    if (!code) continue
    const word = code.split(/\s+/)[0].toUpperCase()
    if (word === "M82") absE = true
    else if (word === "M83") absE = false
    else if (word === "G90") absXY = true
    else if (word === "G91") absXY = false
    else if (word === "G92") {
      const e = num(code, "E")
      if (e != null) lastE = e
    } else if (/^T\d+$/.test(word)) tool = Number(word.slice(1))
    else if (word === "G0" || word === "G1" || word === "G2" || word === "G3") {
      const nx = num(code, "X")
      const ny = num(code, "Y")
      const e = num(code, "E")
      const nf = num(code, "F")
      if (nf != null) f = nf
      const tx = nx == null ? x : absXY ? nx : x + nx
      const ty = ny == null ? y : absXY ? ny : y + ny
      let de = 0
      if (e != null) {
        de = absE ? e - lastE : e
        if (absE) lastE = e
      }
      const moved = tx !== x || ty !== y
      if (de < 0 && !moved) retracted = true
      if (de > 0 && !moved) retracted = false
      if (moved) {
        if (de > 0) {
          if (word === "G1" || word === "G0") addSeg(x, y, tx, ty)
          else {
            // Arc: approximate with chords (I/J centre offsets relative to the start).
            const i = num(code, "I") ?? 0
            const j = num(code, "J") ?? 0
            const cx = x + i
            const cy = y + j
            const r = Math.hypot(i, j)
            const a1 = Math.atan2(y - cy, x - cx)
            let a2 = Math.atan2(ty - cy, tx - cx)
            const cw = word === "G2"
            if (cw && a2 >= a1) a2 -= 2 * Math.PI
            if (!cw && a2 <= a1) a2 += 2 * Math.PI
            const steps = Math.max(2, Math.ceil((Math.abs(a2 - a1) * r) / 0.8))
            let px = x
            let py = y
            for (let k = 1; k <= steps; k++) {
              const a = a1 + ((a2 - a1) * k) / steps
              const qx = k === steps ? tx : cx + r * Math.cos(a)
              const qy = k === steps ? ty : cy + r * Math.sin(a)
              addSeg(px, py, qx, qy)
              px = qx
              py = qy
            }
          }
          retracted = false
        } else if (cur && de === 0) {
          cur.travels.push({ x1: x, y1: y, x2: tx, y2: ty, retracted })
        }
        x = tx
        y = ty
      }
    }
  }
  flush()
  return { layers, settings, bbox: Number.isFinite(bbox[0]) ? bbox : [0, 0, 0, 0] }
}

const r2 = (v: number) => Math.round(v * 100) / 100

function num(code: string, letter: string): number | null {
  const m = code.match(new RegExp(`(?:^|\\s)${letter}(-?\\d*\\.?\\d+)`, "i"))
  return m ? Number(m[1]) : null
}
