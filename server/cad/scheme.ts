// OpenSCAD render colour schemes for the app's PNG previews.
// "dark": the app's previews (the flat background is made transparent, so pictures sit on the --stage tone). Geometry
// without color() is drawn in the part's filament tone (shared/filament-tones.ts): one scheme per tone.
// OpenSCAD has no flag for a scheme file, but it loads extra render schemes from its user config dir
// (<config>/OpenSCAD/color-schemes/render/*.json), so we install ours there once per process.
// "light": OpenSCAD's built-in Tomorrow (white paper; assembly guides).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export type RenderScheme = "dark" | "light"

/** Bumped whenever preview styling changes, so cached renders are redone once. */
export const RENDER_STYLE = "dark-v5" // v2: dark colours in variables lifted, face-down pieces turned over; v3: charcoal bed; v4: black stays black (small lift), lighter bed; v5: filament tones, uncoloured parts in a PLA colour

export const DARK_SCHEME_NAME = "PrintStudio Dark"
/** The viewer's neutral part grey: geometry without color() when no part colour is known. */
export const NEUTRAL_FACE = "#cfd3da"

function darkScheme(face: string, name: string, index: number) {
  return {
    name,
    index,
    "show-in-gui": false,
    colors: {
      background: "#000000",
      "axes-color": "#2b3140",
      // geometry without color(): front and cut faces alike
      "opencsg-face-front": face,
      "opencsg-face-back": face,
      "cgal-face-front": face,
      "cgal-face-back": face,
      "cgal-face-2d": face,
      "cgal-edge-front": "#3d4454",
      "cgal-edge-back": "#3d4454",
      "cgal-edge-2d": "#8f97a8",
      crosshair: "#8f97a8",
    },
  }
}

function userSchemeDir(): string {
  const base =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support")
      : process.platform === "win32"
        ? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
        : (process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"))
  return join(base, "OpenSCAD", "color-schemes", "render")
}

/** The scheme name for a face colour (the neutral one keeps the original name and file). */
export function darkSchemeName(face: string): string {
  return face === NEUTRAL_FACE ? DARK_SCHEME_NAME : `${DARK_SCHEME_NAME} ${face.slice(1)}`
}

const installed = new Map<string, boolean>()

/** Install the dark scheme for a face colour (once each). Returns false if it couldn't be written. */
function installDark(face: string): boolean {
  const known = installed.get(face)
  if (known !== undefined) return known
  const neutral = face === NEUTRAL_FACE
  let ok = false
  try {
    const dir = userSchemeDir()
    const file = join(dir, neutral ? "printstudio-dark.json" : `printstudio-dark-${face.slice(1)}.json`)
    const index = neutral ? 9100 : 9101 + (parseInt(face.slice(1), 16) % 800)
    const body = JSON.stringify(darkScheme(face, darkSchemeName(face), index), null, 2) + "\n"
    if (!existsSync(file) || readFileSync(file, "utf8") !== body) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(file, body)
    }
    ok = true
  } catch (e) {
    console.error("[cad] could not install an OpenSCAD dark colour scheme", e)
  }
  installed.set(face, ok)
  return ok
}

/** --colorscheme value for a scheme; `face` (#rrggbb) colours the dark scheme's geometry without color(). */
export function colorschemeArg(scheme: RenderScheme, face: string = NEUTRAL_FACE): string {
  if (scheme === "light") return "Tomorrow"
  const f = /^#[0-9a-f]{6}$/i.test(face) ? face.toLowerCase() : NEUTRAL_FACE
  if (installDark(f)) return darkSchemeName(f)
  return installDark(NEUTRAL_FACE) ? DARK_SCHEME_NAME : "Tomorrow Night"
}
