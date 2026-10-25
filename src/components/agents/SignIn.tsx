// Browser sign-in for a designer's own home (Codex: ChatGPT; Grok: device code), as steps inside a modal:
// 1 open the sign-in page (Grok: with the code shown big + Copy), 2 wait while the app polls, 3 signed in.
// Grok's sign-in page asks the user to type or check the code, so the code stays on screen until it's done.
import { useEffect, useRef, useState } from "react"
import type { RuntimeLoginStatus } from "@shared/types"
import { CheckCircle2Icon, ExternalLinkIcon, Loader2Icon, SparklesIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { api, errMsg } from "@/lib/api"
import { cn } from "@/lib/utils"

export type BrowserLoginKind = "codex" | "grok"

const ACCOUNT: Record<BrowserLoginKind, string> = { codex: "ChatGPT", grok: "Grok" }

type Phase = { at: "idle" } | { at: "starting" } | { at: "waiting"; authUrl: string; code: string | null } | { at: "done" } | { at: "failed"; error: string }

/** The sign-in, inline. `onDone` fires once when it succeeds. */
export function BrowserSignIn({ kind, onDone, autoStart = false }: { kind: BrowserLoginKind; onDone?: () => void; autoStart?: boolean }) {
  const [phase, setPhase] = useState<Phase>(autoStart ? { at: "starting" } : { at: "idle" })
  const [copied, setCopied] = useState(false)
  const done = useRef(onDone)
  useEffect(() => {
    done.current = onDone
  }, [onDone])

  const start = () => {
    setPhase({ at: "starting" })
    void request()
  }
  const request = async () => {
    try {
      if (kind === "grok") {
        const { authUrl, code } = await api.grokLogin()
        setPhase({ at: "waiting", authUrl, code })
      } else {
        const { authUrl } = await api.codexLogin()
        setPhase({ at: "waiting", authUrl, code: null })
        window.open(authUrl, "_blank", "noopener") // nothing to copy for ChatGPT: go straight there
      }
    } catch (e) {
      setPhase({ at: "failed", error: errMsg(e) })
    }
  }

  const autoStarted = useRef(false) // once, also under StrictMode's double effects (a second start replaces the code)
  useEffect(() => {
    if (!autoStart || autoStarted.current) return
    autoStarted.current = true
    void request()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // poll until the CLI says it's finished
  const waiting = phase.at === "waiting"
  useEffect(() => {
    if (!waiting) return
    let alive = true
    const tick = async () => {
      try {
        const s: RuntimeLoginStatus = await api.runtimeLoginStatus(kind)
        if (!alive) return
        if (s.state === "done") {
          setPhase({ at: "done" })
          done.current?.()
        } else if (s.state === "failed") setPhase({ at: "failed", error: s.error ?? "The sign-in didn't finish." })
      } catch {
        /* server busy: try again next tick */
      }
    }
    const t = window.setInterval(() => void tick(), 1500)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [waiting, kind])

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked: the code is on screen */
    }
  }

  if (phase.at === "idle" || phase.at === "starting")
    return (
      <Button size="sm" disabled={phase.at === "starting"} onClick={start}>
        {phase.at === "starting" ? <Loader2Icon className="animate-spin" /> : <SparklesIcon />} Sign in with {ACCOUNT[kind]}
      </Button>
    )
  if (phase.at === "done")
    return (
      <div className="flex items-center gap-1.5 text-xs text-ok" role="status">
        <CheckCircle2Icon className="size-4" /> Signed in
      </div>
    )
  if (phase.at === "failed")
    return (
      <div className="flex flex-col items-start gap-1.5" role="alert">
        <span className="text-xs text-err">{phase.error}</span>
        <Button size="sm" variant="outline" onClick={start}>
          Try again
        </Button>
      </div>
    )
  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      {phase.code && (
        <div className="flex flex-col items-center gap-2 border border-line-strong bg-muted/30 px-3 py-4">
          <span className="text-caption text-muted-foreground">Your code</span>
          <span className="font-mono text-3xl font-semibold tracking-[0.2em] text-foreground select-all" aria-label="Sign-in code">
            {phase.code}
          </span>
          <Button size="xs" variant="outline" onClick={() => void copy(phase.code!)}>
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      )}
      <ol className="flex flex-col gap-1.5 text-xs">
        <li className="flex items-center gap-2">
          <span className="w-4 text-center text-muted-foreground">1</span>
          <Button size="sm" variant={phase.code ? "default" : "outline"} onClick={() => window.open(phase.authUrl, "_blank", "noopener")}>
            <ExternalLinkIcon /> Open sign-in page
          </Button>
        </li>
        <li className="flex items-center gap-2">
          <span className="w-4 text-center text-muted-foreground">2</span>
          <span>{phase.code ? `Type or check the code, then approve.` : `Sign in with your ${ACCOUNT[kind]} account.`}</span>
        </li>
        <li className={cn("flex items-center gap-2 text-muted-foreground")}>
          <span className="w-4 text-center">3</span>
          <Loader2Icon className="size-3.5 animate-spin" /> Waiting for you…
        </li>
      </ol>
    </div>
  )
}

/** The sign-in as its own modal (row "Sign in" button, setup checks). Cancels a waiting sign-in when closed early. */
export function SignInDialog({ kind, open, onOpenChange, onDone }: { kind: BrowserLoginKind; open: boolean; onOpenChange: (o: boolean) => void; onDone?: () => void }) {
  const [finished, setFinished] = useState(false)
  const close = (o: boolean) => {
    if (!o && !finished) void api.cancelRuntimeLogin(kind).catch(() => {})
    if (!o) setFinished(false)
    onOpenChange(o)
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Sign in to {kind === "grok" ? "Grok" : "Codex"}</DialogTitle>
        </DialogHeader>
        {open && (
          <BrowserSignIn
            kind={kind}
            autoStart
            onDone={() => {
              setFinished(true)
              onDone?.()
            }}
          />
        )}
        {finished && (
          <Button size="sm" onClick={() => close(false)}>
            Done
          </Button>
        )}
      </DialogContent>
    </Dialog>
  )
}
