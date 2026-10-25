// The design revision of a project folder: one hash of what the user sees and gets printed. Shared by the agent's
// approval/slice-review gates (server/agent/revision.ts) and print jobs (server/jobs), so "the design changed" means
// the same thing to both.
//
// Covered (design): each part in project.json with its .scad, every file it include<>/use<>s and its Customizer
// overrides (the part stamp below), the parts list in project.json (which parts, qty, colours), and the design side
// of assembly.json: placements, motions and, for an assembled build, its parts' qty and colours (assemblyDesignKey).
// Not covered (guide-only, so building the picture guide after an approval keeps the approval): assembly.json's
// hardware, tools, consumables, steps, title/summary/notes and hardware placements; assembly.scad (the guide's
// render script); the generated lib/studio_assembly*.scad files and any other .scad no part includes; build/
// outputs, renders, .studio/ app state, .git, skills.
// Content-based and path-independent, so undoing a change back to the exact same files gives the same revision again.
import { createHash } from "node:crypto"
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import type { Assembly, PartRef, SharedParamNote, SourceStamp } from "../../shared/types"
import { declaredParameters } from "../cad/customizer"
import { isSculptFile, sculptLibDeps } from "../cad/sculpt"

/**
 * The parts of assembly.json that change what the user sees: placements and motions (the assembled build), and,
 * when there is an assembled build, its parts' qty and colours (the assembly view draws them). An assembly.json
 * with neither placements nor motions is guide/BOM data only (a one-part hook with screws to buy) and counts the
 * same as none, so writing it after an approval keeps the approval. Hardware, tools, consumables, steps and text
 * never count. Invalid JSON counts as its raw text.
 */
export function assemblyDesignKey(text: string | null): string {
  if (text === null) return "none"
  let a: Partial<Assembly> | null
  try {
    a = JSON.parse(text) as Partial<Assembly> | null
  } catch {
    return `raw:${text}`
  }
  if (!a || typeof a !== "object") return `raw:${text}`
  const placements = Array.isArray(a.placements) ? a.placements : []
  const motions = Array.isArray(a.motions) ? a.motions : []
  if (!placements.length && !motions.length) return "none"
  const parts = Array.isArray(a.parts) ? a.parts.map((p) => ({ id: p?.id, qty: p?.qty, color: p?.color })) : null
  return JSON.stringify({ parts, placements, motions })
}

/**
 * Hash of the design under a project root at this moment (hex, 16 chars).
 * `overrides: false` leaves Customizer overrides out: print jobs already track them per part (their part stamps), and
 * use this only as the whole-project fallback (colours, parts list, assembly), so one part's Customizer value
 * doesn't make another part's job stale.
 */
export function designRevisionAt(root: string, opts: { overrides?: boolean } = {}): string {
  const withOverrides = opts.overrides !== false
  const h = createHash("sha256")
  let parts: PartRef[] = []
  try {
    const p = JSON.parse(readFileSync(join(root, "project.json"), "utf8")) as { parts?: PartRef[] }
    parts = Array.isArray(p.parts) ? p.parts : []
    h.update(`parts:${JSON.stringify(p.parts ?? [])}\n`)
  } catch {
    h.update("parts:none\n")
  }
  const valid = parts.filter((x) => x && typeof x.id === "string" && typeof x.file === "string")
  for (const part of valid.sort((a, b) => a.id.localeCompare(b.id))) {
    const s = withOverrides ? currentPartStampAt(root, part) : partStampAt(join(root, part.file), null, root)
    const files = Object.entries(s.files).sort(([a], [b]) => a.localeCompare(b))
    h.update(`part:${part.id}:${JSON.stringify(files)}:${JSON.stringify(s.params ?? null)}\n`)
  }
  const asm = join(root, "assembly.json")
  let asmText: string | null = null
  if (existsSync(asm)) {
    try {
      asmText = readFileSync(asm, "utf8")
    } catch {
      asmText = "\0unreadable"
    }
  }
  h.update(`assembly:${assemblyDesignKey(asmText)}\n`)
  return h.digest("hex").slice(0, 16)
}

