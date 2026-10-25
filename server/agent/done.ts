// A soft "definition of done": open items the tools report back to the agent (after render_part, check_part, and
// from request_print when the user declines) so it can decide what to do next. Nothing in doneChecklist blocks.
// The hard gates live elsewhere and run before the print dialog: user approval of the current design revision
// (approval.ts), a preview_slice look at the exact G-code being requested (review.ts), and the picture guide for
// builds that go together (guideRequired below).
//
// Items come from the project's real state (geometry checks, assembly.json, the guide on disk), not from keywords
// in the agent's prose. The one exception is the plan-vs-shopping-list comparison, which reads what the agent told
// the user (share_plan) because that promise is the thing being checked.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Assembly, CheckReport } from "../../shared/types"
import { assemblyStampAt } from "../projects/revision"
import { checkValidityAt, guideValidityAt, motionValidityAt, readMotionRecord, reasonLine } from "../projects/validity"
import { deps } from "./deps"
import { machineChecklist } from "./machines"

interface Track {
  planText: string | null // last share_plan (title + bullets)
  slices: Map<string, { seq: number; issues: QualityIssue[] }> // gcodePath -> last slice
  previewed: Map<string, number> // gcodePath -> seq of the last preview_slice
}
type QualityIssue = { code: string; severity: string; message: string; fix?: string }
/** Look-related findings worth raising even when the analyzer files them as info. */
const LOOK_ISSUES = new Set(["no_edge_chamfer_display", "top_lines_hit_curves", "show_face_down"])
const tracks = new Map<string, Track>()
const track = (projectId: string): Track => {
  let t = tracks.get(projectId)
  if (!t) tracks.set(projectId, (t = { planText: null, slices: new Map(), previewed: new Map() }))
  return t
}

export const notePlan = (projectId: string, text: string) => void (track(projectId).planText = text)
// A sequence number rather than a timestamp, so events in the same millisecond still order correctly.
let seq = 0

/**
 * A slice_part / slice_plate result (SliceResult or PlateSliceResult JSON): remember each G-code and the quality
 * issues its preview summary found. Called from the session's message stream, so the slice tools need no hooks.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function noteSliceResult(projectId: string, result: any) {
  const t = track(projectId)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: any[] = Array.isArray(result?.plates) ? result.plates : [result]
  for (const r of items) {
    const gcode = r?.gcodePath ?? r?.preview?.gcodePath
    if (typeof gcode === "string") t.slices.set(gcode, { seq: ++seq, issues: r?.preview?.issues ?? result?.preview?.issues ?? [] })
  }
}

/** A preview_slice result (SlicePreviewSummary JSON): the agent looked at this G-code. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function notePreview(projectId: string, gcodePath: string | undefined, summary: any) {
  const t = track(projectId)
  const g = gcodePath ?? summary?.gcodePath ?? [...t.slices.keys()].pop()
  if (!g) return
  t.previewed.set(g, ++seq)
  const s = t.slices.get(g)
  if (s && Array.isArray(summary?.issues)) s.issues = summary.issues
}

/** Failing items from the latest saved check of each part (.studio/checks/<part>.json), for the agent and the print dialog. */
export function failingChecks(projectRoot: string, partIds?: string[]): string[] {
  const dir = join(projectRoot, ".studio", "checks")
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const partId = f.slice(0, -5)
    if (partIds && !partIds.includes(partId)) continue
    try {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as CheckReport
      for (const i of r.items ?? []) if (i.severity === "fail") out.push(`${partId}: ${i.message}`)
    } catch {
      /* unreadable report */
    }
  }
  return out
}

// Hardware words, used only to compare the plan the user saw with the shopping list.
const HW = /\b(screws?|bolts?|nuts?|magnets?|heat[- ]?set inserts?|inserts?|adhesive strips?|sticky strips?|command strips?|double[- ]sided tape|wall anchors?|nails?|dowels?|springs?|bearings?|glue)\b/i
const NO_HW = /\b(no|without|zero)\s+(extra\s+|other\s+)?(hardware|screws?|glue|extra parts|parts to buy)\b/i
/** Hardware words the plan mentions, ignoring negated phrases ("no extra parts", "without glue"). */
const hardwareMentioned = (plan: string) =>
  [...new Set((plan.replace(new RegExp(NO_HW.source, "gi"), "").match(new RegExp(HW.source, "gi")) ?? []).map((m) => m.toLowerCase()))]

