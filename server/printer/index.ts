// OWNER: slicer/printer agent. Thin Moonraker client + confirmation flow.
// Every print start goes through createPrintRequest -> user approval (POST /api/print-requests/:id with
// approved && bedClear) -> upload -> start. Nothing else in this module starts a print.
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs"
import { basename, join } from "node:path"
import { randomUUID } from "node:crypto"
import type { FirmwareState, Machine, MachineWithStatus, PrintJob, PrintJobState, PrintRecord, PrintRequest, PrinterStatus, Webcam } from "../../shared/types"
import { getMachine, getMachines, requireMachine, updateMachine } from "../machines"
import { gcodeSlotsUsed, parseBox, slotBlockers } from "./cfs"
import { CrealityStartError, crealityState, pruneCreality, startViaCreality, type CrealitySlot } from "./creality"
import { captureFromApp, detectCamera } from "./camera"
import { derivePhase, firstLayerOffset, jobConsole, newPhaseMemory, type ConsoleLine, type OurJob, type PhaseMemory } from "./phase"
import { ensureProfileDir } from "../slicer/profiles"
import { practicePort } from "./practice"
import { printFileName } from "./filename"
import { emit } from "../events"
import { parsePlateObjects, readGcodeEstimates, slicePart, slicePlate } from "../slicer"
import { loadJob, notePrintFinished, savedOrDefault, readJobBytes, setJobStatus, setOpenRequestProbe, sha256, staleReasons, summaryOf } from "../jobs"
import { getProject, httpError, projectDir, resolveProjectPath } from "../projects/store"
import { partDesignColors } from "../projects/colors"
import { getDb, openPrints, recordPrintFinish, recordPrintStart } from "../db"
import { scopeOfJob } from "../outcomes/calibration"
import { adjustedTimeFor } from "../outcomes/time"
import { getSecret, machineSecretRef } from "../secrets"
import { canRestartFirmware, FIRMWARE_SENTENCE, firmwareState, firstLine, plainMoonrakerError } from "./klippy"

// ---------------------------------------------------------------------------------------------
// Moonraker HTTP (per Machine)
// ---------------------------------------------------------------------------------------------

export class MoonrakerError extends Error {
  constructor(
    message: string,
    public statusCode = 502,
  ) {
    super(message)
  }
}

/** Base URL + display host of a machine's Moonraker. The practice printer is served in-process. */
async function endpoint(m: Machine): Promise<{ url: string; host: string; httpHost: string; port: number }> {
  if (m.isPractice) {
    const port = await practicePort()
    return { url: `http://127.0.0.1:${port}`, host: "practice", httpHost: "127.0.0.1", port }
  }
  if (m.connection.type !== "moonraker" || !m.connection.host) {
    throw new MoonrakerError(`${m.name} has no printer connection (add its address in Machines)`, 409)
  }
  const { host, port } = m.connection
  return { url: `http://${host}:${port}`, host: `${host}:${port}`, httpHost: host, port }
}

/** Call Moonraker and return the unwrapped `result` (or the raw body for endpoints without one). */
async function moonraker<T = unknown>(
  m: Machine,
  path: string,
  init: { method?: "GET" | "POST"; body?: FormData; timeoutMs?: number } = {},
): Promise<T> {
  const { url } = await endpoint(m)
  const headers: Record<string, string> = {}
  // Saved machines: the secret store. An unsaved probe (POST /api/machines/test) carries its key inline, even if null.
  const apiKey = m.connection.type !== "moonraker" ? null : "apiKey" in m.connection ? m.connection.apiKey : getSecret(machineSecretRef(m.id))
  if (apiKey) headers["X-Api-Key"] = apiKey
  let res: Response
  try {
    res = await fetch(url + path, {
      method: init.method ?? "GET",
      body: init.body,
      headers,
      signal: AbortSignal.timeout(init.timeoutMs ?? 4000),
    })
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } }
    throw new MoonrakerError(`${m.name} unreachable at ${url}: ${err.cause?.code ?? err.message}`)
  }
  const text = await res.text()
  let body: { result?: T; error?: { message?: string } | string } | null = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const msg = typeof body?.error === "string" ? body.error : (body?.error?.message ?? (text.slice(0, 2000) || res.statusText))
    // People get a plain sentence; the firmware's first line goes to the log (never raw JSON in the app).
    const plain = plainMoonrakerError(path, res.status, msg)
    console.warn(`[printer] ${m.name}: Moonraker ${plain.logLine}`)
    throw new MoonrakerError(plain.message)
  }
  return (body && "result" in body ? body.result : body) as T
}

interface PrinterInfo {
  state: string // klippy: ready | startup | shutdown | error
  state_message: string
  hostname: string
  software_version: string
  [k: string]: unknown
}

export async function getPrinterInfo(machineId?: string): Promise<PrinterInfo> {
  return moonraker<PrinterInfo>(getMachine(machineId), "/printer/info")
}

/** Read-only connection test (Settings, Machines, onboarding). */
export async function testMachine(m: Machine): Promise<{ ok: boolean; info?: PrinterInfo & { webcams?: unknown[] }; error?: string }> {
  try {
    const info = await moonraker<PrinterInfo>(m, "/printer/info")
    let webcams: unknown[] | undefined
    try {
      webcams = (await moonraker<{ webcams: unknown[] }>(m, "/server/webcams/list")).webcams
    } catch {
      /* optional */
    }
    return { ok: true, info: { ...info, webcams } }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** Connection test of a machine (default machine when omitted). */
export async function testPrinter(machineId?: string) {
  return testMachine(getMachine(machineId))
}

// ---------------------------------------------------------------------------------------------
// Cameras
// ---------------------------------------------------------------------------------------------

interface MoonrakerWebcam {
  name?: string
  service?: string
  enabled?: boolean
  stream_url?: string
  snapshot_url?: string
  rotation?: number
  flip_horizontal?: boolean
  flip_vertical?: boolean
}

export async function listWebcams(machineId?: string): Promise<Webcam[]> {
  const { webcams } = await moonraker<{ webcams: MoonrakerWebcam[] }>(getMachine(machineId), "/server/webcams/list")
  return (webcams ?? []).map((w) => ({
    name: w.name ?? "camera",
    service: w.service ?? null,
    enabled: w.enabled !== false,
    streamUrl: w.stream_url || null,
    snapshotUrl: w.snapshot_url || null,
    rotation: w.rotation ?? 0,
    flipHorizontal: !!w.flip_horizontal,
    flipVertical: !!w.flip_vertical,
  }))
}

/**
 * Candidate absolute URLs for a webcam URL. Moonraker usually reports URLs relative to the web
 * frontend (nginx on :80, or Fluidd :4408 / Mainsail :4409 on Creality), not to Moonraker itself.
 */
function snapshotCandidates(url: string, host: string, port: number, practice: boolean): string[] {
  if (/^https?:\/\//i.test(url)) return [url]
  const path = url.startsWith("/") ? url : `/${url}`
  const ports = practice ? [port] : [...new Set([80, 4408, 4409, port])]
  return ports.map((p) => `http://${host}${p === 80 ? "" : `:${p}`}${path}`)
}
const snapshotBase = new Map<string, string>() // machine+camera key -> working URL

/** Fetch one JPEG/PNG frame from a machine's camera (first enabled webcam, or `name`). */
export async function getSnapshot(
  name?: string,
  machineId?: string,
): Promise<{ data: Buffer; contentType: string; camera: string; url: string; machineId: string }> {
  const m = getMachine(machineId)
  if (m.camera?.type === "creality-webrtc") {
    // WebRTC only: an open app window grabs a frame from its stream.
    const f = await captureFromApp(m.id)
    return { ...f, camera: "creality", url: m.camera.url ?? "", machineId: m.id }
  }
  const cams = (await listWebcams(m.id)).filter((w) => w.enabled && w.snapshotUrl)
  const cam = name ? cams.find((w) => w.name === name) : cams[0]
  if (!cam) throw new MoonrakerError(name ? `no webcam named ${name}` : `${m.name} reports no webcam with a snapshot URL`, 404)
  const ep = await endpoint(m)
  const key = `${m.id}:${ep.host}:${cam.snapshotUrl}`
  const known = snapshotBase.get(key)
  const candidates = known ? [known] : snapshotCandidates(cam.snapshotUrl!, ep.httpHost, ep.port, !!m.isPractice)
  const errors: string[] = []
  for (const url of candidates) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) })
      const type = res.headers.get("content-type") ?? ""
      if (!res.ok || !type.startsWith("image/")) {
        errors.push(`${url}: ${res.status} ${type}`)
        continue
      }
      snapshotBase.set(key, url)
      return { data: Buffer.from(await res.arrayBuffer()), contentType: type.split(";")[0], camera: cam.name, url, machineId: m.id }
    } catch (e) {
      const err = e as Error & { cause?: { code?: string } }
      errors.push(`${url}: ${err.cause?.code ?? err.message}`)
    }
  }
  snapshotBase.delete(key)
  throw new MoonrakerError(`could not fetch snapshot from ${cam.name}: ${errors.join("; ")}`)
}

