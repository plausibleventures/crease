// Hard slice-review gate for the agent's request_print: it may only ask to print G-code that
//  1. it sliced itself (slice_part / slice_plate) from the current design revision, and
//  2. it then looked at with preview_slice: exactly those bytes, not an older slice at the same path.
//
// G-code is identified by the sha256 of its file bytes (full hex), the same key as content-addressed print jobs, so a
// re-slice to the same path is a different G-code and needs a fresh look. Each slice and each review is written to
// .studio/slice-reviews/<sha256>.json (what was pictured, which issues were reported), so there is a record of what
// was inspected before a print was requested. A tool call alone can't prove a thoughtful look; the record makes it
// checkable, and the subjective finish warnings stay advice for the agent and user.
//
// The final "Start printing?" confirmation is still the app's dialog; this only decides whether the agent may ask.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { isAbsolute, join, normalize, relative } from "node:path"
import { deps } from "./deps"
import { designRevision } from "./revision"
import { REVIEW_Q, blankDesignGate, sliceOrPrintGate } from "./approval"
import { guideRequired } from "./done"

export interface SliceReviewIssue {
  code: string
  severity: string
  layers?: number[]
}
export interface SliceReviewRecord {
  sha256: string
  gcodePath: string // project-relative, as sliced
  slicedAt: string
  designRevision: string | null // design revision it was sliced from
  reviews: {
    at: string
    gcodePath: string
    layersPictured: (number | "top" | "first")[] // 0-based layer indexes, or the top surfaces / first layer
    issues: SliceReviewIssue[] // what the analyzer reported at that look
  }[]
}

/** sha256 (hex) of a file's bytes: the G-code identity shared with print jobs. */
export const fileSha256 = (abs: string) => createHash("sha256").update(readFileSync(abs)).digest("hex")

/** Project-relative G-code path -> absolute, or null if it isn't a .gcode inside the project. */
export function gcodeAbs(projectId: string, gcodePath: string): string | null {
  const root = deps.projectDir(projectId)
  const rel = isAbsolute(gcodePath) ? relative(root, gcodePath) : normalize(gcodePath)
  if (!/\.gcode$/i.test(rel) || rel.startsWith("..") || isAbsolute(rel)) return null
  return join(root, rel)
}

const recordFile = (projectId: string, sha: string) => join(deps.projectDir(projectId), ".studio", "slice-reviews", `${sha}.json`)

export function readSliceRecord(projectId: string, sha: string): SliceReviewRecord | null {
  try {
    return JSON.parse(readFileSync(recordFile(projectId, sha), "utf8")) as SliceReviewRecord
  } catch {
    return null
  }
}
function writeSliceRecord(projectId: string, r: SliceReviewRecord) {
  const f = recordFile(projectId, r.sha256)
  mkdirSync(join(f, ".."), { recursive: true })
  writeFileSync(f, JSON.stringify(r, null, 2))
}

/**
 * The agent sliced: remember each resulting G-code's hash and the design revision it came from. `revision` is the
 * revision taken just before slicing. Accepts a SliceResult or PlateSliceResult.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function noteSliced(projectId: string, result: any, revision: string | null) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: any[] = Array.isArray(result?.plates) ? result.plates : [result]
  for (const r of items) {
    const g = r?.gcodePath
    const abs = typeof g === "string" ? gcodeAbs(projectId, g) : null
    if (!abs || !existsSync(abs)) continue
    const sha = fileSha256(abs)
    writeSliceRecord(projectId, { sha256: sha, gcodePath: g, slicedAt: new Date().toISOString(), designRevision: revision, reviews: [] })
  }
}

/** The agent ran preview_slice on these exact bytes: log what it was shown. */
export function noteReviewed(
  projectId: string,
  sha: string,
  gcodePath: string,
  layersPictured: (number | "top" | "first")[],
  issues: SliceReviewIssue[],
) {
  // A slice we didn't see (toolbar, older session): keep the review, with no known design revision.
  const r = readSliceRecord(projectId, sha) ?? { sha256: sha, gcodePath, slicedAt: "", designRevision: null, reviews: [] }
  r.reviews.push({ at: new Date().toISOString(), gcodePath, layersPictured, issues: issues.map(({ code, severity, layers }) => ({ code, severity, ...(layers?.length ? { layers: layers.slice(0, 8) } : {}) })) })
  writeSliceRecord(projectId, r)
}

