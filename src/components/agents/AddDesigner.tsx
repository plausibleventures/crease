// Add designer: a modal with a stepper. 1 Service -> 2 Sign in (or paste a key) -> 3 Model -> Done.
// The profile is created when step 1 is left and removed again if the modal is closed before Done.
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import type { AgentProfileView, AgentRuntimeInfo, AgentRuntimeProbe, CodexRuntimeSettings } from "@shared/types"
import { ArrowLeftIcon, ArrowRightIcon, ExternalLinkIcon, Loader2Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { api, errMsg } from "@/lib/api"
import { cn } from "@/lib/utils"
import { AccessPicker } from "./Access"
import { TestButtons, useProfileSaver } from "./DesignerDialog"
import { ModelField } from "./Model"
import { Hint, profileHealth, StatusDot, StepDots } from "./parts"

const STEPS = ["Service", "Sign in", "Model", "Done"]

export function AddDesignerDialog({
  open,
  onOpenChange,
  runtimes,
  probes,
  profiles,
  codex,
  onCodex,
  onProbe,
  onCreated,
  initialKind,
  defaultOn = false,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  runtimes: AgentRuntimeInfo[]
  probes: AgentRuntimeProbe[] | null
  profiles: AgentProfileView[]
  codex: CodexRuntimeSettings | undefined
  onCodex: (patch: CodexRuntimeSettings) => Promise<boolean>
  onProbe: () => void
  /** Reload the list (also after a cancelled add). */
  onCreated: () => void
  /** Start with this service picked and go straight to signing in (first-run setup). */
  initialKind?: string
  /** "Use for new chats" starts ticked. */
  defaultOn?: boolean
}) {
  const [n, setN] = useState(0) // remount the wizard each time it opens
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (!o) setN((x) => x + 1)
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        {open && (
          <Wizard
            key={n}
            runtimes={runtimes}
            probes={probes}
            profiles={profiles}
            codex={codex}
            onCodex={onCodex}
            onProbe={onProbe}
            onFinish={() => {
              onCreated()
              onOpenChange(false)
              setN((x) => x + 1)
            }}
            onCancelled={onCreated}
            initialKind={initialKind}
            defaultOn={defaultOn}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function Wizard({
  runtimes,
  probes,
  profiles,
  codex,
  onCodex,
  onProbe,
  onFinish,
  onCancelled,
  initialKind,
  defaultOn,
}: {
  runtimes: AgentRuntimeInfo[]
  probes: AgentRuntimeProbe[] | null
  profiles: AgentProfileView[]
  codex: CodexRuntimeSettings | undefined
  onCodex: (patch: CodexRuntimeSettings) => Promise<boolean>
  onProbe: () => void
  onFinish: () => void
  onCancelled: () => void
  initialKind?: string
  defaultOn?: boolean
}) {
  const [step, setStep] = useState(0)
  const [kind, setKind] = useState<string | null>(() => (initialKind && runtimes.some((r) => r.kind === initialKind && r.available) ? initialKind : (runtimes.find((r) => r.available)?.kind ?? null)))
  const [p, setP] = useState<AgentProfileView | null>(null)
  const [creating, setCreating] = useState(false)
  const [makeDefault, setMakeDefault] = useState(!!defaultOn)
  const { busy, save } = useProfileSaver(p, setP)
  const [name, setName] = useState("")
  const info = runtimes.find((r) => r.kind === kind)
  const probe = probes?.find((x) => x.runtime === kind)

  // a created-but-unfinished profile goes away with the modal
  const [finished, setFinished] = useState(false)
  useCleanup(p && !finished ? p.id : null, onCancelled)

  const nextName = (label: string) => {
    if (!profiles.some((x) => x.name === label)) return label
    let i = 2
    while (profiles.some((x) => x.name === `${label} ${i}`)) i++
    return `${label} ${i}`
  }

  const leaveService = async () => {
    if (!info) return
    if (p && p.runtime === info.kind) return setStep(1)
    setCreating(true)
    try {
      if (p) await api.deleteAgentProfile(p.id).catch(() => {})
      const created = await api.createAgentProfile({ name: nextName(info.label), runtime: info.kind })
      setP(created)
      setName(created.name)
      setStep(1)
    } catch (e) {
      toast.error(`Couldn't add ${info.label}`, { description: errMsg(e) })
    } finally {
      setCreating(false)
    }
  }

  const finish = async () => {
    if (!p) return
    try {
      if (name.trim() && name.trim() !== p.name) await save({ name: name.trim() }, "rename it")
      if (makeDefault) await api.setDefaultAgentProfile(p.id)
      setFinished(true)
      setStep(3)
    } catch (e) {
      toast.error("Couldn't save it", { description: errMsg(e) })
    }
  }

  // a service picked before opening: skip the service step (once, also under StrictMode's double effects)
  const autoLeft = useRef(false)
  useEffect(() => {
    if (!initialKind || initialKind !== kind || autoLeft.current) return
    autoLeft.current = true
    void leaveService()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const health = p ? profileHealth(p, info, probe) : null

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add designer</DialogTitle>
        <StepDots steps={STEPS} at={step} />
      </DialogHeader>

      <div className="min-h-40">
        {step === 0 && (
          <div className="flex flex-col gap-1" role="radiogroup" aria-label="Service">
            {runtimes.map((r) => {
              const pr = probes?.find((x) => x.runtime === r.kind)
              const notInstalled = r.available && pr && !pr.installed
              const on = kind === r.kind
              return (
                <div key={r.kind} className="flex items-center gap-2">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={!r.available}
                    onClick={() => setKind(r.kind)}
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-2 border px-2 py-2 text-left text-xs hover:border-line-strong disabled:opacity-50",
                      on ? "border-primary/60 bg-primary/10" : "border-line",
                    )}
                  >
                    <span className={cn("flex size-3.5 shrink-0 items-center justify-center rounded-full border", on ? "border-primary" : "border-muted-foreground")}>
                      {on && <span className="size-1.5 rounded-full bg-primary" />}
                    </span>
                    <span className="font-medium">{r.label}</span>
                    {!r.available ? (
                      <span className="ms-auto text-micro text-muted-foreground">Soon</span>
                    ) : notInstalled ? (
                      <span className="ms-auto text-micro text-warn">Not installed</span>
                    ) : null}
                  </button>
                  <Hint>{r.blurb}</Hint>
                </div>
              )
            })}
            {info && probe && !probe.installed && info.homepage && (
              <Button size="xs" variant="link" className="self-start" onClick={() => window.open(info.homepage, "_blank", "noopener")}>
                <ExternalLinkIcon /> Get {info.label}
              </Button>
            )}
          </div>
        )}

        {step === 1 && p && (
          <AccessPicker p={p} info={info} probe={probe} codex={codex} onCodex={onCodex} onChanged={setP} save={save} onProbe={onProbe} busy={busy} />
        )}

        {step === 2 && p && (
          <div className="flex flex-col gap-3">
            <ModelField p={p} probe={probe} busy={busy} save={save} />
            <label className="flex items-center gap-2 text-xs">
              <span className="w-20 shrink-0 text-muted-foreground">Name</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className="h-7" aria-label="Name" />
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Checkbox checked={makeDefault} onCheckedChange={(v) => setMakeDefault(!!v)} aria-label="Use for new chats" />
              Use for new chats
            </label>
          </div>
        )}

        {step === 3 && p && health && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium">{name.trim() || p.name}</span>
              <StatusDot h={health} />
            </div>
            <TestButtons p={p} onProbe={onProbe} />
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        {step > 0 && step < 3 && (
          <Button size="sm" variant="ghost" onClick={() => setStep((s) => s - 1)}>
            <ArrowLeftIcon /> Back
          </Button>
        )}
        <div className="flex-1" />
        {step === 0 && (
          <Button size="sm" disabled={!info?.available || creating} onClick={() => void leaveService()}>
            {creating ? <Loader2Icon className="animate-spin" /> : null} Next <ArrowRightIcon />
          </Button>
        )}
        {step === 1 && (
          <Button size="sm" onClick={() => setStep(2)}>
            Next <ArrowRightIcon />
          </Button>
        )}
        {step === 2 && (
          <Button size="sm" disabled={busy} onClick={() => void finish()}>
            Next <ArrowRightIcon />
          </Button>
        )}
        {step === 3 && (
          <Button size="sm" onClick={onFinish}>
            Finish
          </Button>
        )}
      </div>
    </>
  )
}

/** Remove the half-made profile when the wizard unmounts without finishing. */
function useCleanup(id: string | null, after: () => void) {
  const pending = useRef<string | null>(null)
  const then = useRef(after)
  useEffect(() => {
    pending.current = id
    then.current = after
  }, [id, after])
  useEffect(
    () => () => {
      if (pending.current) void api.deleteAgentProfile(pending.current).then(() => then.current(), () => {})
    },
    [],
  )
}
