// Preview-only helpers for the OpenSCAD PNG renders (never used for exports / slicing):
//  - a copy of the part source with colours as the 3D viewer shows them: screen primaries as filament tones, very
//    dark colours lightened so black parts still shade (OpenSCAD's fixed lighting turns near-black into a flat
//    silhouette), and the colour for geometry without color() (partFace);
//  - picking which side is the part's "front" so wall-mounted parts aren't shown from the wall side.
import { existsSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import type { IndexedMesh } from "./mesh"
import { paletteFor, toneOf } from "../../shared/filament-tones"

// SVG colour names that may be dark enough to need lifting (liftDark decides; others render fine).
const DARK_NAMES: Record<string, [number, number, number]> = {
  black: [0, 0, 0],
  dimgray: [105, 105, 105],
  dimgrey: [105, 105, 105],
  darkslategray: [47, 79, 79],
  darkslategrey: [47, 79, 79],
  midnightblue: [25, 25, 112],
  navy: [0, 0, 128],
  darkblue: [0, 0, 139],
  maroon: [128, 0, 0],
  darkred: [139, 0, 0],
  darkgreen: [0, 100, 0],
  indigo: [75, 0, 130],
  darkslateblue: [72, 61, 139],
  darkolivegreen: [85, 107, 47],
  saddlebrown: [139, 69, 19],
  purple: [128, 0, 128],
  darkmagenta: [139, 0, 139],
  teal: [0, 128, 128],
  brown: [165, 42, 42],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  darkgray: [169, 169, 169],
  darkgrey: [169, 169, 169],
  slategray: [112, 128, 144],
  slategrey: [112, 128, 144],
  olive: [128, 128, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  red: [255, 0, 0],
  darkcyan: [0, 139, 139],
  firebrick: [178, 34, 34],
  crimson: [220, 20, 60],
  sienna: [160, 82, 45],
  chocolate: [210, 105, 30],
}

/**
 * Lift only colours that are dark by value (brightest channel below LIFT_BELOW), and only a little: OpenSCAD's fixed
 * lighting turns near-black into a flat silhouette, and pure black would vanish into the picture's (cleared) black
 * background, but a lift to mid-grey made black parts look grey. Black becomes #333333 (faces shade apart, still reads
 * black); the lift shrinks as the colour gets lighter, so darker shades stay darker and there's no jump at the edge.
 * Saturated colours (red, blue…) are left alone so their hue doesn't wash out.
 */
const LIFT_BELOW = 80
const LIFT_BLACK = 51 // black -> #333333

export function liftDark(rgb: [number, number, number]): [number, number, number] | null {
  const max = Math.max(...rgb)
  if (max >= LIFT_BELOW) return null
  const add = Math.round(((LIFT_BELOW - max) * LIFT_BLACK) / LIFT_BELOW)
  return rgb.map((c) => Math.min(255, c + add)) as [number, number, number]
}

const toHex = (rgb: number[]) => "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("")

function parseHexColor(s: string): [number, number, number] | null {
  const m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i)
  if (!m) return null
  let h = m[1]
  if (h.length <= 4) h = [...h].map((c) => c + c).join("")
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

/**
 * A colour string as a preview draws it (quoted, ready to splice into source), or null to leave it as written:
 * screen primaries become filament tones ("blue" -> blue PLA, shared/filament-tones.ts), and dark colours are lifted
 * a little (liftDark). One pass, so nothing is lifted twice.
 */
function shownColour(c: string): string | null {
  const tone = toneOf(c)
  const rgb = tone ? parseHexColor(tone) : (DARK_NAMES[c.toLowerCase()] ?? parseHexColor(c))
  const lifted = rgb && liftDark(rgb)
  if (lifted) return `"${toHex(lifted)}"`
  return tone ? `"${tone}"` : null
}

// A few more names a part's colour may be given in (project.json), for the colour of geometry without color().
const PLAIN_NAMES: Record<string, string> = {
  white: "#f5f5f5",
  black: "#333333",
  silver: "#c0c0c0",
  ivory: "#fffff0",
  beige: "#f5f5dc",
  natural: "#efe6d2",
  transparent: "#cfd3da",
}

/**
 * The colour for a part's geometry without color() (#rrggbb), exactly as the 3D viewer draws it
 * (src/components/viewer/shared.tsx): its colour from the project, as a filament tone; else the filament it prints in
 * (`printsIn`: the first loaded on its printer), so the picture never promises a colour the print won't have; else
 * (no printer known) a PLA colour picked from the part id.
 */
export function partFace(colour: string | undefined, partId: string, printsIn?: string | null): string {
  if (!colour && printsIn) colour = printsIn
  if (colour) {
    const c = colour.trim().toLowerCase()
    const tone = toneOf(c)
    if (tone) return tone
    const rgb = parseHexColor(c)
    if (rgb) return toHex(liftDark(rgb) ?? rgb)
    if (PLAIN_NAMES[c]) return PLAIN_NAMES[c]
  }
  return paletteFor(partId)
}

/**
 * Source for preview renders: colour literals as the viewer shows them (shownColour), and include/use/import paths
 * made absolute so the copy can live in build/.
 */
export function previewSource(src: string, srcDir: string): string {
  let out = src.replace(/\b(include|use)(\s*)<([^>]+)>/g, (all, kw: string, sp: string, p: string) => {
    if (isAbsolute(p)) return all
    const abs = resolve(srcDir, p)
    return existsSync(abs) ? `${kw}${sp}<${abs}>` : all
  })
  out = out.replace(/\b(import|surface)(\s*\(\s*(?:file\s*=\s*)?)"([^"]+)"/g, (all, kw: string, mid: string, p: string) => {
    if (isAbsolute(p)) return all
    const abs = resolve(srcDir, p)
    return existsSync(abs) ? `${kw}${mid}${JSON.stringify(abs)}` : all
  })
  // Dark colour literals: color("name" | "#hex") and colours held in variables (`body_colour = "black";`,
  // `colours = ["black", "white"];`), i.e. any colour string that isn't text() content. One pass, so nothing is lifted
  // twice (a lifted colour is still dark enough to lift again).
  out = out.replace(/(text\s*\(\s*(?:text\s*=\s*)?)?"([^"\n]+)"/g, (all, text: string | undefined, c: string) => {
    if (text) return all
    return shownColour(c) ?? all
  })
  // color([r, g, b(, a)]) with 0..1 components
  out = out.replace(
    /\bcolor(\s*\(\s*(?:c\s*=\s*)?)\[\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(,\s*[\d.]+\s*)?\]/g,
    (all, mid: string, r: string, g: string, b: string, a: string | undefined) => {
      const rgb = [r, g, b].map((v) => Math.round(Math.min(1, Math.max(0, Number(v))) * 255)) as [number, number, number]
      const lifted = liftDark(rgb)
      if (!lifted) return all
      return `color${mid}[${lifted.map((c) => (c / 255).toFixed(3)).join(", ")}${a ?? ""}]`
    },
  )
  return `// generated by Crease for preview renders only (dark colours lifted); do not edit\n${out}`
}

