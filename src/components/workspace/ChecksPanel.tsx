import { useState } from "react"
import type { CheckItem, CheckSeverity, OrientationAdvice } from "@shared/types"
import {
  CheckIcon,
  ChevronRightIcon,
  InfoIcon,
  LightbulbIcon,
  Loader2Icon,
  MapPinIcon,
  OctagonXIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
} from "@/components/icons"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/panel"
import { StaleNote } from "./StaleNote"
import { toast } from "sonner"
import { api, errMsg } from "@/lib/api"
import { fmtRelative } from "@/lib/format"
import { partKey, useStudio } from "@/stores/studio"
import { cn } from "@/lib/utils"
import { usePlain } from "@/lib/use-plain"
import { useLength } from "@/lib/units"

export const SEV_STYLE: Record<CheckSeverity, string> = {
  pass: "bg-ok/15 text-ok border-ok/30",
  info: "bg-primary/15 text-primary border-primary/30",
  warn: "bg-warn/15 text-warn border-warn/30",
  fail: "bg-err/15 text-err border-err/30",
}

export function SevBadge({ sev, plain }: { sev: CheckSeverity; plain?: boolean }) {
  return (
    <span className={cn("inline-flex h-4 items-center border px-1.5 text-micro", SEV_STYLE[sev] ?? SEV_STYLE.info)}>
      {plain ? (SEV_WORD[sev] ?? sev) : sev}
    </span>
  )
}

const ORDER: Record<string, number> = { fail: 0, warn: 1, pass: 2, info: 3 }

/** What each check is, in plain words (the rule id, measured value and limit are in the row's details). */
export const RULE_LABEL: Record<string, string> = {
  manifold: "Solid, closed shape",
  fits_bed: "Fits on the printer",
  bodies: "Separate pieces",
  first_layer: "Sits flat on the bed",
  overhangs: "Overhangs",
  tall_thin: "Tall and thin",
  thin_walls: "Thin walls",
  thin_features: "Very thin bits",
  orientation: "Best way up",
  colors: "Colours",
  estimates: "Time and filament",
}
const SEV_WORD: Record<string, string> = { pass: "ok", warn: "check", fail: "problem", info: "note" }
export const ruleLabel = (rule: string) => RULE_LABEL[rule] ?? rule.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())

const area = (a: number, inches = false) =>
  a < 1 ? "no supports" : `${inches ? `${+(a / 645.16).toFixed(a >= 6451.6 ? 0 : 1)} in²` : a >= 1000 ? `${Math.round(a / 100)} cm²` : `${a} mm²`} needs supports`

