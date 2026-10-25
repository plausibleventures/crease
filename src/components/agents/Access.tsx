// "How it's paid": one line per choice (recommended first; an empty key route is never shown as picked), then what that choice needs right below
// it: a browser sign-in (Codex, Grok), your own Claude Code, or an API key. Used by Add designer (step 2) and Edit.
import { useState } from "react"
import type { AgentProfile, AgentProfileView, AgentRuntimeInfo, AgentRuntimeProbe, ApiProtocol, CodexRuntimeSettings } from "@shared/types"
import { CheckCircle2Icon, ExternalLinkIcon, RefreshCwIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { OptionSelect } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { CODEX_MODES, codexMode, codexModeChange, type CodexMode } from "./codex-access"
import { Hint, KeyField, keyOptional, keyRef } from "./parts"
import { BrowserSignIn } from "./SignIn"

type Save = (patch: Partial<AgentProfile>, what?: string) => Promise<boolean>

export interface AccessProps {
  p: AgentProfileView
  info: AgentRuntimeInfo | undefined
  probe: AgentRuntimeProbe | undefined
  codex: CodexRuntimeSettings | undefined
  onCodex: (patch: CodexRuntimeSettings) => Promise<boolean>
  /** A changed profile (saved, or a local switch to a key that isn't saved yet). */
  onChanged: (v: AgentProfileView) => void
  save: Save
  /** Ask the server again whether it's signed in. */
  onProbe: () => void
  busy?: boolean
}

interface Choice {
  id: string
  label: string
  hint: string
  more?: string
}

const PLAN_MORE = "No charge per message. It uses your plan's limits. Costs in the app are estimates."
const KEY_MORE = "Each message is billed to this key. Costs in the app are real charges."

function choicesFor(runtime: string, info: AgentRuntimeInfo | undefined): Choice[] {
  const key: Choice = { id: "api-key", label: info?.apiKeyLabel ?? "API key", hint: "Pay per message.", more: KEY_MORE }
  if (runtime === "claude") return [{ id: "subscription", label: "My Claude Code", hint: "Your Claude plan.", more: PLAN_MORE }, key]
  if (runtime === "grok") return [{ id: "subscription", label: "Grok account", hint: "Sign in with Grok.", more: PLAN_MORE }, key]
  if (runtime === "codex")
    return CODEX_MODES.map((m) => ({
      id: m.mode,
      label: m.label,
      hint: m.hint,
      more: m.mode === "api-key" ? KEY_MORE : m.mode === "user" ? "Uses the Codex you signed in to yourself (~/.codex)." : PLAN_MORE,
    }))
  return (info?.authKinds ?? ["subscription"]).map((k) => (k === "api-key" ? key : { id: k, label: info?.subscriptionLabel ?? "My plan", hint: "" }))
}

function Radio({ c, on, recommended, disabled, onPick }: { c: Choice; on: boolean; recommended: boolean; disabled?: boolean; onPick: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        role="radio"
        aria-checked={on}
        disabled={disabled}
        onClick={onPick}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 border px-2 py-1.5 text-left text-xs hover:border-line-strong disabled:opacity-60",
          on ? "border-primary/60 bg-primary/10" : "border-line",
        )}
      >
        <span className={cn("flex size-3.5 shrink-0 items-center justify-center rounded-full border", on ? "border-primary" : "border-muted-foreground")}>
          {on && <span className="size-1.5 rounded-full bg-primary" />}
        </span>
        <span className="shrink-0 font-medium whitespace-nowrap">{c.label}</span>
        {c.hint && <span className="truncate text-muted-foreground">· {c.hint}</span>}
        {recommended && <span className="ms-auto shrink-0 border border-primary/40 px-1 text-micro text-primary">Recommended</span>}
      </button>
      {c.more && <Hint>{c.more}</Hint>}
    </div>
  )
}

function SignedIn({ plan }: { plan?: string | null }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-ok" role="status">
      <CheckCircle2Icon className="size-3.5" /> Signed in{plan ? ` · ${plan} plan` : ""}
    </span>
  )
}

const API_PROTOCOLS: { value: ApiProtocol; label: string; more: string; placeholder: string }[] = [
  { value: "anthropic", label: "Anthropic (Claude API)", more: "Tested. Costs come from Anthropic's prices.", placeholder: "https://api.anthropic.com" },
  {
    value: "openai-chat",
    label: "OpenAI-compatible (experimental)",
    more: "OpenAI, Ollama or LM Studio. Untested with real servers. Token counts only, no costs.",
    placeholder: "http://localhost:11434/v1",
  },
]

