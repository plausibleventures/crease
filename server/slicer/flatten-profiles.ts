// Regenerates resources/slicer-profiles/<key>/*.json from OrcaSlicer's bundled system profiles by
// flattening the "inherits" chain (the CLI does not resolve inherits for --load-settings files).
// Usage: npx tsx server/slicer/flatten-profiles.ts [/Applications/OrcaSlicer.app]
import { readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const app = process.argv[2] ?? "/Applications/OrcaSlicer.app"
const PROFILES = join(app, "Contents/Resources/profiles")
const KEY = "sparkx-i7" // Machine.slicerProfile
const OUT = join(dirname(fileURLToPath(import.meta.url)), "../../resources/slicer-profiles", KEY)

// output file -> [profile type, system profile name, overrides]
// filament-<MATERIAL>.json are per-material templates; the slicer writes one copy per CFS slot with the colour set.
const TARGETS: Record<string, [string, string, Record<string, unknown>]> = {
  // Shipped as 28, CLI rejects: "retraction_distances_when_cut: 28 not in range [10,18]".
  machine: ["machine", "Creality SPARKX i7 0.4 nozzle", { retraction_distances_when_cut: "18" }],
  // Multicolour: purge part of each colour change into the (hidden) sparse infill instead of only the prime tower.
  process: ["process", "0.20mm Standard @Creality SPARKX i7 0.4 nozzle", { flush_into_infill: "1" }],
  "filament-PLA": ["filament", "Generic PLA @SPARKX i7-all", {}],
  "filament-PETG": ["filament", "Generic PETG @SPARKX i7-all", {}],
  "filament-TPU": ["filament", "Generic TPU @SPARKX i7-all", {}],
}

type Json = Record<string, unknown>
const byName = new Map<string, Json>()
function walk(dir: string) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p)
    else if (f.endsWith(".json")) {
      try {
        const j = JSON.parse(readFileSync(p, "utf8")) as Json
        if (typeof j.name === "string" && j.type && !byName.has(`${j.type}:${j.name}`)) byName.set(`${j.type}:${j.name}`, j)
      } catch {
        /* ignore */
      }
    }
  }
}
// Vendor dir first so its definitions win over the generic library.
walk(join(PROFILES, "Creality"))
walk(join(PROFILES, "OrcaFilamentLibrary"))

function flatten(type: string, name: string): Json {
  const j = byName.get(`${type}:${name}`)
  if (!j) throw new Error(`profile not found: ${type}:${name}`)
  const parent = typeof j.inherits === "string" && j.inherits ? flatten(type, j.inherits) : {}
  return { ...parent, ...j }
}

mkdirSync(OUT, { recursive: true })
for (const [file, [type, name, overrides]] of Object.entries(TARGETS)) {
  const flat = flatten(type, name)
  delete flat.inherits
  // Keep "from":"system" and the original name/compatible_printers: the CLI's process<->printer
  // compatibility check matches compatible_printers against the printer's name only for system presets
  // (with "from":"user" it compares against the empty "inherits" and fails: "process not compatible").
  Object.assign(flat, overrides)
  writeFileSync(join(OUT, `${file}.json`), JSON.stringify(flat, null, 2) + "\n")
  console.log(`${file}: ${name} -> ${Object.keys(flat).length} keys`)
}
