// Portable build pack (R16): export a project as one .zip a maker can share, and open such a zip as a new project.
//
// Layout of a pack:
//   printstudio-pack.json   manifest (BuildPackManifest): metadata, licence, per-part sizes/materials/settings, every
//                           file with its sha256, labelled G-code, what was left out
//   CHECKSUMS.sha256        `sha256sum -c` format, every file including the manifest
//   README.txt              plain-words description for someone without the app
//   source/                 project.json (scrubbed), parts/, lib/, assembly.json, assembly.scad, other source files
//   guide/                  assembly-guide.html (+ .pdf when a PDF renderer is available: the desktop app)
//   bom/                    shopping-list.md / .csv, bom.json (no personal "already have" ticks)
//   renders/, models/       part pictures and STLs (derived, for people without the app)
//   gcode/                  optional, only current jobs, each labelled for its machine/profile
//   notes/                  optional print outcomes/notes from this install
//
// Never exported: .git, .studio (sessions, transcripts, checks, job state, print log), assistant config (.claude,
// CLAUDE.md, .mcp.json, Codex's AGENTS.md / .codex / .agents), credential-like files, and absolute paths (usernames scrubbed from every text file; known
// secret values and key patterns redacted).
//
// Import verifies every checksum before writing anything, creates a NEW project, and treats it as untrusted (R09):
// any assistant settings in it are moved aside until the user turns them on, trust recorded under a recycled
// project id is forgotten, and its Python files (Blender part scripts and their lib/ modules) don't run until the
// user allows them (server/cad/sculpt-trust.ts).
import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { simpleGit } from "simple-git"
import type {
  BuildPackFile,
  BuildPackGcode,
  BuildPackImportResult,
  BuildPackManifest,
  BuildPackOptions,
  BuildPackPartInfo,
  BuildPackPreview,
  PartRef,
  PrintIntent,
  PrintJob,
  Project,
} from "../../shared/types"
import { BUILD_PACK_FORMAT } from "../../shared/types"
import { getSettings, STUDIO_HOME } from "../config"
import { listPrints } from "../db"
import { readAssembly } from "../assembly/index"
import { buildBom } from "../assembly/bom"
import { buildShoppingList, shoppingCsv, shoppingMarkdown } from "../assembly/shopping"
import { DEFAULT_SOURCING } from "../assembly/stores"
import { loadJob, projectJobs, readJobBytes } from "../jobs"
import { prepareAgentConfig, revokeAgentConfig } from "../projects/agent-config"
import { blockScripts } from "../cad/sculpt-trust"
import { GUIDE_STAMP_REL, guideValidityAt } from "../projects/validity"
import { assemblyStampAt } from "../projects/revision"
import { createProjectFromFiles, getProject, httpError, projectDir, slugify } from "../projects/store"
import { redactSecrets } from "../secrets"
import { readZip, writeZip, ZipError, type ZipEntry } from "./zip"
import { APP_NAME } from "../../shared/brand"

export const MANIFEST = "printstudio-pack.json"
export const CHECKSUMS = "CHECKSUMS.sha256"
export const DEFAULT_LICENSE = "All rights reserved"
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex")
function omit<T extends object, K extends keyof T>(o: T, keys: K[]): Omit<T, K> {
  const out = { ...o }
  for (const k of keys) delete out[k]
  return out
}

// ---------------------------------------------------------------------------------------------
// Hooks: PDF renderer (desktop app) and app version
// ---------------------------------------------------------------------------------------------

type PdfRenderer = (html: string) => Promise<Buffer>
let pdfRenderer: PdfRenderer | null = null
/** The desktop app registers Chromium's printToPDF here; the browser-dev server has none (HTML only). */
export function setPdfRenderer(fn: PdfRenderer | null) {
  pdfRenderer = fn
}

let appVersionOverride: string | null = null
export function setAppVersion(v: string | null) {
  appVersionOverride = v
}
export function appVersion(): string {
  if (appVersionOverride) return appVersionOverride
  const here = dirname(fileURLToPath(import.meta.url))
  for (const dir of [join(here, "..", ".."), join(here, ".."), process.cwd()]) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string }
      if (pkg.name === "printstudio" && pkg.version) return pkg.version
    } catch {
      /* next */
    }
  }
  return "unknown"
}

