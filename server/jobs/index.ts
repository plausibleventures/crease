// OWNER: jobs agent. Immutable, content-addressed print jobs (R02) + their lifecycle and staleness (R04).
//
// A job is a snapshot of one sliced G-code: id = sha256 of its exact bytes. The bytes are copied into
// <project>/.studio/jobs/<id>/<name>.gcode next to a read-only job.json that records everything that went into them
// (source revision, parts + overrides, intent, slicer/profile versions and effective settings, machine config,
// checks, guide). Print requests carry the job; approving uploads exactly those bytes after re-verifying the hash.
//
// Mutable state (lifecycle per job, latest job per part, latest plate set) lives in .studio/jobs/state.json.
// Staleness is never stored: it is computed on read by comparing the job's recorded inputs with the project now.
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, join, relative } from "node:path"
import type {
  CheckReport,
  Machine,
  PlacedObject,
  PlatePlacement,
  PrintIntent,
  PrintJob,
  PrintJobStatus,
  PrintJobSummary,
  PrintJobView,
  ProjectJobs,
  SlicePreviewSummary,
  SlotUsage,
} from "../../shared/types"
import { PRINT_REQUEST_RESTART_NOTICE } from "../../shared/types"
import { PROJECTS_DIR } from "../config"
import { mapPlateObjects, parseExcludeObjects, placeObjects, stlMesh } from "../slicer/placement"
import { emit } from "../events"
import { getDefaultMachine, getMachines } from "../machines"
import { getPrint } from "../db"
import { ensureProfileDir } from "../slicer/profiles"
import { currentPartStampAt, designRevisionAt, stampReasons, type SourceStamp } from "../projects/revision"
import { guideValidityAt } from "../projects/validity"
import { getProject, httpError, projectDir, resolveProjectPath, updateProject } from "../projects/store"
import { scopeOfJob } from "../outcomes/calibration"
import { adjustedTimeFor } from "../outcomes/time"

export const sha256 = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex")
const ID_RE = /^[0-9a-f]{64}$/
const KEEP_UNREFERENCED = 20 // old job snapshots kept besides the ones the state still points at

const jobsRoot = (projectId: string) => join(projectDir(projectId), ".studio", "jobs")
const jobDir = (projectId: string, id: string) => {
  if (!ID_RE.test(id)) throw httpError(400, `invalid job id: ${id}`)
  return join(jobsRoot(projectId), id)
}

// ---------------------------------------------------------------------------------------------
// Inputs: source revision, machine fingerprint, G-code settings
// ---------------------------------------------------------------------------------------------

/**
 * Recursive source stamp of each part (its file, every include/use, and the Customizer values it renders with;
 * server/projects/revision.ts, the same stamp renders/checks/guides record). `stamps` keep the per-file hashes so a
 * stale job can say what changed ("lib/params.scad changed").
 */
export async function sourceRevision(projectId: string, partIds: string[]): Promise<PrintJob["source"]> {
  const root = projectDir(projectId)
  const project = await getProject(projectId)
  const parts: Record<string, string> = {}
  const stamps: Record<string, SourceStamp> = {}
  for (const id of [...new Set(partIds)].sort()) {
    const ref = project.parts.find((p) => p.id === id)
    if (!ref || !existsSync(join(root, ref.file))) {
      parts[id] = "missing"
      continue
    }
    stamps[id] = currentPartStampAt(root, ref)
    parts[id] = stamps[id].hash
  }
  return { revision: sha256(JSON.stringify(parts)).slice(0, 16), designRevision: designRevisionAt(root, { overrides: false }), parts, stamps }
}

/** Hash of the machine settings that change the G-code: slicer profile (incl. its machine.json), bed, nozzle, slots. */
export function machineFingerprint(m: Machine): string {
  let profile = ""
  try {
    profile = readFileSync(join(ensureProfileDir(m).dir, "machine.json"), "utf8")
  } catch {
    /* no profile folder (e.g. OrcaSlicer missing): config only */
  }
  return sha256(JSON.stringify([m.slicerProfile, m.buildVolumeMm, m.nozzleMm, m.filamentSlots, sha256(profile)])).slice(0, 16)
}

