// OWNER: feedback (R15). Structured print outcomes: rating, failure categories, notes, photos, measured features and
// fit tests. An outcome lives on the print record (catalog prints row + .studio/prints/<id>.json) and is attached to
// the immutable job it printed: .studio/jobs/<jobId>/outcome.json ({jobId, outcomes[]}, one per print of those bytes)
// with photos in .studio/jobs/<jobId>/photos/. Prints without a job keep photos in .studio/prints/photos/<printId>/.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import type {
  CalibrationReport,
  CalibrationScope,
  PrintIntent,
  PrintOutcome,
  PrintOutcomeInput,
  PrintRecord,
} from "../../shared/types"
import { getPrint, listPrints, setPrintOutcome } from "../db"
import { emit } from "../events"
import { track } from "../telemetry"
import { loadJob, noteOutcomeFailed } from "../jobs"
import { getMachine } from "../machines"
import { addLesson, removeLesson } from "../agent/lessons"
import { httpError, projectDir } from "../projects/store"
import { sameScope, scopeOfJob, toleranceSuggestions } from "./calibration"
import { proposeLesson } from "./propose"
import { timeCalibrationFor } from "./time"

const JOB_RE = /^[0-9a-f]{64}$/
const PHOTO_RE = /^[\w-]{1,80}\.(jpe?g|png|webp)$/i
const MAX_PHOTOS = 12
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024

function requirePrint(printId: string): PrintRecord {
  const p = getPrint(printId)
  if (!p) throw httpError(404, "print not found")
  return p
}

const jobDirOf = (rec: PrintRecord) => (rec.jobId && JOB_RE.test(rec.jobId) ? join(projectDir(rec.projectId), ".studio", "jobs", rec.jobId) : null)

/** Where a print's photos live (the job's folder when the job snapshot still exists). */
export function photoDir(rec: PrintRecord): string {
  const jd = jobDirOf(rec)
  if (jd && existsSync(join(jd, "job.json"))) return join(jd, "photos")
  return join(projectDir(rec.projectId), ".studio", "prints", "photos", rec.id)
}

export function photoPath(printId: string, name: string): string {
  if (!PHOTO_RE.test(name)) throw httpError(400, "invalid photo name")
  const f = join(photoDir(requirePrint(printId)), name)
  if (!existsSync(f)) throw httpError(404, "photo not found")
  return f
}

export const photoUrl = (printId: string, name: string) => `/api/prints/${encodeURIComponent(printId)}/photos/${encodeURIComponent(name)}`

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp" }

/** Save one photo for a print (uploaded or a camera frame). Photo names start with the print id. */
export function addPhoto(printId: string, data: Buffer, mediaType: string): { name: string; url: string } {
  const rec = requirePrint(printId)
  const ext = EXT[mediaType.toLowerCase()]
  if (!ext) throw httpError(400, "photos must be JPEG, PNG or WebP")
  if (!data.length) throw httpError(400, "empty photo")
  if (data.length > MAX_PHOTO_BYTES) throw httpError(413, "photo is too big (8 MB max)")
  const dir = photoDir(rec)
  mkdirSync(dir, { recursive: true })
  const mine = readdirSync(dir).filter((f) => f.startsWith(rec.id.slice(0, 8)))
  if (mine.length >= MAX_PHOTOS) throw httpError(409, `up to ${MAX_PHOTOS} photos per print`)
  const name = `${rec.id.slice(0, 8)}-${Date.now().toString(36)}${randomBytes(2).toString("hex")}.${ext}`
  writeFileSync(join(dir, name), data)
  return { name, url: photoUrl(printId, name) }
}

export function removePhoto(printId: string, name: string) {
  const f = photoPath(printId, name)
  rmSync(f, { force: true })
  const rec = requirePrint(printId)
  if (rec.outcome?.photos.includes(name)) {
    persistOutcome(rec, { ...rec.outcome, photos: rec.outcome.photos.filter((p) => p !== name), updatedAt: new Date().toISOString() })
  }
}