// ---------------------------------------------------------------------------------------------
// Scrubbing: private paths and secrets out of every text file
// ---------------------------------------------------------------------------------------------

const TEXT_EXT = /\.(scad|json|md|txt|csv|html?|svg|gcode|js|ts|py|ya?ml|toml|ini|cfg|xml|dxf|log)$/i
const isText = (path: string, data: Buffer) => TEXT_EXT.test(path) || (data.length < 4 * 1024 * 1024 && !data.subarray(0, 8192).includes(0))

/** Replace absolute paths that reveal a username or this install's folders; redact secret values/patterns. */
export function scrubText(text: string, projectRoot?: string): string {
  let out = text
  const swaps: [string, string][] = []
  if (projectRoot) swaps.push([projectRoot, "<project>"])
  swaps.push([STUDIO_HOME, "<Crease data>"])
  const home = homedir()
  if (home && home.length > 3) swaps.push([home, "~"])
  for (const [from, to] of swaps) if (from) out = out.split(from).join(to)
  out = out
    .replace(/\/Users\/(?!<user>)[^/\s"'<>`;:,)]+/g, "/Users/<user>")
    .replace(/\/home\/(?!<user>)[^/\s"'<>`;:,)]+/g, "/home/<user>")
    .replace(/([A-Za-z]:)(\\{1,2}|\/)Users(\\{1,2}|\/)(?!<user>)[^\\/\s"'<>`;:,)]+/g, "$1$2Users$3<user>")
  return redactSecrets(out)
}

// ---------------------------------------------------------------------------------------------
// What goes in
// ---------------------------------------------------------------------------------------------

const AGENT_CONFIG_RE = /(^|\/)(\.(claude|codex|agents)(\/|$)|CLAUDE(\.local)?\.md$|AGENTS(\.override)?\.md$|\.mcp\.json$)/i
const CREDENTIAL_RE = /(^|\/)(\.env(\..*)?|\.npmrc|\.netrc|\.pypirc|id_(rsa|ed25519|ecdsa)(\.pub)?|.*\.(pem|key|p12|pfx)|secrets?(\.[\w-]+)?\.json|credentials?(\.[\w-]+)?\.json|agent-trust\.json)$/i
const APP_TOP = new Set([".git", ".studio", "build", "renders", "imports", "node_modules"])

/** Why a project-relative source path stays out of a pack (null = include). */
export function sourceExclusion(rel: string): string | null {
  const segs = rel.split("/")
  if (APP_TOP.has(segs[0]) || segs.includes(".git")) return "app data"
  if (AGENT_CONFIG_RE.test(rel)) return "assistant settings"
  if (CREDENTIAL_RE.test(rel)) return "credentials"
  if (/(^|\/)(\.DS_Store|Thumbs\.db)$|\.tmp$|~$/.test(rel) || rel === ".gitignore" || rel === "project.json") return "housekeeping"
  if (/-kept-\d+/.test(segs[0])) return "app data"
  return null
}

async function sourceFiles(root: string): Promise<string[]> {
  let files: string[] = []
  try {
    const git = simpleGit({ baseDir: root })
    const out = await git.raw(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    files = out.split("\0").filter(Boolean)
  } catch {
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, e.name)
        const rel = relative(root, abs).split(sep).join("/")
        if (APP_TOP.has(rel.split("/")[0])) continue
        if (e.isDirectory()) walk(abs)
        else if (e.isFile()) files.push(rel)
      }
    }
    walk(root)
  }
  // only regular files that are still there (the index may list deleted ones); links are never followed or packed
  return [...new Set(files)]
    .filter((rel) => {
      try {
        return lstatSync(join(root, rel)).isFile()
      } catch {
        return false
      }
    })
    .sort()
}

interface Planned {
  path: string
  role: BuildPackFile["role"]
  data: () => Promise<Buffer> | Buffer
  size: number
}

const NICE: Record<string, string> = { layer_height: "layerHeightMm", sparse_infill_density: "infill", wall_loops: "walls", enable_support: "supports" }

function jobMaterials(job: PrintJob | null): string[] {
  const t = job?.settings?.filament_type
  return t ? [...new Set(t.split(/[;,]/).map((s) => s.trim()).filter(Boolean))] : []
}

function gcodeLabel(job: PrintJob, materials: string[]): Omit<BuildPackGcode, "path"> {
  const machine = job.machine.model && job.machine.model !== job.machine.name ? `${job.machine.name} (${job.machine.model})` : job.machine.name
  const mats = materials.length ? materials.join(" + ") : "its loaded filament"
  return {
    jobId: job.id,
    partIds: job.partIds,
    ...(job.plate ? { plate: job.plate } : {}),
    machine,
    profile: job.slicer.printerProfile ?? job.machine.slicerProfile ?? null,
    nozzleMm: job.machine.nozzleMm,
    materials,
    intent: job.intent,
    label: `for ${machine}, ${job.machine.nozzleMm} mm nozzle, ${mats} — won't fit other printers`,
  }
}

interface Plan {
  project: Project
  root: string
  license: string
  description: string | null
  files: Planned[]
  gcode: (BuildPackGcode & { stale: string[]; include: boolean })[]
  parts: BuildPackPartInfo[]
  materials: string[]
  hardwareCount: number
  excluded: string[]
  notes: number
  guide: boolean
  guideCurrent: boolean
  warnings: string[]
}

async function plan(projectId: string, opts: BuildPackOptions): Promise<Plan> {
  const project = await getProject(projectId)
  const root = projectDir(projectId)
  const license = (opts.license ?? project.license ?? DEFAULT_LICENSE).trim().slice(0, 120) || DEFAULT_LICENSE
  const { assembly, error } = await readAssembly(projectId)
  const description = (opts.description ?? project.description ?? assembly?.summary ?? "").trim().slice(0, 2000) || null
  const files: Planned[] = []
  const warnings: string[] = []
  const excluded = new Set<string>([
    "Agent sessions and chat transcripts",
    "App internals (.studio: checks, job state, print log)",
    "Version history (.git)",
    "Credentials and API keys",
    "Usernames and folder paths on this computer (scrubbed from every file)",
  ])
  const fileAt = (rel: string) => join(root, rel)
  const add = (path: string, role: Planned["role"], abs: string) => {
    if (existsSync(abs)) files.push({ path, role, size: statSync(abs).size, data: () => readFileSync(abs) })
  }
  const addData = (path: string, role: Planned["role"], data: Buffer | string) => {
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data)
    files.push({ path, role, size: b.length, data: () => b })
  }

  // source
  for (const rel of await sourceFiles(root)) {
    const why = sourceExclusion(rel)
    if (why === "assistant settings") excluded.add("Assistant settings (.claude, CLAUDE.md, .mcp.json, AGENTS.md, .codex, .agents)")
    if (why === "credentials") excluded.add("Credential-like files (.env, keys)")
    if (why) continue
    add(`source/${rel}`, "source", fileAt(rel))
  }
  const cleanProject = {
    name: project.name,
    tags: project.tags ?? [],
    parts: project.parts.map((p) => ({ id: p.id, file: p.file, qty: p.qty, colors: p.colors ?? [] })),
    ...(project.intent ? { intent: project.intent } : {}),
    license,
    ...(description ? { description } : {}),
  }
  addData("source/project.json", "source", JSON.stringify(cleanProject, null, 2) + "\n")

  // guide
  const guideAbs = fileAt("build/assembly-guide.html")
  const guide = existsSync(guideAbs)
  if (guide) add("guide/assembly-guide.html", "guide", guideAbs)
  else if (assembly) warnings.push("The assembly guide hasn't been built yet, so the pack has no guide. Build it in Assembly first.")
  // fresh guide (step pictures + finished-build picture match the sources being packed): the importer can say so
  const guideCurrent = guide && guideValidityAt(root, project.parts).state === "fresh"
  if (error) warnings.push("assembly.json has errors; the pack includes it as-is.")

  // BOM (regenerated, no personal ticks)
  const sourcing = getSettings().sourcing ?? DEFAULT_SOURCING
  if (assembly) {
    const list = buildShoppingList(assembly, sourcing)
    addData("bom/shopping-list.md", "bom", shoppingMarkdown(assembly.title ?? project.name, list))
    addData("bom/shopping-list.csv", "bom", shoppingCsv(list))
  }
  const bom = buildBom({ project, assembly, sourcing, have: {}, bin: [] })
  addData("bom/bom.json", "bom", JSON.stringify({ items: bom.items.map((it) => omit(it, ["have", "haveSource", "inBin"])), region: bom.region, priceNote: bom.priceNote }, null, 2) + "\n")
  if (existsSync(join(root, ".studio", "bom.json"))) excluded.add('Your "already have" ticks')

  // renders + models
  for (const p of project.parts) {
    add(`renders/${p.id}-iso.png`, "render", fileAt(`renders/${p.id}-iso.png`))
    add(`models/${p.id}.stl`, "model", fileAt(`build/${p.id}.stl`))
    if (!existsSync(fileAt(`build/${p.id}.stl`))) warnings.push(`Part "${p.id}" has no exported model yet (render it to include an STL).`)
  }
  add("renders/assembly-complete.png", "render", fileAt("renders/assembly-complete.png"))

  // jobs: per-part info + optional G-code
  const jobs = await projectJobs(projectId).catch(() => null)
  const views = [...Object.values(jobs?.parts ?? {}), ...(jobs?.plates?.plates ?? [])]
  const seen = new Set<string>()
  const gcode: Plan["gcode"] = []
  const names = new Set<string>()
  for (const v of views) {
    if (seen.has(v.id)) continue
    seen.add(v.id)
    const job = loadJob(projectId, v.id)
    if (!job) continue
    let name = `gcode/${job.gcodeName.replace(/[^\w.-]+/g, "_")}`
    for (let i = 2; names.has(name); i++) name = name.replace(/(\.gcode)?$/, `-${i}.gcode`)
    names.add(name)
    gcode.push({ ...gcodeLabel(job, jobMaterials(job)), path: name, stale: v.stale, include: !!opts.includeGcode && v.stale.length === 0 })
  }
  for (const g of gcode.filter((x) => x.include)) {
    const job = loadJob(projectId, g.jobId)!
    files.push({ path: g.path, role: "gcode", size: job.bytes, data: () => readJobBytes(projectId, job) })
  }
  if (gcode.some((g) => g.include))
    addData(
      "gcode/README.txt",
      "gcode",
      "Sliced files, ready to print ONLY on the machine and settings they were made for:\n\n" +
        gcode
          .filter((g) => g.include)
          .map((g) => `${g.path.replace(/^gcode\//, "")}\n  ${g.label}\n  print profile: ${g.intent}${g.profile ? ` · slicer profile: ${g.profile}` : ""}\n`)
          .join("\n") +
        "\nOn any other printer, slice the models/ (or source/) files yourself.\n",
    )
  if (!opts.includeGcode && gcode.length) excluded.add("Sliced G-code (tick “Include G-code” to add it)")
  if (opts.includeGcode && gcode.some((g) => !g.include)) warnings.push("Out-of-date G-code is left out; slice again to include it.")

  const parts: BuildPackPartInfo[] = []
  const allMaterials = new Set<string>()
  for (const p of project.parts) {
    const view = jobs?.parts?.[p.id] ?? jobs?.plates?.plates.find((j) => j.partIds.includes(p.id))
    const job = view ? loadJob(projectId, view.id) : null
    const mats = jobMaterials(job)
    mats.forEach((m) => allMaterials.add(m))
    let sizeMm: [number, number, number] | null = null
    try {
      const meta = JSON.parse(readFileSync(fileAt(`build/${p.id}.render.json`), "utf8")) as { stats?: { sizeMm?: [number, number, number] } }
      sizeMm = meta.stats?.sizeMm ?? null
    } catch {
      /* not rendered yet */
    }
    const ap = assembly?.parts.find((x) => x.id === p.id)
    const printSettings: BuildPackPartInfo["printSettings"] = job
      ? {
          intent: job.intent,
          ...Object.fromEntries(Object.entries(NICE).filter(([k]) => job.settings[k] != null).map(([k, nice]) => [nice, job.settings[k]])),
          ...(job.overrides && Object.keys(job.overrides).length ? { overrides: job.overrides } : {}),
        }
      : null
    parts.push({
      id: p.id,
      name: ap?.name ?? p.id,
      qty: ap?.qty ?? p.qty,
      colors: ap?.color ? [ap.color] : (p.colors ?? []),
      sizeMm,
      material: mats[0] ?? null,
      printSettings,
    })
  }

  // print notes
  let notes = 0
  let printRecords: unknown[] = []
  try {
    const prints = listPrints(projectId)
    notes = prints.length
    printRecords = prints.map((r) => ({
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      state: r.state,
      result: r.result,
      notes: r.notes,
      partIds: r.partIds,
      gcodeName: r.gcodeName,
      estimatedTimeS: r.estimatedTimeS,
      filamentG: r.filamentG,
    }))
  } catch {
    /* catalog unavailable */
  }
  // R15 outcomes: .studio/prints/<id>.json and .studio/jobs/<sha>/outcome.json + photos/ (only when ticked).
  const outcomeFiles: [string, string][] = [] // [pack path, abs]
  const listDir = (abs: string) => {
    try {
      return readdirSync(abs, { withFileTypes: true })
    } catch {
      return []
    }
  }
  for (const e of listDir(join(root, ".studio", "prints")))
    if (e.isFile() && /^[\w.-]+\.json$/.test(e.name)) outcomeFiles.push([`notes/prints/${e.name}`, join(root, ".studio", "prints", e.name)])
  for (const j of listDir(join(root, ".studio", "jobs"))) {
    if (!j.isDirectory() || !/^[0-9a-f]{64}$/.test(j.name)) continue
    const jd = join(root, ".studio", "jobs", j.name)
    if (existsSync(join(jd, "outcome.json")) && lstatSync(join(jd, "outcome.json")).isFile())
      outcomeFiles.push([`notes/jobs/${j.name}/outcome.json`, join(jd, "outcome.json")])
    for (const ph of listDir(join(jd, "photos")))
      if (ph.isFile() && /^[\w.-]+\.(jpe?g|png|webp|heic)$/i.test(ph.name)) outcomeFiles.push([`notes/jobs/${j.name}/photos/${ph.name}`, join(jd, "photos", ph.name)])
  }
  // Count prints, not files: one print has a record (.studio/prints/<id>.json) AND its job's outcome.json.
  const count = (re: RegExp) => outcomeFiles.filter(([p]) => re.test(p)).length
  notes = Math.max(notes, count(/^notes\/prints\/.*\.json$/), count(/^notes\/jobs\/[^/]+\/outcome\.json$/))
  if (opts.includeNotes && notes) {
    if (printRecords.length) addData("notes/print-notes.json", "notes", JSON.stringify(printRecords, null, 2) + "\n")
    for (const [path, abs] of outcomeFiles) add(path, "notes", abs)
  } else if (notes) excluded.add("Print notes, outcomes and photos (tick “Include print notes” to add them)")

  return {
    project,
    root,
    license,
    description,
    files,
    gcode,
    parts,
    materials: [...allMaterials],
    hardwareCount: assembly?.hardware.reduce((n, h) => n + h.qty, 0) ?? 0,
    excluded: [...excluded],
    notes,
    guide,
    guideCurrent,
    warnings,
  }
}

export async function packPreview(projectId: string, opts: BuildPackOptions = {}): Promise<BuildPackPreview> {
  const p = await plan(projectId, opts)
  return {
    name: p.project.name,
    license: p.license,
    description: p.description,
    files: p.files.map((f) => ({ path: f.path, bytes: f.size, role: f.role })),
    excluded: p.excluded,
    gcode: p.gcode.map((g) => omit(g, ["path", "include"])),
    notes: p.notes,
    guidePdf: !p.guide ? "no-guide" : pdfRenderer ? "yes" : "no-renderer",
    warnings: p.warnings,
  }
}

function readme(m: BuildPackManifest): string {
  const lines = [
    m.project.name,
    "=".repeat(Math.min(60, m.project.name.length)),
    "",
    ...(m.project.description ? [m.project.description, ""] : []),
    `Licence: ${m.project.license}`,
    `Made with Crease ${m.app.version} on ${m.createdAt.slice(0, 10)}.`,
    "",
    "What's inside",
    "- guide/       step-by-step assembly guide (open the .html in a browser" + (m.guidePdf ? ", or the .pdf)" : ")"),
    "- bom/         shopping list: what to print, buy and make",
    "- models/      STL files to slice on any printer",
    "- source/      the editable OpenSCAD design (open the whole pack in Crease to keep designing)",
    ...(m.gcode.length ? ["- gcode/       sliced files for ONE specific printer: see gcode/README.txt"] : []),
    "",
    "Parts",
    ...m.parts.map(
      (p) =>
        `- ${p.qty}× ${p.name}${p.sizeMm ? ` (${p.sizeMm.map((v) => Math.round(v * 10) / 10).join(" × ")} mm)` : ""}${p.material ? `, ${p.material}` : ""}${p.colors.length ? `, ${p.colors.join("/")}` : ""}`,
    ),
    "",
    `Check the files: sha256sum -c ${CHECKSUMS}`,
    "",
  ]
  return lines.join("\n")
}

export async function exportPack(projectId: string, opts: BuildPackOptions = {}): Promise<{ zip: Buffer; filename: string; manifest: BuildPackManifest }> {
  const p = await plan(projectId, opts)
  const entries: (ZipEntry & { role: BuildPackFile["role"] })[] = []
  for (const f of p.files) {
    let data = await f.data()
    if (isText(f.path, data)) data = Buffer.from(scrubText(data.toString("utf8"), p.root), "utf8")
    entries.push({ path: f.path, data, role: f.role })
  }
  let guidePdf = false
  if (p.guide && pdfRenderer) {
    try {
      const html = entries.find((e) => e.path === "guide/assembly-guide.html")!.data.toString("utf8")
      entries.push({ path: "guide/assembly-guide.pdf", data: await pdfRenderer(html), role: "guide" })
      guidePdf = true
    } catch (e) {
      console.error("[pack] guide PDF failed:", (e as Error).message)
    }
  }
  const manifestBase: Omit<BuildPackManifest, "files"> = {
    format: BUILD_PACK_FORMAT,
    formatVersion: 1,
    app: { name: APP_NAME, version: appVersion() },
    createdAt: new Date().toISOString(),
    project: {
      name: p.project.name,
      description: p.description ? scrubText(p.description, p.root) : null,
      tags: p.project.tags ?? [],
      license: p.license,
      intent: p.project.intent ?? null,
    },
    parts: p.parts,
    materials: p.materials,
    hardwareCount: p.hardwareCount,
    gcode: p.gcode.filter((g) => g.include).map((g) => omit(g, ["stale", "include"])),
    guidePdf,
    ...(p.guideCurrent ? { guideCurrent: true } : {}),
    excluded: p.excluded,
  }
  const draft = { ...manifestBase, files: [] as BuildPackFile[] }
  entries.push({ path: "README.txt", data: Buffer.from(readme(draft)), role: "info" })
  const files: BuildPackFile[] = entries.map((e) => ({ path: e.path, sha256: sha256(e.data), bytes: e.data.length, role: e.role }))
  const manifest: BuildPackManifest = { ...manifestBase, files }
  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2) + "\n")
  const sums = [...files.map((f) => `${f.sha256}  ${f.path}`), `${sha256(manifestBuf)}  ${MANIFEST}`].join("\n") + "\n"
  const zip = writeZip([
    { path: MANIFEST, data: manifestBuf },
    { path: CHECKSUMS, data: Buffer.from(sums) },
    ...entries.map(({ path, data }) => ({ path, data })),
  ])
  return { zip, filename: `${slugify(p.project.name)}.buildpack.zip`, manifest }
}

// ---------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------

/** Check a pack's integrity. Returns the manifest and its files by path; throws 400 with every problem. */
export function verifyPack(buf: Buffer): { manifest: BuildPackManifest; files: Map<string, Buffer> } {
  let entries: ZipEntry[]
  try {
    entries = readZip(buf)
  } catch (e) {
    if (e instanceof ZipError) throw httpError(400, `This isn't a readable build pack: ${e.message}`)
    throw e
  }
  const byPath = new Map(entries.map((e) => [e.path, e.data]))
  const mbuf = byPath.get(MANIFEST)
  if (!mbuf) throw httpError(400, `This zip isn't a Crease build pack (no ${MANIFEST}).`)
  let manifest: BuildPackManifest
  try {
    manifest = JSON.parse(mbuf.toString("utf8")) as BuildPackManifest
  } catch {
    throw httpError(400, `The build pack's ${MANIFEST} is not valid JSON.`)
  }
  if (manifest?.format !== BUILD_PACK_FORMAT) throw httpError(400, "This zip isn't a Crease build pack (unknown format).")
  if (manifest.formatVersion !== 1) throw httpError(400, `This build pack was made by a newer version of Crease (format ${manifest.formatVersion}); update the app to open it.`)
  if (!Array.isArray(manifest.files)) throw httpError(400, "The build pack's file list is missing.")
  const bad: string[] = []
  const listed = new Set<string>([MANIFEST, CHECKSUMS])
  for (const f of manifest.files) {
    listed.add(f.path)
    const data = byPath.get(f.path)
    if (!data) bad.push(`${f.path} (missing)`)
    else if (sha256(data) !== f.sha256 || data.length !== f.bytes) bad.push(f.path)
  }
  for (const path of byPath.keys()) if (!listed.has(path)) bad.push(`${path} (not in the file list)`)
  const sums = byPath.get(CHECKSUMS)?.toString("utf8")
  if (!sums) bad.push(`${CHECKSUMS} (missing)`)
  else {
    const want = new Map(manifest.files.map((f) => [f.path, f.sha256]))
    want.set(MANIFEST, sha256(mbuf))
    const got = new Map(
      sums
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const m = l.match(/^([0-9a-f]{64}) [ *](.+)$/)
          return m ? ([m[2], m[1]] as [string, string]) : (["", ""] as [string, string])
        }),
    )
    for (const [path, h] of want) if (got.get(path) !== h && !bad.includes(path)) bad.push(path === MANIFEST ? `${MANIFEST} (changed)` : path)
  }
  if (bad.length)
    throw httpError(
      400,
      `This build pack is damaged or was changed after it was exported: ${bad.length} file${bad.length === 1 ? "" : "s"} don't match their checksum (${bad.slice(0, 6).join(", ")}${bad.length > 6 ? ", …" : ""}). Nothing was imported.`,
    )
  return { manifest, files: byPath }
}

