// Project lifecycle from the Library (U4): rename, tags, duplicate, move to the Trash.
// Never deletes a project folder: "delete" moves it to the OS Trash (desktop app, Electron shell.trashItem) or, without
// one (browser dev server, tests), into <STUDIO_HOME>/.trash/ where it can be moved back by hand.
import { cpSync, existsSync, lstatSync, realpathSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative, sep } from "node:path"
import type { Project, ProjectTrashResult } from "../../shared/types"
import { PROJECTS_DIR, STUDIO_HOME } from "../config"
import { openPrints, removeProject } from "../db"
import { activePrintJobs } from "../jobs"
import { getProject, httpError, projectDir, saveCheckpoint, slugify, updateProject } from "./store"

export const MAX_TAGS = 12
export const MAX_TAG_LENGTH = 32
export const MAX_NAME_LENGTH = 80
export const APP_TRASH_DIR = join(STUDIO_HOME, ".trash")

/** Moves a folder to the OS Trash (Electron: shell.trashItem). Set by the desktop shell; null = app trash folder. */
export type TrashHandler = (absPath: string) => Promise<void>
let trashHandler: TrashHandler | null = null
export function setTrashHandler(fn: TrashHandler | null) {
  trashHandler = fn
}

/** Trimmed, single-spaced, 1..MAX_NAME_LENGTH characters; 400 otherwise. */
export function cleanName(name: unknown): string {
  if (typeof name !== "string") throw httpError(400, "name must be a string")
  const s = name.replace(/\s+/g, " ").trim()
  if (!s) throw httpError(400, "name is required")
  if (s.length > MAX_NAME_LENGTH) throw httpError(400, `name is too long (max ${MAX_NAME_LENGTH} characters)`)
  return s
}

/** Trimmed, de-duplicated (case-insensitive, first spelling wins), at most MAX_TAGS of at most MAX_TAG_LENGTH each. */
export function cleanTags(tags: unknown): string[] {
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string")) throw httpError(400, "tags must be an array of strings")
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of tags as string[]) {
    const t = raw.replace(/\s+/g, " ").trim()
    if (!t) continue
    if (t.length > MAX_TAG_LENGTH) throw httpError(400, `tag is too long (max ${MAX_TAG_LENGTH} characters): ${t.slice(0, 40)}`)
    const k = t.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t)
  }
  if (out.length > MAX_TAGS) throw httpError(400, `too many tags (max ${MAX_TAGS})`)
  return out
}

/** Rename (display name only: the folder and id stay) and/or replace the tags. */
export async function patchProject(projectId: string, body: { name?: unknown; tags?: unknown }): Promise<Project> {
  await getProject(projectId) // 404 if missing
  const patch: Partial<Project> = {}
  if (body.name !== undefined) patch.name = cleanName(body.name)
  if (body.tags !== undefined) patch.tags = cleanTags(body.tags)
  if (!Object.keys(patch).length) throw httpError(400, "nothing to change: give name and/or tags")
  return updateProject(projectId, patch)
}

/** The project folder, checked: a real directory directly inside PROJECTS_DIR (no links), with a project.json. */
function realProjectDir(projectId: string): string {
  const dir = projectDir(projectId) // 400 for a malformed id (no "..", "/", dots)
  let st
  try {
    st = lstatSync(dir)
  } catch {
    throw httpError(404, `project not found: ${projectId}`)
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw httpError(400, `not a project folder: ${projectId}`)
  const rel = relative(realpathSync(PROJECTS_DIR), realpathSync(dir))
  if (!rel || rel.startsWith("..") || rel.includes(sep)) throw httpError(400, `not a project folder: ${projectId}`)
  if (!existsSync(join(dir, "project.json"))) throw httpError(404, `project not found: ${projectId}`)
  return dir
}

function freeId(base: string): string {
  let id = base
  for (let i = 2; existsSync(join(PROJECTS_DIR, id)); i++) id = `${base}-${i}`
  return id
}

/** App state that belongs to the original only: chats, print jobs/records, handoffs, reviews, pasted images. */
const NOT_COPIED = new Set([".studio/state.json", ".studio/sessions", ".studio/jobs", ".studio/prints", ".studio/handoffs", ".studio/slice-reviews", ".studio/agent-images"])

/**
 * A copy of the project under a new id: design files, history (git), ideas, Customizer values, renders and checks.
 * Chats and print jobs stay with the original (the copy starts a fresh chat).
 */
export async function duplicateProject(projectId: string, name?: unknown): Promise<Project> {
  const src = realProjectDir(projectId)
  const orig = await getProject(projectId)
  const title = name === undefined || name === null || name === "" ? `${orig.name} copy`.slice(0, MAX_NAME_LENGTH) : cleanName(name)
  const id = freeId(slugify(title))
  const dst = join(PROJECTS_DIR, id)
  try {
    cpSync(src, dst, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (from) => !NOT_COPIED.has(relative(src, from).split(sep).join("/")),
    })
    const pj = JSON.parse(await readFile(join(dst, "project.json"), "utf8")) as Project
    pj.id = id
    pj.name = title
    pj.createdAt = new Date().toISOString()
    delete (pj as Partial<Project>).sessions
    delete (pj as Partial<Project>).activeSessionId
    await writeFile(join(dst, "project.json"), JSON.stringify(pj, null, 2) + "\n")
    await updateProject(id, { sessions: [], activeSessionId: null }) // writes .studio/state.json + the catalog row
    await saveCheckpoint(id, `user: copy of ${orig.name}`)
    return getProject(id)
  } catch (e) {
    await rm(dst, { recursive: true, force: true }).catch(() => {})
    throw e
  }
}

/** Why a project can't be moved to the Trash right now, or null. */
export function trashBlocker(projectId: string): string | null {
  if (openPrints().some((r) => r.projectId === projectId)) return "A print from this project is running. Stop it first."
  if (activePrintJobs(projectId) > 0) return "A print from this project is waiting or running. Finish or cancel it first."
  return null
}

/**
 * Move the project folder to the Trash. 409 while a print from it is running or waiting for approval. The catalog row
 * goes; print records stay (they are a log).
 */
export async function trashProject(projectId: string): Promise<ProjectTrashResult> {
  const dir = realProjectDir(projectId)
  const why = trashBlocker(projectId)
  if (why) throw httpError(409, why)
  let result: ProjectTrashResult
  if (trashHandler) {
    await trashHandler(dir)
    result = { trashed: true, where: "system", path: null }
  } else {
    await mkdir(APP_TRASH_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const dest = join(APP_TRASH_DIR, `${projectId}-${stamp}`)
    if (dirname(dest) !== APP_TRASH_DIR) throw httpError(400, "bad trash path")
    await rename(dir, dest)
    result = { trashed: true, where: "app", path: dest }
  }
  try {
    removeProject(projectId)
  } catch (e) {
    console.error("[catalog] removeProject failed", e)
  }
  return result
}
