// OWNER: slicer/printer agent. OrcaSlicer CLI.
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rename, rm, open, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative } from "node:path"
import type { ColorPlan, ColorPlanOption, ColorPlanStrategy, Machine, PlacedObject, PlateGcode, PlateObject, PlateSliceResult, PrintIntent, SlicePreviewSummary, SliceResult, SlotUsage } from "../../shared/types"
import { emit } from "../events"
import { exportPart, partSource } from "../cad"
import { paramArgs, runOpenscad } from "../cad/openscad"
import { getMachine, requireMachine } from "../machines"
import { mapColorsToSlots, userError, type ColorMatch } from "./colors"
import { ensureProfileDir } from "./profiles"
import { intentHeader, objectParams, writeProcessFile } from "./intents"
import { parseGcodeFile } from "../gcode/parse"
import { analyzeGcode } from "../gcode/analyze"
import { cachedStatus, idleMachines } from "../printer/index"
import { baseMaterial, crealityFilamentId } from "../printer/cfs"
import { getProject, httpError, projectDir } from "../projects/store"
import { mapPlateObjects, parseExcludeObjects, partOfObjectName, placeObjects, stlMesh, type ExcludeObjectDef } from "./placement"
import { createJob, latestSliceInputs, projectMachine, recordPartJob, recordPlateSet, setProjectIntent, sourceRevision } from "../jobs"
import { orcaSlicerBin } from "../tools/index"
import { clearSliceError, recordSliceError } from "./last-error"

export { BUNDLED_PROFILES_DIR as PROFILES_DIR } from "./profiles"

export interface GcodeEstimates {
  estimatedTimeS: number | null
  filamentG: number | null
  filamentMm: number | null
}

/** Parse "1d 2h 3m 4s" style durations (OrcaSlicer / PrusaSlicer) into seconds. */
export function parseDuration(s: string): number | null {
  let total = 0
  let matched = false
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/g)) {
    matched = true
    total += Number(m[1]) * { d: 86400, h: 3600, m: 60, s: 1 }[m[2] as "d" | "h" | "m" | "s"]
  }
  return matched ? Math.round(total) : null
}

/** Parse estimates from G-code comments (OrcaSlicer footer; also understands Cura/Creality Print/Prusa styles). */
export function parseGcodeEstimates(text: string): GcodeEstimates {
  const num = (re: RegExp) => {
    const m = text.match(re)
    if (!m) return null
    // multi-filament files list comma-separated values; sum them
    const v = m[1].split(",").reduce((a, x) => a + (Number(x.trim()) || 0), 0)
    return Number.isFinite(v) && v > 0 ? v : null
  }
  let estimatedTimeS: number | null = null
  const t = text.match(/;\s*estimated printing time(?: \(normal mode\))?\s*=\s*(.+)/i)
  if (t) estimatedTimeS = parseDuration(t[1])
  if (estimatedTimeS == null) {
    const cura = text.match(/;\s*(?:TIME|PRINT\.TIME|estimated_time\(s\)|print_time)\s*[:=]\s*(\d+(?:\.\d+)?)/i)
    if (cura) estimatedTimeS = Math.round(Number(cura[1]))
  }
  const filamentG = num(/;\s*(?:total )?filament used \[g\]\s*=\s*([\d.,\s]+)/i)
  let filamentMm = num(/;\s*filament used \[mm\]\s*=\s*([\d.,\s]+)/i)
  if (filamentMm == null) {
    const m = num(/;\s*Filament used:\s*([\d.]+)m/i) // Cura: metres
    filamentMm = m == null ? null : m * 1000
  }
  return {
    estimatedTimeS,
    filamentG: filamentG == null ? null : Math.round(filamentG * 100) / 100,
    filamentMm: filamentMm == null ? null : Math.round(filamentMm * 10) / 10,
  }
}

/** Read the head and tail of a (possibly large) G-code file and parse estimates. */
export async function readGcodeEstimates(gcodeAbs: string): Promise<GcodeEstimates> {
  const fh = await open(gcodeAbs, "r")
  try {
    const { size } = await fh.stat()
    const chunk = 64 * 1024
    const head = Buffer.alloc(Math.min(chunk, size))
    await fh.read(head, 0, head.length, 0)
    // OrcaSlicer writes estimates just before its ~40 KB config dump at the end of the file.
    const tailLen = Math.min(256 * 1024, size)
    const tail = Buffer.alloc(tailLen)
    await fh.read(tail, 0, tailLen, size - tailLen)
    return parseGcodeEstimates(head.toString("utf8") + "\n" + tail.toString("utf8"))
  } finally {
    await fh.close()
  }
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    const onData = (d: Buffer) => {
      out += d.toString()
      if (out.length > 200_000) out = out.slice(-100_000)
    }
    p.stdout.on("data", onData)
    p.stderr.on("data", onData)
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs)
    p.on("error", (e) => {
      clearTimeout(timer)
      reject(e)
    })
    p.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    })
  })
}


// ---------------------------------------------------------------------------------------------
// OrcaSlicer runs
// ---------------------------------------------------------------------------------------------

function profileDir(machine: Machine): string {
  return ensureProfileDir(machine).dir
}

function filamentTemplate(dir: string, material: string): string {
  // "PETG" or a product name like "Hyper PETG"; "PLA-CF" falls back to the plain base type's profile
  const base = baseMaterial(material) ?? material.toUpperCase()
  for (const m of [base, base.replace(/-.*$/, "")]) {
    const f = join(dir, `filament-${m}.json`)
    if (existsSync(f)) return f
  }
  return join(dir, "filament-PLA.json")
}

async function orca(args: string[], tmpDir: string): Promise<string[]> {
  const orcaSlicerPath = orcaSlicerBin()
  const log = join(tmpDir, "orca.log")
  const { code, out } = await run(orcaSlicerPath, ["--debug", "1", "--logfile", log, ...args, "--outputdir", tmpDir], 10 * 60_000)
  const plateNo = (f: string) => Number(f.match(/(\d+)\.gcode$/)?.[1] ?? 0)
  const produced = (await readdir(tmpDir)).filter((f) => f.endsWith(".gcode")).sort((x, y) => plateNo(x) - plateNo(y))
  if (code !== 0 || produced.length === 0) {
    // stdout only says "run found error, exit"; the reason is in the log.
    let detail = ""
    try {
      detail = (await readFile(log, "utf8")).trim().split("\n").slice(-6).join("\n")
    } catch {
      /* no log */
    }
    throw new OrcaError(`OrcaSlicer failed (exit ${code}): ${detail || out.trim().split("\n").slice(-6).join("\n") || "no output"}`, detail)
  }
  return produced.map((f) => join(tmpDir, f))
}

class OrcaError extends Error {
  constructor(
    message: string,
    public log: string,
  ) {
    super(message)
  }
}

