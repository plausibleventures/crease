// The design agent's view of the user's printers: the project's target machine (its limits are the design
// constraints) and the other enabled machines it might recommend instead.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { FilamentSlot, Machine, PrinterStatus, Project } from "../../shared/types"
import { getMachine, getMachines } from "../machines"
import { cachedStatus } from "../printer/index"
import { partColorText } from "../cad/sculpt"
import { deps } from "./deps"

/** The project's target machine (project.json `printer`), falling back to the default machine. */
export const targetMachine = (project: Pick<Project, "printer">): Machine => getMachine(project.printer || undefined)

export const enabledMachines = (): Machine[] => getMachines().filter((m) => m.enabled)

const inches = (mm: number) => (mm / 25.4).toFixed(1)
export const loadedColours = (m: Machine): FilamentSlot[] => (m.filaments ?? []).filter((f) => f.loaded)

/** Live status from the printer poller's cache (null when not connected or not yet polled). */
function statusOf(m: Machine): PrinterStatus | null {
  if (m.connection.type === "none") return null
  try {
    return cachedStatus(m.id)
  } catch {
    return null
  }
}

/** One compact line per machine, for the brief and list_machines. */
export function machineLine(m: Machine, status?: PrinterStatus | null): string {
  const [x, y, z] = m.buildVolumeMm
  const cols = loadedColours(m)
  const colours = cols.length ? cols.map((f) => `${f.colorName} ${f.material}`).join(", ") : "none recorded"
  const state = status ? (status.connected ? status.state : "offline") : m.connection.type === "none" ? "not connected" : "status unknown"
  return (
    `${m.name} [${m.id}]: bed ${x}×${y}×${z} mm (${inches(x)}×${inches(y)}×${inches(z)} in), ${m.nozzleMm} mm nozzle, ` +
    `${m.filamentSlots} colour slot${m.filamentSlots === 1 ? "" : "s"} loaded with ${colours}` +
    `${m.filamentsConfirmed ? "" : " (not confirmed)"}, ${state}`
  )
}

export async function machinesWithStatus(): Promise<{ machine: Machine; status: PrinterStatus | null }[]> {
  return enabledMachines().map((machine) => ({ machine, status: statusOf(machine) }))
}

// ---------------------------------------------------------------------------------------------
// Done-checklist items for the target machine: does every part fit, and are its colours loaded?
// ---------------------------------------------------------------------------------------------
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, "")
const COLOR_RE = /\bcolou?r\(\s*"([^"]+)"/g

/** Distinct color("…") values used by a part's source (literal strings only). */
export function coloursUsed(scadSource: string): string[] {
  return [...new Set([...scadSource.matchAll(COLOR_RE)].map((m) => m[1]))]
}

function colourLoaded(c: string, loaded: FilamentSlot[]): boolean {
  const n = norm(c)
  return loaded.some((f) => norm(f.colorName) === n || norm(f.colorHex) === n || norm(f.colorName).includes(n) || n.includes(norm(f.colorName)))
}

export async function machineChecklist(projectId: string): Promise<string[]> {
  const root = deps.projectDir(projectId)
  const project = await deps.getProject(projectId)
  const m = targetMachine(project)
  const items: string[] = []
  const [bx, by, bz] = m.buildVolumeMm
  const loaded = loadedColours(m)
  const others = enabledMachines().filter((o) => o.id !== m.id)
  for (const p of project.parts) {
    const meta = join(root, "build", `${p.id}.render.json`)
    if (existsSync(meta)) {
      try {
        const size = JSON.parse(readFileSync(meta, "utf8"))?.stats?.sizeMm as [number, number, number] | undefined
        if (size) {
          const [a, b] = [size[0], size[1]].sort((u, v) => v - u)
          const [ba, bb] = [bx - 10, by - 10].sort((u, v) => v - u)
          if (a > ba || b > bb || size[2] > bz) {
            const fits = others.filter((o) => {
              const [oa, ob] = [o.buildVolumeMm[0] - 10, o.buildVolumeMm[1] - 10].sort((u, v) => v - u)
              return a <= oa && b <= ob && size[2] <= o.buildVolumeMm[2]
            })
            items.push(
              `${p.id} (${size.map((v) => Math.round(v)).join("×")} mm) doesn't fit ${m.name}'s ${bx}×${by}×${bz} mm bed` +
                (fits.length ? `; it would fit ${fits.map((o) => o.name).join(", ")}` : "; split it into parts that join"),
            )
          }
        }
      } catch {
        /* no stats */
      }
    }
    const scad = join(root, p.file)
    if (!existsSync(scad)) continue
    const used = coloursUsed(partColorText(root, p.file))
    if (used.length > m.filamentSlots) items.push(`${p.id} uses ${used.length} colours but ${m.name} holds ${m.filamentSlots}`)
    const missing = used.filter((c) => !colourLoaded(c, loaded))
    if (missing.length) {
      const better = others.filter((o) => used.length <= o.filamentSlots && used.every((c) => colourLoaded(c, loadedColours(o))))
      items.push(
        `${p.id} uses ${missing.join(", ")}, not loaded on ${m.name}` + (better.length ? `; ${better.map((o) => o.name).join(", ")} has them loaded` : ""),
      )
    }
  }
  return items
}
