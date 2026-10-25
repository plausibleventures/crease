// Small pieces shared by the Designers screen and its modals: health of a designer, "?" hints, the stepper header,
// the API key field and the capability list (shown only behind "More").
import { useState, type ReactNode } from "react"
import { toast } from "sonner"
import type { AgentConnectionResult, AgentProfile, AgentProfileView, AgentRuntimeCapabilities, AgentRuntimeInfo, AgentRuntimeProbe } from "@shared/types"
import { CheckCircle2Icon, CheckIcon, CircleHelpIcon, ExternalLinkIcon, Loader2Icon, XCircleIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { api, errMsg } from "@/lib/api"
import { cn } from "@/lib/utils"


// ---- health ----

type Tri = boolean | null
export interface Health {
  installed: Tri
  signedIn: Tri
  ready: Tri
  /** One or two words for the table. */
  label: string
  tone: "ok" | "warn" | "err" | "muted"
  /** What the row's one button does next, if anything. */
  next: "sign-in" | "add-key" | "install" | "allow" | "check" | null
}

const isLocal = (u: string | null | undefined) => /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0|[\w-]+\.local)(:\d+)?(\/|$)/i.test(u ?? "")
/** A local OpenAI-compatible server (Ollama, LM Studio) needs no key. */
export const keyOptional = (p: Pick<AgentProfile, "runtime" | "apiProtocol" | "endpointRef">) => p.runtime === "api" && p.apiProtocol === "openai-chat" && isLocal(p.endpointRef)

export function profileHealth(p: AgentProfileView, info: AgentRuntimeInfo | undefined, probe: AgentRuntimeProbe | undefined): Health {
  const h = (installed: Tri, signedIn: Tri, ready: Tri, label: string, tone: Health["tone"], next: Health["next"] = null): Health => ({ installed, signedIn, ready, label, tone, next })
  if (info && !info.available) return h(false, null, false, "Coming soon", "muted")
  if (!probe) return h(null, null, null, "Checking…", "muted")
  if (!probe.installed) return h(false, null, false, "Not installed", "err", "install")
  if (p.auth.kind === "api-key") {
    const c = p.credential
    if (!c?.set && keyOptional(p)) return h(true, null, true, "Ready", "ok")
    if (!c?.set) return h(true, false, false, "Not set up", "warn", "add-key")
    if (c.locked) return h(true, null, false, "Key locked", "warn", "add-key")
    return h(true, true, true, "Ready", "ok")
  }
  // signed in, but the runtime can't start yet (Codex: your own login waits for your OK on partial isolation)
  if (probe.auth.status === "ok" && probe.ready === false) return h(true, true, false, "Needs your OK", "warn", "allow")
  if (probe.auth.status === "ok") return h(true, true, true, "Ready", "ok")
  if (probe.auth.status === "missing") return h(true, false, false, "Not set up", "warn", "sign-in")
  return h(true, null, null, "Couldn't check", "warn", "check")
}

export const TONE = { ok: "text-ok", warn: "text-warn", err: "text-err", muted: "text-muted-foreground" } as const
const DOT = { ok: "bg-ok", warn: "bg-warn", err: "bg-err", muted: "bg-muted-foreground" } as const

export function StatusDot({ h }: { h: Health }) {
  return (
    <span className={cn("flex items-center gap-1.5 text-xs", TONE[h.tone])} role="status">
      <span className={cn("size-2 shrink-0 rounded-full", DOT[h.tone])} aria-hidden />
      {h.label}
    </span>
  )
}

/** The secret ref a profile's key lives under. */
export const keyRef = (p: Pick<AgentProfileView, "auth" | "id" | "runtime">) =>
  p.auth.kind === "api-key" ? p.auth.credentialRef : p.id === "claude" && p.runtime === "claude" ? "anthropic.apiKey" : `profile.${p.id}.apiKey`

// ---- "?" hint ----

export function Hint({ children, label = "More info" }: { children: ReactNode; label?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<button type="button" aria-label={label} className="inline-flex shrink-0 items-center text-muted-foreground hover:text-foreground" />}
      >
        <CircleHelpIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent className="block max-w-72 py-1.5 text-caption">{children}</TooltipContent>
    </Tooltip>
  )
}

// ---- stepper header ----

export function StepDots({ steps, at }: { steps: string[]; at: number }) {
  return (
    <ol className="flex items-center gap-1.5 text-caption" aria-label="Steps">
      {steps.map((s, i) => (
        <li key={s} className="flex items-center gap-1.5" aria-current={i === at ? "step" : undefined}>
          {i > 0 && <span className="h-px w-4 bg-line-strong" aria-hidden />}
          <span
            className={cn(
              "flex size-5 items-center justify-center rounded-full border text-micro",
              i < at && "border-primary bg-primary text-primary-foreground",
              i === at && "border-primary text-primary",
              i > at && "text-muted-foreground",
            )}
          >
            {i < at ? <CheckIcon className="size-3" /> : i + 1}
          </span>
          <span className={cn(i === at ? "text-foreground" : "text-muted-foreground", "hidden sm:inline")}>{s}</span>
        </li>
      ))}
    </ol>
  )
}

