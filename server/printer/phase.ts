// Printer state from one Moonraker status poll, as a pure function (fixtures: server/printer/fixtures/status/).
//
// Creality firmware (SPARKX i7 fw 1.1.5.x) never moves print_stats off "standby" during a job, so "printing" vs
// "preparing" (START_PRINT: home, CFS load, flush, nozzle clean, heat) has to be derived. Before R19 that was
// "active and virtual_sdcard.layer < 1". It missed the Preparing phase on a warm printer (test plate, 2026-10-08):
// a warm start skips heating, and right after a finished job the previous job's numbers are still on the printer
// (virtual_sdcard.layer / :9999 layer stay at the last job's final layer until the new one reaches its first layer
// change — our reading of the symptom, not yet seen in a raw recording). Now, in order:
//   1. our own job and we know where its first layer starts in the file: preparing while
//      virtual_sdcard.file_position is before that byte (START_PRINT and the purge run before it). Firmware-agnostic:
//      Klipper's file_position only moves past a line once its command (the whole START_PRINT macro) has run.
//   2. otherwise the layer number, ignoring a layer value left over from before this job started (the value the
//      printer showed while idle, until it changes).
//   3. within the grace period after we started a job, before the printer shows it: preparing.
import type { PrinterState } from "../../shared/types"

type Obj = Record<string, unknown>
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
const KNOWN = new Set<PrinterState>(["standby", "printing", "paused", "complete", "cancelled", "error"])

export const PREPARE_GRACE_MS = 45_000

/** A job this app started on the printer. */
export interface OurJob {
  startedAt: number // ms
  filename: string // as uploaded (Moonraker path relative to gcodes/)
  firstLayerByte: number | null // byte offset of the first layer change in the file (null = unknown)
}

/** What a machine remembers between polls. */
export interface PhaseMemory {
  idleLayer: number | null // layer value the printer showed while idle (left over from the last job)
  staleLayer: number | null // that value, while a new job hasn't moved off it yet
  wasActive: boolean | null // null = no poll yet (e.g. app restarted mid-print)
}
export const newPhaseMemory = (): PhaseMemory => ({ idleLayer: null, staleLayer: null, wasActive: null })

export interface PhaseInput {
  now: number
  status: { print_stats?: Obj; virtual_sdcard?: Obj; idle_timeout?: Obj; pause_resume?: Obj }
  ws?: { layer?: unknown; TotalLayer?: unknown } | null // Creality :9999 push data
  job: OurJob | null
}

export interface PhaseResult {
  state: PrinterState
  active: boolean // a file is running (virtual_sdcard / idle_timeout)
  layer: number | null
  totalLayers: number | null
  why: string // which rule decided (for tests and debugging)
}

/** Byte offset of the first layer change in G-code (OrcaSlicer ";LAYER_CHANGE", Cura ";LAYER:0", Klipper info). */
export function firstLayerOffset(gcode: Buffer | string): number | null {
  const text = typeof gcode === "string" ? gcode : gcode.subarray(0, 4 * 1024 * 1024).toString("latin1")
  const m = /^(;LAYER_CHANGE|;LAYER:0\b|;LAYER:1\b|SET_PRINT_STATS_INFO CURRENT_LAYER=1\b)/m.exec(text)
  return m ? Buffer.byteLength(text.slice(0, m.index), "latin1") : null
}

const base = (p: unknown) => String(p ?? "").split("/").pop() ?? ""

