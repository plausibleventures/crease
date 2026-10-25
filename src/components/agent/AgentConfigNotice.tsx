// R09 follow-up: "this project came with its own assistant settings". A project copied, cloned or imported from
// somewhere else can carry instructions and settings for Claude or Codex; Crease keeps them off (moved to
// .studio/agent-config-disabled/) until the user turns them on here. Shows what was turned off, in plain words, with
// a clear warning before turning anything on, and a way to turn it back off.
import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import type { AgentConfigStatus } from "@shared/types"
import { ChevronDownIcon, Loader2Icon, ShieldCheckIcon, TriangleAlertIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { describeAgentConfigItem } from "@/lib/agent-config"
import { api, errMsg } from "@/lib/api"
import { cn } from "@/lib/utils"
import { useStudio } from "@/stores/studio"

export function AgentConfigNotice({ projectId }: { projectId: string }) {
  const running = useStudio((s) => !!s.agent[projectId]?.running)
  const sessionId = useStudio((s) => s.agent[projectId]?.sessionId ?? null)
  const [st, setSt] = useState<AgentConfigStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState<"on" | "off" | null>(null)
  const [n, setN] = useState(0)
  const reload = useCallback(() => setN((x) => x + 1), [])

  useEffect(() => {
    let alive = true
    api
      .agentConfig(projectId)
      .then((s) => alive && setSt(s ?? null))
      .catch(() => alive && setSt(null))
    return () => {
      alive = false
    }
    // a session start moves untrusted items aside: look again when one starts or ends
  }, [projectId, running, sessionId, n])

  if (!st) return null
  const off = [...st.disabled, ...st.pending]
  const on = st.enabled
  if (!off.length && !on.length) return null
  const items = (off.length ? off : on).map(describeAgentConfigItem)
  const runs = items.some((i) => i.runsCommands)

  const enable = async () => {
    setBusy("on")
    try {
      const r = await api.enableAgentConfig(projectId)
      if (r.skipped.length) toast.warning("Some settings weren't turned on", { description: `Something new is in their place: ${r.skipped.join(", ")}` })
      else toast.success("Turned on", { description: "Used from the next new chat." })
      setConfirm(false)
    } catch (e) {
      toast.error("Couldn't turn them on", { description: errMsg(e) })
    } finally {
      setBusy(null)
      reload()
    }
  }
  const disable = async () => {
    setBusy("off")
    try {
      await api.disableAgentConfig(projectId)
      toast.success("Turned off", { description: "Nothing was deleted." })
    } catch (e) {
      toast.error("Couldn't turn them off", { description: errMsg(e) })
    } finally {
      setBusy(null)
      reload()
    }
  }

  return (
    <section
      aria-label="This project's own assistant settings"
      className={cn("shrink-0 border-b px-2 py-1.5 text-xs", off.length ? "bg-warn/5" : "bg-card")}
    >
      <button className="flex w-full items-center gap-1.5 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {off.length ? <ShieldCheckIcon className="size-3.5 shrink-0 text-warn" /> : <TriangleAlertIcon className="size-3.5 shrink-0 text-warn" />}
        <span className="min-w-0 flex-1">
          {off.length
            ? `This project came with its own assistant settings (${off.length}). They're off for your safety.`
            : `This project's own assistant settings are on (${on.length}).`}
        </span>
        <span className={cn("flex shrink-0 items-center gap-1 text-caption text-muted-foreground", open && "text-foreground")}>
          <span className="font-medium">Review</span>
          <ChevronDownIcon className={cn("size-3 transition-transform duration-150 motion-reduce:transition-none", open && "rotate-180")} aria-hidden />
        </span>
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-2 pl-5">
          <p className="text-caption text-muted-foreground">
            {off.length
              ? "Made elsewhere. The designer ignores these until you turn them on."
              : "The designer follows these too."}
          </p>
          <ul className="flex flex-col gap-1" aria-label={off.length ? "Turned off" : "Turned on"}>
            {items.map((i) => (
              <li key={i.path} className="flex flex-col">
                <span className="font-mono text-caption text-foreground">{i.path}</span>
                <span className={cn("text-caption", i.runsCommands ? "text-warn" : "text-muted-foreground")}>{i.what}</span>
              </li>
            ))}
          </ul>
          {off.length > 0 ? (
            confirm ? (
              <div role="alertdialog" aria-label="Turn on this project's settings?" className="flex flex-col gap-2 border border-warn/50 bg-warn/10 p-2">
                <p className="flex gap-1.5 text-xs text-foreground">
                  <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-warn" />
                  <span>
                    Only turn this on for projects you trust{runs ? ": these settings can run commands on your computer." : "."} They're used from the designer's next start.
                  </span>
                </p>
                <div className="flex gap-1.5">
                  <Button size="sm" variant="destructive" disabled={!!busy} onClick={() => void enable()}>
                    {busy === "on" && <Loader2Icon className="animate-spin" />} I trust it, turn them on
                  </Button>
                  <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setConfirm(false)}>
                    Keep them off
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="xs" variant="outline" onClick={() => setConfirm(true)}>
                  Turn them on…
                </Button>
                <span className="text-caption text-muted-foreground">Recommended: leave them off.</span>
              </div>
            )
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="xs" variant="outline" disabled={!!busy} onClick={() => void disable()}>
                {busy === "off" && <Loader2Icon className="animate-spin" />} Turn them off
              </Button>
              <span className="text-caption text-muted-foreground">Nothing is deleted; you can turn them on again.</span>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
