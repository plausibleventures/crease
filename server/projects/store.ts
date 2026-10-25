// OWNER: projects/cad agent. Project folders on disk, each its own git repo.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs"
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import { simpleGit } from "simple-git"
import { PROJECTS_DIR } from "../config"
import { displayUrl } from "../cad/display"
import { isPartFile, partIdOf } from "../cad/sculpt"
import { PathError, canonicalSegments, resolveInside } from "./paths"
import { upsertProject } from "../db"
import { getDefaultMachine } from "../machines"
import type { Checkpoint, PartRef, Project, ProjectSummary } from "../../shared/types"
import { copyIdeaOverrides } from "./revision"
import { applyParamSnapshot, describeParamChange, paramSnapshotAt, paramsTrailer, parseParamsTrailer, snapshotKey, type ParamSnapshot } from "./param-snapshot"

/**
 * The printer a new project targets: the default printer (the practice printer when none is added yet). Always
 * explicit, so changing the default later never moves an existing project to another printer.
 */
const newProjectPrinter = () => getDefaultMachine().id

const ID_RE = /^[a-z0-9][a-z0-9-]*$/

export function projectDir(projectId: string): string {
  if (!ID_RE.test(projectId)) throw httpError(400, `invalid project id: ${projectId}`)
  return join(PROJECTS_DIR, projectId)
}

/**
 * Resolve a project-relative path, refusing anything outside the project folder or inside .git, judged by where the
 * path really lands (symlinks resolved, including the existing parent of a new file; see projects/paths.ts).
 * `within`: restrict to these top-level folders (e.g. ["build", "renders"]).
 */
export function resolveProjectPath(projectId: string, relPath: string, opts: { within?: readonly string[] } = {}): string {
  try {
    return resolveInside(projectDir(projectId), relPath, opts)
  } catch (e) {
    if (e instanceof PathError) throw httpError(e.statusCode, e.message)
    throw e
  }
}

/** Project-relative top-level folders only the app writes (not the code editor, not the agent). */
const APP_OWNED_TOP = new Set([".studio", ".claude", ".mcp.json", "build", "renders"])

/** resolveProjectPath for a user edit (code editor save): also refuses the app's own files and agent settings. */
export function resolveEditablePath(projectId: string, relPath: string): string {
  const abs = resolveProjectPath(projectId, relPath)
  const root = projectDir(projectId)
  const lexical = relative(root, abs).split(sep)
  const real = canonicalSegments(root, abs) ?? []
  if ([lexical, real].some((segs) => APP_OWNED_TOP.has(segs[0] ?? "") || segs.includes(".claude")))
    throw httpError(403, `${relPath} is managed by Crease and can't be edited here`)
  return abs
}

export function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode })
}

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "")
  return s || "project"
}

/** "parts/tray.scad" -> "tray"; a Blender part script "parts/king.blend.py" -> "king". */
export function partIdFromFile(file: string): string {
  return partIdOf(file)
}

const projectFile = (id: string) => join(projectDir(id), "project.json")

// Agent sessions (and which one is active) live in .studio/state.json, outside version control, so
// restoring an old version or switching between "ideas" (git branches) never rewrites the session list.
const stateFile = (id: string) => join(projectDir(id), ".studio", "state.json")
// The agent model picked in this project's switcher lives there too (a workspace preference, not part of the design).
// R11b: so does the project's designer choice (agentProfileId) and which runtime its model pick was for.
type WorkspaceState = Pick<Project, "activeSessionId" | "sessions" | "agentModel" | "agentModelRuntime" | "agentProfileId">