/** R23: a better way to lay the part on the bed, with the reasons and one click to apply it (rotates via the .scad). */
function OrientationCard({ projectId, partId, advice }: { projectId: string; partId: string; advice: OrientationAdvice }) {
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const s = advice.suggestion
  const length = useLength()
  if (!s) return null
  const apply = async () => {
    setBusy(true)
    try {
      await api.setOrientation(projectId, partId, s.rotate)
      toast.success(`${s.label}: rendering`)
    } catch (e) {
      toast.error("Couldn't turn it", { description: errMsg(e) })
    } finally {
      setBusy(false)
    }
  }
  const faster = Math.round(((1 - s.relTime) * 100) / 5) * 5
  return (
    <div className="flex flex-col border-b border-line bg-primary/5 text-xs" data-orientation-card>
      <div className="flex items-center gap-2 px-2 py-1">
        <LightbulbIcon className="size-3.5 shrink-0 text-primary" />
        <button className="min-w-0 flex-1 truncate text-left text-foreground hover:underline" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {advice.summary}
        </button>
        <Button size="xs" disabled={busy} onClick={() => void apply()} title="Turns the part on the bed. The shape stays the same.">
          {busy ? <Loader2Icon className="animate-spin" /> : <RotateCcwIcon />} Turn it
        </Button>
      </div>
      {open && (
        <div className="flex flex-col gap-1 px-2 pb-2 pl-7 text-caption text-muted-foreground">
          {advice.reasons.slice(2).map((r, i) => (
            <span key={i}>{r}</span>
          ))}
          <div className="grid grid-cols-[auto_1fr] gap-x-3 font-mono text-micro">
            <span>now</span>
            <span>
              {area(advice.current.supportMm2, length.units === "in")} · {length.len(advice.current.heightMm)}
            </span>
            <span className="text-foreground">{s.label.toLowerCase()}</span>
            <span className="text-foreground">
              {area(s.supportMm2, length.units === "in")} · {length.len(s.heightMm)}{faster >= 10 ? ` · ~${faster}% faster` : ""}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

const SEV_ICON: Record<string, React.ReactNode> = {
  fail: <OctagonXIcon className="size-3.5 shrink-0 text-err" />,
  warn: <TriangleAlertIcon className="size-3.5 shrink-0 text-warn" />,
  pass: <CheckIcon className="size-3.5 shrink-0 text-ok" />,
  info: <InfoIcon className="size-3.5 shrink-0 text-info" />,
}

/** One check: severity icon · plain name · chevron. Details on click: what it found, the exact numbers and rule. */
function CheckRow({ it, plain, onShow }: { it: CheckItem; plain: (s: string) => string; onShow: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <li className="border-b border-line">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex h-7 w-full items-center gap-2 rounded-none px-2 text-left text-xs hover:bg-surface-3">
        <span title={SEV_WORD[it.severity] ?? it.severity}>{SEV_ICON[it.severity] ?? SEV_ICON.info}</span>
        <span className="min-w-0 flex-1 truncate text-foreground">{ruleLabel(it.rule)}</span>
        <ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="flex flex-col gap-1 px-2 pb-2 pl-7 text-caption text-muted-foreground">
          <span title={it.message}>{plain(it.message)}</span>
          <span className="font-mono text-micro text-faint">
            {[it.rule, it.measured, it.threshold && `limit ${it.threshold}`, it.location && `@ ${it.location}`].filter(Boolean).join(" · ")}
          </span>
          {it.markers?.length ? (
            <button className="inline-flex items-center gap-1 self-start text-primary hover:underline" onClick={onShow}>
              <MapPinIcon className="size-3" /> Show on model
            </button>
          ) : null}
        </div>
      )}
    </li>
  )
}

export function ChecksPanel({ projectId, partId }: { projectId: string; partId: string | null }) {
  const k = partId ? partKey(projectId, partId) : ""
  const report = useStudio((s) => s.checks[k])
  const checking = useStudio((s) => !!s.checking[k])
  const check = useStudio((s) => s.check)
  const validity = useStudio((s) => (partId ? s.validity[projectId]?.parts[partId]?.check : undefined))
  const setCenterTab = useStudio((s) => s.setCenterTab)
  const plain = usePlain()

  const run = async () => {
    if (!partId) return
    try {
      await check(projectId, partId)
    } catch (e) {
      toast.error("Check failed", { description: errMsg(e) })
    }
  }

  if (!partId) return <EmptyState icon={<ShieldCheckIcon />} title="No part selected" />
  if (!report)
    return (
      <EmptyState
        icon={checking ? <Loader2Icon className="animate-spin" /> : <ShieldCheckIcon />}
        title={checking ? "Checking…" : "Not checked yet"}
        action={
          !checking && (
            <Button size="sm" variant="outline" onClick={() => void run()}>
              Check
            </Button>
          )
        }
      />
    )

  const items = [...report.items].sort((a, b) => (ORDER[a.severity] ?? 9) - (ORDER[b.severity] ?? 9))
  const counts = report.items.reduce<Record<string, number>>((m, i) => ((m[i.severity] = (m[i.severity] ?? 0) + 1), m), {})

  const summary = [
    counts.fail && `${counts.fail} ${counts.fail === 1 ? "problem" : "problems"}`,
    counts.warn && `${counts.warn} to check`,
    `${counts.pass ?? 0} ok`,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <div className="flex h-full flex-col">
      <StaleNote validity={validity} />
      <div className="flex h-7 shrink-0 items-center gap-2 border-b px-2 text-caption text-muted-foreground">
        {SEV_ICON[report.summary] ?? SEV_ICON.info}
        <span className="text-foreground">{summary}</span>
        <span>· {fmtRelative(report.createdAt)}</span>
        <div className="flex-1" />
        <Button size="icon-xs" variant="ghost" disabled={checking} onClick={() => void run()} title="Check again" aria-label="Check again">
          {checking ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {report.orientation?.suggestion && <OrientationCard projectId={projectId} partId={partId} advice={report.orientation} />}
        <ul aria-label="Checks">
          {items.map((it, i) => (
            <CheckRow key={`${it.rule}-${i}`} it={it} plain={plain} onShow={() => setCenterTab("model")} />
          ))}
        </ul>
      </div>
    </div>
  )
}
