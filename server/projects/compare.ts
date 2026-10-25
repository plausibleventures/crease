// R22: compare two ideas (branches) or two saved versions (commits) side by side, read-only.
//
// Each side resolves to a commit sha (a stable reference; "current" = the open files, including unsaved edits) whose
// files are extracted into build/compare/<key>/src (gitignored, never the project's own files) and built there:
// each part's STL (sizes, volume), a colour model of the whole thing (3D overlay) and, per pair, one picture of each
// side from the SAME camera so sizes compare by eye. Snapshots are cached by content, so comparing again after new
// commits gives the same answer for the same versions.
//
// Filament and time: the slicer's numbers when a print job was sliced from exactly these part sources (both sides),
// else a rough estimate from the part volumes for both (labelled). Time is scaled by the machine's measured factor.
// Design decisions: the designer's plan cards and the user's asks from the idea's chats, and the saved changes since
// the two sides split; only what the other side doesn't share.
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { promisify } from "node:util"
import { simpleGit } from "simple-git"
import type {
  Assembly,
  BomCategory,
  CompareRef,
  CompareSide,
  ComparePart,
  IdeaComparison,
  IdeaDesigner,
  PrintJob,
  Project,
  Vec3,
} from "../../shared/types"
import { currentBranch, getProject, httpError, projectDir } from "./store"
import { listIdeas, sessionsOfIdea } from "./ideas"
import { currentIdeaAt, partOverridesAt, partStampAt, partsWithOverrides, SHARED_KEY, sharedOverridesAt, walkScad, type ParamValue } from "./revision"
import { declaredParameters } from "../cad/customizer"
import { parseParamsTrailer, snapshotPartValues, type ParamSnapshot } from "./param-snapshot"

/** Whose Customizer overrides a side uses (R22: per idea): its idea, else (a version no idea holds) the open one. */
const ideaOfRef = (root: string, ref: CompareRef) => ref.branch ?? currentIdeaAt(root)
import { placedBox } from "./overview"
import { validateAssembly } from "../assembly/schema"
import { buildBom, readBin, readHave } from "../assembly/bom"
import { partsBinFile } from "../assembly/index"
import { DEFAULT_SOURCING } from "../assembly/stores"
import { getSettings } from "../config"
import { openscadEngine } from "../cad/index"
import { runOpenscad, parseCustomizer } from "../cad/openscad"
import { colorschemeArg } from "../cad/scheme"
import { displayUrl } from "../cad/display"
import { previewSource } from "../cad/preview"
import { isPartFile, isSculptFile, partSourceText, partIdOf } from "../cad/sculpt"
import { buildSculpt } from "../cad/blender"
import { analyzeStl } from "../cad/mesh"
import { projectMachine } from "../jobs/index"
import { adjustedTimeFor } from "../outcomes/time"
import { readEvents } from "../agent/transcript"

const run = promisify(execFile)
const SNAP_VERSION = 2 // 2: shared Customizer values (one value for every part that has the setting)
const KEEP_SNAPSHOTS = 16

// Rough-estimate constants (labelled as estimates wherever shown).
export const PLA_G_PER_CM3 = 1.24
export const SOLID_FRACTION = 0.5 // walls + typical infill, as a share of the solid volume
export const DEFAULT_S_PER_G = 150
export const FILAMENT_USD_PER_KG = 20

type Box = { min: Vec3; max: Vec3 }
type Params = Record<string, ParamValue>

/* ------------------------------------------------------------------------------------------------------------- */
/* References                                                                                                     */
/* ------------------------------------------------------------------------------------------------------------- */

const git = (projectId: string) => simpleGit({ baseDir: projectDir(projectId) })

async function isDirty(projectId: string) {
  return (await git(projectId).status()).files.length > 0
}

async function commitInfo(projectId: string, rev: string) {
  const out = (await git(projectId).raw(["log", "-1", "--format=%H%x1f%h%x1f%aI%x1f%s", rev])).trim()
  const [commit, short, date, subject] = out.split("\x1f")
  return { commit, short, date, message: subject.replace(/^(agent|user):\s*/, "") }
}

/** Resolve "current", an idea's branch or a version's commit to a stable reference. */
export async function resolveRef(projectId: string, ref: string): Promise<CompareRef> {
  const r = String(ref ?? "").trim()
  if (!r || r.length > 100) throw httpError(400, "pick an idea or a version to compare")
  const ideas = await listIdeas(projectId)
  const g = git(projectId)
  const cur = ideas.ideas.find((i) => i.current)
  const ideaOf = async (commit: string) => {
    if (cur && (await g.raw(["merge-base", "--is-ancestor", commit, cur.branch]).then(() => true, () => false))) return cur
    for (const i of ideas.ideas) if (await g.raw(["merge-base", "--is-ancestor", commit, i.branch]).then(() => true, () => false)) return i
    return null
  }
  if (r === "current" || (cur && r === cur.branch)) {
    const info = await commitInfo(projectId, "HEAD")
    const unsaved = await isDirty(projectId)
    return {
      ref: r,
      kind: r === "current" ? "current" : "idea",
      ...info,
      idea: cur?.name ?? null,
      branch: cur?.branch ?? null,
      label: r === "current" ? `${cur?.name ?? "This idea"} (now)` : (cur?.name ?? "This idea"),
      unsaved,
    }
  }
  const idea = ideas.ideas.find((i) => i.branch === r)
  if (idea) {
    const info = await commitInfo(projectId, `refs/heads/${idea.branch}`)
    return { ref: r, kind: "idea", ...info, idea: idea.name, branch: idea.branch, label: idea.name, unsaved: false }
  }
  if (!/^[0-9a-f]{4,40}$/i.test(r)) throw httpError(404, `no idea or version called ${r}`)
  let full: string
  try {
    full = (await g.raw(["rev-parse", "--verify", "--quiet", `${r}^{commit}`])).trim()
  } catch {
    throw httpError(404, `version not found: ${r}`)
  }
  if (!full) throw httpError(404, `version not found: ${r}`)
  const info = await commitInfo(projectId, full)
  const owner = await ideaOf(full)
  return { ref: r, kind: "version", ...info, idea: owner?.name ?? null, branch: owner?.branch ?? null, label: `“${info.message || "Saved version"}”`, unsaved: false }
}

