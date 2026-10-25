// Geometry import (R23): STL, 3MF and SCAD files dropped into a project.
//
// Two steps so the dialog can ask its questions with the facts in hand: inspect (parse, size in mm vs inches,
// 3MF metadata, libraries/missing files) keeps the bytes in memory under a token; commit writes
//   parts/imported/<id>.stl + parts/imported/<id>.scad (a small wrapper: scale + print orientation) for meshes,
//   parts/imported/<id>.scad for OpenSCAD files (editable like any part),
//   parts/imported/<id>.json (ImportedPartInfo: units, licence, source)
// and registers the part. Meshes stay meshes: the wrapper can scale, rotate and place them, nothing reshapes them.
// R09: every write goes through resolveInside (no links out of the project); a 3MF's own settings are never used;
// a .scad that reads files outside the project (absolute paths, "..") is refused.
import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { ImportCommitRequest, ImportCommitResult, ImportedPartInfo, ImportInspection, ImportSource, PartRef } from "../../shared/types"
import { getPrinterProfile } from "../config"
import { addPart, getProject, httpError, projectDir, slugify } from "../projects/store"
import { PathError, resolveInside } from "../projects/paths"
import { ensureLibraries } from "./libraries"
import { parseStl, type IndexedMesh } from "./mesh"
import { orientationBlock } from "./orient"
import { readThreeMf, ThreeMfError } from "./threemf"

export const MAX_IMPORT_BYTES = 200 * 1024 * 1024
const TOKEN_TTL_MS = 30 * 60 * 1000
const MAX_STAGED = 8

interface Staged {
  projectId: string
  fileName: string
  format: "stl" | "3mf" | "scad"
  sha256: string
  mesh?: IndexedMesh // mm for 3MF, file units for STL
  triangles?: Float32Array // 9 per triangle, same units as mesh (written as the STL)
  scad?: string
  inspection: ImportInspection
  at: number
}
const staged = new Map<string, Staged>()

function prune() {
  const now = Date.now()
  for (const [k, v] of staged) if (now - v.at > TOKEN_TTL_MS) staged.delete(k)
  while (staged.size > MAX_STAGED) staged.delete(staged.keys().next().value!)
}

const r1 = (v: number) => Math.round(v * 10) / 10
const sizeOf = (m: IndexedMesh, k = 1): [number, number, number] => {
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < m.verts.length; i += 3)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], m.verts[i + a])
      hi[a] = Math.max(hi[a], m.verts[i + a])
    }
  return [0, 1, 2].map((a) => r1((hi[a] - lo[a]) * k)) as [number, number, number]
}

/** Raw triangle soup from an STL (binary or ASCII), file units. */
function stlTriangles(buf: Buffer): Float32Array {
  const isBinary = buf.length >= 84 && 84 + buf.readUInt32LE(80) * 50 === buf.length
  if (isBinary) {
    const n = buf.readUInt32LE(80)
    const out = new Float32Array(n * 9)
    for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) out[i * 9 + k] = buf.readFloatLE(84 + i * 50 + 12 + k * 4)
    return out
  }
  const vals: number[] = []
  for (const m of buf.toString("utf8").matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) vals.push(Number(m[1]), Number(m[2]), Number(m[3]))
  vals.length -= vals.length % 9
  return Float32Array.from(vals)
}

function binaryStl(tris: Float32Array, header: string): Buffer {
  const n = tris.length / 9
  const buf = Buffer.alloc(84 + n * 50)
  buf.write(header.slice(0, 79), 0, "ascii")
  buf.writeUInt32LE(n, 80)
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50
    const t = tris.subarray(i * 9, i * 9 + 9)
    const ux = t[3] - t[0], uy = t[4] - t[1], uz = t[5] - t[2]
    const vx = t[6] - t[0], vy = t[7] - t[1], vz = t[8] - t[2]
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz) || 1
    buf.writeFloatLE(nx / l, o)
    buf.writeFloatLE(ny / l, o + 4)
    buf.writeFloatLE(nz / l, o + 8)
    for (let k = 0; k < 9; k++) buf.writeFloatLE(t[k], o + 12 + k * 4)
  }
  return buf
}

