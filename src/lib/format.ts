export function fmtDuration(s: number | null | undefined): string {
  if (s == null || !isFinite(s)) return "—"
  s = Math.round(s)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${sec}s`
  return `${sec}s`
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null || !isFinite(ms)) return "—"
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return fmtDuration(ms / 1000)
}

export function fmtCost(usd: number | null | undefined): string {
  if (usd == null || !isFinite(usd)) return "$0.00"
  return usd < 0.01 && usd > 0 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`
}

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "—"
  const t = Date.parse(iso)
  if (isNaN(t)) return iso
  const d = (Date.now() - t) / 1000
  if (d < 60) return "just now"
  if (d < 3600) return `${Math.floor(d / 60)}m ago`
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}d ago`
  return new Date(t).toLocaleDateString()
}

export function fmtNum(n: number | null | undefined, digits = 1): string {
  if (n == null || !isFinite(n)) return "—"
  return n.toFixed(digits)
}

/** One word per printer state (docs/writing.md glossary): "offline", never "disconnected"; "stopped", not "cancelled". */
const STATE_WORD: Record<string, string> = { disconnected: "offline", standby: "ready", complete: "done", cancelled: "stopped", error: "problem" }
/** Klipper not ready (PrinterStatus.firmware): "stopped" for a safety shutdown, never the firmware's own words. */
const FIRMWARE_WORD: Record<string, string> = { shutdown: "stopped", error: "problem", startup: "starting" }
export const printerStateWord = (state: string, firmware?: string | null) =>
  (firmware ? FIRMWARE_WORD[firmware] : undefined) ?? STATE_WORD[state] ?? state
