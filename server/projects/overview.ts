// R12: the project overview. One read-only aggregate of what the maker needs to see first — the finished thing, its
// size, colours and grams, plates and how long they take, what's still to buy, what's out of date — and the ONE next
// action computed from that state. Computed on read from existing records; never renders, slices or prints.
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type {
  Assembly,
  FilamentSlot,
  OverviewAction,
  OverviewPart,
  OverviewPlate,
  PrintJobView,
  PrintRecord,
  ProjectJobs,
  ProjectOverview,
  ProjectValidity,
  RenderResult,
  Units,
} from "../../shared/types"
import { blankDesignAt, getProject, projectDir } from "./store"
import { partDesignColors } from "./colors"
import { projectValidity } from "./validity"
import { getProjectBom, readAssembly } from "../assembly/index"
import { STUDIO_HERO } from "../assembly/art"
import { projectJobs, projectMachine } from "../jobs/index"
import { listPrints } from "../db"
import { isApproved } from "../agent/approval"
import { CHECK_RULES } from "../cad/mesh"
import { displayUrl } from "../cad/display"
import { currentSliceError } from "../slicer/last-error"
import { isPracticePrint, machineById } from "../printer/index"
import { getSettings } from "../config"
import { fmtLen } from "../../shared/length"

type Vec3 = [number, number, number]
type RenderMeta = { hash?: string; stats?: RenderResult["stats"]; images?: string[]; error?: string }

function readJson<T>(abs: string): T | null {
  try {
    return JSON.parse(readFileSync(abs, "utf8")) as T
  } catch {
    return null
  }
}

/** Axis-aligned box of a part's mesh box after rotate (X, then Y, then Z; degrees) and translate. */
export function placedBox(min: Vec3, max: Vec3, rotate: Vec3 | undefined, translate: Vec3): { min: Vec3; max: Vec3 } {
  const [rx, ry, rz] = (rotate ?? [0, 0, 0]).map((d) => (d * Math.PI) / 180)
  const lo: Vec3 = [Infinity, Infinity, Infinity]
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const x of [min[0], max[0]])
    for (const y of [min[1], max[1]])
      for (const z of [min[2], max[2]]) {
        // X
        let [px, py, pz] = [x, y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)]
        // Y
        ;[px, pz] = [px * Math.cos(ry) + pz * Math.sin(ry), -px * Math.sin(ry) + pz * Math.cos(ry)]
        // Z
        ;[px, py] = [px * Math.cos(rz) - py * Math.sin(rz), px * Math.sin(rz) + py * Math.cos(rz)]
        const p: Vec3 = [px + translate[0], py + translate[1], pz + translate[2]]
        for (let i = 0; i < 3; i++) {
          lo[i] = Math.min(lo[i], p[i])
          hi[i] = Math.max(hi[i], p[i])
        }
      }
  return { min: lo, max: hi }
}

const round1 = (v: Vec3): Vec3 => v.map((x) => Math.round(x * 10) / 10) as Vec3

/** Overall size of the assembled build from part boxes + placements; null when a placed part has no box. */
export function assembledSize(a: Assembly, boxes: Record<string, { min: Vec3; max: Vec3 } | null>): Vec3 | null {
  if (!a.placements?.length) return null
  const lo: Vec3 = [Infinity, Infinity, Infinity]
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const pl of a.placements) {
    const b = boxes[pl.part]
    if (!b) return null
    const r = placedBox(b.min, b.max, pl.rotate, pl.translate)
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], r.min[i])
      hi[i] = Math.max(hi[i], r.max[i])
    }
  }
  return round1([hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]])
}

// ---------------------------------------------------------------------------------------------
// The next action. Pure: everything it needs is in NextInput (tests build these by hand).
// ---------------------------------------------------------------------------------------------

/** A part bigger than the printer's usable volume (the "Fits on the printer" check, known from its last picture). */
export interface TooBig {
  partId: string
  printer: string
  axis: "wide" | "deep" | "tall"
  sizeMm: number
  maxMm: number
}