function meshFromTriangles(t: Float32Array): IndexedMesh {
  const b = Buffer.alloc(84 + (t.length / 9) * 50)
  b.writeUInt32LE(t.length / 9, 80)
  for (let i = 0; i < t.length / 9; i++) for (let k = 0; k < 9; k++) b.writeFloatLE(t[i * 9 + k], 84 + i * 50 + 12 + k * 4)
  return parseStl(b)
}

/** mm or inch? STLs carry no units: a part only a few units across is most likely inches (if that fits the bed). */
export function guessUnits(
  sizeRaw: [number, number, number],
  bedMm: [number, number, number],
  // the size in mm if it's inches, measured from the mesh (not the rounded raw size × 25.4: the numbers must match
  // what the dialog shows next to it)
  sizeIfInch: [number, number, number] = sizeRaw.map((v) => r1(v * 25.4)) as [number, number, number],
): ImportInspection["units"] {
  const big = Math.max(...sizeRaw)
  const bigInch = Math.max(...sizeIfInch)
  const fitsAsInch = sizeIfInch.every((v, i) => v <= bedMm[i])
  if (big > 0 && big <= 12 && fitsAsInch) {
    const tiny = big <= 6
    return {
      known: null,
      ask: true,
      recommended: tiny ? "inch" : "mm",
      why: `It's only ${r1(big)} units across: ${r1(big)} mm is ${tiny ? "very small" : "small"}, ${r1(bigInch)} mm if the file is in inches.`,
    }
  }
  return { known: null, ask: false, recommended: "mm", why: `${r1(big)} units across reads as millimetres (${r1(big / 25.4)} in).` }
}

const LIB_RE = /^\s*(?:include|use)\s*<([^>]+)>/gm
const FILE_RE = /\b(?:import|surface)\s*\(\s*(?:file\s*=\s*)?"([^"]+)"/g

/** Libraries, files it needs that aren't there, and paths that would read outside the project (refused). */
export function scanScad(src: string, bundled: (lib: string) => boolean): { libraries: string[]; missing: string[]; outside: string[] } {
  const libraries = new Set<string>()
  const missing: string[] = []
  const outside: string[] = []
  const refs = [...src.matchAll(LIB_RE)].map((m) => ({ p: m[1].trim(), lib: true })).concat([...src.matchAll(FILE_RE)].map((m) => ({ p: m[1].trim(), lib: false })))
  for (const { p, lib } of refs) {
    if (/^([A-Za-z]:)?[\\/]/.test(p) || p.startsWith("~") || p.split(/[\\/]/).includes("..")) {
      outside.push(p)
      continue
    }
    const top = p.split("/")[0]
    if (lib && p.includes("/") && bundled(top)) {
      libraries.add(top)
      continue
    }
    missing.push(p)
  }
  return { libraries: [...libraries], missing, outside }
}

function freeId(base: string, taken: Set<string>): string {
  let id = slugify(base) || "imported"
  if (!/^[a-z]/.test(id)) id = `part-${id}`
  if (!taken.has(id)) return id
  for (let i = 2; ; i++) if (!taken.has(`${id}-${i}`)) return `${id}-${i}`
}

const LICENCE_KEYS = ["LicenseTerms", "License", "Licence", "license"]

