// OWNER: slicer/printer agent. Klipper's own state and Moonraker errors, in plain words (pure, no I/O).
// The firmware's text never reaches the app: its first line goes to the server log, people get a sentence.
import type { FirmwareState } from "../../shared/types"

/** Klipper's state ("ready" | "startup" | "shutdown" | "error") as a FirmwareState; null when ready or unknown. */
export function firmwareState(raw: unknown): FirmwareState | null {
  if (typeof raw !== "string" || !raw || raw === "ready") return null
  if (raw === "startup" || raw === "shutdown") return raw
  return "error"
}

export const FIRMWARE_SENTENCE: Record<FirmwareState, string> = {
  shutdown: "The printer stopped itself for safety. Restart it to keep going.",
  error: "The printer's firmware has a problem. Restart it to try again.",
  startup: "The printer is starting up.",
}

/** Can a firmware restart help (and is it allowed)? */
export const canRestartFirmware = (f: FirmwareState | null | undefined) => f === "shutdown" || f === "error"

const unescape = (s: string) => s.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, "\\")

/**
 * The first useful line of a Klipper / Moonraker message. Unwraps SparkX's `{"code":"key1","msg":"..."}` and
 * Moonraker's Python-repr `{'error': 'WebRequestError', 'message': '...'}`, nested in either order.
 */
export function firstLine(raw: unknown): string {
  let s = typeof raw === "string" ? raw : raw == null ? "" : JSON.stringify(raw)
  for (let i = 0; i < 4; i++) {
    const t = s.trim()
    if (!t.startsWith("{")) break
    let next: string | null = null
    try {
      const j = JSON.parse(t) as Record<string, unknown>
      const v = j.msg ?? j.message ?? (typeof j.error === "object" && j.error ? (j.error as Record<string, unknown>).message : j.error)
      if (typeof v === "string") next = v
    } catch {
      // Not JSON (Python repr, or JSON with raw newlines): pick the msg / message value by pattern.
      const m = t.match(/["']msg["']\s*:\s*"((?:[^"\\]|\\.)*)"/s) ?? t.match(/["']message["']\s*:\s*'((?:[^'\\]|\\.)*)'/s) ?? t.match(/["']message["']\s*:\s*"((?:[^"\\]|\\.)*)"/s)
      if (m) next = unescape(m[1])
    }
    if (next == null) break
    s = next
  }
  const line = unescape(s)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !/^[{}]$/.test(l))
  return (line ?? "").replace(/^!!\s*/, "").slice(0, 200)
}

/** What a Moonraker path was trying to do, as the end of "The printer couldn't …". */
function verbFor(path: string): string {
  const p = path.split("?")[0]
  if (p === "/printer/print/cancel") return "stop the print"
  if (p === "/printer/print/pause") return "pause the print"
  if (p === "/printer/print/resume") return "resume the print"
  if (p === "/printer/print/start") return "start the print"
  if (p === "/server/files/upload") return "take the file"
  if (p === "/printer/firmware_restart") return "restart"
  return "answer"
}

const SHUTDOWN_RE = /shutdown|FIRMWARE_RESTART|flush_handler|MCU .* (?:lost|shutdown)/i
const STARTING_RE = /klippy (?:disconnected|not (?:connected|ready))|klippy host not connected|startup/i

/**
 * A Moonraker HTTP error as a plain sentence for people, plus its first line for the log.
 * Short, plain reasons ("No print in progress") are kept; anything that looks like code or JSON is dropped.
 */
export function plainMoonrakerError(path: string, status: number, raw: unknown): { message: string; logLine: string } {
  const line = firstLine(raw)
  const logLine = `${path.split("?")[0]} -> ${status}: ${line}`
  if (SHUTDOWN_RE.test(line)) return { message: FIRMWARE_SENTENCE.shutdown, logLine }
  if (STARTING_RE.test(line)) return { message: "The printer is starting up. Try again in a moment.", logLine }
  if (status === 401 || status === 403) return { message: "The printer refused Crease. Check its API key in Machines.", logLine }
  const plain = line.length > 0 && line.length <= 80 && /^[\w .,'()%:/+-]+$/.test(line) && !/(?:Error|Exception)\b/.test(line)
  const reason = plain ? `: ${line.charAt(0).toLowerCase()}${line.slice(1).replace(/[.\s]+$/, "")}` : ""
  return { message: `The printer couldn't ${verbFor(path)}${reason}.`, logLine }
}