/* ------------------------------------------------------------------------------------------------------------- */
/* Snapshots: one version's files, built outside the project's own folders                                        */
/* ------------------------------------------------------------------------------------------------------------- */

interface SnapPart extends ComparePart {
  file: string
  bbox: Box | null
  volumeMm3: number | null
  params: Params
  paramInfo: Record<string, string>
  stamp: { files: Record<string, string>; params: Params | null }
}

export interface Snapshot {
  version: number
  key: string
  name: string
  intent: string | null
  parts: SnapPart[]
  assembly: Assembly | null
  scene: { basis: "assembled" | "part" | "laid-out"; box: Box; scad: string; params: Params | null } | null
  model: string | null // project-relative path of the scene's colour model
  /** Sizes in shared lib/ files the parts include (e.g. lib/params.scad): design values outside the Customizer. */
  shared: { params: Params; info: Record<string, string> }
}

/** Key of the shared lib/ values in CompareSide.params. */
export const SHARED = "(shared)"

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Top-level `name = literal;` values of lib/ files the parts include, with their comment as the description; a
 * saved shared Customizer value replaces the file's.
 */
function sharedValues(src: string, partFiles: string[], saved: Record<string, ParamValue>): Snapshot["shared"] {
  const libs = new Set<string>()
  for (const f of partFiles)
    walkScad(join(src, f), src, (abs, buf) => {
      const rel = relative(src, abs)
      if (buf && rel.startsWith("lib/") && !/studio_assembly/.test(rel)) libs.add(abs)
    })
  const params: Params = {}
  const info: Record<string, string> = {}
  for (const abs of [...libs].sort()) {
    const text = readFileSync(abs, "utf8")
    for (const d of parseCustomizer(text)) {
      params[d.name] = saved[d.name] ?? d.value
      const trailing = text.match(new RegExp(`^\\s*${escapeRe(d.name)}\\s*=[^;]*;\\s*//\\s*(.+)$`, "m"))?.[1]
      const desc = d.description ?? (trailing && !trailing.startsWith("[") ? trailing.trim() : undefined)
      if (desc) info[d.name] = desc
    }
  }
  return { params, info }
}

const compareRoot = (projectId: string) => join(projectDir(projectId), "build", "compare")
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex")

/** Content key of the open files (tracked + new, not ignored): the "current" snapshot. */
async function workingKey(projectId: string): Promise<{ key: string; files: string[] }> {
  const root = projectDir(projectId)
  const out = await git(projectId).raw(["ls-files", "-co", "--exclude-standard", "-z"])
  const files = out.split("\0").filter((f) => f && existsSync(join(root, f)) && statSync(join(root, f)).isFile()).sort()
  const h = createHash("sha256")
  for (const f of files) h.update(`${f}\0`).update(readFileSync(join(root, f)))
  return { key: `wt-${h.digest("hex").slice(0, 16)}`, files }
}

function overridesKey(root: string, partIds: string[], idea: string): string {
  const o = Object.fromEntries(partIds.sort().map((id) => [id, partOverridesAt(root, id, idea)]))
  o[SHARED_KEY] = sharedOverridesAt(root, idea)
  return sha(JSON.stringify(o)).slice(0, 8)
}

/**
 * U2: a saved version recorded its slider values (commit trailer); compare builds it with those. null = an idea's
 * tip, the open files, or a version from before values were recorded: use the idea's current values.
 */
async function recordedParams(projectId: string, ref: CompareRef): Promise<ParamSnapshot | null> {
  if (ref.kind !== "version" || ref.unsaved) return null
  const body = await git(projectId)
    .raw(["log", "-1", "--format=%B", ref.commit])
    .catch(() => "")
  return parseParamsTrailer(body)
}

async function extract(projectId: string, ref: CompareRef, srcDir: string) {
  rmSync(srcDir, { recursive: true, force: true })
  mkdirSync(srcDir, { recursive: true })
  const root = projectDir(projectId)
  if (ref.unsaved || ref.kind === "current") {
    const { files } = await workingKey(projectId)
    for (const f of files) {
      if (f.startsWith("build/") || f.startsWith("renders/") || f.startsWith(".studio/")) continue
      mkdirSync(dirname(join(srcDir, f)), { recursive: true })
      cpSync(join(root, f), join(srcDir, f))
    }
    return
  }
  const tar = join(srcDir, "..", "src.tar")
  await run("git", ["-C", root, "archive", "--format=tar", "-o", tar, ref.commit])
  await run("tar", ["-xf", tar, "-C", srcDir])
  rmSync(tar, { force: true })
}

function readJsonAt<T>(abs: string): T | null {
  try {
    return JSON.parse(readFileSync(abs, "utf8")) as T
  } catch {
    return null
  }
}

/** Parts of an extracted project: project.json's list (files that exist) plus parts/*.scad / *.blend.py it doesn't list. */
function snapParts(src: string): { project: Partial<Project>; parts: Project["parts"] } {
  const project = readJsonAt<Partial<Project>>(join(src, "project.json")) ?? {}
  const listed = (project.parts ?? []).filter((p) => p && typeof p.file === "string" && existsSync(join(src, p.file)))
  const known = new Set(listed.map((p) => p.file))
  const extra = existsSync(join(src, "parts"))
    ? readdirSync(join(src, "parts"))
        .filter((f) => isPartFile(f) && !known.has(`parts/${f}`))
        .sort()
        .map((f) => ({ id: partIdOf(f), file: `parts/${f}`, qty: 1, colors: [] as string[] }))
    : []
  return { project, parts: [...listed, ...extra] }
}

const building = new Map<string, Promise<Snapshot>>()

/** Build (or reuse) the snapshot of one side. Never touches the project's own files outside build/compare/. */
export async function snapshotOf(projectId: string, ref: CompareRef): Promise<Snapshot> {
  const root = projectDir(projectId)
  const base = ref.unsaved || ref.kind === "current" ? (await workingKey(projectId)).key : ref.commit.slice(0, 16)
  // which parts exist isn't known before extraction; overrides are keyed by every part that has any on this side's idea
  const idea = ideaOfRef(root, ref)
  const recorded = await recordedParams(projectId, ref)
  const key = `${base}-${recorded ? `v${sha(JSON.stringify(recorded)).slice(0, 7)}` : overridesKey(root, partsWithOverrides(root, idea), idea)}`
  const k = `${projectId}/${key}`
  const pending = building.get(k)
  if (pending) return pending
  const p = buildSnapshot(projectId, ref, key, recorded).finally(() => building.delete(k))
  building.set(k, p)
  return p
}