async function readProjectJson(projectId: string): Promise<Project> {
  const f = projectFile(projectId)
  if (!existsSync(f)) throw httpError(404, `project not found: ${projectId}`)
  const p = JSON.parse(await readFile(f, "utf8")) as Project
  try {
    const st = JSON.parse(await readFile(stateFile(projectId), "utf8")) as Partial<WorkspaceState>
    if (Array.isArray(st.sessions)) p.sessions = st.sessions
    if (st.activeSessionId !== undefined) p.activeSessionId = st.activeSessionId
    if (typeof st.agentModel === "string" && st.agentModel) p.agentModel = st.agentModel
    if (typeof st.agentModelRuntime === "string" && st.agentModelRuntime) p.agentModelRuntime = st.agentModelRuntime
    if (typeof st.agentProfileId === "string" && st.agentProfileId) p.agentProfileId = st.agentProfileId
  } catch {
    /* no state file yet: older project, sessions still in project.json */
  }
  p.sessions ??= []
  p.activeSessionId ??= null
  return p
}

async function writeAtomic(f: string, content: string) {
  const tmp = f + ".tmp"
  await writeFile(tmp, content)
  await rename(tmp, f)
}

async function writeProjectJson(p: Project): Promise<void> {
  const f = projectFile(p.id)
  await mkdir(join(projectDir(p.id), ".studio"), { recursive: true })
  const state: WorkspaceState = {
    activeSessionId: p.activeSessionId ?? null,
    sessions: p.sessions ?? [],
    ...(p.agentModel ? { agentModel: p.agentModel } : {}),
    ...(p.agentModel && p.agentModelRuntime ? { agentModelRuntime: p.agentModelRuntime } : {}),
    ...(p.agentProfileId ? { agentProfileId: p.agentProfileId } : {}),
  }
  await writeAtomic(stateFile(p.id), JSON.stringify(state, null, 2) + "\n")
  // the versioned part: everything except the session list (only rewritten when it actually changes)
  const tracked: Partial<Project> = { ...p }
  delete tracked.sessions
  delete tracked.activeSessionId
  delete tracked.agentModel
  delete tracked.agentModelRuntime
  delete tracked.agentProfileId
  const content = JSON.stringify(tracked, null, 2) + "\n"
  const prev = existsSync(f) ? await readFile(f, "utf8").catch(() => "") : ""
  if (prev !== content) await writeAtomic(f, content)
  try {
    upsertProject(p)
  } catch (e) {
    console.error("[catalog] upsertProject failed", e)
  }
}

/**
 * Make project.json's parts list match parts/*.scad and parts/*.blend.py (Blender part scripts): adds files that
 * appeared (e.g. created by the agent) and drops entries whose file is gone. A new file whose part id is taken
 * (king.blend.py next to king.scad) waits until the name is free. Writes project.json only if something changed.
 */
