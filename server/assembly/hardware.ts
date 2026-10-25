// Metric hardware dimensions (nominal, from the ISO/DIN standards) and SVG drawings for the guide.
// Drawings are in millimetres so they can be printed at true 1:1 scale.
import type { AssemblyHardware, AssemblyTool } from "../../shared/types"
import { lengthOf, threadOf } from "./schema"

type Table = Record<string, number[]>
const pick = (t: Table, d: number) => t[String(d)] ?? null

// [head dia dk, head height k]
const HEAD: Record<string, Table> = {
  socket: { "2": [3.8, 2], "2.5": [4.5, 2.5], "3": [5.5, 3], "4": [7, 4], "5": [8.5, 5], "6": [10, 6], "8": [13, 8], "10": [16, 10] }, // ISO 4762 / DIN 912
  button: { "2": [3.5, 1.3], "2.5": [4.7, 1.5], "3": [5.7, 1.65], "4": [7.6, 2.2], "5": [9.5, 2.75], "6": [10.5, 3.3], "8": [14, 4.4], "10": [17.5, 5.5] }, // ISO 7380
  countersunk: { "2": [4, 1.2], "2.5": [5, 1.5], "3": [6.72, 1.86], "4": [8.96, 2.48], "5": [11.2, 3.1], "6": [13.44, 3.72], "8": [17.92, 4.96], "10": [22.4, 6.2] }, // ISO 10642 / DIN 7991
  pan: { "2": [4, 1.6], "2.5": [5, 1.75], "3": [5.6, 2.1], "4": [8, 2.8], "5": [9.5, 3.5], "6": [12, 4.2], "8": [16, 5.6] }, // ISO 7045 / 14583
  hex: { "3": [6.4, 2], "4": [8.1, 2.8], "5": [9.2, 3.5], "6": [11.5, 4], "8": [15, 5.3], "10": [18.5, 6.4] }, // ISO 4017 (across corners)
  cheese: { "2": [3.8, 1.3], "2.5": [4.5, 1.6], "3": [5.5, 2], "4": [7, 2.6], "5": [8.5, 3.3], "6": [10, 3.9] }, // ISO 1207
}
HEAD.flange = HEAD.button
// Hex key for each head type (mm).
const HEX_KEY: Record<string, Table> = {
  socket: { "2": [1.5], "2.5": [2], "3": [2.5], "4": [3], "5": [4], "6": [5], "8": [6], "10": [8] },
  button: { "2": [1.3], "2.5": [1.5], "3": [2], "4": [2.5], "5": [3], "6": [4], "8": [5], "10": [6] },
  countersunk: { "2": [1.3], "2.5": [1.5], "3": [2], "4": [2.5], "5": [3], "6": [4], "8": [5], "10": [6] },
  grub: { "2": [0.9], "2.5": [1.3], "3": [1.5], "4": [2], "5": [2.5], "6": [3], "8": [4], "10": [5] },
}
// Nut ISO 4032: [across flats s, height m]
const NUT: Table = { "2": [4, 1.6], "2.5": [5, 2], "3": [5.5, 2.4], "4": [7, 3.2], "5": [8, 4.7], "6": [10, 5.2], "8": [13, 6.8], "10": [16, 8.4] }
// Washer ISO 7089: [inner, outer, thickness]
const WASHER: Table = { "2": [2.2, 5, 0.3], "2.5": [2.7, 6, 0.5], "3": [3.2, 7, 0.5], "4": [4.3, 9, 0.8], "5": [5.3, 10, 1], "6": [6.4, 12, 1.6], "8": [8.4, 16, 1.6], "10": [10.5, 20, 2] }
// Heat-set insert, typical "standard" size (CNC Kitchen / Ruthex style): [outer dia, length, hole dia]
const INSERT: Table = { "2": [3.6, 4, 3.2], "2.5": [4.6, 5.7, 4.0], "3": [5, 5.7, 4.0], "4": [6.3, 8.1, 5.6], "5": [7.1, 9.5, 6.4], "6": [8.7, 12.7, 8.0] }
const PITCH: Table = { "2": [0.4], "2.5": [0.45], "3": [0.5], "4": [0.7], "5": [0.8], "6": [1], "8": [1.25], "10": [1.5] }

