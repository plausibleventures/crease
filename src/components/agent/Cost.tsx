// Session/turn cost and Claude plan usage, labelled honestly.
// On a claude.ai login the SDK's total_cost_usd is an API list-price estimate: the user isn't billed it.
import type { PlanUsage, PlanUsageWindow } from "@shared/types"
import { fmtCost } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useStudio } from "@/stores/studio"

const EST_TIP = "What this would cost on the API. On your Claude plan it counts toward your usage limits instead."
const API_TIP = "Billed to your Anthropic API key."

export function Cost({ usd, className, note }: { usd: number | null | undefined; className?: string; note?: string }) {
  const billing = useStudio((s) => s.billing)
  const api = billing === "api"
  return (
    <span className={cn("tabular-nums", className)} title={`${note ? `${note}. ` : ""}${api ? API_TIP : EST_TIP}`}>
      {api ? fmtCost(usd) : `≈ ${fmtCost(usd)} est.`}
    </span>
  )
}

const fmtReset = (w: PlanUsageWindow) => {
  if (!w.resetsAt) return ""
  const d = new Date(w.resetsAt * 1000)
  const sameDay = d.toDateString() === new Date().toDateString()
  const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  return `, resets ${sameDay ? t : `${d.toLocaleDateString([], { weekday: "short" })} ${t}`}`
}
const pct = (w: PlanUsageWindow) => `${Math.round(w.utilization * 100)}%`

export function planUsageText(u: PlanUsage): string {
  const parts: string[] = []
  if (u.fiveHour) parts.push(`${pct(u.fiveHour)} of 5-hour limit${fmtReset(u.fiveHour)}`)
  if (u.sevenDay) parts.push(`${pct(u.sevenDay)} of weekly limit${fmtReset(u.sevenDay)}`)
  return `Claude plan: ${parts.join(" · ")}${u.status === "rejected" ? " (limit reached)" : ""}`
}

/** Small meter for the 5-hour window (weekly in the tooltip). Hidden on an API key or before the first reading. */
export function PlanUsageMeter({ className }: { className?: string }) {
  const billing = useStudio((s) => s.billing)
  const u = useStudio((s) => s.planUsage)
  if (billing !== "plan" || !u) return null
  const w = u.fiveHour ?? u.sevenDay
  if (!w) return null
  const v = Math.min(1, Math.max(0, w.utilization))
  const hot = u.status !== "allowed" || v >= 0.8
  return (
    <span className={cn("flex items-center gap-1 text-micro text-muted-foreground", className)} title={planUsageText(u)}>
      Plan
      <span className="relative h-1.5 w-10 overflow-hidden rounded-full bg-muted">
        <span className={cn("absolute inset-y-0 left-0", hot ? "bg-warn" : "bg-primary/70")} style={{ width: `${v * 100}%` }} />
      </span>
      <span className="tabular-nums">{pct(w)}</span>
    </span>
  )
}