// ---------------------------------------------------------------------------------------------
// Source stamps (R07): what one part, or the whole assembly, is built from. Derived artifacts (renders, checks, the
// picture guide + assembly renders, motion checks, print jobs) record the stamp they were made from; an artifact is
// current when its recorded hash equals the stamp computed now, and the per-file hashes say what changed.
// This is the only part/assembly hasher: cad's render cache (sourceHash) and print jobs use it too.
// ---------------------------------------------------------------------------------------------

export type ParamValue = number | string | boolean
export type { SourceStamp }

const INCLUDE_RE = /^\s*(?:include|use)\s*<([^>]+)>/gm
const MESH_IMPORT_RE = /\bimport\s*\(\s*(?:file\s*=\s*)?"([^"]+\.(?:stl|3mf|off|obj|amf))"/gi
const fileKey = (root: string | undefined, abs: string) => (root ? relative(root, abs).split("\\").join("/") || abs : abs)
const short = (b: Buffer | string) => createHash("sha256").update(b).digest("hex").slice(0, 12)
const sortedParams = (params?: Record<string, ParamValue> | null) =>
  params ? Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b))) : {}

/**
 * Walk a .scad file and every file it include<>/use<>s (recursively; a name is looked up next to the including file,
 * then at the project root, then in lib/). BOSL2 and other libraries outside the project are not followed.
 * `feed` sees each file (or a missing file) in visiting order.
 */
export function walkScad(scadAbs: string, projectRoot: string | undefined, feed: (abs: string, src: Buffer | null) => void) {
  const seen = new Set<string>()
  const visit = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    let src: Buffer
    try {
      src = readFileSync(file)
    } catch {
      feed(file, null)
      return
    }
    feed(file, src)
    // A Blender part script (parts/<id>.blend.py): the lib/*.py modules it imports are part of what it's made from.
    if (isSculptFile(file)) {
      if (projectRoot)
        for (const dep of sculptLibDeps(file, projectRoot))
          if (!seen.has(dep)) {
            seen.add(dep)
            try {
              feed(dep, readFileSync(dep))
            } catch {
              feed(dep, null)
            }
          }
      return
    }
    const text = src.toString("utf8")
    for (const m of text.matchAll(INCLUDE_RE)) {
      const candidates = [resolve(dirname(file), m[1]), ...(projectRoot ? [resolve(projectRoot, m[1]), resolve(projectRoot, "lib", m[1])] : [])]
      const hit = candidates.find((c) => existsSync(c))
      if (hit) visit(hit)
    }
    // R23: meshes a part import()s (imported STL/3MF next to its wrapper) are part of what it's made from.
    for (const m of text.matchAll(MESH_IMPORT_RE)) {
      const abs = resolve(dirname(file), m[1])
      if (seen.has(abs) || (projectRoot && relative(projectRoot, abs).startsWith(".."))) continue
      seen.add(abs)
      try {
        feed(abs, readFileSync(abs))
      } catch {
        feed(abs, null)
      }
    }
  }
  visit(scadAbs)
}

/**
 * Stamp of one part: its .scad, every include/use (recursively) and its Customizer overrides. The hash is the render
 * cache key (build/<part>.render.json `hash`) and a print job's per-part source hash, so all three agree.
 */
export function partStampAt(scadAbs: string, params?: Record<string, ParamValue> | null, projectRoot?: string): SourceStamp {
  const h = createHash("sha256")
  const files: Record<string, string> = {}
  walkScad(scadAbs, projectRoot, (abs, src) => {
    if (!src) {
      h.update(`missing:${abs}\n`)
      files[fileKey(projectRoot, abs)] = "missing"
      return
    }
    h.update(`${abs}\n`).update(src)
    files[fileKey(projectRoot, abs)] = short(src)
  })
  h.update(JSON.stringify(sortedParams(params)))
  return { hash: h.digest("hex").slice(0, 16), files, params: params && Object.keys(params).length ? sortedParams(params) : null }
}