export function headDims(head: string, d: number): [number, number] {
  const t = pick(HEAD[head] ?? HEAD.socket, d)
  return t ? [t[0], t[1]] : head === "countersunk" ? [2 * d, 0.6 * d] : [1.8 * d, head === "button" ? 0.55 * d : d]
}
export function hexKeyFor(head: string, d: number): number | null {
  return pick(HEX_KEY[head] ?? {}, d)?.[0] ?? null
}
export const nutDims = (d: number): [number, number] => (pick(NUT, d) as [number, number]) ?? [1.8 * d, 0.8 * d]
export const washerDims = (d: number): [number, number, number] => (pick(WASHER, d) as [number, number, number]) ?? [d * 1.07, d * 2.2, d * 0.16]
export const insertDims = (d: number): [number, number, number] => (pick(INSERT, d) as [number, number, number]) ?? [d * 1.65, d * 1.9, d * 1.33]

// ---------- display names ----------

const HEAD_NAME: Record<string, string> = {
  socket: "socket head", button: "button head", countersunk: "countersunk", pan: "pan head", hex: "hex head",
  flange: "flange head", cheese: "cheese head", grub: "grub",
}

export function hardwareName(h: AssemblyHardware): string {
  if (h.name) return h.name
  const d = threadOf(h)
  const l = lengthOf(h)
  const size = d ? `M${d}${l ? ` × ${l}` : ""}` : (h.size ?? "")
  switch (h.type) {
    case "screw":
    case "bolt":
      return `${size} ${h.head ? HEAD_NAME[h.head] + " " : ""}${h.type}`.trim()
    case "nut": return `${size} hex nut`
    case "washer": return `${size} washer`
    case "heat-set-insert": return `${size} heat-set insert`
    case "threaded-insert": return `${size} threaded insert`
    case "spring": return h.spring ? `${cap(h.spring.kind)} spring ${h.spring.outerDiaMm} × ${h.spring.freeLengthMm} mm` : "Spring"
    case "bearing": return h.bearing ? `${h.bearing.designation} bearing` : `${h.size ?? ""} bearing`.trim()
    case "magnet": return h.magnet ? `Magnet ${magnetSize(h)}` : `Magnet ${h.size ?? ""}`.trim()
    case "rod": return `Rod ${h.size ?? ""}`.trim()
    case "dowel-pin": return `Dowel pin ${h.size ?? ""}`.trim()
    case "filament-offcut": {
      const [d, l] = offcutDims(h)
      return `${d} mm filament, ${l} mm piece`
    }
    case "standoff": return `${size} standoff`
    case "o-ring": return `O-ring ${h.size ?? ""}`.trim()
    default: return cap(`${h.type.replace(/-/g, " ")} ${h.size ?? ""}`.trim())
  }
}

function magnetSize(h: AssemblyHardware) {
  const m = h.magnet!
  return m.shape === "block" ? `${m.lengthMm ?? "?"} × ${m.widthMm ?? "?"} × ${m.thicknessMm} mm` : `${m.diaMm ?? "?"} × ${m.thicknessMm} mm`
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Short spec line under the name: standard, material, spring/bearing data. */
/** Diameter and length of a filament offcut: size "1.75x40", or threadMm / lengthMm. */
export function offcutDims(h: Pick<AssemblyHardware, "size" | "threadMm" | "lengthMm">): [number, number] {
  const m = h.size?.match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/)
  return [h.threadMm ?? (m ? Number(m[1]) : 1.75), h.lengthMm ?? (m ? Number(m[2]) : 20)]
}

/** True for items the builder makes from what they have (no store links). */
export const isMakeYourself = (h: Pick<AssemblyHardware, "type">) => h.type === "filament-offcut"

/** The instruction shown instead of store links for make-it-yourself items. */
export function makeInstruction(h: AssemblyHardware): string {
  const [d, l] = offcutDims(h)
  return `Cut ${l} mm from your ${d} mm filament${h.qty > 1 ? ` (${h.qty} pieces)` : ""}. Snip the ends square.`
}

export function hardwareSpec(h: AssemblyHardware): string[] {
  const out: string[] = []
  if (h.standard) out.push(h.standard)
  if (h.material) out.push(h.material)
  if (h.spring) {
    const s = h.spring
    out.push(`wire ${s.wireDiaMm} mm · OD ${s.outerDiaMm} mm · free length ${s.freeLengthMm} mm${s.rateNPerMm ? ` · ${s.rateNPerMm} N/mm` : ""}`)
  }
  if (h.bearing) out.push(`${h.bearing.boreMm} × ${h.bearing.outerDiaMm} × ${h.bearing.widthMm} mm${h.bearing.seal ? " " + h.bearing.seal : ""}`)
  if (h.magnet?.grade) out.push(h.magnet.grade)
  if (h.type === "heat-set-insert") {
    const d = threadOf(h)
    if (d) {
      const [od, l] = insertDims(d)
      out.push(`≈ ${od} mm OD × ${lengthOf(h) ?? l} mm`)
    }
  }
  return out
}

