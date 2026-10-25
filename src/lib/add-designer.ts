// "Set up a designer" from anywhere: go to Designers and open its Add designer dialog there.
import { create } from "zustand"
import { useStudio } from "@/stores/studio"

export const useAddDesignerRequest = create<{ pending: boolean }>(() => ({ pending: false }))

export function openAddDesigner() {
  useAddDesignerRequest.setState({ pending: true })
  useStudio.getState().navigate({ name: "agents" })
}

/** True once per request (the Designers screen opens Add designer and clears it). */
export function takeAddDesignerRequest(): boolean {
  if (!useAddDesignerRequest.getState().pending) return false
  useAddDesignerRequest.setState({ pending: false })
  return true
}