/** Open items, one plain line each (empty list = nothing obviously open). */
export async function doneChecklist(projectId: string): Promise<string[]> {
  const root = deps.projectDir(projectId)
  const t = track(projectId)
  const items: string[] = []
  const project = await deps.getProject(projectId)
  const partIds = project.parts.map((p) => p.id)

  // 1. Geometry checks: failing, or not re-run since anything it's built from changed (its file, an included lib
  //    file, its Customizer values): the same freshness the app's Checks panel shows (server/projects/validity.ts).
  for (const f of failingChecks(root, partIds)) items.push(`Failing check: ${f}`)
  for (const p of project.parts) {
    if (!existsSync(join(root, p.file))) continue
    const v = checkValidityAt(root, p)
    if (v.state === "missing") items.push(`${p.id} hasn't been checked yet (check_part)`)
    else if (v.state === "stale") items.push(`${p.id} hasn't been checked since its last change: ${reasonLine(v)} (check_part)`)
  }

  // 2. Assembly: moving parts, multi-part/hardware guide, plan vs shopping list
  const asm: Assembly | null = await deps
    .readAssembly(projectId)
    .then((r) => r.assembly)
    .catch(() => null)
  const motions = asm?.motions?.length ?? 0
  const hardware = asm?.hardware ?? []
  const asmStamp = asm ? assemblyStampAt(root, project.parts) : null
  if (motions && asmStamp) {
    // The persisted check_motion result (build/motion-check.json) and whether it matches the design now.
    const mv = motionValidityAt(root, project.parts, asmStamp)
    const last = readMotionRecord(root)?.check
    if (mv.state === "missing") items.push("Moving parts haven't been checked for collisions yet (check_motion)")
    else if (mv.state === "stale") items.push(`It has ${motions} motion(s) but check_motion hasn't run since the last change: ${reasonLine(mv)}`)
    else if (last?.status === "problems") items.push("The last check_motion found collisions: fix them (or tell the user plainly what still hits)")
    else if (last?.status === "incomplete")
      items.push(
        `The last check_motion was incomplete (${last.incomplete?.[0] ?? "some geometry wasn't checked"}): fix that and re-run it; until then don't say it moves without hitting anything`,
      )
  }

  // Several separate bodies in one part usually means print-in-place moving pieces (or an accident).
  for (const p of project.parts) {
    try {
      const rep = JSON.parse(readFileSync(join(root, ".studio", "checks", `${p.id}.json`), "utf8")) as CheckReport
      const bodies = rep.items?.find((i) => i.rule === "bodies")
      const n = Number(String(bodies?.measured ?? "").match(/\d+/)?.[0] ?? 1)
      if (n > 1 && !motions) items.push(`${p.id} prints as ${n} separate bodies: if they're meant to move (print-in-place), describe them as motions in assembly.json and run check_motion; if not, join them`)
    } catch {
      /* no report */
    }
  }

  const multi = project.parts.length > 1
  if (!asm && multi) {
    items.push("Several parts: if they go together, describe them in assembly.json (placements, steps); separate pieces on one plate need nothing")
  } else if (asm && asmStamp && needsGuide(project.parts.length, asm)) {
    const gv = guideValidityAt(root, project.parts, asmStamp)
    if (gv.state === "missing") items.push("The build guide + shopping list hasn't been made yet (build_assembly_guide)")
    else if (gv.state === "stale") items.push(`The build guide + shopping list is out of date: ${reasonLine(gv)} (build_assembly_guide)`)
  }

  if (t.planText) {
    const mentioned = hardwareMentioned(t.planText)
    const promisedNone = NO_HW.test(t.planText) && !mentioned.length
    if (promisedNone && hardware.length) {
      items.push(`The plan told the user no hardware, but the shopping list has: ${hardware.map((h) => h.purchaseHint || h.id).join(", ")}. Tell them, or design it out`)
    } else if (mentioned.length && !promisedNone && !hardware.length) {
      items.push(`The plan mentions ${mentioned.join(", ")}, but nothing is on the shopping list (add it to assembly.json hardware, or correct the plan)`)
    }
  } else if (project.parts.some((p) => existsSync(join(root, "build", `${p.id}.stl`)))) {
    items.push("You haven't shared what you assumed or decided for the user yet (share_plan)")
  }
  // 3. Sliced output: previewed since the last slice, quality warnings dealt with?
  for (const [g, sl] of t.slices) {
    if ((t.previewed.get(g) ?? 0) < sl.seq) items.push(`The sliced preview of ${g} hasn't been reviewed since the last slice (preview_slice: first and top layers; request_print needs it)`)
    for (const i of sl.issues.filter((x) => x.severity === "warn" || LOOK_ISSUES.has(x.code))) {
      items.push(`Quality warning (${g}): ${i.message}${i.fix ? ` Fix: ${i.fix}` : ""}`)
    }
  }

  // 4. Target machine: does it fit, are its colours loaded?
  items.push(...(await machineChecklist(projectId).catch(() => [])))
  return items
}