async function buildSnapshot(projectId: string, ref: CompareRef, key: string, recorded: ParamSnapshot | null): Promise<Snapshot> {
  const root = projectDir(projectId)
  const dir = join(compareRoot(projectId), key)
  const cached = readJsonAt<Snapshot>(join(dir, "snapshot.json"))
  if (cached?.version === SNAP_VERSION) return cached
  pruneSnapshots(projectId)
  const src = join(dir, "src")
  const out = join(dir, "out")
  await extract(projectId, ref, src)
  mkdirSync(out, { recursive: true })
  const { project, parts: refs } = snapParts(src)

  let assembly: Assembly | null = null
  const rawAsm = readJsonAt<unknown>(join(src, "assembly.json"))
  if (rawAsm) {
    const v = validateAssembly(rawAsm, refs.map((p) => p.id))
    if (!v.errors.length) assembly = v.assembly
  }

  const parts: SnapPart[] = await Promise.all(
    refs.map(async (pr): Promise<SnapPart> => {
      const scad = join(src, pr.file)
      const overrides = recorded ? snapshotPartValues(recorded, pr.id) : partOverridesAt(root, pr.id, ideaOfRef(root, ref))
      let declared: ReturnType<typeof parseCustomizer> = []
      try {
        declared = parseCustomizer(partSourceText(scad))
      } catch {
        /* unreadable: no parameters */
      }
      // the build uses every setting the part has (its include<>d files' too); the list shows its own
      const names = new Set(declaredParameters(scad, src).map((d) => d.name))
      const used = overrides ? Object.fromEntries(Object.entries(overrides).filter(([n]) => names.has(n))) : null
      const params: Params = Object.fromEntries(declared.map((d) => [d.name, used?.[d.name] ?? d.value]))
      const paramInfo = Object.fromEntries(declared.filter((d) => d.description).map((d) => [d.name, d.description!]))
      const stamp = partStampAt(scad, used && Object.keys(used).length ? used : undefined, src)
      const ap = assembly?.parts.find((x) => x.id === pr.id)
      const base = {
        id: pr.id,
        file: pr.file,
        name: ap?.name ?? pr.id,
        qty: ap?.qty ?? pr.qty ?? 1,
        colors: pr.colors?.length ? pr.colors : ap?.color ? [ap.color] : [],
        params,
        paramInfo,
        stamp: { files: stamp.files, params: stamp.params ?? null },
      }
      try {
        const stl = join(out, `${pr.id}.stl`)
        // a Blender part: build its mesh from this version's script (cached under the snapshot's build/)
        const geo = isSculptFile(pr.file) ? (await buildSculpt(src, pr.id, pr.file, used)).wrapperAbs : scad
        await openscadEngine.export(geo, stl, used ?? undefined)
        const a = await analyzeStl(readFileSync(stl))
        const r1 = (v: number) => Math.round(v * 10) / 10
        return { ...base, sizeMm: a.stats.sizeMm.map(r1) as Vec3, bbox: a.stats.bbox, volumeMm3: a.stats.volumeMm3, error: null }
      } catch (e) {
        return { ...base, sizeMm: null, bbox: null, volumeMm3: null, error: (e as Error).message.split("\n")[0].slice(0, 200) }
      }
    }),
  )

  // The whole thing: assembled (placements), the one part, or every part laid out in a row.
  let scene: Snapshot["scene"] = null
  let model: string | null = null
  const ok = parts.filter((p) => p.bbox)
  const colorOf = (p: SnapPart) => {
    const c = p.colors[0]
    return c && (/^#[0-9a-f]{3,8}$/i.test(c) || /^[a-z]+$/i.test(c)) ? c.toLowerCase() : null
  }
  const imp = (p: SnapPart) => `import(${JSON.stringify(join(out, `${p.id}.stl`))});`
  const colored = (p: SnapPart, body: string) => (colorOf(p) ? `color(${JSON.stringify(colorOf(p))}) ${body}` : body)
  if (assembly?.placements?.length && assembly.placements.every((pl) => parts.find((p) => p.id === pl.part)?.bbox)) {
    const lo: Vec3 = [Infinity, Infinity, Infinity]
    const hi: Vec3 = [-Infinity, -Infinity, -Infinity]
    const lines: string[] = []
    for (const pl of assembly.placements) {
      const p = parts.find((x) => x.id === pl.part)!
      const b = placedBox(p.bbox!.min, p.bbox!.max, pl.rotate, pl.translate)
      for (let i = 0; i < 3; i++) {
        lo[i] = Math.min(lo[i], b.min[i])
        hi[i] = Math.max(hi[i], b.max[i])
      }
      lines.push(`translate(${JSON.stringify(pl.translate)}) rotate(${JSON.stringify(pl.rotate ?? [0, 0, 0])}) ${colored(p, imp(p))}`)
    }
    const scad = join(out, "scene.scad")
    writeFileSync(scad, `// generated by Crease (compare)\n${lines.join("\n")}\n`)
    scene = { basis: "assembled", box: { min: lo, max: hi }, scad, params: null }
  } else if (parts.length === 1 && ok.length === 1) {
    const p = ok[0]
    const scadSrc = isSculptFile(p.file) ? join(src, "build", `${p.id}.blend.scad`) : join(src, p.file)
    const preview = join(dirname(scadSrc), `${p.id}.compare-preview.scad`)
    writeFileSync(preview, previewSource(readFileSync(scadSrc, "utf8"), dirname(scadSrc)))
    const used = p.stamp.params
    scene = { basis: "part", box: p.bbox!, scad: preview, params: used }
  } else if (ok.length) {
    const lines: string[] = []
    let x = 0
    let depth = 0
    let height = 0
    for (const p of ok) {
      const b = p.bbox!
      const w = b.max[0] - b.min[0]
      lines.push(`translate([${x - b.min[0]}, ${-(b.min[1] + b.max[1]) / 2}, ${-b.min[2]}]) ${colored(p, imp(p))}`)
      x += w + 10
      depth = Math.max(depth, b.max[1] - b.min[1])
      height = Math.max(height, b.max[2] - b.min[2])
    }
    const scad = join(out, "scene.scad")
    writeFileSync(scad, `// generated by Crease (compare)\n${lines.join("\n")}\n`)
    scene = { basis: "laid-out", box: { min: [0, -depth / 2, 0], max: [x - 10, depth / 2, height] }, scad, params: null }
  }
  if (scene) {
    try {
      await openscadEngine.export(scene.scad, join(out, "scene.3mf"), scene.params ?? undefined)
      model = relative(root, join(out, "scene.3mf"))
    } catch {
      model = null
    }
  }

  const snap: Snapshot = {
    version: SNAP_VERSION,
    key,
    name: project.name ?? "",
    intent: (project as { intent?: string }).intent ?? null,
    parts,
    assembly,
    scene,
    model,
    shared: sharedValues(src, refs.map((p) => p.file), recorded ? (recorded[SHARED_KEY] ?? {}) : sharedOverridesAt(root, ideaOfRef(root, ref))),
  }
  writeFileSync(join(dir, "snapshot.json"), JSON.stringify(snap, null, 2))
  return snap
}

function pruneSnapshots(projectId: string) {
  const dir = compareRoot(projectId)
  if (!existsSync(dir)) return
  const all = readdirSync(dir)
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  for (const { f } of all.slice(KEEP_SNAPSHOTS)) rmSync(join(dir, f), { recursive: true, force: true })
}

/** One picture of a side, from a camera shared by both sides (fits the union of both). */
async function renderSide(projectId: string, snap: Snapshot, union: Box): Promise<string | null> {
  if (!snap.scene) return null
  const c = [0, 1, 2].map((i) => (union.min[i] + union.max[i]) / 2)
  const r = Math.hypot(...[0, 1, 2].map((i) => union.max[i] - union.min[i])) / 2
  const dist = Math.max(10, r / Math.sin((11.25 * Math.PI) / 180) * 1.05)
  const cam = [...c, 55, 0, 25, dist].map((v) => Math.round(v * 100) / 100)
  const name = `view-${sha(cam.join(",")).slice(0, 10)}.png`
  const out = join(compareRoot(projectId), snap.key, "out", name)
  if (!existsSync(out)) {
    const params = Object.entries(snap.scene.params ?? {}).flatMap(([k, v]) => ["-D", `${k}=${typeof v === "string" ? JSON.stringify(v) : String(v)}`])
    try {
      await runOpenscad(
        ["--render", "-o", out, ...params, `--camera=${cam.join(",")}`, "--imgsize=800,600", `--colorscheme=${colorschemeArg("dark")}`, snap.scene.scad],
        dirname(snap.scene.scad),
      )
    } catch {
      return null
    }
  }
  return relative(projectDir(projectId), out)
}

/* ------------------------------------------------------------------------------------------------------------- */
/* Filament, time and cost                                                                                        */
/* ------------------------------------------------------------------------------------------------------------- */

const sameStamp = (a: { files: Record<string, string>; params?: Params | null } | undefined, b: SnapPart["stamp"]) =>
  !!a && JSON.stringify(Object.entries(a.files).sort()) === JSON.stringify(Object.entries(b.files).sort()) && JSON.stringify(a.params ?? null) === JSON.stringify(b.params ?? null)

function allJobs(projectId: string): PrintJob[] {
  const dir = join(projectDir(projectId), ".studio", "jobs")
  if (!existsSync(dir)) return []
  const out: PrintJob[] = []
  for (const id of readdirSync(dir)) {
    const j = readJsonAt<PrintJob>(join(dir, id, "job.json"))
    if (j?.source) out.push(j)
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** The slicer's numbers for exactly these sources: every part's own newest matching slice, or the latest plate set. */
export function slicedNumbers(jobs: PrintJob[], plateSet: string[] | null, parts: SnapPart[]): { grams: number; timeS: number; jobs: PrintJob[] } | null {
  const printed = parts.filter((p) => p.qty > 0)
  if (!printed.length) return null
  const matches = (j: PrintJob) => j.parts.every((jp) => sameStamp(j.source.stamps?.[jp.partId], parts.find((p) => p.id === jp.partId)?.stamp ?? { files: { "?": "?" }, params: null }))
  const sum = (js: PrintJob[], scale: (j: PrintJob) => number) =>
    js.every((j) => j.filamentG != null && j.estimatedTimeS != null)
      ? { grams: js.reduce((n, j) => n + j.filamentG! * scale(j), 0), timeS: js.reduce((n, j) => n + j.estimatedTimeS! * scale(j), 0), jobs: js }
      : null
  if (plateSet?.length) {
    const set = plateSet.map((id) => jobs.find((j) => j.id === id)).filter((j): j is PrintJob => !!j)
    const covered = new Set(set.flatMap((j) => j.parts.map((p) => p.partId)))
    // the plates must hold exactly this side's pieces: every printed part, at its quantity (else per-part slices)
    const onPlates = (id: string) => set.reduce((n, j) => n + j.parts.filter((x) => x.partId === id).reduce((m, x) => m + x.qty, 0), 0)
    if (set.length === plateSet.length && set.every(matches) && printed.every((p) => covered.has(p.id) && onPlates(p.id) === p.qty)) {
      const r = sum(set, () => 1)
      if (r) return r
    }
  }
  const per: PrintJob[] = []
  for (const p of printed) {
    const j = jobs.find((x) => x.kind === "part" && x.parts.length === 1 && x.parts[0].partId === p.id && matches(x))
    if (!j) return null
    per.push(j)
  }
  return sum(per, (j) => (parts.find((p) => p.id === j.parts[0].partId)?.qty ?? 1) / Math.max(1, j.parts[0].qty))
}

export function estimateGrams(parts: { qty: number; volumeMm3: number | null }[]): number | null {
  if (!parts.length || parts.some((p) => p.volumeMm3 == null)) return null
  return parts.reduce((n, p) => n + (p.qty * p.volumeMm3!) / 1000, 0) * PLA_G_PER_CM3 * SOLID_FRACTION
}

/* ------------------------------------------------------------------------------------------------------------- */
/* Decisions                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------- */

type Decision = CompareSide["decisions"][number]

function sessionDecisions(projectId: string, sessionIds: string[], until: string | null): Decision[] {
  const out: Decision[] = []
  const seen = new Set<string>()
  for (const sid of sessionIds) {
    let events: ReturnType<typeof readEvents>
    try {
      events = readEvents(projectId, sid)
    } catch {
      continue
    }
    for (const e of events) {
      if (until && e.ts > until) continue
      const ev = e.event
      let d: Decision | null = null
      if (ev.type === "tool.started" && /(^|__)share_plan$/.test(ev.name) && ev.input && typeof ev.input === "object") {
        const inp = ev.input as { title?: unknown; bullets?: unknown }
        const bullets = Array.isArray(inp.bullets) ? inp.bullets.filter((b): b is string => typeof b === "string") : []
        if (bullets.length) d = { kind: "plan", text: [typeof inp.title === "string" && inp.title ? `${inp.title}:` : "", bullets.join(" · ")].filter(Boolean).join(" "), at: e.ts }
      } else if (ev.type === "run.started" && ev.input?.text?.trim()) {
        d = { kind: "ask", text: ev.input.text.trim().replace(/\s+/g, " ").slice(0, 240), at: e.ts }
      }
      if (d && !seen.has(`${d.kind}:${d.text}`)) {
        seen.add(`${d.kind}:${d.text}`)
        out.push(d)
      }
    }
  }
  return out
}

/**
 * R11g: who worked on an idea: each chat's runtime, designer, model and version (from its own transcript) and its own
 * cost (the parent's copied cost at a fork excluded). Billed = "known", an API-price estimate = "estimated", nothing
 * reported = "unknown" (never 0).
 */
export function ideaDesigners(projectId: string, sessions: Project["sessions"]): IdeaDesigner[] {
  const out: IdeaDesigner[] = []
  for (const x of sessions) {
    let events: ReturnType<typeof readEvents>
    try {
      events = readEvents(projectId, x.id)
    } catch {
      continue
    }
    let runtime = x.runtime ?? null
    let designer: string | null = null
    let model: string | null = x.model ?? null
    let version: string | null = null
    let billed: number | null = null
    let estimated: number | null = null
    let runs = 0
    for (const e of events) {
      const ev = e.event
      if (!runtime && e.runtime !== "app") runtime = e.runtime
      if (ev.type === "notice" && ev.code === "session.started") {
        const d = ev.data ?? {}
        if (typeof d.version === "string" && d.version) version = d.version
        if (typeof d.model === "string" && d.model) model = d.model
      } else if (ev.type === "run.started") {
        runs++
        if (ev.profile?.name) designer = ev.profile.name
        if (ev.profile?.runtime) runtime = ev.profile.runtime
        if (ev.model) model = ev.model
      } else if (ev.type === "usage.updated" || ev.type === "run.completed" || ev.type === "run.failed" || ev.type === "run.interrupted") {
        // money is cumulative per session: the largest reported total is the chat's
        const u = ev.type === "usage.updated" ? ev.usage : ev.result?.usage
        if (u?.billedUsd != null) billed = Math.max(billed ?? 0, u.billedUsd)
        if (u?.estimatedApiUsd != null) estimated = Math.max(estimated ?? 0, u.estimatedApiUsd)
      }
    }
    if (!runs && !x.handoff) continue // never used
    const total = billed ?? estimated
    const own = total != null ? Math.max(0, Math.round((total - (x.forkCostUsd ?? 0)) * 1e4) / 1e4) : runs ? null : 0
    out.push({
      sessionId: x.id,
      title: x.title,
      runtime: runtime ?? "claude",
      designer,
      model,
      version,
      costUsd: own,
      cost: billed != null ? "known" : estimated != null ? "estimated" : runs ? "unknown" : "known",
      handedOverFrom: x.handoff?.from || null,
    })
  }
  return out
}

async function commitDecisions(projectId: string, from: string | null, to: string): Promise<Decision[]> {
  const range = from ? `${from}..${to}` : to
  const raw = await git(projectId).raw(["log", "-n40", "--format=%aI%x1f%s", range]).catch(() => "")
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [at, s] = l.split("\x1f")
      return { kind: "change" as const, text: s.replace(/^(agent|user):\s*/, ""), at }
    })
    .filter((d) => d.text && !/^(work in progress|create project|keep app data out of versions)$/i.test(d.text))
}

/* ------------------------------------------------------------------------------------------------------------- */
/* Diff (pure)                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------- */

export interface SideData {
  size: CompareSide["size"]
  parts: ComparePart[]
  params: CompareSide["params"]
  paramInfo?: Record<string, Record<string, string>>
  grams: number | null
  timeS: number | null
  costUsd: number | null
  bom: CompareSide["bom"]
}

const r1 = (v: number) => Math.round(v * 10) / 10
const sameVec = (a: Vec3 | null, b: Vec3 | null, tol = 0.05) => (!a && !b) || (!!a && !!b && a.every((v, i) => Math.abs(v - b[i]) <= tol))

export function diffSides(a: SideData, b: SideData): IdeaComparison["diff"] {
  const ids = [...new Set([...a.parts.map((p) => p.id), ...b.parts.map((p) => p.id)])]
  const parts = ids.map((id) => {
    const pa = a.parts.find((p) => p.id === id) ?? null
    const pb = b.parts.find((p) => p.id === id) ?? null
    const change: IdeaComparison["diff"]["parts"][number]["change"] = !pa
      ? "added"
      : !pb
        ? "removed"
        : !sameVec(pa.sizeMm, pb.sizeMm)
          ? "resized"
          : pa.qty !== pb.qty
            ? "qty"
            : "same"
    return { id, name: (pb ?? pa)!.name, change, a: pa?.sizeMm ?? null, b: pb?.sizeMm ?? null, qtyA: pa?.qty ?? null, qtyB: pb?.qty ?? null }
  })
  const params: IdeaComparison["diff"]["params"] = []
  for (const id of [...new Set([...Object.keys(a.params), ...Object.keys(b.params)])]) {
    const A = a.params[id] ?? {}
    const B = b.params[id] ?? {}
    if (!a.params[id] || !b.params[id]) continue // a whole part added/removed is shown as a part change
    for (const name of [...new Set([...Object.keys(A), ...Object.keys(B)])]) {
      if (A[name] === B[name]) continue
      const description = b.paramInfo?.[id]?.[name] ?? a.paramInfo?.[id]?.[name]
      params.push({ partId: id, name, ...(description ? { description } : {}), a: A[name] ?? null, b: B[name] ?? null })
    }
  }
  const keys = [...new Set([...a.bom.map((x) => x.key), ...b.bom.map((x) => x.key)])]
  const bom: IdeaComparison["diff"]["bom"] = []
  for (const key of keys) {
    const ia = a.bom.find((x) => x.key === key)
    const ib = b.bom.find((x) => x.key === key)
    if (ia?.category === "printed" || ib?.category === "printed") continue // printed parts are the parts list
    if (ia?.category === "tool" || ib?.category === "tool") {
      if (ia && ib) continue
    }
    const name = (ib ?? ia)!.name
    if (!ia) bom.push({ key, name, change: "added", a: null, b: ib!.need })
    else if (!ib) bom.push({ key, name, change: "removed", a: ia.need, b: null })
    else if (ia.need !== ib.need || (ia.needText ?? "") !== (ib.needText ?? "")) bom.push({ key, name, change: "changed", a: ia.need, b: ib.need })
  }
  const sub = (x: number | null, y: number | null) => (x == null || y == null ? null : y - x)
  return {
    sizeMm: a.size && b.size ? ([0, 1, 2].map((i) => r1(b.size!.mm[i] - a.size!.mm[i])) as Vec3) : null,
    parts,
    params,
    bom,
    grams: sub(a.grams, b.grams),
    timeS: sub(a.timeS, b.timeS),
    costUsd: sub(a.costUsd, b.costUsd),
  }
}

const AXES: [string, string][] = [
  ["wider", "narrower"],
  ["deeper", "shallower"],
  ["taller", "shorter"],
]
const fmtMm = (v: number) => `${Math.abs(v) >= 10 ? Math.round(Math.abs(v)) : r1(Math.abs(v))} mm`
const count = (n: number, w: string) => `${n} ${w}${n === 1 || /s$/.test(w) ? "" : "s"}`
const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s)
const pluralWord = (w: string) => (/(s|x|ch|sh)$/.test(w) ? `${w}es` : /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`)
/** "2 magnets (6 × 3 mm)", "2 × M3x12 screw", "superglue (CA)" (no count). */
export function things(n: number | null, name: string): string {
  if (n == null) return lowerFirst(name)
  const m = name.match(/^([A-Za-z]+)(?:\s+(.*))?$/)
  if (!m) return `${n} × ${name}`
  const word = m[1].toLowerCase()
  return `${n} ${n === 1 ? word : pluralWord(word)}${m[2] ? ` (${m[2]})` : ""}`
}
function joinAnd(xs: string[]): string {
  if (xs.length <= 1) return xs[0] ?? ""
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`
}