// ---------- SVG drawings (mm units) ----------

const STEEL = "#c9ced6"
const BRASS = "#d9b45a"
const INK = "#1d1d1f"
const SW = 0.18 // outline stroke (mm)

export interface Drawing {
  svg: string // inner SVG markup (mm coordinates)
  w: number
  h: number
  minX: number
  minY: number
  trueScale: boolean // can be printed at 1:1
}

/** Widen the view box so the dimension label (centred at cx) is not clipped. */
function fit(dw: Drawing, cx: number, label: string): Drawing {
  const half = label.length * 0.75 + 0.5
  const minX = Math.min(dw.minX, cx - half)
  const maxX = Math.max(dw.minX + dw.w, cx + half)
  return { ...dw, minX, w: maxX - minX }
}

const f = (n: number) => +n.toFixed(3)

function dim(x1: number, x2: number, y: number, label: string): string {
  const t = 0.8
  return `<g stroke="${INK}" stroke-width="0.12" fill="none">
<line x1="${f(x1)}" y1="${f(y)}" x2="${f(x2)}" y2="${f(y)}"/>
<line x1="${f(x1)}" y1="${f(y - t)}" x2="${f(x1)}" y2="${f(y + t)}"/>
<line x1="${f(x2)}" y1="${f(y - t)}" x2="${f(x2)}" y2="${f(y + t)}"/></g>
<text x="${f((x1 + x2) / 2)}" y="${f(y + 3.2)}" font-size="2.6" text-anchor="middle" fill="${INK}" font-family="Helvetica, Arial, sans-serif">${label}</text>`
}

function threads(x0: number, x1: number, r: number, pitch: number): string {
  let s = ""
  for (let x = x0 + pitch / 2; x < x1 - pitch * 0.4; x += pitch) {
    s += `<line x1="${f(x)}" y1="${f(-r)}" x2="${f(x + pitch / 2)}" y2="${f(r)}"/>`
  }
  return `<g stroke="${INK}" stroke-width="0.07" opacity="0.55">${s}</g>`
}

function screwDrawing(h: AssemblyHardware): Drawing {
  const d = threadOf(h) ?? 3
  const L = lengthOf(h) ?? d * 3
  const head = h.head ?? (h.type === "bolt" ? "hex" : "socket")
  const r = d / 2
  const pitch = pick(PITCH, d)?.[0] ?? d * 0.15
  const fill = h.color ?? (/black|12\.9|oxide/i.test(h.material ?? "") ? "#4a4d52" : STEEL)
  let headSvg = ""
  let k: number
  let shankStart = 0 // grub screws: threaded throughout, no head
  let D = d
  if (head !== "grub") {
    ;[D, k] = headDims(head, d)
    const R = D / 2
    if (head === "countersunk") {
      headSvg = `<path d="M0 ${f(-R)} L${f(k)} ${f(-r)} L${f(k)} ${f(r)} L0 ${f(R)} Z"/>`
      shankStart = k
    } else if (head === "button") {
      headSvg = `<path d="M${f(k)} ${f(-R)} L${f(k * 0.35)} ${f(-R)} Q0 ${f(-R)} 0 0 Q0 ${f(R)} ${f(k * 0.35)} ${f(R)} L${f(k)} ${f(R)} Z"/>`
      shankStart = k
    } else if (head === "pan" || head === "cheese") {
      headSvg = `<rect x="0" y="${f(-R)}" width="${f(k)}" height="${f(D)}" rx="${f(k * 0.35)}"/>`
      shankStart = k
    } else if (head === "hex") {
      headSvg = `<rect x="0" y="${f(-R)}" width="${f(k)}" height="${f(D)}"/><line x1="0" y1="${f(-R / 2)}" x2="${f(k)}" y2="${f(-R / 2)}"/><line x1="0" y1="${f(R / 2)}" x2="${f(k)}" y2="${f(R / 2)}"/>`
      shankStart = k
    } else if (head === "flange") {
      headSvg = `<rect x="0" y="${f(-R * 0.75)}" width="${f(k)}" height="${f(D * 0.75)}"/><rect x="${f(k * 0.75)}" y="${f(-R)}" width="${f(k * 0.25)}" height="${f(D)}"/>`
      shankStart = k
    } else {
      headSvg = `<rect x="0" y="${f(-R)}" width="${f(k)}" height="${f(D)}" rx="${f(Math.min(0.4, k * 0.1))}"/>`
      shankStart = k
    }
  }
  // Length is measured under the head, except countersunk (overall length).
  const end = head === "countersunk" ? L : shankStart + L
  const tip = Math.min(pitch, r * 0.5)
  const shank = `<path d="M${f(shankStart)} ${f(-r)} L${f(end - tip)} ${f(-r)} L${f(end)} ${f(-r + tip)} L${f(end)} ${f(r - tip)} L${f(end - tip)} ${f(r)} L${f(shankStart)} ${f(r)} Z"/>`
  const R = Math.max(D, d) / 2
  const dimX0 = head === "countersunk" ? 0 : shankStart
  const svg = `<g fill="${fill}" stroke="${INK}" stroke-width="${SW}" stroke-linejoin="round">${shank}${headSvg}</g>${threads(shankStart, end, r, pitch)}${dim(dimX0, end, R + 1.6, `${L} mm`)}`
  return fit({ svg, minX: -0.5, minY: -R - 0.5, w: end + 1, h: 2 * R + 5.6, trueScale: true }, (dimX0 + end) / 2, `${L} mm`)
}