// ---------------------------------------------------------------------------------------------
// Status polling (one loop over all enabled machines)
// ---------------------------------------------------------------------------------------------

// `box` = Creality CFS (ignored by Moonraker on printers without it).
// idle_timeout + pause_resume: Creality firmware's print_stats doesn't move during a job (see fetchStatus).
// webhooks: Klipper's own state; a shutdown mid-print shows here while /printer/info is cached as ready.
const QUERY = "/printer/objects/query?webhooks&print_stats&extruder&heater_bed&display_status&virtual_sdcard&box&idle_timeout&pause_resume"

/** Map Creality START_PRINT console lines to a plain step (latest match wins). */
const STEPS: [RegExp, string][] = [
  [/BOX_LOAD_MATERIAL(?!_MATERIAL_FLUSH)|load_material|PRINT_PREPARE_LOAD/i, "load"],
  [/MATERIAL_FLUSH|flush_length|flush_temp/i, "Flushing old filament"],
  [/nozzle_clean|NOZ_CLEAR|NOZZLE_CLEAN/i, "Cleaning the nozzle"],
  [/bed_mesh|BED_MESH|prtouch|PRES_|probe/i, "Checking the bed"],
  [/Z-Home|G28|homing|x_park|IF_HOME/i, "Homing"],
  [/print preparing|multicolor_method|START_PRINT/i, "Getting ready"],
]

/** Plain "what's it doing" while preparing: the latest START_PRINT step from the console, plus heating. */
async function preparePhase(m: Machine, st: MachineState, ex: Obj, bed: Obj): Promise<{ phase: string; ended: boolean }> {
  let step: string | null = null
  let ended = false
  try {
    const { gcode_store } = await moonraker<{ gcode_store: ConsoleLine[] }>(m, "/server/gcode_store?count=40")
    // Only this job's lines: never the previous job's "Done printing file" (still there on a warm printer).
    for (const l of jobConsole(gcode_store, st.job?.startedAt ?? null)) {
      if (CANCEL_RE.test(l.message) || DONE_RE.test(l.message)) ended = true
      const hit = STEPS.find(([re]) => re.test(l.message))
      if (hit) step = hit[1] === "load" ? (st.startedSlot ? `Loading ${st.startedSlot.name} · slot ${st.startedSlot.slot}` : "Loading filament") : hit[1]
    }
  } catch {
    /* console not available: temps only */
  }
  const t = (o: Obj) => ({ temp: Math.round(num(o.temperature)), target: Math.round(num(o.target)) })
  const n = t(ex)
  const b = t(bed)
  const heating: string[] = []
  if (n.target > 0 && n.temp < n.target - 3) heating.push(`nozzle ${n.temp}/${n.target} °C`)
  if (b.target > 0 && b.temp < b.target - 2) heating.push(`bed ${b.temp}/${b.target} °C`)
  const heat = heating.length ? `Heating ${heating.join(" · ")}` : ""
  if (step && heat) return { phase: `${step} · ${heating.join(" · ")}`, ended }
  return { phase: step ?? (heat || "Getting ready"), ended }
}

interface MachineState {
  infoCache: { host: string; info: PrinterInfo } | null
  messages: Map<string, string> // print id -> last non-empty print_stats.message seen while it ran
  cameraCheckedAt: number // last camera detection (ms)
  userCancelAt: number | null // when this app last sent a cancel (ms)
  done: { state: "complete" | "cancelled" | "error"; filename: string | null; until: number } | null // last job's end, shown briefly
  leftSeen: { v: number; since: number } // last Creality printLeftTime and since when it hasn't changed
  job: OurJob | null // the job we last started here: "preparing" before the printer shows it / before its first layer
  phase: PhaseMemory // what the phase logic remembers between polls (leftover layer from the last job)
  startedSlot: { slot: number; name: string } | null // first slot that job uses (for "Loading White · slot 1")
  printMessage: string // print_stats.message of the last poll (display_status text like "Heating..." isn't a reason)
  lastJson: string
  firmwareLogged: string // last firmware state message written to the log (once per change)
  status: PrinterStatus | null
  polling: boolean
}
const states = new Map<string, MachineState>()
const stateOf = (id: string) => {
  let s = states.get(id)
  if (!s) states.set(id, (s = { infoCache: null, messages: new Map(), cameraCheckedAt: 0, userCancelAt: null, done: null, leftSeen: { v: 0, since: Date.now() }, job: null, phase: newPhaseMemory(), startedSlot: null, printMessage: "", lastJson: "", firmwareLogged: "", status: null, polling: false }))
  return s
}

function disconnected(machineId: string, host: string | null, message: string | null): PrinterStatus {
  return {
    machineId,
    connected: false,
    host,
    state: "disconnected",
    filename: null,
    progress: 0,
    printDurationS: 0,
    extruder: { temp: 0, target: 0 },
    bed: { temp: 0, target: 0 },
    message,
    isMock: false,
  }
}

type Obj = Record<string, unknown>

/** Klipper isn't ready: state "error" + `firmware`, a plain message; the firmware's first line goes to the log once. */
async function firmwareStatus(m: Machine, st: MachineState, host: string | null, fw: FirmwareState, raw: unknown, isMock: boolean): Promise<PrinterStatus> {
  const line = `${fw}: ${firstLine(raw)}`
  if (line !== st.firmwareLogged) {
    st.firmwareLogged = line
    console.warn(`[printer] ${m.name}: Klipper ${line}`)
  }
  const out: PrinterStatus = { ...disconnected(m.id, host, FIRMWARE_SENTENCE[fw]), connected: true, state: "error", firmware: fw, isMock }
  // Temperatures still read during a shutdown (heaters off, the nozzle cools); not while Klipper starts.
  if (fw !== "startup") {
    try {
      const { status } = await moonraker<{ status: Record<string, Obj> }>(m, "/printer/objects/query?extruder&heater_bed")
      const t = (o: Obj = {}) => ({ temp: Math.round(num(o.temperature) * 10) / 10, target: num(o.target) })
      Object.assign(out, { extruder: t(status.extruder), bed: t(status.heater_bed) })
    } catch {
      /* temps unknown */
    }
  }
  return out
}
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0)