/** A failing printability check of the current design (fresh checks only). */
export interface FailingCheck {
  partId: string
  rule: string
  message: string
}

export interface NextInput {
  hasDesign: boolean
  renderErrors: string[] // "base: <error>"
  missingRenders: string[] // parts never rendered (a render is probably on its way)
  staleRenders: string[] // parts whose preview is out of date
  approved: boolean
  multiPart: boolean
  slice: ProjectOverview["slice"]
  plates: OverviewPlate[]
  nextPlate: number | null // 1-based
  guide: { steps: number; exists: boolean } | null
  needsAssembly: boolean // more than one printed piece, or bought hardware goes in
  lastPrint: ProjectOverview["lastPrint"]
  /** parts too big for the printer (from their size), U1: these come before slicing, not "Approve the design" */
  tooBig?: TooBig[]
  /** other failing checks of this exact design */
  failingChecks?: FailingCheck[]
  /** the last slice of this design revision failed */
  sliceError?: { message: string; kind: string } | null
  /** the user's unit for sizes in the text (Settings.units; mm when unset) */
  units?: Units
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`

export function nextAction(s: NextInput): OverviewAction {
  if (!s.hasDesign)
    return { kind: "describe", label: "Describe what to make", detail: "Tell the designer what you want, in your own words." }
  if (s.renderErrors.length)
    return { kind: "fix", label: "Ask the designer to fix it", detail: `The model didn't build: ${s.renderErrors[0]}` }
  if (s.missingRenders.length || s.staleRenders.length)
    return {
      kind: "update",
      label: "Update the preview",
      detail: s.missingRenders.length
        ? `No picture of ${s.missingRenders.join(", ")} yet.`
        : "The design changed since the last picture.",
    }
  const printing = s.plates.find((p) => p.status === "printing")
  if (printing)
    return {
      kind: "printing",
      label: s.plates.length > 1 ? `Watch plate ${printing.plate} print` : "Watch it print",
      detail: "It's printing now.",
    }
  // What the checks (or the last slice) already know comes before slicing: a beginner does what the big button says.
  const big = s.tooBig?.[0]
  const u: Units = s.units === "in" ? "in" : "mm"
  if (big)
    return {
      kind: "fit",
      label: "Make it fit",
      detail: `Too big for ${big.printer}: ${fmtLen(big.sizeMm, u)} ${big.axis}, max ${fmtLen(big.maxMm, u)}.`,
      partId: big.partId,
    }
  const failing = s.failingChecks?.[0]
  if (failing) return { kind: "problem", label: "Fix the problem", detail: failing.message, partId: failing.partId }
  if (s.sliceError)
    return s.sliceError.kind === "fit"
      ? { kind: "fit", label: "Make it fit", detail: s.sliceError.message }
      : {
          kind: "problem",
          label: "Fix the problem",
          detail: s.sliceError.kind === "other" ? s.sliceError.message : `Slicing didn't work. ${s.sliceError.message}`,
        }
  const current = s.slice.state === "current"
  // No separate "Approve" step for the user: the print dialog shows the checks and its Print approves this version
  // (U1). The designer still needs approval before it slices or asks to print (R05).
  if (!current)
    return s.slice.state === "stale"
      ? // one button: the action slices the same thing again, then asks to print (the print dialog still confirms)
        { kind: "slice", label: "Slice again and print", detail: staleDetail(s.slice.reasons) }
      : { kind: "slice", label: "Slice it", detail: s.multiPart ? "Lay the parts out on plates." : "Get it ready for the printer." }
  if (s.nextPlate != null) {
    const pl = s.plates[s.nextPlate - 1]
    // only a print that started and failed is a "try again"; "Don't print" (or a refused request) never sent anything
    const again = pl?.status === "failed"
    const n = s.plates.length
    if (pl?.status === "requested")
      return { kind: "waiting", label: "Answer the print dialog", detail: `Plate ${pl.plate} is waiting for your OK.`, plate: pl.plate }
    return {
      kind: "print",
      label: n > 1 ? `Print plate ${s.nextPlate} of ${n}${again ? " again" : ""}` : again ? "Print it again" : "Print it",
      detail: again
        ? "The last try didn't finish. Clear the bed first."
        : n > 1
          ? `${plural(n - s.nextPlate + 1, "plate")} left.`
          : "You'll check the bed is clear first.",
      plate: s.nextPlate,
    }
  }
  // every plate started; all done (none printing)
  const rated = s.lastPrint ? s.lastPrint.rated || !!s.lastPrint.practice : true
  if (s.guide && s.guide.steps > 0 && s.needsAssembly && !rated)
    return {
      kind: "assemble",
      label: "Put it together",
      detail: `${plural(s.guide.steps, "step")} to put it together.`,
    }
  if (s.lastPrint && !rated && !s.lastPrint.practice && s.lastPrint.state !== "printing")
    return { kind: "feedback", label: "How did it turn out?", detail: "A rating helps the next print.", printId: s.lastPrint.id }
  return { kind: "again", label: "Print another one", detail: s.lastPrint?.practice ? "Practice print done. Nothing was printed." : "Everything is printed." }
}