function hexPath(s: number) {
  const R = s / Math.sqrt(3)
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i
    return `${f(R * Math.cos(a))},${f(R * Math.sin(a))}`
  }).join(" ")
}

function nutDrawing(h: AssemblyHardware): Drawing {
  const d = threadOf(h) ?? 3
  const [s, m] = nutDims(d)
  const R = s / Math.sqrt(3)
  const side = `<rect x="${f(R + 2)}" y="${f(-R)}" width="${f(m)}" height="${f(2 * R)}"/>`
  const svg = `<g fill="${h.color ?? STEEL}" stroke="${INK}" stroke-width="${SW}"><polygon points="${hexPath(s)}"/>${side}</g>
<circle r="${f(d / 2)}" fill="#fff" stroke="${INK}" stroke-width="${SW}"/>${dim(-s / 2, s / 2, R + 1.6, `${s} mm`)}`
  return fit({ svg, minX: -R - 0.5, minY: -R - 0.5, w: 2 * R + m + 3, h: 2 * R + 5.6, trueScale: true }, 0, `${s} mm`)
}

function washerDrawing(h: AssemblyHardware): Drawing {
  const d = threadOf(h) ?? 3
  const [di, dO] = washerDims(d)
  const R = dO / 2
  const svg = `<circle r="${f(R)}" fill="${h.color ?? STEEL}" stroke="${INK}" stroke-width="${SW}"/><circle r="${f(di / 2)}" fill="#fff" stroke="${INK}" stroke-width="${SW}"/>${dim(-R, R, R + 1.6, `${dO} mm`)}`
  return fit({ svg, minX: -R - 0.5, minY: -R - 0.5, w: 2 * R + 1, h: 2 * R + 5.6, trueScale: true }, 0, `${dO} mm`)
}

function insertDrawing(h: AssemblyHardware): Drawing {
  const d = threadOf(h) ?? 3
  const [od, l0] = insertDims(d)
  const L = lengthOf(h) ?? l0
  const r = od / 2
  let knurl = ""
  for (let x = 0.6; x < L - 0.3; x += 0.9) knurl += `<line x1="${f(x)}" y1="${f(-r)}" x2="${f(x + 0.6)}" y2="${f(r)}"/><line x1="${f(x + 0.6)}" y1="${f(-r)}" x2="${f(x)}" y2="${f(r)}"/>`
  const svg = `<rect x="0" y="${f(-r)}" width="${f(L)}" height="${f(od)}" fill="${h.color ?? BRASS}" stroke="${INK}" stroke-width="${SW}" rx="0.2"/>
<g stroke="${INK}" stroke-width="0.07" opacity="0.6">${knurl}</g>${dim(0, L, r + 1.6, `${L} mm`)}`
  return fit({ svg, minX: -0.5, minY: -r - 0.5, w: L + 1, h: od + 5.6, trueScale: true }, L / 2, `${L} mm`)
}

