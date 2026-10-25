// Toolpath layer → PNG (SVG rasterised with sharp, already in node_modules via manifold-3d). Spool-terminal look:
// black background, features coloured, the previous layer ghosted, a legend strip.
import type { ParsedGcode, ParsedLayer } from "./parse"

export const FEATURE_COLORS: Record<string, string> = {
  "Outer wall": "#ff8c42",
  "Inner wall": "#ffd23f",
  "Overhang wall": "#ff5c7a",
  "Sparse infill": "#6f8dff",
  "Internal solid infill": "#a06cd5",
  "Top surface": "#e8e8e2",
  "Bottom surface": "#7fd1ff",
  Bridge: "#3fe0b0",
  "Internal Bridge": "#3fe0b0",
  "Gap infill": "#ff2fd0",
  Ironing: "#9ad0ff",
  Skirt: "#66665f",
  Brim: "#66665f",
  Support: "#8d99ae",
  "Support interface": "#b0bccf",
  "Prime tower": "#55555c",
  Custom: "#3a3a3a",
}
const colorOf = (f: string) => FEATURE_COLORS[f] ?? "#b0b0aa"

export type LayerSelector = number | "top" | "first"

export interface RenderOptions {
  zoom?: [number, number, number, number] // x, y, w, h in bed mm
  size?: number // longest side in px (default 900)
  hide?: string[] // features not to draw (e.g. ["Ironing"] to see the top lines under it)
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)

/** Which layers to draw (in order) and a caption. */
function pick(parsed: ParsedGcode, sel: LayerSelector): { layers: ParsedLayer[]; ghost: ParsedLayer | null; caption: string; visibleOnly: boolean } {
  const L = parsed.layers
  if (!L.length) throw Object.assign(new Error("no layers in this G-code"), { statusCode: 422 })
  if (sel === "first") return { layers: [L[0]], ghost: null, caption: `first layer · z ${L[0].z} mm`, visibleOnly: false }
  if (sel === "top") {
    const tops = L.filter((l) => l.segments.some((s) => s.feature === "Top surface"))
    const last = tops.length ? tops : [L[L.length - 1]]
    return {
      layers: last,
      ghost: null,
      caption: `top surfaces · ${last.length} layer${last.length > 1 ? "s" : ""} (${last.map((l) => l.index + 1).join(", ")})`,
      visibleOnly: true,
    }
  }
  const i = Math.max(0, Math.min(L.length - 1, sel))
  return { layers: [L[i]], ghost: i > 0 ? L[i - 1] : null, caption: `layer ${i + 1} of ${L.length} · z ${L[i].z} mm`, visibleOnly: false }
}

// Features that show on the outside of a top composite.
const VISIBLE = new Set(["Outer wall", "Inner wall", "Top surface", "Gap infill", "Ironing", "Overhang wall"])

export function layerSvg(parsed: ParsedGcode, sel: LayerSelector, opts: RenderOptions = {}): string {
  const { layers, ghost, caption, visibleOnly } = pick(parsed, sel)
  const [bx0, by0, bx1, by1] = parsed.bbox
  const pad = 3
  const [vx, vy, vw, vh] = opts.zoom ?? [bx0 - pad, by0 - pad, bx1 - bx0 + 2 * pad, by1 - by0 + 2 * pad]
  const size = opts.size ?? 900
  const scale = size / Math.max(vw, vh)
  const W = Math.round(vw * scale)
  const H = Math.round(vh * scale)
  const legendH = 52
  // bed coords -> px (y up on the bed, down in the image)
  const X = (x: number) => ((x - vx) * scale).toFixed(1)
  const Y = (y: number) => ((vy + vh - y) * scale).toFixed(1)
  const path = (c: number[]) => {
    let d = ""
    for (let i = 0; i < c.length; i += 4) d += `M${X(c[i])} ${Y(c[i + 1])}L${X(c[i + 2])} ${Y(c[i + 3])}`
    return d
  }
  const parts: string[] = []
  if (ghost) {
    for (const s of ghost.segments) parts.push(`<path d="${path(s.coords)}" stroke="#1a1e27" stroke-width="${(s.lineWidth * scale).toFixed(2)}" stroke-linecap="round" fill="none"/>`)
  }
  const used = new Set<string>()
  // Draw infill first, walls and highlights (gap fill) last so they stay visible.
  const order = (f: string) => (f === "Gap infill" ? 3 : f.includes("wall") ? 2 : f === "Ironing" ? 1.5 : 1)
  const hidden = new Set(opts.hide ?? [])
  const segs = layers.flatMap((l) => l.segments).filter((s) => (!visibleOnly || VISIBLE.has(s.feature)) && !hidden.has(s.feature))
  segs.sort((a, b) => order(a.feature) - order(b.feature))
  for (const s of segs) {
    used.add(s.feature)
    const w = Math.max(0.6, s.lineWidth * scale * (s.feature === "Ironing" ? 0.35 : 0.85))
    parts.push(`<path d="${path(s.coords)}" stroke="${colorOf(s.feature)}" stroke-width="${w.toFixed(2)}" stroke-linecap="round" fill="none" opacity="${s.feature === "Ironing" ? 0.7 : 1}"/>`)
  }
  const legend = [...used].map((f, i) => {
    const x = 12 + (i % 5) * Math.min(180, (W - 24) / 5)
    const y = H + 38 + Math.floor(i / 5) * 18
    return `<rect x="${x}" y="${y - 9}" width="10" height="10" fill="${colorOf(f)}"/><text x="${x + 15}" y="${y}" fill="#a3a3a0" font-family="Menlo, monospace" font-size="12">${esc(f.toLowerCase())}</text>`
  })
  const totalH = H + legendH + (used.size > 5 ? 18 : 0)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${totalH}" viewBox="0 0 ${W} ${totalH}">
<rect width="${W}" height="${totalH}" fill="#000"/>
${parts.join("\n")}
<rect x="0" y="${H}" width="${W}" height="${totalH - H}" fill="#0a0a0a"/>
<text x="12" y="${H + 18}" fill="#f4f4f2" font-family="Menlo, monospace" font-size="12">${esc(caption)}</text>
${legend.join("\n")}
</svg>`
}

export async function layerPng(parsed: ParsedGcode, sel: LayerSelector, opts: RenderOptions = {}): Promise<Buffer> {
  const { default: sharp } = await import("sharp")
  return sharp(Buffer.from(layerSvg(parsed, sel, opts))).png().toBuffer()
}