/** Why the slice is out of date, in one short sentence (the reasons stay in Details). */
export function staleDetail(reasons: string[]): string {
  const r = reasons[0] ?? ""
  if (/print settings changed/.test(r)) return "Settings changed. Slice again."
  if (/now prints on|sliced for|printer settings changed|was removed$/.test(r)) return "The printer changed. Slice again."
  return "The design changed. Slice again."
}

/** A part too big for the machine's usable volume (same rule as the "Fits on the printer" check). */
export function tooBigFor(partId: string, sizeMm: [number, number, number], m: { name: string; buildVolumeMm: [number, number, number] }): TooBig | null {
  const [bx, by, bz] = m.buildVolumeMm
  const max: [number, number, number] = [bx - 2 * CHECK_RULES.bedMarginMm, by - 2 * CHECK_RULES.bedMarginMm, bz]
  const axes = ["wide", "deep", "tall"] as const
  for (let i = 0; i < 3; i++) if (sizeMm[i] > max[i] + 0.05) return { partId, printer: m.name, axis: axes[i], sizeMm: sizeMm[i], maxMm: max[i] }
  return null
}

/** Plain words for a failing check (the rule ids and thresholds stay in the Checks panel). */
const CHECK_PROBLEM: Record<string, string> = {
  manifold: "The shape has holes or gaps, so it can't print.",
  bodies: "It has loose pieces that aren't joined.",
  colors: "It uses more colours than the printer holds.",
}

// ---------------------------------------------------------------------------------------------
// Composer suggestions: computed from the project, not generic.
// ---------------------------------------------------------------------------------------------

export interface SuggestInput {
  hasDesign: boolean
  name: string
  tags: string[]
  sizeMm: Vec3 | null
  partCount: number
  colors: string[] // colours the design uses (lowercase names)
  loaded: FilamentSlot[] // what's in the printer
  hasScrews: boolean // the build already uses screws / bolts
  hasGuide: boolean
  multiPart: boolean
  printed: boolean // at least one print of it finished
  printing?: boolean // a print of it is running now ("Print another one" waits until it's done)
  lastProblem: string | null // the last outcome's first failure category, if any
  outOfDate: boolean
}

const PROBLEM_FIX: Record<string, string> = {
  didnt_stick: "It came off the bed — make it stick better",
  stringing: "It had stringing — fix that",
  warping: "The corners lifted — stop it warping",
  rough_top: "The top came out rough — make it smoother",
  wrong_size: "It came out the wrong size — fix the fit",
  broke: "It broke — make it stronger",
  layer_shift: "The layers shifted — try again more safely",
}