function springDrawing(h: AssemblyHardware): Drawing {
  const s = h.spring ?? { kind: "compression" as const, wireDiaMm: 0.8, outerDiaMm: 6, freeLengthMm: 15 }
  const L = s.freeLengthMm
  const R = s.outerDiaMm / 2 - s.wireDiaMm / 2
  const coils = Math.max(3, Math.round((L - 2 * s.wireDiaMm) / Math.max(s.wireDiaMm * 2.2, L / 14)))
  const p = (L - s.wireDiaMm) / coils
  const x0 = s.wireDiaMm / 2
  let path = `M${f(x0)} ${f(-R)} `
  for (let i = 0; i < coils; i++) path += `L${f(x0 + p * (i + 0.5))} ${f(R)} L${f(x0 + p * (i + 1))} ${f(-R)} `
  let back = ""
  for (let i = 0; i < coils; i++) back += `M${f(x0 + p * i)} ${f(-R)} L${f(x0 + p * (i + 0.5))} ${f(R)} `
  const svg = `<path d="${back}" fill="none" stroke="#8a9099" stroke-width="${f(s.wireDiaMm)}" stroke-linecap="round"/>
<path d="${path}" fill="none" stroke="${INK}" stroke-width="${f(s.wireDiaMm + 0.24)}" stroke-linecap="round" stroke-linejoin="round"/>
<path d="${path}" fill="none" stroke="${h.color ?? STEEL}" stroke-width="${f(s.wireDiaMm)}" stroke-linecap="round" stroke-linejoin="round"/>
${dim(0, L, s.outerDiaMm / 2 + 1.6, `${L} mm free`)}`
  const H = s.outerDiaMm / 2
  return fit({ svg, minX: -0.5, minY: -H - 0.5, w: L + 1, h: s.outerDiaMm + 5.6, trueScale: true }, L / 2, `${L} mm free`)
}

function bearingDrawing(h: AssemblyHardware): Drawing {
  const b = h.bearing ?? { designation: h.size ?? "608", boreMm: 8, outerDiaMm: 22, widthMm: 7 }
  const R = b.outerDiaMm / 2
  const ri = b.boreMm / 2
  const mid = (R + ri) / 2
  const svg = `<circle r="${f(R)}" fill="${STEEL}" stroke="${INK}" stroke-width="${SW}"/>
<circle r="${f(R - (R - ri) * 0.22)}" fill="#3c4148" stroke="${INK}" stroke-width="0.1"/>
<circle r="${f(ri + (R - ri) * 0.22)}" fill="${STEEL}" stroke="${INK}" stroke-width="0.1"/>
<circle r="${f(ri)}" fill="#fff" stroke="${INK}" stroke-width="${SW}"/>
<circle r="${f(mid)}" fill="none" stroke="#8a9099" stroke-width="0.1" stroke-dasharray="0.6 0.6"/>
${dim(-R, R, R + 1.6, `${b.outerDiaMm} mm`)}`
  return fit({ svg, minX: -R - 0.5, minY: -R - 0.5, w: 2 * R + 1, h: 2 * R + 5.6, trueScale: true }, 0, `${b.outerDiaMm} mm`)
}

function magnetDrawing(h: AssemblyHardware): Drawing {
  const sp = sizePair(h)
  const m = h.magnet ?? { shape: "disc" as const, diaMm: sp?.[0] ?? 6, thicknessMm: sp?.[1] ?? 3 }
  const fill = h.color ?? "#9aa1ab"
  if (m.shape === "block") {
    const L = m.lengthMm ?? 10
    const W = m.widthMm ?? 5
    const svg = `<rect x="0" y="${f(-W / 2)}" width="${f(L)}" height="${f(W)}" fill="${fill}" stroke="${INK}" stroke-width="${SW}"/>${dim(0, L, W / 2 + 1.6, `${L} mm`)}`
    return fit({ svg, minX: -0.5, minY: -W / 2 - 0.5, w: L + 1, h: W + 5.6, trueScale: true }, L / 2, `${L} mm`)
  }
  const D = m.diaMm ?? 6
  const R = D / 2
  const side = `<rect x="${f(R + 2)}" y="${f(-R)}" width="${f(m.thicknessMm)}" height="${f(D)}" fill="${fill}" stroke="${INK}" stroke-width="${SW}"/>`
  const svg = `<circle r="${f(R)}" fill="${fill}" stroke="${INK}" stroke-width="${SW}"/>${m.shape === "ring" ? `<circle r="${f(R * 0.4)}" fill="#fff" stroke="${INK}" stroke-width="${SW}"/>` : ""}${side}${dim(-R, R, R + 1.6, `${D} mm`)}`
  return fit({ svg, minX: -R - 0.5, minY: -R - 0.5, w: D + m.thicknessMm + 3, h: D + 5.6, trueScale: true }, 0, `${D} mm`)
}

