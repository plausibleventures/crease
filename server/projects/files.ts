// The sidebar's Files section: list the project folder and let the user copy files in, rename and delete them.
//
// Every path goes through resolveProjectPath (projects/paths.ts: no `..`, no absolute paths, judged by where it really
// lands, so links out of the project are refused). On top of that the user can't touch, by lexical OR real path:
//   - app-owned places: .git/, .studio/, build/, renders/, node_modules/, project.json (renders/ is still listed, read-only)
//   - any dot-entry (hidden from the tree too)
//   - G-code: only the slicer makes it (a dropped .gcode could be sent to the printer as if the app had made it)
//   - project assistant settings (CLAUDE.md, AGENTS.md, .claude/, .codex/, .agents/, .grok/, .mcp.json at any depth):
//     these go live in the designer's session, so they come in only through agent-config trust (agent-config.ts).
import { existsSync, lstatSync, readdirSync, statSync, type Dirent } from "node:fs"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, extname, join, relative, sep } from "node:path"
import type { ProjectFileNode, ProjectFilesResult } from "../../shared/types"
import { canonicalSegments } from "./paths"
import { httpError, projectDir, resolveProjectPath } from "./store"

export const MAX_FILE_BYTES = 100 * 1024 * 1024
const MAX_ENTRIES = 5000
const MAX_DEPTH = 12

/** Top-level folders the tree never shows. */
const HIDDEN_TOP = new Set(["build", "node_modules", "project.json"])
/** Top-level entries the user can see (renders/) or not, but never change. */
const APP_TOP = new Set(["build", "renders", "node_modules", "project.json"])
const INSTRUCTIONS_RE = /^(CLAUDE(\.local)?|AGENTS(\.override)?)\.md$/i
const GCODE_RE = /\.(gcode|bgcode|gco)$/i

const isHiddenName = (name: string) => name.startsWith(".") || INSTRUCTIONS_RE.test(name)

/** Why the user can't change this path (null = allowed). `segs` are project-relative segments. */
function refusal(segs: string[]): string | null {
  if (!segs.length) return "That is the project folder itself"
  // lower-case: macOS folders are case-insensitive, so "Build/x" lands in build/
  if (APP_TOP.has(segs[0].toLowerCase())) return `${segs[0]} is made by Crease and can't be changed here`
  if (segs.some((s) => s.startsWith("."))) return "Hidden files and folders can't be changed here"
  if (segs.some((s) => INSTRUCTIONS_RE.test(s))) return "Designer settings files can't be added here. Turn them on in the chat panel"
  if (GCODE_RE.test(segs[segs.length - 1])) return "G-code is made by slicing. It can't be added here"
  return null
}

/** Resolve a project-relative path the user wants to write, rename or delete; throws 400/403 when refused. */
export function resolveUserPath(projectId: string, rel: string): string {
  const abs = resolveProjectPath(projectId, rel)
  const root = projectDir(projectId)
  const lexical = relative(root, abs).split(sep).filter(Boolean)
  const real = canonicalSegments(root, abs) ?? []
  for (const segs of [lexical, real]) {
    const why = refusal(segs)
    if (why) throw httpError(403, why)
  }
  return abs
}

const toPosix = (p: string) => p.split(sep).join("/")

function lstat(p: string) {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

/** The tree the sidebar shows: folders first, then files, by name. */
export function listProjectFiles(projectId: string): ProjectFilesResult {
  const root = projectDir(projectId)
  if (!existsSync(join(root, "project.json"))) throw httpError(404, `project not found: ${projectId}`)
  let budget = MAX_ENTRIES
  let truncated = false
  const walk = (dir: string, depth: number, readOnly: boolean): ProjectFileNode[] => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const out: ProjectFileNode[] = []
    for (const e of entries) {
      if (isHiddenName(e.name)) continue
      if (depth === 0 && HIDDEN_TOP.has(e.name)) continue
      if (budget <= 0) {
        truncated = true
        break
      }
      const abs = join(dir, e.name)
      const rel = toPosix(relative(root, abs))
      let st
      if (e.isSymbolicLink()) {
        // Only links that land inside the project, and only files (a linked folder could loop).
        if (!canonicalSegments(root, abs)) continue
        try {
          st = statSync(abs)
        } catch {
          continue
        }
        if (!st.isFile()) continue
      } else {
        st = lstat(abs)
        if (!st || !(st.isFile() || st.isDirectory())) continue
      }
      budget--
      const ro = readOnly || (depth === 0 && e.name === "renders")
      const node: ProjectFileNode = { name: e.name, path: rel, kind: st.isDirectory() ? "dir" : "file", mtime: st.mtime.toISOString() }
      if (ro) node.readOnly = true
      if (st.isDirectory()) node.children = depth < MAX_DEPTH ? walk(abs, depth + 1, ro) : []
      else node.size = st.size
      out.push(node)
    }
    return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.kind === "dir" ? -1 : 1))
  }
  return { files: walk(root, 0, false), truncated }
}

