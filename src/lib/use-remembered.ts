import { useCallback, useState } from "react"

// U2: per-panel "Details" disclosures (one product, two depths). Each panel remembers whether its details are open,
// per viewer, in localStorage. Storage can be missing or throw (private window, blocked site data): then the panel
// starts from its default and simply doesn't remember.

const PREFIX = "ps-details:"

export function readRemembered(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(PREFIX + key)
    return v === "1" ? true : v === "0" ? false : fallback
  } catch {
    return fallback
  }
}

export function writeRemembered(key: string, open: boolean): void {
  try {
    localStorage.setItem(PREFIX + key, open ? "1" : "0")
  } catch {
    /* not remembered */
  }
}

/** A boolean (a "Details" disclosure, a panel shown or hidden) remembered per panel across sessions. */
export function useRemembered(key: string, fallback = false): [boolean, (next: boolean | ((cur: boolean) => boolean)) => void] {
  const [open, setOpen] = useState(() => readRemembered(key, fallback))
  const set = useCallback(
    (next: boolean | ((cur: boolean) => boolean)) =>
      setOpen((cur) => {
        const v = typeof next === "function" ? next(cur) : next
        writeRemembered(key, v)
        return v
      }),
    [key],
  )
  return [open, set]
}
