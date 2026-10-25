// U2: versions remember the Customizer values (slider settings). Overrides live in .studio/params (app state, not
// in git), so every version commit carries a snapshot of the open idea's overrides as a commit-message trailer:
//   Studio-Params: {"main":{"width":90},"@shared":{"wall":3}}
// ("@shared": settings several parts share, one value for all of them; versions from before it have per-part
// values only, which are joined again when read.)
// Going back to a version restores its values; Compare builds a version with its own values. Versions from before
// this have no trailer: their values are unknown, so restore and compare keep using the idea's current ones.
import { restoreStoredOverrides, SHARED_KEY, storedOverridesAt, type ParamValue } from "./revision"

export type ParamSnapshot = Record<string, Record<string, ParamValue>>

export const PARAMS_TRAILER = "Studio-Params"

/** The open idea's stored overrides: every part that has its own (others left out), plus the shared ones. */
export function paramSnapshotAt(root: string): ParamSnapshot {
  return storedOverridesAt(root)
}

/** A part's values in a snapshot: its own plus the shared ones (callers keep only the settings it declares). */
export function snapshotPartValues(snap: ParamSnapshot, partId: string): Record<string, ParamValue> | null {
  const all = { ...(snap[partId] ?? {}), ...(snap[SHARED_KEY] ?? {}) }
  return Object.keys(all).length ? all : null
}

export const snapshotKey = (s: ParamSnapshot | null) => JSON.stringify(s ?? {})

/** The trailer line for a commit message body. */
export const paramsTrailer = (s: ParamSnapshot) => `${PARAMS_TRAILER}: ${JSON.stringify(s)}`

/** The snapshot recorded in a commit message, or null when it has none (an older version) or it is unreadable. */
export function parseParamsTrailer(message: string): ParamSnapshot | null {
  const m = message.match(new RegExp(`^${PARAMS_TRAILER}:\\s*(.+)$`, "m"))
  if (!m) return null
  try {
    const v = JSON.parse(m[1]) as unknown
    if (!v || typeof v !== "object" || Array.isArray(v)) return null
    const out: ParamSnapshot = {}
    for (const [id, o] of Object.entries(v as Record<string, unknown>)) {
      if (!o || typeof o !== "object" || Array.isArray(o)) continue
      const vals = Object.entries(o as Record<string, unknown>).filter(
        (e): e is [string, ParamValue] => typeof e[1] === "number" || typeof e[1] === "string" || typeof e[1] === "boolean",
      )
      if (vals.length) out[id] = Object.fromEntries(vals)
    }
    return out
  } catch {
    return null
  }
}

/** Make the open idea's overrides equal a snapshot (parts not in it go back to the file's defaults). */
export function applyParamSnapshot(root: string, snap: ParamSnapshot): boolean {
  return restoreStoredOverrides(root, snap)
}

const fmt = (v: ParamValue | undefined) => (v === undefined ? "default" : typeof v === "string" ? JSON.stringify(v) : String(v))
const human = (n: string) => n.replace(/_+/g, " ").trim()

/** A version message for a burst of slider edits: "change width to 90", "change width and height", "reset sizes". */
export function describeParamChange(before: ParamSnapshot, after: ParamSnapshot): string | null {
  const changed: { name: string; to: ParamValue | undefined }[] = []
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[id] ?? {}
    const b = after[id] ?? {}
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[name]) !== JSON.stringify(b[name])) changed.push({ name, to: b[name] })
    }
  }
  if (!changed.length) return null
  if (!Object.keys(after).length) return "reset settings"
  const names = [...new Set(changed.map((c) => human(c.name)))]
  if (names.length === 1) return `change ${names[0]} to ${fmt(changed[changed.length - 1].to)}`
  if (names.length === 2) return `change ${names[0]} and ${names[1]}`
  return `change ${names[0]}, ${names[1]} and ${names.length - 2} more`
}