/** A file name that is safe to create: no folders, no control characters. parts/*.scad and parts/*.blend.py names become part ids. */
function cleanName(name: string, dir: string[]): string {
  // eslint-disable-next-line no-control-regex
  let n = name.replace(/[\u0000-\u001f\u007f/\\:]/g, "").trim()
  const ext = /\.blend\.py$/i.test(n) ? ".blend.py" : /\.scad$/i.test(n) ? ".scad" : null
  if (dir.length === 1 && dir[0] === "parts" && ext) {
    const stem = n
      .slice(0, -ext.length)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
    n = `${stem || "part"}${ext}`
  }
  if (!n || n === "." || n === "..") throw httpError(400, "That file name can't be used")
  if (n.length > 200) throw httpError(400, "That file name is too long")
  return n
}

/** Project-relative segments of a path from the client; absolute paths and `..` are refused, not reinterpreted. */
function splitRel(rel: unknown): string[] {
  const s = typeof rel === "string" ? rel : ""
  if (/^([/\\]|[a-zA-Z]:)/.test(s) || s.startsWith("~")) throw httpError(400, `path outside project: ${s}`)
  const segs = s.split(/[/\\]/).filter((x) => x && x !== ".")
  if (segs.includes("..")) throw httpError(400, `path outside project: ${s}`)
  return segs
}

/** `name` or the first free `name-2.ext`, `name-3.ext`, … in `dirAbs`. */
function freeName(dirAbs: string, name: string): string {
  if (!lstat(join(dirAbs, name))) return name
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let i = 2; i < 10000; i++) {
    const n = `${stem}-${i}${ext}`
    if (!lstat(join(dirAbs, n))) return n
  }
  throw httpError(409, "Too many files with that name")
}

/** Copy bytes into the project at `rel` (folders made as needed). Returns the project-relative path written. */
export async function uploadProjectFile(projectId: string, rel: string, data: Buffer, opts: { replace?: boolean } = {}): Promise<string> {
  if (data.length > MAX_FILE_BYTES) throw httpError(413, "That file is over 100 MB")
  const parts = splitRel(rel)
  if (!parts.length) throw httpError(400, "path is required")
  const dirSegs = parts.slice(0, -1)
  const name = cleanName(parts[parts.length - 1], dirSegs)
  // Check the folder and the final name both (the folder may be new; the name may be taken).
  const dirAbs = dirSegs.length ? resolveUserPath(projectId, dirSegs.join("/")) : projectDir(projectId)
  if (dirSegs.length && existsSync(dirAbs) && !statSync(dirAbs).isDirectory()) throw httpError(409, `${dirSegs.join("/")} is a file, not a folder`)
  const finalName = opts.replace ? name : freeName(dirAbs, name)
  const target = [...dirSegs, finalName].join("/")
  const abs = resolveUserPath(projectId, target)
  const st = lstat(abs)
  if (st?.isDirectory()) throw httpError(409, `${target} is a folder`)
  await mkdir(dirname(abs), { recursive: true })
  // Re-check after mkdir: the folder now exists, so a link swapped in along the way is resolved.
  resolveUserPath(projectId, target)
  await writeFile(abs, data, { flag: opts.replace ? "w" : "wx" })
  return target
}

/** Make an empty folder at `rel` (its parents too). 409 when something is already there. Returns the path made. */
export async function makeProjectFolder(projectId: string, rel: string): Promise<string> {
  const parts = splitRel(rel)
  if (!parts.length) throw httpError(400, "path is required")
  const name = cleanName(parts[parts.length - 1], [])
  const target = [...parts.slice(0, -1), name].join("/")
  const abs = resolveUserPath(projectId, target)
  if (lstat(abs)) throw httpError(409, `${target} already exists`)
  await mkdir(abs, { recursive: true })
  // Re-check now it exists: a link swapped in along the way is resolved.
  resolveUserPath(projectId, target)
  return target
}

export async function renameProjectFile(projectId: string, from: string, to: string): Promise<string> {
  if (typeof from !== "string" || typeof to !== "string" || !from || !to) throw httpError(400, "from and to are required")
  const src = resolveUserPath(projectId, from)
  if (!lstat(src)) throw httpError(404, `not found: ${from}`)
  const toParts = splitRel(to)
  const name = cleanName(toParts[toParts.length - 1] ?? "", toParts.slice(0, -1))
  const target = [...toParts.slice(0, -1), name].join("/")
  const dst = resolveUserPath(projectId, target)
  if (dst === src) return target
  if (lstat(dst) && dst.toLowerCase() !== src.toLowerCase()) throw httpError(409, `${basename(target)} already exists`)
  if (isInsideDir(src, dst)) throw httpError(400, "A folder can't go inside itself")
  await mkdir(dirname(dst), { recursive: true })
  await rename(src, dst)
  return target
}

function isInsideDir(dir: string, p: string) {
  const r = relative(dir, p)
  return r !== "" && !r.startsWith("..") && !r.startsWith(sep)
}

export async function deleteProjectFile(projectId: string, rel: string): Promise<void> {
  const abs = resolveUserPath(projectId, rel)
  if (!lstat(abs)) throw httpError(404, `not found: ${rel}`)
  // rm on a link removes the link, never what it points at
  await rm(abs, { recursive: true, force: true })
}
