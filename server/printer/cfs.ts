// Creality CFS (filament system) as Moonraker exposes it in the `box` object, e.g. on the SPARKX i7:
//   box.T1 = { state: "connect", color_value: ["0FFFFFF", "0000000", ...], material_type: ["001001", ...],
//              vender: [...], remain_len: [...], filament_detected, ... }      (slots A–D of unit T1)
//   box.same_material = [["001001", "0FFFFFF", ["T1A"], "PLA"], ...]           (code, colour, slots, material name)
// color_value is a leading digit + RRGGBB; "none" = not set on the printer. material_type is Creality's material
// code; "none" = not set. Units T1..T4 map to machine slots 1-4, 5-8, ...
import { readFileSync, statSync } from "node:fs"
import type { FilamentSlot } from "../../shared/types"
import { colorDistance } from "../slicer/colors"

type Obj = Record<string, unknown>

// Creality material ids. The CFS reports `material_type` as a 6-digit code = "0" + the 5-digit `filament_id` of
// Creality's filament database, which OrcaSlicer ships in its Creality filament profiles
// (/Applications/OrcaSlicer.app/Contents/Resources/profiles/Creality/filament/*.json, 2.4.2). Creality Print writes
// the same 5-digit id into the G-code footer (`filament_ids`). Only 001001 ↔ 01001 has been seen on a real printer
// (SPARKX i7, slots set to "PLA" on the touchscreen); every other row is from the OrcaSlicer profiles and unverified
// on hardware. The pre-R19 guesses here (003001 = PETG, 002001 = ABS, 004001 = TPU, 005001 = ASA) were wrong: in
// Creality's table those are Hyper ABS, Hyper PLA-CF, CR-PLA and CR-Silk.
export interface CrealityMaterial {
  id: string // 5-digit filament_id
  material: string // base type, as our slicer profiles name them (filament-<material>.json)
  product: string
  verified: boolean // seen on a real printer
}
export const CREALITY_MATERIALS: CrealityMaterial[] = [
  // PLA family
  { id: "01001", material: "PLA", product: "Hyper PLA", verified: true },
  { id: "00001", material: "PLA", product: "Generic PLA", verified: false },
  { id: "00002", material: "PLA", product: "Generic PLA-Silk", verified: false },
  { id: "01002", material: "PLA", product: "Hyper L-W PLA", verified: false },
  { id: "01003", material: "PLA", product: "Hyper Luminous", verified: false },
  { id: "01004", material: "PLA", product: "Hyper Stardust", verified: false },
  { id: "01601", material: "PLA", product: "Soleyin Ultra PLA", verified: false },
  { id: "04001", material: "PLA", product: "CR-PLA", verified: false },
  { id: "05001", material: "PLA", product: "CR-Silk", verified: false },
  { id: "08001", material: "PLA", product: "Ender-PLA", verified: false },
  { id: "09001", material: "PLA", product: "EN-PLA+", verified: false },
  { id: "09002", material: "PLA", product: "Ender Fast PLA", verified: false },
  { id: "14001", material: "PLA", product: "CR-PLA Matte", verified: false },
  { id: "15001", material: "PLA", product: "CR-PLA Fluo", verified: false },
  { id: "18001", material: "PLA", product: "HP Ultra PLA", verified: false },
  { id: "29001", material: "PLA", product: "Hyper Marble", verified: false },
  { id: "00006", material: "PLA-CF", product: "Generic PLA-CF", verified: false },
  { id: "02001", material: "PLA-CF", product: "Hyper PLA-CF", verified: false },
  { id: "13001", material: "PLA-CF", product: "CR-PLA Carbon", verified: false },
  // PETG
  { id: "06002", material: "PETG", product: "Hyper PETG", verified: false },
  { id: "00003", material: "PETG", product: "Generic PETG", verified: false },
  { id: "06001", material: "PETG", product: "CR-PETG", verified: false },
  { id: "06005", material: "PETG", product: "Soleyin Basic PETG", verified: false },
  { id: "00014", material: "PETG-CF", product: "Generic PETG-CF", verified: false },
  { id: "06003", material: "PETG-CF", product: "Hyper PETG-CF", verified: false },
  // ABS
  { id: "03001", material: "ABS", product: "Hyper ABS", verified: false },
  { id: "00004", material: "ABS", product: "Generic ABS", verified: false },
  { id: "07001", material: "ABS", product: "CR-ABS", verified: false },
  // TPU
  { id: "10001", material: "TPU", product: "HP-TPU", verified: false },
  { id: "00005", material: "TPU", product: "Generic TPU", verified: false },
  { id: "16001", material: "TPU", product: "CR-TPU", verified: false },
  { id: "00026", material: "TPU", product: "Generic TPU 64D", verified: false },
  // ASA
  { id: "19001", material: "ASA", product: "HP-ASA", verified: false },
  { id: "00007", material: "ASA", product: "Generic ASA", verified: false },
  // others
  { id: "00008", material: "PA", product: "Generic PA", verified: false },
  { id: "11001", material: "PA", product: "CR-Nylon", verified: false },
  { id: "00021", material: "PC", product: "Generic PC", verified: false },
  { id: "07002", material: "PC", product: "Hyper PC", verified: false },
]
const BY_ID = new Map(CREALITY_MATERIALS.map((m) => [m.id, m]))