export const sliceAgainRefusal = (gcodePath: string) =>
  `Not yet: ${gcodePath} wasn't sliced from the current design (it's from an earlier version, or it wasn't sliced by you). Slice it again (slice_part or slice_plate), look at the new slice with preview_slice, then call request_print with the G-code path it returns.`
export const previewFirstRefusal = (gcodePath: string) =>
  `Not yet: look at this exact slice before asking to print it. Run preview_slice on ${gcodePath} (check the first layer, the top surfaces and any layers its issues point at), fix or tell the user about any warnings, then call request_print again.`

/**
 * For the agent's request_print: null if this exact G-code was sliced from the current design and previewed since,
 * else a refusal saying what to do. Returns the record on success so the caller can report what was inspected.
 */
export function sliceReviewGate(projectId: string, gcodePath: string): { refusal: string; record?: undefined } | { refusal: null; record: SliceReviewRecord } {
  const abs = gcodeAbs(projectId, gcodePath)
  if (!abs) return { refusal: "gcodePath must be a .gcode file inside the project, e.g. build/main.gcode (from slice_part / slice_plate)." }
  if (!existsSync(abs)) return { refusal: `There's no ${gcodePath} yet. Slice the design first (slice_part or slice_plate), look at it with preview_slice, then request the print.` }
  const rec = readSliceRecord(projectId, fileSha256(abs))
  const rev = designRevision(projectId)
  if (!rec || !rec.designRevision || rec.designRevision !== rev) return { refusal: sliceAgainRefusal(gcodePath) }
  if (!rec.reviews.length) return { refusal: previewFirstRefusal(gcodePath) }
  return { refusal: null, record: rec }
}

/**
 * Everything that must hold before the agent may ask to print, in the order the agent should fix it: the user
 * approved this version of the design, the picture guide is current if the build goes together, and this exact
 * G-code was sliced from that version and looked at with preview_slice.
 */
export async function requestPrintGate(
  projectId: string,
  gcodePath: string,
): Promise<{ refusal: string; record?: undefined } | { refusal: null; record: SliceReviewRecord }> {
  const notApproved = blankDesignGate(projectId) ?? sliceOrPrintGate(projectId)
  if (notApproved) return { refusal: notApproved }
  const needsGuide = await guideRequired(projectId)
  if (needsGuide) return { refusal: needsGuide }
  return sliceReviewGate(projectId, gcodePath)
}

// ---------------------------------------------------------------------------------------------
// Review-question nudge: one approval should cover everything the user will get. If the build needs a picture guide
// (hardware, supplies, parts that go together, moving parts) and it isn't built yet, the first "How does this
// look?" is turned back once, so the agent settles the guide, shopping list and colours before asking, not after.
// Building the guide after "Looks great" keeps the approval anyway (revision.ts), but a colour picked to match the
// plan afterwards doesn't. Once per design revision: asking again at the same revision goes through, so a guide
// that can't be built never blocks the question.
// ---------------------------------------------------------------------------------------------

const reviewNudged = new Map<string, string | null>() // projectId -> design revision the nudge was given at

export const reviewNudge = (why: string) =>
  `Before asking "How does this look?": ${why.replace(/\s*then carry on\.?\s*$/i, "")} Do it now, so the user approves everything in one go: ` +
  "also settle the colours (from the loaded filaments, matching your plan) and anything else you'd still change. " +
  'Then show it and ask "How does this look?". (Building the guide after they approve keeps their approval; changing colours or shape doesn\'t.)'

/** For an AskUserQuestion round: a message turning it back (once per revision) if it's the review question too early. */
export async function reviewQuestionGate(projectId: string, questions: { question: string }[]): Promise<string | null> {
  if (!questions.some((q) => REVIEW_Q.test(q.question))) return null
  const rev = designRevision(projectId)
  if (reviewNudged.has(projectId) && reviewNudged.get(projectId) === rev) return null
  const needsGuide = await guideRequired(projectId).catch(() => null)
  if (!needsGuide) return null
  reviewNudged.set(projectId, rev)
  return reviewNudge(needsGuide)
}