/**
 * Single-filament run on one or more STLs (arranged on the bed, not re-oriented: orientation is a design
 * decision). OrcaSlicer spills onto extra plates itself. Returns G-code files in plate order inside `tmpDir`.
 */
async function runOrca(machine: Machine, stls: string[], tmpDir: string, extraArgs: string[] = [], processFile?: string): Promise<string[]> {
  const dir = profileDir(machine)
  // Single filament = T0 = slot 1; describe slot 1's real spool so the printer picks it.
  const filament = await slotFilamentFile(machine, dir, tmpDir, 1)
  const machineFile = await machineFileFor(machine, dir, tmpDir, 1)
  return orca(
    [
      "--slice", "0",
      "--arrange", "1",
      "--orient", "0",
      "--ensure-on-bed",
      ...extraArgs,
      "--load-settings", `${machineFile};${processFile ?? join(dir, "process.json")}`,
      "--load-filaments", filament,
      ...stls,
    ],
    tmpDir,
  )
}

/** Slice one STL into `outGcodeAbs` (part centred on the bed, default machine, slot-1 filament). */
export async function sliceStl(stlAbs: string, outGcodeAbs: string, machineId?: string): Promise<GcodeEstimates> {
  await mkdir(dirname(outGcodeAbs), { recursive: true })
  // OrcaSlicer always names its output plate_<n>.gcode, so slice into a temp dir and move it.
  const tmp = await mkdtemp(join(dirname(outGcodeAbs), ".slice-"))
  try {
    const [first] = await runOrca(getMachine(machineId), [stlAbs], tmp)
    await rename(first, outGcodeAbs)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
  return readGcodeEstimates(outGcodeAbs)
}

// ---------------------------------------------------------------------------------------------
// Colours -> per-colour bodies
// ---------------------------------------------------------------------------------------------

/**
 * Wrapper that shadows OpenSCAD's color() so the part can be evaluated per colour:
 * - $ps_idx undefined: echo every colour value (discovery pass), keep geometry.
 * - $ps_idx = i >= 0: keep only children of color(<colours[i]>).
 * - $ps_idx = -1: keep only geometry outside any color() (must be empty for a multicolour part).
 * Nested color() calls are not split (outer colour wins); the multicolour skill asks for flat colour regions.
 */
function colorWrapper(includePath: string, colors: string[]): string {
  return `// generated by Crease (per-colour export)
_ps_colors = [${colors.join(", ")}];
module color(c, alpha = 1.0) {
  if (is_undef($ps_idx)) { echo(PS_COLOR = c); children(); }
  else if ($ps_idx >= 0 && c == _ps_colors[$ps_idx]) children();
}
include <${includePath}>
`
}

interface PartBodies {
  partId: string
  fullStl: string
  colors: ColorMatch[] // empty = uncoloured part
  bodies: { stlAbs: string; slot: number | null; label: string | null }[]
}

async function partBodies(projectId: string, partId: string, machine: Machine, multicolorJob: { value: boolean }): Promise<PartBodies> {
  const fullStl = await exportPart(projectId, partId, "stl")
  const { scadAbs, params } = await partSource(projectId, partId)
  const buildDir = join(projectDir(projectId), "build")
  const wrapper = join(buildDir, `${partId}.colors.scad`)
  const rel = relative(buildDir, scadAbs).split("\\").join("/")
  await writeFile(wrapper, colorWrapper(rel, []))
  const echo = join(buildDir, `${partId}.colors.echo`)
  await runOpenscad(["-o", echo, ...paramArgs(params), wrapper], buildDir)
  const seen = new Set<string>()
  for (const m of (await readFile(echo, "utf8")).matchAll(/ECHO: PS_COLOR = (.+)$/gm)) seen.add(m[1].trim())
  await rm(echo, { force: true })
  const values = [...seen].filter((v) => v !== "undef")
  if (values.length <= 1) {
    // Single-colour (or uncoloured) parts print as before; in a multicolour job a single colour still picks its slot.
    // A source without color() prints in the colour the part declares (project.json `colors`, e.g. a template's
    // "black"): otherwise it would silently print with slot 1 (U1: a Black stand sliced as White).
    const declared = values.length ? [] : ((await getProject(projectId)).parts.find((p) => p.id === partId)?.colors ?? []).slice(0, 1)
    const wanted = values.length ? values : declared.map((c) => JSON.stringify(c))
    let colors: ColorMatch[] = []
    if (wanted.length === 1) {
      try {
        colors = mapColorsToSlots(wanted, machine.filaments, machine.filamentSlots)
      } catch {
        colors = []
      }
    }
    return { partId, fullStl, colors, bodies: [{ stlAbs: fullStl, slot: colors[0]?.slot ?? null, label: colors[0]?.label ?? null }] }
  }
  multicolorJob.value = true
  const colors = mapColorsToSlots(values, machine.filaments, machine.filamentSlots)
  await writeFile(wrapper, colorWrapper(rel, values))
  // Geometry outside every color() would be dropped (or duplicated), so refuse with an actionable message.
  const rest = join(buildDir, `${partId}.uncoloured.stl`)
  await rm(rest, { force: true })
  let hasUncoloured = false
  try {
    await runOpenscad(["-o", rest, "--export-format", "binstl", "-D", "$ps_idx=-1", ...paramArgs(params), wrapper], buildDir)
    hasUncoloured = existsSync(rest)
  } catch (e) {
    // Exit 1 with "Current top level object is empty." is the good case: nothing outside color().
    const err = e as Error & { stderr?: string }
    if (!/top level object is empty/i.test(`${err.stderr ?? ""}\n${err.message}`)) throw e
  } finally {
    await rm(rest, { force: true })
  }
  if (hasUncoloured) {
    throw userError(
      `Part "${partId}" uses ${values.length} colours but some geometry is outside every color(). ` +
        `Wrap each body in exactly one color() (one colour per filament slot) so every body has a filament.`,
    )
  }
  const bodies: PartBodies["bodies"] = []
  for (let i = 0; i < values.length; i++) {
    const stl = join(buildDir, `${partId}.color${i + 1}.stl`)
    await runOpenscad(["-o", stl, "--export-format", "binstl", "-D", `$ps_idx=${i}`, ...paramArgs(params), wrapper], buildDir)
    if (!existsSync(stl)) throw new Error(`Part "${partId}": colour ${colors[i].label} produced no geometry`)
    bodies.push({ stlAbs: stl, slot: colors[i].slot, label: colors[i].label })
  }
  return { partId, fullStl, colors, bodies }
}

// ---------------------------------------------------------------------------------------------
// Multicolour run (assemble list: one object per part instance, one volume per colour body)
// ---------------------------------------------------------------------------------------------

interface Instance {
  key: number // assemble_index (1-based, unique per job)
  part: PartBodies
  params?: Record<string, string> // per-object process settings (OrcaSlicer "per-object settings")
}

/**
 * Filament profile for one slot, describing what's actually loaded there. Creality firmware maps each G-code
 * filament to a CFS slot by the footer metadata (filament_colour / filament_ids / filament_type), so these must
 * match the printer's slot or it may pull a different spool (seen on the i7: our default orange #F2754E → slot D red).
 */
/** Per-filament ironing overrides (OrcaSlicer 2.4+); see slotFilamentFile. */
export const FILAMENT_IRONING_KEYS = ["filament_ironing_flow", "filament_ironing_spacing", "filament_ironing_inset", "filament_ironing_speed"] as const

async function slotFilamentFile(machine: Machine, dir: string, tmp: string, slot: number): Promise<string> {
  const f = machine.filaments.find((x) => x.slot === slot)
  const tpl = JSON.parse(await readFile(filamentTemplate(dir, f?.material ?? "PLA"), "utf8"))
  const hex = (f?.colorHex ?? "#f5f5f5").toUpperCase()
  tpl.filament_colour = [hex]
  tpl.default_filament_colour = hex
  // Creality filament id = the CFS material code without its leading digit ("001001" → "01001" = Hyper PLA); for a
  // slot typed in by hand, the id Creality uses for that material (server/printer/cfs.ts; only PLA confirmed).
  const code = crealityFilamentId(f)
  if (code) tpl.filament_id = code
  // OrcaSlicer 2.4.2 reads these per filament, for the filament that irons. A profile without them gets nil (use the
  // process value) for filament 1 only: filament 2+ get padded values that silently turn ironing off, so a part
  // printed from slot 2+ (e.g. a black part, black in slot 2) came out un-ironed with ironing_type = top.
  // Explicit nil = "use the process / intent setting" for every slot.
  for (const k of FILAMENT_IRONING_KEYS) if (tpl[k] === undefined) tpl[k] = ["nil"]
  const out = join(tmp, `slot${slot}.json`)
  await writeFile(out, JSON.stringify(tpl))
  return out
}

/** Filament profiles for slots 1..upTo (G-code tool T<n> = slot n+1, so earlier slots are listed too). */
async function writeSlotFilaments(machine: Machine, dir: string, tmp: string, upTo: number): Promise<string[]> {
  const files: string[] = []
  for (let slot = 1; slot <= Math.max(1, upTo); slot++) files.push(await slotFilamentFile(machine, dir, tmp, slot))
  return files
}

/** machine.json copy whose extruder colour is the colour of the slot printed first (matches Creality Print output). */
async function machineFileFor(machine: Machine, dir: string, tmp: string, firstSlot: number): Promise<string> {
  const j = JSON.parse(await readFile(join(dir, "machine.json"), "utf8"))
  const hex = machine.filaments.find((x) => x.slot === firstSlot)?.colorHex
  if (hex) j.extruder_colour = hex.toUpperCase()
  const out = join(tmp, "machine.json")
  await writeFile(out, JSON.stringify(j))
  return out
}

/**
 * Slice instances with per-volume filaments. Assemble lists can't spill onto extra plates (arrange just
 * fails), so start with everything on plate 1 and move the object OrcaSlicer couldn't place onto the next
 * plate until it fits. Rewrites object names (assemble_K) back to "<part>.stl_id_.." in the G-code.
 */
async function runOrcaMulticolor(
  machine: Machine,
  instances: Instance[],
  tmpBase: string,
  processFile?: string,
  groups?: Instance[][], // start with these plates (one per colour); spill-over gets a plate of its own right after
): Promise<{ files: string[]; keys: Record<string, number>[] }> {
  const dir = profileDir(machine)
  const plates: Instance[][] = groups?.length ? groups.map((g) => g.slice()) : [instances.slice()]
  for (let attempt = 0; attempt <= instances.length; attempt++) {
    const tmp = await mkdtemp(join(tmpBase, ".mc-"))
    const used = instances.flatMap((i) => i.part.bodies.map((b) => b.slot ?? 1))
    const filaments = await writeSlotFilaments(machine, dir, tmp, Math.max(...used))
    const machineFile = await machineFileFor(machine, dir, tmp, Math.min(...used))
    const list = {
      plates: plates.map((pl, i) => ({
        plate_name: `plate${i + 1}`,
        need_arrange: true,
        objects: pl.flatMap((inst) =>
          // print_params = OrcaSlicer per-object settings (same as the GUI's object settings). Set on every body:
          // the merged object takes the first body's config.
          inst.part.bodies.map((b) => ({
            path: b.stlAbs,
            count: 1,
            filaments: [b.slot ?? 1],
            assemble_index: [inst.key],
            ...(inst.params && Object.keys(inst.params).length ? { print_params: inst.params } : {}),
          })),
        ),
      })),
    }
    const listFile = join(tmp, "assemble.json")
    await writeFile(listFile, JSON.stringify(list, null, 1))
    try {
      // --load-assemble-list can't be combined with input files or transforms (--arrange/--orient/...).
      const produced = await orca(
        [
          "--slice", "0",
          "--load-settings", `${machineFile};${processFile ?? join(dir, "process.json")}`,
          "--load-filaments", filaments.join(";"),
          "--load-assemble-list", listFile,
        ],
        tmp,
      )
      const names = new Map(instances.map((i) => [i.key, i.part.partId]))
      // Remember which instance (assemble_index) each renamed object is: per-part settings make copies differ (R13).
      const keys: Record<string, number>[] = []
      for (const g of produced) {
        const text = await readFile(g, "utf8")
        const map: Record<string, number> = {}
        for (const m of text.matchAll(/^EXCLUDE_OBJECT_DEFINE NAME=assemble_(\d+)_id_(\S+)/gm)) {
          const k = Number(m[1])
          if (names.has(k)) map[`${names.get(k)}.stl_id_${m[2]}`] = k
        }
        keys.push(map)
        await writeFile(g, text.replace(/\bassemble_(\d+)_id_/g, (m, k) => (names.has(Number(k)) ? `${names.get(Number(k))}.stl_id_` : m)))
      }
      return { files: produced, keys }
    } catch (e) {
      const m = e instanceof OrcaError ? e.log.match(/arrange failed: ap\.name assemble_(\d+)/) : null
      const key = m ? Number(m[1]) : NaN
      const from = plates.findIndex((pl) => pl.some((i) => i.key === key))
      if (from < 0 || plates[from].length === 1) throw e
      const inst = plates[from].find((i) => i.key === key)!
      plates[from] = plates[from].filter((i) => i !== inst)
      // Colour groups: never mix a spilled object into the next colour's plate.
      const slotOf = (i: Instance) => i.part.bodies[0]?.slot ?? 1
      if (groups?.length && plates[from + 1] && !plates[from + 1].every((i) => slotOf(i) === slotOf(inst))) plates.splice(from + 1, 0, [])
      if (!plates[from + 1]) plates.push([])
      plates[from + 1].push(inst)
    }
  }
  throw new Error("could not arrange the parts onto plates")
}

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

/** Per-slot grams/mm + colour changes from the G-code footer (multicolour jobs). */
export function parseSlotUsage(text: string, machine: Machine, colors: ColorMatch[]): { filamentBySlot: SlotUsage[]; colorChanges: number | null } {
  const list = (re: RegExp) => text.match(re)?.[1].split(",").map((x) => Number(x.trim())) ?? []
  const grams = list(/;\s*filament used \[g\]\s*=\s*([\d.,\s]+)/)
  const mm = list(/;\s*filament used \[mm\]\s*=\s*([\d.,\s]+)/)
  const changes = text.match(/;\s*total filament change\s*=\s*(\d+)/)
  const filamentBySlot: SlotUsage[] = []
  for (let i = 0; i < Math.max(grams.length, mm.length); i++) {
    if (!(grams[i] > 0) && !(mm[i] > 0)) continue
    const slot = i + 1
    const f = machine.filaments.find((x) => x.slot === slot)
    filamentBySlot.push({
      slot,
      colorName: f?.colorName ?? `Slot ${slot}`,
      colorHex: f?.colorHex ?? "#888888",
      grams: Number.isFinite(grams[i]) ? Math.round(grams[i] * 100) / 100 : null,
      mm: Number.isFinite(mm[i]) ? Math.round(mm[i] * 10) / 10 : null,
      modelColors: [...new Set(colors.filter((c) => c.slot === slot).map((c) => c.label))],
    })
  }
  return { filamentBySlot, colorChanges: changes ? Number(changes[1]) : null }
}

async function readHeadTail(abs: string): Promise<string> {
  const fh = await open(abs, "r")
  try {
    const { size } = await fh.stat()
    const head = Buffer.alloc(Math.min(64 * 1024, size))
    await fh.read(head, 0, head.length, 0)
    const tailLen = Math.min(256 * 1024, size)
    const tail = Buffer.alloc(tailLen)
    await fh.read(tail, 0, tailLen, size - tailLen)
    return head.toString("utf8") + "\n" + tail.toString("utf8")
  } finally {
    await fh.close()
  }
}

/** Objects OrcaSlicer placed on a plate, from `EXCLUDE_OBJECT_DEFINE NAME=<part>.stl_id_0_copy_0 CENTER=x,y`. */
export function parsePlateObjects(gcodeHead: string): PlateObject[] {
  return parseExcludeObjects(gcodeHead).map((d) => ({ partId: partOfObjectName(d.name), center: d.center }))
}

/** The API shape of a placed object (PlateGcode.objects): no polygon/transform (those are in the job's placement). */
const plateObjectOf = (o: PlacedObject): PlateObject => ({ partId: o.partId, center: o.center, name: o.name, entry: o.entry, instance: o.instance, label: o.label })

const sum = (xs: (number | null)[]) => (xs.some((x) => x == null) ? null : Math.round(xs.reduce<number>((a, x) => a + (x ?? 0), 0) * 100) / 100)

function sumSlots(plates: { filamentBySlot?: SlotUsage[] }[]): SlotUsage[] {
  const by = new Map<number, SlotUsage>()
  for (const p of plates) {
    for (const u of p.filamentBySlot ?? []) {
      const cur = by.get(u.slot)
      if (!cur) by.set(u.slot, { ...u, modelColors: [...u.modelColors] })
      else {
        cur.grams = cur.grams == null || u.grams == null ? null : Math.round((cur.grams + u.grams) * 100) / 100
        cur.mm = cur.mm == null || u.mm == null ? null : Math.round((cur.mm + u.mm) * 10) / 10
        cur.modelColors = [...new Set([...cur.modelColors, ...u.modelColors])]
      }
    }
  }
  return [...by.values()].sort((a, b) => a.slot - b.slot)
}

/** What the Display intent changed for a curved outline, in one sentence. */
function concentricNote(auto: Record<string, string>): string {
  const top = auto.top_surface_pattern === "concentric"
  const bottom = auto.bottom_surface_pattern === "concentric"
  const where = top && bottom ? "the top surface, ironing and the first layer use" : top ? "the top surface and ironing use" : "the first layer uses"
  return `Display: the outline is curved, so ${where} concentric lines that follow the edge (straight lines would leave a rough band inside it).`
}

type WantedPart = { partId: string; qty: number; overrides?: Record<string, string | number | boolean> }

export interface SliceOptions {
  intent?: PrintIntent
  overrides?: Record<string, string | number | boolean>
  /**
   * Slice the same thing as the latest slice (toolbar Slice / Send on an out-of-date job): its plate composition,
   * per-part overrides and process overrides are reused; `intent`/`overrides` given here still win.
   */
  reuseLatest?: boolean
}

/** Quality check of a fresh slice (never fails the slice). */
function previewOf(abs: string, rel: string, intent: PrintIntent): SlicePreviewSummary | undefined {
  try {
    return analyzeGcode(parseGcodeFile(abs), rel, intent)
  } catch (e) {
    console.error("[slicer] preview failed", e)
    return undefined
  }
}

interface JobOutput {
  preview?: SlicePreviewSummary
  gcodeAbs: string
  est: GcodeEstimates
  objects: PlacedObject[]
  filamentBySlot?: SlotUsage[]
  colorChanges?: number | null
}

/** Internal knobs for the colour plan (slicePlate). */
interface JobTweaks {
  parts?: Map<string, PartBodies> // parts already exported + colour-split (shared between candidate slices)
  tallestLast?: boolean // print by object: list objects shortest first (OrcaSlicer prints in list order; only the last may be taller than the gantry clearance)
  plateBySlot?: boolean // one plate per filament slot
}

/** Export + colour-split the wanted parts once (cached in `into`). multicolor = some part has 2+ colours. */
async function loadParts(
  projectId: string,
  wanted: WantedPart[],
  machine: Machine,
  into = new Map<string, PartBodies>(),
): Promise<{ parts: Map<string, PartBodies>; multicolor: boolean }> {
  const multicolor = { value: false }
  for (const w of wanted) if (!into.has(w.partId)) into.set(w.partId, await partBodies(projectId, w.partId, machine, multicolor))
  return { parts: into, multicolor: wanted.some((w) => (into.get(w.partId)?.bodies.length ?? 0) > 1) }
}

/** Height of a part's mesh (mm). */
function partHeight(p: PartBodies): number {
  const m = stlMesh(p.fullStl)
  return m.maxZ - m.minZ
}

/**
 * Slice part instances into `outNames(plateCount)` inside build/. Single-filament jobs (no part with 2+
 * colours) use the plain multi-STL path; multicolour jobs map color() bodies to CFS slots.
 */
async function sliceJobOnce(
  projectId: string,
  wanted: WantedPart[],
  machine: Machine,
  outNames: (plateCount: number) => string[],
  opts: SliceOptions = {},
  tweaks: JobTweaks = {},
): Promise<JobOutput[]> {
  const intent = opts.intent ?? "standard"
  const overrides = opts.overrides ?? {}
  const buildDir = join(projectDir(projectId), "build")
  await mkdir(buildDir, { recursive: true })
  const loaded = await loadParts(projectId, wanted, machine, tweaks.parts)
  const parts = loaded.parts
  const multicolor = { value: loaded.multicolor }
  const allColors = [...parts.values()].flatMap((p) => p.colors)

  const tmp = await mkdtemp(join(buildDir, ".slice-"))
  try {
    const processFile = await writeProcessFile(profileDir(machine), tmp, intent, overrides)
    let produced: string[]
    let keys: Record<string, number>[] | undefined
    // A single-colour job whose colour sits in another slot (e.g. a red part, red in slot 4) must select that
    // slot too: per-object filaments need the assemble-list path.
    const otherSlot = machine.filamentSlots > 1 && [...parts.values()].some((p) => p.bodies.some((b) => (b.slot ?? 1) !== 1))
    // Per-part settings need per-object params, i.e. the assemble-list path too.
    const perPart = wanted.some((w) => w.overrides && Object.keys(w.overrides).length)
    if (!multicolor.value && !otherSlot && !perPart) {
      const stls = wanted.flatMap((w) => Array.from({ length: w.qty }, () => parts.get(w.partId)!.fullStl))
      produced = await runOrca(machine, stls, tmp, stls.length > 1 ? ["--allow-rotations"] : [], processFile)
    } else {
      let key = 0
      const params = await Promise.all(wanted.map((w) => (w.overrides ? objectParams(profileDir(machine), w.overrides) : Promise.resolve(undefined))))
      let instances: Instance[] = wanted.flatMap((w, wi) => Array.from({ length: w.qty }, () => ({ key: ++key, part: parts.get(w.partId)!, params: params[wi] })))
      // Keys stay with their instance, so reordering never changes the letters shown on the plate.
      if (tweaks.tallestLast) {
        const h = new Map([...parts.values()].map((p) => [p.partId, partHeight(p)]))
        instances = instances.slice().sort((a, b) => h.get(a.part.partId)! - h.get(b.part.partId)! || a.key - b.key)
      }
      const slotOf = (i: Instance) => i.part.bodies[0]?.slot ?? 1
      const groups = tweaks.plateBySlot
        ? [...new Set(instances.map(slotOf))].sort((a, b) => a - b).map((s) => instances.filter((i) => slotOf(i) === s))
        : undefined
      ;({ files: produced, keys } = await runOrcaMulticolor(machine, instances, tmp, processFile, groups))
    }
    const names = outNames(produced.length)
    const out: JobOutput[] = []
    const defs: ExcludeObjectDef[][] = []
    for (let i = 0; i < produced.length; i++) {
      const abs = join(buildDir, names[i])
      // Record how it was made as header comments (read back by the slice preview / print log). Inserted after
      // OrcaSlicer's header block, not before it: firmware/Moonraker read the first lines (multicolor_method, slicer).
      const g = await readFile(produced[i], "utf8")
      const at = g.indexOf("; HEADER_BLOCK_END")
      const cut = at >= 0 ? g.indexOf("\n", at) + 1 : 0
      await writeFile(abs, g.slice(0, cut) + intentHeader(intent, overrides) + g.slice(cut))
      await rm(produced[i], { force: true })
      const text = await readHeadTail(abs)
      defs.push(parseExcludeObjects(text))
      out.push({
        gcodeAbs: abs,
        est: parseGcodeEstimates(text),
        objects: [],
        // Which slot/colour each filament prints with (single-colour jobs too, so the UI can say "White · slot 1").
        ...(machine.filaments.length ? parseSlotUsage(text, machine, allColors) : {}),
        preview: previewOf(abs, `build/${basename(abs)}`, intent),
      })
    }
    // Where each copy landed (R13): object -> entry/copy/letter, and the rotation that puts the mesh there.
    const placed = placeObjects(mapPlateObjects(defs, wanted, keys), (partId) => {
      const stl = parts.get(partId)?.fullStl
      return stl ? stlMesh(stl) : null
    })
    placed.forEach((objs, i) => (out[i].objects = objs))
    return out
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/**
 * sliceJobOnce, plus the Display intent's choice of top and bottom patterns: straight (monotonic) lines ending against
 * a curved outline leave a sawtooth band inside the edge on top, and a thin groove on the plate side. So when the first
 * slice shows that (top_lines_hit_curves / bottom_lines_hit_curves) and the caller didn't pick that pattern, slice
 * again with concentric lines there. Straight outlines keep monotonic (concentric leaves diagonal seams in square
 * corners).
 */
async function sliceJob(
  projectId: string,
  wanted: WantedPart[],
  machine: Machine,
  outNames: (plateCount: number) => string[],
  opts: SliceOptions = {},
  tweaks: JobTweaks = {},
): Promise<JobOutput[] & { autoOverrides?: Record<string, string> }> {
  const first = await sliceJobOnce(projectId, wanted, machine, outNames, opts, tweaks)
  if (opts.intent !== "display") return first
  const has = (code: string) => first.some((j) => j.preview?.issues.some((i) => i.code === code))
  const auto: Record<string, string> = {}
  // Ironing follows the same paths: rectilinear 90° ironing drags at curved edges (seen on a real test plate).
  if (opts.overrides?.top_surface_pattern === undefined && has("top_lines_hit_curves")) Object.assign(auto, { top_surface_pattern: "concentric", ironing_pattern: "concentric" })
  // The plate side is the show face of a face-down piece (1-inch apples F vs H).
  if (opts.overrides?.bottom_surface_pattern === undefined && has("bottom_lines_hit_curves")) auto.bottom_surface_pattern = "concentric"
  if (!Object.keys(auto).length) return first
  const second: JobOutput[] & { autoOverrides?: Record<string, string> } = await sliceJobOnce(projectId, wanted, machine, outNames, {
    ...opts,
    overrides: { ...opts.overrides, ...auto },
  }, tweaks)
  second.autoOverrides = auto
  return second
}

// ---------------------------------------------------------------------------------------------
// Colour plan: single-colour parts in different colours on one plate
// ---------------------------------------------------------------------------------------------

/** "2 h 15 min" / "50 min" / "40 s". */
export function plainDuration(s: number): string {
  s = Math.round(Math.abs(s))
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  if (h) return m ? `${h} h ${m} min` : `${h} h`
  if (m) return `${m} min`
  return `${s} s`
}

/** Tool changes in a G-code body (T<n> lines that switch to another tool). */
async function toolChanges(abs: string): Promise<number> {
  let n = 0
  let cur: string | null = null
  for (const m of (await readFile(abs, "utf8")).matchAll(/^T(\d+)\s*$/gm)) {
    if (cur != null && m[1] !== cur) n++
    cur = m[1]
  }
  return n
}

/** A colour-plan option's cost: print time plus 10 min of handling per extra plate (clearing the bed, starting it). */
export const PLATE_HANDLING_S = 600

type Candidate = { strategy: ColorPlanStrategy; jobs?: JobOutput[] & { autoOverrides?: Record<string, string> }; extra?: Record<string, string>; option: ColorPlanOption }

/** Pick the cheapest safe option and say why in plain words (exported for tests). */
export function chooseColorPlan(options: ColorPlanOption[]): ColorPlan {
  const score = (o: ColorPlanOption) => (o.estimatedTimeS ?? Infinity) + PLATE_HANDLING_S * Math.max(0, (o.plates ?? 1) - 1)
  const prefer: ColorPlanStrategy[] = ["by_object", "per_colour", "swaps"]
  const ok = options.filter((o) => o.ok).sort((a, b) => score(a) - score(b) || prefer.indexOf(a.strategy) - prefer.indexOf(b.strategy))
  const best = ok[0]
  const swaps = options.find((o) => o.strategy === "swaps")
  const cost = (o: ColorPlanOption) => `${o.estimatedTimeS != null ? plainDuration(o.estimatedTimeS) : "unknown time"}${o.filamentG != null ? `, ${Math.round(o.filamentG)} g` : ""}`
  const notSafe = options
    .filter((o) => !o.ok && o.strategy !== "swaps")
    .map((o) => ` ${o.strategy === "by_object" ? "Printing them one after another on one plate" : "One plate per colour"} wasn't possible: ${o.reason ?? "the slicer refused"}.`)
    .join("")
  if (!best || best.strategy === "swaps" || !swaps) {
    const better = options.filter((o) => o.ok && o.strategy !== "swaps")
    return {
      chosen: "swaps",
      summary:
        `Kept one plate that swaps colour on every layer${swaps?.colorChanges ? ` (${swaps.colorChanges} swaps)` : ""}: ${swaps ? cost(swaps) : ""}.` +
        (better.length ? ` ${better.map((o) => `${o.strategy === "by_object" ? "One part at a time" : "One plate per colour"} wouldn't be quicker (${cost(o)}).`).join(" ")}` : "") +
        notSafe,
      options,
    }
  }
  const dt = (swaps.estimatedTimeS ?? 0) - (best.estimatedTimeS ?? 0)
  const dg = Math.round((swaps.filamentG ?? 0) - (best.filamentG ?? 0))
  const saves = `saves ${plainDuration(dt)}${dg > 0 ? ` and ${dg} g` : ""}`
  const how =
    best.strategy === "by_object"
      ? `one plate, each part printed whole before the next (${best.colorChanges ?? "a few"} colour swap${best.colorChanges === 1 ? "" : "s"} instead of ${swaps.colorChanges ?? "one every layer"})`
      : `${best.plates} plates, one per colour, no colour swaps — clear the bed between them`
  return {
    chosen: best.strategy,
    summary: `Printing them one colour at a time ${saves}: ${how}. ${cost(best)} instead of ${cost(swaps)} with a colour swap on every layer.${notSafe}`,
    options,
  }
}

/**
 * slicePlate's slicing step. When every part is single-colour but the colours differ, one plate would swap colour
 * (and purge) on every layer — the E2E box+lid took 2x the time. So also try printing by object (each part whole,
 * shortest first; OrcaSlicer refuses if a part is too tall/close for the print head = not safe) and one plate per
 * colour, and keep the cheapest that is safe. An explicit print_sequence override skips the comparison.
 */
async function sliceWithColorPlan(
  projectId: string,
  wanted: WantedPart[],
  machine: Machine,
  names: (plateCount: number) => string[],
  opts: SliceOptions,
): Promise<{ jobs: JobOutput[] & { autoOverrides?: Record<string, string> }; extra?: Record<string, string>; colorPlan?: ColorPlan }> {
  const cache = new Map<string, PartBodies>()
  const { parts, multicolor } = await loadParts(projectId, wanted, machine, cache)
  const slots = new Set(wanted.map((w) => parts.get(w.partId)!.bodies[0]?.slot ?? 1))
  if (multicolor || slots.size < 2 || machine.filamentSlots < 2 || opts.overrides?.print_sequence !== undefined) {
    return { jobs: await sliceJob(projectId, wanted, machine, names, opts, { parts: cache }) }
  }
  const buildDir = join(projectDir(projectId), "build")
  const tmpNames = (tag: string) => (n: number) => Array.from({ length: n }, (_, i) => `.plan-${tag}-${i + 1}.gcode`)
  // assemble_<key> in OrcaSlicer's messages -> part id (keys follow wanted x qty).
  const keyPart = wanted.flatMap((w) => Array.from({ length: w.qty }, () => w.partId))
  const plain = (e: unknown) =>
    (e instanceof OrcaError && e.log ? e.log : String((e as Error)?.message ?? e))
      .replace(/^got error when validate:\s*/i, "")
      .replace(/assemble_(\d+)/g, (m, k) => (keyPart[Number(k) - 1] ? `"${keyPart[Number(k) - 1]}"` : m))
      .trim()
  const stats = async (strategy: ColorPlanStrategy, jobs: JobOutput[]): Promise<ColorPlanOption> => ({
    strategy,
    ok: true,
    plates: jobs.length,
    estimatedTimeS: sum(jobs.map((j) => j.est.estimatedTimeS)),
    filamentG: sum(jobs.map((j) => j.est.filamentG)),
    colorChanges: (await Promise.all(jobs.map((j) => toolChanges(j.gcodeAbs)))).reduce((a, b) => a + b, 0),
  })
  const candidates: Candidate[] = []
  try {
    const swaps = await sliceJob(projectId, wanted, machine, tmpNames("swaps"), opts, { parts: cache })
    candidates.push({ strategy: "swaps", jobs: swaps, option: await stats("swaps", swaps) })
    const extra = { print_sequence: "by object" }
    try {
      // The head travels over finished parts; only trust the profile's clearance numbers once someone has watched it.
      if (!machine.isPractice && !machine.sequentialPrintOk)
        throw new Error("printing one part at a time hasn't been checked on this printer yet (turn it on in Machines after a watched test print)")
      const j = await sliceJob(projectId, wanted, machine, tmpNames("by_object"), { ...opts, overrides: { ...opts.overrides, ...extra } }, { parts: cache, tallestLast: true })
      // Spilling onto more beds than the plain plate = there isn't room for the print head's clearance around each part.
      if (j.length > swaps.length) throw new Error(`the parts don't fit on ${swaps.length === 1 ? "one plate" : `${swaps.length} plates`} with room for the print head around each of them`)
      candidates.push({ strategy: "by_object", jobs: j, extra, option: await stats("by_object", j) })
    } catch (e) {
      candidates.push({ strategy: "by_object", option: { strategy: "by_object", ok: false, reason: plain(e) } })
    }
    try {
      const j = await sliceJob(projectId, wanted, machine, tmpNames("per_colour"), opts, { parts: cache, plateBySlot: true })
      candidates.push({ strategy: "per_colour", jobs: j, option: await stats("per_colour", j) })
    } catch (e) {
      candidates.push({ strategy: "per_colour", option: { strategy: "per_colour", ok: false, reason: plain(e) } })
    }
    const colorPlan = chooseColorPlan(candidates.map((c) => c.option))
    const chosen = candidates.find((c) => c.strategy === colorPlan.chosen)!
    const jobs = chosen.jobs!
    const final = names(jobs.length)
    for (const [i, j] of jobs.entries()) {
      const abs = join(buildDir, final[i])
      await rename(j.gcodeAbs, abs)
      j.gcodeAbs = abs
      if (j.preview) j.preview = { ...j.preview, gcodePath: `build/${final[i]}` }
    }
    return { jobs, extra: chosen.extra, colorPlan }
  } finally {
    for (const f of await readdir(buildDir)) if (/^\.plan-.*\.gcode$/.test(f)) await rm(join(buildDir, f), { force: true })
  }
}

async function slicePartRaw(projectId: string, partId: string, machineId?: string, opts: SliceOptions = {}): Promise<SliceResult> {
  const t0 = Date.now()
  if (opts.reuseLatest) {
    const last = await latestSliceInputs(projectId, partId)
    opts = { intent: opts.intent ?? last?.intent, overrides: opts.overrides ?? last?.overrides }
  }
  const root = projectDir(projectId)
  const machine = machineId ? requireMachine(machineId) : await projectMachine(projectId)
  const { warning } = ensureProfileDir(machine)
  // The source revision is taken before slicing: an edit during the slice makes the job stale, never silently current.
  const source = await sourceRevision(projectId, [partId])
  const jobs = await sliceJob(projectId, [{ partId, qty: 1 }], machine, (n) =>
    Array.from({ length: n }, (_, i) => (i === 0 ? `${partId}.gcode` : `${partId}-${i + 1}.gcode`)),
    opts,
  )
  const job = jobs[0]
  const overrides = { ...opts.overrides, ...jobs.autoOverrides }
  const intent = opts.intent ?? "standard"
  const printJob = await createJob(projectId, job.gcodeAbs, {
    kind: "part",
    parts: [{ partId, qty: 1 }],
    machine,
    slicedFor: machine,
    intent,
    overrides,
    userOverrides: opts.overrides ?? {},
    source,
    estimates: job.est,
    filamentBySlot: job.filamentBySlot,
    preview: job.preview,
    objects: job.objects,
  })
  recordPartJob(projectId, partId, printJob.id)
  await setProjectIntent(projectId, intent) // the toolbar picker follows the latest slice
  const result: SliceResult = {
    partId,
    gcodePath: relative(root, job.gcodeAbs).split("\\").join("/"),
    gcodeName: basename(job.gcodeAbs),
    ...job.est,
    durationMs: Date.now() - t0,
    ...(job.filamentBySlot ? { filamentBySlot: job.filamentBySlot, colorChanges: job.colorChanges ?? null } : {}),
    machineId: machine.id,
    ...(warning || jobs.autoOverrides ? { warnings: [...(warning ? [warning] : []), ...(jobs.autoOverrides ? [concentricNote(jobs.autoOverrides)] : [])] } : {}),
    intent: opts.intent ?? "standard",
    ...(Object.keys(overrides).length ? { overrides } : {}),
    ...(job.preview ? { preview: job.preview } : {}),
    jobId: printJob.id,
  }
  emit({ type: "slice.done", projectId, result })
  return result
}

/**
 * Slice several parts together: every part x qty arranged on the bed. One plate -> build/plate.gcode; if they
 * don't fit -> build/plate-1.gcode, plate-2.gcode, ... Default: all project parts at their qty. Parts with 2+
 * colours are sliced multicolour (color() bodies -> CFS slots).
 */
/**
 * Farm targets for a plate job: the listed machines (or every idle one), keeping only those that can run G-code
 * sliced for `primary` (same slicer profile, bed at least as big). Idle machines first.
 */
function farmTargets(primary: Machine, machineIds: string[] | "idle", warnings: string[]): Machine[] {
  const list = machineIds === "idle" ? idleMachines() : machineIds.map((id) => requireMachine(id))
  if (!list.length) throw httpError(409, machineIds === "idle" ? "no idle machines right now" : "no machines given")
  const ok = list.filter((m) => {
    const fits = m.slicerProfile === primary.slicerProfile && m.buildVolumeMm[0] >= primary.buildVolumeMm[0] && m.buildVolumeMm[1] >= primary.buildVolumeMm[1]
    if (!fits) warnings.push(`${m.name} skipped: it needs its own slice (${m.model}); slice separately for it.`)
    if (fits && !m.enabled) warnings.push(`${m.name} skipped: disabled.`)
    return fits && m.enabled
  })
  if (!ok.length) throw httpError(409, `none of the machines can run G-code sliced for ${primary.name}`)
  const idle = (m: Machine) => {
    const st = cachedStatus(m.id)
    return !!st?.connected && !["printing", "preparing", "paused", "error"].includes(st.state)
  }
  return [...ok.filter(idle), ...ok.filter((m) => !idle(m))]
}

async function slicePlateRaw(
  projectId: string,
  parts?: { partId: string; qty?: number; overrides?: Record<string, string | number | boolean> }[],
  machineId?: string,
  farm?: { machineIds?: string[] | "idle" },
  opts: SliceOptions = {},
): Promise<PlateSliceResult> {
  const t0 = Date.now()
  if (opts.reuseLatest) {
    const last = await latestSliceInputs(projectId)
    if (!parts?.length) parts = last?.parts
    opts = { intent: opts.intent ?? last?.intent, overrides: opts.overrides ?? last?.overrides }
  }
  const root = projectDir(projectId)
  const warnings: string[] = []
  // Primary machine: the one asked for, else the first farm machine, else the default.
  let machine = machineId ? requireMachine(machineId) : await projectMachine(projectId)
  let targets: Machine[] | null = null
  if (farm?.machineIds && (farm.machineIds === "idle" || farm.machineIds.length)) {
    if (!machineId) {
      const first = farm.machineIds === "idle" ? idleMachines()[0] : requireMachine(farm.machineIds[0])
      if (first) machine = first
    }
    targets = farmTargets(machine, farm.machineIds, warnings)
  }
  const { warning } = ensureProfileDir(machine)
  if (warning) warnings.unshift(warning)
  const project = await getProject(projectId)
  const wanted: WantedPart[] = (parts?.length ? parts : project.parts.map((p) => ({ partId: p.id, qty: p.qty }))).map((p) => ({
    partId: p.partId,
    qty: Math.max(1, Math.min(50, Math.round(p.qty ?? 1))),
    ...("overrides" in p && p.overrides && Object.keys(p.overrides).length ? { overrides: p.overrides } : {}),
  }))
  if (!wanted.length) throw httpError(400, "project has no parts to slice")
  for (const w of wanted) {
    if (!project.parts.some((p) => p.id === w.partId)) throw httpError(400, `unknown part: ${w.partId}`)
  }
  const source = await sourceRevision(
    projectId,
    wanted.map((w) => w.partId),
  )
  const { jobs, extra, colorPlan } = await sliceWithColorPlan(projectId, wanted, machine, (n) =>
    n === 1 ? ["plate.gcode"] : Array.from({ length: n }, (_, i) => `plate-${i + 1}.gcode`),
    opts,
  )
  // Drop plate files left over from an earlier slice with a different plate count (only after success).
  const buildDir = join(root, "build")
  const fresh = new Set(jobs.map((j) => basename(j.gcodeAbs)))
  for (const f of await readdir(buildDir)) if (/^plate(-\d+)?\.gcode$/.test(f) && !fresh.has(f)) await rm(join(buildDir, f), { force: true })
  // Say which parts have their own settings (they apply on top of the plate's intent), by the letter shown on the
  // plate (Model › Plate and Layers label every copy A, B, C… in this order).
  const letters = (i: number) => {
    const ls = jobs.flatMap((j) => j.objects).filter((o) => o.entry === i).map((o) => o.label).sort()
    return ls.length ? ` [${ls.join(", ")}]` : ""
  }
  const partNotes = wanted.flatMap((w, i) =>
    w.overrides && Object.keys(w.overrides).length
      ? [`${w.partId}${wanted.filter((x) => x.partId === w.partId).length > 1 ? ` (entry ${i + 1})` : ""}${letters(i)}: ${Object.entries(w.overrides).map(([k, v]) => `${k}=${v}`).join(", ")} (per-part, on top of the ${opts.intent ?? "standard"} intent)`]
      : [],
  )
  const intent = opts.intent ?? "standard"
  const effective = { ...opts.overrides, ...extra, ...jobs.autoOverrides }
  const jobIds: string[] = []
  for (const [i, j] of jobs.entries()) {
    const pj = await createJob(projectId, j.gcodeAbs, {
      kind: "plate",
      parts: wanted,
      allParts: !parts?.length,
      plate: i + 1,
      plateCount: jobs.length,
      machine: targets ? targets[i % targets.length] : machine,
      slicedFor: machine,
      intent,
      overrides: effective,
      userOverrides: opts.overrides ?? {},
      source,
      estimates: j.est,
      filamentBySlot: j.filamentBySlot,
      preview: j.preview,
      objects: j.objects,
    })
    jobIds.push(pj.id)
  }
  recordPlateSet(projectId, jobIds)
  await setProjectIntent(projectId, intent)
  const plates: PlateGcode[] = jobs.map((j, i) => ({
    plate: i + 1,
    gcodePath: `build/${basename(j.gcodeAbs)}`,
    gcodeName: basename(j.gcodeAbs),
    ...j.est,
    objects: j.objects.map(plateObjectOf),
    ...(j.filamentBySlot ? { filamentBySlot: j.filamentBySlot, colorChanges: j.colorChanges ?? null } : {}),
    // Farm: spread plates round-robin over the target machines (idle ones first).
    ...(targets ? { machineId: targets[i % targets.length].id } : {}),
    ...(j.preview ? { preview: partNotes.length ? { ...j.preview, notes: [...(j.preview.notes ?? []), ...partNotes] } : j.preview } : {}),
    jobId: jobIds[i],
  }))
  if (targets && targets.length > plates.length) {
    warnings.push(`${plates.length} plate(s) for ${targets.length} machines: ${targets.length - plates.length} stay free.`)
  }
  const multicolor = plates.some((p) => p.filamentBySlot)
  const result: PlateSliceResult = {
    plates,
    parts: wanted,
    estimatedTimeS: sum(plates.map((p) => p.estimatedTimeS)),
    filamentG: sum(plates.map((p) => p.filamentG)),
    filamentMm: sum(plates.map((p) => p.filamentMm)),
    durationMs: Date.now() - t0,
    ...(multicolor
      ? { filamentBySlot: sumSlots(plates), colorChanges: plates.reduce<number | null>((a, p) => (a == null || p.colorChanges == null ? null : a + p.colorChanges), 0) }
      : {}),
    machineId: machine.id,
    ...(warnings.length || jobs.autoOverrides ? { warnings: [...warnings, ...(jobs.autoOverrides ? [concentricNote(jobs.autoOverrides)] : [])] } : {}),
    intent: opts.intent ?? "standard",
    ...(Object.keys(effective).length ? { overrides: effective } : {}),
    ...(colorPlan ? { colorPlan } : {}),
  }
  for (const p of plates) {
    emit({
      type: "slice.done",
      projectId,
      result: {
        partId: p.gcodeName.replace(/\.gcode$/, ""),
        gcodePath: p.gcodePath,
        gcodeName: p.gcodeName,
        estimatedTimeS: p.estimatedTimeS,
        filamentG: p.filamentG,
        filamentMm: p.filamentMm,
        durationMs: result.durationMs,
        ...(p.filamentBySlot ? { filamentBySlot: p.filamentBySlot, colorChanges: p.colorChanges ?? null } : {}),
        intent,
        jobId: p.jobId,
      },
    })
  }
  return result
}

/**
 * Remember a failed slice for the overview (plain words, until the next slice or a design change); clear it on
 * success. Bad requests (400/404) are the caller's mistake, not the design's, so they aren't kept.
 */
async function noteSliceOutcome<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  try {
    const r = await fn()
    clearSliceError(projectId)
    return r
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode
    if (status !== 400 && status !== 404) {
      recordSliceError(projectId, (e as Error).message ?? String(e))
      emit({ type: "jobs.changed", projectId })
    }
    throw e
  }
}

/** Slice one part for a machine (the project's target when omitted). See slicePartRaw. */
export function slicePart(...args: Parameters<typeof slicePartRaw>): Promise<SliceResult> {
  return noteSliceOutcome(args[0], () => slicePartRaw(...args))
}

/** Slice several parts onto plates. See slicePlateRaw. */
export function slicePlate(...args: Parameters<typeof slicePlateRaw>): Promise<PlateSliceResult> {
  return noteSliceOutcome(args[0], () => slicePlateRaw(...args))
}
