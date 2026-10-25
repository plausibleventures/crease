// Slicer profiles per Machine. Machine.slicerProfile is one of:
//   "<key>"                    bundled, flattened profiles in resources/slicer-profiles/<key>/ (e.g. "sparkx-i7")
//   "orca:<Vendor>/<preset>"   an OrcaSlicer bundled machine preset, flattened on first use into
//                              <STUDIO_HOME>/slicer-profiles/<slug>/
//   "generic"                  OrcaSlicer's "MyKlipper" preset resized to the Machine's bed/nozzle (with a warning)
// Each profile folder holds machine.json, process.json and filament-<MATERIAL>.json (PLA always; PETG/TPU if found).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Machine, MachineModel } from "../../shared/types"
import { STUDIO_HOME } from "../config"
import { orcaSlicerTool } from "../tools/index"

export const BUNDLED_PROFILES_DIR =
  process.env.PRINTSTUDIO_SLICER_PROFILES ?? join(dirname(fileURLToPath(import.meta.url)), "../../resources/slicer-profiles")
const CACHE_DIR = join(STUDIO_HOME, "slicer-profiles")

type Json = Record<string, unknown>

/** OrcaSlicer's bundled profiles folder, derived from the configured OrcaSlicer binary. */
export function orcaProfilesDir(): string | null {
  const bin = orcaSlicerTool()?.path
  if (!bin) return null
  const d = dirname(bin)
  for (const c of [join(d, "../Resources/profiles"), join(d, "resources/profiles"), join(d, "../share/OrcaSlicer/profiles")]) {
    if (existsSync(c)) return c
  }
  return null
}

// ---------- index of OrcaSlicer presets (per vendor, lazily) ----------

const vendorIndex = new Map<string, Map<string, Json>>() // vendor -> "type:name" -> json

function indexVendor(root: string, vendor: string): Map<string, Json> {
  const hit = vendorIndex.get(vendor)
  if (hit) return hit
  const map = new Map<string, Json>()
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const f of readdirSync(dir)) {
      const p = join(dir, f)
      if (statSync(p).isDirectory()) walk(p)
      else if (f.endsWith(".json")) {
        try {
          const j = JSON.parse(readFileSync(p, "utf8")) as Json
          if (typeof j.name === "string" && j.type) map.set(`${j.type}:${j.name}`, j)
        } catch {
          /* skip */
        }
      }
    }
  }
  walk(join(root, vendor))
  vendorIndex.set(vendor, map)
  return map
}

function flatten(root: string, vendor: string, type: string, name: string): Json {
  const own = indexVendor(root, vendor).get(`${type}:${name}`)
  // Filaments often inherit from the shared library.
  const j = own ?? (type === "filament" ? indexVendor(root, "OrcaFilamentLibrary").get(`${type}:${name}`) : undefined)
  if (!j) throw new Error(`OrcaSlicer profile not found: ${vendor} ${type} "${name}"`)
  const parent = typeof j.inherits === "string" && j.inherits ? flatten(root, vendor, type, j.inherits) : {}
  return { ...parent, ...j }
}

// ---------- model catalogue ----------

let catalogue: MachineModel[] | null = null

const first = (v: unknown) => (Array.isArray(v) ? v[0] : v)

function bedFromArea(area: unknown, height: unknown): [number, number, number] | null {
  const pts = (Array.isArray(area) ? area : typeof area === "string" ? area.split(",") : []).map((p: string) => p.split("x").map(Number))
  if (pts.length < 3 || pts.some((p) => p.length !== 2 || p.some((n) => !Number.isFinite(n)))) return null
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const h = Number(first(height))
  return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), Number.isFinite(h) ? h : 0]
}

