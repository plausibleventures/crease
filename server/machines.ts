// Machines: the user's printers (a printer farm is just several). Stored in <STUDIO_HOME>/machines.json
// (see config.ts: storage + one-time migration from Settings.printer). Callers use these functions, not
// Settings.printer.
import type { FilamentSlot, Machine } from "../shared/types"
import { join } from "node:path"
import { PRINTERS_DIR, readMachinesFile, writeMachinesFile } from "./config"
import { listMachineModels, resolveSlicerProfile } from "./slicer/profiles"
import { deleteSecret, machineSecretRef, secretStatus, setSecret } from "./secrets"
import { normCameraIce } from "../shared/camera-ice"

const httpError = (statusCode: number, msg: string) => Object.assign(new Error(msg), { statusCode })

/** Creality SPARKX i7 defaults for a new machine of that model. */
const SPARKX_I7: Omit<Machine, "id" | "name" | "connection" | "enabled" | "isDefault"> = {
  model: "Creality SPARKX i7",
  slicerProfile: "sparkx-i7",
  buildVolumeMm: [260, 260, 255],
  nozzleMm: 0.4,
  maxNozzleC: 300,
  filamentSlots: 4,
  filaments: [],
  filamentsConfirmed: false,
  tolerances: { slidingFitMm: null, pressFitMm: null, holeCompensationMm: null },
}

const PRACTICE_ID = "practice-printer"
const PRACTICE_NOTES = "Simulated printer built into Crease: heats, prints and finishes like a real one, but nothing moves."

/**
 * With no printers at all (a fresh install), slicing and printing use the practice printer. It is not saved: the
 * Machines list stays empty until the user adds a printer (or picks the practice printer, which saves this one).
 */
function unsavedPracticeMachine(): Machine {
  return {
    ...structuredClone(SPARKX_I7),
    id: PRACTICE_ID,
    name: "Practice printer",
    filaments: structuredClone(DEFAULT_FILAMENTS),
    connection: { type: "moonraker", host: "practice", port: 0 },
    enabled: true,
    isDefault: true,
    isPractice: true,
    notes: PRACTICE_NOTES,
  }
}

/** As callers and the API see a machine: no API key value, only its masked status (the key is in the secret store). */
function withKeyStatus(m: Machine): Machine {
  if (m.connection?.type !== "moonraker") return m
  const connection = { ...m.connection }
  delete connection.apiKey
  return { ...m, connection: { ...connection, apiKeyStatus: secretStatus(machineSecretRef(m.id)) } }
}

/** Apply a write-only `connection.apiKey` from a POST/PUT body: string = store, null/"" = remove, absent = keep. */
function applyApiKey(id: string, conn: Partial<Machine>["connection"] | undefined) {
  if (!conn || conn.type !== "moonraker" || !("apiKey" in conn) || conn.apiKey === undefined) return
  if (typeof conn.apiKey === "string" && conn.apiKey.trim()) setSecret(machineSecretRef(id), conn.apiKey)
  else deleteSecret(machineSecretRef(id))
}

export function getMachines(): Machine[] {
  return readMachinesFile().map(withKeyStatus)
}

/**
 * The printer new projects use: the one marked default. The first printer saved becomes the default; adding another
 * never does by itself (UX round 2: the app asks). With none saved, the unsaved practice printer stands in.
 */
export function getDefaultMachine(): Machine {
  const all = getMachines()
  return all.find((m) => m.isDefault && m.enabled) ?? all.find((m) => m.isDefault) ?? all.find((m) => m.isPractice) ?? unsavedPracticeMachine()
}

/** The machine with this id, or the default when id is missing/unknown. The practice printer is known unsaved too. */
export function getMachine(id?: string | null): Machine {
  if (!id) return getDefaultMachine()
  const all = getMachines()
  return all.find((m) => m.id === id) ?? (id === PRACTICE_ID ? (all.find((m) => m.isPractice) ?? unsavedPracticeMachine()) : getDefaultMachine())
}