/** The scope a print was made with: recorded at start, else from its job, else the machine with unknown intent. */
function scopeOf(rec: PrintRecord): CalibrationScope | null {
  if (rec.scope) return rec.scope
  const job = rec.jobId ? loadJob(rec.projectId, rec.jobId) : null
  return job ? scopeOfJob(job) : null
}

function writeJobOutcome(rec: PrintRecord, outcome: PrintOutcome) {
  const jd = jobDirOf(rec)
  if (!jd || !existsSync(join(jd, "job.json"))) return
  const f = join(jd, "outcome.json")
  let all: PrintOutcome[] = []
  try {
    all = (JSON.parse(readFileSync(f, "utf8")) as { outcomes?: PrintOutcome[] }).outcomes ?? []
  } catch {
    /* first outcome */
  }
  all = [...all.filter((o) => o.printId !== outcome.printId), outcome].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  writeFileSync(f + ".tmp", JSON.stringify({ jobId: rec.jobId, outcomes: all }, null, 2) + "\n")
  renameSync(f + ".tmp", f)
}

function persistOutcome(rec: PrintRecord, outcome: PrintOutcome): PrintRecord {
  const next = setPrintOutcome(rec.id, outcome)
  if (!next) throw httpError(404, "print not found")
  writeJobOutcome(rec, outcome)
  emit({ type: "prints.changed", projectId: rec.projectId, printId: rec.id, machineId: rec.machineId ?? null })
  return next
}

const clean = (s: string | null | undefined, max: number) => {
  const t = (s ?? "").trim()
  return t ? t.slice(0, max) : null
}

/** Save (or replace) the outcome of a print. Proposes a lesson; "failed" marks the job failed for a retry. */
export function saveOutcome(printId: string, input: PrintOutcomeInput): PrintRecord {
  const rec = requirePrint(printId)
  if (!rec.finishedAt) throw httpError(409, "this print hasn't finished yet")
  const now = new Date().toISOString()
  const prev = rec.outcome ?? null
  const dir = photoDir(rec)
  const photos = (input.photos ?? prev?.photos ?? []).filter((n) => PHOTO_RE.test(n) && existsSync(join(dir, n)))
  const machineId = rec.machineId ?? scopeOf(rec)?.machineId ?? null
  const outcome: PrintOutcome = {
    printId: rec.id,
    projectId: rec.projectId,
    jobId: rec.jobId ?? null,
    machineId,
    rating: input.rating,
    categories: input.rating === "great" ? [] : [...new Set(input.categories ?? [])],
    notes: clean(input.notes, 4000),
    photos: [...new Set(photos)],
    measurements: (input.measurements ?? prev?.measurements ?? [])
      .filter((m) => m.name.trim() && isFinite(m.expectedMm) && m.expectedMm > 0)
      .map((m) => ({ ...m, name: m.name.trim().slice(0, 80), measuredMm: m.measuredMm != null && isFinite(m.measuredMm) && m.measuredMm > 0 ? m.measuredMm : null }))
      .slice(0, 40),
    fits: (input.fits ?? prev?.fits ?? []).filter((f) => f.name.trim()).map((f) => ({ ...f, name: f.name.trim().slice(0, 80) })).slice(0, 20),
    scope: scopeOf(rec),
    partIds: rec.partIds,
    estimatedTimeS: rec.estimatedTimeS,
    actualDurationS: rec.actualDurationS ?? null,
    lesson: null,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  }
  // Keep a decided lesson (accepted/dismissed) as it is; otherwise propose afresh from the new outcome.
  if (prev?.lesson && prev.lesson.status !== "proposed") outcome.lesson = prev.lesson
  else if (machineId) {
    const text = proposeLesson(outcome)
    outcome.lesson = text ? { text, machineId, status: "proposed", line: null, decidedAt: null } : null
  }
  const next = persistOutcome(rec, outcome)
  if (!prev) track("print_rated", { result: input.rating, issue: outcome.categories[0] ?? "none" }) // the first rating only
  if (input.rating === "failed" && rec.jobId) noteOutcomeFailed(rec.projectId, rec.jobId, rec.id)
  return next
}