/** A straight piece of filament at real size. */
function offcutDrawing(h: AssemblyHardware): Drawing {
  const [d, L] = offcutDims(h)
  const r = d / 2
  const svg = `<rect x="0" y="${f(-r)}" width="${f(L)}" height="${f(d)}" rx="${f(r * 0.3)}" fill="${h.color ?? "#e8743b"}" stroke="${INK}" stroke-width="${SW}"/>
<g stroke="${INK}" stroke-width="0.15"><line x1="0" y1="${f(-r - 1.2)}" x2="0" y2="${f(r + 1.2)}" stroke-dasharray="0.6 0.5"/><line x1="${f(L)}" y1="${f(-r - 1.2)}" x2="${f(L)}" y2="${f(r + 1.2)}" stroke-dasharray="0.6 0.5"/></g>
${dim(0, L, r + 2.2, `cut ${L} mm`)}`
  return fit({ svg, minX: -0.5, minY: -r - 1.7, w: L + 1, h: d + 7, trueScale: true }, L / 2, `cut ${L} mm`)
}

function rodDrawing(h: AssemblyHardware): Drawing {
  const m = h.size?.match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/)
  const d = h.threadMm ?? (m ? Number(m[1]) : 3)
  const L = h.lengthMm ?? (m ? Number(m[2]) : 20)
  const r = d / 2
  const c = Math.min(r * 0.4, 0.5)
  const fill = h.color ?? STEEL
  const body = h.type === "standoff"
    ? `<rect x="0" y="${f(-nutDims(d)[0] / Math.sqrt(3))}" width="${f(L)}" height="${f((2 * nutDims(d)[0]) / Math.sqrt(3))}" fill="${h.color ?? BRASS}"/>`
    : `<path d="M${f(c)} ${f(-r)} L${f(L - c)} ${f(-r)} L${f(L)} ${f(-r + c)} L${f(L)} ${f(r - c)} L${f(L - c)} ${f(r)} L${f(c)} ${f(r)} L0 ${f(r - c)} L0 ${f(-r + c)} Z" fill="${fill}"/>`
  const H = h.type === "standoff" ? nutDims(d)[0] / Math.sqrt(3) : r
  const svg = `<g stroke="${INK}" stroke-width="${SW}">${body}</g>${dim(0, L, H + 1.6, `${L} mm`)}`
  return fit({ svg, minX: -0.5, minY: -H - 0.5, w: L + 1, h: 2 * H + 5.6, trueScale: true }, L / 2, `${L} mm`)
}

function oringDrawing(h: AssemblyHardware): Drawing {
  const m = h.size?.match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/)
  const id = m ? Number(m[1]) : (h.threadMm ?? 10)
  const cs = m ? Number(m[2]) : 1.5
  const R = id / 2 + cs
  const svg = `<circle r="${f(id / 2 + cs / 2)}" fill="none" stroke="${INK}" stroke-width="${f(cs + 0.3)}"/><circle r="${f(id / 2 + cs / 2)}" fill="none" stroke="${h.color ?? "#2b2b2b"}" stroke-width="${f(cs)}"/>${dim(-id / 2, id / 2, R + 1.6, `ID ${id} mm`)}`
  return fit({ svg, minX: -R - 0.5, minY: -R - 0.5, w: 2 * R + 1, h: 2 * R + 5.6, trueScale: true }, 0, `ID ${id} mm`)
}

function footDrawing(h: AssemblyHardware): Drawing | null {
  const m = h.size?.match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/)
  if (!m) return null
  const D = Number(m[1])
  const H = Number(m[2])
  const R = D / 2
  const svg = `<path d="M${f(-R)} 0 Q${f(-R)} ${f(-H)} 0 ${f(-H)} Q${f(R)} ${f(-H)} ${f(R)} 0 Z" fill="${h.color ?? "#2b2b2b"}" stroke="${INK}" stroke-width="${SW}"/>${dim(-R, R, 1.6, `${D} mm`)}`
  return fit({ svg, minX: -R - 0.5, minY: -H - 0.5, w: D + 1, h: H + 5.6, trueScale: true }, 0, `${D} mm`)
}

function sizePair(h: AssemblyHardware): [number, number] | null {
  const m = h.size?.match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/)
  return m ? [Number(m[1]), Number(m[2])] : null
}

