// "Out of date — re-run" strip for a derived artifact (checks, renders, guide, motion check) whose sources changed
// since it was made (R07: server-computed from content hashes, GET /api/projects/:id/validity).
import type { ArtifactValidity } from "@shared/types"
import { Loader2Icon, RefreshCwIcon, TriangleAlertIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { usePlain } from "@/lib/use-plain"

/** Short plain-words reason line: the first two reasons, then "+N more". */
export function reasonText(v: ArtifactValidity, plain: (s: string) => string = (s) => s): string {
  const r = v.reasons.map(plain)
  if (!r.length) return ""
  return r.length <= 2 ? r.join(" · ") : `${r.slice(0, 2).join(" · ")} · +${r.length - 2} more`
}

export function StaleNote({
  validity,
  onRerun,
  busy,
  label = "Re-run",
  text = "Out of date — re-run",
  className,
}: {
  validity: ArtifactValidity | null | undefined
  onRerun?: () => void
  busy?: boolean
  label?: string
  /** the strip's words; say what the button does (e.g. "Out of date — rebuild the guide") */
  text?: string
  className?: string
}) {
  const plain = usePlain()
  if (validity?.state !== "stale") return null
  return (
    <div
      role="status"
      className={cn("flex min-h-7 shrink-0 items-center gap-2 border-b border-warn/30 bg-warn/10 px-2 py-1 text-caption text-warn", className)}
      title={validity.reasons.join("\n")}
    >
      <TriangleAlertIcon className="size-3.5 shrink-0" />
      <span className="shrink-0 font-medium">{text}</span>
      <span className="min-w-0 flex-1 truncate text-micro text-warn">{reasonText(validity, plain)}</span>
      {onRerun && (
        <Button size="xs" variant="ghost" className="shrink-0 text-warn hover:text-warn" disabled={busy} onClick={onRerun}>
          {busy ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />} {label}
        </Button>
      )}
    </div>
  )
}