export async function syncParts(projectId: string, project?: Project): Promise<Project> {
  const p = project ?? (await readProjectJson(projectId))
  const dir = projectDir(projectId)
  const partsDir = join(dir, "parts")
  const onDisk = existsSync(partsDir)
    ? readdirSync(partsDir)
        .filter((f) => isPartFile(f))
        .sort()
        .map((f) => `parts/${f}`)
    : []
  const kept = p.parts.filter((pt) => existsSync(join(dir, pt.file)))
  const known = new Set(kept.map((pt) => pt.file))
  const ids = new Set(kept.map((pt) => pt.id))
  const added: PartRef[] = onDisk
    .filter((f) => !known.has(f))
    .map((f) => ({ id: partIdFromFile(f), file: f, qty: 1, colors: [] }))
    .filter((pt) => !ids.has(pt.id) && ids.add(pt.id))
  if (added.length || kept.length !== p.parts.length) {
    const removed = p.parts.filter((pt) => !kept.includes(pt)).map((pt) => pt.id)
    p.parts = [...kept, ...added]
    await writeProjectJson(p)
    const still = new Set(p.parts.map((pt) => pt.id))
    for (const id of removed) if (!still.has(id)) await removePartOutputs(projectId, id)
  }
  return p
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * A part left the project: drop what was generated from it (build/<id>.stl/.gcode/.render.json/…, its render PNGs,
 * its saved check) so nothing stale about it shows up in checks, the print dialog or the agent's checklist.
 */
export async function removePartOutputs(projectId: string, partId: string): Promise<string[]> {
  const root = projectDir(projectId)
  const id = escapeRe(partId)
  const rules: [string, RegExp][] = [
    ["build", new RegExp(`^(${id}\\.[\\w.]+|${id}-bed\\.scad|${id}-\\d+\\.gcode|assembly-part-${id}\\.scad)$`)],
    ["renders", new RegExp(`^(${id}-(iso|front|top|right|bed|back)(\\.clear)?\\.png|assembly-part-${id}\\.png)$`)],
    [".studio/checks", new RegExp(`^${id}\\.json$`)],
  ]
  const gone: string[] = []
  for (const [dir, re] of rules) {
    const abs = join(root, dir)
    if (!existsSync(abs)) continue
    for (const f of readdirSync(abs)) {
      if (!re.test(f)) continue
      await rm(join(abs, f), { force: true })
      gone.push(`${dir}/${f}`)
    }
  }
  // a Blender part's cached meshes (build/sculpt/<id>/)
  const sculptDir = join(root, "build", "sculpt", partId)
  if (/^[a-z0-9][\w-]*$/i.test(partId) && existsSync(sculptDir)) {
    await rm(sculptDir, { recursive: true, force: true })
    gone.push(`build/sculpt/${partId}`)
  }
  return gone
}

/** Add (or update) a part entry in project.json. */
export async function addPart(projectId: string, file: string, opts: Partial<Omit<PartRef, "file">> = {}): Promise<Project> {
  const p = await readProjectJson(projectId)
  const id = opts.id ?? partIdFromFile(file)
  const existing = p.parts.find((pt) => pt.id === id || pt.file === file)
  if (existing) Object.assign(existing, opts, { file })
  else p.parts.push({ id, file, qty: opts.qty ?? 1, colors: opts.colors ?? [], ...(opts.imported ? { imported: opts.imported } : {}) })
  await writeProjectJson(p)
  return p
}

/**
 * Before the default printer changes: projects that follow the default (older projects with no `printer`) are
 * pinned to the printer they use now, so a new default only applies to new projects. Returns the ids pinned.
 */
export async function pinProjectsToCurrentDefault(): Promise<string[]> {
  if (!existsSync(PROJECTS_DIR)) return []
  const current = getDefaultMachine().id
  const pinned: string[] = []
  for (const id of readdirSync(PROJECTS_DIR)) {
    if (!ID_RE.test(id)) continue
    const pf = join(PROJECTS_DIR, id, "project.json")
    if (!existsSync(pf)) continue
    try {
      const p = JSON.parse(await readFile(pf, "utf8")) as Project
      if (p.printer) continue
      await updateProject(id, { printer: current })
      pinned.push(id)
    } catch {
      // unreadable project: leave it alone
    }
  }
  return pinned
}

export async function listProjects(): Promise<ProjectSummary[]> {
  if (!existsSync(PROJECTS_DIR)) return []
  const out: ProjectSummary[] = []
  for (const id of readdirSync(PROJECTS_DIR)) {
    if (!ID_RE.test(id)) continue
    const dir = join(PROJECTS_DIR, id)
    const pf = join(dir, "project.json")
    if (!existsSync(pf)) continue
    try {
      const p = JSON.parse(await readFile(pf, "utf8")) as Project
      let mtime = statSync(pf).mtimeMs
      for (const pt of p.parts) {
        const f = join(dir, pt.file)
        if (existsSync(f)) mtime = Math.max(mtime, statSync(f).mtimeMs)
      }
      const first = p.parts[0]
      const thumbRel = first ? `renders/${first.id}-iso.png` : null
      const thumbAbs = thumbRel ? join(dir, thumbRel) : null
      out.push({
        id: p.id,
        name: p.name,
        tags: p.tags ?? [],
        updatedAt: new Date(mtime).toISOString(),
        thumbnailUrl:
          thumbAbs && existsSync(thumbAbs)
            ? displayUrl(p.id, thumbRel!, Math.round(statSync(thumbAbs).mtimeMs))
            : null,
      })
    } catch {
      // skip unreadable project folders
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function getProject(projectId: string): Promise<Project> {
  return syncParts(projectId)
}

export const STARTER_PART = `// Starter part. Parameters below show up in the Customizer panel.

/* [Size] */
// Outer width (mm)
width = 40; // [10:1:200]
// Outer depth (mm)
depth = 30; // [10:1:200]
// Outer height (mm)
height = 15; // [5:1:100]

/* [Shape] */
// Wall thickness (mm)
wall = 2; // [1.2:0.2:6]
// Corner radius (mm)
corner = 3; // [0:0.5:10]

/* [Hidden] */
$fn = 48;

module rounded_box(w, d, h, r) {
  if (r <= 0) cube([w, d, h]);
  else hull() for (x = [r, w - r], y = [r, d - r]) translate([x, y, 0]) cylinder(r = r, h = h);
}

difference() {
  rounded_box(width, depth, height, corner);
  translate([wall, wall, wall]) rounded_box(width - 2 * wall, depth - 2 * wall, height, max(corner - wall, 0));
}
`

/**
 * Nothing designed yet: the project holds only a new project's untouched starter part (parts/main.scad exactly as
 * created, no other part file, no assembly). Such a project is never sliced or printed (it would print the starter
 * box the user never asked for). Sync, so the agent's tool gates can use it; anything unreadable counts as designed.
 */
export function blankDesignAt(root: string): boolean {
  try {
    if (existsSync(join(root, "assembly.json"))) return false
    const files = readdirSync(join(root, "parts")).filter((f) => f.toLowerCase().endsWith(".scad"))
    if (files.length !== 1 || files[0] !== "main.scad") return false
    const pj = JSON.parse(readFileSync(join(root, "project.json"), "utf8")) as { parts?: { file?: string }[] }
    if ((pj.parts ?? []).some((p) => p.file !== "parts/main.scad")) return false
    return readFileSync(join(root, "parts", "main.scad"), "utf8") === STARTER_PART
  } catch {
    return false
  }
}

export const BLANK_DESIGN_REFUSAL = "Nothing is designed yet. Describe what to make first."

/** Slice and print routes: refuse a blank project (409, plain words). */
export function assertHasDesign(projectId: string) {
  if (blankDesignAt(projectDir(projectId))) throw httpError(409, BLANK_DESIGN_REFUSAL)
}

// .claude/skills/ holds installed copies of the app's skills, re-copied every agent session.
// .studio/ holds app state (sessions, transcripts, checks, print log): per project, not per version.
const GITIGNORE_LINES = ["build/", "renders/", ".claude/skills/", ".studio/", ".DS_Store", "*.tmp"]
const GITIGNORE = GITIGNORE_LINES.join("\n") + "\n"

const gitignoreChecked = new Set<string>()
/**
 * One-time (per process) upgrade of an existing project's .gitignore to the current template:
 * appends missing lines and untracks anything now ignored that was committed (e.g. .claude/skills/).
 */
export async function ensureGitignore(projectId: string): Promise<void> {
  if (gitignoreChecked.has(projectId)) return
  gitignoreChecked.add(projectId)
  await fixGitignore(projectId, true)
}

/** Make .gitignore current; untrack anything now ignored. `commit`: record that as its own commit. */
async function fixGitignore(projectId: string, commit: boolean): Promise<void> {
  const dir = projectDir(projectId)
  const file = join(dir, ".gitignore")
  let cur = ""
  try {
    cur = await readFile(file, "utf8")
  } catch {
    /* missing: create */
  }
  const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()))
  const missing = GITIGNORE_LINES.filter((l) => !have.has(l))
  if (!missing.length) return
  await writeFile(file, (cur && !cur.endsWith("\n") ? cur + "\n" : cur) + missing.join("\n") + "\n")
  try {
    const git = simpleGit({ baseDir: dir })
    let untracked = false
    for (const [line, path] of [
      [".claude/skills/", ".claude/skills"],
      [".studio/", ".studio"],
    ]) {
      if (!missing.includes(line)) continue
      const tracked = await git.raw(["ls-files", "--", path])
      if (tracked.trim()) {
        await git.raw(["rm", "-r", "--cached", "--quiet", "--", path])
        untracked = true
      }
    }
    if (commit && untracked) {
      await ensureIdentity(projectId)
      await git.raw(["add", "--", ".gitignore"])
      await git.raw(["commit", "-q", "-m", "user: keep app data out of versions", "--", ".gitignore", ".studio", ".claude/skills"])
    }
  } catch (e) {
    console.error(`[projects] gitignore upgrade for ${projectId}:`, e)
  }
}

export async function createProject(name: string): Promise<Project> {
  const trimmed = (name ?? "").trim()
  if (!trimmed) throw httpError(400, "name is required")
  const base = slugify(trimmed)
  let id = base
  for (let i = 2; existsSync(join(PROJECTS_DIR, id)); i++) id = `${base}-${i}`
  const dir = join(PROJECTS_DIR, id)
  mkdirSync(dir, { recursive: true })
  for (const d of ["parts", "lib", "build", "renders", ".studio/sessions", ".studio/checks"]) {
    await mkdir(join(dir, d), { recursive: true })
  }
  await writeFile(join(dir, "parts", "main.scad"), STARTER_PART)
  await writeFile(join(dir, "lib", ".gitkeep"), "")
  await writeFile(join(dir, ".gitignore"), GITIGNORE)
  const project: Project = {
    id,
    name: trimmed,
    createdAt: new Date().toISOString(),
    printer: newProjectPrinter(), // new projects target the default printer
    engine: "openscad",
    tags: [],
    parts: [{ id: "main", file: "parts/main.scad", qty: 1, colors: [] }],
    activeSessionId: null,
    sessions: [],
    source: null,
  }
  await writeProjectJson(project)
  const git = gitFor(id)
  await git.init()
  await ensureIdentity(id)
  await git.add(".")
  await git.commit("user: create project")
  return project
}

/**
 * New project from a bundled starter folder (resources/starters/<id>/): copies its parts, lib/ and
 * assembly files, takes name/tags/parts from its project.json, then git-inits like createProject.
 */
export async function createProjectFromStarter(starterDir: string, name?: string): Promise<Project> {
  const tpl = JSON.parse(await readFile(join(starterDir, "project.json"), "utf8")) as Partial<Project>
  const title = (name ?? "").trim() || tpl.name || "My project"
  const base = slugify(title)
  let id = base
  for (let i = 2; existsSync(join(PROJECTS_DIR, id)); i++) id = `${base}-${i}`
  const dir = join(PROJECTS_DIR, id)
  mkdirSync(dir, { recursive: true })
  const SKIP = new Set(["starter.json", "project.json", "thumbnail.png", "build", "renders", ".studio", ".git"])
  for (const f of readdirSync(starterDir)) {
    if (SKIP.has(f)) continue
    cpSync(join(starterDir, f), join(dir, f), { recursive: true })
  }
  for (const d of ["parts", "lib", "build", "renders", ".studio/sessions", ".studio/checks"]) await mkdir(join(dir, d), { recursive: true })
  await writeFile(join(dir, ".gitignore"), GITIGNORE)
  const project: Project = {
    id,
    name: title,
    createdAt: new Date().toISOString(),
    printer: newProjectPrinter(), // new projects target the default printer
    engine: "openscad",
    tags: tpl.tags ?? [],
    parts: (tpl.parts ?? []).map((p) => ({ id: p.id, file: p.file, qty: p.qty ?? 1, colors: p.colors ?? [] })),
    activeSessionId: null,
    sessions: [],
    source: null,
  }
  await writeProjectJson(project)
  const git = gitFor(id)
  await git.init()
  await ensureIdentity(id)
  await git.add(".")
  await git.commit(`user: start from the ${tpl.name ?? "starter"} idea`)
  return syncParts(id)
}

/**
 * New project from files supplied by the caller (build pack import): `fill(dir)` writes the files into the new folder
 * (which already has the standard folders) and returns the project.json fields to use; then git-inits and commits.
 * The folder is removed again if anything fails.
 */
export async function createProjectFromFiles(
  name: string,
  fill: (
    dir: string,
    id: string,
  ) => Promise<Pick<Project, "tags" | "parts"> & Partial<Pick<Project, "intent" | "license" | "description" | "source">>>,
  message: string,
): Promise<Project> {
  const title = (name ?? "").trim() || "Imported project"
  const base = slugify(title)
  let id = base
  for (let i = 2; existsSync(join(PROJECTS_DIR, id)); i++) id = `${base}-${i}`
  const dir = join(PROJECTS_DIR, id)
  mkdirSync(dir, { recursive: true })
  try {
    for (const d of ["parts", "lib", "build", "renders", ".studio/sessions", ".studio/checks"]) await mkdir(join(dir, d), { recursive: true })
    const meta = await fill(dir, id)
    await writeFile(join(dir, ".gitignore"), GITIGNORE)
    const project: Project = {
      id,
      name: title,
      createdAt: new Date().toISOString(),
      printer: newProjectPrinter(),
      engine: "openscad",
      tags: meta.tags ?? [],
      parts: meta.parts.filter((p) => existsSync(join(dir, p.file))),
      activeSessionId: null,
      sessions: [],
      source: meta.source ?? null,
      ...(meta.intent ? { intent: meta.intent } : {}),
      ...(meta.license ? { license: meta.license } : {}),
      ...(meta.description ? { description: meta.description } : {}),
    }
    await writeProjectJson(project)
    const repo = gitFor(id)
    await repo.init()
    await ensureIdentity(id)
    await repo.add(".")
    await repo.commit(/^user: /.test(message) ? message : `user: ${message}`)
    return syncParts(id)
  } catch (e) {
    await rm(dir, { recursive: true, force: true })
    throw e
  }
}

export async function updateProject(projectId: string, patch: Partial<Project>): Promise<Project> {
  const p = await readProjectJson(projectId)
  const next: Project = { ...p, ...patch, id: p.id }
  await writeProjectJson(next)
  return next
}

function gitFor(projectId: string) {
  return simpleGit({ baseDir: projectDir(projectId) })
}

// Commits fail if no git identity is configured anywhere; set a repo-local fallback only then.
async function ensureIdentity(projectId: string) {
  const git = gitFor(projectId)
  const email = await git.raw(["config", "--get", "user.email"]).catch(() => "")
  if (!email.trim()) {
    await git.addConfig("user.email", "studio@printstudio.local")
    await git.addConfig("user.name", "Crease")
  }
}

/** The slider values recorded in a commit (null: none recorded, i.e. a version from before U2). */
async function paramsOfCommit(projectId: string, rev: string): Promise<ParamSnapshot | null> {
  const body = await gitFor(projectId)
    .raw(["log", "-1", "--format=%B", rev])
    .catch(() => "")
  return parseParamsTrailer(body)
}

/** Do the open idea's slider values differ from what HEAD recorded? (No record counts as "none".) */
async function paramsChangedSinceHead(projectId: string): Promise<boolean> {
  return snapshotKey(paramSnapshotAt(projectDir(projectId))) !== snapshotKey(await paramsOfCommit(projectId, "HEAD"))
}

/** Stage everything and commit with the slider values as a trailer; an edit to the values alone is a version too. */
async function commitAll(projectId: string, subject: string): Promise<boolean> {
  const git = gitFor(projectId)
  await git.add(["-A", "."])
  const status = await git.status()
  const files = status.staged.length > 0 || status.files.length > 0
  if (!files && !(await paramsChangedSinceHead(projectId))) return false
  await git.commit([subject, paramsTrailer(paramSnapshotAt(projectDir(projectId)))], undefined, files ? {} : { "--allow-empty": null })
  return true
}

/**
 * Commit everything in the project. `message` should be prefixed "agent: " or "user: "; a bare message
 * gets "user: ". Returns the commit hash (or the current HEAD if there was nothing to commit).
 * The open idea's slider values are recorded with it, so a slider change alone also makes a version.
 */
export async function saveCheckpoint(projectId: string, message: string): Promise<string> {
  await readProjectJson(projectId) // 404 if missing
  const git = gitFor(projectId)
  await ensureIdentity(projectId)
  const msg = /^(agent|user):\s/.test(message) ? message : `user: ${message || "checkpoint"}`
  await commitAll(projectId, msg)
  return (await git.revparse(["HEAD"])).trim()
}

/* ---------- slider edits become versions, one per settled burst ---------- */

/** How long the sliders must be still before their edits become one version. */
export const PARAM_VERSION_IDLE_MS = 2000
const paramBursts = new Map<string, { before: ParamSnapshot; timer: ReturnType<typeof setTimeout>; onVersion?: () => void }>()

/** The open idea's slider values now (pass to noteParamEdit before saving new ones). */
export const currentParamSnapshot = (projectId: string): ParamSnapshot => paramSnapshotAt(projectDir(projectId))

/**
 * Note a slider edit (the Parameters panel saving new values). `before` = the values before this edit; the first edit
 * of a burst keeps its `before`, so the version says what the whole burst changed ("change width to 90").
 */
export function noteParamEdit(projectId: string, before: ParamSnapshot, idleMs = PARAM_VERSION_IDLE_MS, onVersion?: () => void): void {
  const cur = paramBursts.get(projectId)
  if (cur) clearTimeout(cur.timer)
  const timer = setTimeout(
    () => void flushParamVersion(projectId).catch((e) => console.error(`[projects] slider version for ${projectId}:`, e)),
    idleMs,
  )
  timer.unref?.()
  paramBursts.set(projectId, { before: cur?.before ?? before, timer, onVersion: onVersion ?? cur?.onVersion })
}

/** Save the pending slider burst as a version now (before going back or switching ideas, or when the timer fires). */
export async function flushParamVersion(projectId: string): Promise<string | null> {
  const b = paramBursts.get(projectId)
  if (!b) return null
  clearTimeout(b.timer)
  paramBursts.delete(projectId)
  const what = describeParamChange(b.before, paramSnapshotAt(projectDir(projectId)))
  if (!what) return null
  await ensureIdentity(projectId)
  if (!(await commitAll(projectId, `user: ${what}`))) return null
  b.onVersion?.()
  return (await gitFor(projectId).revparse(["HEAD"])).trim()
}

/* ---------- versions ("checkpoints") and ideas ("variants" = git branches) ---------- */

/**
 * Run a git operation that rewrites the working tree with .studio/ (sessions, transcripts, print log)
 * moved aside: older commits may still contain a tracked .studio/, and git silently overwrites ignored
 * files on checkout/restore.
 */
async function withAppDataKept<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const dir = projectDir(projectId)
  const live = join(dir, ".studio")
  const kept = join(dir, `.studio-kept-${Date.now()}`)
  const had = existsSync(live)
  if (had) await rename(live, kept)
  try {
    return await fn()
  } finally {
    if (had) {
      await rm(live, { recursive: true, force: true })
      await rename(kept, live)
    }
  }
}

async function isDirty(projectId: string): Promise<boolean> {
  const st = await gitFor(projectId).status()
  return st.files.length > 0 || (await paramsChangedSinceHead(projectId))
}

/** Commit uncommitted edits so nothing is lost when moving between versions. Returns true if it committed. */
export async function commitWorkInProgress(projectId: string): Promise<boolean> {
  if (await flushParamVersion(projectId)) return true
  if (!(await isDirty(projectId))) return false
  await saveCheckpoint(projectId, "user: work in progress")
  return true
}

export async function currentBranch(projectId: string): Promise<string> {
  return (await gitFor(projectId).raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim()
}

/** Versions on the current line of work, newest first. */
export async function listCheckpoints(projectId: string, limit = 100): Promise<{ branch: string; checkpoints: Checkpoint[] }> {
  await readProjectJson(projectId)
  const git = gitFor(projectId)
  const out = await git.raw(["log", `-n${limit}`, "--format=%H%x1f%h%x1f%aI%x1f%s"]).catch(() => "")
  const checkpoints = out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [commit, short, date, subject] = line.split("\x1f")
      const m = subject.match(/^(agent|user):\s*(.*)$/)
      return { commit, short, date, author: (m?.[1] ?? "user") as Checkpoint["author"], message: m ? m[2] : subject }
    })
  return { branch: await currentBranch(projectId), checkpoints }
}