/** `; key = value` lines of the G-code's CONFIG_BLOCK (OrcaSlicer's effective settings). */
export function gcodeSettings(text: string): Record<string, string> {
  const start = text.lastIndexOf("; CONFIG_BLOCK_START")
  if (start < 0) return {}
  const end = text.indexOf("; CONFIG_BLOCK_END", start)
  const out: Record<string, string> = {}
  for (const line of text.slice(start, end < 0 ? undefined : end).split("\n")) {
    const m = line.match(/^; ([\w-]+) = (.*)$/)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}

const unquote = (s: string | undefined) => (s == null ? null : s.replace(/^"(.*)"$/, "$1") || null)

function checkSummaries(projectId: string, partIds: string[]): PrintJob["checks"] {
  const dir = join(projectDir(projectId), ".studio", "checks")
  return [...new Set(partIds)].map((partId) => {
    try {
      const r = JSON.parse(readFileSync(join(dir, `${partId}.json`), "utf8")) as CheckReport
      return {
        partId,
        summary: r.summary ?? null,
        createdAt: r.createdAt ?? null,
        failing: (r.items ?? []).filter((i) => i.severity === "fail").map((i) => i.message),
      }
    } catch {
      return { partId, summary: null, createdAt: null, failing: [] }
    }
  })
}

/** The picture guide on disk and whether it was built from the current parts + assembly (a soft record, not a gate). */
async function guideStatus(projectId: string): Promise<PrintJob["guide"]> {
  const v = guideValidityAt(projectDir(projectId), (await getProject(projectId)).parts)
  return { exists: v.state !== "missing", current: v.state === "fresh" }
}

// ---------------------------------------------------------------------------------------------
// Creating + loading jobs
// ---------------------------------------------------------------------------------------------

export interface JobInput {
  kind: "part" | "plate"
  parts: { partId: string; qty: number; overrides?: Record<string, string | number | boolean> }[]
  allParts?: boolean
  plate?: number
  plateCount?: number
  machine: Machine // the machine it prints on
  slicedFor: Machine // the machine whose profile it was sliced with
  intent: PrintIntent
  overrides?: Record<string, string | number | boolean> // effective (incl. automatic ones)
  userOverrides?: Record<string, string | number | boolean> // as the caller asked (reused by a toolbar re-slice)
  source: PrintJob["source"] // computed BEFORE slicing
  estimates: { estimatedTimeS: number | null; filamentG: number | null; filamentMm: number | null }
  filamentBySlot?: SlotUsage[]
  preview?: SlicePreviewSummary
  objects?: PlacedObject[] // R13: where each copy landed on this plate
}

function writeReadOnly(file: string, data: Buffer | string) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, data)
  chmodSync(tmp, 0o444)
  renameSync(tmp, file)
}

/**
 * Snapshot a freshly sliced G-code as an immutable job. Same bytes = same job (returns the existing record).
 * Does not change any lifecycle state; the slicer records the latest part job / plate set separately.
 */