// R22: Customizer overrides are per idea: .studio/params/<idea>/<part>.json, <idea> = the git branch (URI-encoded),
// read from .git/HEAD. Switching ideas swaps the overrides along with the files; a new idea starts with a copy of
// the overrides of the idea it came from; compare builds each side with its own idea's. Projects from before (flat
// .studio/params/<part>.json, shared by every idea) are migrated on first use: every idea gets a copy.
const paramsRoot = (root: string) => join(root, ".studio", "params")
const ideaDir = (root: string, idea: string) => join(paramsRoot(root), encodeURIComponent(idea))
const overridesFile = (root: string, partId: string, idea: string) => join(ideaDir(root, idea), `${partId}.json`)

/** The idea (git branch) open now, from .git/HEAD; "HEAD" when detached or unknown. */
export function currentIdeaAt(root: string): string {
  try {
    const m = readFileSync(join(root, ".git", "HEAD"), "utf8").trim().match(/^ref:\s*refs\/heads\/(.+)$/)
    return m ? m[1] : "HEAD"
  } catch {
    return "HEAD"
  }
}

/** Branch names (loose refs + packed-refs). */
function branchesAt(root: string): string[] {
  const out = new Set<string>()
  const walk = (dir: string, prefix: string) => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(join(dir, e.name), `${prefix}${e.name}/`)
      else if (e.isFile()) out.add(`${prefix}${e.name}`)
    }
  }
  walk(join(root, ".git", "refs", "heads"), "")
  try {
    for (const m of readFileSync(join(root, ".git", "packed-refs"), "utf8").matchAll(/^[0-9a-f]{40}\s+refs\/heads\/(\S+)$/gm)) out.add(m[1])
  } catch {
    /* no packed refs */
  }
  return [...out]
}

/** Old flat layout -> one folder per idea (each idea keeps the overrides it showed before). */
export function migrateOverrides(root: string): void {
  const dir = paramsRoot(root)
  let flat: string[]
  try {
    flat = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => e.name)
  } catch {
    return
  }
  if (!flat.length) return
  for (const idea of new Set([currentIdeaAt(root), ...branchesAt(root)])) {
    const to = ideaDir(root, idea)
    mkdirSync(to, { recursive: true })
    for (const f of flat) if (!existsSync(join(to, f))) copyFileSync(join(dir, f), join(to, f))
  }
  for (const f of flat) rmSync(join(dir, f), { force: true })
}

/** Parts with saved overrides of their own on an idea (default: the open one). Shared values are not a part. */
export function partsWithOverrides(root: string, idea = currentIdeaAt(root)): string[] {
  migrateOverrides(root)
  try {
    return readdirSync(ideaDir(root, idea))
      .filter((f) => f.endsWith(".json") && !f.startsWith("@"))
      .map((f) => f.slice(0, -5))
  } catch {
    return []
  }
}

/** A new idea starts with the overrides of the idea it was made from (ones it already has are kept). */
export function copyIdeaOverrides(root: string, from: string, to: string): void {
  migrateOverrides(root)
  const src = ideaDir(root, from)
  if (from === to || !existsSync(src)) return
  cpSync(src, ideaDir(root, to), { recursive: true, force: false })
}