/**
 * Does this build go together (so it needs a picture guide)? Parts placed into one build, moving parts, or shared
 * hardware/supplies. Separate items, variants or test pieces sharing a plate don't, even with an assembly.json that
 * lists them or has steps.
 */
export function needsGuide(partCount: number, asm: Assembly | null): boolean {
  if (!asm) return false
  return (partCount > 1 && (asm.placements?.length ?? 0) > 0) || (asm.motions?.length ?? 0) > 0 || (asm.hardware?.length ?? 0) > 0 || (asm.consumables?.length ?? 0) > 0
}

export function formatChecklist(items: string[]): string {
  return items.length
    ? `Done checklist (open items; your call what matters before showing the user):\n${items.map((i) => `- ${i}`).join("\n")}`
    : "Done checklist: nothing open."
}

/**
 * Print boundary: a build that needs putting together (parts placed into one build, hardware or supplies in the plan
 * or shopping list, or moving parts) must have a current picture guide before it's sliced or printed. Current = built
 * from exactly the parts (files, includes, Customizer values), assembly.json and assembly.scad there are now
 * (server/projects/validity.ts). Returns a gentle refusal for the agent, or null.
 * Single-part, nothing-to-buy prints and separate pieces sharing a plate are unaffected.
 */
export async function guideRequired(projectId: string): Promise<string | null> {
  const root = deps.projectDir(projectId)
  const project = await deps.getProject(projectId)
  const asm = await deps
    .readAssembly(projectId)
    .then((r) => r.assembly)
    .catch(() => null)
  const plan = track(projectId).planText ?? ""
  const reasons: string[] = []
  // Several parts only need a guide when they go together: assembly.json places them into one build (placements).
  // Separate items, variants or test pieces sharing a plate don't, even if assembly.json lists them or has steps.
  if (project.parts.length > 1 && (asm?.placements?.length ?? 0) > 0) reasons.push("its parts go together")
  if ((asm?.hardware?.length ?? 0) > 0 || (asm?.consumables?.length ?? 0) > 0) reasons.push("it needs hardware or supplies")
  else if (hardwareMentioned(plan).length) reasons.push(`your plan mentions ${hardwareMentioned(plan).join(", ")}`)
  if ((asm?.motions?.length ?? 0) > 0) reasons.push("it has moving parts")
  if (!reasons.length) return null

  const gv = guideValidityAt(root, project.parts)
  if (gv.state === "fresh") return null
  return (
    `Almost there: ${reasons.join(" and ")}, so it needs its picture guide and shopping list before printing` +
    `${gv.state === "stale" ? ` (the current one is out of date: ${reasonLine(gv)})` : ""}. ` +
    "Update assembly.json (update_assembly: parts, placements, any hardware or supplies, steps), run build_assembly_guide, " +
    'mention it to the user in a sentence ("I made a step-by-step picture guide and a shopping list. See the Assembly tab."), then carry on.'
  )
}