export async function createJob(projectId: string, gcodeAbs: string, input: JobInput): Promise<PrintJob> {
  const bytes = readFileSync(gcodeAbs)
  const id = sha256(bytes)
  const dir = jobDir(projectId, id)
  const existing = loadJob(projectId, id)
  if (existing) return existing
  const root = projectDir(projectId)
  const name = basename(gcodeAbs)
  mkdirSync(dir, { recursive: true })
  const text = bytes.toString("utf8")
  const settings = gcodeSettings(text.slice(-512 * 1024))
  const m = input.machine
  const partIds = [...new Set(input.parts.map((p) => p.partId))]
  const job: PrintJob = {
    id,
    projectId,
    createdAt: new Date().toISOString(),
    kind: input.kind,
    gcodePath: relative(root, gcodeAbs).split("\\").join("/"),
    gcodeName: name,
    snapshotPath: relative(root, join(dir, name)).split("\\").join("/"),
    bytes: bytes.length,
    partIds,
    ...(input.plate ? { plate: input.plate, plateCount: input.plateCount ?? 1 } : {}),
    machineId: m.id,
    machineName: m.name,
    slicedForMachineId: input.slicedFor.id,
    intent: input.intent,
    ...(input.overrides && Object.keys(input.overrides).length ? { overrides: input.overrides } : {}),
    ...input.estimates,
    ...(input.filamentBySlot ? { filamentBySlot: input.filamentBySlot } : {}),
    sourceRevision: input.source.revision,
    designRevision: input.source.designRevision,
    slicer: {
      name: "OrcaSlicer",
      version: text.slice(0, 4096).match(/; generated by OrcaSlicer ([\w.-]+)/)?.[1] ?? null,
      printProfile: unquote(settings.print_settings_id),
      printerProfile: unquote(settings.printer_settings_id),
    },
    checks: checkSummaries(projectId, partIds),
    guide: await guideStatus(projectId).catch(() => ({ exists: false, current: false })),
    previewWarnings: input.preview?.issues.filter((i) => i.severity === "warn").length ?? 0,
    parts: input.parts,
    allParts: !!input.allParts,
    ...(input.userOverrides ? { userOverrides: input.userOverrides } : {}),
    source: input.source,
    machine: {
      id: m.id,
      name: m.name,
      model: m.model,
      slicerProfile: input.slicedFor.slicerProfile,
      buildVolumeMm: m.buildVolumeMm,
      nozzleMm: m.nozzleMm,
      filamentSlots: m.filamentSlots,
      filaments: m.filaments.map((f) => ({ slot: f.slot, colorName: f.colorName, colorHex: f.colorHex, material: f.material, loaded: f.loaded })),
      fingerprint: machineFingerprint(input.slicedFor),
    },
    settings,
    settingsHash: sha256(JSON.stringify(settings)).slice(0, 16),
    ...(input.objects?.length ? { objects: input.objects } : {}),
  }
  writeReadOnly(join(dir, name), bytes)
  writeReadOnly(join(dir, "job.json"), JSON.stringify(job, null, 2) + "\n")
  return job
}

export function loadJob(projectId: string, id: string): PrintJob | null {
  if (!ID_RE.test(id)) return null
  try {
    return JSON.parse(readFileSync(join(jobDir(projectId, id), "job.json"), "utf8")) as PrintJob
  } catch {
    return null
  }
}

/** The job whose bytes are exactly the file at `relPath` now (null: not made by our slicer, or edited since). */
export function getJobForGcode(projectId: string, relPath: string): PrintJob | null {
  const abs = resolveProjectPath(projectId, relPath)
  if (!existsSync(abs)) return null
  return loadJob(projectId, sha256(readFileSync(abs)))
}

/**
 * The job's bytes, read from its snapshot and verified against the id. Throws 409 if the snapshot is missing or was
 * modified (the bytes must be exactly what was sliced, previewed and approved).
 */
export function readJobBytes(projectId: string, job: PrintJobSummary): Buffer {
  const abs = resolveProjectPath(projectId, job.snapshotPath)
  if (!existsSync(abs)) throw httpError(409, `The print file for this job is gone (${job.gcodeName}). Slice again.`)
  const buf = readFileSync(abs)
  if (sha256(buf) !== job.id) throw httpError(409, `The print file for this job was modified after slicing (${job.gcodeName}). Slice again.`)
  return buf
}

export function summaryOf(job: PrintJob): PrintJobSummary {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { parts, allParts, source, machine, settings, settingsHash, objects, ...summary } = job
  return summary
}

// ---------------------------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------------------------