/** Plastic wall plug, side view: size "6x30" = drill/plug dia x length. */
function anchorDrawing(h: AssemblyHardware): Drawing {
  const [d, L] = sizePair(h) ?? [h.threadMm ?? 6, h.lengthMm ?? 30]
  const r = d / 2
  const fl = Math.max(0.8, d * 0.12) // flange thickness
  const R = r * 1.35 // flange radius
  const tip = r * 0.75
  let ribs = ""
  for (let x = fl + 2; x < L - 2; x += Math.max(1.5, d * 0.35)) ribs += `<line x1="${f(x)}" y1="${f(-r + 0.3)}" x2="${f(x)}" y2="${f(r - 0.3)}"/>`
  const body = `<path d="M${f(fl)} ${f(-r)} L${f(L)} ${f(-tip)} L${f(L)} ${f(tip)} L${f(fl)} ${f(r)} Z" fill="${h.color ?? "#d9d3c3"}"/>
<rect x="0" y="${f(-R)}" width="${f(fl)}" height="${f(2 * R)}" fill="${h.color ?? "#d9d3c3"}"/>
<line x1="${f(fl)}" y1="0" x2="${f(L * 0.8)}" y2="0" stroke-dasharray="1 0.8"/>`
  const svg = `<g stroke="${INK}" stroke-width="${SW}" stroke-linejoin="round">${body}</g><g stroke="${INK}" stroke-width="0.08" opacity="0.6">${ribs}</g>${dim(0, L, R + 1.6, `${L} mm`)}`
  return fit({ svg, minX: -0.5, minY: -R - 0.5, w: L + 1, h: 2 * R + 5.6, trueScale: true }, L / 2, `${L} mm`)
}

/** Double-sided adhesive strip / pad, face view: size "20x50" = width x length. */
function stripDrawing(h: AssemblyHardware): Drawing {
  const [W, L] = sizePair(h) ?? [20, 50]
  const tab = Math.min(12, L * 0.25)
  const svg = `<rect x="0" y="${f(-W / 2)}" width="${f(L)}" height="${f(W)}" rx="1" fill="${h.color ?? "#f2f2f0"}" stroke="${INK}" stroke-width="${SW}"/>
<rect x="${f(L)}" y="${f(-W / 4)}" width="${f(tab)}" height="${f(W / 2)}" rx="0.8" fill="#c9d6e8" stroke="${INK}" stroke-width="${SW}"/>
<line x1="${f(L - 0.01)}" y1="${f(-W / 2)}" x2="${f(L - 0.01)}" y2="${f(W / 2)}" stroke="${INK}" stroke-width="0.1" stroke-dasharray="0.8 0.6"/>
<text x="${f(L + tab / 2)}" y="${f(0.9)}" font-size="2.2" text-anchor="middle" fill="${INK}" font-family="Helvetica, Arial, sans-serif">pull</text>
${dim(0, L, W / 2 + 1.6, `${L} × ${W} mm`)}`
  return fit({ svg, minX: -0.5, minY: -W / 2 - 0.5, w: L + tab + 1, h: W + 5.6, trueScale: true }, L / 2, `${L} × ${W} mm`)
}

/** Generic icon (not to scale) for consumables and things without a meaningful silhouette. */
function iconDrawing(type: string): Drawing {
  const g = `fill="none" stroke="${INK}" stroke-width="0.9" stroke-linecap="round" stroke-linejoin="round"`
  const icons: Record<string, string> = {
    "zip-tie": `<path ${g} d="M3 12 a7 7 0 1 1 7 7 L21 19"/><rect x="1.5" y="10" width="3.2" height="4" fill="${INK}"/>`,
    glue: `<path ${g} d="M8 9 h8 v12 h-8 z M10 9 v-3 h4 v3 M12 6 v-3"/>`,
    tape: `<circle cx="12" cy="12" r="8" ${g}/><circle cx="12" cy="12" r="4" ${g}/><path ${g} d="M12 20 h9"/>`,
    electronics: `<rect x="5" y="5" width="14" height="14" ${g}/><path ${g} d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>`,
    "rubber-foot": `<path ${g} d="M4 16 q8 -10 16 0 z"/>`,
  }
  // Generic item: a small parcel (not to scale).
  const svg = icons[type] ?? `<path ${g} d="M4 8 l8 -4 8 4 v9 l-8 4 -8 -4 z M4 8 l8 4 8 -4 M12 12 v9"/>`
  return { svg, minX: 0, minY: 0, w: 24, h: 24, trueScale: false }
}