/** Like getMachine but 404s on an unknown id (for routes). */
export function requireMachine(id: string): Machine {
  const m = getMachines().find((x) => x.id === id)
  if (!m) throw httpError(404, `machine not found: ${id}`)
  return m
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "printer"

const RESERVED = new Set(["models", "tolerances", "test", "status"]) // fixed /api/machines/<word> routes

function uniqueId(base: string, list: Machine[]) {
  let id = slug(base)
  for (let i = 2; list.some((m) => m.id === id) || RESERVED.has(id); i++) id = `${slug(base)}-${i}`
  return id
}

const DEFAULT_FILAMENTS: FilamentSlot[] = [
  { slot: 1, colorName: "White", colorHex: "#f5f5f5", material: "PLA", loaded: true },
  { slot: 2, colorName: "Black", colorHex: "#1a1a1a", material: "PLA", loaded: true },
  { slot: 3, colorName: "Red", colorHex: "#d32f2f", material: "PLA", loaded: true },
  { slot: 4, colorName: "Blue", colorHex: "#1e5bd8", material: "PLA", loaded: true },
]

function sanitize(m: Machine): Machine {
  const slots = Math.max(1, Math.min(16, Math.round(m.filamentSlots || 1)))
  const vol = (m.buildVolumeMm ?? [220, 220, 250]).map((v) => Math.max(10, Math.min(2000, Number(v) || 0))) as [number, number, number]
  return {
    ...m,
    name: (m.name || m.model || "Printer").trim().slice(0, 60),
    model: (m.model || "Generic printer").trim().slice(0, 80),
    buildVolumeMm: vol,
    nozzleMm: Number(m.nozzleMm) > 0 ? Number(m.nozzleMm) : 0.4,
    maxNozzleC: Number(m.maxNozzleC) > 0 ? Number(m.maxNozzleC) : 260,
    filamentSlots: slots,
    filaments: (m.filaments ?? []).filter((f) => f.slot >= 1 && f.slot <= slots),
    tolerances: m.tolerances ?? { slidingFitMm: null, pressFitMm: null, holeCompensationMm: null },
    connection:
      m.connection?.type === "moonraker"
        ? {
            type: "moonraker",
            host: String(m.connection.host ?? "").trim(),
            port: Number(m.connection.port) || 7125,
            // no apiKey: it lives in the secret store (applyApiKey)
            ...(m.connection.crealityWsPort != null ? { crealityWsPort: Number(m.connection.crealityWsPort) || 0 } : {}),
            ...(m.connection.crealityStart ? { crealityStart: true } : {}),
            ...(normCameraIce(m.connection.cameraIce) ? { cameraIce: normCameraIce(m.connection.cameraIce)! } : {}),
          }
        : { type: "none" },
    enabled: m.enabled !== false,
  }
}

/** Add a machine. Missing fields get defaults; the slicer profile is picked from the model name. */
export function createMachine(input: Partial<Machine>): Machine {
  const list = getMachines()
  const model = input.model?.trim() || input.name?.trim() || "Generic printer"
  const isI7 = /spark\s*x.*i7/i.test(model)
  const base: Machine = {
    ...(isI7 ? SPARKX_I7 : {}),
    id: "",
    name: input.name?.trim() || model,
    model,
    slicerProfile: "",
    buildVolumeMm: isI7 ? [260, 260, 255] : [220, 220, 250],
    nozzleMm: 0.4,
    maxNozzleC: isI7 ? 300 : 260,
    filamentSlots: isI7 ? 4 : 1,
    filaments: isI7 ? DEFAULT_FILAMENTS : DEFAULT_FILAMENTS.slice(0, 1),
    filamentsConfirmed: false,
    tolerances: { slidingFitMm: null, pressFitMm: null, holeCompensationMm: null },
    connection: { type: "none" },
    enabled: true,
    isDefault: false,
    ...input,
  } as Machine
  base.id = uniqueId(input.id || base.name, list)
  base.slicerProfile = input.slicerProfile || resolveSlicerProfile(base.model, base.nozzleMm)
  // Bed size from OrcaSlicer's profile for this model when the form didn't give one.
  if (!input.buildVolumeMm && base.slicerProfile.startsWith("orca:")) {
    const hit = listMachineModels().find((m) => base.slicerProfile.endsWith(`/${m.preset}`) || m.slicerProfile === base.slicerProfile)
    if (hit?.buildVolumeMm) base.buildVolumeMm = hit.buildVolumeMm
  }
  // The first printer saved is the default (until then the unsaved practice printer stands in, so nothing changes
  // silently). After that, only when asked: the app asks after adding (UX round 2).
  base.isDefault = !!input.isDefault || !list.some((x) => x.isDefault)
  const m = sanitize(base)
  applyApiKey(m.id, input.connection) // before the machine exists, so a failed key write leaves nothing half-made
  const next = m.isDefault ? list.map((x) => ({ ...x, isDefault: false })) : list
  writeMachinesFile([...next, m])
  return withKeyStatus(m)
}

export function updateMachine(id: string, patch: Partial<Machine>): Machine {
  const list = getMachines()
  const i = list.findIndex((m) => m.id === id)
  if (i < 0) throw httpError(404, `machine not found: ${id}`)
  const cur = list[i]
  // isPractice is fixed at creation (ensurePracticeMachine); a patch can't turn a real machine into the practice one.
  const merged: Machine = { ...cur, ...patch, id: cur.id, isPractice: cur.isPractice, tolerances: { ...cur.tolerances, ...patch.tolerances } }
  if (!cur.isPractice && merged.connection.type === "moonraker" && merged.connection.host === "practice") merged.connection = cur.connection
  if ((patch.model && patch.model !== cur.model) || (patch.nozzleMm && patch.nozzleMm !== cur.nozzleMm)) {
    if (!patch.slicerProfile) merged.slicerProfile = resolveSlicerProfile(merged.model, merged.nozzleMm)
  }
  // Pointing the practice machine at a real address turns it into a normal machine.
  if (cur.isPractice && patch.connection && !(patch.connection.type === "moonraker" && patch.connection.host === "practice")) merged.isPractice = false
  applyApiKey(cur.id, patch.connection)
  list[i] = sanitize(merged)
  if (patch.isDefault) list.forEach((m, j) => (m.isDefault = j === i))
  writeMachinesFile(list)
  return withKeyStatus(list[i])
}

export function deleteMachine(id: string) {
  const list = getMachines()
  const m = list.find((x) => x.id === id)
  if (!m) throw httpError(404, `machine not found: ${id}`)
  const rest = list.filter((x) => x.id !== id)
  // the next default: an enabled real printer, else the practice printer, else anything left
  if (m.isDefault && rest.length) (rest.find((x) => x.enabled && !x.isPractice) ?? rest.find((x) => x.enabled) ?? rest[0]).isDefault = true
  writeMachinesFile(rest)
  deleteSecret(machineSecretRef(id))
}

export function setDefaultMachine(id: string) {
  requireMachine(id)
  writeMachinesFile(getMachines().map((m) => ({ ...m, isDefault: m.id === id })))
}

/** The built-in simulated printer (created once; reused). */
/**
 * The built-in simulated printer: created once, then reused. Never converts or renames another machine.
 * It becomes the default when asked, or when no other enabled machine is the default.
 */
export function ensurePracticeMachine(opts: { makeDefault?: boolean; fields?: Partial<Machine> } = {}): Machine {
  const all = getMachines()
  const existing = all.find((m) => m.isPractice)
  const otherDefault = all.some((m) => m.isDefault && m.enabled && !m.isPractice)
  const makeDefault = !!opts.makeDefault || !otherDefault
  // What the Add-a-printer form chose (name, loaded filaments, tags…): the machine's own, never another's.
  const f = opts.fields ?? {}
  const fields: Partial<Machine> = Object.fromEntries(
    (["name", "filamentSlots", "filaments", "filamentsConfirmed", "tags", "notes", "enabled"] as const).filter((k) => f[k] !== undefined).map((k) => [k, f[k]]),
  )
  if (fields.filaments) fields.filamentsSource = "user"
  if (existing) {
    if (Object.keys(fields).length) updateMachine(existing.id, fields)
    if (makeDefault && !existing.isDefault) setDefaultMachine(existing.id)
    return getMachine(existing.id)
  }
  return createMachine({
    id: PRACTICE_ID,
    name: "Practice printer",
    model: "Creality SPARKX i7",
    slicerProfile: "sparkx-i7",
    // The host/port are placeholders: the printer client serves practice machines in-process.
    connection: { type: "moonraker", host: "practice", port: 0 },
    isPractice: true,
    isDefault: makeDefault,
    notes: PRACTICE_NOTES,
    ...fields,
  })
}

/** Per-machine lessons the design agent learned from real prints (markdown, one dated line per lesson). */
export function machineLessonsPath(machineId: string): string {
  return join(PRINTERS_DIR, machineId.replace(/[^a-zA-Z0-9_-]/g, "_"), "lessons.md")
}