/** "B is 12 mm taller, uses 8 g more filament and adds 2 magnets." (names: what to call A and B) */
export function summarize(d: IdeaComparison["diff"], names: { a: string; b: string } = { a: "A", b: "B" }): string {
  const bits: string[] = []
  if (d.sizeMm) {
    const sized = d.sizeMm.map((v, i) => ({ v, i })).filter((x) => Math.abs(x.v) >= 0.5)
    sized.sort((x, y) => Math.abs(y.v) - Math.abs(x.v))
    const words = sized.slice(0, 2).map(({ v, i }) => `${fmtMm(v)} ${AXES[i][v > 0 ? 0 : 1]}`)
    if (words.length) bits.push(`is ${joinAnd(words)}`)
  }
  if (d.grams != null && Math.abs(d.grams) >= 1) bits.push(`uses ${Math.round(Math.abs(d.grams))} g ${d.grams > 0 ? "more" : "less"} filament`)
  const added = d.parts.filter((p) => p.change === "added")
  const removed = d.parts.filter((p) => p.change === "removed")
  if (added.length) bits.push(`adds ${joinAnd(added.map((p) => `the ${lowerFirst(p.name)}`))}`)
  if (removed.length) bits.push(`drops ${joinAnd(removed.map((p) => `the ${lowerFirst(p.name)}`))}`)
  const buyAdd = d.bom.filter((x) => x.change === "added")
  const buyDrop = d.bom.filter((x) => x.change === "removed")
  const buyMore = d.bom.filter((x) => x.change === "changed" && x.a != null && x.b != null && x.a !== x.b)
  const needs = [
    ...buyAdd.map((x) => things(x.b, x.name)),
    ...buyMore.map((x) => things(Math.abs(x.b! - x.a!), x.name).replace(/^(\d+)( × )?/, `$1 ${x.b! > x.a! ? "more" : "fewer"}$2`)),
  ]
  if (needs.length) bits.push(`needs ${needs.slice(0, 2).join(" plus ")}${needs.length > 2 ? " and more" : ""}`)
  if (buyDrop.length) bits.push(`no longer needs ${joinAnd(buyDrop.slice(0, 2).map((x) => things(x.a, x.name)))}`)
  if (!bits.length) {
    const resized = d.parts.filter((p) => p.change === "resized")
    if (resized.length) bits.push(`changes the size of ${joinAnd(resized.map((p) => `the ${lowerFirst(p.name)}`))}`)
    else if (d.params.length) bits.push(`changes ${count(d.params.length, "setting")} (${joinAnd(d.params.slice(0, 2).map((p) => p.name))})`)
  }
  if (!bits.length) return `${names.a} and ${names.b} are the same design.`
  return `${names.b} ${joinAnd(bits)}.`
}

