// Assembly guides: assembly.json (validated), step renders of assembly.scad, and the IKEA-style HTML guide.
import { createHash } from "node:crypto"
import { existsSync, statSync } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { previewSource } from "../cad/preview"
import { toneOf } from "../../shared/filament-tones"
import type { Assembly, AssemblyInfo, AssemblyStep, MotionCheck } from "../../shared/types"
import { exportPart, renderScadImage, sourceHash } from "../cad/index"
import { getSettings, STUDIO_HOME } from "../config"
import { getProject, httpError, projectDir } from "../projects/store"
import { assemblyStampAt } from "../projects/revision"
import { motionValidityAt, readMotionRecord, writeGuideStamp, writeMotionRecord } from "../projects/validity"
import { buildGuideHtml, type GuideImages } from "./guide"
import { clearBackground, whitenBackground } from "./png"
import { buildShoppingList, shoppingCsv, shoppingMarkdown } from "./shopping"
import { DEFAULT_SOURCING } from "./stores"
import { validateAssembly } from "./schema"
import { SCADLIB, SCADLIB_FILE } from "./scadlib"
import { motionFraction, SCADDATA_FILE, scadData } from "./scaddata"
import { checkMotion } from "./motion"
import { binFile, buildBom, readBin, readHave, setHave, setInBin } from "./bom"
import type { AssemblyArt, PartsBinItem, ProjectBom, StepArt } from "../../shared/types"
import { partLetters } from "../../shared/assembly-art"
import { artHash, artProblems, loadScene, readArt, STUDIO_HERO, writeAllArt, writeStepArt, writeThumb, type LoadedScene } from "./art"
import { drawStep } from "./illustrate"

export { validateAssembly } from "./schema"

export const ASSEMBLY_JSON = "assembly.json"
export const ASSEMBLY_SCAD = "assembly.scad"
export const GUIDE_REL = "build/assembly-guide.html"
export const SHOPPING_MD_REL = "build/shopping-list.md"
export const SHOPPING_CSV_REL = "build/shopping-list.csv"
export const MOTION_CHECK_REL = "build/motion-check.json"
export const DEFAULT_EXPLODE = 1
export const DEFAULT_EXPLODE_DISTANCE = 30
const STEP_SIZE: [number, number] = [1200, 900]
const PART_SIZE: [number, number] = [480, 360]
const MOTION_SIZE: [number, number] = [600, 450]

const artifactUrl = (projectId: string, rel: string, v: string | number) => `/api/projects/${projectId}/artifacts/${rel}?v=${v}`

export async function readAssembly(projectId: string): Promise<{ assembly: Assembly | null; error?: string }> {
  const f = join(projectDir(projectId), ASSEMBLY_JSON)
  if (!existsSync(f)) return { assembly: null }
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(f, "utf8"))
  } catch (e) {
    return { assembly: null, error: `assembly.json is not valid JSON: ${(e as Error).message}` }
  }
  const project = await getProject(projectId)
  const v = validateAssembly(raw, project.parts.map((p) => p.id))
  if (v.errors.length) return { assembly: null, error: v.errors.join("\n") }
  return { assembly: v.assembly }
}

async function loadAssemblyOrThrow(projectId: string): Promise<Assembly> {
  const { assembly, error } = await readAssembly(projectId)
  if (error) throw httpError(400, `assembly.json is invalid:\n${error}`)
  if (!assembly) throw httpError(404, "this project has no assembly.json (write it with update_assembly)")
  return assembly
}

/** Validate and write assembly.json. Throws (400) with every problem if invalid; returns warnings otherwise. */
export async function writeAssembly(projectId: string, input: unknown): Promise<{ assembly: Assembly; warnings: string[] }> {
  const project = await getProject(projectId)
  const v = validateAssembly(input, project.parts.map((p) => p.id))
  if (v.errors.length) throw httpError(400, `assembly.json not written; fix these:\n- ${v.errors.join("\n- ")}`)
  const f = join(projectDir(projectId), ASSEMBLY_JSON)
  await writeFile(f + ".tmp", JSON.stringify(v.assembly, null, 2) + "\n")
  await rename(f + ".tmp", f)
  return { assembly: v.assembly, warnings: v.warnings }
}