const PNG_RE = /^renders\/[\w.-]+\.png$/
const INTENTS: PrintIntent[] = ["display", "strong", "fast", "draft", "standard"]

/**
 * Open a pack as a NEW project. Everything is verified first; nothing is written if a checksum fails.
 * `appSkillsDir`: the app's own skill folders (pack copies of them are dropped; the app installs its own).
 */
export async function importPack(buf: Buffer, opts: { appSkillsDir: string; trustFile?: string; blenderTrustFile?: string }): Promise<BuildPackImportResult> {
  const { manifest, files } = verifyPack(buf)
  const warnings: string[] = []
  let meta: Partial<Project> = {}
  try {
    meta = JSON.parse(files.get("source/project.json")?.toString("utf8") ?? "{}") as Partial<Project>
  } catch {
    warnings.push("source/project.json was unreadable; parts were taken from parts/.")
  }
  const appSkills = new Set(existsSync(opts.appSkillsDir) ? readdirSync(opts.appSkillsDir) : [])
  const license = String(manifest.project?.license || meta.license || DEFAULT_LICENSE).slice(0, 120)
  const description = (manifest.project?.description ?? meta.description ?? null) || null
  const importId = `pack-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${sha256(buf).slice(0, 8)}`
  let disabled: string[] = []
  let verified = 0
  let scripts: string[] = []

  const project = await createProjectFromFiles(
    String(manifest.project?.name || meta.name || "Imported build"),
    async (dir, id) => {
      const pyFiles: { rel: string; content: Buffer }[] = []
      const write = (rel: string, data: Buffer) => {
        const abs = join(dir, ...rel.split("/"))
        if (!abs.startsWith(dir + sep)) throw httpError(400, `unsafe path in pack: ${rel}`)
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, data)
      }
      for (const [path, data] of files) {
        if (path === MANIFEST || path === CHECKSUMS) continue
        verified++
        if (path.startsWith("source/")) {
          const rel = path.slice("source/".length)
          if (rel === "project.json") continue
          const top = rel.split("/")[0]
          if (APP_TOP.has(top) || rel.split("/").includes(".git") || rel === ".gitignore") {
            warnings.push(`Skipped ${rel} (app-managed location).`)
            continue
          }
          const skill = rel.match(/^\.claude\/skills\/([^/]+)\//)
          if (skill && appSkills.has(skill[1])) continue // the app installs its own copy
          write(rel, data)
          if (/\.py$/i.test(rel)) pyFiles.push({ rel, content: data })
        } else if (PNG_RE.test(path)) write(path, data)
        else if (path === "guide/assembly-guide.html") write("build/assembly-guide.html", data)
        else if (path === "bom/shopping-list.md" || path === "bom/shopping-list.csv") write(`build/${path.slice(4)}`, data)
        else if (path.startsWith("gcode/") || path.startsWith("notes/") || path === "guide/assembly-guide.pdf" || path === "README.txt")
          write(`imports/${importId}/${path}`, data)
      }
      // Imported G-code and notes are reference copies: keep them out of version history.
      write(`imports/${importId}/.gitignore`, Buffer.from("gcode/\nnotes/\n*.pdf\n"))
      write(`imports/${importId}/pack.json`, files.get(MANIFEST)!)
      write(
        `imports/${importId}/source.json`,
        Buffer.from(
          JSON.stringify(
            {
              kind: "build-pack",
              name: manifest.project?.name ?? null,
              license,
              description,
              packCreatedAt: manifest.createdAt ?? null,
              appVersion: manifest.app?.version ?? null,
              importedAt: new Date().toISOString(),
              files: manifest.files.length,
            },
            null,
            2,
          ) + "\n",
        ),
      )
      // R09: untrusted until the user says otherwise. Forget any trust recorded under this (possibly recycled) id,
      // then move every assistant-config item aside right away.
      revokeAgentConfig(id, opts.trustFile ? { trustFile: opts.trustFile } : {})
      disabled = prepareAgentConfig(id, dir, opts.appSkillsDir, opts.trustFile ? { trustFile: opts.trustFile } : {}).disabled
      scripts = blockScripts(id, pyFiles, ...(opts.blenderTrustFile ? [opts.blenderTrustFile] : []))
      const parts: PartRef[] = (Array.isArray(meta.parts) ? meta.parts : [])
        .filter((p): p is PartRef => !!p && typeof p.id === "string" && typeof p.file === "string" && /^parts\/[^/]+\.(scad|blend\.py)$/i.test(p.file))
        .map((p) => ({ id: p.id, file: p.file, qty: Number.isInteger(p.qty) && p.qty > 0 ? p.qty : 1, colors: Array.isArray(p.colors) ? p.colors.filter((c) => typeof c === "string") : [] }))
      // The pack's guide matched its sources when it was made, and those are exactly the files just written: record
      // that, so the guide and the finished-build picture don't read as "older — design changed" (E2E #2 P3).
      if (manifest.guideCurrent === true && files.has("guide/assembly-guide.html"))
        write(GUIDE_STAMP_REL, Buffer.from(JSON.stringify({ source: assemblyStampAt(dir, parts), builtAt: manifest.createdAt ?? new Date().toISOString() }, null, 2) + "\n"))
      return {
        tags: Array.isArray(meta.tags) ? meta.tags.filter((t): t is string => typeof t === "string").slice(0, 20) : [],
        parts,
        ...(meta.intent && INTENTS.includes(meta.intent) ? { intent: meta.intent } : {}),
        license,
        ...(description ? { description: String(description).slice(0, 2000) } : {}),
        source: { importId },
      }
    },
    `import build pack "${String(manifest.project?.name ?? "build").slice(0, 60)}"`,
  )
  if (disabled.length) warnings.push(`The pack had assistant settings (${disabled.join(", ")}); they're off until you turn them on.`)
  if (scripts.length)
    warnings.push(`The pack has ${scripts.length === 1 ? "a Blender script" : `${scripts.length} Blender scripts`} (${scripts.slice(0, 3).join(", ")}${scripts.length > 3 ? ", …" : ""}). Sculpted parts won't build until you allow them (Allow sculpt scripts, on the part).`)
  const gcode = (manifest.gcode ?? []).map((g) => ({ ...g, path: `imports/${importId}/${g.path}` }))
  if (gcode.length) warnings.push("Sliced G-code from the pack is kept for reference only; slice again for your printer.")
  return { project, verified, license, disabledAgentConfig: disabled, gcode, warnings }
}
