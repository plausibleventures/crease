// Slice / Send to printer, shared by the toolbar and the project overview's next-action button (R12).
// Multi-part projects slice the whole build (all parts × qty arranged onto plates); single-part projects slice the part.
import { create } from "zustand"
import { toast } from "sonner"
import type { ProjectOverview, SlicePreviewSummary, SliceResult, PlateSliceResult } from "@shared/types"
import { api, ApiError, errMsg } from "@/lib/api"
import { fmtDuration, fmtNum } from "@/lib/format"
import { plainSliceError } from "@shared/slice-errors"
import { useStudio } from "@/stores/studio"
import type { PrintNow } from "@/lib/print-line"

interface BuildBusy {
  slicing: Record<string, boolean> // per project (plate slices; part slices use useStudio.slicing)
  sending: Record<string, boolean>
  /** Send found the slice out of date and is slicing the same thing again first ("Slicing again…") */
  reslicing: Record<string, boolean>
}
export const useBuildBusy = create<BuildBusy>(() => ({ slicing: {}, sending: {}, reslicing: {} }))
const setBusy = (k: keyof BuildBusy, projectId: string, v: boolean) =>
  useBuildBusy.setState((s) => ({ [k]: { ...s[k], [projectId]: v } }))

/**
 * R2-FLOW-02: the Overview's next step is a check that must pass first ("Make it fit", a failed check, a part that
 * didn't build). Print (toolbar, palette) is then off, with this reason; it never slices only to fail.
 * `slice` is also off unless the failure was the slice itself (then slicing again is how you retry).
 */
export function blockFor(ov: ProjectOverview | undefined): { reason: string; slice: boolean } | null {
  if (!ov?.hasDesign) return null
  const n = ov.next
  if (n.kind !== "fit" && n.kind !== "problem" && n.kind !== "fix") return null
  const sliceError = n.kind === "problem" && !n.partId && !!ov.slice.error
  return { reason: `${n.label} first. ${n.detail}`, slice: !sliceError }
}
export const printBlock = (projectId: string) => blockFor(useStudio.getState().overview[projectId])

/** The reason Print is off (null: it's on), and whether Slice is off too. Re-renders when the overview changes. */
export function usePrintBlock(projectId: string) {
  const reason = useStudio((s) => blockFor(s.overview[projectId])?.reason ?? null)
  const slice = useStudio((s) => blockFor(s.overview[projectId])?.slice ?? false)
  return { reason, slice }
}

const isMultiPart = (projectId: string) => {
  const p = useStudio.getState().project
  return p?.id === projectId && p.parts.length > 1
}

/** Remember the slice for the Layers tab; if the preview found things to check, say so (non-blocking). */
async function afterSlice(projectId: string, gcodePath: string, preview?: SlicePreviewSummary) {
  const p = await useStudio.getState().noteSliced(projectId, gcodePath, preview)
  const n = p?.issues.filter((i) => i.severity === "warn").length ?? 0
  if (n)
    toast.warning(`${n} thing${n === 1 ? "" : "s"} to check in Layers`, {
      // the short name ("Ragged top edge"), not the slicer's numbers; Layers has the detail
      description: (() => {
        const w = p!.issues.find((i) => i.severity === "warn")
        return w ? (w.title ?? w.message.split(/(?<=[a-z)])[.:(]\s|\s\(/)[0]) : undefined
      })(),
      action: { label: "Open Layers", onClick: () => useStudio.getState().setCenterTab("layers") },
      duration: 10000,
    })
}

/** A slice failed: say it in plain words; the overview keeps saying it (and what to do) until the next slice. */
function sliceFailed(projectId: string, e: unknown) {
  toast.error(plainSliceError(errMsg(e)).message, {
    id: `slice-failed-${projectId}`,
    description: "The Overview says what to do next.",
    action: { label: "Overview", onClick: () => useStudio.getState().setCenterTab("overview") },
    duration: 10000,
  })
  useStudio.getState().loadOverview(projectId)
}

export async function slicePlate(projectId: string): Promise<PlateSliceResult | null> {
  setBusy("slicing", projectId, true)
  try {
    const st = useStudio.getState()
    // reuseLatest: the same plate as last time — its composition and the agent's per-part settings (e.g. 4 walls)
    const r = await api.slicePlate(projectId, undefined, st.targetMachineId(projectId), st.intentFor(projectId), true)
    await st.loadJobs(projectId)
    if (r.plates[0]) void afterSlice(projectId, r.plates[0].gcodePath, r.plates[0].preview ?? r.preview)
    const n = r.plates.length
    toast.success(n === 1 ? "Sliced the build onto one plate" : `Sliced the build onto ${n} plates`, {
      description: `${fmtDuration(r.estimatedTimeS)} · ${fmtNum(r.filamentG)} g`,
    })
    return r
  } catch (e) {
    sliceFailed(projectId, e)
    return null
  } finally {
    setBusy("slicing", projectId, false)
  }
}

/** Slice the build (multi-part) or the part. Returns the first G-code path, or null on failure. */
export async function sliceBuild(projectId: string, partId: string | null): Promise<{ gcodePath: string } | null> {
  if (isMultiPart(projectId)) {
    const r = await slicePlate(projectId)
    const first = r?.plates[0]
    return first ? { gcodePath: first.gcodePath } : null
  }
  if (!partId) return null
  const st = useStudio.getState()
  try {
    const r: SliceResult | null = await st.slice(projectId, partId)
    if (r) {
      await st.loadJobs(projectId)
      toast.success(`Sliced ${r.gcodeName}`, { description: `${fmtDuration(r.estimatedTimeS)} · ${fmtNum(r.filamentG)} g` })
      void afterSlice(projectId, r.gcodePath, r.preview)
    }
    return r
  } catch (e) {
    sliceFailed(projectId, e)
    return null
  }
}

/**
 * Ask to print: the next plate of the build (one request per plate, in order; the server's cursor moves only when a
 * plate actually starts, so a rejected or failed plate is offered again), or the part. An out-of-date or missing
 * slice is sliced first. The app's confirm dialog always asks before anything starts.
 */
export async function sendBuild(projectId: string, partId: string | null): Promise<void> {
  const multiPart = isMultiPart(projectId)
  if (!partId && !multiPart) return
  const block = printBlock(projectId)
  if (block) {
    toast.info(block.reason, { id: `print-blocked-${projectId}` })
    return
  }
  setBusy("sending", projectId, true)
  try {
    try {
      await sendOnce(projectId, partId, multiPart, false)
    } catch (e) {
      // The server judges "out of date" (e.g. a Customizer change the UI hadn't heard about yet): slice the same
      // thing again and ask once more.
      if (!isOutOfDate(e)) throw e
      await useStudio.getState().loadJobs(projectId)
      await sendOnce(projectId, partId, multiPart, true)
    }
  } catch (e) {
    toast.error("Couldn't create print request", { description: errMsg(e) })
  } finally {
    setBusy("sending", projectId, false)
  }
}

/** 409 "Out of date — slice again" from POST print-requests: the job no longer matches the design. */
export const isOutOfDate = (e: unknown) => e instanceof ApiError && e.status === 409 && /out of date/i.test(e.message)

/** Slice again as part of Send, with the button saying "Slicing again…". */
async function resliceForSend<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  setBusy("reslicing", projectId, true)
  try {
    return await fn()
  } finally {
    setBusy("reslicing", projectId, false)
  }
}

