import type { AdjustedTime } from "@shared/types"
import { fmtDuration } from "@/lib/format"
import { cn } from "@/lib/utils"

/** "From your last N prints" label for an estimate scaled by the machine's measured time factor (R15). */
export function adjustedLabel(a: AdjustedTime): string {
  const n = `${a.prints} print${a.prints === 1 ? "" : "s"}`
  return `≈ adjusted from your last ${n}${a.scope === "machine" ? " on this printer" : ""}: they took about ${a.factor}× the slicer's estimate (it said ${fmtDuration(a.rawEstimateS)})`
}

/**
 * A print-time estimate: the slicer's number, or the calibrated one ("≈ 42m") when finished prints showed this machine
 * runs slower/faster than the slicer thinks. `items` sums several plates.
 */
export function EstimatedTime({ items, className, showNote = false }: { items: { estimatedTimeS: number | null; adjustedTime?: AdjustedTime | null }[]; className?: string; showNote?: boolean }) {
  const adjusted = items.find((i) => i.adjustedTime)?.adjustedTime ?? null
  const raw = items.reduce((a, i) => a + (i.estimatedTimeS ?? 0), 0)
  if (!adjusted) return <span className={className}>{items.some((i) => i.estimatedTimeS != null) ? fmtDuration(raw) : fmtDuration(null)}</span>
  const total = items.reduce((a, i) => a + (i.adjustedTime?.estimatedTimeS ?? i.estimatedTimeS ?? 0), 0)
  const label = adjustedLabel({ ...adjusted, rawEstimateS: raw })
  return (
    <span className={cn("cursor-help", className)} title={label}>
      ≈ {fmtDuration(total)}
      {showNote && (
        <span className="ml-1.5 font-sans text-caption text-muted-foreground">
          adjusted from your last {adjusted.prints} print{adjusted.prints === 1 ? "" : "s"} (slicer: {fmtDuration(raw)})
        </span>
      )}
    </span>
  )
}