/** Every printer model OrcaSlicer ships a profile for (vendor, model, bed, nozzles). Cached. */
export function listMachineModels(): MachineModel[] {
  if (catalogue) return catalogue
  const root = orcaProfilesDir()
  if (!root) return []
  const out: MachineModel[] = []
  for (const vendor of readdirSync(root)) {
    const mdir = join(root, vendor, "machine")
    if (!existsSync(mdir) || vendor === "OrcaFilamentLibrary") continue
    const presets: Json[] = []
    const models: Json[] = []
    for (const f of readdirSync(mdir)) {
      if (!f.endsWith(".json")) continue
      try {
        const j = JSON.parse(readFileSync(join(mdir, f), "utf8")) as Json
        if (j.type === "machine_model") models.push(j)
        else if (j.type === "machine" && String(j.instantiation) === "true") presets.push(j)
      } catch {
        /* skip */
      }
    }
    for (const m of models) {
      const name = String(m.name)
      const mine = presets.filter((p) => p.printer_model === name)
      if (!mine.length) continue
      const nozzles = [...new Set(mine.map((p) => Number(first(p.nozzle_diameter) ?? p.printer_variant)).filter((n) => n > 0))].sort()
      const pick = mine.find((p) => /\b0\.4\b/.test(String(p.name))) ?? mine[0]
      let bed: [number, number, number] | null = null
      let klipper = false
      try {
        const flat = flatten(root, vendor, "machine", String(pick.name))
        bed = bedFromArea(flat.printable_area, flat.printable_height)
        klipper = String(flat.gcode_flavor) === "klipper"
      } catch {
        /* incomplete preset */
      }
      out.push({ vendor, model: name, preset: String(pick.name), slicerProfile: canonicalProfile(`orca:${vendor}/${pick.name}`), buildVolumeMm: bed, nozzleMm: nozzles, klipper })
    }
  }
  catalogue = out.sort((a, b) => a.vendor.localeCompare(b.vendor) || a.model.localeCompare(b.model))
  return catalogue
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()

export function searchMachineModels(q: string, limit = 50): MachineModel[] {
  const all = listMachineModels()
  const words = norm(q).split(" ").filter(Boolean)
  if (!words.length) return all.slice(0, limit)
  return all
    .filter((m) => {
      const hay = norm(`${m.vendor} ${m.model}`)
      return words.every((w) => hay.includes(w))
    })
    .slice(0, limit)
}

/** Best slicerProfile key for a model name: ours for the SPARKX i7, else the matching OrcaSlicer preset, else "generic". */
export function resolveSlicerProfile(model: string, nozzleMm = 0.4): string {
  if (/spark\s*x.*i7/i.test(model)) return "sparkx-i7"
  const n = norm(model)
  const all = listMachineModels()
  const hit = all.find((m) => norm(m.model) === n) ?? all.find((m) => norm(`${m.vendor} ${m.model}`) === n) ?? null
  const fuzzy =
    hit ??
    all
      .map((m) => ({ m, score: n.split(" ").filter((w) => norm(m.model).split(" ").includes(w)).length / Math.max(1, norm(m.model).split(" ").length) }))
      .filter((x) => x.score >= 0.99)
      .sort((a, b) => b.score - a.score)[0]?.m
  if (!fuzzy) return "generic"
  // Prefer the preset for this nozzle size.
  const root = orcaProfilesDir()
  if (root && nozzleMm !== 0.4) {
    const alt = [...indexVendor(root, fuzzy.vendor).values()].find(
      (j) => j.type === "machine" && j.printer_model === fuzzy.model && new RegExp(`\\b${nozzleMm}\\b`).test(String(j.name)),
    )
    if (alt) return `orca:${fuzzy.vendor}/${alt.name}`
  }
  return fuzzy.slicerProfile
}

// OrcaSlicer presets we ship hand-tuned, flattened copies of (resources/slicer-profiles/<key>/). A machine picked
// from the model list gets the "orca:" key; route it to the tuned copy so its fixes apply.
const CURATED: Record<string, string> = {
  "orca:Creality/Creality SPARKX i7 0.4 nozzle": "sparkx-i7",
}
export function canonicalProfile(key: string): string {
  return CURATED[key] ?? key
}

// Values in stock presets the CLI rejects ("<key>: <v> not in range [lo,hi]"); clamped when we flatten a preset.
const CLI_RANGES: Record<string, [number, number]> = {
  retraction_distances_when_cut: [10, 18],
}
function clampCliRanges(j: Json): Json {
  const out: Json = { ...j }
  for (const [k, [lo, hi]] of Object.entries(CLI_RANGES)) {
    const clamp = (v: unknown) => {
      const n = Number(v)
      return Number.isFinite(n) ? String(Math.min(hi, Math.max(lo, n))) : v
    }
    if (Array.isArray(out[k])) out[k] = (out[k] as unknown[]).map(clamp)
    else if (out[k] !== undefined) out[k] = clamp(out[k])
  }
  return out
}

// ---------- materialising a profile folder ----------

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80)