export type FrontDir = "-y" | "+y" | "-x" | "+x"

/** Camera yaw (OpenSCAD rot_z, degrees) that looks at the given side. rot_z = 0 looks from -Y. */
export const FRONT_YAW: Record<FrontDir, number> = { "-y": 0, "+x": 90, "+y": 180, "-x": 270 }

/** Explicit override in the part source: `// @front: +y` (also -y, +x, -x). */
export function declaredFront(src: string): FrontDir | null {
  const m = src.match(/\/\/\s*@front\s*:?\s*([+-][xy])\b/i)
  return m ? (m[1].toLowerCase() as FrontDir) : null
}

/**
 * Pick the more detailed of the -Y / +Y sides: count triangles facing each way. A wall-mounted part's
 * back is one big flat face (few triangles); its front carries hooks, pockets, text... (many).
 * Defaults to -Y (OpenSCAD's front) unless +Y is clearly busier.
 */
export function detectFront(mesh: IndexedMesh): FrontDir {
  const v = mesh.verts
  const t = mesh.tris
  let neg = 0
  let pos = 0
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3
    const b = t[i + 1] * 3
    const c = t[i + 2] * 3
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2]
    const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2]
    const nx = uy * wz - uz * wy
    const ny = uz * wx - ux * wz
    const nz = ux * wy - uy * wx
    const len = Math.hypot(nx, ny, nz)
    if (!len) continue
    const y = ny / len
    if (y < -0.3) neg++
    else if (y > 0.3) pos++
  }
  return pos > neg * 1.5 && pos - neg > 8 ? "+y" : "-y"
}

/** Customizer values for preview renders: a dark colour chosen in a setting is lifted like one in the source. */
export function previewParams<T extends Record<string, number | string | boolean>>(params: T | undefined): T | undefined {
  if (!params) return params
  const out: Record<string, number | string | boolean> = { ...params }
  for (const [k, v] of Object.entries(out)) {
    if (typeof v !== "string") continue
    const shown = shownColour(v)
    if (shown) out[k] = shown.slice(1, -1)
  }
  return out as T
}

/**
 * A face-down display piece: modelled mirrored, show face on the plate (z = 0), so the side a camera above sees is its
 * back. The source says so with `// @show: plate`; a flat part that mirrors its design in X and says "face down" in a
 * comment counts too (what the print-finish skill asks the designer for). Previews then look at the show face.
 */
export function showsFaceDown(src: string, sizeMm: readonly number[] | null | undefined): boolean {
  if (/\/\/\s*@show\s*:?\s*(plate|down|bottom)\b/i.test(src)) return true
  if (!sizeMm || sizeMm.length < 3) return false
  const flat = sizeMm[2] <= 0.35 * Math.min(sizeMm[0], sizeMm[1])
  const mirrored = /\bmirror\s*\(\s*(?:v\s*=\s*)?\[\s*-?1\s*,\s*0\s*,\s*0\s*\]/.test(src)
  const comments = (src.match(/\/\/.*$|\/\*[\s\S]*?\*\//gm) ?? []).join("\n")
  return flat && mirrored && /face[\s-]*down|show[\s-]*face|on the (build )?plate/i.test(comments)
}

/**
 * OpenSCAD camera rotation that shows the part turned over (rotate([0, 180, 0])) from the same viewpoint: the
 * view is Rx·Ry·Rz, and Rx(rx)·Rz(rz)·Ry(180) = Rx(rx + 180)·Rz(180 - rz). Only for ry = 0 (every preview view).
 */
export function turnedOverCamera([rx, ry, rz]: readonly [number, number, number]): [number, number, number] {
  if (ry !== 0) throw new Error("turnedOverCamera: ry must be 0")
  return [(rx + 180) % 360, 0, (((180 - rz) % 360) + 360) % 360]
}

