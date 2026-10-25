// Store registry for hardware search links, and pack-size suggestions for the shopping list.
// Links are plain search URLs built from the item's search term: no scraping, no part numbers, no prices.
import type { AssemblyHardware, HardwareType, SourcingSettings, StoreId } from "../../shared/types"
import { hardwareName } from "./hardware"

export interface StoreDef {
  id: StoreId
  label: string
  countries: string[] // ISO 3166 alpha-2; "*" = ships worldwide
  search: (q: string) => string
  suits: HardwareType[] | "all"
  note?: string
  /** false when the URL format could not be checked automatically (site blocks bots). */
  verified: boolean
}

// encodeURIComponent leaves ( ) ' ! * alone; encode them too so links survive Markdown and CSV.
const enc = (q: string) => encodeURIComponent(q).replace(/[()'!*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
const slug = (q: string) => q.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "")
const FASTENERS: HardwareType[] = ["screw", "bolt", "nut", "washer", "heat-set-insert", "threaded-insert", "standoff", "rod", "dowel-pin"]

export const STORES: StoreDef[] = [
  { id: "amazon-us", label: "Amazon", countries: ["US"], search: (q) => `https://www.amazon.com/s?k=${enc(q)}`, suits: "all", verified: true },
  { id: "amazon-ca", label: "Amazon.ca", countries: ["CA"], search: (q) => `https://www.amazon.ca/s?k=${enc(q)}`, suits: "all", verified: true },
  { id: "amazon-uk", label: "Amazon UK", countries: ["GB"], search: (q) => `https://www.amazon.co.uk/s?k=${enc(q)}`, suits: "all", verified: true },
  { id: "amazon-de", label: "Amazon.de", countries: ["DE", "AT"], search: (q) => `https://www.amazon.de/s?k=${enc(q)}`, suits: "all", verified: true },
  { id: "amazon-in", label: "Amazon.in", countries: ["IN"], search: (q) => `https://www.amazon.in/s?k=${enc(q)}`, suits: "all", verified: true },
  {
    id: "aliexpress",
    label: "AliExpress",
    countries: ["*"],
    search: (q) => `https://www.aliexpress.com/wholesale?SearchText=${enc(q)}`,
    suits: "all",
    note: "cheapest, slow shipping",
    verified: true,
  },
  {
    id: "boltdepot",
    label: "Bolt Depot",
    countries: ["US"],
    search: (q) => `https://www.boltdepot.com/Search?keywords=${enc(q)}`,
    suits: FASTENERS,
    note: "cheap US fasteners, sold by the piece",
    verified: false,
  },
  {
    id: "mcmaster",
    label: "McMaster-Carr",
    countries: ["*"],
    search: (q) => `https://www.mcmaster.com/products/${slug(q)}/`,
    suits: "all",
    note: "reliable, exact specs, pricier",
    verified: true,
  },
]

export const DEFAULT_SOURCING: SourcingSettings = { country: "US", stores: ["amazon-us", "aliexpress", "boltdepot", "mcmaster"] }

/** The search term for an item: its purchaseHint, else its generated name. */
export function searchTerm(h: AssemblyHardware): string {
  return (h.purchaseHint ?? hardwareName(h)).trim()
}

/** Search links for an item, in the configured store order, filtered to stores that sell its type. */
export function storeLinks(h: Pick<AssemblyHardware, "type"> & Partial<AssemblyHardware>, term: string, sourcing: SourcingSettings = DEFAULT_SOURCING) {
  if (h.type === "filament-offcut") return [] // made from the user's own filament: nothing to buy
  return sourcing.stores
    .map((id) => STORES.find((s) => s.id === id))
    .filter((s): s is StoreDef => !!s && (s.countries.includes("*") || s.countries.includes(sourcing.country)))
    .filter((s) => s.suits === "all" || s.suits.includes(h.type))
    .map((s) => ({ store: s.id, label: s.label, url: s.search(term), note: s.note }))
}

/** A sensible pack to buy for `need` pieces (as sold in shops, with spares for small fasteners). */
export function packSuggestion(type: HardwareType, need: number): string {
  switch (type) {
    case "screw":
    case "bolt":
    case "nut":
    case "washer":
    case "heat-set-insert":
    case "threaded-insert":
      if (need <= 20) return "pack of 50–100 (or an assortment kit)"
      if (need <= 80) return "pack of 100"
      return `${Math.ceil(need / 100) * 100} (packs of 100)`
    case "standoff":
    case "dowel-pin":
    case "rubber-foot":
    case "zip-tie":
      return need <= 10 ? "pack of 10–50" : `pack of ${need <= 40 ? 50 : 100}+`
    case "magnet":
      return need <= 10 ? "pack of 10–20 (sold in packs)" : `pack of ${Math.ceil(need / 10) * 10}+`
    case "spring":
      return "as sold: singles or an assortment box; get 1–2 spares"
    case "bearing":
      return need <= 4 ? "pack of 4–10 (singles from McMaster)" : `pack of ${need <= 10 ? 10 : need}`
    case "filament-offcut":
      return "cut from your spool"
    case "wall-anchor":
      return need <= 10 ? "pack of 10–50 (often sold with screws)" : "pack of 50–100"
    case "adhesive-strip":
      return need <= 8 ? "pack of 8–16" : `pack of ${Math.ceil(need / 8) * 8}+`
    case "o-ring":
      return "pack of 10+ or an O-ring assortment"
    case "rod":
      return need === 1 ? "1 (cut to length if needed)" : `${need}`
    default:
      return `${need}`
  }
}
