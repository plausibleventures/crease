// zod schema for assembly.json (mirrors the Assembly types in shared/types.ts) + semantic validation.
import { z } from "zod"
import type { Assembly, AssemblyHardware, AssemblyStepItem } from "../../shared/types"

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "ids use letters, digits, - and _")
const pos = z.number().positive()
const vec3 = z.tuple([z.number(), z.number(), z.number()])

export const HARDWARE_TYPES = [
  "screw", "bolt", "nut", "washer", "heat-set-insert", "threaded-insert", "magnet", "spring", "bearing",
  "rod", "dowel-pin", "standoff", "o-ring", "rubber-foot", "wall-anchor", "filament-offcut", "adhesive-strip", "zip-tie", "glue", "tape", "electronics", "other",
] as const
export const TOOL_TYPES = [
  "hex-key", "screwdriver", "soldering-iron", "pliers", "wrench", "knife", "file", "clamp", "drill", "tweezers", "other",
] as const

export const springSchema = z.object({
  kind: z.enum(["compression", "extension", "torsion"]),
  wireDiaMm: pos,
  outerDiaMm: pos,
  freeLengthMm: pos,
  rateNPerMm: pos.optional(),
  solidLengthMm: pos.optional(),
  material: z.string().optional(),
})

export const bearingSchema = z.object({
  designation: z.string(),
  boreMm: pos,
  outerDiaMm: pos,
  widthMm: pos,
  seal: z.string().optional(),
})

export const magnetSchema = z.object({
  shape: z.enum(["disc", "block", "ring"]),
  diaMm: pos.optional(),
  lengthMm: pos.optional(),
  widthMm: pos.optional(),
  thicknessMm: pos,
  grade: z.string().optional(),
})

export const hardwareSchema = z.object({
  id,
  type: z.enum(HARDWARE_TYPES),
  qty: z.number().int().positive(),
  name: z.string().optional(),
  standard: z.string().optional().describe("e.g. ISO 7380, DIN 912, ISO 4762, ISO 4032, ISO 7089"),
  size: z.string().optional().describe("e.g. M3x10, M3, 608"),
  threadMm: pos.optional(),
  lengthMm: pos.optional(),
  head: z.enum(["socket", "button", "countersunk", "pan", "hex", "flange", "cheese", "grub"]).optional(),
  drive: z.enum(["hex", "torx", "phillips", "pozidriv", "slot", "none"]).optional(),
  material: z.string().optional(),
  purchaseHint: z.string().optional().describe("generic search term"),
  notes: z.string().optional(),
  color: z.string().optional(),
  spring: springSchema.optional(),
  bearing: bearingSchema.optional(),
  magnet: magnetSchema.optional(),
  listings: z
    .array(
      z.object({
        store: z.string(),
        title: z.string(),
        url: z.string().regex(/^https:\/\//, "listing url must be https"),
        partNumber: z.string().optional(),
        price: z.string().optional(),
        packSize: z.number().int().positive().optional(),
        retrievedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "retrievedAt is YYYY-MM-DD"),
      }),
    )
    .optional()
    .describe("Only listings you actually opened (on request); never invented"),
  substitutes: z
    .array(z.object({ size: z.string().min(1), purchaseHint: z.string().optional(), note: z.string().optional() }))
    .optional()
    .describe("Other sizes that also fit, only when the design allows (e.g. M3x10 for M3x12 when the hole is deep enough)"),
  fit: z.string().optional().describe("Dimensional compatibility note for buyers (hole/pocket size, what else fits)"),
})

export const toolSchema = z.object({
  id,
  type: z.enum(TOOL_TYPES),
  name: z.string(),
  size: z.string().optional(),
  notes: z.string().optional(),
})

export const consumableSchema = z.object({
  id,
  name: z.string(),
  qty: z.string().optional(),
  purchaseHint: z.string().optional(),
  notes: z.string().optional(),
})

export const partSchema = z.object({
  id,
  qty: z.number().int().positive(),
  color: z.string(),
  name: z.string().optional(),
  notes: z.string().optional(),
})