// ---- shared settings ----
// A setting several parts use is one setting: a pot and its saucer that both include lib/params.scad get the same
// wall thickness, or they stop fitting. So a value is saved either for one part (.studio/params/<idea>/<part>.json)
// or once for every part that uses it (.studio/params/<idea>/@shared.json). A setting is shared when it comes from
// an include<>d project file in every part that has it, or when 2+ parts declare it with the same design value
// (pot.scad and saucer.scad both saying `wall = 2;`). Same name, different design values (a pot `height = 120;`, a
// saucer `height = 15;`) are two settings, and an imported mesh's own settings (scale_percent) are always its own. Older projects saved shared settings per part; the first read moves them
// into the shared file: the first part (project order) that set one wins, and if parts had different values a note
// says what each had (GET .../overrides `notes`, shown in the Parameters panel until dismissed or changed).

/** The snapshot key / file name of the shared values (a part id never starts with "@"). */
export const SHARED_KEY = "@shared"
const sharedFile = (root: string, idea: string) => join(ideaDir(root, idea), `${SHARED_KEY}.json`)

interface SharedData {
  params: Record<string, ParamValue>
  notes: SharedParamNote[]
}

export interface ParamLink {
  /** parts whose declaration can be shared (not an imported mesh's own), in project order */
  parts: string[]
  /** one value for all of them */
  shared: boolean
  /** project-relative files that declare it (a part's own file or an include<>d one) */
  files: string[]
}

export interface ParamLinks {
  /** parts in project order */
  parts: string[]
  byName: Map<string, ParamLink>
  /** part -> its settings -> the file that declares it for that part */
  byPart: Map<string, Map<string, string>>
}

/** Whether a part's setting is a shared one (one value for every part in `byName.get(name).parts`). */
export function isSharedFor(links: ParamLinks, partId: string, name: string): boolean {
  const l = links.byName.get(name)
  return !!l?.shared && l.parts.includes(partId)
}

function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T
  } catch {
    return null
  }
}

function writeJsonAtomic(file: string, data: unknown) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2) + "\n")
  renameSync(`${file}.tmp`, file)
}

const cleanParams = (v: unknown): Record<string, ParamValue> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(
        Object.entries(v as Record<string, unknown>).filter(
          (e): e is [string, ParamValue] => typeof e[1] === "number" || typeof e[1] === "string" || typeof e[1] === "boolean",
        ),
      )
    : {}

/** A part's own saved values as stored (no shared ones), or null when it has no file on that idea. */
function ownOverrides(root: string, partId: string, idea: string): Record<string, ParamValue> | null {
  const saved = readJsonFile<{ params?: unknown }>(overridesFile(root, partId, idea))
  return saved ? cleanParams(saved.params) : null
}

function writeOwn(root: string, partId: string, idea: string, params: Record<string, ParamValue> | null) {
  writeJsonAtomic(overridesFile(root, partId, idea), { params: params && Object.keys(params).length ? sortedParams(params) : null })
}

function readShared(root: string, idea: string): SharedData {
  const d = readJsonFile<{ params?: unknown; notes?: unknown }>(sharedFile(root, idea))
  return { params: cleanParams(d?.params), notes: Array.isArray(d?.notes) ? (d.notes as SharedParamNote[]) : [] }
}

function writeShared(root: string, idea: string, d: SharedData) {
  const file = sharedFile(root, idea)
  if (!Object.keys(d.params).length && !d.notes.length) {
    rmSync(file, { force: true })
    return
  }
  writeJsonAtomic(file, { params: sortedParams(d.params), ...(d.notes.length ? { notes: d.notes } : {}) })
}

let linksCache: { root: string; stats: [string, string][]; links: ParamLinks } | null = null
const statKey = (abs: string) => {
  try {
    const st = statSync(abs)
    return `${st.mtimeMs}:${st.ctimeMs}:${st.size}`
  } catch {
    return "missing"
  }
}

