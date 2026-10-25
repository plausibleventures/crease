// Practical bill of materials (R17): printed parts, hardware to buy, make-it-yourself items, consumables and tools,
// with "I already have this" (per project, .studio/bom.json) and a global "my parts bin" (<STUDIO_HOME>/parts-bin.json)
// that pre-ticks items the maker keeps around. Pack size vs need, substitutions and fit notes come from assembly.json
// (written by the agent from the design); the app never invents a substitute. Costs are rough: a verified listing's
// price when there is one, else a typical US price for a common pack, clearly labelled as an estimate.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type {
  Assembly,
  AssemblyHardware,
  BomItem,
  BomLink,
  HardwareListing,
  HardwareType,
  PartsBinItem,
  Project,
  ProjectBom,
  SourcingSettings,
} from "../../shared/types"
import { hardwareName, hardwareSpec, isMakeYourself, makeInstruction } from "./hardware"
import { lengthOf, threadOf } from "./schema"
import { specKey } from "./shopping"
import { searchTerm, storeLinks } from "./stores"

// ---------------------------------------------------------------------------------------------
// Keys: stable across projects and assembly edits (the buyable spec, not the id)
// ---------------------------------------------------------------------------------------------

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/×/g, "x")
    .replace(/\bmm\b/g, "")
    .replace(/[^a-z0-9.x]+/g, "")

/** Parts-bin key of a hardware item: what you'd look for in a drawer ("screw:m3x12:button"). */
export function hardwareKey(h: AssemblyHardware): string {
  const parts: string[] = [h.type]
  const d = threadOf(h)
  const l = lengthOf(h)
  if (h.magnet) parts.push(`${h.magnet.shape}${h.magnet.diaMm ?? `${h.magnet.lengthMm}x${h.magnet.widthMm}`}x${h.magnet.thicknessMm}`)
  else if (h.bearing) parts.push(norm(h.bearing.designation))
  else if (h.spring) parts.push(`${h.spring.kind}${h.spring.wireDiaMm}x${h.spring.outerDiaMm}x${h.spring.freeLengthMm}`)
  else if (d && ["screw", "bolt", "nut", "washer", "heat-set-insert", "threaded-insert", "standoff"].includes(h.type))
    parts.push(`m${d}${l && !["nut", "washer"].includes(h.type) ? `x${l}` : ""}`)
  else if (h.size) parts.push(norm(h.size))
  else parts.push(norm(h.purchaseHint ?? h.name ?? h.id))
  if (h.head) parts.push(h.head)
  return parts.join(":")
}

export const consumableKey = (name: string) => `consumable:${norm(name)}`
export const toolKey = (t: { type: string; size?: string; name: string }) => `tool:${t.type}:${norm(t.size ?? (t.type === "other" ? t.name : ""))}`

// ---------------------------------------------------------------------------------------------
// Packs and rough prices
// ---------------------------------------------------------------------------------------------

/** Typical pack as sold (pieces) and a rough US price for it (USD). null price = no useful estimate. */
const TYPICAL: Partial<Record<HardwareType, { size: number; usd: number | null }>> = {
  screw: { size: 100, usd: 9 },
  bolt: { size: 100, usd: 9 },
  nut: { size: 100, usd: 6 },
  washer: { size: 100, usd: 6 },
  "heat-set-insert": { size: 100, usd: 10 },
  "threaded-insert": { size: 50, usd: 10 },
  standoff: { size: 50, usd: 10 },
  "dowel-pin": { size: 50, usd: 9 },
  rod: { size: 1, usd: 8 },
  magnet: { size: 50, usd: 11 },
  spring: { size: 1, usd: 10 }, // usually an assortment box
  bearing: { size: 10, usd: 10 },
  "o-ring": { size: 1, usd: 10 }, // assortment
  "rubber-foot": { size: 50, usd: 7 },
  "wall-anchor": { size: 50, usd: 7 },
  "adhesive-strip": { size: 16, usd: 9 },
  "zip-tie": { size: 100, usd: 6 },
  glue: { size: 1, usd: 6 },
  tape: { size: 1, usd: 5 },
}
const ASSORTMENT: HardwareType[] = ["spring", "o-ring"]
const CONSUMABLE_USD: [RegExp, number][] = [
  [/\b(ca|super ?glue|cyanoacrylate)\b/i, 6],
  [/epoxy/i, 8],
  [/thread ?lock/i, 7],
  [/grease|lubricant|lube/i, 8],
  [/tape/i, 5],
  [/glue/i, 6],
]