async function writeIfChanged(abs: string, content: string) {
  const cur = existsSync(abs) ? await readFile(abs, "utf8") : null
  if (cur === content) return
  await mkdir(join(abs, ".."), { recursive: true })
  await writeFile(abs, content)
}

/** Write lib/studio_assembly.scad and lib/studio_assembly_data.scad (placements + motions) if missing or outdated. */
export async function ensureScadLib(projectId: string, a?: Assembly): Promise<void> {
  const root = projectDir(projectId)
  await writeIfChanged(join(root, SCADLIB_FILE), SCADLIB)
  const data = a ?? (await readAssembly(projectId)).assembly ?? { parts: [], hardware: [], tools: [], consumables: [], steps: [] }
  await writeIfChanged(join(root, SCADDATA_FILE), scadData(data))
}

/** Export fresh STLs of every printed part in the assembly (cached by the CAD module). */
async function prepareParts(projectId: string, a: Assembly): Promise<void> {
  for (const p of a.parts) await exportPart(projectId, p.id, "stl")
}

// ---- render cache: build/assembly.render.json maps output file -> input hash ----
const cachePath = (root: string) => join(root, "build", "assembly.render.json")
async function readCache(root: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(cachePath(root), "utf8"))
  } catch {
    return {}
  }
}
async function writeCacheEntry(root: string, file: string, hash: string) {
  const c = await readCache(root)
  c[file] = hash
  await writeFile(cachePath(root), JSON.stringify(c, null, 2))
}
function stlStamp(root: string, a: Assembly): string {
  return a.parts
    .map((p) => {
      const f = join(root, "build", `${p.id}.stl`)
      return existsSync(f) ? `${p.id}:${statSync(f).size}:${statSync(f).mtimeMs}` : `${p.id}:missing`
    })
    .join("|")
}

async function cachedRender(
  root: string,
  scadAbs: string,
  outRel: string,
  defines: Record<string, string>,
  rotation: [number, number, number] | undefined,
  size: [number, number],
  extra: string,
): Promise<{ cached: boolean; hash: string }> {
  const hash = createHash("sha256")
    .update(await sourceHash(scadAbs, defines as Record<string, string>, root))
    .update(JSON.stringify({ rotation, size, extra, tones: 1 }))
    .digest("hex")
    .slice(0, 16)
  const out = join(root, outRel)
  if ((await readCache(root))[outRel] === hash && existsSync(out)) return { cached: true, hash }
  // drawn from a copy whose colours are filament tones, as in the app (server/cad/preview.ts)
  const shownAbs = join(root, "build", `${basename(outRel, ".png")}.shown.scad`)
  await mkdir(dirname(shownAbs), { recursive: true })
  await writeFile(shownAbs, previewSource(await readFile(scadAbs, "utf8"), dirname(scadAbs)))
  await renderScadImage(shownAbs, out, { defines, rotation, size })
  await writeFile(out, whitenBackground(await readFile(out)))
  await writeCacheEntry(root, outRel, hash)
  return { cached: false, hash }
}

export interface StepRender {
  n: number // 0 = completed assembly
  path: string // absolute
  rel: string
  url: string
  cached: boolean
}

function stepDefines(s: AssemblyStep | null, explode: number): Record<string, string> {
  if (!s) return { step: "999", explode: "0", highlight: "false" }
  const dir = s.explodeDirection ?? [0, 0, 1]
  return {
    step: String(s.n),
    explode: String(explode),
    explode_dir: `[${dir.join(",")}]`,
    explode_dist: String(s.explodeDistance ?? DEFAULT_EXPLODE_DISTANCE),
    highlight: "true",
  }
}

// ---- R14: geometry-based step art (server/assembly/illustrate.ts) ----

export interface ArtSource {
  scene: LoadedScene | null // null: the guide uses assembly.scad renders
  reason: string | null // why not (plain words for the agent)
  hash: string
}

