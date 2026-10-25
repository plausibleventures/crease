// Shopping list: hardware consolidated across the build, with pack suggestions and store search links.
import type { Assembly, AssemblyHardware, HardwareListing, SourcingSettings } from "../../shared/types"
import { hardwareName, hardwareSpec, isMakeYourself, makeInstruction } from "./hardware"
import { packSuggestion, searchTerm, storeLinks } from "./stores"

export interface ShoppingItem {
  ids: string[] // hardware ids merged into this line
  name: string
  type: AssemblyHardware["type"]
  spec: string[]
  need: number
  pack: string
  term: string
  links: { store: string; label: string; url: string; note?: string }[]
  listings: HardwareListing[]
  steps: number[] // steps that use it
  sample: AssemblyHardware // for drawings
}

export interface MakeItem {
  name: string
  instruction: string // "Cut 40 mm from your 1.75 mm filament."
  need: number
  steps: number[]
  sample: AssemblyHardware
}

export interface ShoppingList {
  items: ShoppingItem[] // hardware to buy (make-it-yourself items are in `make`)
  make: MakeItem[]
  consumables: { name: string; qty?: string; term: string; links: ShoppingItem["links"] }[]
  tools: { name: string }[]
}

// Items with the same buyable spec are one line, even if the design uses them under different ids.
export function specKey(h: AssemblyHardware): string {
  const ignore = new Set(["id", "qty", "notes", "name", "listings", "color", "substitutes", "fit"])
  return JSON.stringify(Object.entries(h).filter(([k]) => !ignore.has(k)).sort(([a], [b]) => a.localeCompare(b)))
}

export function buildShoppingList(a: Assembly, sourcing: SourcingSettings): ShoppingList {
  const byKey = new Map<string, ShoppingItem>()
  const make: MakeItem[] = []
  for (const h of a.hardware) {
    const key = specKey(h)
    const steps = a.steps.filter((s) => s.adds.some((x) => (typeof x === "string" ? x : x.id) === h.id)).map((s) => s.n)
    if (isMakeYourself(h)) {
      make.push({ name: hardwareName(h), instruction: makeInstruction(h), need: h.qty, steps, sample: h })
      continue
    }
    const cur = byKey.get(key)
    if (cur) {
      cur.ids.push(h.id)
      cur.need += h.qty
      cur.steps = [...new Set([...cur.steps, ...steps])].sort((x, y) => x - y)
      cur.listings.push(...(h.listings ?? []))
      continue
    }
    const term = searchTerm(h)
    byKey.set(key, {
      ids: [h.id],
      name: hardwareName(h),
      type: h.type,
      spec: hardwareSpec(h),
      need: h.qty,
      pack: "",
      term,
      links: storeLinks(h, term, sourcing),
      listings: [...(h.listings ?? [])],
      steps,
      sample: h,
    })
  }
  const items = [...byKey.values()].map((it) => ({ ...it, pack: packSuggestion(it.type, it.need) }))
  const consumables = a.consumables.map((c) => {
    const term = (c.purchaseHint ?? c.name).trim()
    return { name: c.name, qty: c.qty, term, links: storeLinks({ type: /glue|epoxy|\bca\b/i.test(c.name) ? "glue" : "other" }, term, sourcing) }
  })
  return { items, make, consumables, tools: a.tools.map((t) => ({ name: t.name })) }
}

const mdEsc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ")

export function shoppingMarkdown(title: string, list: ShoppingList): string {
  const out = [
    `# Shopping list: ${title}`,
    "",
    '"Search on …" links open a store search, not a specific product: check the listing matches the spec (size, standard, material) before buying. "Verified listing" links are product pages that were actually opened, with the date.',
    "",
  ]
  if (list.items.length) out.push("| Need | Item | Spec | Suggested pack | Search for | Where |", "|---|---|---|---|---|---|")
  for (const it of list.items) {
    const where = [
      ...it.links.map((l) => `[Search on ${l.label}](${l.url})`),
      ...it.listings.map((l) => `[Verified listing: ${l.store}: ${mdEsc(l.title)}${l.partNumber ? ` (${l.partNumber})` : ""}${l.price ? `, ${l.price}` : ""}, checked ${l.retrievedAt}](${l.url})`),
    ].join(" · ")
    out.push(`| ${it.need} | ${mdEsc(it.name)} | ${mdEsc([...it.spec, ...(it.sample.fit ? [it.sample.fit] : []), ...(it.sample.substitutes ?? []).map((s) => `also works: ${s.size}${s.note ? ` (${s.note})` : ""}`)].join(", "))} | ${mdEsc(it.pack)} | ${mdEsc(it.term)} | ${where} |`)
  }
  if (list.make.length) {
    out.push("", "## Make it yourself (nothing to buy)", "")
    for (const m of list.make) out.push(`- ${m.need}× ${m.name}: ${m.instruction}`)
  }
  if (list.consumables.length) {
    out.push("", "## Supplies", "")
    for (const c of list.consumables) out.push(`- ${c.name}${c.qty ? ` (${c.qty})` : ""}: ${c.links.map((l) => `[Search on ${l.label}](${l.url})`).join(" · ")}`)
  }
  if (list.tools.length) out.push("", "## Tools", "", ...list.tools.map((t) => `- ${t.name}`))
  return out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n"
}

const csvCell = (s: string | number) => {
  const v = String(s)
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

export function shoppingCsv(list: ShoppingList): string {
  const stores = [...new Map(list.items.flatMap((i) => i.links).map((l) => [l.store, l.label])).entries()]
  const header = ["need", "item", "spec", "suggested_pack", "search_term", ...stores.map(([, label]) => `search_${label}`), "verified_listings"]
  const rows = list.items.map((it) => [
    it.need,
    it.name,
    it.spec.join("; "),
    it.pack,
    it.term,
    ...stores.map(([id]) => it.links.find((l) => l.store === id)?.url ?? ""),
    it.listings.map((l) => `${l.store} ${l.partNumber ?? ""} ${l.price ?? ""} ${l.url} (${l.retrievedAt})`.replace(/\s+/g, " ")).join(" | "),
  ])
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n"
}