/**
 * A saved machine, or the default one when it has this id: with no printer saved (U3) the default is an unsaved
 * practice printer, which slices and prints like a saved one and must not count as "removed".
 */
export function savedOrDefault(id: string | null | undefined): Machine | undefined {
  if (!id) return undefined
  const saved = getMachines().find((m) => m.id === id)
  if (saved) return saved
  const def = getDefaultMachine()
  return def.id === id ? def : undefined
}

/** The machine a project slices for now: project.json `printer` if it names a machine, else the default. */
function targetMachine(printer: string | undefined): Machine {
  return getMachines().find((m) => m.id === printer) ?? getDefaultMachine()
}

/** The project's target machine (what slices and print requests use when no machine is named). */
export async function projectMachine(projectId: string): Promise<Machine> {
  return targetMachine((await getProject(projectId)).printer)
}

/**
 * Why a job no longer matches the project (empty = current). Server-owned; computed fresh on every call.
 * `forMachineId`: the machine a print request names (e.g. the print dialog's "Slice for <printer>"). A job sliced
 * for exactly that machine is current for it even when the project's own printer is another one. Without it, the
 * job is checked against the project's target machine.
 */
export async function staleReasons(projectId: string, job: PrintJob, forMachineId?: string | null): Promise<string[]> {
  const project = await getProject(projectId)
  const out: string[] = []
  const now = await sourceRevision(
    projectId,
    job.partIds.filter((id) => project.parts.some((p) => p.id === id)),
  )
  for (const id of job.partIds) {
    if (!project.parts.some((p) => p.id === id)) out.push(`${id} was removed from the project`)
    else if (now.parts[id] !== job.source.parts[id]) {
      // Jobs from before R07 have no per-file stamps: they can only say the part changed.
      const was = job.source.stamps?.[id]
      const why = was && now.stamps?.[id] ? stampReasons(was, now.stamps[id]) : []
      out.push(why.length ? `${id}: ${why.join("; ")} since it was sliced` : `${id} changed since it was sliced`)
    }
  }
  // The whole-design revision is what the agent's approval and slice review are keyed on: any design change
  // (another part, assembly.json placements/motions/colours, part colours) makes the slice out of date there too.
  if (!out.length && now.designRevision !== job.source.designRevision) out.push("the design changed since it was sliced")
  if (job.allParts) {
    const have = new Set(job.parts.map((p) => p.partId))
    const added = project.parts.filter((p) => !have.has(p.id)).map((p) => p.id)
    if (added.length) out.push(`${added.join(", ")} ${added.length === 1 ? "was" : "were"} added to the project`)
    const qty = (id: string) => job.parts.filter((p) => p.partId === id).reduce((a, p) => a + p.qty, 0)
    if (project.parts.some((p) => have.has(p.id) && qty(p.id) !== p.qty)) out.push("part quantities changed")
  }
  // Farm plates print on a machine other than the one they were sliced for; only plain jobs follow the target.
  if (job.machineId === job.slicedForMachineId) {
    const wanted = forMachineId ? savedOrDefault(forMachineId) : undefined
    if (wanted) {
      if (wanted.id !== job.slicedForMachineId) out.push(`it was sliced for ${job.machine.name}, not ${wanted.name}`)
    } else {
      const target = targetMachine(project.printer)
      if (target.id !== job.slicedForMachineId) out.push(`the project now prints on ${target.name}`)
    }
  }
  const slicedFor = savedOrDefault(job.slicedForMachineId)
  if (!slicedFor) out.push(`${job.machine.name} was removed`)
  else if (machineFingerprint(slicedFor) !== job.machine.fingerprint) out.push(`${slicedFor.name}'s printer settings changed`)
  if (project.intent && project.intent !== job.intent) out.push(`print settings changed to ${project.intent}`)
  return out
}

// ---------------------------------------------------------------------------------------------
// Lifecycle state (.studio/jobs/state.json)
// ---------------------------------------------------------------------------------------------

