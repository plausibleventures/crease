// Edit one designer, in a modal: model, how it's paid, default. Everything else sits behind one collapsed "More":
// budget, effort, tests, what it can do, advanced paths, recent problems, remove.
import { useState } from "react"
import { toast } from "sonner"
import type { AgentConnectionResult, AgentEffort, AgentFailure, AgentProfile, AgentProfileView, AgentRuntimeInfo, AgentRuntimeProbe, CodexRuntimeSettings } from "@shared/types"
import { AlertTriangleIcon, Loader2Icon, PencilIcon, RefreshCwIcon, SendIcon, Trash2Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { OptionSelect } from "@/components/ui/select"
import { api, errMsg } from "@/lib/api"
import { fmtRelative } from "@/lib/format"
import { cn } from "@/lib/utils"
import { DetailsToggle } from "@/components/panel"
import { useStudio } from "@/stores/studio"
import { useRemembered } from "@/lib/use-remembered"
import { AccessPicker } from "./Access"
import { ModelField } from "./Model"
import { Capabilities, Hint, profileHealth, StatusDot, TestResult } from "./parts"

export interface DesignerContext {
  info: AgentRuntimeInfo | undefined
  probe: AgentRuntimeProbe | undefined
  codex: CodexRuntimeSettings | undefined
  onCodex: (patch: CodexRuntimeSettings) => Promise<boolean>
  onProbe: () => void
}

/** Save a patch to a profile, with a toast on failure. */
export function useProfileSaver(p: AgentProfileView | null, onChanged: (v: AgentProfileView) => void) {
  const [busy, setBusy] = useState(false)
  const save = async (patch: Partial<AgentProfile>, what = "save it") => {
    if (!p) return false
    setBusy(true)
    try {
      onChanged(await api.updateAgentProfile(p.id, patch))
      return true
    } catch (e) {
      toast.error(`Couldn't ${what}`, { description: errMsg(e) })
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, save }
}

export function DesignerDialog({
  p,
  ctx,
  failures,
  onChanged,
  onReload,
  onClose,
}: {
  p: AgentProfileView | null
  ctx: DesignerContext
  failures: AgentFailure[]
  onChanged: (v: AgentProfileView) => void
  onReload: () => void
  onClose: () => void
}) {
  return (
    <Dialog open={!!p} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        {p && <DesignerForm key={p.id} p={p} ctx={ctx} failures={failures} onChanged={onChanged} onReload={onReload} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  )
}

function DesignerForm({
  p,
  ctx,
  failures,
  onChanged,
  onReload,
  onClose,
}: {
  p: AgentProfileView
  ctx: DesignerContext
  failures: AgentFailure[]
  onChanged: (v: AgentProfileView) => void
  onReload: () => void
  onClose: () => void
}) {
  const { info, probe } = ctx
  const { busy, save } = useProfileSaver(p, onChanged)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(p.name)
  // U2: "More" is this dialog's in-place detail; it remembers whether it was open
  const [more, setMore] = useRemembered("designer-more")
  const health = profileHealth(p, info, probe)

  const makeDefault = async () => {
    try {
      await api.setDefaultAgentProfile(p.id)
      onReload()
    } catch (e) {
      toast.error("Couldn't change the default", { description: errMsg(e) })
    }
  }

  return (
    <>
      <DialogHeader className="pe-8">
        {renaming ? (
          <form
            className="flex items-center gap-1"
            onSubmit={async (e) => {
              e.preventDefault()
              if (name.trim() && (await save({ name: name.trim() }, "rename it"))) setRenaming(false)
            }}
          >
            <Input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} className="h-7 text-sm" autoFocus maxLength={60} />
            <Button size="sm" type="submit" disabled={busy}>
              Save
            </Button>
          </form>
        ) : (
          <div className="flex items-center gap-2">
            <DialogTitle className="truncate">{p.name}</DialogTitle>
            <Button size="icon-xs" variant="ghost" onClick={() => setRenaming(true)} aria-label="Rename" title="Rename">
              <PencilIcon />
            </Button>
            <span className="ms-auto">
              <StatusDot h={health} />
            </span>
          </div>
        )}
      </DialogHeader>

      <div className="flex flex-col gap-3">
        <section className="flex flex-col gap-1.5" aria-label="How it's paid">
          <h3 className="text-xs text-muted-foreground">How it's paid</h3>
          <AccessPicker p={p} info={info} probe={probe} codex={ctx.codex} onCodex={ctx.onCodex} onChanged={onChanged} save={save} onProbe={ctx.onProbe} busy={busy} />
        </section>

        <label className="flex items-center gap-2 text-xs">
          <Checkbox checked={p.isDefault} disabled={p.isDefault} onCheckedChange={(v) => v && void makeDefault()} aria-label="Use for new chats" />
          Use for new chats
          <Hint>A project can pick its own designer in its chat.</Hint>
        </label>

        <section className="border-t pt-2">
          <DetailsToggle open={more} onToggle={() => setMore((m) => !m)} label="More" summary="model, budget, tests" className="-ml-1.5" />
          {more && (
            <div className="mt-2 flex flex-col gap-3">
              <ModelField p={p} probe={probe} busy={busy} save={save} />
              <BudgetField key={String(p.budget.maxUsdPerRun)} p={p} busy={busy} onSave={(v) => save({ budget: { maxUsdPerRun: v } }, "set the budget")} />
              <EffortField p={p} efforts={probe?.effortLevels ?? []} busy={busy} save={save} />
              <TestButtons p={p} onProbe={ctx.onProbe} disabled={info?.available === false} />
              <div className="flex flex-col gap-1">
                <h3 className="text-xs text-muted-foreground">What it can do</h3>
                <Capabilities caps={probe?.capabilities} />
              </div>
              <div className="flex flex-col gap-1.5 text-xs">
                <h3 className="text-xs text-muted-foreground">Advanced</h3>
                {p.runtime !== "api" && <PathField key={`b${p.binaryPath}`} label="Program" value={p.binaryPath ?? ""} placeholder="Automatic" onSave={(v) => save({ binaryPath: v || null }, "set the program path")} />}
                {p.runtime === "api" && (p.apiProtocol ?? "anthropic") === "anthropic" && (
                  <PathField key={`e${p.endpointRef}`} label="Address" value={p.endpointRef ?? ""} placeholder="https://api.anthropic.com" onSave={(v) => save({ endpointRef: v || null }, "set the address")} />
                )}
                {p.runtime === "api" && <PathField key={`m${p.model}`} label="Model id" value={p.model ?? ""} placeholder="Any model id" onSave={(v) => save({ model: v || null }, "set the model")} />}
                <div className="font-mono text-micro text-muted-foreground">
                  {p.runtime}
                  {probe?.version ? ` ${probe.version}` : ""} · usage {probe?.capabilities.usage ?? "?"} · {p.id}
                  {p.auth.kind === "api-key" ? ` · ${p.auth.credentialRef}` : ""}
                </div>
              </div>
              {failures.length > 0 && (
                <div className="flex flex-col gap-1">
                  <h3 className="text-xs text-muted-foreground">Recent problems</h3>
                  <FailureTable failures={failures.slice(0, 5)} onOpen={onClose} />
                </div>
              )}
              {!p.isDefault && <RemoveButton p={p} onRemoved={() => (onClose(), onReload())} />}
            </div>
          )}
        </section>
      </div>
    </>
  )
}

function RemoveButton({ p, onRemoved }: { p: AgentProfileView; onRemoved: () => void }) {
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const remove = async () => {
    setBusy(true)
    try {
      await api.deleteAgentProfile(p.id)
      onRemoved()
    } catch (e) {
      toast.error("Couldn't remove it", { description: errMsg(e) })
    } finally {
      setBusy(false)
    }
  }
  return confirm ? (
    <div role="alert" className="flex items-center gap-1.5 text-xs">
      Remove “{p.name}”?
      <Button size="xs" variant="destructive" disabled={busy} onClick={() => void remove()}>
        Remove
      </Button>
      <Button size="xs" variant="ghost" onClick={() => setConfirm(false)}>
        Keep
      </Button>
    </div>
  ) : (
    <div>
      <Button size="xs" variant="ghost" className="text-err" onClick={() => setConfirm(true)}>
        <Trash2Icon /> Remove designer
      </Button>
    </div>
  )
}

export function TestButtons({ p, onProbe, disabled }: { p: AgentProfileView; onProbe: () => void; disabled?: boolean }) {
  const [busy, setBusy] = useState<"test" | "message" | null>(null)
  const [confirmMsg, setConfirmMsg] = useState(false)
  const [result, setResult] = useState<AgentConnectionResult | null>(null)
  const run = async (message: boolean) => {
    setBusy(message ? "message" : "test")
    setConfirmMsg(false)
    try {
      setResult(await api.testAgentProfile(p.id, message))
      onProbe()
    } catch (e) {
      setResult({ ok: false, steps: [], summary: errMsg(e) })
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="outline" disabled={!!busy || disabled} onClick={() => void run(false)}>
          {busy === "test" ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />} Test connection
        </Button>
        <Hint>Free. Checks install and sign-in.</Hint>
        {!confirmMsg ? (
          <Button size="sm" variant="ghost" disabled={!!busy || disabled} onClick={() => setConfirmMsg(true)}>
            {busy === "message" ? <Loader2Icon className="animate-spin" /> : <SendIcon />} Test message
          </Button>
        ) : (
          <span role="alert" className="flex items-center gap-1.5 text-caption">
            {p.auth.kind === "subscription" ? "Uses a little of your plan." : "Costs about 1¢."}
            <Button size="xs" onClick={() => void run(true)}>
              Send
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirmMsg(false)}>
              Cancel
            </Button>
          </span>
        )}
      </div>
      {result && <TestResult r={result} />}
    </div>
  )
}

function BudgetField({ p, busy, onSave }: { p: AgentProfileView; busy: boolean; onSave: (v: number | null) => Promise<boolean> }) {
  const cur = p.budget.maxUsdPerRun
  const [v, setV] = useState(cur == null ? "" : String(cur)) // remounted (key) when the saved value changes
  const commit = () => {
    const t = v.trim()
    const n = t === "" ? null : Number(t)
    if (n !== null && (!Number.isFinite(n) || n <= 0)) {
      toast.error("Enter an amount above 0, or leave it empty")
      return
    }
    if (n !== cur) void onSave(n)
  }
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="w-20 shrink-0 text-muted-foreground">Budget $</span>
      <Input
        aria-label="Budget per request in dollars"
        inputMode="decimal"
        value={v}
        disabled={busy}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
        placeholder="No limit"
        className="h-7 w-24 font-mono"
      />
      <Hint>
        {p.auth.kind === "subscription" ? "Stops one request above this much of your plan, counted at API prices." : "Stops one request that costs more than this. Your design is kept."}
      </Hint>
    </label>
  )
}

function EffortField({ p, efforts, busy, save }: { p: AgentProfileView; efforts: AgentEffort[]; busy: boolean; save: (patch: Partial<AgentProfile>, what?: string) => Promise<boolean> }) {
  if (!efforts.length) return null
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="w-20 shrink-0 text-muted-foreground">Effort</span>
      <OptionSelect
        aria-label="Effort"
        className="flex-1"
        value={p.effort ?? "auto"}
        disabled={busy}
        onChange={(v) => void save({ effort: v === "auto" ? null : (v as AgentEffort) }, "change the effort")}
        options={[{ value: "auto", label: "Automatic" }, ...efforts.map((e) => ({ value: e, label: e }))]}
      />
      <Hint>More effort thinks longer. It's slower and uses more.</Hint>
    </label>
  )
}