async function fetchStatus(m: Machine): Promise<PrinterStatus> {
  const st = stateOf(m.id)
  let host: string | null = m.connection.type === "moonraker" ? `${m.connection.host}:${m.connection.port}` : null
  try {
    host = (await endpoint(m)).host
    if (!st.infoCache || st.infoCache.host !== host || st.infoCache.info.state !== "ready") {
      st.infoCache = { host, info: await moonraker<PrinterInfo>(m, "/printer/info") }
    }
    const info = st.infoCache.info
    const isMock = !!m.isPractice || /mock/i.test(info.hostname ?? "") || /mock/i.test(info.software_version ?? "")
    const fw = firmwareState(info.state)
    if (fw) return firmwareStatus(m, st, host, fw, info.state_message, isMock)
    const { status } = await moonraker<{ status: Record<string, Obj> }>(m, QUERY)
    const wh = status.webhooks ?? {}
    const whFw = firmwareState(wh.state)
    if (whFw) {
      st.infoCache = null // re-read /printer/info until Klipper is ready again
      return firmwareStatus(m, st, host, whFw, wh.state_message, isMock)
    }
    const ps = status.print_stats ?? {}
    st.printMessage = typeof ps.message === "string" ? ps.message : ""
    const ex = status.extruder ?? {}
    const bed = status.heater_bed ?? {}
    const ds = status.display_status ?? {}
    const sd = status.virtual_sdcard ?? {}
    const it = status.idle_timeout ?? {}
    const pr = status.pause_resume ?? {}
    const cws = crealityState(m) // Creality :9999 push data, if this printer has it
    // Creality firmware (i7 1.1.5.x) never moves print_stats off "standby" (duration 0, layers null) during a job:
    // derive printing / preparing / paused (server/printer/phase.ts, fixtures in fixtures/status/).
    const ph = derivePhase({ now: Date.now(), status: { print_stats: ps, virtual_sdcard: sd, idle_timeout: it, pause_resume: pr }, ws: cws, job: st.job }, st.phase)
    let state = ph.state
    const { active, layer, totalLayers } = ph
    // Our job is over once the printer is idle and the start grace has passed.
    if (!active && state !== "preparing") st.job = null
    // Just finished (Creality never says so in print_stats): show the outcome for a couple of minutes, then idle.
    const recent = st.done && Date.now() < st.done.until ? st.done : null
    if (state === "standby" && recent) state = recent.state
    let phase: string | null = null
    if (state === "preparing") {
      const p = await preparePhase(m, st, ex, bed)
      // Only "preparing" because we just started it, and the console already shows it ended (e.g. the firmware
      // cancelled at 0 s): it's idle.
      if (p.ended && !active) {
        state = "standby"
        st.job = null
      } else phase = p.phase
    }
    const progress = Math.max(
      0,
      Math.min(1, num(ds.progress) || num(sd.progress) || (cws?.printProgress ? num(cws.printProgress) / 100 : 0)),
    )
    // Elapsed: print_stats when it's live, else Creality's job time, else Klipper's idle_timeout printing time.
    const elapsed = num(ps.print_duration) || (active ? num(cws?.printJobTime) || num(it.printing_time) : 0)
    const working = state === "printing" || state === "paused"
    // Creality's printLeftTime: on the i7 it stayed at the slicer's estimate (985 s for a 16m25s cube) from layer 10
    // to 27, so if it hasn't moved for a minute treat it as the whole-job estimate and scale by progress.
    const left = num(cws?.printLeftTime)
    if (left !== st.leftSeen.v) st.leftSeen = { v: left, since: Date.now() }
    const leftIsStatic = Date.now() - st.leftSeen.since > 60_000
    const crealityLeft = left ? (leftIsStatic ? left * (1 - progress) : left) : 0
    const timeLeftS = working ? crealityLeft || (progress > 0.01 && elapsed ? (elapsed / progress) * (1 - progress) : 0) || null : null
    const round = (n: number) => Math.round(n * 10) / 10
    return {
      machineId: m.id,
      connected: true,
      host,
      state,
      filename: recent && state === recent.state ? recent.filename : (ps.filename as string) || (active && cws?.printFileName ? String(cws.printFileName).split("/").pop()! : "") || null,
      progress: Math.round(progress * 1000) / 1000,
      printDurationS: Math.round(elapsed),
      extruder: { temp: round(num(ex.temperature)), target: num(ex.target) },
      bed: { temp: round(num(bed.temperature)), target: num(bed.target) },
      message: (ps.message as string) || (ds.message as string) || null,
      ...(working && layer ? { layer, totalLayers } : {}),
      ...(timeLeftS ? { timeLeftS: Math.round(timeLeftS) } : {}),
      ...(phase ? { phase } : {}),
      isMock,
      ...(() => {
        // A simulated printer (practice / dev mock) has no real spools: it "has loaded" exactly what this machine
        // says, so its made-up CFS box never overwrites the machine's own slots.
        if (isMock) return m.filaments.length ? { filaments: m.filaments } : {}
        const slots = parseBox(status.box, m.filamentSlots, m.filaments)
        return slots ? { filaments: slots } : {}
      })(),
    }
  } catch (e) {
    st.infoCache = null
    return disconnected(m.id, host, (e as Error).message)
  }
}

// ---------------------------------------------------------------------------------------------
// Print log hooks (catalog DB). Failures here must never affect printing.
// ---------------------------------------------------------------------------------------------

const LOST_TRACK_GRACE_MS = 60_000

function finishPrint(rec: PrintRecord, state: Exclude<PrintJobState, "printing">, message: string | null = null) {
  const done = recordPrintFinish(rec.id, state, undefined, message)
  if (done) {
    notePrintFinished(rec.projectId, rec.id, state)
    emit({ type: "print.finished", printId: rec.id, projectId: rec.projectId, state, message, practice: isPracticePrint(rec) })
  }
}

/**
 * A saved machine by id, or the unsaved practice printer a fresh install prints on (U3: no printers saved, so the
 * default machine is a practice printer that isn't in the list). Undefined for an unknown (e.g. removed) machine.
 */
export const machineById = savedOrDefault

/** Printed on the built-in practice printer: nothing real to rate (no "How did it turn out?" card). */
export function isPracticePrint(rec: Pick<PrintRecord, "machineId">): boolean {
  try {
    return !!machineById(rec.machineId)?.isPractice
  } catch {
    return false
  }
}

/** Open print records on this machine (records from before Machines belong to the default machine). */
function openPrintsOn(m: Machine): PrintRecord[] {
  return openPrints().filter((r) => r.machineId === m.id || (!r.machineId && m.isDefault))
}

interface HistoryJob {
  filename: string
  status: string // completed | cancelled | error | klippy_shutdown | klippy_disconnect | server_exit | in_progress
  start_time: number
  end_time: number | null
  print_duration: number
  total_duration: number
}

/** Moonraker's job history entry for one of our prints (read-only). */
async function historyJob(m: Machine, rec: PrintRecord): Promise<HistoryJob | null> {
  try {
    const { jobs } = await moonraker<{ jobs: HistoryJob[] }>(m, "/server/history/list?limit=10&order=desc")
    // Only a job for this file that started at/after ours (older attempts of the same file don't count).
    const since = Date.parse(rec.startedAt) / 1000 - 30
    return jobs.find((j) => j.filename === rec.printerFilename && j.start_time >= since) ?? null
  } catch {
    return null
  }
}

/** Plain explanation for a print that ended unexpectedly, from what the printer said and how long it ran. */
function endMessage(state: Exclude<PrintJobState, "printing">, said: string | null, ranS: number | null, printedS: number | null): string | null {
  if (said) return said
  if (state === "complete") return null
  if (state === "cancelled" && (printedS ?? 0) < 1 && ranS != null && ranS < 180) {
    return (
      `The printer cancelled the print before it started printing (after ${Math.round(ranS)} s). ` +
      `On Creality printers this usually means a filament slot the file uses has no material or colour set, ` +
      `or a filament error: check the printer's screen.`
    )
  }
  return state === "error" ? "The printer stopped the print with an error (it didn't say why)." : null
}

