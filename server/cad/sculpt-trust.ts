// Import trust for Blender part scripts (R09, like projects/agent-config.ts for assistant settings). A script runs in
// Blender's sandbox (blender.ts), but a script that came in from elsewhere (a shared build pack) doesn't run at all
// until the user allows it: pack import records the content hash of every .py it writes here, and buildSculpt
// refuses a script (or a lib/ file it imports) whose content matches one. The list lives in
// <STUDIO_HOME>/blender-trust.json, outside every project, so a project (or the sandboxed designer) can't clear it.
// Editing a blocked file makes it a different file: whoever edits it (the designer, the user) now owns it.
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { STUDIO_HOME } from "../config"

interface Store {
  blocked: Record<string, { project: string; file: string; at: string }>
}

const defaultFile = () => join(STUDIO_HOME, "blender-trust.json")
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex")

function read(file: string): Store {
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as Partial<Store>
    return { blocked: s && typeof s.blocked === "object" && s.blocked ? s.blocked : {} }
  } catch {
    return { blocked: {} }
  }
}

function write(file: string, s: Store) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
}

/** Record Python files that came from elsewhere: they won't run until allowScripts. */
export function blockScripts(projectId: string, files: { rel: string; content: Buffer | string }[], trustFile = defaultFile()): string[] {
  if (!files.length) return []
  const s = read(trustFile)
  const at = new Date().toISOString()
  for (const f of files) s.blocked[sha(f.content)] = { project: projectId, file: f.rel, at }
  write(trustFile, s)
  return files.map((f) => f.rel)
}

/** Why these files (a script and the lib/ files it imports) may not run, or null. */
export function blockedReason(files: { rel: string; content: Buffer | string }[], trustFile = defaultFile()): string | null {
  const s = read(trustFile)
  const hit = files.filter((f) => s.blocked[sha(f.content)])
  if (!hit.length) return null
  return `${hit.map((f) => f.rel).join(", ")} came in a shared build pack, so ${hit.length === 1 ? "its Blender script doesn't" : "their Blender scripts don't"} run until you allow it: press "Allow sculpt scripts".`
}

/** Project-relative files of a project that are still blocked. */
export function blockedScripts(projectId: string, trustFile = defaultFile()): string[] {
  return Object.values(read(trustFile).blocked)
    .filter((b) => b.project === projectId)
    .map((b) => b.file)
}

/** The user's "allow these scripts": forget every block recorded for the project. Returns the files. */
export function allowScripts(projectId: string, trustFile = defaultFile()): string[] {
  const s = read(trustFile)
  const files: string[] = []
  for (const [k, b] of Object.entries(s.blocked))
    if (b.project === projectId) {
      files.push(b.file)
      delete s.blocked[k]
    }
  if (files.length) write(trustFile, s)
  return files
}