/** Load the placed scene when every part instance and drawable hardware item has a position. */
async function artSource(projectId: string, a: Assembly, pose?: Record<string, number>): Promise<ArtSource> {
  const root = projectDir(projectId)
  await prepareParts(projectId, a)
  const hash = artHash(a, stlStamp(root, a))
  if (!a.placements?.length) return { scene: null, reason: "no placements in assembly.json", hash }
  const scene = await loadScene(root, a, pose)
  const problems = artProblems(scene)
  if (problems.length) return { scene: null, reason: `missing positions: ${problems.slice(0, 6).join("; ")}${problems.length > 6 ? "…" : ""}`, hash }
  return { scene, reason: null, hash }
}

/** The saved step art, if it was drawn from the current assembly.json and part meshes. */
export async function currentArt(projectId: string, a: Assembly | null): Promise<AssemblyArt | null> {
  if (!a) return null
  const root = projectDir(projectId)
  const art = await readArt(root)
  return art && art.hash === artHash(a, stlStamp(root, a)) ? art : null
}

/**
 * Render step n (0 = the finished assembly, all parts in colour) to renders/assembly-step-<n>.png (or
 * renders/assembly-complete.png): drawn from geometry with arrows/callouts when everything is placed
 * (R14), else assembly.scad rendered with OpenSCAD.
 */
export async function renderAssemblyStep(
  projectId: string,
  n: number,
  opts: { explode?: number; pose?: Record<string, number> } = {},
): Promise<StepRender & { art?: StepArt; artNote?: string }> {
  const root = projectDir(projectId)
  const a = await loadAssemblyOrThrow(projectId)
  const s = n === 0 ? null : a.steps.find((x) => x.n === n)
  if (n !== 0 && !s) throw httpError(400, `no step ${n} (steps 1..${a.steps.length}; 0 = finished assembly)`)
  const posed = opts.pose && Object.keys(opts.pose).length > 0
  if (posed) poseDefines(a, opts.pose) // validates motion ids
  const src = await artSource(projectId, a, opts.pose)
  if (src.scene) {
    const saved = await readArt(root)
    const prev = n > 1 ? (saved?.steps.find((x) => x.n === n - 1)?.camera.dir ?? null) : null
    const f = await writeStepArt(root, a, src.scene.insts, n, { prevDir: prev, explode: opts.explode, suffix: posed ? "-posed" : "" })
    const v = Math.round(statSync(join(root, f.pngRel)).mtimeMs)
    return { n, path: join(root, f.pngRel), rel: f.pngRel, url: artifactUrl(projectId, f.pngRel, v), cached: false, art: { ...f.drawing.art, image: f.pngRel, svg: f.svgRel } }
  }
  const scadAbs = join(root, ASSEMBLY_SCAD)
  if (!existsSync(scadAbs))
    throw httpError(404, `assembly.scad is missing and the step can't be drawn from geometry (${src.reason}); see the assembly-guide skill`)
  await ensureScadLib(projectId, a)
  const explode = Math.max(0, Math.min(1, opts.explode ?? DEFAULT_EXPLODE))
  const rel = n === 0 ? `renders/assembly-complete${posed ? "-posed" : ""}.png` : `renders/assembly-step-${n}${posed ? "-posed" : ""}.png`
  const defines = { ...stepDefines(s ?? null, explode), ...poseDefines(a, opts.pose) }
  const r = await cachedRender(root, scadAbs, rel, defines, s?.view, STEP_SIZE, stlStamp(root, a))
  // the finished build for the app's pages (Overview, Library): the paper picture with its white made transparent
  if (n === 0 && !posed && (!r.cached || !existsSync(join(root, STUDIO_HERO))))
    await writeFile(join(root, STUDIO_HERO), clearBackground(await readFile(join(root, rel))))
  return { n, path: join(root, rel), rel, url: artifactUrl(projectId, rel, r.hash), cached: r.cached, ...(src.reason ? { artNote: `assembly.scad render (${src.reason})` } : {}) }
}

/**
 * Pose every motion across its range and report collisions / clearances (see motion.ts); saved to
 * build/motion-check.json as {inputs, check} where `inputs` is the assembly SourceStamp it was checked against
 * (server/projects/revision.ts, R07): stale once a part, a shared lib file, an override or assembly.json changes.
 */