function PathField({ label, value, placeholder, onSave }: { label: string; value: string; placeholder: string; onSave: (v: string) => Promise<boolean> }) {
  const [v, setV] = useState(value) // remounted (key) when the saved value changes
  return (
    <label className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <Input value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && void onSave(v.trim())} placeholder={placeholder} className="h-7 font-mono" />
    </label>
  )
}

const KIND_LABEL = { failed: "Failed", budget: "Over budget", auth: "Sign-in" } as const

export function FailureTable({ failures, showProfile, onOpen }: { failures: AgentFailure[]; showProfile?: boolean; onOpen?: () => void }) {
  const navigate = useStudio((s) => s.navigate)
  return (
    <table className="w-full text-caption">
      <tbody>
        {failures.map((f) => (
          <tr key={f.ts + f.sessionId + f.kind} className="border-t border-line align-top">
            <td className="py-1 pe-2 whitespace-nowrap">
              <span className="flex items-center gap-1">
                <AlertTriangleIcon className={cn("size-3", f.kind === "budget" ? "text-warn" : "text-err")} />
                {KIND_LABEL[f.kind]}
              </span>
            </td>
            {showProfile && <td className="py-1 pe-2 text-muted-foreground">{f.profileName}</td>}
            <td className="max-w-40 truncate py-1 pe-2">
              <button
                className="truncate text-primary hover:underline"
                onClick={() => {
                  onOpen?.()
                  navigate({ name: "project", id: f.projectId })
                }}
              >
                {f.projectName ?? f.projectId}
              </button>
            </td>
            <td className="py-1 pe-2 whitespace-nowrap text-muted-foreground">{fmtRelative(f.ts)}</td>
            <td className="py-1">
              <Hint label="Error">{f.error}</Hint>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