interface JobLife {
  status: PrintJobStatus
  requestId?: string | null
  printId?: string | null
  error?: string | null
  updatedAt: string
}
interface JobsState {
  jobs: Record<string, JobLife>
  parts: Record<string, string> // partId -> latest single-part job
  plateSet: { id: string; createdAt: string; jobIds: string[] } | null
}

const statePath = (projectId: string) => join(jobsRoot(projectId), "state.json")

function readState(projectId: string): JobsState {
  try {
    const s = JSON.parse(readFileSync(statePath(projectId), "utf8")) as Partial<JobsState>
    return { jobs: s.jobs ?? {}, parts: s.parts ?? {}, plateSet: s.plateSet ?? null }
  } catch {
    return { jobs: {}, parts: {}, plateSet: null }
  }
}

/** Read-modify-write (synchronous, so concurrent requests in this process can't interleave). */
function updateState(projectId: string, fn: (s: JobsState) => void) {
  const s = readState(projectId)
  fn(s)
  mkdirSync(jobsRoot(projectId), { recursive: true })
  const f = statePath(projectId)
  writeFileSync(f + ".tmp", JSON.stringify(s, null, 2) + "\n")
  renameSync(f + ".tmp", f)
  emit({ type: "jobs.changed", projectId })
}

const life = (s: JobsState, id: string): JobLife => (s.jobs[id] ??= { status: "pending", updatedAt: new Date().toISOString() })

/** Record a fresh single-part slice as that part's latest job. */
export function recordPartJob(projectId: string, partId: string, jobId: string) {
  updateState(projectId, (s) => {
    s.parts[partId] = jobId
    const l = life(s, jobId)
    if (l.status !== "requested" && l.status !== "printing") Object.assign(l, { status: "pending", error: null, updatedAt: new Date().toISOString() })
  })
  pruneJobs(projectId)
}

/** Record a fresh plate slice: it replaces the plate set; every plate starts pending (cursor at plate 1). */
export function recordPlateSet(projectId: string, jobIds: string[]) {
  updateState(projectId, (s) => {
    s.plateSet = { id: sha256(jobIds.join(",")).slice(0, 12), createdAt: new Date().toISOString(), jobIds }
    for (const id of jobIds) {
      const l = life(s, id)
      if (l.status !== "requested" && l.status !== "printing") Object.assign(l, { status: "pending", error: null, printId: null, updatedAt: new Date().toISOString() })
    }
  })
  pruneJobs(projectId)
}

/** How many of the project's jobs are waiting for the print dialog or printing (a project can't be trashed then). */
export function activePrintJobs(projectId: string): number {
  return Object.values(readState(projectId).jobs).filter((l) => l.status === "printing" || (l.status === "requested" && (!l.requestId || openRequest(l.requestId)))).length
}

export function setJobStatus(projectId: string, jobId: string, status: PrintJobStatus, patch: Partial<Omit<JobLife, "status" | "updatedAt">> = {}) {
  updateState(projectId, (s) => {
    Object.assign(life(s, jobId), patch, { status, updatedAt: new Date().toISOString() })
  })
}

/** When the agent's latest-slice review (preview_slice) last looked at these exact bytes (server/agent/review.ts record). */
function reviewedAt(projectId: string, id: string): string | null {
  try {
    const r = JSON.parse(readFileSync(join(projectDir(projectId), ".studio", "slice-reviews", `${id}.json`), "utf8")) as { reviews?: { at: string }[] }
    return r.reviews?.at(-1)?.at ?? null
  } catch {
    return null
  }
}

/** A logged print ended: its job is done (complete) or failed (cancelled/error), so the plate can be retried. */
export function notePrintFinished(projectId: string, printId: string, state: "complete" | "cancelled" | "error") {
  try {
    const s = readState(projectId)
    const id = Object.keys(s.jobs).find((k) => s.jobs[k].printId === printId)
    if (!id) return
    setJobStatus(projectId, id, state === "complete" ? "done" : "failed", { error: state === "complete" ? null : `print ${state}` })
  } catch (e) {
    console.error("[jobs] could not record print end", e)
  }
}