export async function checkAssemblyMotion(projectId: string): Promise<MotionCheck> {
  const a = await loadAssemblyOrThrow(projectId)
  const root = projectDir(projectId)
  await ensureScadLib(projectId, a) // generated lib files are part of the stamp: settle them first
  const inputs = assemblyStampAt(root, (await getProject(projectId)).parts)
  const r = await checkMotion(projectId, a)
  const out: MotionCheck = { ...r, checkedAt: new Date().toISOString() }
  try {
    writeMotionRecord(root, inputs, out)
  } catch {
    /* the result is still returned */
  }
  return out
}

/** The last saved motion check, marked stale (with reasons) if anything it was checked against changed since. */
export async function readMotionCheck(projectId: string, a: Assembly | null): Promise<MotionCheck | null> {
  if (!a) return null
  const root = projectDir(projectId)
  const saved = readMotionRecord(root)
  if (!saved?.check?.status) return null
  const v = motionValidityAt(root, (await getProject(projectId)).parts)
  return { ...saved.check, stale: v.state !== "fresh", ...(v.reasons.length ? { staleReasons: v.reasons } : {}) }
}

/** -D motion_<id>=<0..1> for the given poses (unknown ids are an error). */
function poseDefines(a: Assembly, pose?: Record<string, number>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [id, f] of Object.entries(pose ?? {})) {
    if (!(a.motions ?? []).some((m) => m.id === id)) throw httpError(400, `unknown motion "${id}"`)
    out[`motion_${id}`] = String(Math.max(0, Math.min(1, f)))
  }
  return out
}

export interface MotionFrame {
  value: number // degrees or mm
  label: string // "0°", "55°", "110°"
  path: string
}

/** Render a motion at a few poses (finished assembly in colour, from step `n`'s camera) for the "How it moves" strip. */
export async function renderMotionStrip(projectId: string, motionId: string, n: number, frames = 3): Promise<MotionFrame[]> {
  const root = projectDir(projectId)
  const a = await loadAssemblyOrThrow(projectId)
  const m = (a.motions ?? []).find((x) => x.id === motionId)
  if (!m) throw httpError(400, `unknown motion "${motionId}"`)
  const s = a.steps.find((x) => x.n === n)
  await ensureScadLib(projectId, a)
  await prepareParts(projectId, a)
  const out: MotionFrame[] = []
  for (let k = 0; k < frames; k++) {
    const value = m.range[0] + ((m.range[1] - m.range[0]) * k) / (frames - 1)
    const rel = `renders/assembly-motion-${m.id}-${k}.png`
    const defines = { step: String(n || 999), explode: "0", highlight: "false", [`motion_${m.id}`]: String(motionFraction(m, value)) }
    await cachedRender(root, join(root, ASSEMBLY_SCAD), rel, defines, s?.view, MOTION_SIZE, stlStamp(root, a))
    out.push({ value, label: `${+value.toFixed(1)}${m.type === "rotate" ? "°" : " mm"}`, path: join(root, rel) })
  }
  return out
}