const parseUsd = (price?: string): number | null => {
  const m = price?.match(/\$\s?(\d+(?:\.\d{1,2})?)/)
  return m ? Number(m[1]) : null
}

function packInfo(type: HardwareType, need: number, listings: HardwareListing[]): BomItem["pack"] {
  const l = listings.find((x) => x.packSize)
  if (l?.packSize) {
    const packs = Math.ceil(need / l.packSize)
    return {
      size: l.packSize,
      fromListing: true,
      text: `${packs > 1 ? `${packs} packs` : "This listing is a pack"} of ${l.packSize}: you need ${need}${packs === 1 && l.packSize > need ? ` (${l.packSize - need} spare)` : ""}`,
    }
  }
  const t = TYPICAL[type]
  if (!t) return undefined
  if (ASSORTMENT.includes(type)) return { size: null, fromListing: false, text: `Sold singly or as an assortment box: you need ${need}` }
  if (t.size === 1) return { size: 1, fromListing: false, text: `Sold singly: you need ${need}` }
  const packs = Math.ceil(need / t.size)
  return {
    size: t.size,
    fromListing: false,
    text: packs > 1 ? `Usually sold in packs of ~${t.size}: ${packs} packs for the ${need} you need` : `Usually sold in packs of ~${t.size}: you need ${need}`,
  }
}

function estimate(type: HardwareType, need: number, listings: HardwareListing[], usOk: boolean): BomItem["estCost"] {
  for (const l of listings) {
    const usd = parseUsd(l.price)
    if (usd == null) continue
    const packs = l.packSize ? Math.ceil(need / l.packSize) : 1
    return { usd: Math.round(usd * packs * 100) / 100, basis: "listing" }
  }
  const t = TYPICAL[type]
  if (!usOk || !t?.usd) return null
  const packs = ASSORTMENT.includes(type) ? 1 : Math.ceil(need / t.size)
  return { usd: t.usd * packs, basis: "typical" }
}

/** Plain dimensional notes for buyers; the agent's own `fit` note comes first. */
function fitNotes(h: AssemblyHardware): string[] {
  const out: string[] = []
  if (h.fit) out.push(h.fit)
  const d = threadOf(h)
  const l = lengthOf(h)
  if ((h.type === "screw" || h.type === "bolt") && d && l)
    out.push(`M${d} thread, ${l} mm long ${h.head === "countersunk" ? "overall (countersunk)" : "measured under the head"}; a different length only if the notes say it fits`)
  if (h.magnet) {
    const m = h.magnet
    const size = m.diaMm ? `${m.diaMm} mm across` : `${m.lengthMm} × ${m.widthMm} mm`
    out.push(`${size} × ${m.thicknessMm} mm thick: has to match the pocket; bigger won't fit, smaller rattles`)
  }
  if (h.bearing) out.push(`${h.bearing.designation}: ${h.bearing.boreMm} mm bore, ${h.bearing.outerDiaMm} mm outside, ${h.bearing.widthMm} mm wide`)
  return out
}

// ---------------------------------------------------------------------------------------------
// Persistence: per-project ticks and the global parts bin
// ---------------------------------------------------------------------------------------------