/** Derive the state for one poll and update `mem`. */
export function derivePhase(input: PhaseInput, mem: PhaseMemory): PhaseResult {
  const ps = input.status.print_stats ?? {}
  const sd = input.status.virtual_sdcard ?? {}
  const it = input.status.idle_timeout ?? {}
  const pr = input.status.pause_resume ?? {}
  const raw = String(ps.state ?? "standby") as PrinterState
  let state: PrinterState = KNOWN.has(raw) ? raw : "standby"
  // Only virtual_sdcard.is_active (or Klipper's idle_timeout "Printing") says a file runs. Not print_stats.filename
  // (Creality keeps it after a job) and not Creality's deviceState (stays 1 after a finished print).
  const active = sd.is_active === true || it.state === "Printing"
  const sdLayer = typeof sd.layer === "number" ? sd.layer : null
  const wsLayer = typeof input.ws?.layer === "number" ? input.ws.layer : null
  const psLayer = num((ps.info as Obj | undefined)?.current_layer) || null
  const totalLayers = num((ps.info as Obj | undefined)?.total_layer) || num(sd.layer_count) || num(input.ws?.TotalLayer) || null

  // Leftover layer from the last job: remember what the printer shows while idle; a new job starts "stale" on it.
  let rawLayer = state === "printing" ? (psLayer ?? sdLayer ?? wsLayer) : (sdLayer ?? wsLayer)
  if (!active) {
    mem.idleLayer = rawLayer
    mem.staleLayer = null
  } else if (mem.wasActive === false) {
    // just went active: a leftover layer ≥ 1 isn't this job's
    mem.staleLayer = mem.idleLayer != null && mem.idleLayer >= 1 ? mem.idleLayer : null
  }
  if (active && mem.staleLayer != null) {
    if (rawLayer === mem.staleLayer) rawLayer = null
    else if (rawLayer != null) mem.staleLayer = null // moved: it's this job's layer from now on
  }
  mem.wasActive = active
  // Creality counts one past the end (the i7 reported layer 51 of 50 on the last layer): never show more than the total.
  const layer = rawLayer != null && totalLayers != null ? Math.min(rawLayer, totalLayers) : rawLayer

  // Where in the file it is, for our own job (rule 1).
  const ours = !!input.job && (base(ps.filename) === base(input.job.filename) || base(sd.file_path) === base(input.job.filename))
  const pos = typeof sd.file_position === "number" ? sd.file_position : null
  const beforeFirstLayer = ours && input.job!.firstLayerByte != null && pos != null ? pos < input.job!.firstLayerByte! : null
  const justStarted = !!input.job && input.now - input.job.startedAt < PREPARE_GRACE_MS

  let why = "print_stats"
  if (state === "standby") {
    if (pr.is_paused === true && ps.filename) {
      state = "paused"
      why = "pause_resume"
    } else if (active) {
      if (beforeFirstLayer != null) {
        state = beforeFirstLayer ? "preparing" : "printing"
        why = "file_position"
      } else {
        state = (layer ?? 0) >= 1 ? "printing" : "preparing" // START_PRINT runs before layer 1
        why = mem.staleLayer != null ? "stale-layer" : "layer"
      }
    } else if (justStarted) {
      state = "preparing"
      why = "grace"
    }
  } else if (state === "printing" && beforeFirstLayer === true) {
    // Plain Klipper says "printing" from the first line of the file: PRINT_START heating/levelling is Preparing too.
    state = "preparing"
    why = "file_position"
  }
  return { state, active, layer, totalLayers, why }
}

export interface ConsoleLine {
  message: string
  time: number // printer epoch seconds
  type?: string
}

/**
 * Console lines that belong to the current job: from its last selection line ("SDCARD_PRINT_FILE" / "File selected")
 * on. Without one, only lines since our start (minus clock skew) — never the previous job's "Done printing file",
 * which on a warm printer is often still among the last lines and used to end "Preparing" at once.
 */
export function jobConsole(lines: ConsoleLine[], startedAtMs: number | null): ConsoleLine[] {
  const since = startedAtMs == null ? -Infinity : startedAtMs / 1000 - 5
  let from = -1
  lines.forEach((l, i) => {
    // a selection from before our start is the previous job's
    if (/SDCARD_PRINT_FILE|File selected/.test(l.message) && l.time >= since) from = i
  })
  if (from >= 0) return lines.slice(from)
  if (startedAtMs == null) return lines
  return lines.filter((l) => l.time >= since)
}