export const STEP_ACTIONS = ["place", "insert", "slide", "push", "snap", "twist", "screw"] as const
const PART_REF = /^[A-Za-z0-9][A-Za-z0-9_-]*(#\d+)?$/
export const glueSchema = z.object({
  kind: z.enum(["glue", "no-glue"]),
  at: vec3,
  size: z.tuple([z.number().nonnegative(), z.number().nonnegative(), z.number().nonnegative()]),
  part: z.string().regex(PART_REF, 'part/hardware id or "id#instance"').optional(),
  label: z.string().optional(),
})

export const stepSchema = z.object({
  n: z.number().int().positive(),
  title: z.string().min(1),
  adds: z.array(z.union([id, z.object({ id, qty: z.number().int().positive() })])),
  explodeDirection: vec3.optional(),
  explodeDistance: z.number().nonnegative().optional(),
  view: vec3.optional().describe("camera rotation [rx, ry, rz]; default [55, 0, 25]"),
  text: z.string().min(1),
  warnings: z.array(z.string()).optional(),
  tips: z.array(z.string()).optional(),
  tools: z.array(id).optional(),
  check: z.string().optional().describe('"You got it right when…": what the builder sees or feels when this step is right'),
  showMotion: z.string().optional().describe("motion id to demonstrate at the end of this step"),
  // R14 illustrations
  action: z.enum(STEP_ACTIONS).optional().describe("what the hands do, drawn as the arrow type"),
  insert: vec3.optional().describe("direction the new items travel to go in (assembled coordinates)"),
  glue: z.array(glueSchema).optional().describe("where glue goes / must not go (hatched in the picture)"),
  closeUp: z.union([z.boolean(), z.object({ at: vec3, size: pos.optional() })]).optional().describe("close-up inset of the joint"),
  focus: z.array(z.string().regex(PART_REF, 'part id or "part#instance"')).optional().describe("parts the step acts on when it adds nothing new"),
})

export const placementSchema = z.object({
  part: id,
  instance: z.number().int().nonnegative().optional(),
  translate: vec3,
  rotate: vec3.optional(),
})

export const hardwarePlacementSchema = z.object({
  hardware: id,
  instance: z.number().int().nonnegative().optional(),
  translate: vec3,
  rotate: vec3.optional(),
  movesWith: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*(#\d+)?$/, 'part id or "part#instance"').optional(),
})

// Motion ids become OpenSCAD variables (motion_<id>), so no hyphens.
export const motionSchema = z.object({
  id: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "motion ids use letters, digits and _ (they become OpenSCAD variables)"),
  label: z.string().min(1),
  type: z.enum(["rotate", "translate"]),
  parts: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*(#\d+)?$/, 'part id or "part#instance"')).min(1),
  axis: vec3,
  origin: vec3.optional(),
  range: z.tuple([z.number(), z.number()]),
  rest: z.number().optional(),
  continuous: z.boolean().optional(),
  check: z.string().optional(),
})

export const assemblySchema = z.object({
  title: z.string().optional(),
  summary: z.string().optional(),
  timeMinutes: z.number().positive().optional(),
  parts: z.array(partSchema),
  hardware: z.array(hardwareSchema).default([]),
  tools: z.array(toolSchema).default([]),
  consumables: z.array(consumableSchema).default([]),
  steps: z.array(stepSchema).min(1),
  placements: z.array(placementSchema).optional(),
  motions: z.array(motionSchema).optional(),
  hardwarePlacements: z.array(hardwarePlacementSchema).optional(),
})

// Compile-time check that the zod output matches the shared contract.
type Parsed = z.output<typeof assemblySchema>
const _check: (a: Parsed) => Assembly = (a) => a
void _check

export interface ValidationResult {
  assembly: Assembly
  errors: string[] // must be fixed; the file is not written
  warnings: string[] // written anyway, reported to the agent
}

/** Schema + cross-reference validation. `knownPartIds` = the project's parts (null to skip that check). */
export function validateAssembly(input: unknown, knownPartIds: string[] | null): ValidationResult {
  const parsed = assemblySchema.safeParse(input)
  if (!parsed.success) {
    return {
      assembly: input as Assembly,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      warnings: [],
    }
  }
  const a = parsed.data as Assembly
  const errors: string[] = []
  const warnings: string[] = []

  const kinds = new Map<string, string>()
  const addId = (i: string, kind: string) => {
    if (kinds.has(i)) errors.push(`duplicate id "${i}" (${kinds.get(i)} and ${kind})`)
    else kinds.set(i, kind)
  }
  a.parts.forEach((p) => addId(p.id, "part"))
  a.hardware.forEach((h) => addId(h.id, "hardware"))
  a.consumables.forEach((c) => addId(c.id, "consumable"))
  const toolIds = new Set(a.tools.map((t) => t.id))

  if (knownPartIds) {
    for (const p of a.parts) {
      if (!knownPartIds.includes(p.id)) errors.push(`parts: "${p.id}" is not a project part (known: ${knownPartIds.join(", ")})`)
    }
  }

  a.steps.forEach((s, i) => {
    if (s.n !== i + 1) errors.push(`steps[${i}].n is ${s.n}; steps must be numbered 1..N in order`)
    if (s.explodeDirection && s.explodeDirection.every((v) => v === 0)) errors.push(`step ${s.n}: explodeDirection is zero`)
    if (s.insert && s.insert.every((v) => v === 0)) errors.push(`step ${s.n}: insert is zero`)
    for (const t of s.tools ?? []) if (!toolIds.has(t)) errors.push(`step ${s.n}: unknown tool "${t}"`)
    const sentences = s.text.split(/[.!?](\s|$)/).filter((x) => x && x.trim()).length
    if (sentences > 2 || s.text.length > 220) warnings.push(`step ${s.n}: keep text to 1-2 short sentences (pictures carry the meaning)`)
  })

  // How many of each item each step adds; bare ids mean "all of it" (only valid if one step adds it).
  const stepsAdding = new Map<string, number>()
  for (const s of a.steps) for (const x of s.adds) {
    const xid = typeof x === "string" ? x : x.id
    stepsAdding.set(xid, (stepsAdding.get(xid) ?? 0) + 1)
  }
  const totals = new Map<string, number>()
  for (const s of a.steps) {
    for (const x of s.adds) {
      const xid = typeof x === "string" ? x : x.id
      if (!kinds.has(xid)) {
        errors.push(`step ${s.n}: adds unknown id "${xid}" (not in parts, hardware or consumables)`)
        continue
      }
      if (typeof x === "string" && (stepsAdding.get(xid) ?? 0) > 1 && kinds.get(xid) !== "consumable") {
        errors.push(`step ${s.n}: "${xid}" is added in several steps, so give a qty: {"id": "${xid}", "qty": N}`)
      }
      totals.set(xid, (totals.get(xid) ?? 0) + stepQty(a, x))
    }
  }
  for (const p of [...a.parts, ...a.hardware]) {
    const used = totals.get(p.id) ?? 0
    if (used === 0) warnings.push(`"${p.id}" is never added in any step`)
    else if (used !== p.qty) warnings.push(`"${p.id}": qty is ${p.qty} but steps add ${used}`)
  }
  // Placements: where each part instance sits once assembled.
  const placements = a.placements ?? []
  const seenInst = new Set<string>()
  for (const pl of placements) {
    const part = a.parts.find((p) => p.id === pl.part)
    if (!part) {
      errors.push(`placements: unknown part "${pl.part}"`)
      continue
    }
    const inst = pl.instance ?? 0
    if (inst >= part.qty) errors.push(`placements: "${pl.part}" instance ${inst} but qty is ${part.qty} (instances are 0-based)`)
    const key = `${pl.part}#${inst}`
    if (seenInst.has(key)) errors.push(`placements: "${key}" is placed twice`)
    seenInst.add(key)
  }
  if (!placements.length) warnings.push("add placements (where each part sits when built) so the 3D assembly view and check_motion work")
  else {
    for (const p of a.parts) {
      for (let i = 0; i < p.qty; i++) if (!seenInst.has(`${p.id}#${i}`)) warnings.push(`placements: "${p.id}${p.qty > 1 ? `#${i}` : ""}" has no placement`)
    }
  }
  // Hardware placements: optional, so check_motion can include bought hardware as simple shapes.
  const seenHw = new Set<string>()
  for (const hp of a.hardwarePlacements ?? []) {
    const h = a.hardware.find((x) => x.id === hp.hardware)
    if (!h) {
      errors.push(`hardwarePlacements: unknown hardware "${hp.hardware}"`)
      continue
    }
    const inst = hp.instance ?? 0
    if (inst >= h.qty) errors.push(`hardwarePlacements: "${hp.hardware}" instance ${inst} but qty is ${h.qty} (instances are 0-based)`)
    const key = `${hp.hardware}#${inst}`
    if (seenHw.has(key)) errors.push(`hardwarePlacements: "${key}" is placed twice`)
    seenHw.add(key)
    if (hp.movesWith) {
      const [pid, pi] = hp.movesWith.split("#")
      const part = a.parts.find((p) => p.id === pid)
      if (!part) errors.push(`hardwarePlacements: "${key}" movesWith unknown part "${pid}"`)
      else if (pi !== undefined && Number(pi) >= part.qty) errors.push(`hardwarePlacements: "${key}" movesWith "${hp.movesWith}" but qty is ${part.qty}`)
    }
  }
  // Motions: everything that moves once built.
  const motionIds = new Set<string>()
  for (const m of a.motions ?? []) {
    if (motionIds.has(m.id)) errors.push(`motions: duplicate id "${m.id}"`)
    motionIds.add(m.id)
    for (const ref of m.parts) {
      const [pid, inst] = ref.split("#")
      const part = a.parts.find((p) => p.id === pid)
      if (!part) errors.push(`motion "${m.id}": unknown part "${pid}"`)
      else if (inst !== undefined && Number(inst) >= part.qty) errors.push(`motion "${m.id}": "${ref}" but qty is ${part.qty}`)
    }
    if (m.axis.every((v) => v === 0)) errors.push(`motion "${m.id}": axis is zero`)
    if (!(m.range[1] > m.range[0])) errors.push(`motion "${m.id}": range must be [min, max] with max > min`)
    if (m.rest !== undefined && (m.rest < m.range[0] || m.rest > m.range[1])) errors.push(`motion "${m.id}": rest ${m.rest} is outside range`)
    if (m.type === "rotate" && !m.origin) warnings.push(`motion "${m.id}": rotate without origin pivots about [0,0,0]; give the hinge point`)
    if (!m.check) warnings.push(`motion "${m.id}": add a check ("Swings open to about 110° without rubbing")`)
  }
  for (const s of a.steps) {
    if (!s.check) warnings.push(`step ${s.n}: add a check ("You got it right when…")`)
    if (s.showMotion && !motionIds.has(s.showMotion)) errors.push(`step ${s.n}: showMotion "${s.showMotion}" is not a motion id`)
  }
  // Steps must show what they use: an item mentioned in the text before any step adds it is probably missing from adds.
  const addedBy = (id: string) => a.steps.find((s) => s.adds.some((x) => (typeof x === "string" ? x : x.id) === id))?.n ?? Infinity
  for (const s of a.steps) {
    if (!s.adds.length && !s.showMotion && !s.focus?.length) warnings.push(`step ${s.n}: adds nothing and shows no motion; add the items it uses to adds, or merge it into another step`)
    const said = `${s.title} ${s.text}`.toLowerCase()
    for (const item of [...a.hardware, ...a.consumables]) {
      if (addedBy(item.id) <= s.n) continue
      const words = mentionWords(item)
      const hit = words.find((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(e?s)?\\b`).test(said))
      if (hit) warnings.push(`step ${s.n}: text mentions "${hit}" but "${item.id}" is not added yet; if this step uses it, list it in adds`)
    }
  }
  // R14: glue regions and focus refs point at real part / hardware instances.
  const refProblem = (ref: string) => {
    const [rid, ri] = ref.split("#")
    const item = a.parts.find((p) => p.id === rid) ?? a.hardware.find((h) => h.id === rid)
    if (!item) return `unknown part or hardware "${rid}"`
    if (ri !== undefined && Number(ri) >= item.qty) return `"${ref}" but qty is ${item.qty} (instances are 0-based)`
    return null
  }
  for (const s of a.steps) {
    for (const g of s.glue ?? []) {
      const e = g.part ? refProblem(g.part) : null
      if (e) errors.push(`step ${s.n}: glue region: ${e}`)
      if (g.size.every((v) => v === 0)) errors.push(`step ${s.n}: glue region size is zero`)
    }
    for (const f of s.focus ?? []) {
      const e = refProblem(f)
      if (e) errors.push(`step ${s.n}: focus: ${e}`)
    }
  }
  if (a.steps.length > 8) warnings.push(`${a.steps.length} steps: group small actions so the build has at most ~8 steps`)

  for (const h of a.hardware) {
    if (h.type === "spring" && !h.spring) warnings.push(`hardware "${h.id}": springs need a spring spec (wireDiaMm, outerDiaMm, freeLengthMm, rate if known)`)
    if (h.type === "bearing" && !h.bearing) warnings.push(`hardware "${h.id}": bearings need a bearing spec (designation, bore, OD, width)`)
    if (["screw", "bolt", "nut", "washer", "heat-set-insert", "threaded-insert", "standoff"].includes(h.type) && threadOf(h) == null) {
      warnings.push(`hardware "${h.id}": give size like "M3x10" (or threadMm) so it can be drawn at real size`)
    }
    if (h.type === "filament-offcut") {
      if (lengthOf(h) == null && !/x\s*\d/i.test(h.size ?? "")) warnings.push(`hardware "${h.id}": give size "1.75x40" (filament diameter x length to cut)`)
    } else if (!h.purchaseHint) warnings.push(`hardware "${h.id}": add a purchaseHint (generic search term)`)
  }
  return { assembly: a, errors, warnings }
}

const TYPE_WORDS: Partial<Record<string, string[]>> = {
  screw: ["screw"], bolt: ["bolt"], nut: ["nut"], washer: ["washer"], "heat-set-insert": ["insert"], "threaded-insert": ["insert"],
  magnet: ["magnet"], spring: ["spring"], bearing: ["bearing"], rod: ["rod"], "dowel-pin": ["pin", "dowel"], standoff: ["standoff"],
  "o-ring": ["o-ring"], "rubber-foot": ["foot", "feet", "bumper"], "wall-anchor": ["anchor", "wall plug"], "adhesive-strip": ["strip"],
  "filament-offcut": ["filament", "pin"], "zip-tie": ["zip tie", "cable tie"], glue: ["glue"], tape: ["tape"],
}
function mentionWords(item: { id: string; type?: string; name: string } | { id: string; type: string; name?: string }): string[] {
  const words = new Set<string>([item.id.toLowerCase().replace(/[-_]+/g, " ")])
  for (const w of TYPE_WORDS[item.type ?? ""] ?? []) words.add(w)
  if (!item.type) for (const w of ["glue", "superglue", "epoxy", "grease", "threadlocker", "tape"]) if (item.name?.toLowerCase().includes(w)) words.add(w)
  return [...words].filter((w) => w.length > 2)
}

/** Quantity of an `adds` entry: explicit qty, else the item's full qty. */
export function stepQty(a: Assembly, x: string | AssemblyStepItem): number {
  if (typeof x !== "string") return x.qty
  return a.parts.find((p) => p.id === x)?.qty ?? a.hardware.find((h) => h.id === x)?.qty ?? 1
}

/** Nominal thread diameter: threadMm, else parsed from size ("M3x10" -> 3, "M2.5" -> 2.5). */
export function threadOf(h: Pick<AssemblyHardware, "threadMm" | "size">): number | null {
  if (h.threadMm) return h.threadMm
  const m = h.size?.match(/M\s*(\d+(?:\.\d+)?)/i)
  return m ? Number(m[1]) : null
}

/** Length: lengthMm, else parsed from size ("M3x10" -> 10). */
export function lengthOf(h: Pick<AssemblyHardware, "lengthMm" | "size">): number | null {
  if (h.lengthMm) return h.lengthMm
  const m = h.size?.match(/[x×]\s*(\d+(?:\.\d+)?)/i)
  return m ? Number(m[1]) : null
}