const historyChecks = new Set<string>() // print ids with an end check in flight
const progressSeen = new Map<string, number>() // print id -> highest progress seen while it ran
const idleSince = new Map<string, number>() // print id -> when we first saw the printer idle after it

/** Console lines since a time (printer epoch seconds). Read-only. */
async function consoleSince(m: Machine, sinceS: number): Promise<ConsoleLine[]> {
  try {
    const { gcode_store } = await moonraker<{ gcode_store: ConsoleLine[] }>(m, "/server/gcode_store?count=500")
    return gcode_store.filter((l) => l.time >= sinceS)
  } catch {
    return []
  }
}

// A real cancel. Creality's END_PRINT also logs "// CANCEL_PRINT trigger ENABLE_PRESSURE_ADVANCE=1" on a
// normal finish, so that line alone is NOT a cancel.
const CANCEL_RE = /start CANCEL_PRINT|CANCEL_PRINT success|cancel_continue_print|Print cancelled|print_stats: cancelled/i
const DONE_RE = /^Done printing file/

/**
 * How a job that's no longer running ended (Creality firmware never says so in print_stats, and Moonraker's job
 * history has no entry for prints started this way). In order:
 *   "Done printing file" in the console since the start, or progress reached ~100% → complete;
 *   a real cancel in the console, or a cancel sent from this app → cancelled;
 *   Moonraker history, only an entry for this file that started at/after this job.
 * null = can't tell yet.
 */
async function jobOutcome(m: Machine, rec: PrintRecord, st: MachineState): Promise<{ state: Exclude<PrintJobState, "printing">; ranS: number | null; printedS: number | null; byUser?: boolean } | null> {
  // Lines from this job only: after the console's selection of our file (or from our start time, minus a few
  // seconds of clock skew). A previous job's "Done printing file" must not count.
  const startS = Date.parse(rec.startedAt) / 1000 - 5
  const recent = await consoleSince(m, startS - 60)
  let from = recent.findIndex((l) => l.time >= startS)
  recent.forEach((l, i) => {
    if (rec.printerFilename && l.message.includes(rec.printerFilename) && /SDCARD_PRINT_FILE|File opened/.test(l.message) && l.time >= startS - 10) from = i
  })
  const lines = from < 0 ? [] : recent.slice(from)
  const lastLine = lines.at(-1)?.time ?? null
  const ranS = lastLine ? lastLine - startS : null
  const progress = progressSeen.get(rec.id) ?? 0
  const done = lines.some((l) => DONE_RE.test(l.message))
  const cancelled = lines.some((l) => CANCEL_RE.test(l.message)) || (st.userCancelAt ?? 0) >= Date.parse(rec.startedAt)
  if (done || (progress >= 0.99 && !cancelled)) return { state: "complete", ranS, printedS: null }
  if (cancelled) return { state: "cancelled", ranS, printedS: progress > 0 ? null : 0, byUser: (st.userCancelAt ?? 0) >= Date.parse(rec.startedAt) }
  const job = await historyJob(m, rec)
  if (job && job.status !== "in_progress") {
    const state = job.status === "completed" ? "complete" : job.status === "cancelled" ? "cancelled" : "error"
    return { state, ranS: job.end_time ? job.end_time - job.start_time : job.total_duration, printedS: job.print_duration }
  }
  return null
}

function trackPrints(m: Machine, status: PrinterStatus) {
  if (!status.connected) return
  const st = stateOf(m.id)
  try {
    for (const rec of openPrintsOn(m)) {
      // Klipper shut down (or failed) with our print on it: that print is over.
      if (canRestartFirmware(status.firmware)) {
        st.messages.delete(rec.id)
        progressSeen.delete(rec.id)
        idleSince.delete(rec.id)
        st.job = null
        finishPrint(rec, "error", "The printer stopped itself for safety during this print.")
        continue
      }
      const age = (Date.now() - Date.parse(rec.startedAt)) / 1000
      const ours = status.filename === rec.printerFilename
      const running = status.state === "printing" || status.state === "preparing" || status.state === "paused"
      if (ours && st.printMessage) st.messages.set(rec.id, st.printMessage)
      if (running && (ours || !status.filename)) {
        if (ours) progressSeen.set(rec.id, Math.max(progressSeen.get(rec.id) ?? 0, status.progress))
        idleSince.delete(rec.id)
        continue // still going (or starting)
      }
      if (ours && (status.state === "complete" || status.state === "cancelled" || status.state === "error")) {
        // Plain Klipper reports the end state in print_stats.
        const msg = endMessage(status.state, st.printMessage || st.messages.get(rec.id) || null, age, status.printDurationS)
        st.messages.delete(rec.id)
        finishPrint(rec, status.state, msg)
        continue
      }
      if (running) {
        // Printing another file: our job is over.
        if (age * 1000 > LOST_TRACK_GRACE_MS) finishPrint(rec, "error", "The printer started another file before this print reported its end.")
        continue
      }
      // Idle after our job: work out how it ended (console, progress seen while it ran, our own cancel, strict
      // history). Idle progress isn't used: a finished earlier job of the same file leaves it at 100%.
      if (!idleSince.has(rec.id)) idleSince.set(rec.id, Date.now())
      if (historyChecks.has(rec.id)) continue
      historyChecks.add(rec.id)
      void (async () => {
        const out = await jobOutcome(m, rec, st)
        const said = st.messages.get(rec.id) ?? null
        const idleFor = Date.now() - (idleSince.get(rec.id) ?? Date.now())
        if (out) {
          st.job = null // no longer "preparing"
          st.done = { state: out.state, filename: rec.printerFilename, until: Date.now() + 2 * 60_000 }
          st.messages.delete(rec.id)
          progressSeen.delete(rec.id)
          idleSince.delete(rec.id)
          finishPrint(rec, out.state, out.byUser ? "Cancelled from Crease." : endMessage(out.state, said, out.ranS, out.printedS))
        } else if (idleFor > LOST_TRACK_GRACE_MS && age * 1000 > LOST_TRACK_GRACE_MS) {
          st.messages.delete(rec.id)
          progressSeen.delete(rec.id)
          idleSince.delete(rec.id)
          finishPrint(rec, "error", said ?? "Lost track of this print: the printer went idle without saying how it ended.")
        }
      })().finally(() => historyChecks.delete(rec.id))
    }
  } catch (e) {
    console.error("[printer] print log update failed", e)
  }
}

const CAMERA_RECHECK_MS = 10 * 60_000

/** Detect the camera once connected (and every 10 min); save it on the Machine when it changes. Read-only GETs. */
function maybeDetectCamera(m: Machine, st: MachineState, status: PrinterStatus) {
  if (!status.connected || Date.now() - st.cameraCheckedAt < CAMERA_RECHECK_MS) return
  // The unsaved practice printer (no printers yet) has nowhere to save a camera.
  if (!getMachines().some((x) => x.id === m.id)) return
  st.cameraCheckedAt = Date.now()
  void (async () => {
    let cams: Webcam[] = []
    try {
      cams = await listWebcams(m.id)
    } catch {
      /* none */
    }
    const cam = await detectCamera(m, cams)
    const cur = getMachine(m.id).camera
    if (cur?.type !== cam.type || (cur?.url ?? null) !== (cam.url ?? null)) updateMachine(m.id, { camera: cam })
  })().catch((e) => console.error("[printer] camera detection failed", e))
}

