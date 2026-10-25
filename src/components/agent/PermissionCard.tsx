// A permission request from the design agent (R11d: runtimes with permission callbacks, e.g. Codex asking to read
// a file outside the project). The app's policy has already refused anything unsafe; what's left is the user's call.
// Plain words, two big buttons: Allow once / Deny.
import { useState } from "react"
import { toast } from "sonner"
import { Loader2Icon, ShieldCheckIcon } from "@/components/icons"
import type { AgentPermissionRequest } from "@shared/types"
import { Button } from "@/components/ui/button"
import { api, errMsg } from "@/lib/api"

export function PermissionCard({ projectId, request }: { projectId: string; request: AgentPermissionRequest }) {
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null)
  const answer = async (allow: boolean) => {
    setBusy(allow ? "allow" : "deny")
    try {
      await api.answerPermission(projectId, request.requestId, allow)
    } catch (e) {
      toast.error(errMsg(e))
      setBusy(null)
    }
  }
  return (
    <div className="flex flex-col gap-1.5 border border-warn/40 bg-warn/5 p-2.5" role="alertdialog" aria-label={request.title}>
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <ShieldCheckIcon className="size-3.5 shrink-0 text-warn" />
        {request.title}
      </div>
      {request.detail && (
        <div className="line-clamp-2 font-mono text-caption whitespace-pre-wrap text-muted-foreground" title={request.detail}>
          {request.detail}
        </div>
      )}
      <div className="flex gap-2">
        <Button size="sm" onClick={() => answer(true)} disabled={busy !== null}>
          {busy === "allow" && <Loader2Icon className="size-3.5 animate-spin" />}
          Allow once
        </Button>
        <Button size="sm" variant="outline" onClick={() => answer(false)} disabled={busy !== null}>
          {busy === "deny" && <Loader2Icon className="size-3.5 animate-spin" />}
          Don't allow
        </Button>
      </div>
    </div>
  )
}
