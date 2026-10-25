import { homedir } from "node:os"
import { join } from "node:path"
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, statSync } from "node:fs"
import type { Machine, Settings } from "../shared/types"

/**
 * The data folder (projects, settings, secrets). PRINTSTUDIO_HOME overrides it. Otherwise an install from before the
 * Crease rename keeps ~/PrintStudio (Claude session resume is keyed by project paths, so moving the folder would
 * break chat resume); a new install gets ~/Crease. Nothing is ever moved or copied.
 */
export function chooseStudioHome(env: { PRINTSTUDIO_HOME?: string }, home: string, exists: (p: string) => boolean = existsSync): string {
  if (env.PRINTSTUDIO_HOME) return env.PRINTSTUDIO_HOME
  const legacy = join(home, "PrintStudio")
  return exists(legacy) ? legacy : join(home, "Crease")
}

export const STUDIO_HOME = chooseStudioHome(process.env, homedir())
export const PROJECTS_DIR = join(STUDIO_HOME, "projects")
export const PRINTERS_DIR = join(STUDIO_HOME, "printers")
export const SKILLS_DIR = join(STUDIO_HOME, "skills")
export const SETTINGS_FILE = join(STUDIO_HOME, "settings.json")
export const MACHINES_FILE = join(STUDIO_HOME, "machines.json")

for (const d of [STUDIO_HOME, PROJECTS_DIR, PRINTERS_DIR, SKILLS_DIR]) mkdirSync(d, { recursive: true })

const DEFAULTS: Settings = {
  // Empty = automatic: found in /Applications, ~/Applications, Homebrew or PATH (server/tools/discovery.ts).
  openscadPath: "",
  orcaSlicerPath: "",
  // Optional (sculpted parts). Empty = automatic, like OpenSCAD.
  blenderPath: "",
  // Empty = automatic: the user's Claude Code on PATH, ~/.local/bin, ~/.claude/local or Homebrew (discovery.ts).
  claudePath: "",
  // Dev default points at the mock Moonraker (npm run mock:printer).
  printer: {
    host: "127.0.0.1",
    port: 7125,
    // A guess until confirmed (by the user in Settings or via the agent's intake question).
    filaments: [
      { slot: 1, colorName: "White", colorHex: "#f5f5f5", material: "PLA", loaded: true },
      { slot: 2, colorName: "Black", colorHex: "#1a1a1a", material: "PLA", loaded: true },
      { slot: 3, colorName: "Red", colorHex: "#d32f2f", material: "PLA", loaded: true },
      { slot: 4, colorName: "Blue", colorHex: "#1e5bd8", material: "PLA", loaded: true },
    ],
    filamentsConfirmed: false,
  },
  model: "opus",
  // Hardware links in assembly guides: US, Amazon first, then cheaper / more exact alternatives.
  sourcing: { country: "US", stores: ["amazon-us", "aliexpress", "boltdepot", "mcmaster"] },
}

/**
 * Never part of Settings: secrets live in server/secrets.ts; `auth` is computed per request. `uiMode` is retired (U2:
 * no Beginner/Maker modes): an old settings.json value is ignored on read and dropped on the next save, and an old
 * client's PUT of it is ignored.
 */
const NOT_SETTINGS = ["anthropicApiKey", "auth", "uiMode"] as const

function stripNonSettings<T extends object>(o: T): T {
  const out = { ...o } as Record<string, unknown>
  for (const k of NOT_SETTINGS) delete out[k]
  return out as T
}

function rawSettings(): Settings {
  if (!existsSync(SETTINGS_FILE)) return structuredClone(DEFAULTS)
  // A not-yet-migrated legacy anthropicApiKey stays in the file (secrets.ts moves it) but never leaves this function.
  const saved = stripNonSettings(JSON.parse(readFileSync(SETTINGS_FILE, "utf8")))
  return {
    ...DEFAULTS,
    ...saved,
    model: saved.model ?? DEFAULTS.model,
    printer: { ...DEFAULTS.printer, ...saved.printer },
    sourcing: { ...DEFAULTS.sourcing!, ...saved.sourcing },
  }
}

/**
 * Settings. `printer` is a legacy view of the default Machine (machines.json is the source of truth);
 * saving `printer` writes through to the default Machine.
 */
export function getSettings(): Settings {
  const s = rawSettings()
  const m = defaultOf(readMachinesFile())
  if (m) {
    s.printer = {
      ...s.printer,
      ...(m.connection.type === "moonraker" ? { host: m.connection.host, port: m.connection.port } : {}),
      filaments: m.filaments,
      filamentsConfirmed: m.filamentsConfirmed,
    }
  }
  return s
}

export function saveSettings(patch: Partial<Settings>): Settings {
  if (patch.printer) {
    const list = readMachinesFile()
    const m = defaultOf(list)
    if (m) {
      const p = patch.printer
      // "practice" is not an address: the practice printer is its own machine (POST /api/machines {isPractice}).
      if ((p.host !== undefined || p.port !== undefined) && p.host !== "practice" && !m.isPractice) {
        const cur = m.connection.type === "moonraker" ? m.connection : { host: "", port: 7125 }
        m.connection = { type: "moonraker", host: p.host ?? cur.host, port: Number(p.port ?? cur.port) || 7125 }
      }
      if (p.filaments) m.filaments = p.filaments
      if (p.filamentsConfirmed !== undefined) m.filamentsConfirmed = !!p.filamentsConfirmed
      writeMachinesFile(list)
    }
  }
  let onDisk: Record<string, unknown> = {}
  try {
    if (existsSync(SETTINGS_FILE)) onDisk = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"))
  } catch {
    /* rewrite */
  }
  // Keep a not-yet-migrated legacy key where it is (the secret store migration owns it); never write a new one.
  const legacy = "anthropicApiKey" in onDisk ? { anthropicApiKey: onDisk.anthropicApiKey } : {}
  const next = { ...rawSettings(), ...stripNonSettings(patch), ...legacy }
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2))
  return getSettings()
}

