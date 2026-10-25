// The one line that says how this project's print is going: "Plate 1 printing · 59% · 1h 59m left".
import { fmtDuration } from "./format"

export interface PrintNow {
  plate: number | null // 1-based, when the build has plates
  plates: number // how many plates the build has
  state: "printing" | "paused" | "preparing"
  progress: number | null // 0..1
  timeLeftS: number | null
}

export function printLine(p: PrintNow): string {
  const who = p.plates > 1 && p.plate != null ? `Plate ${p.plate} ` : ""
  const verb = p.state === "preparing" ? "getting ready" : p.state === "paused" ? "paused" : "printing"
  const head = who ? `${who}${verb}` : verb[0].toUpperCase() + verb.slice(1)
  if (p.state === "preparing") return head
  const parts = [head]
  if (p.progress != null) parts.push(`${Math.round(p.progress * 100)}%`)
  if (p.state === "printing" && p.timeLeftS != null && p.timeLeftS > 0) parts.push(`${fmtDuration(p.timeLeftS)} left`)
  return parts.join(" · ")
}