/** Render each printed part alone, in its assembly colour, for the parts list. */
async function renderPartThumb(projectId: string, partId: string, color: string): Promise<string> {
  const root = projectDir(projectId)
  const wrapper = join(root, "build", `assembly-part-${partId}.scad`)
  // Near-white filament would vanish on white paper: draw it light grey (the label keeps the real colour).
  const shown = /^(white|snow|ivory|whitesmoke|natural|#f{3}|#f{6}|#fefefe)$/i.test(color.trim()) ? "#dcdcd6" : (toneOf(color) ?? color)
  await writeFile(wrapper, `// generated by Crease for the assembly guide\ncolor(${JSON.stringify(shown)}) import("${partId}.stl");\n`)
  const rel = `renders/assembly-part-${partId}.png`
  const a = await loadAssemblyOrThrow(projectId)
  await cachedRender(root, wrapper, rel, {}, undefined, PART_SIZE, stlStamp(root, a))
  return join(root, rel)
}

const dataUri = async (abs: string) => `data:image/png;base64,${(await readFile(abs)).toString("base64")}`

/** Render every step + part thumbnails and write the self-contained build/assembly-guide.html. */
export async function buildAssemblyGuide(
  projectId: string,
): Promise<{ url: string; path: string; steps: number; rendered: number; art: "geometry" | "assembly.scad"; artNote?: string }> {
  const root = projectDir(projectId)
  const a = await loadAssemblyOrThrow(projectId)
  const project = await getProject(projectId)
  await ensureScadLib(projectId, a) // generated lib files are part of the stamp: settle them first
  const source = assemblyStampAt(root, project.parts) // what this guide is built from (R07), taken before rendering
  const src = await artSource(projectId, a)
  let images: GuideImages
  let rendered = 0
  if (src.scene) {
    // R14: every step drawn from geometry; the guide inlines each step as SVG (raster + vector overlay).
    const scene = src.scene.insts
    const saved = await readArt(root)
    const reuse = saved?.hash === src.hash && saved.steps.every((s) => existsSync(join(root, s.svg)) && existsSync(join(root, s.svg.replace(/\.svg$/, ".art.png"))))
    const art = reuse ? saved! : (await writeAllArt(root, a, scene, src.hash)).art
    if (!reuse) rendered = art.steps.length
    images = { complete: await dataUri(join(root, art.steps[0].image)), steps: {}, stepSvgs: {}, parts: {}, motions: {}, letters: {} }
    for (const st of art.steps.slice(1)) {
      const raster = await dataUri(join(root, st.svg.replace(/\.svg$/, ".art.png")))
      const svg = await readFile(join(root, st.svg), "utf8")
      images.stepSvgs![st.n] = svg.replace(/href="[^"]*\.art\.png"/, `href="${raster}"`).replace(/^<svg /, `<svg role="img" aria-label="Step ${st.n}" `)
      images.steps[st.n] = await dataUri(join(root, st.image))
    }
    for (const p of a.parts) {
      const inst = scene.find((x) => x.id === p.id)
      if (inst) images.parts[p.id] = await dataUri(join(root, await writeThumb(root, a, inst, PART_SIZE)))
    }
    for (const [key, l] of partLetters(a)) {
      const id = key.split("#")[0]
      images.letters![id] = [...(images.letters![id] ?? []), l]
    }
    for (const s of a.steps) {
      if (!s.showMotion) continue
      const m = (a.motions ?? []).find((x) => x.id === s.showMotion)!
      const cam = art.steps.find((x) => x.n === s.n)?.camera.dir ?? null
      const frames: { label: string; src: string }[] = []
      for (let k = 0; k < 3; k++) {
        const value = m.range[0] + ((m.range[1] - m.range[0]) * k) / 2
        const posed = await loadScene(root, a, { [m.id]: motionFraction(m, value) })
        const d = drawStep(a, posed.insts, 0, { width: MOTION_SIZE[0], height: MOTION_SIZE[1], prevDir: cam, overlays: false })
        const rel = `renders/assembly-motion-${m.id}-${k}.png`
        await writeFile(join(root, rel), d.png)
        frames.push({ label: `${+value.toFixed(1)}${m.type === "rotate" ? "°" : " mm"}`, src: `data:image/png;base64,${d.png.toString("base64")}` })
      }
      images.motions[s.n] = frames
    }
  } else {
    const renders: StepRender[] = []
    for (const n of [0, ...a.steps.map((s) => s.n)]) renders.push(await renderAssemblyStep(projectId, n))
    rendered = renders.filter((r) => !r.cached).length
    images = { complete: await dataUri(renders[0].path), steps: {}, parts: {}, motions: {} }
    for (const r of renders.slice(1)) images.steps[r.n] = await dataUri(r.path)
    for (const p of a.parts) images.parts[p.id] = await dataUri(await renderPartThumb(projectId, p.id, p.color))
    for (const s of a.steps) {
      if (!s.showMotion) continue
      const frames = await renderMotionStrip(projectId, s.showMotion, s.n)
      images.motions[s.n] = await Promise.all(frames.map(async (f) => ({ label: f.label, src: await dataUri(f.path) })))
    }
  }
  const sourcing = getSettings().sourcing ?? DEFAULT_SOURCING
  const html = buildGuideHtml(a, images, { projectName: project.name, sourcing, motionCheck: await readMotionCheck(projectId, a) })
  const abs = join(root, GUIDE_REL)
  await mkdir(join(root, "build"), { recursive: true })
  await writeFile(abs, html)
  const list = buildShoppingList(a, sourcing)
  await writeFile(join(root, SHOPPING_MD_REL), shoppingMarkdown(a.title ?? project.name, list))
  await writeFile(join(root, SHOPPING_CSV_REL), shoppingCsv(list))
  writeGuideStamp(root, source)
  return { url: artifactUrl(projectId, GUIDE_REL, Date.now()), path: abs, steps: a.steps.length, rendered, art: src.scene ? "geometry" : "assembly.scad", ...(src.reason ? { artNote: `step pictures rendered from assembly.scad because ${src.reason}; add placements / hardwarePlacements to draw them from geometry with arrows and labels` } : {}) }
}

export async function getAssemblyInfo(projectId: string): Promise<AssemblyInfo> {
  const root = projectDir(projectId)
  await getProject(projectId) // 404 if missing
  const { assembly, error } = await readAssembly(projectId)
  const guideAbs = join(root, GUIDE_REL)
  const stepImages = (assembly?.steps ?? [])
    .map((s) => ({ n: s.n, rel: `renders/assembly-step-${s.n}.png` }))
    .filter((s) => existsSync(join(root, s.rel)))
    .map((s) => ({ n: s.n, url: artifactUrl(projectId, s.rel, Math.round(statSync(join(root, s.rel)).mtimeMs)) }))
  return {
    assembly,
    ...(error ? { error } : {}),
    hasScad: existsSync(join(root, ASSEMBLY_SCAD)),
    guideUrl: existsSync(guideAbs) ? artifactUrl(projectId, GUIDE_REL, Math.round(statSync(guideAbs).mtimeMs)) : null,
    stepImages,
    partModels: Object.fromEntries(
      (assembly?.parts ?? []).flatMap((p) => {
        const rel = [`build/${p.id}.view.3mf`, `build/${p.id}.3mf`, `build/${p.id}.stl`].find((r) => existsSync(join(root, r)))
        return rel ? [[p.id, artifactUrl(projectId, rel, Math.round(statSync(join(root, rel)).mtimeMs))]] : []
      }),
    ),
    shoppingListUrl: existsSync(join(root, SHOPPING_MD_REL))
      ? artifactUrl(projectId, SHOPPING_MD_REL, Math.round(statSync(join(root, SHOPPING_MD_REL)).mtimeMs))
      : null,
    motionCheck: assembly?.motions?.length ? await readMotionCheck(projectId, assembly) : null,
    art: await currentArt(projectId, assembly),
  }
}

// ---- practical BOM (R17) ----

export const partsBinFile = () => binFile(STUDIO_HOME)

/** The project's bill of materials with "I already have this" ticks (project) and the parts bin applied. */
export async function getProjectBom(projectId: string): Promise<ProjectBom> {
  const project = await getProject(projectId)
  const { assembly } = await readAssembly(projectId)
  return buildBom({
    project,
    assembly,
    sourcing: getSettings().sourcing ?? DEFAULT_SOURCING,
    have: readHave(projectDir(projectId)),
    bin: readBin(partsBinFile()),
  })
}

/** Tick / untick "I already have this" for one item (null = back to the parts bin's answer). */
export async function setProjectHave(projectId: string, key: string, have: boolean | null): Promise<ProjectBom> {
  if (typeof key !== "string" || !key || key.length > 200) throw httpError(400, "key is required")
  if (have !== null && typeof have !== "boolean") throw httpError(400, "have must be true, false or null")
  await getProject(projectId)
  setHave(projectDir(projectId), key, have)
  return getProjectBom(projectId)
}

export function getPartsBin(): PartsBinItem[] {
  return readBin(partsBinFile())
}

export function setPartsBin(key: string, name: string, inBin: boolean): PartsBinItem[] {
  if (typeof key !== "string" || !key || key.length > 200) throw httpError(400, "key is required")
  if (key.startsWith("printed:") || key.startsWith("make:")) throw httpError(400, "printed and make-it-yourself items don't go in the parts bin")
  return setInBin(partsBinFile(), { key, name: String(name ?? key).slice(0, 200) }, !!inBin)
}