/**
 * The user said a print that the printer reported complete actually failed (R15 outcome "failed"): the job goes back
 * to failed, so a plate stays at the cursor for a retry. No-op for jobs that are already pending/failed/rejected or
 * have moved on to another print.
 */
export function noteOutcomeFailed(projectId: string, jobId: string, printId: string, reason = "you marked the print as failed") {
  try {
    const l = readState(projectId).jobs[jobId]
    if (!l || l.printId !== printId || l.status !== "done") return
    setJobStatus(projectId, jobId, "failed", { error: reason })
  } catch (e) {
    console.error("[jobs] could not record failed outcome", e)
  }
}

// The printer module tells us which request ids are still open (requests live in memory; after a restart a
// "requested" job has no dialog any more and counts as pending again).
let openRequest: (requestId: string) => boolean = () => true
export function setOpenRequestProbe(fn: (requestId: string) => boolean) {
  openRequest = fn
}

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

/** The print with this id ran on the built-in practice printer (saved, or the unsaved one a fresh install uses). */
function printedOnPractice(printId: string): boolean {
  try {
    const rec = getPrint(printId)
    return !!rec && !!savedOrDefault(rec.machineId)?.isPractice
  } catch {
    return false
  }
}

async function viewOf(projectId: string, job: PrintJob, l: JobLife | undefined): Promise<PrintJobView> {
  let status = l?.status ?? "pending"
  if (status === "requested" && l?.requestId && !openRequest(l.requestId)) status = "pending"
  return {
    ...summaryOf(job),
    status,
    stale: await staleReasons(projectId, job).catch((e) => [`couldn't check: ${(e as Error).message}`]),
    requestId: l?.requestId ?? null,
    printId: l?.printId ?? null,
    ...(l?.printId && printedOnPractice(l.printId) ? { practice: true } : {}),
    error: l?.error ?? null,
    reviewedAt: reviewedAt(projectId, job.id),
    updatedAt: l?.updatedAt ?? job.createdAt,
    adjustedTime: adjustedTimeFor(scopeOfJob(job), job.estimatedTimeS),
  }
}

export async function jobView(projectId: string, id: string): Promise<PrintJobView | null> {
  const job = loadJob(projectId, id)
  return job ? viewOf(projectId, job, readState(projectId).jobs[id]) : null
}

// The plate cursor: the first plate that hasn't started. A requested plate is still the cursor (its dialog is open),
// and a rejected or failed one stays there for a retry; only a recorded start (printing, then done) moves past it.
const STARTED = new Set<PrintJobStatus>(["printing", "done"])

/** GET /api/projects/:id/jobs */
export async function projectJobs(projectId: string): Promise<ProjectJobs> {
  const s = readState(projectId)
  const project = await getProject(projectId)
  const parts: Record<string, PrintJobView> = {}
  for (const [partId, id] of Object.entries(s.parts)) {
    if (!project.parts.some((p) => p.id === partId)) continue
    const job = loadJob(projectId, id)
    if (job) parts[partId] = await viewOf(projectId, job, s.jobs[id])
  }
  let plates: ProjectJobs["plates"] = null
  if (s.plateSet) {
    const views: PrintJobView[] = []
    for (const id of s.plateSet.jobIds) {
      const job = loadJob(projectId, id)
      if (job) views.push(await viewOf(projectId, job, s.jobs[id]))
    }
    if (views.length) {
      const next = views.findIndex((v) => !STARTED.has(v.status))
      plates = { id: s.plateSet.id, createdAt: s.plateSet.createdAt, plates: views, next: next < 0 ? null : next, stale: [...new Set(views.flatMap((v) => v.stale))] }
    }
  }
  return { parts, plates, intent: project.intent ?? null }
}