/** Which parts use which settings, and which settings are shared, from the open files (project.json + .scad). */
export function paramLinksAt(root: string): ParamLinks {
  if (linksCache?.root === root && linksCache.stats.every(([f, k]) => statKey(f) === k)) return linksCache.links
  const pj = join(root, "project.json")
  const read = new Set<string>([pj])
  let parts: PartRef[] = []
  try {
    const p = JSON.parse(readFileSync(pj, "utf8")) as { parts?: PartRef[] }
    parts = (Array.isArray(p.parts) ? p.parts : []).filter((x) => x && typeof x.id === "string" && typeof x.file === "string")
  } catch {
    /* no project.json: no parts */
  }
  const decl = new Map<string, { parts: string[]; files: string[]; values: string[]; fromFile: boolean[] }>()
  const byPart = new Map<string, Map<string, string>>()
  for (const part of parts) {
    const mine = new Map<string, string>()
    byPart.set(part.id, mine)
    const mesh = (part as { imported?: { kind?: string } }).imported?.kind === "mesh"
    for (const p of declaredParameters(join(root, part.file), root, read)) {
      const file = p.file ?? part.file
      mine.set(p.name, file)
      if (mesh && !p.file) continue // scale_percent of one imported mesh is never another part's
      let d = decl.get(p.name)
      if (!d) decl.set(p.name, (d = { parts: [], files: [], values: [], fromFile: [] }))
      d.parts.push(part.id)
      if (!d.files.includes(file)) d.files.push(file)
      d.values.push(JSON.stringify(p.value))
      d.fromFile.push(!!p.file)
    }
  }
  const byName = new Map<string, ParamLink>()
  for (const [name, d] of decl) {
    const shared = d.fromFile.every(Boolean) || (d.parts.length > 1 && new Set(d.values).size === 1)
    byName.set(name, { parts: d.parts, shared, files: d.files })
  }
  const links: ParamLinks = { parts: parts.map((p) => p.id), byName, byPart }
  linksCache = { root, stats: [...read].map((f) => [f, statKey(f)]), links }
  return links
}

/**
 * Bring the open idea's saved values in line with which settings are shared now: per-part values of a shared
 * setting move into the shared file (older projects, a new part that also uses it); a shared value whose setting
 * is no longer shared goes back to each part that has it. Writes only when something moves.
 */
function normalizeShared(root: string, idea: string, links: ParamLinks): SharedData {
  const data = readShared(root, idea)
  if (!existsSync(ideaDir(root, idea))) return data
  const own = new Map<string, Record<string, ParamValue> | null>()
  const ownOf = (id: string) => {
    if (!own.has(id)) own.set(id, ownOverrides(root, id, idea))
    return own.get(id) ?? null
  }
  const dirty = new Set<string>()
  let sharedDirty = false
  for (const [name, l] of links.byName) {
    if (!l.shared) continue
    const had = l.parts.map((id) => [id, ownOf(id)?.[name]] as const).filter((e): e is readonly [string, ParamValue] => e[1] !== undefined)
    if (!had.length) continue
    if (!(name in data.params)) data.params[name] = had[0][1]
    const value = data.params[name]
    if (had.some(([, v]) => v !== value)) {
      data.notes = data.notes.filter((n) => n.name !== name)
      data.notes.push({ name, value, was: Object.fromEntries(had) })
    }
    sharedDirty = true
    for (const [id] of had) {
      delete ownOf(id)![name]
      dirty.add(id)
    }
  }
  for (const name of Object.keys(data.params)) {
    const l = links.byName.get(name)
    if (!l || l.shared) continue // still shared, or no part has it now (a file being edited): keep it
    for (const id of l.parts) {
      const o = ownOf(id) ?? {}
      if (!(name in o)) o[name] = data.params[name]
      own.set(id, o)
      dirty.add(id)
    }
    delete data.params[name]
    data.notes = data.notes.filter((n) => n.name !== name)
    sharedDirty = true
  }
  for (const id of dirty) writeOwn(root, id, idea, own.get(id) ?? null)
  if (sharedDirty) writeShared(root, idea, data)
  return data
}

