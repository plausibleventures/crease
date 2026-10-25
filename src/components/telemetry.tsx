// Anonymous usage reports (Settings.telemetry, server/telemetry.ts). Asked once: in setup's Preferences step, or, for
// anyone set up without an answer, by one slim bar above the status bar (Yes / No thanks). Settings changes it any time.
// The "What's sent" list mirrors server/telemetry.ts SCHEMA; keep them in step.
import { useEffect, useId, useState } from "react"
import { InfoIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { DetailsToggle } from "@/components/panel"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { useStudio } from "@/stores/studio"

const SENT = [
  "App opened: version, system, chip type",
  "Setup finished or skipped",
  "Each design request: designer, model family, how it ended, rough time",
  "Designer errors: the kind only",
  "Renders and checks: worked or not, rough time, issue count",
  "Slices: worked or not, one colour or more",
  "Prints: approved or not, practice or real, how it ended, your rating",
  "New projects and build packs: a count",
]

/** The exact list of what usage reports contain, and what they never contain. */
export function WhatsSent({ id, className }: { id?: string; className?: string }) {
  return (
    <div id={id} className={cn("flex flex-col gap-1.5 text-caption text-muted-foreground", className)}>
      <ul className="list-disc space-y-0.5 pl-4">
        {SENT.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      <p>Never your designs, prompts, files, names or printer details. A random ID, not your name.</p>
    </div>
  )
}

/** The yes/no as a checkbox (setup, Settings), with "What's sent" in place. */
export function TelemetryChoice({ checked, onChange, className }: { checked: boolean; onChange: (v: boolean) => void; className?: string }) {
  const [open, setOpen] = useState(false)
  const listId = useId()
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label className="flex items-start gap-2.5 text-xs">
        <Checkbox checked={checked} onCheckedChange={(v) => onChange(!!v)} className="mt-px" />
        <span className="flex flex-col gap-0.5">
          <span className="text-foreground">Send anonymous usage reports</span>
          <span className="text-caption text-muted-foreground">Helps improve Crease. Never your designs or prompts.</span>
        </span>
      </label>
      <DetailsToggle open={open} onToggle={() => setOpen(!open)} label="What's sent" controls={listId} className="self-start pl-5" />
      {open && <WhatsSent id={listId} className="pl-6.5" />}
    </div>
  )
}

/** Once, for people set up before the question existed (or who skipped it): Yes / No thanks. Never blocks work. */
export function TelemetryAsk() {
  const onboarding = useStudio((s) => s.onboarding.open)
  const [ask, setAsk] = useState(false)
  const [open, setOpen] = useState(false)
  const listId = useId()
  useEffect(() => {
    api
      .getSettings()
      .then((s) => setAsk(!!s.onboardedAt && s.telemetry == null))
      .catch(() => {})
  }, [])
  if (!ask || onboarding) return null
  const answer = (telemetry: boolean) => {
    setAsk(false)
    void api.putSettings({ telemetry }).catch(() => {}) // not saved: asked again next launch
  }
  return (
    <div role="status" className="shrink-0 border-t border-line bg-surface-2 text-xs">
      <div className="flex min-h-8 items-center gap-2 px-3 py-1">
        <InfoIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate">Help improve Crease with anonymous usage reports?</span>
        <DetailsToggle open={open} onToggle={() => setOpen(!open)} label="What's sent" controls={listId} />
        <div className="flex-1" />
        <Button size="xs" onClick={() => answer(true)}>
          Yes
        </Button>
        <Button size="xs" variant="ghost" onClick={() => answer(false)}>
          No thanks
        </Button>
      </div>
      {open && <WhatsSent id={listId} className="pr-3 pb-2 pl-8.5" />}
    </div>
  )
}
