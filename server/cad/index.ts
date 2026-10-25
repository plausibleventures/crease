// OWNER: projects/cad agent. OpenSCAD CLI behind the CadEngine interface + mesh checks.
import { existsSync, readFileSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import type { CheckReport, MeshStats, PartRef, RenderResult, ScadParameter, SourceStamp } from "../../shared/types"
import { paramLinksAt, partOverridesAt, partStampAt, saveOverrides, walkScad } from "../projects/revision"
import { getPrinterProfile } from "../config"
import { colorschemeArg, RENDER_STYLE, type RenderScheme } from "./scheme"
import { displayUrl } from "./display"
import { emit } from "../events"
import { getDefaultMachine, getMachines } from "../machines"
import { getProject, httpError, projectDir, resolveProjectPath } from "../projects/store"
import { assertAppDir } from "../projects/paths"
import { analyzeStl, parseStl, runChecks, worstSeverity } from "./mesh"
import { measureThinWalls } from "./thickness"
import { adviseOrientation, readOrientation, writeOrientation } from "./orient"
import { FRONT_YAW, declaredFront, detectFront, partFace, previewParams, previewSource, showsFaceDown, turnedOverCamera, type FrontDir } from "./preview"
import { paramArgs, parseCustomizer, runOpenscad, OpenScadError } from "./openscad"
import { includedParametersSync } from "./customizer"
import { isSculptFile, partSourceText, readPyOrientation, writePyOrientation } from "./sculpt"
import { buildSculpt, sculptEngineKey, SculptError } from "./blender"

export type ParamValues = Record<string, number | string | boolean>

export interface CadEngine {
  export(scadAbsPath: string, outAbsPath: string, params?: ParamValues): Promise<void>
  renderImages(scadAbsPath: string, outDirAbs: string, params?: ParamValues, opts?: { base?: string; yaw?: number; turnOver?: boolean; face?: string }): Promise<string[]>
  listParameters(scadAbsPath: string): Promise<ScadParameter[]>
}

export const VIEWS = ["iso", "front", "top", "right", "bed"] as const
export type View = (typeof VIEWS)[number]
// --camera=translate_x,y,z,rot_x,y,z,dist. --viewall/--autocenter then override translate + dist,
// so only the rotation matters. rot_x=0 looks straight down; rot_x=90 looks from -Y (front).
const CAMERA_ROT: Record<View, [number, number, number]> = {
  iso: [55, 0, 25],
  front: [90, 0, 0],
  top: [0, 0, 0],
  right: [90, 0, 90],
  bed: [55, 0, 25],
}

/** The OpenSCAD CLI implementation of CadEngine. */
export const openscadEngine: CadEngine & {
  renderView(scadAbsPath: string, pngAbsPath: string, view: View, params?: ParamValues, yaw?: number, turnOver?: boolean, face?: string): Promise<void>
} = {
  async export(scadAbsPath, outAbsPath, params) {
    await mkdir(dirname(outAbsPath), { recursive: true })
    const ext = outAbsPath.split(".").pop()!
    const tmp = outAbsPath.replace(/\.[^.]+$/, `.tmp.${ext}`)
    await rm(tmp, { force: true })
    const args = ["-o", tmp, ...paramArgs(params)]
    if (ext === "stl") args.push("--export-format", "binstl")
    await runOpenscad([...args, scadAbsPath], dirname(scadAbsPath))
    if (!existsSync(tmp)) throw new OpenScadError("OpenSCAD produced no output (is the top-level object empty?)", "")
    await rename(tmp, outAbsPath)
  },
  async renderView(scadAbsPath, pngAbsPath, view, params, yaw = 0, turnOver = false, face?: string) {
    await mkdir(dirname(pngAbsPath), { recursive: true })
    const [rx0, ry0, rz0] = CAMERA_ROT[view]
    // A face-down piece is seen turned over (its show face), except on the plate.
    const [rx, ry, rz] = turnOver ? turnedOverCamera([rx0, ry0, (rz0 + yaw) % 360]) : [rx0, ry0, (rz0 + yaw) % 360]
    await runOpenscad(
      [
        // Full geometry for every view (true mesh + per-color() colours). Preview mode (OpenCSG) paints
        // intersection()/difference() results in the first child's colour, e.g. a whole plate in the
        // colour of a small inlay. The bed plate is opaque so --render shows it cleanly.
        // NB: --render takes an optional value, so it must not be directly followed by the input file.
        "--render",
        "-o",
        pngAbsPath,
        ...paramArgs(params),
        `--camera=0,0,0,${rx},${ry},${rz},200`,
        "--imgsize=800,600",
        "--viewall",
        "--autocenter",
        `--colorscheme=${colorschemeArg("dark", face)}`,
        scadAbsPath,
      ],
      dirname(scadAbsPath),
    )
  },
  async renderImages(scadAbsPath, outDirAbs, params, opts = {}) {
    const base = opts.base ?? scadAbsPath.replace(/^.*\//, "").replace(/\.scad$/, "")
    const views = VIEWS.filter((v) => v !== "bed")
    const out = views.map((v) => join(outDirAbs, `${base}-${v}.png`))
    await Promise.all(views.map((v, i) => this.renderView(scadAbsPath, out[i], v, params, opts.yaw ?? 0, opts.turnOver, opts.face)))
    return out
  },
  async listParameters(scadAbsPath) {
    return parseCustomizer(await readFile(scadAbsPath, "utf8"))
  },
}

/**
 * Render any .scad file to a PNG through the shared OpenSCAD queue (used by assembly guides).
 * `defines` are raw OpenSCAD expressions (e.g. { step: "2", explode_dir: "[0,0,1]" }).
 */
export async function renderScadImage(
  scadAbsPath: string,
  pngAbsPath: string,
  opts: { defines?: Record<string, string>; rotation?: [number, number, number]; size?: [number, number]; scheme?: RenderScheme } = {},
): Promise<void> {
  await mkdir(dirname(pngAbsPath), { recursive: true })
  const [rx, ry, rz] = opts.rotation ?? CAMERA_ROT.iso
  const [w, h] = opts.size ?? [800, 600]
  const defs = Object.entries(opts.defines ?? {}).flatMap(([k, v]) => {
    if (!/^[A-Za-z_$][A-Za-z0-9_]*$/.test(k)) throw new Error(`invalid define name: ${k}`)
    return ["-D", `${k}=${v}`]
  })
  await runOpenscad(
    ["--render", "-o", pngAbsPath, ...defs, `--camera=0,0,0,${rx},${ry},${rz},200`, `--imgsize=${w},${h}`, "--viewall", "--autocenter", `--colorscheme=${colorschemeArg(opts.scheme ?? "light")}`, scadAbsPath],
    dirname(scadAbsPath),
  )
}

// ---------- helpers ----------

async function partRef(projectId: string, partId: string): Promise<PartRef> {
  const p = await getProject(projectId)
  const ref = p.parts.find((pt) => pt.id === partId)
  if (!ref) throw httpError(404, `part not found: ${partId}`)
  // R09: the part file must really be inside the project, and the folders the app writes into must be real folders.
  if (!existsSync(resolveProjectPath(projectId, ref.file))) throw httpError(404, `part file missing: ${ref.file}`)
  for (const d of ["build", "renders", ".studio"]) assertAppDir(projectDir(projectId), d)
  return ref
}

/** Hash of the part file, every file it include<>/use<>s (recursively), and the params (server/projects/revision.ts). */
export async function sourceHash(scadAbs: string, params?: ParamValues, projectRoot?: string): Promise<string> {
  return partStampAt(scadAbs, params, projectRoot).hash
}

/** Files (absolute) a part depends on, for the watcher. */
export async function partDependencies(scadAbs: string, projectRoot: string): Promise<string[]> {
  const out: string[] = []
  walkScad(scadAbs, projectRoot, (abs, src) => void (src && out.push(abs)))
  return out
}

interface RenderMeta {
  hash: string
  files?: SourceStamp["files"] // what the hash covers, per file (R07: says what changed when it goes stale)
  builtAt?: string
  params: ParamValues | null
  stats: MeshStats | null
  images: (View | "back")[] // "back": Blender parts (a figure is seen from all round)
  model?: boolean // build/<part>.view.3mf (colour-preserving mesh for the 3D viewer) was written
  front?: FrontDir // side the preview images treat as the front
  showFaceDown?: boolean // a face-down display piece: previews (not the plate view) show it turned over
  style?: string // RENDER_STYLE the images were made with
  face?: string // the colour geometry without color() was drawn in (partFace)
  engine?: string // Blender parts: sculptEngineKey() of the runner that built it (a newer runner rebuilds)
  notes?: string[] // what the build did on its own (a Blender part simplified, moved onto the bed)
  error?: string
  errorCode?: string // SculptError code ("BLOCKED": a build-pack script not allowed yet)
}

const metaPath = (root: string, partId: string) => join(root, "build", `${partId}.render.json`)

/** Parts whose last render found a face-down display piece (see showsFaceDown). */
export function faceDownParts(root: string, partIds: string[]): string[] {
  return partIds.filter((id) => {
    try {
      return JSON.parse(readFileSync(metaPath(root, id), "utf8")).showFaceDown === true
    } catch {
      return false
    }
  })
}

async function readMeta(root: string, partId: string): Promise<RenderMeta | null> {
  try {
    return JSON.parse(await readFile(metaPath(root, partId), "utf8"))
  } catch {
    return null
  }
}

const artifactUrl = (projectId: string, rel: string, v: string) => displayUrl(projectId, rel, v)

function resultFromMeta(projectId: string, partId: string, meta: RenderMeta, cached: boolean, durationMs: number): RenderResult {
  return {
    partId,
    stlUrl: meta.error ? "" : artifactUrl(projectId, `build/${partId}.stl`, meta.hash),
    ...(meta.model && !meta.error ? { modelUrl: artifactUrl(projectId, `build/${partId}.view.3mf`, meta.hash) } : {}),
    ...(meta.front ? { front: meta.front } : {}),
    ...(meta.showFaceDown && !meta.error ? { showFaceDown: true } : {}),
    images: meta.images.map((view) => ({ view, url: artifactUrl(projectId, `renders/${partId}-${view}.png`, meta.hash) })),
    stats: meta.stats,
    ...(meta.notes?.length && !meta.error ? { notes: meta.notes } : {}),
    cached,
    durationMs,
    ...(meta.error ? { error: meta.error } : {}),
    ...(meta.error && meta.errorCode ? { errorCode: meta.errorCode } : {}),
  }
}

// Serialize work per part so overlapping renders (watcher + agent) never write the same files at once.
const partLocks = new Map<string, Promise<unknown>>()
function withPartLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = partLocks.get(key) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  partLocks.set(key, next)
  next.finally(() => {
    if (partLocks.get(key) === next) partLocks.delete(key)
  }).catch(() => {})
  return next
}

function bedWrapper(partRel: string, stats: MeshStats | null): string {
  const [bx, by] = getPrinterProfile().buildVolumeMm
  // Centre the plate under the part (the slicer auto-centres on the plate).
  const cx = stats ? (stats.bbox.min[0] + stats.bbox.max[0]) / 2 : 0
  const cy = stats ? (stats.bbox.min[1] + stats.bbox.max[1]) / 2 : 0
  const z = stats ? stats.bbox.min[2] : 0
  // Opaque plate (rendered with --render on the dark scheme), matching the 3D viewer (src/lib/stage.ts): a warm stone
  // surface, a faint 10 mm grid (50 mm lines brighter) and a hairline grey frame, just under the part.
  const x0 = cx - bx / 2
  const y0 = cy - by / 2
  const zt = z - 0.7 // plate top
  const lines = (n: number, step: number) => Array.from({ length: Math.floor(n / step) - 1 }, (_, i) => (i + 1) * step)
  const grid = (step: number, rgb: string, w: number, skip?: number) => {
    const keep = (v: number) => !skip || v % skip !== 0
    const strips = [
      ...lines(bx, step).filter(keep).map((v) => `translate([${x0 + v - w / 2}, ${y0}, ${zt}]) cube([${w}, ${by}, 0.05]);`),
      ...lines(by, step).filter(keep).map((v) => `translate([${x0}, ${y0 + v - w / 2}, ${zt}]) cube([${bx}, ${w}, 0.05]);`),
    ]
    return strips.length ? `color("${rgb}") union() {\n  ${strips.join("\n  ")}\n}` : ""
  }
  return `// generated by Crease: part on a ${bx}x${by} build plate
include <${partRel}>
color("#34302d") translate([${x0}, ${y0}, ${z - 1.2}]) cube([${bx}, ${by}, 0.5]);
${grid(10, "#403b37", 0.35, 50)}
${grid(50, "#57524d", 0.5)}
color("#a8a29e") translate([${x0}, ${y0}, ${z - 1.2}]) difference() {
  cube([${bx}, ${by}, 0.6]);
  translate([1.2, 1.2, -1]) cube([${bx - 2.4}, ${by - 2.4}, 3]);
}
`
}

/**
 * The OpenSCAD file that draws a part: its .scad, or for a Blender part (parts/<id>.blend.py) the wrapper around
 * its mesh (built first, or reused from the cache: server/cad/blender.ts).
 */
async function geometryFile(root: string, partId: string, ref: PartRef, params?: ParamValues): Promise<{ scadAbs: string; notes: string[]; sculpt: boolean }> {
  if (!isSculptFile(ref.file)) return { scadAbs: join(root, ref.file), notes: [], sculpt: false }
  const b = await buildSculpt(root, partId, ref.file, params)
  return { scadAbs: b.wrapperAbs, notes: b.notes, sculpt: true }
}

// ---------- public API ----------

/**
 * Export the part's STL to build/<part>.stl and render preview PNGs to renders/. Emits render.started/render.done.
 * `given` (even `{}`) = the part's new Customizer overrides: saved (.studio/params) and used by every later render,
 * check and slice; a change emits jobs.changed (slices made with the old values are now out of date). A shared
 * setting (one every part that has it shares, server/projects/revision.ts) changes for those parts too: they are
 * re-rendered and checked after this one, like a lib file edit. Omitted = render with the saved overrides (watcher,
 * restore, toolbar, agent without params).
 */
export async function renderPart(projectId: string, partId: string, given?: ParamValues): Promise<RenderResult> {
  const ref = await partRef(projectId, partId)
  const root = projectDir(projectId)
  let others: string[] = []
  if (given !== undefined) {
    const saved = saveOverrides(root, partId, given)
    if (saved.changed) emit({ type: "jobs.changed", projectId })
    others = saved.others
  }
  const result = await renderOne(projectId, partId, ref, root)
  if (others.length) void refreshParts(projectId, others)
  return result
}

/** Re-render and check parts whose shared settings changed elsewhere (in the background, one at a time). */
async function refreshParts(projectId: string, partIds: string[]) {
  for (const id of partIds) {
    try {
      const r = await renderPart(projectId, id)
      if (!r.error) await checkPart(projectId, id)
    } catch (e) {
      console.error(`[cad] re-render of ${projectId}/${id} after a shared setting changed:`, e)
    }
  }
}

/** The filament a part without a colour prints in: the first loaded on the project's printer (#rrggbb), if known. */
async function printsIn(projectId: string): Promise<string | null> {
  try {
    const printer = (await getProject(projectId)).printer
    const m = getMachines().find((x) => x.id === printer) ?? getDefaultMachine()
    return m.filaments?.find((f) => f.loaded)?.colorHex ?? null
  } catch {
    return null
  }
}

async function renderOne(projectId: string, partId: string, ref: PartRef, root: string): Promise<RenderResult> {
  const params = partOverridesAt(root, partId) ?? undefined
  return withPartLock(`${projectId}/${partId}`, async () => {
    const t0 = Date.now()
    const stamp = partStampAt(join(root, ref.file), params, root)
    const hash = stamp.hash
    const prev = await readMeta(root, partId)
    // geometry without color() shows in the part's colour, else the filament it prints in, as in the 3D viewer
    const face = partFace(ref.colors?.[0], partId, await printsIn(projectId))
    if (
      prev &&
      prev.hash === hash &&
      !prev.error &&
      prev.model !== undefined && // renders from before colour/front support get redone once
      prev.style === RENDER_STYLE && // ... and after a preview restyle (e.g. dark background)
      prev.face === face && // ... and when the colour it prints in changes
      (!isSculptFile(ref.file) || (prev.engine === sculptEngineKey() && prev.images.includes("back") && existsSync(join(root, "build", `${partId}.blend.scad`)))) &&
      existsSync(join(root, "build", `${partId}.stl`)) &&
      prev.images.every((v) => existsSync(join(root, "renders", `${partId}-${v}.png`)))
    ) {
      const result = resultFromMeta(projectId, partId, prev, true, Date.now() - t0)
      emit({ type: "render.done", projectId, result })
      return result
    }

    emit({ type: "render.started", projectId, partId })
    const stlAbs = join(root, "build", `${partId}.stl`)
    const modelAbs = join(root, "build", `${partId}.view.3mf`)
    let meta: RenderMeta
    try {
      const { scadAbs, notes, sculpt } = await geometryFile(root, partId, ref, params)
      // STL (checks, slicer) + a colour-preserving 3MF for the 3D viewer (OpenSCAD keeps color() per
      // triangle in 3MF). Manifold makes the second export cheap; if it fails the viewer falls back to STL.
      let model = true
      await Promise.all([
        openscadEngine.export(scadAbs, stlAbs, params),
        openscadEngine.export(scadAbs, modelAbs, params).catch(() => {
          model = false
        }),
      ])
      const stlBuf = await readFile(stlAbs)
      const analysis = await analyzeStl(stlBuf)
      const src = await readFile(scadAbs, "utf8")
      const front = declaredFront(src) ?? detectFront(parseStl(stlBuf))
      const yaw = FRONT_YAW[front]
      const faceDown = showsFaceDown(src, analysis.stats.sizeMm)
      const shown = previewParams(params)
      // Preview-only copy of the source (dark colours lifted so they shade instead of going flat black).
      const previewAbs = join(root, "build", `${partId}.preview.scad`)
      await writeFile(previewAbs, previewSource(src, dirname(scadAbs)))
      const wrapperAbs = join(root, "build", `${partId}-bed.scad`)
      await writeFile(wrapperAbs, bedWrapper(relative(dirname(wrapperAbs), previewAbs), analysis.stats))
      const rendersDir = join(root, "renders")
      await Promise.all([
        openscadEngine.renderImages(previewAbs, rendersDir, shown, { base: partId, yaw, turnOver: faceDown, face }),
        openscadEngine.renderView(wrapperAbs, join(rendersDir, `${partId}-bed.png`), "bed", shown, yaw, false, face),
        // a sculpted figure is seen from all round: its back too
        ...(sculpt ? [openscadEngine.renderView(previewAbs, join(rendersDir, `${partId}-back.png`), "front", shown, (yaw + 180) % 360, faceDown, face)] : []),
      ])
      meta = { hash, files: stamp.files, builtAt: new Date().toISOString(), params: params ?? null, stats: analysis.stats, images: sculpt ? [...VIEWS, "back"] : [...VIEWS], model, front, ...(faceDown ? { showFaceDown: true } : {}), style: RENDER_STYLE, face, ...(sculpt ? { engine: sculptEngineKey() } : {}), ...(notes.length ? { notes } : {}) }
    } catch (e) {
      const err = e as OpenScadError
      const code = e instanceof SculptError ? e.code : undefined
      meta = { hash, files: stamp.files, builtAt: new Date().toISOString(), params: params ?? null, stats: null, images: [], error: err.message || String(e), ...(code ? { errorCode: code } : {}) }
    }
    await writeFile(metaPath(root, partId), JSON.stringify(meta, null, 2))
    const result = resultFromMeta(projectId, partId, meta, false, Date.now() - t0)
    emit({ type: "render.done", projectId, result })
    return result
  })
}

/** Run printability checks on build/<part>.stl (exports first if missing/stale). Emits check.done. */
export async function checkPart(projectId: string, partId: string): Promise<CheckReport> {
  const root = projectDir(projectId)
  const ref = await partRef(projectId, partId)
  const stlAbs = await exportPart(projectId, partId, "stl")
  // What this check is of: the sources + overrides the STL was just exported from (R07 freshness).
  const source = partStampAt(join(root, ref.file), partOverridesAt(root, partId) ?? undefined, root)
  const project = await getProject(projectId)
  const profile = getPrinterProfile(project.printer)
  const stlBuf = await readFile(stlAbs)
  const analysis = await analyzeStl(stlBuf)
  // a Blender part: its wrapper (orientation, and the colours of its bodies), written by the render above
  const src = await readFile(isSculptFile(ref.file) ? join(root, "build", `${partId}.blend.scad`) : join(root, ref.file), "utf8")
  // R23: thin walls (from the target machine's nozzle) and how to lay it on the bed.
  const mesh = parseStl(stlBuf)
  const thickness = measureThinWalls(mesh, profile.nozzleMm)
  const orientation = adviseOrientation(mesh, readOrientation(src), analysis.stats.volumeMm3)
  const colors = new Set(
    [...src.matchAll(/\bcolor\s*\(\s*("[^"]*"|\[[^\]]*\])/g)].map((m) => m[1].replace(/\s+/g, "").toLowerCase()),
  )
  const items = runChecks(analysis, {
    buildVolumeMm: profile.buildVolumeMm,
    filamentSlots: profile.filamentSlots,
    declaredBodies: 1,
    colorCount: colors.size,
    nozzleMm: profile.nozzleMm,
    thickness,
    orientation,
  })
  const report: CheckReport = { partId, createdAt: new Date().toISOString(), items, summary: worstSeverity(items), source, orientation }
  const checksDir = join(root, ".studio", "checks")
  await mkdir(checksDir, { recursive: true })
  await writeFile(join(checksDir, `${partId}.json`), JSON.stringify(report, null, 2))
  emit({ type: "check.done", projectId, report })
  return report
}

/** Export STL (or 3mf) to build/ and return the absolute path. Reuses the STL from the last render if still fresh. */
export async function exportPart(projectId: string, partId: string, format: "stl" | "3mf" = "stl"): Promise<string> {
  const ref = await partRef(projectId, partId)
  const root = projectDir(projectId)
  if (format === "stl") {
    const meta = await readMeta(root, partId)
    const params = partOverridesAt(root, partId) ?? undefined
    const hash = await sourceHash(join(root, ref.file), params, root)
    const stlAbs = join(root, "build", `${partId}.stl`)
    if (meta && meta.hash === hash && !meta.error && existsSync(stlAbs) && (!isSculptFile(ref.file) || meta.engine === sculptEngineKey())) return stlAbs
    const r = await renderPart(projectId, partId)
    if (r.error) throw new Error(`render failed: ${r.error}`)
    return stlAbs
  }
  const out = join(root, "build", `${partId}.${format}`)
  const params = partOverridesAt(root, partId) ?? undefined
  await withPartLock(`${projectId}/${partId}`, async () => openscadEngine.export((await geometryFile(root, partId, ref, params)).scadAbs, out, params))
  return out
}

/**
 * The OpenSCAD file that draws a part (its .scad, or a Blender part's wrapper) and its saved Customizer overrides, for
 * exporters outside cad (e.g. per-colour slicing bodies).
 */
export async function partSource(projectId: string, partId: string): Promise<{ scadAbs: string; params: ParamValues | undefined }> {
  const ref = await partRef(projectId, partId)
  const root = projectDir(projectId)
  const params = partOverridesAt(root, partId) ?? undefined
  return { scadAbs: (await geometryFile(root, partId, ref, params)).scadAbs, params }
}

export async function listParameters(projectId: string, partId: string): Promise<ScadParameter[]> {
  const ref = await partRef(projectId, partId)
  const root = projectDir(projectId)
  const abs = join(root, ref.file)
  const own = parseCustomizer(partSourceText(abs))
  const all = [...own, ...(await includedParameters(abs, root, new Set(own.map((p) => p.name))))]
  // shared settings say which parts they change (one value for all of them)
  const links = paramLinksAt(root)
  return all.map((p) => {
    const l = links.byName.get(p.name)
    return l?.shared && l.parts.length > 1 && l.parts.includes(partId) ? { ...p, sharedWith: l.parts } : p
  })
}

/**
 * Customizer parameters of the project files a part include<>s (lib/params.scad …), recursively, tagged with their
 * file (server/cad/customizer.ts).
 */
export async function includedParameters(scadAbs: string, root: string, have: Set<string>): Promise<ScadParameter[]> {
  return includedParametersSync(scadAbs, root, have)
}

/**
 * R23: lay a part on the bed differently by writing the documented transform into its .scad
 * (`print_orientation = [x, y, z];` + `rotate(print_orientation) { … }`, server/cad/orient.ts). Never edits a mesh.
 * The watcher re-renders; returns the new rotation and the file written.
 */
export async function setPartOrientation(projectId: string, partId: string, rotate: [number, number, number]): Promise<{ file: string; rotate: [number, number, number] }> {
  if (!Array.isArray(rotate) || rotate.length !== 3 || !rotate.every((v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 360))
    throw httpError(400, "rotate must be [x, y, z] in degrees")
  const ref = await partRef(projectId, partId)
  const abs = resolveProjectPath(projectId, ref.file)
  const src = await readFile(abs, "utf8")
  const sculpt = isSculptFile(ref.file)
  let next: string
  try {
    // a Blender part: the script gets `print_orientation = [x, y, z]`, which its wrapper applies to the mesh
    next = sculpt ? writePyOrientation(src, rotate) : writeOrientation(src, rotate)
  } catch (e) {
    throw httpError(422, `couldn't set the orientation of ${ref.file}: ${(e as Error).message}`)
  }
  await withPartLock(`${projectId}/${partId}`, () => writeFile(abs, next)) // the watcher re-renders and re-checks
  return { file: ref.file, rotate: sculpt ? readPyOrientation(next) : readOrientation(next) }
}

export { watchProject, unwatchProject } from "./watch"