/** Creality code → material. Accepts the CFS's 6-digit code ("001001") or a 5-digit filament_id ("01001"). */
export function materialForCode(code: string | null | undefined): CrealityMaterial | null {
  const c = String(code ?? "").trim()
  if (/^0\d{5}$/.test(c)) return BY_ID.get(c.slice(1)) ?? null
  return /^\d{5}$/.test(c) ? (BY_ID.get(c) ?? null) : null
}

// What we write when a slot has no code from the printer (typed in by the user): the material Creality's touchscreen
// offers for that type. Only PLA → 01001 is confirmed (the i7 reported 001001 for slots set to "PLA"); the others are
// the matching Creality "Hyper"/"HP" ids and unverified.
const DEFAULT_ID: Record<string, string> = { PLA: "01001", PETG: "06002", ABS: "03001", TPU: "10001", ASA: "19001", "PLA-CF": "02001", "PETG-CF": "06003" }

/** Creality filament_id for the G-code footer (`filament_ids`): the printer's own code when it reported one. */
export function crealityFilamentId(f: { material?: string; materialCode?: string } | undefined): string | null {
  if (f?.materialCode && /^\d{6}$/.test(f.materialCode)) return f.materialCode.slice(1)
  return DEFAULT_ID[baseMaterial(f?.material ?? "PLA") ?? ""] ?? null
}

const BASES = ["PLA-CF", "PETG-CF", "PLA", "PETG", "ABS", "ASA", "TPU", "PA", "PC", "PET"]
/** "Hyper PETG" → "PETG", "CR-PLA Matte" → "PLA", "PLA" → "PLA"; null when no known type is named. */
export function baseMaterial(name: string): string | null {
  const n = name.toUpperCase()
  if (/\bNYLON\b/.test(n)) return "PA"
  return BASES.find((b) => new RegExp(`(^|[^A-Z])${b.replace("-", "\\-")}($|[^A-Z])`).test(n)) ?? null
}

/** Plain colour names for the UI and the agent (nearest wins). */
const FRIENDLY: [string, string][] = [
  ["White", "#ffffff"],
  ["Black", "#000000"],
  ["Grey", "#808080"],
  ["Silver", "#c0c0c0"],
  ["Red", "#d32f2f"],
  ["Dark red", "#8b0000"],
  ["Orange", "#ff8c00"],
  ["Yellow", "#ffd700"],
  ["Beige", "#e8d8b0"],
  ["Brown", "#7b4a26"],
  ["Green", "#2e9d3a"],
  ["Dark green", "#1b5e20"],
  ["Lime", "#9acd32"],
  ["Teal", "#008080"],
  ["Cyan", "#00bcd4"],
  ["Light blue", "#87cefa"],
  ["Blue", "#1e5bd8"],
  ["Navy", "#1a237e"],
  ["Purple", "#7b1fa2"],
  ["Pink", "#f06292"],
  ["Magenta", "#e91e63"],
  ["Gold", "#c9a227"],
]

