// Dependency-based artifact validity (R07). Every derived artifact records the SourceStamp it was built from
// (server/projects/revision.ts); it is current when that stamp's hash equals the stamp computed now. Nothing here
// compares timestamps, so an edit to lib/params.scad, a Customizer override or assembly.json counts even when the
// part's own file is untouched, and restoring an older version makes artifacts built from it current again.
//
// Records:
//   render  build/<part>.render.json        {hash, files, params, builtAt}   (cad/index.ts; also the render cache key)
//   check   .studio/checks/<part>.json      CheckReport.source               (cad/index.ts)
//   guide   build/assembly-guide.json       {source, builtAt}                (assembly/index.ts; covers step renders + shopping list)
//   motion  build/motion-check.json         {inputs: SourceStamp, check: MotionCheck} (assembly/index.ts)
//   jobs    .studio/jobs/<id>/job.json      source.parts / source.stamps     (jobs/index.ts)
//
// The functions take the project root + parts list so the agent's done checklist (which runs on its deps
// indirection) and the HTTP route share one implementation.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ArtifactValidity, CheckReport, MotionCheck, ProjectValidity, SourceStamp } from "../../shared/types"
import { assemblyStampAt, currentPartStampAt, partOverridesAt, stampReasons } from "./revision"
import { getProject, projectDir } from "./store"

type PartLike = { id: string; file: string }

export const GUIDE_STAMP_REL = "build/assembly-guide.json"
export const GUIDE_HTML_REL = "build/assembly-guide.html"
export const MOTION_RECORD_REL = "build/motion-check.json" // = assembly/index.ts MOTION_CHECK_REL

function readJson<T>(abs: string): T | null {
  try {
    return JSON.parse(readFileSync(abs, "utf8")) as T
  } catch {
    return null
  }
}

function writeJsonAtomic(abs: string, data: unknown) {
  mkdirSync(join(abs, ".."), { recursive: true })
  writeFileSync(`${abs}.tmp`, JSON.stringify(data, null, 2) + "\n")
  renameSync(`${abs}.tmp`, abs)
}

const missing = (): ArtifactValidity => ({ state: "missing", reasons: [], builtAt: null })
function judge(recorded: SourceStamp | null | undefined, current: SourceStamp, builtAt: string | null): ArtifactValidity {
  const reasons = stampReasons(recorded, current)
  return { state: reasons.length ? "stale" : "fresh", reasons, builtAt }
}

// ---- parts ----

interface RenderRecord {
  hash?: string
  files?: SourceStamp["files"]
  params?: SourceStamp["params"]
  builtAt?: string
  error?: string
}

/** build/<part>.stl + preview PNGs vs the part's sources now. */
export function renderValidityAt(root: string, part: PartLike, current = currentPartStampAt(root, part)): ArtifactValidity {
  const meta = readJson<RenderRecord>(join(root, "build", `${part.id}.render.json`))
  if (!meta?.hash) return missing()
  // Renders from before R07 have the hash but no per-file map: still comparable, just less specific.
  const recorded: SourceStamp = { hash: meta.hash, files: meta.files ?? current.files, params: meta.params ?? null }
  return judge(recorded, current, meta.builtAt ?? null)
}

/** .studio/checks/<part>.json vs the part's sources now. */
export function checkValidityAt(root: string, part: PartLike, current = currentPartStampAt(root, part)): ArtifactValidity {
  const report = readJson<CheckReport>(join(root, ".studio", "checks", `${part.id}.json`))
  if (!report) return missing()
  return judge(report.source, current, report.createdAt ?? null)
}

// ---- assembly ----

export interface GuideStamp {
  source: SourceStamp
  builtAt: string
}
/** build/motion-check.json. `inputs` was a bare hash before R07 (such records read as out of date). */
export interface MotionRecord {
  inputs: SourceStamp | string
  check: MotionCheck
}

export function writeGuideStamp(root: string, source: SourceStamp) {
  writeJsonAtomic(join(root, GUIDE_STAMP_REL), { source, builtAt: new Date().toISOString() } satisfies GuideStamp)
}

/** Persist a motion check with the assembly stamp it was run against. */
export function writeMotionRecord(root: string, inputs: SourceStamp, check: MotionCheck) {
  writeJsonAtomic(join(root, MOTION_RECORD_REL), { inputs, check } satisfies MotionRecord)
}

export function readMotionRecord(root: string): MotionRecord | null {
  const r = readJson<MotionRecord>(join(root, MOTION_RECORD_REL))
  return r?.check ? r : null
}

/** The picture guide (and the step renders + shopping list built with it) vs the assembly's sources now. */
export function guideValidityAt(root: string, parts: PartLike[], current = assemblyStampAt(root, parts)): ArtifactValidity {
  if (!existsSync(join(root, GUIDE_HTML_REL))) return missing()
  const s = readJson<GuideStamp>(join(root, GUIDE_STAMP_REL))
  return judge(s?.source, current, s?.builtAt ?? null)
}

/** The last check_motion vs the assembly's sources now. */
export function motionValidityAt(root: string, parts: PartLike[], current = assemblyStampAt(root, parts)): ArtifactValidity {
  const r = readMotionRecord(root)
  if (!r) return missing()
  return judge(typeof r.inputs === "object" ? r.inputs : null, current, r.check.checkedAt ?? null)
}

// ---- the whole project (GET /api/projects/:id/validity) ----

export async function projectValidity(projectId: string): Promise<ProjectValidity> {
  const project = await getProject(projectId)
  const root = projectDir(projectId)
  const parts: ProjectValidity["parts"] = {}
  for (const p of project.parts) {
    const current = currentPartStampAt(root, p)
    parts[p.id] = {
      source: current.hash,
      overrides: partOverridesAt(root, p.id),
      render: renderValidityAt(root, p, current),
      check: checkValidityAt(root, p, current),
    }
  }
  let assembly: ProjectValidity["assembly"] = null
  const asmJson = readJson<{ motions?: unknown[] }>(join(root, "assembly.json"))
  if (existsSync(join(root, "assembly.json"))) {
    const current = assemblyStampAt(root, project.parts)
    const hasMotions = (asmJson?.motions?.length ?? 0) > 0
    assembly = {
      source: current.hash,
      guide: guideValidityAt(root, project.parts, current),
      motion: hasMotions ? motionValidityAt(root, project.parts, current) : null,
    }
  }
  return { parts, assembly }
}

/** One line for a stale artifact: "lib/params.scad changed; Customizer values changed (width)". */
export const reasonLine = (v: ArtifactValidity) => v.reasons.join("; ")