export const DEFAULT_PRINTER_PROFILE = {
  id: "sparkx-i7",
  name: "Creality SPARKX i7",
  buildVolumeMm: [260, 260, 255] as [number, number, number],
  nozzleMm: 0.4,
  maxNozzleC: 300,
  filamentSlots: 4,
  tolerances: { slidingFitMm: null, pressFitMm: null, holeCompensationMm: null } as {
    slidingFitMm: number | null
    pressFitMm: number | null
    holeCompensationMm: number | null
  },
  connection: { type: "moonraker", host: null as string | null, port: 7125 },
}
export type PrinterProfile = typeof DEFAULT_PRINTER_PROFILE

/** Legacy printer-profile shape of a Machine (by id, else the default). Prefer getMachine() in new code. */
export function getPrinterProfile(id?: string): PrinterProfile {
  const list = readMachinesFile()
  const m = (id && list.find((x) => x.id === id)) || defaultOf(list)
  if (!m) return structuredClone(DEFAULT_PRINTER_PROFILE)
  return {
    id: m.id,
    name: m.model,
    buildVolumeMm: m.buildVolumeMm,
    nozzleMm: m.nozzleMm,
    maxNozzleC: m.maxNozzleC,
    filamentSlots: m.filamentSlots,
    tolerances: m.tolerances,
    connection: { type: "moonraker", host: m.connection.type === "moonraker" ? m.connection.host : null, port: m.connection.type === "moonraker" ? m.connection.port : 7125 },
  }
}

// ---------------------------------------------------------------------------------------------
// machines.json (storage only; the API is in server/machines.ts)
// ---------------------------------------------------------------------------------------------

let machinesCache: { mtimeMs: number; list: Machine[] } | null = null

// Same rule as machines.ts getDefaultMachine: the marked default, else the practice printer (undefined: unsaved).
function defaultOf(list: Machine[]): Machine | undefined {
  return list.find((m) => m.isDefault && m.enabled) ?? list.find((m) => m.isDefault) ?? list.find((m) => m.isPractice)
}

/**
 * One-time migration: the single printer from settings.json + printers/<id>.json becomes the first Machine.
 * Only an install from before machines.json had a printer the user set up (a legacy printer file, a real address,
 * confirmed filaments, or finished setup). A fresh install starts with no printers: zero is a valid state, and the
 * practice printer is what a print uses until a real one is added (machines.ts getDefaultMachine).
 */
function migrateMachines(): Machine[] {
  const legacyFile = join(PRINTERS_DIR, `${DEFAULT_PRINTER_PROFILE.id}.json`)
  let saved: Partial<Settings> = {}
  try {
    if (existsSync(SETTINGS_FILE)) saved = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"))
  } catch {
    /* unreadable: treat as fresh */
  }
  const host = saved.printer?.host?.trim() ?? ""
  const legacy = existsSync(legacyFile) || !!saved.onboardedAt || !!saved.printer?.filamentsConfirmed || (!!host && !["127.0.0.1", "localhost"].includes(host))
  if (!legacy) return []
  const s = rawSettings()
  let prof: Partial<PrinterProfile> & { machineName?: string } = {}
  try {
    if (existsSync(legacyFile)) prof = JSON.parse(readFileSync(legacyFile, "utf8"))
  } catch {
    /* defaults */
  }
  const base = { ...DEFAULT_PRINTER_PROFILE, ...prof }
  const m: Machine = {
    id: base.id ?? DEFAULT_PRINTER_PROFILE.id,
    name: prof.machineName?.trim() || base.name,
    model: base.name,
    slicerProfile: "sparkx-i7",
    buildVolumeMm: base.buildVolumeMm,
    nozzleMm: base.nozzleMm,
    maxNozzleC: base.maxNozzleC,
    filamentSlots: base.filamentSlots,
    filaments: s.printer.filaments ?? DEFAULTS.printer.filaments ?? [],
    filamentsConfirmed: !!s.printer.filamentsConfirmed,
    tolerances: { ...DEFAULT_PRINTER_PROFILE.tolerances, ...prof.tolerances },
    connection: { type: "moonraker", host: s.printer.host, port: s.printer.port },
    enabled: true,
    isDefault: true,
  }
  return [m]
}

export function readMachinesFile(): Machine[] {
  if (!existsSync(MACHINES_FILE)) {
    writeMachinesFile(migrateMachines())
  }
  const mtimeMs = statSync(MACHINES_FILE).mtimeMs
  if (machinesCache && machinesCache.mtimeMs === mtimeMs) return structuredClone(machinesCache.list)
  let list: Machine[]
  try {
    const j = JSON.parse(readFileSync(MACHINES_FILE, "utf8"))
    list = Array.isArray(j) ? j : Array.isArray(j?.machines) ? j.machines : []
  } catch {
    list = []
  }
  machinesCache = { mtimeMs, list }
  return structuredClone(list)
}

export function writeMachinesFile(list: Machine[]) {
  const tmp = MACHINES_FILE + ".tmp"
  // apiKeyStatus is derived (server/machines.ts adds it from the secret store); never persist it.
  const clean = list.map((m) => {
    if (m.connection?.type !== "moonraker" || !("apiKeyStatus" in m.connection)) return m
    const connection = { ...m.connection }
    delete connection.apiKeyStatus
    return { ...m, connection }
  })
  writeFileSync(tmp, JSON.stringify({ version: 1, machines: clean }, null, 2) + "\n")
  renameSync(tmp, MACHINES_FILE)
  machinesCache = null
}