/** Shared values that apply to a part: the ones for settings it has. */
function sharedFor(links: ParamLinks, partId: string, shared: Record<string, ParamValue>): Record<string, ParamValue> {
  return Object.fromEntries(Object.entries(shared).filter(([n]) => isSharedFor(links, partId, n)))
}

/**
 * The Customizer overrides a part renders, checks and slices with, on an idea (default: the open one): its own
 * saved values plus the shared values of the settings it has (set from the Parameters panel or the agent's
 * render_part params; `{params: null}` = none), so a file change, a restore or a plain re-render never drops them.
 * On another idea the files may differ, so every shared value is included (callers filter by what the part
 * declares there). Projects from before any saved overrides fall back to the open idea's last render.
 */
export function partOverridesAt(root: string, partId: string, idea?: string): Record<string, ParamValue> | null {
  migrateOverrides(root)
  const open = currentIdeaAt(root)
  const which = idea ?? open
  let shared: Record<string, ParamValue>
  if (which === open) {
    const links = paramLinksAt(root)
    shared = sharedFor(links, partId, normalizeShared(root, open, links).params)
  } else shared = readShared(root, which).params
  const own = ownOverrides(root, partId, which)
  if (own || Object.keys(shared).length) {
    const all = { ...(own ?? {}), ...shared }
    return Object.keys(all).length ? sortedParams(all) : null
  }
  // The render fallback is only for projects that never saved overrides: once any idea has, another idea's render
  // must not leak in.
  if (which !== open || existsSync(paramsRoot(root))) return null
  try {
    const meta = JSON.parse(readFileSync(join(root, "build", `${partId}.render.json`), "utf8")) as { params?: Record<string, ParamValue> | null }
    return meta.params && Object.keys(meta.params).length ? meta.params : null
  } catch {
    return null
  }
}

/**
 * Save a part's Customizer overrides on the open idea (null / `{}` clears them): `params` is the whole set the part
 * should render with. Values of shared settings are saved once for every part that has them (dropping one resets
 * it for all of them); the rest are the part's own. `others` = the other parts whose values changed with it.
 */
export function saveOverrides(root: string, partId: string, params: Record<string, ParamValue> | null | undefined): { changed: boolean; others: string[] } {
  migrateOverrides(root)
  const idea = currentIdeaAt(root)
  const links = paramLinksAt(root)
  const before = partOverridesAt(root, partId)
  const data = normalizeShared(root, idea, links)
  const next = params ?? {}
  const mine = links.byPart.get(partId) ?? new Map<string, string>()
  const isShared = (n: string) => isSharedFor(links, partId, n)
  const touched: string[] = []
  for (const n of mine.keys()) {
    if (!isShared(n)) continue
    if (n in next) {
      if (data.params[n] !== next[n]) touched.push(n)
      data.params[n] = next[n]
    } else if (n in data.params) {
      touched.push(n)
      delete data.params[n]
    }
  }
  const own = Object.fromEntries(Object.entries(next).filter(([n]) => !isShared(n)))
  if (touched.length) {
    data.notes = data.notes.filter((x) => !touched.includes(x.name))
    writeShared(root, idea, data)
  }
  const file = overridesFile(root, partId, idea)
  const ownBefore = ownOverrides(root, partId, idea)
  if (!existsSync(file) || JSON.stringify(sortedParams(ownBefore)) !== JSON.stringify(sortedParams(own))) writeOwn(root, partId, idea, own)
  const after = partOverridesAt(root, partId)
  const others = links.parts.filter((id) => id !== partId && touched.some((n) => links.byName.get(n)?.parts.includes(id)))
  return { changed: JSON.stringify(before ?? null) !== JSON.stringify(after ?? null) || touched.length > 0, others }
}

/** Save a part's Customizer overrides on the open idea (see saveOverrides). Returns true if they changed. */
export function savePartOverrides(root: string, partId: string, params: Record<string, ParamValue> | null | undefined): boolean {
  return saveOverrides(root, partId, params).changed
}