// ---- API key ----

export function KeyField({ p, getKeyUrl, onChanged }: { p: AgentProfileView; getKeyUrl?: string; onChanged: (v: AgentProfileView) => void }) {
  const [value, setValue] = useState("")
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const c = p.auth.kind === "api-key" ? p.credential : null
  const save = async () => {
    setBusy(true)
    try {
      onChanged(await api.setAgentProfileKey(p.id, value.trim()))
      setValue("")
      setEditing(false)
      toast.success("Key saved")
    } catch (e) {
      toast.error("Couldn't save the key", { description: errMsg(e) })
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    setBusy(true)
    try {
      onChanged(await api.removeAgentProfileKey(p.id))
      toast.success("Key removed")
    } catch (e) {
      toast.error("Couldn't remove the key", { description: errMsg(e) })
    } finally {
      setBusy(false)
      setConfirmRemove(false)
    }
  }
  return (
    <div className="flex flex-col gap-1">
      {c?.set && !editing && (
        <div className="flex flex-wrap items-center gap-2 text-caption">
          <CheckCircle2Icon className="size-3.5 text-ok" />
          <span className="font-mono">{c.last4 ?? "Key saved"}</span>
          <Hint>{c.source === "os-keychain" ? "Kept in your keychain." : c.source === "env" ? "Comes from the environment." : "Kept in a local file."}</Hint>
          {c.source !== "env" &&
            (confirmRemove ? (
              <span role="alert" className="flex items-center gap-1">
                <Button size="xs" variant="destructive" disabled={busy} onClick={() => void remove()}>
                  Remove key
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setConfirmRemove(false)}>
                  Keep
                </Button>
              </span>
            ) : (
              <>
                <Button size="xs" variant="outline" onClick={() => setEditing(true)}>
                  Replace
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setConfirmRemove(true)}>
                  Remove
                </Button>
              </>
            ))}
        </div>
      )}
      {c?.locked && <span className="text-caption text-warn">Locked by the desktop app. Paste it again here.</span>}
      {(!c?.set || editing || c.source === "env") && (
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            if (value.trim()) void save()
          }}
        >
          <Input type="password" autoComplete="off" aria-label="API key" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Paste your key" className="h-7 font-mono" />
          <Button size="sm" type="submit" disabled={busy || !value.trim()}>
            {busy && <Loader2Icon className="animate-spin" />}Save
          </Button>
        </form>
      )}
      {!c?.set && getKeyUrl && (
        <a className="text-caption text-primary hover:underline" href={getKeyUrl} target="_blank" rel="noreferrer">
          Get a key <ExternalLinkIcon className="inline size-3" />
        </a>
      )}
    </div>
  )
}

// ---- capabilities (behind "More") ----

const CAPS: { key: string; label: string; has: (c: AgentRuntimeCapabilities) => boolean }[] = [
  { key: "images", label: "Sees photos", has: (c) => c.images },
  { key: "questions", label: "Asks questions", has: (c) => c.userQuestions },
  { key: "tools", label: "Uses app tools", has: (c) => c.appTools },
  { key: "resume", label: "Remembers chats", has: (c) => c.resume },
  { key: "models", label: "Switches model mid-chat", has: (c) => c.modelSwitch },
  { key: "fork", label: "Keeps chat on “Try another”", has: (c) => c.fork },
  { key: "sandbox", label: "Sandboxed", has: (c) => c.isolation.workspaceWrites && c.isolation.network },
]

export function Capabilities({ caps }: { caps: AgentRuntimeCapabilities | undefined }) {
  if (!caps) return null
  return (
    <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5" aria-label="What it can do">
      {CAPS.map((c) => {
        const ok = c.has(caps)
        return (
          <li key={c.key} className={cn("flex items-center gap-1.5 text-caption", !ok && "text-muted-foreground")}>
            {ok ? <CheckCircle2Icon className="size-3 shrink-0 text-ok" /> : <XCircleIcon className="size-3 shrink-0 text-faint" />}
            {c.label}
          </li>
        )
      })}
    </ul>
  )
}

export function TestResult({ r }: { r: AgentConnectionResult }) {
  return (
    <div className={cn("flex flex-col gap-1 border p-2", r.ok ? "border-ok/40 bg-ok/5" : "border-warn/40 bg-warn/5")} role="status">
      {r.steps.map((s) => (
        <div key={s.label} className="flex items-center gap-1.5 text-caption">
          {s.ok === true ? <CheckCircle2Icon className="size-3.5 text-ok" /> : s.ok === false ? <XCircleIcon className="size-3.5 text-err" /> : <CircleHelpIcon className="size-3.5 text-muted-foreground" />}
          <span>{s.label}</span>
          {s.detail && <Hint>{s.detail}</Hint>}
        </div>
      ))}
      <div className={cn("text-xs", r.ok ? "text-ok" : "text-foreground")}>{r.summary}</div>
    </div>
  )
}