/** The job to print now: a part's latest job, or (no part) the plate set's next plate. Null if none. */
export async function currentJob(projectId: string, partId?: string): Promise<PrintJobView | null> {
  const all = await projectJobs(projectId)
  if (partId) return all.parts[partId] ?? null
  if (!all.plates) return null
  return all.plates.plates[all.plates.next ?? 0] ?? null
}

/** The toolbar intent picker (server-owned: it makes slices of another intent stale). */
export async function setProjectIntent(projectId: string, intent: PrintIntent) {
  const p = await getProject(projectId)
  if (p.intent !== intent) await updateProject(projectId, { intent })
  emit({ type: "jobs.changed", projectId })
  return intent
}

type Overrides = Record<string, string | number | boolean>

/** What the caller asked for (older jobs: the effective overrides minus the Display intent's automatic ones). */
function userOverridesOf(job: PrintJob): Overrides {
  if (job.userOverrides) return { ...job.userOverrides }
  const o: Overrides = { ...job.overrides }
  if (job.intent === "display") for (const k of ["top_surface_pattern", "ironing_pattern", "bottom_surface_pattern"]) if (o[k] === "concentric") delete o[k]
  return o
}

/** The inputs of a project's latest slice, for slicing the same thing again (toolbar "Slice", Send on a stale job). */
export interface SliceInputs {
  intent: PrintIntent
  overrides: Overrides // plate-level process overrides, as the caller gave them
  /** plate composition with per-part overrides; undefined = every part at its qty */
  parts?: { partId: string; qty: number; overrides?: Overrides }[]
  jobId: string
}

/**
 * The latest slice's inputs: with `partId`, that part's own latest slice (its part job, or a newer plate holding
 * only that part, whose per-part settings fold into plate-level ones); without, the latest plate set. Parts since
 * removed from the project are dropped. Null = nothing sliced yet.
 */
export async function latestSliceInputs(projectId: string, partId?: string): Promise<SliceInputs | null> {
  const s = readState(projectId)
  const project = await getProject(projectId)
  const exists = (id: string) => project.parts.some((p) => p.id === id)
  const plateJob = s.plateSet?.jobIds[0] ? loadJob(projectId, s.plateSet.jobIds[0]) : null
  if (partId) {
    const own = s.parts[partId] ? loadJob(projectId, s.parts[partId]) : null
    const onlyThis = plateJob && plateJob.parts.length > 0 && plateJob.parts.every((p) => p.partId === partId) ? plateJob : null
    const job = own && onlyThis ? (own.createdAt >= onlyThis.createdAt ? own : onlyThis) : (own ?? onlyThis)
    if (!job) return null
    const entry = job.kind === "plate" ? job.parts.find((p) => p.partId === partId) : undefined
    return { intent: job.intent, overrides: { ...userOverridesOf(job), ...entry?.overrides }, jobId: job.id }
  }
  if (!plateJob) return null
  const parts = plateJob.allParts ? undefined : plateJob.parts.filter((p) => exists(p.partId)).map((p) => ({ ...p }))
  return { intent: plateJob.intent, overrides: userOverridesOf(plateJob), ...(parts?.length ? { parts } : {}), jobId: plateJob.id }
}

/** Projects that have print jobs (their folders under the studio home). */
function projectsWithJobs(): string[] {
  try {
    return readdirSync(PROJECTS_DIR).filter((id) => existsSync(join(PROJECTS_DIR, id, ".studio", "jobs", "state.json")))
  } catch {
    return []
  }
}

/** A machine's slicing config / the default machine changed: every project's job staleness may have too. */
export function emitJobsChangedEverywhere() {
  for (const projectId of projectsWithJobs()) emit({ type: "jobs.changed", projectId })
}

/**
 * Server start: print requests live in memory, so a job still "requested" lost its dialog when the server stopped.
 * Put each back to pending with PRINT_REQUEST_RESTART_NOTICE as its error (nothing was sent: uploads happen only on
 * approval). Returns the projects affected, for a timeline notice.
 */