export function friendlyColorName(hex: string): string {
  return [...FRIENDLY].sort((a, b) => colorDistance(hex, a[1]) - colorDistance(hex, b[1]))[0][0]
}

const cfsHex = (v: unknown): string | null => {
  const m = String(v ?? "").trim().match(/^[0-9a-f]?([0-9a-f]{6})$/i)
  return m ? `#${m[1].toLowerCase()}` : null
}

/**
 * Filament slots from a `box` object, or null when the printer has no CFS (or none connected).
 * `existing` keeps user-entered colour names when the colour is the same.
 */
export function parseBox(box: Obj | undefined, slotCount: number, existing: FilamentSlot[] = []): FilamentSlot[] | null {
  if (!box || typeof box !== "object") return null
  const named = new Map<string, string>()
  for (const e of (Array.isArray(box.same_material) ? box.same_material : []) as unknown[][]) {
    if (Array.isArray(e) && typeof e[0] === "string" && typeof e[3] === "string") named.set(e[0], e[3])
  }
  const out: FilamentSlot[] = []
  let anyUnit = false
  for (let u = 1; u <= 4; u++) {
    const unit = box[`T${u}`] as Obj | undefined
    if (!unit || String(unit.state) !== "connect") continue
    anyUnit = true
    const colors = Array.isArray(unit.color_value) ? unit.color_value : []
    const types = Array.isArray(unit.material_type) ? unit.material_type : []
    for (let i = 0; i < 4; i++) {
      const slot = (u - 1) * 4 + i + 1
      if (slot > slotCount) continue
      const hex = cfsHex(colors[i])
      const code = String(types[i] ?? "none")
      // Base type ("PETG") for slicing; the printer's own name (same_material) or our table names the product.
      const known = materialForCode(code)
      const name = named.get(code)
      const material = code === "none" || !code ? null : (known?.material ?? (name ? (baseMaterial(name) ?? name) : "unknown"))
      const prev = existing.find((f) => f.slot === slot)
      const keepName = prev && hex && prev.colorHex?.toLowerCase() === hex
      out.push({
        slot,
        colorName: hex ? (keepName ? prev.colorName : friendlyColorName(hex)) : "Not set",
        colorHex: hex ?? "#000000",
        material: material ?? "unknown",
        loaded: !!hex && !!material,
        ...(material ? { materialCode: code } : {}),
        ...(material && known ? { materialProduct: known.product } : {}),
      })
    }
  }
  return anyUnit ? out : null
}

// ---------- which slots a G-code file uses ----------

const usedCache = new Map<string, { mtimeMs: number; slots: number[] }>()

/** Filament slots (1-based) a G-code file selects: `T<n>` tool changes and the CFS `M8200 P S<n>` / `M8200 L I<n>`. */
export function gcodeSlotsUsed(gcodeAbs: string): number[] {
  const { mtimeMs } = statSync(gcodeAbs)
  const hit = usedCache.get(gcodeAbs)
  if (hit && hit.mtimeMs === mtimeMs) return hit.slots
  const text = readFileSync(gcodeAbs, "utf8")
  const used = new Set<number>()
  for (const m of text.matchAll(/^(?:T(\d+)|M8200 (?:P S|L I)(\d+))\b/gm)) used.add(Number(m[1] ?? m[2]) + 1)
  const slots = [...used].sort((a, b) => a - b)
  usedCache.set(gcodeAbs, { mtimeMs, slots })
  return slots
}

/** Plain reasons a print can't start because a slot it uses isn't set up on the printer. */
export function slotBlockers(used: number[], printerSlots: FilamentSlot[] | null | undefined): string[] {
  if (!printerSlots) return [] // printer doesn't report its filaments: nothing to check
  const out: string[] = []
  for (const slot of used) {
    const f = printerSlots.find((x) => x.slot === slot)
    if (!f) out.push(`Slot ${slot} doesn't exist on the printer's filament system. Slice again for the slots it has.`)
    else if (!f.loaded) {
      out.push(`Slot ${slot} isn't set up on the printer — choose its colour and material on the printer's screen, then try again.`)
    }
  }
  return out
}
