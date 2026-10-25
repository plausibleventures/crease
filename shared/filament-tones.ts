// Filament tones: colour lives in the user's work, so parts are drawn in the colours a real PLA spool has, not in
// screen primaries ("blue" is #0000ff in CSS, nothing like blue PLA). One table for the 3D viewer (src/) and the
// server's OpenSCAD part pictures (server/cad/preview.ts), so a thumbnail and the 3D view agree.
// Dependency-free: both sides import it.

/** CSS named colour (as #rrggbb) -> a filament-like tone. */
const TONES: Record<string, string> = {
  "#ff0000": "#d62839", // red
  "#ffa500": "#f26b1d", // orange
  "#ff8c00": "#f26b1d", // darkorange
  "#ffff00": "#f5c400", // yellow
  "#ffd700": "#e8b923", // gold
  "#008000": "#2a9d4b", // green
  "#00ff00": "#7ac943", // lime
  "#32cd32": "#5fbf3a", // limegreen
  "#008080": "#12a4a0", // teal
  "#00ffff": "#1fb5c9", // cyan / aqua
  "#0000ff": "#2b5fd9", // blue
  "#000080": "#1f2f6b", // navy
  "#800080": "#7b3fbf", // purple
  "#ff00ff": "#d83f9a", // magenta / fuchsia
  "#ffc0cb": "#ef7aa8", // pink
  "#a52a2a": "#8b5a2b", // brown
  "#808080": "#8a8d91", // gray
}

/** The CSS names behind TONES (the server has no canvas to resolve names; the client uses its own). */
const NAMED: Record<string, string> = {
  red: "#ff0000",
  orange: "#ffa500",
  darkorange: "#ff8c00",
  yellow: "#ffff00",
  gold: "#ffd700",
  green: "#008000",
  lime: "#00ff00",
  limegreen: "#32cd32",
  teal: "#008080",
  cyan: "#00ffff",
  aqua: "#00ffff",
  blue: "#0000ff",
  navy: "#000080",
  purple: "#800080",
  magenta: "#ff00ff",
  fuchsia: "#ff00ff",
  pink: "#ffc0cb",
  brown: "#a52a2a",
  gray: "#808080",
  grey: "#808080",
}

/** PLA colours for parts that have none, picked per part so a project's parts differ. */
export const PLA_PALETTE = ["#2b5fd9", "#f26b1d", "#12a4a0", "#d62839", "#f5c400", "#2a9d4b"]

/** "#rrggbb" -> its filament tone (unchanged when it isn't a screen primary). */
export function filamentTone(hex: string): string {
  return TONES[hex.toLowerCase()] ?? hex
}

/** A colour string as written in a design ("blue", "Blue", "#00f", "#0000ff") -> its tone, or null if it has none. */
export function toneOf(colour: string): string | null {
  const c = colour.trim().toLowerCase()
  let hex = NAMED[c] ?? null
  if (!hex && /^#[0-9a-f]{3}$/.test(c)) hex = "#" + [...c.slice(1)].map((x) => x + x).join("")
  if (!hex && /^#[0-9a-f]{6}$/.test(c)) hex = c
  return hex ? (TONES[hex] ?? null) : null
}

/** The palette colour for a part with no colour of its own (stable per seed, usually the part id). */
export function paletteFor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
  return PLA_PALETTE[Math.abs(h) % PLA_PALETTE.length]
}