export function recoverInterruptedRequests(): string[] {
  const out: string[] = []
  for (const projectId of projectsWithJobs()) {
    try {
      const s = readState(projectId)
      const lost = Object.entries(s.jobs).filter(([, l]) => l.status === "requested" && !(l.requestId && openRequest(l.requestId)))
      if (!lost.length) continue
      for (const [id] of lost) setJobStatus(projectId, id, "pending", { requestId: null, error: PRINT_REQUEST_RESTART_NOTICE })
      out.push(projectId)
    } catch (e) {
      console.error(`[jobs] could not recover print requests of ${projectId}`, e)
    }
  }
  return out
}

/** Drop old snapshots no longer referenced by the state (keeps the newest few for history). */
export function pruneJobs(projectId: string) {
  try {
    const root = jobsRoot(projectId)
    const s = readState(projectId)
    const keep = new Set([...Object.values(s.parts), ...(s.plateSet?.jobIds ?? [])])
    for (const [id, l] of Object.entries(s.jobs)) if (l.status === "requested" || l.status === "printing") keep.add(id)
    const old = readdirSync(root)
      // Jobs with a recorded print outcome (R15: outcome.json + photos) are history: never pruned.
      .filter((d) => ID_RE.test(d) && !keep.has(d) && !existsSync(join(root, d, "outcome.json")))
      .map((d) => ({ d, t: statSync(join(root, d)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(KEEP_UNREFERENCED)
    if (!old.length) return
    for (const { d } of old) rmSync(join(root, d), { recursive: true, force: true })
    updateState(projectId, (st) => {
      for (const { d } of old) delete st.jobs[d]
    })
  } catch (e) {
    console.error("[jobs] prune failed", e)
  }
}

// ---------------------------------------------------------------------------------------------
// Placement (R13): where each object of a job sits on the bed
// ---------------------------------------------------------------------------------------------

const placementCache = new Map<string, PlatePlacement>()

/** GET /api/projects/:id/jobs/:jobId/placement. Recorded at slice time; older jobs: read from the snapshot. */
export function jobPlacement(projectId: string, jobId: string): PlatePlacement | null {
  const job = loadJob(projectId, jobId)
  if (!job) return null
  const area = (job.settings?.printable_area ?? "").split(",").map((p) => p.split("x").map(Number))
  const bedMm: [number, number] =
    area.length >= 3 && area.every((p) => p.length === 2 && p.every(Number.isFinite))
      ? [Math.max(...area.map((p) => p[0])), Math.max(...area.map((p) => p[1]))]
      : [job.machine?.buildVolumeMm?.[0] ?? 256, job.machine?.buildVolumeMm?.[1] ?? 256]
  const base = { jobId, kind: job.kind, plate: job.plate ?? 1, plateCount: job.plateCount ?? 1, bedMm, front: "-y" as const }
  if (job.objects?.length) return { ...base, objects: job.objects, source: "slice" }
  const key = `${projectId}|${jobId}`
  const hit = placementCache.get(key)
  if (hit) return hit
  let head: string
  try {
    const abs = resolveProjectPath(projectId, job.snapshotPath)
    const buf = readFileSync(abs)
    head = buf.subarray(0, Math.min(buf.length, 512 * 1024)).toString("utf8")
  } catch {
    return { ...base, objects: [], source: "gcode" }
  }
  const root = projectDir(projectId)
  const [objects] = placeObjects(mapPlateObjects([parseExcludeObjects(head)], job.parts ?? []), (partId) => {
    const stl = join(root, "build", `${partId}.stl`)
    return existsSync(stl) ? stlMesh(stl) : null
  })
  const out: PlatePlacement = { ...base, objects, source: "gcode" }
  placementCache.set(key, out)
  if (placementCache.size > 50) placementCache.delete(placementCache.keys().next().value!)
  return out
}