export function AccessPicker({ p, info, probe, codex, onCodex, onChanged, save, onProbe, busy }: AccessProps) {
  const [working, setWorking] = useState(false)
  const choices = choicesFor(p.runtime, info)
  const isCodex = p.runtime === "codex"
  const saved = isCodex ? codexMode(p.auth, codex) : p.auth.kind
  // DES-01: a pay-per-message key with no key in it yet is the install default, not the user's choice. Show nothing
  // picked (so the paid route is never preselected next to a "Recommended" free one) until the user picks.
  const unchosen = saved === "api-key" && !p.credential?.set && choices.length > 1 && choices[0].id !== "api-key"
  const [picked, setPicked] = useState<string | null>(null)
  const current = picked ?? (unchosen ? null : saved)
  const off = busy || working
  const signedIn = probe?.auth.status === "ok"

  const pick = async (id: string) => {
    setPicked(id)
    if (id === saved) return
    setWorking(true)
    try {
      if (isCodex) {
        const change = codexModeChange(id as CodexMode, { auth: p.auth, settings: codex, keyRef: keyRef(p) })
        if (change.login && !(await onCodex({ login: change.login }))) return setPicked(null)
        if (change.auth) {
          if (change.auth.kind === "api-key" && !p.credential?.set) onChanged({ ...p, auth: change.auth, credential: { set: false, source: null } })
          else await save({ auth: change.auth }, "change the sign-in")
        }
        return
      }
      if (id === "subscription") {
        if (!(await save({ auth: { kind: "subscription" } }, "change the sign-in"))) setPicked(null)
      } else if (p.credential?.set) {
        if (!(await save({ auth: { kind: "api-key", credentialRef: keyRef(p) } }, "change the sign-in"))) setPicked(null)
      }
      else onChanged({ ...p, auth: { kind: "api-key", credentialRef: keyRef(p) }, credential: p.credential ?? { set: false, source: null } })
    } finally {
      setWorking(false)
    }
  }

  const keyUrl = p.runtime === "api" && p.apiProtocol === "openai-chat" ? undefined : info?.apiKeyUrl

  if (p.runtime === "api") {
    const proto = API_PROTOCOLS.find((x) => x.value === (p.apiProtocol ?? "anthropic")) ?? API_PROTOCOLS[0]
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="w-20 shrink-0 text-muted-foreground">Service</span>
          <OptionSelect
            aria-label="Protocol"
            className="flex-1"
            value={proto.value}
            disabled={off}
            onChange={(v) => void save({ apiProtocol: v as ApiProtocol, model: null }, "change the connection")}
            options={API_PROTOCOLS.map((x) => ({ value: x.value, label: x.label }))}
          />
          <Hint>{proto.more}</Hint>
        </div>
        {proto.value === "openai-chat" && <EndpointField key={p.endpointRef ?? ""} value={p.endpointRef ?? ""} placeholder={proto.placeholder} onSave={(v) => save({ endpointRef: v || null }, "set the address")} />}
        <div className="flex items-start gap-2 text-xs">
          <span className="w-20 shrink-0 pt-1 text-muted-foreground">Key</span>
          <div className="min-w-0 flex-1">
            {keyOptional(p) && !p.credential?.set ? <span className="text-caption text-muted-foreground">Not needed for a server on this computer.</span> : null}
            <KeyField p={p} getKeyUrl={keyUrl} onChanged={onChanged} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1" role="radiogroup" aria-label="How it's paid">
        {choices.map((c, i) => (
          <Radio key={c.id} c={c} on={current === c.id} recommended={i === 0} disabled={off} onPick={() => void pick(c.id)} />
        ))}
      </div>

      <div className="min-h-7 ps-5">
        {current === null && <span className="text-caption text-muted-foreground">Pick how to pay.</span>}
        {current === "api-key" && <KeyField p={p} getKeyUrl={keyUrl} onChanged={onChanged} />}

        {current === "subscription" && p.runtime === "claude" &&
          (probe && !probe.installed ? (
            <div className="flex flex-wrap items-center gap-2 text-caption">
              <span className="text-warn">Claude Code isn't installed.</span>
              <Button size="xs" variant="outline" onClick={() => window.open(info?.homepage ?? "https://code.claude.com/docs/en/setup", "_blank", "noopener")}>
                <ExternalLinkIcon /> Get it
              </Button>
              <CheckAgain onProbe={onProbe} />
            </div>
          ) : signedIn ? (
            <SignedIn plan={probe?.login?.plan} />
          ) : (
            <div className="flex flex-wrap items-center gap-2 text-caption">
              <span className="text-warn">Sign in to Claude Code first.</span>
              <Hint>Open Terminal, type “claude” and sign in. Crease never signs in to Claude for you.</Hint>
              <CheckAgain onProbe={onProbe} />
            </div>
          ))}

        {(current === "subscription" && p.runtime === "grok") || (isCodex && current === "app")
          ? signedIn
            ? <SignedIn plan={probe?.login?.plan} />
            : <BrowserSignIn kind={p.runtime as "grok" | "codex"} onDone={onProbe} />
          : null}

        {isCodex && current === "user" && (
          <div className="flex flex-col gap-1.5">
            {signedIn ? <SignedIn plan={probe?.login?.plan} /> : <span className="text-caption text-warn">Sign in to Codex on this Mac first.</span>}
            <label className="flex items-center gap-2 text-xs">
              <Checkbox checked={!!codex?.allowPartialIsolation} disabled={off} onCheckedChange={(v) => void onCodex({ allowPartialIsolation: !!v })} aria-label="Allow partial isolation" />
              <span>Allow partial isolation</span>
              <Hint>
                Your own Codex brings its saved command rules. Crease can't switch them off, so the designer is only partly walled off. Signing in with ChatGPT avoids
                this.
              </Hint>
            </label>
          </div>
        )}
      </div>
    </div>
  )
}

function CheckAgain({ onProbe }: { onProbe: () => void }) {
  return (
    <Button size="xs" variant="ghost" onClick={onProbe}>
      <RefreshCwIcon /> Check again
    </Button>
  )
}

function EndpointField({ value, placeholder, onSave }: { value: string; placeholder: string; onSave: (v: string) => Promise<boolean> }) {
  const [v, setV] = useState(value) // remounted (key) when the saved value changes
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="w-20 shrink-0 text-muted-foreground">Address</span>
      <Input value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && void onSave(v.trim())} placeholder={placeholder} className="h-7 font-mono" />
    </label>
  )
}
