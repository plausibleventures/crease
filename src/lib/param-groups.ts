// The Parameters panel's groups: settings grouped by their Customizer section ("/* [Pot] */"), with the part each
// section is about, so the selected part's settings come first and another part's settings say whose they are.

import type { ScadParameter } from "@shared/types"

export interface ParamGroup {
  title: string
  ps: ScadParameter[]
  /** shared files (lib/*.scad) its settings come from */
  files: string[]
  /** parts the title names ("Pot" -> the pot); empty for general groups ("Fit between parts") */
  partIds: string[]
  /** "mine": about the selected part · "general": about no part in particular · "other": about another part */
  about: "mine" | "general" | "other"
  /** every setting in it is shared by these same parts (one value for all of them); null otherwise */
  sharedWith: string[] | null
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w))

/** Parts a group title names: every word of the part's name (or id) is in the title. */
export function partsNamed(title: string, parts: { id: string; name?: string }[]): string[] {
  const t = new Set(words(title))
  return parts
    .filter((p) => {
      const names = [p.name, p.id].filter((x): x is string => !!x).map(words)
      return names.some((w) => w.length > 0 && w.every((x) => t.has(x)))
    })
    .map((p) => p.id)
}

/** Group a part's settings by section title (its own and its shared files' together), the selected part's first. */
export function groupParams(params: ScadParameter[], parts: { id: string; name?: string }[], selected: string | null): ParamGroup[] {
  const byTitle = new Map<string, ParamGroup>()
  for (const p of params) {
    const title = p.group?.trim() || (p.file ? "Shared settings" : "Settings")
    let g = byTitle.get(title)
    if (!g) {
      const partIds = partsNamed(title, parts)
      const about = partIds.length === 0 ? "general" : selected && partIds.includes(selected) ? "mine" : "other"
      g = { title, ps: [], files: [], partIds, about, sharedWith: null }
      byTitle.set(title, g)
    }
    g.ps.push(p)
    if (p.file && !g.files.includes(p.file)) g.files.push(p.file)
  }
  for (const g of byTitle.values()) {
    const sets = new Set(g.ps.map((p) => (p.sharedWith?.length ? p.sharedWith.join("\0") : "")))
    const [only] = sets
    g.sharedWith = sets.size === 1 && only ? only.split("\0") : null
  }
  const rank = { mine: 0, general: 1, other: 2 } as const
  // stable: within a rank, the order the file declares them
  return [...byTitle.values()].map((g, i) => ({ g, i })).sort((a, b) => rank[a.g.about] - rank[b.g.about] || a.i - b.i).map((x) => x.g)
}

/** A part's name inside a sentence: "Saucer" -> "saucer", but "LED strip" stays. */
const inSentence = (name: string) => (/^[A-Z][a-z]/.test(name) ? name[0].toLowerCase() + name.slice(1) : name)
const capital = (name: string) => name.charAt(0).toUpperCase() + name.slice(1)

/** The parts a shared setting changes, in a few words: "Pot and saucer", "Pot, saucer and lid", "All 5 parts". */
export function sharedLabel(ids: string[], parts: { id: string; name?: string }[]): string {
  const names = ids.map((id) => parts.find((p) => p.id === id)?.name ?? id)
  if (names.length > 3 && names.length === parts.length) return `All ${names.length} parts`
  if (names.length > 3) return `${capital(names[0])}, ${inSentence(names[1])} and ${names.length - 2} more`
  const rest = names.slice(1).map(inSentence)
  if (!rest.length) return capital(names[0] ?? "")
  return `${[capital(names[0]), ...rest.slice(0, -1)].join(", ")} and ${rest[rest.length - 1]}`
}

/** "Pot height (mm)" -> { text: "Pot height", unit: "mm" }. Only short trailing units; "in mm" counts too. */
export function splitUnit(label: string): { text: string; unit: string | null } {
  const m = label.match(/^(.*?)\s*\(\s*(mm|in|cm|°|deg|degrees|%|g|s|min)\s*\)\s*$/i)
  if (m && m[1]) return { text: m[1], unit: m[2] === "degrees" || m[2] === "deg" ? "°" : m[2] }
  const n = label.match(/^(.*?)\s+in (mm|inches)\s*$/i)
  if (n && n[1]) return { text: n[1], unit: n[2] === "inches" ? "in" : "mm" }
  return { text: label, unit: null }
}