export function suggestionsFor(s: SuggestInput): string[] {
  if (!s.hasDesign) return []
  const out: string[] = []
  if (s.lastProblem && PROBLEM_FIX[s.lastProblem]) out.push(PROBLEM_FIX[s.lastProblem])
  if (s.outOfDate) out.push("Bring everything up to date")
  const max = s.sizeMm ? Math.max(...s.sizeMm) : null
  if (max != null) out.push(max < 80 ? "Make it bigger" : max > 180 ? "Make it smaller" : "Make it a bit bigger")
  const text = `${s.name} ${s.tags.join(" ")}`.toLowerCase()
  const mounts = /hook|holder|hanger|shelf|bracket|rack|mount|organi[sz]er|caddy|clip/.test(text)
  if (!s.hasScrews) out.push(mounts ? "Add holes to screw it to the wall" : "Add a hole for a screw")
  const used = new Set(s.colors.map((c) => c.toLowerCase()))
  const other = s.loaded.find((f) => f.loaded && !used.has(f.colorName.toLowerCase()))
  if (other) out.push(used.size <= 1 && s.loaded.length > 1 ? `Try it in ${other.colorName.toLowerCase()}` : `Use ${other.colorName.toLowerCase()} for one part`)
  if (s.printed && !s.printing) out.push("Print another one")
  if (s.multiPart && s.hasGuide) out.push("Explain how it goes together")
  if (!/name|tag|label|sign/.test(text) && !s.multiPart) out.push("Add my name to it")
  return [...new Set(out)].slice(0, 4)
}

// ---------------------------------------------------------------------------------------------

function platesOf(jobs: ProjectJobs, partIds: string[]): { plates: OverviewPlate[]; kind: "part" | "plate" | null; views: PrintJobView[]; next: number | null } {
  const toPlate = (v: PrintJobView, i: number): OverviewPlate => ({
    plate: v.plate ?? i + 1,
    jobId: v.id,
    status: v.status,
    partIds: v.partIds,
    estimatedTimeS: v.estimatedTimeS,
    adjustedTime: v.adjustedTime ?? null,
    filamentG: v.filamentG,
    ...(v.practice ? { practice: true } : {}),
  })
  // Multi-part projects print plate sets; a single-part project prints its part's own slice.
  if (partIds.length > 1 || (jobs.plates && !partIds.some((id) => jobs.parts[id]))) {
    if (!jobs.plates) return { plates: [], kind: null, views: [], next: null }
    return { plates: jobs.plates.plates.map(toPlate), kind: "plate", views: jobs.plates.plates, next: jobs.plates.next == null ? null : jobs.plates.next + 1 }
  }
  const v = jobs.parts[partIds[0]]
  if (!v) return { plates: [], kind: null, views: [], next: null }
  const started = v.status === "printing" || v.status === "done"
  return { plates: [toPlate(v, 0)], kind: "part", views: [v], next: started ? null : 1 }
}

const sumOrNull = (xs: (number | null | undefined)[]) => (xs.length && xs.every((x) => x != null) ? xs.reduce<number>((a, x) => a + (x ?? 0), 0) : null)