export const BOM_STATE_REL = join(".studio", "bom.json")

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T
  } catch {
    return fallback
  }
}
function writeJson(file: string, data: unknown) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file + ".tmp", JSON.stringify(data, null, 2) + "\n")
  renameSync(file + ".tmp", file)
}

/** key -> true ("I have it") / false ("I need to buy it", overriding the parts bin). */
export function readHave(projectRoot: string): Record<string, boolean> {
  const s = readJson<{ have?: Record<string, boolean> }>(join(projectRoot, BOM_STATE_REL), {})
  return s.have && typeof s.have === "object" ? s.have : {}
}

/** Set (true/false) or clear (null) the project's tick for one item. */
export function setHave(projectRoot: string, key: string, have: boolean | null) {
  const file = join(projectRoot, BOM_STATE_REL)
  const s = readJson<{ have?: Record<string, boolean> }>(file, {})
  const h = { ...(s.have ?? {}) }
  if (have === null) delete h[key]
  else h[key] = have
  writeJson(file, { ...s, have: h })
}

export function readBin(file: string): PartsBinItem[] {
  const s = readJson<{ items?: PartsBinItem[] }>(file, {})
  return Array.isArray(s.items) ? s.items.filter((i) => i && typeof i.key === "string") : []
}

export function setInBin(file: string, item: { key: string; name: string }, inBin: boolean): PartsBinItem[] {
  const items = readBin(file).filter((i) => i.key !== item.key)
  if (inBin) items.push({ key: item.key, name: item.name, addedAt: new Date().toISOString() })
  items.sort((a, b) => a.name.localeCompare(b.name))
  writeJson(file, { items })
  return items
}

// ---------------------------------------------------------------------------------------------
// The BOM
// ---------------------------------------------------------------------------------------------

function searchLinks(links: { store: string; label: string; url: string; note?: string }[]): BomLink[] {
  return links.map((l) => ({ kind: "search", store: l.store, label: `Search on ${l.label}`, url: l.url, ...(l.note ? { note: l.note } : {}) }))
}
function listingLinks(listings: HardwareListing[]): BomLink[] {
  return listings.map((l) => ({
    kind: "listing",
    store: l.store,
    label: `${l.store}: ${l.title}${l.partNumber ? ` (${l.partNumber})` : ""}`,
    url: l.url,
    checkedAt: l.retrievedAt,
    ...(l.price ? { price: l.price } : {}),
  }))
}

const stepsUsing = (a: Assembly, id: string) =>
  a.steps.filter((s) => s.adds.some((x) => (typeof x === "string" ? x : x.id) === id)).map((s) => s.n)

export interface BomInputs {
  project: Pick<Project, "name" | "parts">
  assembly: Assembly | null
  sourcing: SourcingSettings
  have: Record<string, boolean>
  bin: PartsBinItem[]
}

