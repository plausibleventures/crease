// Loaded filaments (CFS slots): the one place the agent and UI read them from.
// Today they come from the Machine (user-edited, or confirmed by the agent's intake question).
// Printers with a Creality CFS report their slots (Moonraker `box` object): the printer client copies them into the
// Machine on every poll (filamentsSource "printer", confirmed), so the printer wins over what was typed in.
import type { FilamentSlot } from "../../shared/types"
import { getMachine, updateMachine } from "../machines"

export interface LoadedFilaments {
  filaments: FilamentSlot[]
  confirmed: boolean
  source: "settings" | "printer"
}

export function getLoadedFilaments(machineId?: string): LoadedFilaments {
  const m = getMachine(machineId)
  return { filaments: m.filaments ?? [], confirmed: !!m.filamentsConfirmed, source: m.filamentsSource === "printer" ? "printer" : "settings" }
}

/** Save a user-confirmed set of loaded filaments on a machine (default when omitted; max its slot count). */
export function confirmLoadedFilaments(filaments: Omit<FilamentSlot, "slot" | "loaded">[], machineId?: string): LoadedFilaments {
  const m = getMachine(machineId)
  const slots: FilamentSlot[] = filaments.slice(0, Math.max(1, m.filamentSlots)).map((f, i) => ({
    slot: i + 1,
    colorName: f.colorName,
    colorHex: /^#[0-9a-f]{6}$/i.test(f.colorHex) ? f.colorHex : "#888888",
    material: f.material || "PLA",
    loaded: true,
  }))
  updateMachine(m.id, { filaments: slots, filamentsConfirmed: true, filamentsSource: "user" })
  return getLoadedFilaments(m.id)
}

/** One line for prompts and tool output, e.g. "White PLA, Black PLA, Red PLA, Blue PLA (not confirmed)". */
export function describeFilaments(f: LoadedFilaments = getLoadedFilaments()): string {
  const loaded = f.filaments.filter((x) => x.loaded)
  const list = loaded.length ? loaded.map((x) => `slot ${x.slot}: ${x.colorName} ${x.material}`).join(", ") : "none recorded"
  const how = f.source === "printer" ? "read from the printer" : f.confirmed ? "confirmed by the user" : "NOT confirmed: a default guess"
  const unset = f.filaments.filter((x) => !x.loaded).map((x) => x.slot)
  return `${list} (${how})${unset.length ? `; not set up on the printer: slot ${unset.join(", ")}` : ""}`
}