export function hardwareDrawing(h: AssemblyHardware): Drawing {
  switch (h.type) {
    case "screw":
    case "bolt":
      return screwDrawing(h)
    case "nut":
      return nutDrawing(h)
    case "washer":
      return washerDrawing(h)
    case "heat-set-insert":
    case "threaded-insert":
      return insertDrawing(h)
    case "spring":
      return springDrawing(h)
    case "bearing":
      return bearingDrawing(h)
    case "magnet":
      return magnetDrawing(h)
    case "filament-offcut":
      return offcutDrawing(h)
    case "rod":
    case "dowel-pin":
    case "standoff":
      return rodDrawing(h)
    case "o-ring":
      return oringDrawing(h)
    case "rubber-foot":
      return footDrawing(h) ?? iconDrawing(h.type)
    case "wall-anchor":
      return anchorDrawing(h)
    case "adhesive-strip":
      return stripDrawing(h)
    default:
      // Older assembly.json files describe these as "other"/"tape": recognise them by name.
      if (/anchor|wall ?plug|drywall/i.test(`${h.name ?? ""} ${h.purchaseHint ?? ""}`)) return anchorDrawing(h)
      if (/adhesive|command strip|mounting (strip|tape|pad)|double.?sided|vhb/i.test(`${h.name ?? ""} ${h.purchaseHint ?? ""}`)) return stripDrawing(h)
      return iconDrawing(h.type)
  }
}

/** Render a drawing as an <svg>. mode "true" = printed at 1:1 (mm units), else fitted into maxPx box. */
export function drawingSvg(dw: Drawing, mode: "true" | { maxW: number; maxH: number }, maxTrueWidthMm = 170): string {
  const vb = `${f(dw.minX)} ${f(dw.minY)} ${f(dw.w)} ${f(dw.h)}`
  if (mode === "true" && dw.trueScale) {
    const k = dw.w > maxTrueWidthMm ? maxTrueWidthMm / dw.w : 1
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${f(dw.w * k)}mm" height="${f(dw.h * k)}mm"${k < 1 ? ' data-scaled="1"' : ""}>${dw.svg}</svg>`
  }
  const box = mode === "true" ? { maxW: 64, maxH: 64 } : mode
  const k = Math.min(box.maxW / dw.w, box.maxH / dw.h)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${Math.round(dw.w * k)}" height="${Math.round(dw.h * k)}">${dw.svg}</svg>`
}

// ---------- tool icons (not to scale, 24x24) ----------

export function toolIcon(t: AssemblyTool): string {
  const g = `fill="none" stroke="${INK}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"`
  const icons: Record<string, string> = {
    "hex-key": `<path ${g} d="M5 4 L5 18 Q5 20 7 20 L19 20"/><path ${g} stroke-width="0.8" d="M3.6 4 h2.8"/>`,
    screwdriver: `<path ${g} d="M14 3 l7 7 -3 3 -7 -7 z M11 9 L4 16 M4 16 l-1 5 5 -1 M7 13 l4 4"/>`,
    "soldering-iron": `<path ${g} d="M21 3 l-6 6 M15 9 l-3 3 M12 12 l-7 7 -2 2"/><rect x="15.5" y="2.5" width="5" height="8" transform="rotate(45 18 6.5)" ${g}/>`,
    pliers: `<path ${g} d="M9 3 L12 12 L15 3 M12 12 L7 21 M12 12 L17 21"/>`,
    wrench: `<path ${g} d="M14.5 3.5 a5 5 0 0 0 -4.6 6.9 L3.5 16.8 a2 2 0 0 0 2.8 2.8 L12.7 13.2 a5 5 0 0 0 6.9 -4.6 l-3 1.5 -2.5 -2.5 z"/>`,
    knife: `<path ${g} d="M3 21 L14 10 L20 4 L21 5 L16 14 Z"/>`,
    file: `<path ${g} d="M5 19 L17 7 M15 5 l4 4 M8 20 l-4 -4"/>`,
    clamp: `<path ${g} d="M6 4 h10 v4 M6 4 v16 h10 v-4 M16 8 v8"/>`,
    drill: `<path ${g} d="M3 8 h11 v6 h-11 z M14 11 h7 M8 14 l-1 7 h4 l-1 -7"/>`,
    tweezers: `<path ${g} d="M4 20 L18 4 M8 20 L20 7"/>`,
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="40" height="40">${icons[t.type] ?? `<circle cx="12" cy="12" r="8" ${g}/>`}</svg>`
}