/** Keep the machine's loaded filaments in step with what the printer reports (Creality CFS). */
function syncFilaments(m: Machine, status: PrinterStatus) {
  if (!status.filaments || status.isMock) return // simulated printers report the machine's own slots back
  try {
    const same = JSON.stringify(status.filaments) === JSON.stringify(m.filaments)
    if (same && m.filamentsConfirmed && m.filamentsSource === "printer") return
    updateMachine(m.id, { filaments: status.filaments, filamentsConfirmed: true, filamentsSource: "printer" })
  } catch (e) {
    console.error("[printer] could not save filaments read from the printer", e)
  }
}

function readHead(file: string, bytes: number): string {
  const fd = openSync(file, "r")
  try {
    const buf = Buffer.alloc(bytes)
    return buf.subarray(0, readSync(fd, buf, 0, bytes, 0)).toString("utf8")
  } finally {
    closeSync(fd)
  }
}

function readTail(file: string, bytes: number): string {
  const fd = openSync(file, "r")
  try {
    const size = fstatSync(fd).size
    const n = Math.min(bytes, size)
    const buf = Buffer.alloc(n)
    readSync(fd, buf, 0, n, size - n)
    return buf.toString("utf8")
  } finally {
    closeSync(fd)
  }
}

function logPrintStart(p: Pending, m: Machine, printerFilename: string): string | null {
  try {
    // A machine runs one job: a new job means any job we still think is running there is over.
    for (const old of openPrintsOn(m)) finishPrint(old, "error")
    // Part ids: from the slicer's object list (plates hold several parts), else from the file name.
    let ids = parsePlateObjects(readHead(p.gcodeAbs, 256 * 1024)).map((o) => o.partId)
    if (!ids.length) ids = [p.request.gcodeName.replace(/\.gcode$/i, "")]
    const known = new Set(
      (getDb().prepare(`SELECT id FROM parts WHERE project_id = ?`).all(p.request.projectId) as { id: string }[]).map((r) => r.id),
    )
    return recordPrintStart({
      projectId: p.request.projectId,
      machineId: m.id,
      partIds: [...new Set(ids)].filter((id) => known.has(id)),
      gcodeName: p.request.gcodeName,
      printerFilename,
      estimatedTimeS: p.request.estimatedTimeS,
      filamentG: p.request.filamentG,
      jobId: p.job.id,
      scope: scopeOfJob(p.job),
    }).id
  } catch (e) {
    console.error("[printer] could not record print start", e)
    return null
  }
}

async function poll(m: Machine): Promise<PrinterStatus> {
  const st = stateOf(m.id)
  const status = await fetchStatus(m)
  st.status = status
  syncFilaments(m, status)
  maybeDetectCamera(m, st, status)
  trackPrints(m, status)
  const json = JSON.stringify(status)
  if (json !== st.lastJson) {
    st.lastJson = json
    emit({ type: "printer.status", status })
  }
  return status
}

const polled = (m: Machine) => m.enabled && m.connection.type === "moonraker"

let pollTimer: NodeJS.Timeout | null = null
/** Poll every enabled Moonraker machine every 2 s (each independently) and emit printer.status on change. Idempotent. */
export function startPrinterPolling(intervalMs = 2000) {
  if (pollTimer) return
  const tick = () => {
    const machines = getMachines()
    for (const id of states.keys()) if (!machines.some((m) => m.id === id && polled(m))) states.delete(id)
    pruneCreality(new Set(machines.filter(polled).map((m) => m.id)))
    for (const m of machines.filter(polled)) {
      const st = stateOf(m.id)
      if (st.polling) continue
      st.polling = true
      void poll(m).finally(() => (st.polling = false))
    }
  }
  tick()
  pollTimer = setInterval(tick, intervalMs)
  pollTimer.unref()
}

export function stopPrinterPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

/** Live status of a machine (default when omitted), polled now. */
export async function getPrinterStatus(machineId?: string): Promise<PrinterStatus> {
  return poll(getMachine(machineId))
}

/** Last polled status of a machine without contacting it (null: not polled / no connection). */
export function cachedStatus(machineId: string): PrinterStatus | null {
  return states.get(machineId)?.status ?? null
}

/** Every machine with its last known status (for GET /api/machines). */
export function listMachinesWithStatus(): MachineWithStatus[] {
  return getMachines().map((m) => ({ ...m, status: polled(m) ? cachedStatus(m.id) : null, isPractice: !!m.isPractice }))
}

export function machineIsBusy(machineId: string): boolean {
  const st = cachedStatus(machineId)?.state
  return st === "printing" || st === "paused" || st === "preparing"
}

/** Enabled, connected machines that are not printing (farm "any idle"). */
export function idleMachines(): Machine[] {
  return getMachines().filter((m) => {
    const st = polled(m) ? cachedStatus(m.id) : null
    return m.enabled && !!st?.connected && !["printing", "preparing", "paused", "error"].includes(st.state)
  })
}

// ---------------------------------------------------------------------------------------------
// Print control
// ---------------------------------------------------------------------------------------------

async function control(action: "pause" | "resume" | "cancel", machineId?: string) {
  const m = getMachine(machineId)
  // A shut-down printer takes no print commands (its error would only come back as firmware text).
  const fw = (cachedStatus(m.id) ?? (await fetchStatus(m))).firmware
  if (fw) throw new MoonrakerError(fw === "startup" ? "The printer is starting up. Try again in a moment." : `${FIRMWARE_SENTENCE[fw]}`, 409)
  await moonraker(m, `/printer/print/${action}`, { method: "POST" })
  if (action === "cancel") stateOf(m.id).userCancelAt = Date.now()
  void poll(m)
  return { ok: true }
}
export const pausePrint = (machineId?: string) => control("pause", machineId)
export const resumePrint = (machineId?: string) => control("resume", machineId)
export const cancelPrint = (machineId?: string) => control("cancel", machineId)

/**
 * Restart Klipper after it shut itself down (Moonraker POST /printer/firmware_restart). Only while the printer
 * reports shutdown / error: it moves and heats nothing, but drops whatever the firmware was doing.
 */
export async function restartFirmware(machineId?: string) {
  const m = getMachine(machineId)
  const st = await fetchStatus(m) // fresh: never restart a printer on a stale status
  if (!st.connected) throw new MoonrakerError(`No answer from ${m.name}.`, 409)
  if (!canRestartFirmware(st.firmware)) throw new MoonrakerError(st.firmware === "startup" ? "The printer is already starting up." : `${m.name} is running fine. Nothing to restart.`, 409)
  await moonraker(m, "/printer/firmware_restart", { method: "POST", timeoutMs: 10_000 })
  console.log(`[printer] ${m.name}: firmware restart sent`)
  const ms = stateOf(m.id)
  ms.infoCache = null
  ms.firmwareLogged = ""
  void poll(m)
  return { ok: true }
}

/** Upload a G-code file to the printer's gcodes root. Never starts it (no `print=true`). */
async function uploadGcode(m: Machine, bytes: Buffer, remoteName: string): Promise<string> {
  const form = new FormData()
  form.append("root", "gcodes")
  // The exact bytes that were hash-verified against the job id (never re-read from a path that could change).
  form.append("file", new Blob([new Uint8Array(bytes)]), remoteName)
  const res = await moonraker<{ item?: { path?: string } }>(m, "/server/files/upload", {
    method: "POST",
    body: form,
    timeoutMs: 10 * 60_000,
  })
  return res?.item?.path ?? remoteName
}

async function startPrint(m: Machine, filename: string) {
  await moonraker(m, `/printer/print/start?filename=${encodeURIComponent(filename)}`, { method: "POST", timeoutMs: 15_000 })
}