/* ------------------------------------------------------------------------------------------------------------- */
/* Comparison                                                                                                     */
/* ------------------------------------------------------------------------------------------------------------- */

function unionBox(boxes: (Box | null | undefined)[]): Box | null {
  const bs = boxes.filter((b): b is Box => !!b)
  if (!bs.length) return null
  const lo: Vec3 = [Infinity, Infinity, Infinity]
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const b of bs)
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], b.min[i])
      hi[i] = Math.max(hi[i], b.max[i])
    }
  return { min: lo, max: hi }
}

export async function compareIdeas(projectId: string, aRef: string, bRef: string): Promise<IdeaComparison> {
  const project = await getProject(projectId)
  const root = projectDir(projectId)
  const [ra, rb] = [await resolveRef(projectId, aRef), await resolveRef(projectId, bRef)]
  const [sa, sb] = await Promise.all([snapshotOf(projectId, ra), snapshotOf(projectId, rb)])
  const union = unionBox([sa.scene?.box, sb.scene?.box])
  const [ia, ib] = union ? await Promise.all([renderSide(projectId, sa, union), renderSide(projectId, sb, union)]) : [null, null]
  const url = (rel: string | null, v: string) => (rel ? displayUrl(projectId, rel.split("\\").join("/"), v) : null)

  // filament + time: the slicer's numbers when both sides were sliced as they are, else the same estimate for both
  const jobs = allJobs(projectId)
  const plateSet = readJsonAt<{ plateSet?: { jobIds?: string[] } }>(join(root, ".studio", "jobs", "state.json"))?.plateSet?.jobIds ?? null
  const slA = slicedNumbers(jobs, plateSet, sa.parts)
  const slB = slicedNumbers(jobs, plateSet, sb.parts)
  const sliced = !!slA && !!slB
  const ratios = jobs.filter((j) => j.filamentG && j.estimatedTimeS).map((j) => j.estimatedTimeS! / j.filamentG!)
  const sPerG = ratios.length ? ratios.sort((x, y) => x - y)[Math.floor(ratios.length / 2)] : DEFAULT_S_PER_G
  const machine = await projectMachine(projectId).catch(() => null)
  const intent = (project.intent ?? "standard") as PrintJob["intent"]
  const scope = machine
    ? { machineId: machine.id, nozzleMm: machine.nozzleMm, material: machine.filaments.find((f) => f.loaded)?.material ?? "PLA", intent }
    : null

  const sourcing = getSettings().sourcing ?? DEFAULT_SOURCING
  const have = readHave(root)
  const bin = readBin(partsBinFile())

  const side = (ref: CompareRef, snap: Snapshot, sl: ReturnType<typeof slicedNumbers>, imageRel: string | null): CompareSide & { paramInfo: Record<string, Record<string, string>> } => {
    const grams = sliced ? sl!.grams : estimateGrams(snap.parts)
    const timeS = sliced ? sl!.timeS : grams != null ? grams * sPerG : null
    const jobScope = sliced && sl!.jobs[0] ? { machineId: sl!.jobs[0].machineId, nozzleMm: sl!.jobs[0].machine?.nozzleMm ?? 0.4, material: scope?.material ?? "PLA", intent: sl!.jobs[0].intent } : scope
    const adj = timeS && jobScope ? adjustedTimeFor(jobScope, timeS) : null
    const bomP = buildBom({
      project: { ...project, parts: snap.parts.map((p) => ({ id: p.id, file: p.file, qty: p.qty, colors: p.colors })) },
      assembly: snap.assembly,
      sourcing,
      have,
      bin,
    })
    const buy = bomP.items.filter((i) => i.category === "purchased" || i.category === "consumable")
    const priced = buy.filter((i) => i.estCost)
    const suppliesUsd = priced.length ? priced.reduce((n, i) => n + i.estCost!.usd, 0) : buy.length ? null : 0
    const filamentUsd = grams != null ? (grams * FILAMENT_USD_PER_KG) / 1000 : null
    const snapSize = snap.scene ? ([0, 1, 2].map((i) => r1(snap.scene!.box.max[i] - snap.scene!.box.min[i])) as Vec3) : null
    return {
      ref,
      imageUrl: url(imageRel, snap.key),
      modelUrl: url(snap.model, snap.key),
      size: snap.scene && snapSize ? { mm: snapSize, basis: snap.scene.basis } : null,
      parts: snap.parts.map(({ id, name, qty, colors, sizeMm, error }) => ({ id, name, qty, colors, sizeMm, error })),
      params: {
        ...Object.fromEntries(snap.parts.map((p) => [p.id, p.params])),
        ...(Object.keys(snap.shared.params).length ? { [SHARED]: snap.shared.params } : {}),
      },
      paramInfo: { ...Object.fromEntries(snap.parts.map((p) => [p.id, p.paramInfo])), [SHARED]: snap.shared.info },
      filament: {
        grams: grams != null ? r1(grams) : null,
        timeS: timeS != null ? Math.round(timeS) : null,
        adjustedS: adj ? Math.round(adj.estimatedTimeS) : null,
        calibratedPrints: adj?.prints ?? 0,
        basis: sliced ? "sliced" : "estimate",
      },
      cost: {
        filamentUsd: filamentUsd != null ? Math.round(filamentUsd * 100) / 100 : null,
        suppliesUsd: suppliesUsd != null ? Math.round(suppliesUsd * 100) / 100 : null,
        totalUsd: filamentUsd != null && suppliesUsd != null ? Math.round((filamentUsd + suppliesUsd) * 100) / 100 : null,
        unpriced: buy.length - priced.length,
      },
      bom: bomP.items.map((i) => ({ key: i.key, name: i.name, category: i.category as BomCategory, need: i.need, ...(i.needText ? { needText: i.needText } : {}) })),
      decisions: [],
      designers: [],
    }
  }
  const A = side(ra, sa, slA, ia)
  const B = side(rb, sb, slB, ib)

  // decisions: what each side has that the other doesn't
  const cur = await currentBranch(projectId)
  const base = (await git(projectId).raw(["merge-base", ra.commit, rb.commit]).catch(() => "")).trim() || null
  const decisionsOf = async (ref: CompareRef) => {
    const sessions = ref.branch ? sessionsOfIdea(project, ref.branch, cur).map((x) => x.id) : []
    const until = ref.kind === "version" ? new Date(new Date(ref.date).getTime() + 60_000).toISOString() : null
    const changes = base && base !== ref.commit ? await commitDecisions(projectId, base, ref.commit) : []
    return [...sessionDecisions(projectId, sessions, until), ...changes]
  }
  const [da, db] = await Promise.all([decisionsOf(ra), decisionsOf(rb)])
  const key = (d: Decision) => `${d.kind}:${d.text}`
  const inA = new Set(da.map(key))
  const inB = new Set(db.map(key))
  A.decisions = da.filter((d) => !inB.has(key(d))).sort((x, y) => x.at.localeCompare(y.at)).slice(-12)
  B.decisions = db.filter((d) => !inA.has(key(d))).sort((x, y) => x.at.localeCompare(y.at)).slice(-12)
  // who designed each idea (runtime/model/version) and what it cost: comparing designers, not only designs
  for (const [S, ref] of [[A, ra], [B, rb]] as const) S.designers = ref.branch ? ideaDesigners(projectId, sessionsOfIdea(project, ref.branch, cur)) : []

  const diff = diffSides(
    { size: A.size, parts: A.parts, params: A.params, paramInfo: A.paramInfo, grams: A.filament.grams, timeS: A.filament.adjustedS ?? A.filament.timeS, costUsd: A.cost.totalUsd, bom: A.bom },
    { size: B.size, parts: B.parts, params: B.params, paramInfo: B.paramInfo, grams: B.filament.grams, timeS: B.filament.adjustedS ?? B.filament.timeS, costUsd: B.cost.totalUsd, bom: B.bom },
  )
  const same = !diff.parts.some((p) => p.change !== "same") && !diff.params.length && !diff.bom.length && (!diff.sizeMm || diff.sizeMm.every((v) => Math.abs(v) < 0.05))
  const notes: string[] = []
  if (!sliced) notes.push("Filament and time are rough estimates from the shape. Slice each idea for exact numbers.")
  if (A.filament.calibratedPrints || B.filament.calibratedPrints) notes.push("Times are adjusted by how long your earlier prints really took.")
  if (A.cost.unpriced || B.cost.unpriced) notes.push("Some things to buy have no price yet, so their cost isn't counted.")
  for (const s of [A, B]) for (const p of s.parts) if (p.error) notes.push(`${s.ref.label}: ${p.name} didn't build (${p.error}).`)
  if (ra.unsaved || rb.unsaved) notes.push("Includes changes not saved as a version yet.")
  const r = union ? Math.hypot(...[0, 1, 2].map((i) => union.max[i] - union.min[i])) / 2 : 0
  /* eslint-disable @typescript-eslint/no-unused-vars */
  const { paramInfo: _pa, ...a } = A
  const { paramInfo: _pb, ...b } = B
  /* eslint-enable @typescript-eslint/no-unused-vars */
  return {
    a,
    b,
    summary: same ? "These two are the same design." : summarize(diff, { a: "A", b: "B" }),
    same,
    diff,
    frame: union ? { center: [(union.min[0] + union.max[0]) / 2, (union.min[1] + union.max[1]) / 2], floorZ: union.min[2], radius: r } : null,
    notes,
  }
}

