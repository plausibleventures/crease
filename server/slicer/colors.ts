// Colour values from OpenSCAD color() calls -> hex, and colour -> CFS slot matching.
import type { FilamentSlot } from "../../shared/types"

// SVG/CSS colour names (what OpenSCAD's color("name") accepts).
const NAMED: Record<string, string> = Object.fromEntries(
  (
    "aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque ffe4c4 black 000000 " +
    "blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 " +
    "chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b " +
    "darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b darkmagenta 8b008b " +
    "darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 darksalmon e9967a darkseagreen 8fbc8f " +
    "darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493 " +
    "deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff firebrick b22222 floralwhite fffaf0 forestgreen 228b22 " +
    "fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 grey 808080 green 008000 " +
    "greenyellow adff2f honeydew f0fff0 hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa " +
    "lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff " +
    "lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a " +
    "lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 lightsteelblue b0c4de lightyellow ffffe0 " +
    "lime 00ff00 limegreen 32cd32 linen faf0e6 magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd " +
    "mediumorchid ba55d3 mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a " +
    "mediumturquoise 48d1cc mediumvioletred c71585 midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 " +
    "navajowhite ffdead navy 000080 oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 " +
    "palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9 " +
    "peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f " +
    "royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee sienna a0522d " +
    "silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa springgreen 00ff7f " +
    "steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0 violet ee82ee wheat f5deb3 " +
    "white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32"
  )
    .match(/\S+ \S+/g)!
    .map((p) => {
      const [n, h] = p.split(" ")
      return [n, `#${h}`]
    }),
)

/**
 * Hex for a colour value as OpenSCAD echoes it: `"red"`, `"#f00"`, `"#ff000080"`, `[1, 0, 0]`, `[1, 0, 0, 0.5]`.
 * Returns null for anything we can't interpret (e.g. undef).
 */
export function colorValueToHex(v: string): string | null {
  const t = v.trim()
  const str = t.match(/^"(.*)"$/)?.[1]?.trim().toLowerCase()
  if (str !== undefined) {
    if (NAMED[str]) return NAMED[str]
    const h = str.match(/^#([0-9a-f]{3,8})$/)?.[1]
    if (!h) return null
    if (h.length === 3 || h.length === 4) return `#${[...h.slice(0, 3)].map((c) => c + c).join("")}`
    if (h.length === 6 || h.length === 8) return `#${h.slice(0, 6)}`
    return null
  }
  const vec = t.match(/^\[([^\]]*)\]$/)?.[1]
  if (vec) {
    const n = vec.split(",").map((x) => Number(x.trim()))
    if (n.length < 3 || n.slice(0, 3).some((x) => !Number.isFinite(x))) return null
    return `#${n
      .slice(0, 3)
      .map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, "0"))
      .join("")}`
  }
  return null
}

/** Human label for a colour value: the name if it's a named colour, else the hex. */
export function colorLabel(v: string): string {
  const s = v.trim().match(/^"(.*)"$/)?.[1]
  return s ?? colorValueToHex(v) ?? v
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

/** Perceptual-ish colour distance (CIE76 on Lab). 0 = same; ~2.3 = just noticeable; > ~50 = clearly different. */
export function colorDistance(a: string, b: string): number {
  const lab = (hex: string) => {
    const [r, g, bl] = rgb(hex).map((c) => {
      const x = c / 255
      return x > 0.04045 ? ((x + 0.055) / 1.055) ** 2.4 : x / 12.92
    })
    const X = (r * 0.4124 + g * 0.3576 + bl * 0.1805) / 0.95047
    const Y = r * 0.2126 + g * 0.7152 + bl * 0.0722
    const Z = (r * 0.0193 + g * 0.1192 + bl * 0.9505) / 1.08883
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
    return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))]
  }
  const [l1, a1, b1] = lab(a)
  const [l2, a2, b2] = lab(b)
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2)
}

/** Max distance for "this model colour means that loaded filament" when names don't match exactly. */
export const MATCH_THRESHOLD = 45

export interface ColorMatch {
  value: string // raw OpenSCAD value, e.g. "\"red\"" or "[1, 0, 0]"
  label: string
  hex: string
  slot: number // 1-based CFS slot
}

/** An error the user/agent can fix (HTTP 422), not a server fault. */
export const userError = (msg: string) => Object.assign(new Error(msg), { statusCode: 422 })

const slotList = (slots: FilamentSlot[]) =>
  slots.map((s) => `slot ${s.slot}: ${s.colorName} ${s.colorHex} ${s.material}`).join("; ")

/**
 * Map each distinct model colour to a loaded filament slot: exact name match, then the nearest colour within
 * MATCH_THRESHOLD. Throws an actionable error for unknown colours, too many colours, or two different model
 * colours landing on the same slot.
 */
export function mapColorsToSlots(values: string[], filaments: FilamentSlot[], slotCount: number): ColorMatch[] {
  const loaded = filaments.filter((f) => f.loaded && f.slot >= 1 && f.slot <= slotCount)
  if (!loaded.length) throw userError("No filaments are loaded. Ask the user which colours are in the CFS slots (Settings → Printer).")
  const out: ColorMatch[] = []
  const problems: string[] = []
  for (const value of values) {
    const hex = colorValueToHex(value)
    const label = colorLabel(value)
    if (!hex) {
      problems.push(`color(${value}) isn't a colour I can read; use a name like "red" or "#d32f2f"`)
      continue
    }
    const byName = loaded.find((f) => f.colorName.trim().toLowerCase() === label.toLowerCase())
    const nearest = [...loaded].sort((x, y) => colorDistance(hex, x.colorHex) - colorDistance(hex, y.colorHex))[0]
    const pick = byName ?? (colorDistance(hex, nearest.colorHex) <= MATCH_THRESHOLD ? nearest : null)
    if (!pick) {
      problems.push(`colour "${label}" (${hex}) isn't loaded (closest is slot ${nearest.slot} ${nearest.colorName})`)
      continue
    }
    out.push({ value, label, hex, slot: pick.slot })
  }
  const distinctSlots = new Set(out.map((m) => m.slot))
  if (values.length > slotCount) {
    problems.unshift(`the part uses ${values.length} colours but the printer has ${slotCount} filament slots`)
  }
  for (const slot of distinctSlots) {
    const same = out.filter((m) => m.slot === slot)
    // Two clearly different design colours on one filament would silently print in one colour.
    if (same.length > 1 && same.some((m) => colorDistance(m.hex, same[0].hex) > 10)) {
      problems.push(`${same.map((m) => `"${m.label}"`).join(" and ")} would both print with slot ${slot}`)
    }
  }
  if (problems.length) {
    throw userError(
      `Multicolour slicing needs every color() to match a loaded filament. ${problems.join("; ")}. ` +
        `Loaded: ${slotList(loaded)}. Change the color() values to these colours, or ask the user to load the missing filament and update Settings → Printer.`,
    )
  }
  return out
}