/** Is a file running on the printer right now (Klipper's own signals; read-only)? */
async function fileRunning(m: Machine): Promise<boolean> {
  const { status } = await moonraker<{ status: Record<string, Obj> }>(m, "/printer/objects/query?virtual_sdcard&idle_timeout&print_stats")
  return status.virtual_sdcard?.is_active === true || status.idle_timeout?.state === "Printing" || status.print_stats?.state === "printing"
}

/** The printer's absolute gcodes folder (Moonraker roots; read-only). */
async function gcodesRoot(m: Machine): Promise<string> {
  const roots = await moonraker<{ name: string; path: string }[]>(m, "/server/files/roots")
  const g = roots.find((r) => r.name === "gcodes")?.path
  if (!g) throw new Error("the printer didn't say where its gcodes folder is")
  return g.replace(/\/+$/, "")
}

export const CREALITY_START_VERIFY_MS = 20_000

/**
 * Start an uploaded file. Default: Moonraker's /printer/print/start. With the machine's experimental "Start prints
 * through Creality's own service" setting: over the :9999 websocket (so the touchscreen tracks the job), falling back
 * to Moonraker only when nothing reached the printer; then confirm the printer really started within 20 s.
 */
async function startJob(m: Machine, filename: string, bytes: Buffer, slots: number[], st: PrinterStatus): Promise<"moonraker" | "creality"> {
  if (!(m.connection.type === "moonraker" && m.connection.crealityStart && !m.isPractice)) {
    await startPrint(m, filename)
    return "moonraker"
  }
  let full: string
  try {
    full = `${await gcodesRoot(m)}/${filename}`
  } catch (e) {
    console.warn(`[printer] ${m.name}: Creality start unavailable (${(e as Error).message}); starting through Moonraker`)
    await startPrint(m, filename)
    return "moonraker"
  }
  // CFS print: the file loads from the CFS (M8200) and the printer reports its slots → send the colour mapping too.
  const cfs = /^M8200 /m.test(bytes.subarray(0, 512 * 1024).toString("latin1")) && !!st.filaments?.length
  const crealitySlots: CrealitySlot[] | null = cfs
    ? slots.map((slot) => {
        const f = st.filaments!.find((x) => x.slot === slot)
        return { slot, material: f?.material ?? "PLA", colorHex: f?.colorHex ?? "#ffffff" }
      })
    : null
  try {
    await startViaCreality(m, full, crealitySlots)
  } catch (e) {
    if (e instanceof CrealityStartError && e.notSent) {
      console.warn(`[printer] ${m.name}: Creality start not sent (${e.message}); starting through Moonraker`)
      await startPrint(m, filename)
      return "moonraker"
    }
    throw new MoonrakerError(`Creality's print service didn't take the job: ${(e as Error).message}. Check the printer's screen before trying again.`, 502)
  }
  // Sent: never start it a second way. Just confirm the printer picked it up.
  const until = Date.now() + CREALITY_START_VERIFY_MS
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1000))
    try {
      if (await fileRunning(m)) return "creality"
    } catch {
      /* keep trying */
    }
  }
  throw new MoonrakerError(
    `Sent the job to Creality's print service, but ${m.name} didn't start it within ${CREALITY_START_VERIFY_MS / 1000} s. Check the printer's screen; turn off "Start prints through Creality's own service" in the printer's settings to use the normal start.`,
    502,
  )
}

/**
 * Refuse G-code sliced for a different printer: compares the slicer's printer preset and bed size in the
 * G-code footer with the machine's slicer profile. Returns a reason, or null if it fits (or can't tell).
 */
export function gcodeMismatch(gcodeAbs: string, m: Machine): string | null {
  try {
    const tail = readTail(gcodeAbs, 256 * 1024)
    const preset = tail.match(/^; printer_settings_id = (.+)$/m)?.[1]?.trim()
    const area = tail.match(/^; printable_area = (.+)$/m)?.[1]?.trim()
    const { dir } = ensureProfileDir(m)
    const prof = JSON.parse(readFileSync(join(dir, "machine.json"), "utf8")) as { name?: string }
    if (preset && prof.name && preset !== prof.name) {
      return `this G-code was sliced for "${preset}" but ${m.name} uses "${prof.name}". Slice it again for ${m.name}.`
    }
    if (area) {
      const pts = area.split(",").map((p) => p.split("x").map(Number))
      const w = Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0]))
      const d = Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1]))
      if (w > m.buildVolumeMm[0] + 0.5 || d > m.buildVolumeMm[1] + 0.5) {
        return `this G-code was sliced for a ${w}×${d} mm bed, larger than ${m.name}'s ${m.buildVolumeMm[0]}×${m.buildVolumeMm[1]} mm. Slice it again for ${m.name}.`
      }
    }
  } catch {
    /* can't tell: allow */
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Confirmation flow
// ---------------------------------------------------------------------------------------------

export interface PrintOutcome {
  request: PrintRequest
  approved: boolean
  filename?: string
  error?: string
}

interface Pending {
  request: PrintRequest
  job: PrintJob
  gcodeAbs: string // the job's immutable snapshot (what previews, slot checks and the upload read)
  sourceAbs: string // the slicer output the request was made from (must still hold the same bytes at approval)
  resolve: (o: PrintOutcome) => void
  timer: NodeJS.Timeout
  busy: boolean
  // the machine the request was explicitly made for (a named machine, or the dialog's "Slice for <printer>"): the
  // job is checked against it instead of the project's target machine. Absent: the project's target.
  forMachineId?: string
}
const pending = new Map<string, Pending>()

/**
 * Design approval (server/agent/approval.ts), injected by the printer routes so this module doesn't import the agent
 * (whose deps import this module). Without hooks (unit tests of this module) every design counts as approved.
 */
interface ApprovalHooks {
  isApproved: (projectId: string) => boolean
  approve: (projectId: string) => void
}
let approval: ApprovalHooks = { isApproved: () => true, approve: () => {} }
export function setApprovalHooks(h: ApprovalHooks) {
  approval = h
}
const approvedNow = (projectId: string) => {
  try {
    return approval.isApproved(projectId)
  } catch {
    return false
  }
}
const REQUEST_TTL_MS = 30 * 60_000
setOpenRequestProbe((id) => pending.has(id))

export function listPrintRequests(): PrintRequest[] {
  return [...pending.values()].map((p) => p.request)
}

/** Failing items from each part's latest saved check (.studio/checks/<part>.json), so the dialog never hides them. */
function failingChecksFor(projectId: string): string[] {
  try {
    const dir = resolveProjectPath(projectId, ".studio/checks")
    if (!existsSync(dir)) return []
    const out: string[] = []
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as { items?: { severity: string; message: string }[] }
      for (const i of r.items ?? []) if (i.severity === "fail") out.push(`${f.slice(0, -5)}: ${i.message}`)
    }
    return out
  } catch {
    return []
  }
}

/** The colours the design asks for (the job's parts, read as the slicer reads them), for "Design is Black · prints White". */
async function designColorsOf(projectId: string, partIds: string[]): Promise<string[]> {
  try {
    const project = await getProject(projectId)
    const want = new Set(partIds)
    const root = projectDir(projectId)
    return [...new Set(project.parts.filter((p) => want.has(p.id)).flatMap((p) => partDesignColors(root, p)))]
  } catch {
    return []
  }
}

/**
 * Reasons this machine can't run a file using `slots` right now: a used CFS slot not set up on the printer.
 * `fresh` re-reads the printer; otherwise the last poll is used (re-read if there is none).
 */
async function preflight(m: Machine, slots: number[], fresh: boolean): Promise<string[]> {
  const cached = cachedStatus(m.id)
  const st = fresh || !cached ? await poll(m) : cached
  if (!st.connected) return []
  return slotBlockers(slots, st.filaments)
}