export async function projectOverview(projectId: string): Promise<ProjectOverview> {
  const project = await getProject(projectId)
  const root = projectDir(projectId)
  const url = (rel: string, v: string | number) => displayUrl(projectId, rel, v)
  const [validity, jobs, asm, machine] = await Promise.all([
    projectValidity(projectId).catch((): ProjectValidity => ({ parts: {}, assembly: null })),
    projectJobs(projectId).catch((): ProjectJobs => ({ parts: {}, plates: null, intent: null })),
    readAssembly(projectId).catch(() => ({ assembly: null as Assembly | null })),
    projectMachine(projectId).catch(() => null),
  ])
  const a = asm.assembly

  // A brand-new project holds one blank starter part until the designer writes something (never sliced or printed).
  const hasDesign = project.parts.length > 0 && !blankDesignAt(root)

  const metas: Record<string, RenderMeta | null> = {}
  for (const p of project.parts) metas[p.id] = readJson<RenderMeta>(join(root, "build", `${p.id}.render.json`))
  const parts: OverviewPart[] = project.parts.map((p) => {
    const m = metas[p.id]
    const ap = a?.parts.find((x) => x.id === p.id)
    const iso = m && !m.error && existsSync(join(root, "renders", `${p.id}-iso.png`)) ? url(`renders/${p.id}-iso.png`, m.hash ?? "") : null
    return {
      id: p.id,
      name: ap?.name ?? p.id,
      qty: ap?.qty ?? p.qty,
      colors: ((c) => (c.length ? c : ap?.color ? [ap.color] : []))(partDesignColors(root, p)),
      sizeMm: m?.stats?.sizeMm ? round1(m.stats.sizeMm) : null,
      imageUrl: iso,
      error: m?.error ?? null,
    }
  })

  // overall size
  let size: ProjectOverview["size"] = null
  if (a) {
    const boxes = Object.fromEntries(project.parts.map((p) => [p.id, metas[p.id]?.stats?.bbox ?? null]))
    const s = assembledSize(a, boxes)
    if (s) size = { mm: s, basis: "assembled" }
  }
  if (!size) {
    const sized = parts.filter((p) => p.sizeMm)
    if (sized.length === 1 && parts.length === 1) size = { mm: sized[0].sizeMm!, basis: "part" }
    else if (sized.length) {
      const big = sized.reduce((b, p) => (Math.max(...p.sizeMm!) > Math.max(...b.sizeMm!) ? p : b))
      size = { mm: big.sizeMm!, basis: "largest-part" }
    }
  }

  // hero picture
  const guideV = validity.assembly?.guide
  let hero: ProjectOverview["hero"] = null
  if (a && existsSync(join(root, "renders/assembly-complete.png"))) {
    // The guide's picture is on paper white; the app shows the same view on a transparent background when drawn.
    const studio = existsSync(join(root, STUDIO_HERO)) && statSync(join(root, STUDIO_HERO)).mtimeMs >= statSync(join(root, "renders/assembly-complete.png")).mtimeMs - 5000
    hero = { url: url(studio ? STUDIO_HERO : "renders/assembly-complete.png", guideV?.builtAt ?? Date.now()), kind: "assembly", stale: guideV?.state === "stale" }
  } else {
    const main = parts.find((p) => p.imageUrl)
    if (main) hero = { url: main.imageUrl!, kind: "part", stale: validity.parts[main.id]?.render.state === "stale" }
  }

  // slice + plates
  const { plates, kind, views, next: nextPlate } = platesOf(jobs, project.parts.map((p) => p.id))
  const reasons = [...new Set(views.flatMap((v) => v.stale))]
  const slice: ProjectOverview["slice"] = { state: !views.length ? "none" : reasons.length ? "stale" : "current", reasons, kind }
  const filamentG = slice.state === "current" ? sumOrNull(plates.map((p) => p.filamentG)) : null
  const estimatedS = slice.state === "current" ? sumOrNull(plates.map((p) => p.estimatedTimeS)) : null
  const adjustedS = slice.state === "current" ? sumOrNull(plates.map((p) => p.adjustedTime?.estimatedTimeS)) : null
  const calPrints = Math.max(0, ...plates.map((p) => p.adjustedTime?.prints ?? 0))

  // materials: per CFS slot from the current slice, else the design's colours mapped onto what's loaded
  const loaded = machine?.filaments ?? []
  const slotOf = (c: string) => loaded.find((f) => f.colorName.toLowerCase() === c.toLowerCase()) ?? null
  let materials: ProjectOverview["materials"] = []
  if (slice.state === "current") {
    const bySlot = new Map<number, ProjectOverview["materials"][number]>()
    for (const v of views)
      for (const s of v.filamentBySlot ?? []) {
        const cur = bySlot.get(s.slot)
        const mat = loaded.find((f) => f.slot === s.slot)?.material ?? "PLA"
        bySlot.set(s.slot, { colorName: s.colorName, colorHex: s.colorHex, material: mat, slot: s.slot, grams: cur ? sumOrNull([cur.grams, s.grams]) : s.grams })
      }
    materials = [...bySlot.values()].sort((x, y) => (x.slot ?? 0) - (y.slot ?? 0))
  }
  if (!materials.length) {
    const colors = [...new Set(parts.flatMap((p) => p.colors.map((c) => c.toLowerCase())))]
    const list = colors.length ? colors : [loaded.find((f) => f.loaded)?.colorName ?? "white"]
    materials = list.map((c) => {
      const f = slotOf(c)
      return { colorName: f?.colorName ?? c, colorHex: f?.colorHex ?? null, material: f?.material ?? "PLA", slot: f?.slot ?? null, grams: null }
    })
    // one colour and a current slice: its total is that colour's
    if (materials.length === 1 && filamentG != null) materials[0].grams = filamentG
  }

  // supplies (R17)
  let supplies: ProjectOverview["supplies"] = null
  let hardwareCount = 0
  if (a) {
    const bom = await getProjectBom(projectId).catch(() => null)
    if (bom) {
      const buy = bom.items.filter((i) => (i.category === "purchased" || i.category === "consumable") && !i.have)
      hardwareCount = bom.items.filter((i) => i.category === "purchased").reduce((n, i) => n + (i.need ?? 0), 0)
      supplies = {
        toBuy: bom.totals.toBuy,
        have: bom.totals.have,
        estUsd: bom.totals.estUsd,
        items: buy.slice(0, 6).map((i) => ({ name: i.name, need: i.need, ...(i.needText ? { needText: i.needText } : {}) })),
      }
    }
  }

  // out of date (R07)
  const outOfDate: ProjectOverview["outOfDate"] = []
  const staleRenders: string[] = []
  const missingRenders: string[] = []
  for (const p of project.parts) {
    const v = validity.parts[p.id]
    if (!v) continue
    if (v.render.state === "stale") {
      staleRenders.push(p.id)
      outOfDate.push({ what: `Preview of ${p.id}`, reasons: v.render.reasons })
    } else if (v.render.state === "missing" && hasDesign) missingRenders.push(p.id)
    if (v.check.state === "stale") outOfDate.push({ what: `Printability check of ${p.id}`, reasons: v.check.reasons })
  }
  if (validity.assembly?.guide.state === "stale") outOfDate.push({ what: "Assembly guide", reasons: validity.assembly.guide.reasons })
  if (validity.assembly?.motion?.state === "stale") outOfDate.push({ what: "Moving-parts check", reasons: validity.assembly.motion.reasons })
  if (slice.state === "stale") outOfDate.push({ what: kind === "plate" ? "Sliced plates" : "Sliced file", reasons: slice.reasons })

  // prints
  const prints: PrintRecord[] = (() => {
    try {
      return listPrints(projectId, 20)
    } catch {
      return []
    }
  })()
  const lp = prints[0]
  const lastPrint: ProjectOverview["lastPrint"] = lp
    ? {
        id: lp.id,
        state: lp.state,
        startedAt: lp.startedAt,
        finishedAt: lp.finishedAt,
        rated: !!lp.outcome || lp.result != null,
        practice: isPracticePrint(lp),
      }
    : null
  // The printer this project's running print is on: "Watch it print" follows it, not the project's printer.
  const running = prints.find((p) => p.state === "printing" && p.machineId)
  const runningOn = running ? machineById(running.machineId) : undefined
  const printingOn = runningOn ? { machineId: runningOn.id, name: runningOn.name } : null

  // Failures known before slicing: too big for the printer, failing checks of this exact design, a failed slice.
  const tooBig: TooBig[] = []
  if (machine)
    for (const p of parts) {
      const t = p.sizeMm && !p.error ? tooBigFor(p.id, p.sizeMm, machine) : null
      if (t) tooBig.push(t)
    }
  const failingChecks: FailingCheck[] = []
  for (const p of project.parts) {
    if (validity.parts[p.id]?.check.state !== "fresh") continue
    const rep = readJson<{ items?: { rule: string; severity: string; message: string }[] }>(join(root, ".studio", "checks", `${p.id}.json`))
    for (const i of rep?.items ?? []) {
      if (i.severity !== "fail") continue
      if (i.rule === "fits_bed") {
        if (!tooBig.some((t) => t.partId === p.id) && machine) {
          const size = parts.find((x) => x.id === p.id)?.sizeMm
          const t = size ? tooBigFor(p.id, size, machine) : null
          if (t) tooBig.push(t)
          else failingChecks.push({ partId: p.id, rule: i.rule, message: `Too big for ${machine.name}.` })
        }
        continue
      }
      const name = parts.find((x) => x.id === p.id)?.name ?? p.id
      const what = CHECK_PROBLEM[i.rule] ?? i.message.split(/(?<=\.)\s/)[0]
      failingChecks.push({ partId: p.id, rule: i.rule, message: project.parts.length > 1 ? `${name}: ${what}` : what })
    }
  }
  const sliceErr = currentSliceError(projectId)
  if (sliceErr) slice.error = { message: sliceErr.message, detail: sliceErr.detail }

  const guide = a ? { steps: a.steps.length, exists: !!guideV && guideV.state !== "missing", current: guideV?.state === "fresh" } : null
  const printedCount = parts.reduce((n, p) => n + (p.qty || 0), 0)
  const approved = (() => {
    try {
      return isApproved(projectId)
    } catch {
      return false
    }
  })()
  const multiPart = project.parts.length > 1

  const action = nextAction({
    hasDesign,
    renderErrors: parts.filter((p) => p.error).map((p) => `${p.id}: ${p.error!.split("\n")[0].slice(0, 160)}`),
    missingRenders,
    staleRenders,
    approved,
    multiPart,
    slice,
    plates,
    nextPlate,
    guide,
    needsAssembly: printedCount > 1 || hardwareCount > 0,
    lastPrint,
    tooBig,
    failingChecks,
    sliceError: sliceErr && slice.state !== "current" ? { message: sliceErr.message, kind: sliceErr.kind } : null,
    units: getSettings().units,
  })

  const suggestions = suggestionsFor({
    hasDesign,
    name: project.name,
    tags: project.tags,
    sizeMm: size?.mm ?? null,
    partCount: project.parts.length,
    colors: [...new Set(parts.flatMap((p) => p.colors))],
    loaded,
    // the build uses screws, or a part already has screw holes (its source talks about them)
    hasScrews:
      !!a?.hardware.some((h) => /screw|bolt/.test(h.type)) ||
      project.parts.some((p) => {
        try {
          return /screw/i.test(readFileSync(join(root, p.file), "utf8"))
        } catch {
          return false
        }
      }),
    hasGuide: !!a?.steps.length,
    multiPart,
    printed: prints.some((p) => p.state === "complete"),
    printing: prints.some((p) => p.state === "printing") || plates.some((p) => p.status === "printing"),
    lastProblem: lp?.outcome?.categories?.[0] ?? null,
    outOfDate: staleRenders.length > 0 || outOfDate.some((o) => o.what.startsWith("Printability")),
  })

  return {
    projectId,
    name: project.name,
    description: project.description ?? a?.summary ?? null,
    hasDesign,
    hero,
    size,
    parts,
    printedCount,
    hardwareCount,
    materials,
    filamentG,
    slice,
    plates,
    nextPlate,
    time: { estimatedS, adjustedS, prints: calPrints },
    supplies,
    guide,
    outOfDate,
    approved,
    lastPrint,
    printingOn,
    next: action,
    suggestions,
  }
}
