// Print intents: named OrcaSlicer process overrides on top of the machine's stock process profile.
// Values stay inside the ranges the OrcaSlicer CLI accepts (checked by slicing each intent for real on the i7).
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { PrintIntent, PrintIntentInfo } from "../../shared/types"

type Overrides = Record<string, string | number | boolean>

export const INTENTS: PrintIntentInfo[] = [
  {
    id: "standard",
    label: "Standard",
    blurb: "The printer's stock settings",
    overrides: {},
  },
  {
    id: "display",
    label: "Display piece",
    blurb: "Smooth top, crisp edges. Slower.",
    overrides: {
      ironing_type: "top", // iron the topmost surface
      ironing_speed: "30",
      ironing_flow: "10%",
      wall_generator: "arachne", // variable-width walls: no gap-fill slivers along curves
      wall_loops: "3",
      only_one_wall_top: "0",
      outer_wall_speed: "100",
      inner_wall_speed: "150",
      top_surface_speed: "100",
      gap_infill_speed: "50",
      outer_wall_acceleration: "2000",
      inner_wall_acceleration: "3000",
      top_surface_acceleration: "1500",
      gap_fill_target: "nowhere", // arachne fills thin areas itself
      filter_out_gap_fill: "0.5",
      seam_position: "aligned",
      top_shell_layers: "6",
      top_shell_thickness: "1.2",
    },
  },
  {
    id: "strong",
    label: "Strong part",
    blurb: "Thicker walls and fill for parts under load",
    overrides: {
      wall_loops: "4",
      sparse_infill_density: "40%",
      sparse_infill_pattern: "gyroid",
      top_shell_layers: "6",
      bottom_shell_layers: "5",
      only_one_wall_top: "0",
    },
  },
  {
    id: "fast",
    label: "Fast",
    blurb: "Less inside, done sooner",
    overrides: { wall_loops: "2", sparse_infill_density: "10%" },
  },
  {
    id: "draft",
    label: "Draft",
    blurb: "Quickest test of size and fit",
    overrides: { layer_height: "0.28", wall_loops: "2", sparse_infill_density: "10%", top_shell_layers: "4", bottom_shell_layers: "3" },
  },
]

export function intentInfo(id: string | undefined): PrintIntentInfo {
  const hit = INTENTS.find((i) => i.id === (id ?? "standard"))
  if (!hit) throw Object.assign(new Error(`unknown intent "${id}" (use ${INTENTS.map((i) => i.id).join(", ")})`), { statusCode: 400 })
  return hit
}

/**
 * Write process.json for this slice: the profile's process + intent overrides + caller overrides. Caller keys must
 * already exist in the profile (catches typos; OrcaSlicer would ignore them silently).
 */
export async function writeProcessFile(profileDir: string, tmpDir: string, intent: PrintIntent, overrides: Overrides = {}): Promise<string> {
  const base = JSON.parse(await readFile(join(profileDir, "process.json"), "utf8")) as Record<string, unknown>
  checkOverrideKeys(base, overrides)
  const merged = { ...base }
  for (const [k, v] of Object.entries({ ...intentInfo(intent).overrides, ...overrides })) {
    // Profile values are strings (or string arrays for per-filament keys).
    merged[k] = Array.isArray(base[k]) ? [String(v)] : String(v)
  }
  const out = join(tmpDir, "process.json")
  await writeFile(out, JSON.stringify(merged))
  return out
}

function checkOverrideKeys(base: Record<string, unknown>, overrides: Overrides) {
  const unknown = Object.keys(overrides).filter((k) => !(k in base) && !EXTRA_KEYS.has(k))
  if (unknown.length) {
    throw Object.assign(new Error(`unknown OrcaSlicer process setting(s): ${unknown.join(", ")}`), { statusCode: 400 })
  }
}

/** Validate per-part overrides against the profile and turn them into OrcaSlicer per-object params (strings). */
export async function objectParams(profileDir: string, overrides: Overrides): Promise<Record<string, string>> {
  const base = JSON.parse(await readFile(join(profileDir, "process.json"), "utf8")) as Record<string, unknown>
  checkOverrideKeys(base, overrides)
  return Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, String(v)]))
}

/** Valid OrcaSlicer 2.4.2 process keys that the flattened i7 process profile doesn't list (CLI default used). */
const EXTRA_KEYS = new Set(["ironing_inset"])

/** Header comments recording how the file was made (read back by the slice preview). */
export function intentHeader(intent: PrintIntent, overrides: Overrides): string {
  return `; printstudio_intent = ${intent}\n; printstudio_overrides = ${JSON.stringify(overrides)}\n`
}