/** What's loaded in the slots a file uses (machine re-read: preflight may just have synced it from the printer). */
function slotFilaments(machineId: string, slots: number[]) {
  const m = getMachine(machineId)
  return slots.map((slot) => {
    const f = m.filaments.find((x) => x.slot === slot)
    return { slot, colorName: f?.loaded ? f.colorName : "Not set", colorHex: f?.colorHex ?? "#000000", material: f?.loaded ? f.material : "unknown" }
  })
}

/** "Check again" from the dialog: re-read the printer and refresh the request's blockers (emits print.request). */
export async function recheckPrintRequest(requestId: string): Promise<PrintRequest> {
  const p = pending.get(requestId)
  if (!p) throw httpError(404, `no pending print request ${requestId}`)
  const m = getMachine(p.request.machineId)
  p.request.slotsUsed = gcodeSlotsUsed(p.gcodeAbs)
  p.request.blockers = await preflight(m, p.request.slotsUsed, true)
  p.request.slotFilaments = slotFilaments(m.id, p.request.slotsUsed)
  emit({ type: "print.request", request: p.request })
  return p.request
}

/**
 * The job a request would print, refusing anything that isn't a current slicer job: G-code that wasn't made by our
 * slicer (or was edited after slicing) has no job; a job whose inputs changed is stale. Both mean "slice again".
 */
async function requestableJob(
  projectId: string,
  gcodePath: string,
  expectJobId?: string,
  forMachineId?: string,
): Promise<{ job: PrintJob; sourceAbs: string }> {
  const sourceAbs = resolveProjectPath(projectId, gcodePath)
  if (!/\.gcode$/i.test(sourceAbs)) throw httpError(400, `not a .gcode file: ${gcodePath}`)
  if (!existsSync(sourceAbs)) throw httpError(404, `G-code not found: ${gcodePath} (slice the part first)`)
  // One read, one hash: the job is looked up by the bytes on disk now, and must be the one the caller checked.
  const sha = sha256(readFileSync(sourceAbs))
  if (expectJobId && sha !== expectJobId) {
    throw httpError(409, `${basename(sourceAbs)} changed after it was reviewed (sliced again or edited). Look at the new slice, then request it.`)
  }
  const job = loadJob(projectId, sha)
  if (!job) {
    throw httpError(
      409,
      `${basename(sourceAbs)} doesn't match any slice Crease made (it was edited, copied in, or sliced before print jobs existed). Slice again, then print the new file.`,
    )
  }
  const stale = await staleReasons(projectId, job, forMachineId)
  if (stale.length) throw httpError(409, `Out of date — slice again: ${stale.join("; ")}.`)
  return { job, sourceAbs }
}

/**
 * Export-only path ("Save print file"): the exact bytes of a current slicer job, named like an upload
 * (`<project name>_<file>.gcode`), for printing by hand (USB stick / SD card / the printer's own app). Same checks as a
 * print request: only G-code Crease sliced, and not out of date. `format: "3mf"` gives the part's model as a
 * coloured 3MF instead (to slice in the printer maker's own app); plates have no single model file.
 */
export async function exportPrintFile(
  projectId: string,
  gcodePath: string,
  format: "gcode" | "3mf" = "gcode",
): Promise<{ data: Buffer; filename: string; contentType: string; machineName: string }> {
  const { job } = await requestableJob(projectId, gcodePath)
  const name = (await getProject(projectId)).name
  if (format === "3mf") {
    if (job.kind !== "part" || !job.partIds[0]) throw httpError(409, "Only a single part can be saved as a 3MF model; save the plate's G-code instead.")
    const part = job.partIds[0]
    const rel = [`build/${part}.view.3mf`, `build/${part}.3mf`].find((r) => existsSync(resolveProjectPath(projectId, r)))
    if (!rel) throw httpError(404, `No 3MF model for ${part} yet: render it first.`)
    return { data: readFileSync(resolveProjectPath(projectId, rel)), filename: printFileName(name, `${part}.3mf`), contentType: "model/3mf", machineName: job.machineName }
  }
  return { data: readJobBytes(projectId, job), filename: printFileName(name, job.gcodeName), contentType: "text/x.gcode", machineName: job.machineName }
}

/** Fill a request's job-derived fields (file, estimates, slots) from a job and its snapshot. */
async function applyJob(request: PrintRequest, job: PrintJob, m: Machine, snapshotAbs: string) {
  const est = await readGcodeEstimates(snapshotAbs)
  request.job = summaryOf(job)
  request.machineId = m.id
  request.gcodeName = job.gcodeName
  request.estimatedTimeS = est.estimatedTimeS ?? job.estimatedTimeS
  request.filamentG = est.filamentG ?? job.filamentG
  request.slotsUsed = gcodeSlotsUsed(snapshotAbs)
  request.blockers = await preflight(m, request.slotsUsed, false)
  request.slotFilaments = slotFilaments(m.id, request.slotsUsed)
  request.adjustedTime = adjustedTimeFor(scopeOfJob(job), request.estimatedTimeS)
}

/**
 * Create a print request for a machine (the job's machine when omitted) and emit `print.request`. The request is
 * bound to the immutable job made from the G-code's exact bytes. Returns immediately with the request and a
 * promise (`outcome`) that settles when the user answers in the UI (or after 30 min).
 */
export async function createPrintRequest(
  projectId: string,
  gcodePath: string,
  origin: "agent" | "user",
  machineId?: string,
  expectJobId?: string,
): Promise<{ request: PrintRequest; outcome: Promise<PrintOutcome> }> {
  const { job, sourceAbs } = await requestableJob(projectId, gcodePath, expectJobId, machineId)
  const m = machineId ? requireMachine(machineId) : getMachine(job.machineId)
  if (m.id !== job.machineId) {
    throw httpError(409, `This print file was prepared for ${job.machineName}. Slice again for ${m.name} to print there.`)
  }
  const gcodeAbs = resolveProjectPath(projectId, job.snapshotPath)
  readJobBytes(projectId, job) // the snapshot must still be intact
  const mismatch = gcodeMismatch(gcodeAbs, m)
  if (mismatch) throw httpError(409, `Can't send to ${m.name}: ${mismatch}`)
  const request: PrintRequest = {
    requestId: randomUUID(),
    projectId,
    gcodeName: job.gcodeName,
    estimatedTimeS: null,
    filamentG: null,
    origin,
    failingChecks: failingChecksFor(projectId),
    // a user's print of a design not approved yet: the dialog shows the checks, and its Print approves this version
    needsApproval: origin === "user" && !approvedNow(projectId),
    designColors: await designColorsOf(projectId, job.partIds),
  }
  await applyJob(request, job, m, gcodeAbs)
  const outcome = new Promise<PrintOutcome>((resolve) => {
    const timer = setTimeout(() => {
      const p = pending.get(request.requestId)
      if (!p) return
      pending.delete(request.requestId)
      setJobStatus(projectId, p.job.id, "rejected", { error: "the request expired without an answer", requestId: null })
      emit({ type: "print.request.resolved", requestId: request.requestId, approved: false })
      resolve({ request, approved: false, error: "print request expired without an answer" })
    }, REQUEST_TTL_MS)
    timer.unref()
    pending.set(request.requestId, { request, job, gcodeAbs, sourceAbs, resolve, timer, busy: false, forMachineId: machineId })
  })
  setJobStatus(projectId, job.id, "requested", { requestId: request.requestId, error: null })
  emit({ type: "print.request", request })
  return { request, outcome }
}

/**
 * Create a print request and wait for the user's answer. Resolves with approved=true only after the
 * file was uploaded and the print actually started. The agent can never bypass this. `expectJobId` (the sha256 the
 * agent's slice review approved) must equal the job the file maps to, else it's refused.
 */