/** Plain-text brief of a comparison for the agent (compare_ideas). */
export function describeComparison(c: IdeaComparison): string {
  const name = (s: CompareSide, l: string) => `${l} = ${s.ref.label}${s.ref.kind === "version" && s.ref.idea ? ` (in ${s.ref.idea})` : ""}, version ${s.ref.short} from ${s.ref.date.slice(0, 16).replace("T", " ")}${s.ref.unsaved ? " + unsaved edits" : ""}`
  const mm = (v: Vec3 | null) => (v ? `${v.map((x) => r1(x)).join(" × ")} mm` : "unknown")
  const h = (s: number | null) => (s == null ? "unknown" : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`)
  const lines = [
    name(c.a, "A"),
    name(c.b, "B"),
    `Summary: ${c.summary}`,
    "",
    `Overall size (W × D × H): A ${mm(c.a.size?.mm ?? null)} · B ${mm(c.b.size?.mm ?? null)}`,
    `Filament: A ${c.a.filament.grams ?? "?"} g · B ${c.b.filament.grams ?? "?"} g (${c.a.filament.basis === "sliced" ? "from the slicer" : "rough estimate from volume"})`,
    `Print time: A ${h(c.a.filament.adjustedS ?? c.a.filament.timeS)} · B ${h(c.b.filament.adjustedS ?? c.b.filament.timeS)}`,
    `Cost (filament + things to buy): A $${c.a.cost.totalUsd ?? "?"} · B $${c.b.cost.totalUsd ?? "?"}`,
  ]
  const parts = c.diff.parts.filter((p) => p.change !== "same")
  if (parts.length) lines.push("", "Parts:", ...parts.map((p) => `- ${p.name}: ${p.change}${p.change === "resized" ? ` ${mm(p.a)} → ${mm(p.b)}` : p.change === "qty" ? ` ×${p.qtyA} → ×${p.qtyB}` : ""}`))
  if (c.diff.params.length) lines.push("", "Settings:", ...c.diff.params.map((p) => `- ${p.partId}.${p.name}${p.description ? ` (${p.description})` : ""}: ${p.a ?? "—"} → ${p.b ?? "—"}`))
  if (c.diff.bom.length) lines.push("", "Things to buy:", ...c.diff.bom.map((x) => `- ${x.name}: ${x.change} (${x.a ?? "—"} → ${x.b ?? "—"})`))
  for (const [l, s] of [["A", c.a], ["B", c.b]] as const)
    if (s.decisions.length) lines.push("", `Only in ${l}:`, ...s.decisions.map((d) => `- [${d.kind}] ${d.text}`))
  for (const [l, s] of [["A", c.a], ["B", c.b]] as const)
    if (s.designers?.length)
      lines.push(
        "",
        `Designed in ${l} by:`,
        ...s.designers.map((d) => `- ${d.designer ?? d.runtime}${d.model ? ` · ${d.model}` : ""}${d.version ? ` · v${d.version}` : ""}: ${d.costUsd != null ? `$${d.costUsd.toFixed(2)} (${d.cost})` : "cost unknown"}`),
      )
  if (c.notes.length) lines.push("", ...c.notes.map((n) => `Note: ${n}`))
  return lines.join("\n")
}
