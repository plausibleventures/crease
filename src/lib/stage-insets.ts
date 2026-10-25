// The stage's visible window. The workspace's 3D canvas spans the whole window, under the floating header, parts
// list, chat and tools. The workspace publishes how much of each edge its chrome covers, so viewers can centre the
// part in the visible gap (a camera view offset) and keep the axis gizmo out from under the chat.
import { useSyncExternalStore } from "react"

export type Insets = { l: number; r: number; t: number; b: number }
const ZERO: Insets = { l: 0, r: 0, t: 0, b: 0 }
let insets: Insets = ZERO
const listeners = new Set<() => void>()

export function setStageInsets(next: Insets | null) {
  const n = next ?? ZERO
  if (n.l === insets.l && n.r === insets.r && n.t === insets.t && n.b === insets.b) return
  insets = n
  for (const l of listeners) l()
}

export function useStageInsets(): Insets {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    () => insets,
  )
}
