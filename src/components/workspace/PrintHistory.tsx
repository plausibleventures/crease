// R15 follow-up: the project's prints, newest first, each with a way back into "How did it turn out?" — so a card
// put off with "Later" (or never seen) can still be filled in, and a saved rating can be changed.
import { useEffect, useState } from "react"
import type { PrintOutcomeRating, PrintRecord } from "@shared/types"
import { StarIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"
import { fmtDuration, fmtRelative } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useStudio } from "@/stores/studio"

const RATING: Record<PrintOutcomeRating, { label: string; tone: string }> = {
  great: { label: "Great", tone: "text-ok" },
  ok: { label: "OK", tone: "text-primary" },
  problem: { label: "Problem", tone: "text-warn" },
  failed: { label: "Failed", tone: "text-err" },
}

const STATE: Record<PrintRecord["state"], string> = { printing: "Printing now", complete: "Finished", cancelled: "Cancelled", error: "Stopped by an error" }

/** What the user said about a print: the structured rating, else the older success/failed result. */
export function ratingOf(p: Pick<PrintRecord, "outcome" | "result">): { label: string; tone: string } | null {
  if (p.outcome) return RATING[p.outcome.rating]
  if (p.result === "success") return { label: "Worked", tone: "text-ok" }
  if (p.result === "failed") return { label: "Failed", tone: "text-err" }
  return null
}

export function PrintHistory({ projectId, limit = 5, className }: { projectId: string; limit?: number; className?: string }) {
  const rev = useStudio((s) => s.printsRev)
  const open = useStudio((s) => s.openPrintResult)
  const [prints, setPrints] = useState<PrintRecord[] | null>(null)
  const [all, setAll] = useState(false)
  useEffect(() => {
    let alive = true
    api
      .listPrints(projectId)
      .then((l) => alive && setPrints(Array.isArray(l) ? l : []))
      .catch(() => alive && setPrints([]))
    return () => {
      alive = false
    }
  }, [projectId, rev])
  if (!prints?.length) return null
  const shown = all ? prints : prints.slice(0, limit)
  return (
    <div className={cn("flex flex-col", className)}>
      <ul className="flex flex-col divide-y divide-line" aria-label="Prints of this project">
        {shown.map((p) => {
          // practice prints: labelled, never rated (nothing was printed)
          const rating = p.practice ? null : ratingOf(p)
          const done = p.state !== "printing" && !p.practice
          return (
            <li key={p.id} className="flex items-center gap-2 py-1.5 text-xs">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-1.5">
                  {p.practice && <span className="border border-line-strong px-1 text-micro text-muted-foreground">Practice</span>}
                  <span className="text-foreground">{STATE[p.state]}</span>
                  <span className="text-caption text-muted-foreground">{fmtRelative(p.finishedAt ?? p.startedAt)}</span>
                  {p.actualDurationS != null && <span className="text-caption text-muted-foreground">{fmtDuration(p.actualDurationS)}</span>}
                </div>
                <div className="truncate text-caption text-muted-foreground">{p.partIds.join(", ") || p.gcodeName}</div>
              </div>
              {rating ? (
                <span className={cn("flex items-center gap-1 text-caption", rating.tone)}>
                  <StarIcon className="size-3" /> {rating.label}
                </span>
              ) : done ? (
                <span className="text-caption text-muted-foreground">Not rated</span>
              ) : null}
              {done && (
                <Button
                  size="xs"
                  variant={rating ? "ghost" : "outline"}
                  onClick={() => open({ printId: p.id, projectId, state: p.state })}
                  aria-label={rating ? `Change how the print from ${fmtRelative(p.finishedAt ?? p.startedAt)} turned out` : `Say how the print from ${fmtRelative(p.finishedAt ?? p.startedAt)} turned out`}
                >
                  {rating ? "Change" : "How did it turn out?"}
                </Button>
              )}
            </li>
          )
        })}
      </ul>
      {prints.length > limit && (
        <button className="self-start pt-1 text-caption text-muted-foreground hover:text-foreground hover:underline" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${prints.length} prints`}
        </button>
      )}
    </div>
  )
}