function writeProfile(root: string, vendor: string, machinePreset: string, outDir: string, machineOverrides: Json = {}) {
  const machine = flatten(root, vendor, "machine", machinePreset)
  const idx = indexVendor(root, vendor)
  const compatible = (j: Json) => Array.isArray(j.compatible_printers) && (j.compatible_printers as string[]).includes(machinePreset)
  const processName =
    (typeof machine.default_print_profile === "string" && machine.default_print_profile) ||
    [...idx.values()].find((j) => j.type === "process" && String(j.instantiation) === "true" && compatible(j) && /0\.2\d?mm/.test(String(j.name)))?.name ||
    [...idx.values()].find((j) => j.type === "process" && String(j.instantiation) === "true" && compatible(j))?.name
  if (!processName) throw new Error(`no OrcaSlicer process profile for ${machinePreset}`)
  const process = flatten(root, vendor, "process", String(processName))
  const filaments: Record<string, Json> = {}
  const defaults = (Array.isArray(machine.default_filament_profile) ? machine.default_filament_profile : [machine.default_filament_profile]).filter(Boolean) as string[]
  for (const mat of ["PLA", "PETG", "TPU"]) {
    const cand =
      defaults.find((n) => new RegExp(`\\b${mat}\\b`, "i").test(n)) ??
      [...idx.values()].find((j) => j.type === "filament" && String(j.instantiation) === "true" && compatible(j) && new RegExp(`^Generic ${mat}\\b`, "i").test(String(j.name)))?.name ??
      (mat === "PLA" ? (defaults[0] ?? "Generic PLA") : undefined)
    if (!cand) continue
    try {
      filaments[mat] = flatten(root, vendor, "filament", String(cand))
    } catch {
      if (mat === "PLA") filaments[mat] = flatten(root, "OrcaFilamentLibrary", "filament", "Generic PLA @System")
    }
  }
  mkdirSync(outDir, { recursive: true })
  const write = (file: string, j: Json, extra: Json = {}) => {
    const flat = clampCliRanges({ ...j, ...extra })
    delete flat.inherits
    // Keep "from":"system" + original names: the CLI's compatibility check needs them.
    writeFileSync(join(outDir, file), JSON.stringify(flat, null, 2) + "\n")
  }
  write("machine.json", machine, machineOverrides)
  write("process.json", process)
  for (const [mat, j] of Object.entries(filaments)) write(`filament-${mat}.json`, j)
}

/**
 * Profile folder for a machine (created on first use for OrcaSlicer presets / generic). `warning` is set when
 * the profile is only an approximation of the printer.
 */
export function ensureProfileDir(machine: Machine): { dir: string; warning?: string } {
  const key = canonicalProfile(machine.slicerProfile || "generic")
  if (!key.startsWith("orca:") && key !== "generic") {
    const d = join(BUNDLED_PROFILES_DIR, key)
    if (existsSync(join(d, "machine.json"))) return { dir: d }
    const c = join(CACHE_DIR, key)
    if (existsSync(join(c, "machine.json"))) return { dir: c }
  }
  const root = orcaProfilesDir()
  if (!root) throw new Error("OrcaSlicer's profiles folder wasn't found next to the OrcaSlicer app (see Settings).")
  if (key.startsWith("orca:")) {
    const [vendor, ...rest] = key.slice(5).split("/")
    const preset = rest.join("/")
    const dir = join(CACHE_DIR, slug(`${vendor}-${preset}`))
    if (!existsSync(join(dir, "machine.json"))) writeProfile(root, vendor, preset, dir)
    return { dir }
  }
  // Generic Klipper printer resized to this machine.
  const [x, y, z] = machine.buildVolumeMm
  const nozzle = machine.nozzleMm || 0.4
  const preset = [0.2, 0.4, 0.6, 0.8].includes(nozzle) ? `MyKlipper ${nozzle} nozzle` : "MyKlipper 0.4 nozzle"
  const dir = join(CACHE_DIR, slug(`generic-${x}x${y}x${z}-${nozzle}`))
  if (!existsSync(join(dir, "machine.json"))) {
    writeProfile(root, "Custom", preset, dir, {
      printable_area: [`0x0`, `${x}x0`, `${x}x${y}`, `0x${y}`],
      printable_height: String(z),
      nozzle_diameter: [String(nozzle)],
    })
  }
  return {
    dir,
    warning: `No OrcaSlicer profile matches "${machine.model}"; using a generic Klipper profile sized ${x}×${y}×${z} mm (${nozzle} mm nozzle). Its start G-code calls PRINT_START: check it suits this printer.`,
  }
}