/** The target machine has no connection: Send = save the print file to print by hand (export-only path). */
const byHand = (projectId: string) => {
  const st = useStudio.getState()
  const id = st.targetMachineId(projectId)
  const m = st.machines?.find((x) => x.id === id)
  return m && m.connection.type === "none" ? m : null
}

async function saveByHand(projectId: string, gcodePath: string, printerName: string) {
  const name = await api.savePrintFile(projectId, gcodePath)
  toast.success(`Saved ${name}`, {
    description: `${printerName} has no connection: copy the file to its USB stick or SD card, then pick it on the printer's screen.`,
    duration: 12000,
  })
}

async function sendOnce(projectId: string, partId: string | null, multiPart: boolean, forceReslice: boolean): Promise<void> {
  const st = useStudio.getState()
  const hand = byHand(projectId)
  if (multiPart) {
    let set = forceReslice ? null : (st.jobs[projectId]?.plates ?? null)
    if (!set || set.stale.length || set.next == null) {
      if (!(await resliceForSend(projectId, () => slicePlate(projectId)))) return
      set = useStudio.getState().jobs[projectId]?.plates ?? null
      if (!set || set.next == null) return
    }
    const pl = set.plates[set.next!]
    if (hand) {
      await saveByHand(projectId, pl.gcodePath, hand.name)
      if (set.plates.length > 1) toast.info(`Plate ${pl.plate} of ${set.plates.length}`, { description: "Save the other plates from the Plates view." })
      return
    }
    if (pl.status === "requested") {
      toast.info(`Plate ${pl.plate} is waiting for your answer`, { description: "Approve or reject it in the print dialog first." })
      return
    }
    st.addPrintRequest(await api.createPrintRequest(projectId, pl.gcodePath))
    if (set.plates.length > 1)
      toast.info(`Plate ${pl.plate} of ${set.plates.length}`, { description: "Send again for the next plate once this one has started." })
    return
  }
  // A stale slice is never offered for printing: slice again (same inputs), then request the fresh job.
  const partJob = partId && !forceReslice ? st.jobs[projectId]?.parts[partId] : undefined
  const path = partJob && !partJob.stale.length ? partJob.gcodePath : (await resliceForSend(projectId, () => sliceBuild(projectId, partId)))?.gcodePath
  if (!path) return
  if (hand) return saveByHand(projectId, path, hand.name)
  st.addPrintRequest(await api.createPrintRequest(projectId, path))
}

const LIVE = ["printing", "paused", "preparing"] as const
type Live = (typeof LIVE)[number]
const isLive = (s: string | undefined): s is Live => !!s && (LIVE as readonly string[]).includes(s)

/**
 * This project's print while it runs: which plate, and the printer's live progress and time left. Null when
 * nothing of this project is printing. One source for the toolbar's "Watch print" and the Overview's status line.
 */
export function useProjectPrint(projectId: string): PrintNow | null {
  // primitives only (a new object per selector call would re-render forever)
  const jobPlate = useStudio((s) => {
    const j = s.jobs[projectId]
    const p = j?.plates?.plates.find((x) => x.status === "printing") ?? Object.values(j?.parts ?? {}).find((x) => x.status === "printing")
    return p ? (p.plate ?? 1) : null
  })
  const plates = useStudio((s) => s.jobs[projectId]?.plates?.plates.length ?? 0)
  const overviewSays = useStudio((s) => s.overview[projectId]?.next.kind === "printing")
  const machineId = useStudio((s) => s.watchMachineId(projectId))
  const status = (s: ReturnType<typeof useStudio.getState>) => s.machines?.find((m) => m.id === machineId)?.status ?? s.printer
  const state = useStudio((s) => status(s)?.state)
  const progress = useStudio((s) => status(s)?.progress ?? null)
  const timeLeftS = useStudio((s) => status(s)?.timeLeftS ?? null)
  if (jobPlate == null && !overviewSays) return null
  const live = isLive(state)
  return { plate: jobPlate, plates, state: live ? state : "printing", progress: live ? progress : null, timeLeftS: live ? timeLeftS : null }
}
