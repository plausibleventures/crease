// App-managed OpenSCAD libraries (BOSL2, ...). Vendored under resources/openscad-libraries/ so they work offline
// and in the packaged app; copied into <STUDIO_HOME>/libraries/ and exposed to OpenSCAD via OPENSCADPATH.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { STUDIO_HOME } from "../config"

export const LIBRARIES_DIR = join(STUDIO_HOME, "libraries")
// Packaged Electron sets PRINTSTUDIO_OPENSCAD_LIBRARIES (the bundled main lives in dist-electron/, see electron/main.ts).
export const BUNDLED_LIBRARIES_DIR =
  process.env.PRINTSTUDIO_OPENSCAD_LIBRARIES ?? join(dirname(fileURLToPath(import.meta.url)), "../../resources/openscad-libraries")

let synced = false

/** Copy bundled library directories into LIBRARIES_DIR once per process (only files whose content differs). */
export function ensureLibraries(): string {
  if (synced) return LIBRARIES_DIR
  mkdirSync(LIBRARIES_DIR, { recursive: true })
  if (existsSync(BUNDLED_LIBRARIES_DIR)) {
    for (const e of readdirSync(BUNDLED_LIBRARIES_DIR, { withFileTypes: true })) {
      if (e.isDirectory()) syncDir(join(BUNDLED_LIBRARIES_DIR, e.name), join(LIBRARIES_DIR, e.name))
    }
  }
  synced = true
  return LIBRARIES_DIR
}

function syncDir(src: string, dest: string) {
  mkdirSync(dest, { recursive: true })
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, e.name)
    const to = join(dest, e.name)
    if (e.isDirectory()) syncDir(from, to)
    else if (e.isFile()) {
      const content = readFileSync(from)
      if (!existsSync(to) || statSync(to).size !== content.length || !readFileSync(to).equals(content)) {
        writeFileSync(to, content)
      }
    }
  }
}

/** Env for an OpenSCAD child process: app libraries first, then any user OPENSCADPATH. */
export function openscadEnv(): NodeJS.ProcessEnv {
  const libs = ensureLibraries()
  const sep = process.platform === "win32" ? ";" : ":"
  const existing = process.env.OPENSCADPATH
  return { ...process.env, OPENSCADPATH: existing ? `${libs}${sep}${existing}` : libs }
}
