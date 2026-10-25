// The user's units (Settings.units). Everyone starts in mm; picking inches converts every length the app shows
// (sizes, sliders, limits, 3D views). Designs stay in mm underneath. Formatting lives in shared/length.ts.
import { create } from "zustand"
import type { Units } from "@shared/types"
import { fmtDims, fmtLen, fmtLenDelta, lenNumber, unitLabel } from "@shared/length"
import { api } from "@/lib/api"
import { useStudio } from "@/stores/studio"

export const useUnits = create<{ units: Units; chosen: boolean }>(() => ({ units: "mm", chosen: false }))

/** From GET /api/settings (App start). Unset = not chosen = mm. */
export function loadUnits(u: Units | undefined) {
  const before = useUnits.getState().units
  useUnits.setState({ units: u === "in" ? "in" : "mm", chosen: u === "mm" || u === "in" })
  if (useUnits.getState().units !== before) refreshOverview()
}

export async function saveUnits(u: Units) {
  useUnits.setState({ units: u, chosen: true })
  await api.putSettings({ units: u })
  refreshOverview()
}

/** The Overview's next-step text is written by the server in the user's unit: fetch it again after a change. */
function refreshOverview() {
  const st = useStudio.getState()
  if (st.project?.id) void st.loadOverview(st.project.id)
}

/** Formatters bound to the user's unit; re-renders when it changes. */
export function useLength() {
  const units = useUnits((s) => s.units)
  return {
    units,
    unit: unitLabel(units),
    num: (mm: number) => lenNumber(mm, units),
    len: (mm: number) => fmtLen(mm, units),
    dims: (v: readonly number[], unit = true) => fmtDims(v, units, unit),
    delta: (mm: number, unit = true) => fmtLenDelta(mm, units, unit),
  }
}