export async function inspectImport(projectId: string, fileName: string, buf: Buffer): Promise<ImportInspection> {
  const project = await getProject(projectId)
  if (!buf.length) throw httpError(400, "The file is empty.")
  if (buf.length > MAX_IMPORT_BYTES) throw httpError(413, "That file is too big to import (over 200 MB).")
  const name = (fileName || "file").replace(/^.*[\\/]/, "").slice(0, 120)
  const ext = name.toLowerCase().split(".").pop() ?? ""
  if (!["stl", "3mf", "scad"].includes(ext)) throw httpError(415, "Crease can import STL, 3MF and SCAD files.")
  const format = ext as "stl" | "3mf" | "scad"
  const taken = new Set(project.parts.map((p) => p.id))
  const suggestedId = freeId(name.replace(/\.[^.]+$/, ""), taken)
  const bed = getPrinterProfile(project.printer).buildVolumeMm
  const warnings: string[] = []
  const sha256 = createHash("sha256").update(buf).digest("hex")
  let st: Omit<Staged, "inspection" | "at">
  let inspection: Omit<ImportInspection, "token">

  if (format === "scad") {
    const src = buf.toString("utf8")
    if (src.includes("\0")) throw httpError(400, "That doesn't look like an OpenSCAD file.")
    const libsDir = ensureLibraries()
    const scan = scanScad(src, (lib) => existsSync(join(libsDir, lib)))
    if (scan.outside.length)
      throw httpError(422, `This file reads files outside the project (${scan.outside.slice(0, 3).join(", ")}). Remove those lines, or copy the files next to it, and import it again.`)
    for (const m of scan.missing) warnings.push(`It uses "${m}", which wasn't imported with it. Import that file too, or it won't render.`)
    if (scan.libraries.includes("BOSL2")) warnings.push("It uses BOSL2, which comes with Crease.")
    st = { projectId, fileName: name, format, sha256, scad: src }
    inspection = {
      fileName: name,
      format,
      kind: "scad",
      suggestedId,
      units: { known: "mm", ask: false, recommended: "mm", why: "OpenSCAD files are in millimetres." },
      metadata: {},
      libraries: scan.libraries,
      warnings,
    }
  } else {
    let tris: Float32Array
    const metadata: ImportInspection["metadata"] = {}
    let known: "mm" | null = null
    if (format === "3mf") {
      try {
        const t = readThreeMf(buf)
        tris = t.triangles
        known = "mm"
        const md = t.metadata
        if (md.Title) metadata.title = md.Title
        if (md.Designer) metadata.designer = md.Designer
        const lic = LICENCE_KEYS.map((k) => md[k]).find(Boolean)
        if (lic) metadata.licence = lic
        if (md.Copyright) metadata.copyright = md.Copyright
        if (md.Application) metadata.application = md.Application
        const origin = md.Origin ?? md.DesignerUserId ?? md.ProfileUserId
        if (origin && /^https?:\/\//.test(origin)) metadata.source = origin
        if (t.ignored.length) warnings.push(`The print settings and extras saved inside this 3MF were not used (${t.ignored.length} file${t.ignored.length === 1 ? "" : "s"}); Crease slices it with your printer's settings.`)
        if (t.unit !== "millimeter") warnings.push(`It was made in ${t.unit}s; converted to millimetres.`)
      } catch (e) {
        if (e instanceof ThreeMfError) throw httpError(400, e.message)
        throw e
      }
    } else {
      tris = stlTriangles(buf)
      if (!tris.length && buf.length >= 84 && buf.subarray(0, 5).toString() !== "solid") throw httpError(400, "That doesn't look like an STL file.")
    }
    if (!tris.length) throw httpError(400, "This file has no shape in it (no triangles).")
    if (tris.length / 9 > 3_000_000) throw httpError(413, "That mesh is too detailed to import (over 3 million triangles).")
    if (!tris.every(Number.isFinite)) throw httpError(400, "This file has broken numbers in it and can't be imported.")
    const mesh = meshFromTriangles(tris)
    const raw = sizeOf(mesh)
    const units = known ? { known, ask: false, recommended: known, why: "3MF files say their units." } : guessUnits(raw, bed, sizeOf(mesh, 25.4))
    st = { projectId, fileName: name, format, sha256, mesh, triangles: tris }
    inspection = {
      fileName: name,
      format,
      kind: "mesh",
      suggestedId,
      triangles: tris.length / 9,
      sizeIfMm: raw,
      ...(known ? {} : { sizeIfInch: sizeOf(mesh, 25.4) }),
      units,
      metadata,
      libraries: [],
      warnings,
    }
  }
  prune()
  const token = randomUUID()
  const full: ImportInspection = { token, ...inspection }
  staged.set(token, { ...st, inspection: full, at: Date.now() })
  return full
}

const LICENCE_MAX = 120
const clip = (s: string | undefined, n: number) => (typeof s === "string" ? s.trim().slice(0, n) : undefined)

function sourceLine(info: ImportedPartInfo): string {
  const s = info.source
  const from = s.kind === "self" ? "made by the user" : s.kind === "web" ? `from ${s.url || "a website"}` : s.kind === "person" ? `from ${s.author || "someone else"}` : "source unknown"
  return `${from}; licence: ${info.licence}${info.designer ? `; by ${info.designer}` : ""}`
}

/** The wrapper .scad for an imported mesh: scale + documented orientation around import(). */
export function meshWrapper(id: string, info: ImportedPartInfo): string {
  const inch = info.units === "inch"
  const safe = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/\*\//g, "* /")
  return `// Imported mesh "${safe(info.originalName)}" (${safe(sourceLine(info))}).
// printstudio:imported-mesh. A fixed shape (triangles, not a design): it can be scaled, rotated and placed, but
// parameters can't reshape it. Details in ${id}.json.

/* [Size] */
// Size (%)
scale_percent = 100; // [5:1:500]

/* [Hidden] */
units_to_mm = ${inch ? "25.4; // the file is in inches" : "1; // the file is in millimetres"}

${orientationBlock([0, 0, 0], `  scale(units_to_mm * scale_percent / 100) import("${id}.stl", convexity = 10);`)}`
}

export async function commitImport(projectId: string, req: ImportCommitRequest): Promise<ImportCommitResult> {
  prune()
  const st = staged.get(req?.token ?? "")
  if (!st || st.projectId !== projectId) throw httpError(410, "That import has expired. Drop the file in again.")
  const project = await getProject(projectId)
  const taken = new Set(project.parts.map((p) => p.id))
  const wanted = req.id ? slugify(req.id) : st.inspection.suggestedId
  const id = taken.has(wanted) ? freeId(wanted, taken) : wanted
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw httpError(400, `invalid part id: ${id}`)
  const units = req.units === "inch" || req.units === "mm" ? req.units : st.inspection.units.known ?? st.inspection.units.recommended
  if (st.inspection.kind === "mesh" && st.inspection.units.known && units !== st.inspection.units.known) throw httpError(400, "This 3MF already says its units.")
  const src: ImportSource = { kind: (["self", "web", "person", "unknown"] as const).find((k) => k === req.source?.kind) ?? "unknown" }
  const url = clip(req.source?.url, 500)
  if (url) {
    if (!/^https?:\/\//i.test(url)) throw httpError(400, "The link should start with http:// or https://")
    src.url = url
  }
  const author = clip(req.source?.author, 120)
  if (author) src.author = author
  const licence = clip(req.licence, LICENCE_MAX) || (src.kind === "self" ? "I made it" : "Unknown")

  const md = st.inspection.metadata
  const k = units === "inch" ? 25.4 : 1
  const info: ImportedPartInfo = {
    kind: st.inspection.kind,
    format: st.format,
    originalName: st.fileName,
    importedAt: new Date().toISOString(),
    sha256: st.sha256,
    units,
    source: src,
    licence,
    ...(md.title ? { title: md.title } : {}),
    ...(author || md.designer ? { designer: author || md.designer } : {}),
    ...(st.mesh ? { sizeMm: sizeOf(st.mesh, k), triangles: st.triangles!.length / 9 } : {}),
    ...(st.format === "3mf" ? { ignored: ["the 3MF's own print settings, plates and extras (your printer's settings are used)"] } : {}),
  }

  const root = projectDir(projectId)
  const rel = (ext: string) => `parts/imported/${id}.${ext}`
  const abs = (ext: string) => {
    try {
      return resolveInside(root, rel(ext))
    } catch (e) {
      if (e instanceof PathError) throw httpError(e.statusCode, e.message)
      throw e
    }
  }
  const files: string[] = []
  const write = async (ext: string, data: string | Buffer) => {
    const p = abs(ext)
    if (existsSync(p)) throw httpError(409, `${rel(ext)} already exists`)
    await mkdir(dirname(p), { recursive: true })
    await writeFile(p, data, { flag: "wx" })
    files.push(rel(ext))
  }
  // Check every path before writing anything.
  for (const ext of st.inspection.kind === "mesh" ? ["stl", "scad", "json"] : ["scad", "json"]) abs(ext)
  if (st.inspection.kind === "mesh") {
    await write("stl", binaryStl(st.triangles!, `Crease import ${id}`))
    await write("json", JSON.stringify(info, null, 2) + "\n")
    await write("scad", meshWrapper(id, info))
  } else {
    await write("json", JSON.stringify(info, null, 2) + "\n")
    await write("scad", st.scad!)
  }
  staged.delete(req.token)
  const updated = await addPart(projectId, rel("scad"), { id, imported: info })
  const part = updated.parts.find((p) => p.id === id) as PartRef
  return { part, project: updated, files }
}

/** True when a part is an imported mesh (fixed shape). */
export const isImportedMesh = (p: PartRef | undefined) => p?.imported?.kind === "mesh"