/**
 * Drop saved values of these settings (the designer changed the design value itself): the shared value, and the
 * own values of `parts` (default: every part). Returns the names that had a saved value.
 */
export function clearOverrides(root: string, names: string[], parts?: string[]): string[] {
  migrateOverrides(root)
  const idea = currentIdeaAt(root)
  const data = normalizeShared(root, idea, paramLinksAt(root))
  const dropped = new Set<string>()
  for (const n of names)
    if (n in data.params) {
      delete data.params[n]
      dropped.add(n)
    }
  if (dropped.size) {
    data.notes = data.notes.filter((x) => !dropped.has(x.name))
    writeShared(root, idea, data)
  }
  for (const id of parts ?? partsWithOverrides(root, idea)) {
    const o = ownOverrides(root, id, idea)
    if (!o || !names.some((n) => n in o)) continue
    for (const n of names)
      if (n in o) {
        delete o[n]
        dropped.add(n)
      }
    writeOwn(root, id, idea, o)
  }
  return [...dropped]
}

/** Notes about shared settings whose parts had different values before they were joined (open idea). */
export function sharedNotesAt(root: string): SharedParamNote[] {
  migrateOverrides(root)
  return normalizeShared(root, currentIdeaAt(root), paramLinksAt(root)).notes
}

/** Dismiss those notes (all when `names` is omitted). */
export function dismissSharedNotes(root: string, names?: string[]): void {
  const idea = currentIdeaAt(root)
  const data = readShared(root, idea)
  const next = data.notes.filter((n) => names && !names.includes(n.name))
  if (next.length !== data.notes.length) writeShared(root, idea, { ...data, notes: next })
}

/** The shared values saved on an idea (default: the open one), whichever parts have them. */
export function sharedOverridesAt(root: string, idea?: string): Record<string, ParamValue> {
  migrateOverrides(root)
  const open = currentIdeaAt(root)
  return (idea ?? open) === open ? normalizeShared(root, open, paramLinksAt(root)).params : readShared(root, idea!).params
}

/** The open idea's saved values as stored: each part's own, and the shared ones under SHARED_KEY (version trailers). */
export function storedOverridesAt(root: string): Record<string, Record<string, ParamValue>> {
  migrateOverrides(root)
  const idea = currentIdeaAt(root)
  normalizeShared(root, idea, paramLinksAt(root))
  const out: Record<string, Record<string, ParamValue>> = {}
  for (const id of partsWithOverrides(root, idea).sort()) {
    const o = ownOverrides(root, id, idea)
    if (o && Object.keys(o).length) out[id] = sortedParams(o)
  }
  const shared = readShared(root, idea).params
  if (Object.keys(shared).length) out[SHARED_KEY] = sortedParams(shared)
  return out
}

/**
 * Make the open idea's stored values equal a snapshot (from storedOverridesAt, or an older version's per-part one):
 * parts not in it go back to the file's defaults, and so do shared values when it has none. Returns true if any
 * changed. An older snapshot's per-part values of shared settings are joined again on the next read.
 */
export function restoreStoredOverrides(root: string, snap: Record<string, Record<string, ParamValue>>): boolean {
  migrateOverrides(root)
  const idea = currentIdeaAt(root)
  let changed = false
  for (const id of new Set([...partsWithOverrides(root, idea), ...Object.keys(snap).filter((k) => k !== SHARED_KEY)])) {
    const want = snap[id] ?? null
    const have = ownOverrides(root, id, idea)
    if (have && JSON.stringify(sortedParams(have)) === JSON.stringify(sortedParams(want))) continue
    writeOwn(root, id, idea, want)
    changed = true
  }
  const data = readShared(root, idea)
  const want = snap[SHARED_KEY] ?? {}
  if (JSON.stringify(sortedParams(data.params)) !== JSON.stringify(sortedParams(want))) {
    writeShared(root, idea, { params: { ...want }, notes: data.notes })
    changed = true
  }
  return changed
}