async function verifyCommit(projectId: string, commit: string): Promise<string> {
  if (!/^[0-9a-f]{4,40}$/i.test(commit)) throw httpError(400, "not a version id")
  try {
    return (await gitFor(projectId).raw(["rev-parse", "--verify", "--quiet", `${commit}^{commit}`])).trim()
  } catch {
    throw httpError(404, `version not found: ${commit}`)
  }
}

/**
 * Go back to an older version without rewriting history: a NEW commit whose files equal that version's
 * ("user: restore <message>"). Uncommitted edits are saved first, so the current version stays in history.
 */
export async function restoreCheckpoint(projectId: string, commit: string): Promise<{ commit: string; restored: string }> {
  const project = await readProjectJson(projectId)
  const full = await verifyCommit(projectId, commit)
  const git = gitFor(projectId)
  await ensureIdentity(projectId)
  await commitWorkInProgress(projectId)
  const subject = (await git.raw(["log", "-1", "--format=%s", full])).trim().replace(/^(agent|user):\s*/, "")
  await withAppDataKept(projectId, async () => {
    await git.raw(["restore", `--source=${full}`, "--staged", "--worktree", "--", ".", ":(exclude).studio", ":(exclude).claude"])
    await fixGitignore(projectId, false) // older versions may predate the current .gitignore
  })
  // the restored project.json may be older (sessions inside it); state.json stays authoritative
  await writeProjectJson({ ...(await readProjectJson(projectId)), sessions: project.sessions, activeSessionId: project.activeSessionId })
  // the version's slider values come back with its files (versions from before U2 recorded none: keep today's)
  const params = await paramsOfCommit(projectId, full)
  if (params) applyParamSnapshot(projectDir(projectId), params)
  await syncParts(projectId)
  await commitAll(projectId, `user: restore ${subject.slice(0, 60) || full.slice(0, 7)}`)
  return { commit: (await git.revparse(["HEAD"])).trim(), restored: full }
}