/** Accept (optionally edited), dismiss, or undo an accepted lesson. */
export function decideLesson(printId: string, action: "accept" | "dismiss" | "undo", text?: string): PrintRecord {
  const rec = requirePrint(printId)
  const o = rec.outcome
  if (!o?.lesson) throw httpError(409, "this print has no proposed lesson")
  const l = { ...o.lesson }
  const now = new Date().toISOString()
  if (action === "accept") {
    if (l.status === "accepted") return rec
    const m = getMachine(l.machineId)
    const project = rec.projectId
    const evidence = `${project}${rec.partIds.length === 1 && !project.includes(rec.partIds[0]) ? ` ${rec.partIds[0]}` : ""}, ${(rec.finishedAt ?? rec.startedAt).slice(0, 10)}`
    const written = addLesson(m.id, m.name, (text ?? l.text).trim() || l.text, evidence)
    Object.assign(l, { text: (text ?? l.text).trim() || l.text, status: "accepted", line: written.startsWith("(already recorded)") ? null : written, decidedAt: now })
  } else if (action === "dismiss") {
    if (l.status === "accepted") throw httpError(409, "undo the accepted lesson instead")
    Object.assign(l, { status: "dismissed", decidedAt: now })
  } else {
    if (l.status !== "accepted") throw httpError(409, "only an accepted lesson can be undone")
    if (l.line) removeLesson(l.machineId, l.line)
    Object.assign(l, { status: "undone", line: null, decidedAt: now })
  }
  return persistOutcome(rec, { ...o, lesson: l, updatedAt: now })
}

/** Remove a lesson line from the Machines list; an outcome that wrote it is marked undone. */
export function forgetLesson(machineId: string, line: string): boolean {
  const removed = removeLesson(machineId, line)
  for (const rec of listPrints(undefined, 500, machineId)) {
    const l = rec.outcome?.lesson
    if (l?.status === "accepted" && l.line && l.line.trimEnd() === line.trimEnd()) {
      persistOutcome(rec, { ...rec.outcome!, lesson: { ...l, status: "undone", line: null, decidedAt: new Date().toISOString() }, updatedAt: new Date().toISOString() })
    }
  }
  return removed
}

/** Outcomes of a project's prints, newest first (what the agent reads with read_print_outcomes). */
export function projectOutcomes(projectId: string): PrintOutcome[] {
  return listPrints(projectId, 200)
    .map((p) => p.outcome)
    .filter((o): o is PrintOutcome => !!o)
}

/** Calibration for printer + nozzle + material + intent (defaults: the machine's nozzle, its first loaded material). */
export function calibrationReport(q: { machineId?: string; intent?: PrintIntent; material?: string; nozzleMm?: number }): CalibrationReport {
  const m = getMachine(q.machineId)
  const scope: CalibrationScope = {
    machineId: m.id,
    nozzleMm: q.nozzleMm ?? m.nozzleMm,
    material: (q.material ?? m.filaments.find((f) => f.loaded)?.material ?? "PLA").toUpperCase(),
    intent: q.intent ?? "standard",
  }
  const outcomes = listPrints(undefined, 500, m.id)
    .map((p) => p.outcome)
    .filter((o): o is PrintOutcome => !!o && (o.measurements.some((x) => x.measuredMm != null) || o.fits.length > 0))
  // Fits/sizes depend on printer + nozzle + material much more than on intent: same material first, else any.
  const sameMaterial = outcomes.filter((o) => o.scope && o.scope.nozzleMm === scope.nozzleMm && o.scope.material.toUpperCase() === scope.material)
  const exact = sameMaterial.filter((o) => sameScope(o.scope, scope))
  const basis = exact.length ? exact : sameMaterial.length ? sameMaterial : outcomes
  return {
    scope,
    time: timeCalibrationFor(scope),
    tolerances: toleranceSuggestions(basis, m.tolerances),
    outcomes: basis.length,
  }
}