/** A part's stamp now (file + includes + its current overrides). */
export function currentPartStampAt(root: string, part: { id: string; file: string }): SourceStamp {
  return partStampAt(join(root, part.file), partOverridesAt(root, part.id), root)
}

/**
 * Stamp of the assembly-level artifacts (picture guide, assembly renders, motion checks): every part's stamp, plus
 * assembly.json and assembly.scad with its includes.
 */
export function assemblyStampAt(root: string, parts: { id: string; file: string }[]): SourceStamp {
  const h = createHash("sha256")
  const files: Record<string, string> = {}
  const out: NonNullable<SourceStamp["parts"]> = {}
  for (const p of [...parts].sort((a, b) => a.id.localeCompare(b.id))) {
    const s = currentPartStampAt(root, p)
    out[p.id] = { hash: s.hash, params: s.params ?? null }
    Object.assign(files, s.files)
    h.update(`part:${p.id}:${s.hash}\n`)
  }
  try {
    const buf = readFileSync(join(root, "assembly.json"))
    files["assembly.json"] = short(buf)
    h.update("assembly.json\n").update(buf)
  } catch {
    files["assembly.json"] = "missing"
    h.update("assembly.json missing\n")
  }
  const scad = join(root, "assembly.scad")
  if (existsSync(scad))
    walkScad(scad, root, (abs, src) => {
      const k = fileKey(root, abs)
      files[k] = src ? short(src) : "missing"
      h.update(`asm:${k}:${files[k]}\n`)
    })
  return { hash: h.digest("hex").slice(0, 16), files, parts: out }
}

const listNames = (names: string[]) => (names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`)

function paramChanges(a?: Record<string, ParamValue> | null, b?: Record<string, ParamValue> | null): string[] {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])
  return [...keys].filter((k) => (a ?? {})[k] !== (b ?? {})[k]).sort()
}

/** Reason given for an artifact made before stamps existed (it can't say what it was built from). */
export const UNSTAMPED_REASON = "it was made before Crease tracked what it's built from"

/**
 * Why an artifact built from `recorded` no longer matches `current`, in plain words ("lib/params.scad changed").
 * Empty = current.
 */
export function stampReasons(recorded: SourceStamp | null | undefined, current: SourceStamp): string[] {
  if (!recorded?.hash) return [UNSTAMPED_REASON]
  if (recorded.hash === current.hash) return []
  const out: string[] = []
  const rf = recorded.files ?? {}
  const cf = current.files
  for (const f of [...new Set([...Object.keys(rf), ...Object.keys(cf)])].sort()) {
    const was = rf[f]
    const now = cf[f]
    if (was === now) continue
    if (now === undefined) out.push(`${f} is no longer used`)
    else if (was === undefined) out.push(`${f} is now used`)
    else if (now === "missing") out.push(`${f} is missing`)
    else if (was === "missing") out.push(`${f} was added`)
    else out.push(`${f} changed`)
  }
  if (recorded.parts || current.parts) {
    const rp = recorded.parts ?? {}
    const cp = current.parts ?? {}
    for (const id of Object.keys(cp).filter((id) => !rp[id]).sort()) out.push(`part ${id} was added`)
    for (const id of Object.keys(rp).filter((id) => !cp[id]).sort()) out.push(`part ${id} was removed`)
    for (const id of Object.keys(cp).filter((id) => rp[id]).sort()) {
      const changed = paramChanges(rp[id].params, cp[id].params)
      if (changed.length) out.push(`${id}'s Customizer values changed (${listNames(changed)})`)
    }
  } else {
    const changed = paramChanges(recorded.params, current.params)
    if (changed.length) out.push(`Customizer values changed (${listNames(changed)})`)
  }
  return out.length ? out : ["its sources changed"]
}