export async function requestPrint(
  projectId: string,
  gcodePath: string,
  origin: "agent" | "user",
  machineId?: string,
  expectJobId?: string,
): Promise<PrintOutcome> {
  const { outcome } = await createPrintRequest(projectId, gcodePath, origin, machineId, expectJobId)
  return outcome
}

/**
 * The user picked another machine in the dialog: that needs a different job, so slice the same inputs (parts,
 * intent, overrides) for it and swap the request over to the new job. The user then reviews and approves that one.
 */
export async function reslicePrintRequest(requestId: string, machineId: string): Promise<PrintRequest> {
  const p = pending.get(requestId)
  if (!p) throw httpError(404, `no pending print request ${requestId}`)
  if (p.busy) throw httpError(409, "print request is already being processed")
  const m = requireMachine(machineId)
  const old = p.job
  p.busy = true
  try {
    // what was asked for (automatic Display choices are made again for the new machine's slice)
    const userOverrides = old.userOverrides ?? old.overrides
    let gcodePath: string
    if (old.kind === "part") {
      const r = await slicePart(old.projectId, old.partIds[0], m.id, { intent: old.intent, overrides: userOverrides })
      gcodePath = r.gcodePath
    } else {
      const r = await slicePlate(old.projectId, old.allParts ? undefined : old.parts, m.id, undefined, { intent: old.intent, overrides: userOverrides })
      const pl = r.plates[(old.plate ?? 1) - 1] ?? r.plates[0]
      gcodePath = pl.gcodePath
    }
    const { job, sourceAbs } = await requestableJob(old.projectId, gcodePath, undefined, m.id)
    const gcodeAbs = resolveProjectPath(old.projectId, job.snapshotPath)
    await applyJob(p.request, job, m, gcodeAbs)
    Object.assign(p, { job, gcodeAbs, sourceAbs, forMachineId: m.id })
    if (old.id !== job.id) setJobStatus(old.projectId, old.id, "pending", { requestId: null })
    setJobStatus(old.projectId, job.id, "requested", { requestId, error: null })
    emit({ type: "print.request", request: p.request })
    return p.request
  } finally {
    p.busy = false
  }
}

/**
 * Handle the user's answer from the confirmation dialog. Only `approved && bedClear` uploads + starts, on the
 * request's machine. A different `machineId` is refused (409, request stays open): that machine needs its own
 * job (POST /api/print-requests/:id/reslice). Before uploading, the job's snapshot is hash-verified, the slicer
 * output it came from must still hold the same bytes, and the job must not be stale; otherwise the request is
 * resolved as not approved (409). Upload/start failures resolve it as not approved too (HTTP 502/409).
 */
export async function answerPrintRequest(
  requestId: string,
  approved: boolean,
  bedClear: boolean,
  machineId?: string,
  opts: { approveDesign?: boolean } = {},
): Promise<{ ok: boolean; filename?: string; machineId?: string }> {
  const p = pending.get(requestId)
  if (!p) throw httpError(404, `no pending print request ${requestId}`)
  if (p.busy) throw httpError(409, "print request is already being processed")
  const projectId = p.request.projectId

  const finish = (o: Omit<PrintOutcome, "request">) => {
    clearTimeout(p.timer)
    pending.delete(requestId)
    emit({ type: "print.request.resolved", requestId, approved: o.approved })
    p.resolve({ request: p.request, ...o })
  }
  const refuse = (message: string, status: "rejected" | "failed" = "rejected") => {
    setJobStatus(projectId, p.job.id, status, { error: message, requestId: null })
    finish({ approved: false, error: message })
    return httpError(409, message)
  }

  if (!(approved && bedClear)) {
    // "Don't print": nothing was sent, so the job is simply not printed yet (not a failed or refused try)
    const error = approved ? "bed not confirmed clear" : "rejected by user"
    setJobStatus(projectId, p.job.id, "pending", { error: null, requestId: null })
    finish({ approved: false, error })
    return { ok: true }
  }

  // A user's print of an unapproved design approves it in the same click (the dialog shows the checks). Without
  // that, keep the request open. The designer's requests were approved before they were made (R05); a dialog
  // answer never approves on its behalf.
  const approveNow = p.request.origin === "user" && !approvedNow(projectId)
  if (approveNow && !opts.approveDesign) throw httpError(409, "Approve the design first: printing it approves this version.")

  if (machineId && machineId !== p.request.machineId) {
    // Not a silent swap: another machine means another job. Keep the request open so they can re-slice or go back.
    const other = requireMachine(machineId)
    throw httpError(409, `This print file was prepared for ${p.job.machineName}. Slice again for ${other.name} first.`)
  }
  const m = getMachine(p.request.machineId)

  // Bind the approval to the bytes: the snapshot must hash to the job id, the file it was requested from must not
  // have been re-sliced or edited meanwhile, and nothing the job was made from may have changed.
  let bytes: Buffer
  try {
    bytes = readJobBytes(projectId, p.job)
  } catch (e) {
    throw refuse((e as Error).message)
  }
  if (!existsSync(p.sourceAbs) || sha256(readFileSync(p.sourceAbs)) !== p.job.id) {
    throw refuse(`${p.job.gcodeName} changed after this request was made (sliced again or edited). Send it again to approve the new file.`)
  }
  const stale = await staleReasons(projectId, p.job, p.forMachineId)
  if (stale.length) throw refuse(`Out of date — slice again: ${stale.join("; ")}.`)

  // Preflight on a fresh read: a used CFS slot without material makes Creality firmware cancel at 0 s. Keep the
  // request open so the user can set the slot on the printer and press "Check again".
  const slots = gcodeSlotsUsed(p.gcodeAbs)
  const blockers = await preflight(m, slots, true)
  if (blockers.length) {
    p.request.blockers = blockers
    emit({ type: "print.request", request: p.request })
    throw httpError(409, blockers.join(" "))
  }
  // The job is current: the design now is the revision it was sliced from, so this approves exactly that version.
  if (approveNow) approval.approve(projectId)
  p.busy = true
  try {
    const st = await fetchStatus(m)
    if (!st.connected) throw new MoonrakerError(`${m.name} is not connected: ${st.message ?? ""}`)
    if (st.state === "printing" || st.state === "paused" || st.state === "preparing") throw new MoonrakerError(`${m.name} is busy with another print`, 409)
    if (st.firmware) throw new MoonrakerError(st.firmware === "startup" ? `${m.name} is starting up. Try again in a moment.` : `${m.name} stopped itself for safety. Restart it first.`, 409)
    if (st.state === "error") throw new MoonrakerError(`${m.name} has a problem: ${st.message ?? "check its screen"}`, 409)
    const remoteName = printFileName((await getProject(projectId)).name, p.request.gcodeName)
    const filename = await uploadGcode(m, bytes, remoteName)
    const t0 = Date.now()
    const via = await startJob(m, filename, bytes, slots, st)
    if (via === "creality") console.log(`[printer] ${m.name}: started ${filename} through Creality's print service`)
    const ms = stateOf(m.id)
    ms.job = { startedAt: t0, filename, firstLayerByte: firstLayerOffset(bytes) }
    ms.done = null
    const first = slots[0] ?? 1
    const f = m.filaments.find((x) => x.slot === first)
    ms.startedSlot = { slot: first, name: f?.loaded ? f.colorName : `slot ${first}` }
    const printId = logPrintStart(p, m, filename)
    // The plate cursor advances only here: a recorded, successful start.
    setJobStatus(projectId, p.job.id, "printing", { printId, requestId: null, error: null })
    finish({ approved: true, filename })
    void poll(m)
    return { ok: true, filename, machineId: m.id }
  } catch (e) {
    setJobStatus(projectId, p.job.id, "failed", { error: (e as Error).message, requestId: null })
    finish({ approved: false, error: (e as Error).message })
    throw e
  }
}
