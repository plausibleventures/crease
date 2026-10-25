// R14 glue: load the assembled scene (exported part STLs + hardware proxy shapes), draw every step with
// illustrate.ts, write renders/assembly-step-<n>.{png,svg} (+ .art.png raster) and build/assembly-art.json.
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Assembly, AssemblyArt, AssemblyHardware, StepArt, Vec3 } from "../../shared/types"
import { parseStl } from "../cad/mesh"
import { ART_VERSION, DEFAULT_VIEW, drawStep, drawThumb, overlaySvg, stepSvg, type StepDrawing } from "./illustrate"
import { encodePng } from "./raster"
import { showFaceYaw, turnZ } from "../../shared/assembly-art"
import { faceDownParts } from "../cad"
import { manifoldWasm } from "./motion"
import { hardwareProxy } from "./proxies"
import { buildScene, type Mesh, type SceneInst, type SceneProblem } from "./scene"

export const ART_JSON = "build/assembly-art.json"

export interface LoadedScene {
  insts: SceneInst[]
  problems: SceneProblem[]
}

/** Parts from build/<id>.stl (already exported), hardware from the check_motion proxy shapes. */
export async function loadScene(root: string, a: Assembly, pose: Record<string, number> = {}): Promise<LoadedScene> {
  const parts = new Map<string, Mesh | null>()
  for (const p of a.parts) {
    const f = join(root, "build", `${p.id}.stl`)
    parts.set(p.id, existsSync(f) ? parseStl(await readFile(f)) : null)
  }
  const hw = new Map<string, Mesh | null>()
  if ((a.hardwarePlacements ?? []).length) {
    const w = await manifoldWasm()
    for (const h of a.hardware) {
      const pr = hardwareProxy(w, h)
      if (!pr.mesh) {
        hw.set(h.id, null)
        continue
      }
      const m = pr.mesh.getMesh()
      hw.set(h.id, { verts: Array.from(m.vertProperties).filter((_, i) => i % m.numProp < 3), tris: m.triVerts })
      pr.mesh.delete()
    }
  }
  return buildScene(a, (id) => parts.get(id) ?? null, (h: AssemblyHardware) => hw.get(h.id) ?? null, pose)
}

/**
 * Whether the guide can be drawn from geometry: every part instance placed and loaded, every drawable hardware
 * item placed. Otherwise the guide keeps using assembly.scad renders (and says why).
 */
export function artProblems(scene: LoadedScene): string[] {
  return scene.problems.map((p) => `${p.key}: ${p.reason}`)
}

export function artHash(a: Assembly, stamp: string): string {
  return createHash("sha256").update(JSON.stringify({ v: ART_VERSION, a, stamp })).digest("hex").slice(0, 16)
}

let sharpMod: Promise<unknown> | null = null
/** Overlay composited onto the raster (librsvg via sharp); the plain raster if sharp isn't usable. */
async function composite(png: Buffer, svg: string): Promise<Buffer> {
  try {
    sharpMod ??= import("sharp").then((m) => (m as { default: unknown }).default ?? m)
    const sharp = (await sharpMod) as (input: Buffer) => { composite: (o: { input: Buffer }[]) => { png: () => { toBuffer: () => Promise<Buffer> } } }
    return await sharp(png).composite([{ input: Buffer.from(svg) }]).png().toBuffer()
  } catch {
    return png
  }
}

export interface StepFiles {
  drawing: StepDrawing
  pngRel: string // composited
  rasterRel: string
  svgRel: string
}

const stepName = (n: number) => (n === 0 ? "assembly-complete" : `assembly-step-${n}`)

/** The finished build drawn for the app's pages (transparent background), next to the guide's paper picture. */
export const STUDIO_HERO = "renders/assembly-complete.studio.png"

/** The guide's starting view: the default iso, turned round to the show faces of face-down pieces. */
function homeView(root: string, a: Assembly): Vec3 {
  return turnZ(DEFAULT_VIEW, showFaceYaw(a, faceDownParts(root, a.parts.map((p) => p.id))))
}

/** Draw one step and write its files. */
export async function writeStepArt(
  root: string,
  a: Assembly,
  scene: SceneInst[],
  n: number,
  opts: { prevDir?: Vec3 | null; explode?: number; suffix?: string } = {},
): Promise<StepFiles> {
  const d = drawStep(a, scene, n, { prevDir: opts.prevDir ?? null, home: homeView(root, a), explode: opts.explode })
  const base = `renders/${stepName(n)}${opts.suffix ?? ""}`
  await mkdir(join(root, "renders"), { recursive: true })
  const rasterRel = `${base}.art.png`
  const pngRel = `${base}.png`
  const svgRel = `${base}.svg`
  await writeFile(join(root, rasterRel), d.png)
  // The finished build for the app's pages (Overview, Library): same view, transparent instead of paper white.
  if (n === 0 && !opts.suffix) await writeFile(join(root, STUDIO_HERO), encodePng(d.raster.rgba, d.width, d.height, 4))
  await writeFile(join(root, pngRel), d.overlay ? await composite(d.png, overlaySvg(d)) : d.png)
  await writeFile(join(root, svgRel), stepSvg(d, `${stepName(n)}${opts.suffix ?? ""}.art.png`))
  return { drawing: d, pngRel, rasterRel, svgRel }
}

/** Every step (0 = finished assembly) drawn in order, each camera biased toward the previous one. */
export async function writeAllArt(root: string, a: Assembly, scene: SceneInst[], hash: string): Promise<{ art: AssemblyArt; files: Map<number, StepFiles> }> {
  const files = new Map<number, StepFiles>()
  const steps: StepArt[] = []
  let prev: Vec3 | null = null
  for (const n of [0, ...a.steps.map((s) => s.n)]) {
    const f = await writeStepArt(root, a, scene, n, { prevDir: n === 0 ? null : prev })
    if (n > 0) prev = f.drawing.art.camera.dir
    files.set(n, f)
    steps.push({ ...f.drawing.art, image: f.pngRel, svg: f.svgRel })
  }
  const art: AssemblyArt = { version: ART_VERSION, hash, steps }
  await mkdir(join(root, "build"), { recursive: true })
  await writeFile(join(root, ART_JSON), JSON.stringify(art))
  return { art, files }
}

export async function readArt(root: string): Promise<AssemblyArt | null> {
  try {
    const art = JSON.parse(await readFile(join(root, ART_JSON), "utf8")) as AssemblyArt
    return art.version === ART_VERSION ? art : null
  } catch {
    return null
  }
}

/** Parts list thumbnail in the assembled orientation (first copy). */
export async function writeThumb(root: string, a: Assembly, inst: SceneInst, size: [number, number]): Promise<string> {
  const rel = `renders/assembly-part-${inst.id}.png`
  await writeFile(join(root, rel), drawThumb(inst, size[0], size[1], homeView(root, a)))
  return rel
}
