// One-click fix for a setup check: a download/install page, adding an Anthropic API key, using the user's own signed-in
// Claude Code, or a Codex / Grok sign-in. Also used by the Agents screen. Crease never signs in to Claude itself in
// public builds (docs/licenses/INVENTORY.md B1); "claude-login" only appears with PRINTSTUDIO_DEV_CLAUDE_LOGIN=1.
import { useState } from "react"
import { toast } from "sonner"
import type { SetupFix } from "@shared/types"
import { ExternalLinkIcon, KeyIcon, Loader2Icon, SparklesIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { api, errMsg } from "@/lib/api"
import { SignInDialog } from "@/components/agents/SignIn"

export function SetupFixButton({
  fix,
  size = "sm",
  variant,
  onDone,
}: {
  fix: SetupFix
  size?: "sm" | "default"
  variant?: "default" | "outline"
  /** Called after a fix that changed something (key saved, sign-in switched), e.g. to re-run the checks. */
  onDone?: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [keyOpen, setKeyOpen] = useState(false)
  const [key, setKey] = useState("")
  const [signIn, setSignIn] = useState(false)
  if (fix.kind === "codex-login" || fix.kind === "grok-login") {
    // Browser sign-in in a modal: Grok's page asks for the code it shows, so the code stays on screen until done.
    const kind = fix.kind === "grok-login" ? "grok" : "codex"
    return (
      <>
        <Button size={size} variant={variant} onClick={() => setSignIn(true)}>
          <SparklesIcon /> {fix.label}
        </Button>
        <SignInDialog kind={kind} open={signIn} onOpenChange={setSignIn} onDone={onDone} />
      </>
    )
  }
  if (fix.kind === "open-url")
    return (
      <Button variant={variant ?? "outline"} size={size} onClick={() => window.open(fix.url, "_blank", "noopener")}>
        <ExternalLinkIcon /> {fix.label}
      </Button>
    )
  if (fix.kind === "anthropic-key") {
    const profileId = fix.profileId
    const save = async () => {
      setBusy(true)
      try {
        await api.setAgentProfileKey(profileId, key.trim())
        setKey("")
        setKeyOpen(false)
        toast.success("API key saved", { description: "The designer uses it now. Messages are billed to your Anthropic account." })
        onDone?.()
      } catch (e) {
        toast.error("Couldn't save the key", { description: errMsg(e) })
      } finally {
        setBusy(false)
      }
    }
    if (!keyOpen)
      return (
        <Button variant={variant} size={size} onClick={() => setKeyOpen(true)}>
          <KeyIcon /> {fix.label}
        </Button>
      )
    return (
      <form
        className="flex w-full max-w-md flex-wrap items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault()
          if (key.trim()) void save()
        }}
      >
        <Input
          type="password"
          autoFocus
          autoComplete="off"
          aria-label="Anthropic API key"
          placeholder="sk-ant-…"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          className="h-7 min-w-0 flex-1 font-mono text-xs"
        />
        <Button size="sm" type="submit" disabled={busy || !key.trim()}>
          {busy ? <Loader2Icon className="animate-spin" /> : null} Save key
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={() => window.open("https://console.anthropic.com/settings/keys", "_blank", "noopener")}>
          <ExternalLinkIcon /> Get a key
        </Button>
      </form>
    )
  }
  return (
    <Button
      size={size}
      variant={variant}
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          if (fix.kind === "claude-use-login") {
            await api.updateAgentProfile(fix.profileId, { auth: { kind: "subscription" } })
            toast.success("Using your Claude Code sign-in", { description: "The designer uses your Claude plan through your own Claude Code." })
            onDone?.()
            return
          }
          // Dev only (PRINTSTUDIO_DEV_CLAUDE_LOGIN=1).
          const r = await api.claudeLogin()
          if (r.ok) toast.success("Terminal opened", { description: "Finish signing in there and in your browser, then come back." })
          else toast.error("Couldn't open the sign-in", { description: `${r.error ?? ""} Run this in Terminal: ${r.command}` })
        } catch (e) {
          toast.error(fix.kind === "claude-use-login" ? "Couldn't switch the sign-in" : "Couldn't open the sign-in", { description: errMsg(e) })
        } finally {
          setBusy(false)
        }
      }}
    >
      {busy ? <Loader2Icon className="animate-spin" /> : <SparklesIcon />} {fix.label}
    </Button>
  )
}