/** Start another idea: a new branch "variant-N" from HEAD (or an older version), checked out. */
export async function createVariantBranch(projectId: string, fromCommit?: string): Promise<{ branch: string; previous: string }> {
  await readProjectJson(projectId)
  const git = gitFor(projectId)
  await ensureIdentity(projectId)
  await commitWorkInProgress(projectId)
  const previous = await currentBranch(projectId)
  const start = fromCommit ? await verifyCommit(projectId, fromCommit) : "HEAD"
  const existing = new Set((await git.raw(["branch", "--format=%(refname:short)"])).split("\n").map((b) => b.trim()))
  let n = 1
  while (existing.has(`variant-${n}`)) n++
  const branch = `variant-${n}`
  await withAppDataKept(projectId, async () => {
    await git.raw(["checkout", "-q", "-b", branch, start])
    await fixGitignore(projectId, false)
  })
  // The new idea starts with the Customizer overrides of the idea it came from (R22: overrides are per idea).
  copyIdeaOverrides(projectDir(projectId), previous, branch)
  await syncParts(projectId)
  return { branch, previous }
}

/** Switch the working files to another idea's branch (saving uncommitted edits first). */
export async function switchToBranch(projectId: string, branch: string): Promise<{ switched: boolean; savedWork: boolean }> {
  if (!/^[\w./-]+$/.test(branch)) throw httpError(400, "bad branch name")
  const cur = await currentBranch(projectId)
  if (cur === branch) return { switched: false, savedWork: false }
  const git = gitFor(projectId)
  const exists = (await git.raw(["branch", "--list", branch])).trim()
  if (!exists) throw httpError(404, `that idea's files are missing (branch ${branch})`)
  await ensureIdentity(projectId)
  const savedWork = await commitWorkInProgress(projectId)
  await withAppDataKept(projectId, async () => {
    await git.raw(["checkout", "-q", branch])
    await fixGitignore(projectId, false)
  })
  await syncParts(projectId)
  return { switched: true, savedWork }
}