export function buildBom({ project, assembly: a, sourcing, have, bin }: BomInputs): ProjectBom {
  const binKeys = new Set(bin.map((b) => b.key))
  const usOk = sourcing.country === "US"
  const items: BomItem[] = []
  const used = new Set<string>()
  const push = (it: Omit<BomItem, "have" | "haveSource" | "inBin">, canBin = true) => {
    let key = it.key
    for (let i = 2; used.has(key); i++) key = `${it.key}#${i}`
    used.add(key)
    const inBin = canBin && binKeys.has(key)
    const explicit = have[key]
    items.push({
      ...it,
      key,
      inBin,
      have: explicit ?? inBin,
      haveSource: explicit !== undefined ? "project" : inBin ? "bin" : null,
    })
  }

  // Printed parts: from the assembly when there is one (names, colours), else the project's parts.
  const printed = a?.parts.length
    ? a.parts.map((p) => ({ id: p.id, name: p.name ?? p.id, qty: p.qty, color: p.color, steps: stepsUsing(a, p.id) }))
    : project.parts.map((p) => ({ id: p.id, name: p.id, qty: p.qty, color: p.colors[0], steps: [] as number[] }))
  for (const p of printed)
    push({ key: `printed:${p.id}`, category: "printed", name: p.name, spec: [], need: p.qty, steps: p.steps, ...(p.color ? { color: p.color } : {}), links: [] }, false)

  if (a) {
    // Hardware: identical buyable specs are one line (as in the shopping list).
    const lines = new Map<string, { h: AssemblyHardware; need: number; steps: Set<number>; listings: HardwareListing[] }>()
    for (const h of a.hardware) {
      const k = specKey(h)
      const cur = lines.get(k)
      if (cur) {
        cur.need += h.qty
        stepsUsing(a, h.id).forEach((n) => cur.steps.add(n))
        cur.listings.push(...(h.listings ?? []))
      } else lines.set(k, { h, need: h.qty, steps: new Set(stepsUsing(a, h.id)), listings: [...(h.listings ?? [])] })
    }
    for (const { h, need, steps, listings } of lines.values()) {
      const base = { name: hardwareName(h), spec: hardwareSpec(h), need, steps: [...steps].sort((x, y) => x - y) }
      if (isMakeYourself(h)) {
        push({ ...base, key: `make:${hardwareKey(h)}`, category: "make", note: makeInstruction({ ...h, qty: need }), links: [] }, false)
        continue
      }
      const term = searchTerm(h)
      push({
        ...base,
        key: hardwareKey(h),
        category: "purchased",
        pack: packInfo(h.type, need, listings),
        ...(h.substitutes?.length ? { substitutes: h.substitutes } : {}),
        ...(fitNotes(h).length ? { fit: fitNotes(h) } : {}),
        searchTerm: term,
        links: [...listingLinks(listings), ...searchLinks(storeLinks(h, term, sourcing))],
        estCost: estimate(h.type, need, listings, usOk),
        ...(h.notes ? { note: h.notes } : {}),
      })
    }
    for (const c of a.consumables) {
      const term = (c.purchaseHint ?? c.name).trim()
      const type: HardwareType = /glue|epoxy|\bca\b/i.test(c.name) ? "glue" : /tape/i.test(c.name) ? "tape" : "other"
      const usd = usOk ? (CONSUMABLE_USD.find(([re]) => re.test(`${c.name} ${c.purchaseHint ?? ""}`))?.[1] ?? null) : null
      push({
        key: consumableKey(c.name),
        category: "consumable",
        name: c.name,
        spec: [],
        need: null,
        ...(c.qty ? { needText: c.qty } : {}),
        steps: stepsUsing(a, c.id),
        searchTerm: term,
        links: searchLinks(storeLinks({ type }, term, sourcing)),
        estCost: usd != null ? { usd, basis: "typical" } : null,
        ...(c.notes ? { note: c.notes } : {}),
      })
    }
    for (const t of a.tools)
      push({
        key: toolKey(t),
        category: "tool",
        name: t.name,
        spec: t.size ? [t.size] : [],
        need: null,
        steps: a.steps.filter((s) => s.tools?.includes(t.id)).map((s) => s.n),
        links: [],
        ...(t.notes ? { note: t.notes } : {}),
      })
  }

  const buyable = items.filter((i) => i.category === "purchased" || i.category === "consumable")
  const toBuy = buyable.filter((i) => !i.have)
  const priced = toBuy.filter((i) => i.estCost)
  const est = priced.reduce((n, i) => n + (i.estCost?.usd ?? 0), 0)
  return {
    items,
    region: sourcing.country,
    totals: {
      toBuy: toBuy.length,
      have: buyable.length - toBuy.length,
      estUsd: priced.length ? Math.round(est * 100) / 100 : null,
      estimated: priced.length,
      unpriced: toBuy.length - priced.length,
    },
    priceNote: usOk
      ? "Rough US prices for one common pack (or the verified listing's price); stores vary. Tools aren't counted."
      : null,
  }
}

export function binFile(studioHome: string) {
  return join(studioHome, "parts-bin.json")
}
