// R13: what the plate views share — which parts / copies are hidden (eye toggles), which plate is being inspected,
// and the placement of each sliced job (immutable per job id, so cached for good).
import { create } from "zustand"
import type { PlatePlacement, PrintJobView, ProjectJobs } from "@shared/types"
import { api } from "@/lib/api"

interface Hidden {
  parts: string[] // part ids hidden in Model (assembled) + Plate views
  objects: string[] // copies hidden in the Plate view: objectKey()
}

/** A copy on the plate, stable across re-slices of the same parts list: "<partId>|<letter>". */
export const objectKey = (o: { partId: string; label: string }) => `${o.partId}|${o.label}`

const EMPTY: Hidden = { parts: [], objects: [] }
const storeKey = (projectId: string) => `ps-hidden-${projectId}`

function readHidden(projectId: string): Hidden {
  try {
    const v = JSON.parse(localStorage.getItem(storeKey(projectId)) ?? "null") as Partial<Hidden> | null
    return { parts: Array.isArray(v?.parts) ? v.parts : [], objects: Array.isArray(v?.objects) ? v.objects : [] }
  } catch {
    return EMPTY
  }
}
function writeHidden(projectId: string, h: Hidden) {
  try {
    localStorage.setItem(storeKey(projectId), JSON.stringify(h))
  } catch {
    /* private window: per-session only */
  }
}

export type ModelMode = "part" | "assembled" | "plate"

interface PlatesState {
  hidden: Record<string, Hidden>
  hiddenFor: (projectId: string) => Hidden
  togglePart: (projectId: string, partId: string) => void
  setPartsHidden: (projectId: string, partIds: string[]) => void
  toggleObject: (projectId: string, key: string) => void
  setObjectsHidden: (projectId: string, keys: string[]) => void
  /** inspected plate (0-based) per project; shared by Model › Plate and Layers */
  plate: Record<string, number>
  setPlate: (projectId: string, i: number) => void
  /** Model view mode per project (part / assembled / plate) */
  mode: Record<string, ModelMode>
  setMode: (projectId: string, m: ModelMode) => void
  placements: Record<string, PlatePlacement | { error: string }>
  loadPlacement: (projectId: string, jobId: string) => Promise<PlatePlacement | null>
}

const inflight = new Map<string, Promise<PlatePlacement | null>>()

export const usePlates = create<PlatesState>((set, get) => ({
  hidden: {},
  hiddenFor: (projectId) => get().hidden[projectId] ?? readHidden(projectId),
  togglePart: (projectId, partId) => {
    const h = get().hiddenFor(projectId)
    const parts = h.parts.includes(partId) ? h.parts.filter((x) => x !== partId) : [...h.parts, partId]
    const next = { ...h, parts }
    writeHidden(projectId, next)
    set((s) => ({ hidden: { ...s.hidden, [projectId]: next } }))
  },
  setPartsHidden: (projectId, partIds) => {
    const next = { ...get().hiddenFor(projectId), parts: [...new Set(partIds)] }
    writeHidden(projectId, next)
    set((s) => ({ hidden: { ...s.hidden, [projectId]: next } }))
  },
  toggleObject: (projectId, key) => {
    const h = get().hiddenFor(projectId)
    const objects = h.objects.includes(key) ? h.objects.filter((x) => x !== key) : [...h.objects, key]
    const next = { ...h, objects }
    writeHidden(projectId, next)
    set((s) => ({ hidden: { ...s.hidden, [projectId]: next } }))
  },
  setObjectsHidden: (projectId, keys) => {
    const next = { ...get().hiddenFor(projectId), objects: [...new Set(keys)] }
    writeHidden(projectId, next)
    set((s) => ({ hidden: { ...s.hidden, [projectId]: next } }))
  },
  plate: {},
  setPlate: (projectId, i) => set((s) => ({ plate: { ...s.plate, [projectId]: i } })),
  mode: {},
  setMode: (projectId, m) => set((s) => ({ mode: { ...s.mode, [projectId]: m } })),
  placements: {},
  loadPlacement: (projectId, jobId) => {
    const have = get().placements[jobId]
    if (have && !("error" in have)) return Promise.resolve(have)
    let p = inflight.get(jobId)
    if (!p) {
      p = api
        .jobPlacement(projectId, jobId)
        .then((pl) => {
          set((s) => ({ placements: { ...s.placements, [jobId]: pl } }))
          return pl
        })
        .catch((e) => {
          set((s) => ({ placements: { ...s.placements, [jobId]: { error: (e as Error).message } } }))
          return null
        })
        .finally(() => inflight.delete(jobId))
      inflight.set(jobId, p)
    }
    return p
  },
}))

/** Hidden lists of a project (stable empty object when nothing is hidden). */
export function useHidden(projectId: string): Hidden {
  return usePlates((s) => s.hidden[projectId]) ?? readHiddenCached(projectId)
}
const cached = new Map<string, Hidden>()
function readHiddenCached(projectId: string): Hidden {
  let h = cached.get(projectId)
  if (!h) {
    h = readHidden(projectId)
    cached.set(projectId, h)
  }
  return h
}

/**
 * The jobs the plate views inspect: the latest plate set; with no plate set, the selected part's own slice
 * (single-part projects slice per part). Empty = nothing sliced yet (show the planned arrangement).
 */
export function plateJobsOf(jobs: ProjectJobs | undefined, partId: string | null): PrintJobView[] {
  if (jobs?.plates?.plates.length) return jobs.plates.plates
  const own = partId ? jobs?.parts[partId] : undefined
  return own ? [own] : []
}
