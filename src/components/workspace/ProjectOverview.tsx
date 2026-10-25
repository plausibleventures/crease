// R12: the project overview, the default view of a project. One 12-column grid: the picture and ONE next action on
// top, then small tables (parts, plates, things to buy). Pending numbers are hidden, not explained (docs/writing.md).
import { useState, type ReactNode } from "react"
import { toast } from "sonner"
import type { OverviewAction, OverviewActionKind, ProjectOverview as Overview } from "@shared/types"
import {
  ArrowRightIcon,
  BoxIcon,
  CheckIcon,
  ListOrderedIcon,
  Loader2Icon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  RulerIcon,
  PrinterIcon,
  ShoppingCartIcon,
  SparklesIcon,
  StarIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "@/components/icons"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { EstimatedTime } from "@/components/EstimatedTime"
import { api, errMsg } from "@/lib/api"
import { cn } from "@/lib/utils"
import { toneOf } from "@shared/filament-tones"
import { usePlain } from "@/lib/use-plain"
import { useRemembered } from "@/lib/use-remembered"
import { DetailsToggle } from "@/components/panel"
import { ChangeSize } from "./ParametersPanel"
import { useStudio } from "@/stores/studio"
import { useUnits } from "@/lib/units"
import { fmtDims } from "@shared/length"
import { sendBuild, sliceBuild, useBuildBusy, useProjectPrint } from "./build-actions"
import { printLine } from "@/lib/print-line"
import { PrintHistory } from "./PrintHistory"
import { offlineNote, useTargetOffline } from "@/components/machines/MachinePicker"

type Tool = "printer" | "checks" | "params"

// No "Approve" step: approval folds into the print dialog's Print (U1).
const STEPS: { label: string; kinds: OverviewActionKind[] }[] = [
  { label: "Describe", kinds: ["describe", "fix", "update", "fit", "problem"] },
  { label: "Slice", kinds: ["slice", "approve"] },
  { label: "Print", kinds: ["print", "waiting", "printing"] },
  { label: "Assemble", kinds: ["assemble"] },
  { label: "Rate", kinds: ["feedback"] },
]

/** A size in the user's units (Settings.units), the other unit on hover. */
function Size({ v, unit = false }: { v: readonly number[]; unit?: boolean }) {
  const units = useUnits((s) => s.units)
  return <Tip tip={fmtDims(v, units === "in" ? "mm" : "in")}>{fmtDims(v, units, unit)}</Tip>
}

/** Hover text: extra detail (inches, reasons) kept out of the layout. */
function Tip({ tip, children, className }: { tip: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cn("cursor-help", className)} />}>{children}</TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  )
}

export function ProjectOverview({ projectId, onOpenTool }: { projectId: string; onOpenTool: (t: Tool) => void }) {
  const ov = useStudio((s) => s.overview[projectId])
  const waiting = useStudio((s) => s.printRequests.some((r) => r.projectId === projectId))
  const sliceStaleNow = useStudio((s) => {
    const j = s.jobs[projectId]
    if (!j || !s.overview[projectId]) return false
    const ov = s.overview[projectId]
    if (ov.slice.kind === "plate") return !!j.plates?.stale.length
    return ov.parts.some((p) => !!j.parts[p.id]?.stale.length)
  })
  if (!ov)
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2Icon className="mr-2 size-4 animate-spin" /> Loading…
      </div>
    )
  const next: OverviewAction = waiting
    ? { kind: "waiting", label: "Answer the print dialog", detail: "A print is waiting for your OK." }
    : // the jobs list can learn that the slice went out of date before the overview is fetched again
      ov.next.kind === "print" && sliceStaleNow
      ? { ...ov.next, label: "Slice again and print", detail: "The design changed. Slice again." }
      : ov.next
  if (!ov.hasDesign) return <EmptyOverview ov={ov} />
  return (
    <div className="@container h-full overflow-y-auto">
      <div className="mx-auto grid max-w-5xl grid-cols-12 gap-5 p-5">
        <Hero ov={ov} />
        <div className="col-span-12 flex min-w-0 flex-col gap-4 @2xl:col-span-7">
          <div className="min-w-0">
            <h1 className="ps-title truncate text-xl text-foreground">{ov.name}</h1>
            {ov.description && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{ov.description}</p>}
          </div>
          <NextAction projectId={projectId} ov={ov} next={next} onOpenTool={onOpenTool} />
          <Facts ov={ov} />
        </div>
        <OutOfDate projectId={projectId} ov={ov} onOpenTool={onOpenTool} />
        <ChangeSize projectId={projectId} parts={ov.parts} />
        <Parts ov={ov} />
        {ov.plates.length > 0 && <Plates ov={ov} />}
        {ov.supplies && ov.supplies.toBuy > 0 && <Supplies ov={ov} />}
        {ov.lastPrint && <Prints projectId={projectId} />}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------

function Hero({ ov }: { ov: Overview }) {
  return (
    <figure className="relative col-span-12 flex aspect-[4/3] min-h-56 items-center justify-center overflow-hidden rounded-lg border bg-stage @2xl:col-span-5 @2xl:aspect-auto">
      {ov.hero ? (
        <img src={ov.hero.url} alt={ov.hero.kind === "assembly" ? `${ov.name}, put together` : ov.name} className="size-full object-contain" />
      ) : (
        <BoxIcon className="size-12 text-faint/50" />
      )}
      {ov.hero?.stale && (
        <figcaption className="absolute top-2 left-2">
          <Tip tip="The design changed since this picture." className="rounded-sm bg-warn px-1.5 py-0.5 text-micro text-background">
            Old picture
          </Tip>
        </figcaption>
      )}
    </figure>
  )
}

/** One-line stepper: every step shows its name; done steps with a tick, the current one tinted, later ones outlined. */
function Stepper({ steps, at }: { steps: string[]; at: number }) {
  return (
    <ol className="flex min-w-0 items-center gap-1 text-caption" aria-label="Steps">
      {steps.map((label, i) => (
        <li key={label} className={cn("flex min-w-0 items-center gap-1", i < steps.length - 1 && "flex-auto")}>
          <span
            title={label}
            aria-current={i === at ? "step" : undefined}
            className={cn(
              "flex h-6 min-w-0 items-center gap-1 rounded-sm px-1.5",
              i < at && "bg-ok/15 text-ok",
              i === at && "shrink-0 bg-primary/15 font-medium text-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--primary)_50%,transparent)]",
              i > at && "border border-line-strong text-muted-foreground",
            )}
          >
            {i < at && <CheckIcon className="size-3 shrink-0" />}
            <span className="truncate">{label}</span>
            {i < at && <span className="sr-only">(done)</span>}
          </span>
          {i < steps.length - 1 && <span className={cn("h-px min-w-1.5 flex-1", i < at ? "bg-ok/50" : "bg-line-strong")} />}
        </li>
      ))}
    </ol>
  )
}

function NextAction({ projectId, ov, next, onOpenTool }: { projectId: string; ov: Overview; next: OverviewAction; onOpenTool: (t: Tool) => void }) {
  const plain = usePlain()
  // STATE-05: a real printer that is offline: say it where Print is (slicing still works)
  const offlineM = useTargetOffline(projectId)
  const offline = offlineM && (next.kind === "slice" || next.kind === "print") ? offlineM : null
  const live = useProjectPrint(projectId)
  const busy = useBuildBusy((s) => !!s.slicing[projectId] || !!s.sending[projectId])
  const partSlicing = useStudio((s) => Object.entries(s.slicing).some(([k, v]) => v && k.startsWith(`${projectId}/`)))
  const [running, setRunning] = useState(false)
  const assembly = !!ov.guide && ov.guide.steps > 0 && (ov.printedCount > 1 || ov.hardwareCount > 0)
  const steps = STEPS.filter((s) => assembly || s.label !== "Assemble")
  const at = next.kind === "again" ? steps.length : steps.findIndex((s) => s.kinds.includes(next.kind))

  const run = async () => {
    setRunning(true)
    try {
      await doAction(projectId, ov, next, onOpenTool)
    } catch (e) {
      toast.error("That didn't work", { description: errMsg(e) })
    } finally {
      setRunning(false)
    }
  }
  const spinning = running || busy || partSlicing
  return (
    <section aria-label="Next step" className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-primary/[0.06] p-3">
      <Stepper steps={steps.map((s) => s.label)} at={at} />
      <div className="flex gap-1.5">
        <Button size="lg" className="h-11 min-w-0 flex-1 justify-between px-4 text-sm" onClick={() => void run()} disabled={spinning}>
          <span className="flex min-w-0 items-center gap-2">
            {spinning ? <Loader2Icon className="animate-spin" /> : <ActionIcon kind={next.kind} />}
            <span className="truncate">{offline && next.kind === "slice" ? "Slice now" : next.label}</span>
          </span>
          <ArrowRightIcon />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="icon" className="size-11 shrink-0" title="More" aria-label="More" />}>
            <MoreHorizontalIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {next.kind === "approve" && (
              <DropdownMenuItem onClick={() => useStudio.getState().focusComposer("Can you change ")}>
                <MessageSquareIcon /> Change something
              </DropdownMenuItem>
            )}
            {ov.lastPrint && !ov.lastPrint.rated && next.kind !== "feedback" && (
              <DropdownMenuItem onClick={() => openFeedback(projectId, ov)}>
                <StarIcon /> Rate the print
              </DropdownMenuItem>
            )}
            {next.kind !== "describe" && (
              <DropdownMenuItem onClick={() => useStudio.getState().focusComposer()}>
                <MessageSquareIcon /> Ask the designer
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => useStudio.getState().setCenterTab("model")}>
              <BoxIcon /> Open in 3D
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {ov.slice.error && (next.kind === "fit" || next.kind === "problem") && !next.partId ? (
        <Tip tip={<span className="whitespace-pre-line">{ov.slice.error.detail}</span>} className="text-xs text-err">
          {plain(next.detail)}
        </Tip>
      ) : offline ? (
        <p className="text-xs text-warn">{offlineNote(offline.name)}</p>
      ) : next.kind === "printing" && live ? (
        // the print's state in one line (the status bar keeps the compact monitor; the toolbar shows the estimate)
        <p role="status" className="text-xs text-foreground">
          {printLine(live)}
        </p>
      ) : (
        <p className={cn("text-xs", next.kind === "fit" || next.kind === "problem" ? "text-err" : "text-muted-foreground")}>{plain(next.detail)}</p>
      )}
    </section>
  )
}

function ActionIcon({ kind }: { kind: OverviewActionKind }) {
  switch (kind) {
    case "approve":
      return <CheckIcon />
    case "fit":
      return <RulerIcon />
    case "problem":
      return <WrenchIcon />
    case "slice":
      return <SparklesIcon />
    case "print":
    case "again":
    case "waiting":
    case "printing":
      return <PrinterIcon />
    case "assemble":
      return <ListOrderedIcon />
    case "feedback":
      return <StarIcon />
    case "update":
      // a local render (no chat message): not the chat icon
      return <RefreshCwIcon />
    default:
      return <MessageSquareIcon />
  }
}

function openFeedback(projectId: string, ov: Overview) {
  const p = ov.lastPrint
  if (!p) return
  useStudio.getState().openPrintResult({ printId: p.id, projectId, state: p.state })
}

async function renderStale(projectId: string, ov: Overview) {
  const st = useStudio.getState()
  const v = st.validity[projectId]
  const ids = ov.parts.filter((p) => !v || v.parts[p.id]?.render.state !== "fresh").map((p) => p.id)
  await Promise.all(ids.map((id) => st.render(projectId, id, v?.parts[id]?.overrides ?? undefined)))
  st.loadValidity(projectId)
}

async function doAction(projectId: string, ov: Overview, next: OverviewAction, onOpenTool: (t: Tool) => void) {
  const st = useStudio.getState()
  const partId = st.selectedPartId ?? ov.parts[0]?.id ?? null
  switch (next.kind) {
    case "describe":
      return st.focusComposer()
    case "fix": {
      const r = await api.sendMessage(projectId, `The model didn't build: ${next.detail.replace(/^The model didn't build:\s*/, "")} Please fix it.`)
      useStudio.setState((s) => ({ agent: { ...s.agent, [projectId]: { running: true, sessionId: r?.sessionId ?? null, costUsd: s.agent[projectId]?.costUsd ?? 0 } } }))
      return
    }
    case "update":
      return renderStale(projectId, ov)
    case "fit": {
      // the part's own sliders when it has them, else the designer
      const pid = next.partId ?? partId
      const params = pid ? await api.parameters(projectId, pid).catch(() => []) : []
      if (pid && params.length) {
        // the sliders are right here, in "Change size" (U2): bring them into view and focus the first one
        st.selectPart(pid)
        requestAnimationFrame(() => {
          const sec = document.getElementById("change-size")?.closest("section")
          const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
          sec?.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" })
          sec?.querySelector<HTMLElement>("input, [role=slider]")?.focus({ preventScroll: true })
        })
        return
      }
      return st.focusComposer("Make it fit on my printer.")
    }
    case "problem":
      if (next.partId) {
        st.selectPart(next.partId)
        return onOpenTool("checks")
      }
      return st.focusComposer(`${next.detail} Can you fix it?`)
    case "approve": {
      // The designer may be waiting on its "How does this look?" question: answer it, so it carries on.
      const q = (st.questions[projectId] ?? []).find((r) => r.questions.some((x) => x.options.some((o) => /^looks (great|good)/i.test(o.label))))
      if (q) {
        const answers = Object.fromEntries(q.questions.map((x) => [x.question, x.options.find((o) => /^looks (great|good)/i.test(o.label))?.label ?? "Looks great"]))
        await api.answerQuestion(projectId, q.requestId, answers)
      } else await api.setApproval(projectId, true)
      toast.success("Design approved", { description: "Next: slice it." })
      st.loadOverview(projectId)
      return
    }
    case "slice":
      // "Slice again and print": an out-of-date slice is sliced again by Send, which then opens the print dialog
      if (ov.slice.state === "stale") await sendBuild(projectId, partId)
      else await sliceBuild(projectId, partId)
      st.loadOverview(projectId)
      return
    case "print":
    case "again":
      await sendBuild(projectId, partId)
      return
    case "waiting":
      return st.refreshPrinter()
    case "printing":
      return onOpenTool("printer")
    case "assemble":
      return st.setCenterTab("assembly")
    case "feedback":
      return openFeedback(projectId, ov)
  }
}

// ---------------------------------------------------------------------------------------------

/** Size · parts · filament in one strip. Time and grams live in the toolbar and the plates table, not here. */
function Facts({ ov }: { ov: Overview }) {
  const s = ov.size
  const facts: { label: string; value: ReactNode }[] = []
  if (s)
    facts.push({
      label: s.basis === "largest-part" ? "Biggest part" : "Size",
      value: <Size v={s.mm} unit />,
    })
  facts.push({
    label: "Parts",
    value: (
      <>
        {ov.printedCount}
        {ov.hardwareCount > 0 && <Tip tip="Bought parts, like screws"> + {ov.hardwareCount}</Tip>}
      </>
    ),
  })
  if (ov.materials.length)
    facts.push({
      label: "Filament",
      value: (
        <span className="flex min-w-0 items-center gap-1.5">
          {ov.materials.map((m) => (
            <Tip key={`${m.colorName}-${m.slot}`} tip={`${m.colorName} ${m.material}${m.grams != null ? ` · ${Math.round(m.grams)} g` : ""}`}>
              <span className="inline-block size-2.5 rounded-full border border-line-strong" style={{ background: m.colorHex ?? m.colorName }} />
            </Tip>
          ))}
          {ov.materials.length === 1 && <span className="truncate font-sans capitalize">{ov.materials[0].colorName}</span>}
        </span>
      ),
    })
  return (
    <dl className="mt-auto flex overflow-hidden rounded-lg border bg-card">
      {facts.map((f, i) => (
        <div key={f.label} className={cn("min-w-0 flex-auto px-2.5 py-2", i > 0 && "border-l")}>
          <dt className="text-caption text-muted-foreground">{f.label}</dt>
          <dd className="mt-0.5 whitespace-nowrap text-sm font-medium text-foreground">{f.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function Section({ title, right, children }: { title: ReactNode; right?: ReactNode; children?: ReactNode }) {
  return (
    <section className="col-span-12 flex min-w-0 flex-col gap-1.5">
      <div className="flex h-7 items-center gap-2">
        <h2 className="flex-1 text-sm font-semibold text-foreground">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  )
}

/** Past prints of this project: a title until opened (remembered). */
function Prints({ projectId }: { projectId: string }) {
  const [open, setOpen] = useRemembered("overview-prints")
  return (
    <Section title="Prints" right={<DetailsToggle open={open} onToggle={() => setOpen((o) => !o)} />}>
      {open && <PrintHistory projectId={projectId} className="rounded-lg border bg-card px-2.5" />}
    </Section>
  )
}

/** Everything out of date in one line, with one button that fixes the first thing. */
function OutOfDate({ projectId, ov, onOpenTool }: { projectId: string; ov: Overview; onOpenTool: (t: Tool) => void }) {
  const plain = usePlain()
  const [busy, setBusy] = useState(false)
  // an out-of-date slice is announced once, by the next action ("Slice again and print")
  const items = ov.outOfDate.filter((o) => !o.what.startsWith("Sliced"))
  if (!items.length) return null
  const first = items[0].what
  const fix: { label: string; run: () => unknown } = first.startsWith("Preview")
    ? { label: "Update", run: () => renderStale(projectId, ov) }
    : first.startsWith("Printability")
        ? { label: "Open checks", run: () => onOpenTool("checks") }
        : { label: "Open guide", run: () => useStudio.getState().setCenterTab("assembly") }
  const run = async () => {
    setBusy(true)
    try {
      await fix.run()
      useStudio.getState().loadOverview(projectId)
    } catch (e) {
      toast.error("That didn't work", { description: errMsg(e) })
    } finally {
      setBusy(false)
    }
  }
  const tip = items.map((o) => `${o.what}${o.reasons.length ? `: ${o.reasons.slice(0, 2).map(plain).join("; ")}` : ""}`).join("\n")
  return (
    <div role="status" className="col-span-12 flex h-9 items-center gap-2 border border-warn/30 bg-warn/10 px-2.5 text-xs text-warn">
      <TriangleAlertIcon className="size-3.5 shrink-0" />
      <Tip tip={<span className="whitespace-pre-line">{tip}</span>} className="min-w-0 flex-1 truncate">
        Out of date: {items.map((o) => o.what).join(", ")}
      </Tip>
      <Button size="xs" variant="ghost" className="shrink-0 text-warn hover:text-warn" disabled={busy} onClick={() => void run()}>
        {busy ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />} {fix.label}
      </Button>
    </div>
  )
}

function Swatch({ color }: { color: string }) {
  return <span className="inline-block size-2.5 shrink-0 rounded-full border border-line-strong" style={{ background: toneOf(color) ?? color }} />
}

function Parts({ ov }: { ov: Overview }) {
  const units = useUnits((s) => s.units)
  const select = (id: string) => {
    useStudio.getState().selectPart(id)
    useStudio.getState().setCenterTab("model")
  }
  return (
    <Section title={ov.parts.length === 1 ? "Part" : `Parts · ${ov.parts.length}`}>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-12" />
            <TableHead>Name</TableHead>
            <TableHead>Size ({units})</TableHead>
            <TableHead className="w-20">Colour</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ov.parts.map((p) => (
            <TableRow key={p.id} className="cursor-pointer" onClick={() => select(p.id)} title={`Open ${p.name} in 3D`}>
              <TableCell className="py-1">
                <div className="flex size-9 items-center justify-center overflow-hidden rounded-md bg-stage-thumb">
                  {p.imageUrl ? <img src={p.imageUrl} alt="" className="size-full object-contain" /> : <BoxIcon className="size-4 text-faint/50" />}
                </div>
              </TableCell>
              <TableCell className="max-w-0 truncate text-foreground">
                {p.name}
                {p.qty > 1 && <span className="ml-1.5 text-caption text-muted-foreground">×{p.qty}</span>}
              </TableCell>
              <TableCell className="font-mono text-caption">
                {p.error ? <span className="font-sans text-err">Didn't build</span> : p.sizeMm ? <Size v={p.sizeMm} /> : "–"}
              </TableCell>
              <TableCell>
                <span className="flex gap-1">
                  {p.colors.map((c) => (
                    <Swatch key={c} color={c} />
                  ))}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  )
}

const STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: "To print", cls: "text-muted-foreground" },
  requested: { label: "Waiting", cls: "text-primary" },
  printing: { label: "Printing", cls: "text-primary" },
  done: { label: "Printed", cls: "text-ok" },
  failed: { label: "Failed", cls: "text-err" },
  rejected: { label: "To print", cls: "text-muted-foreground" },
}

function Plates({ ov }: { ov: Overview }) {
  // simple: plate · time · status; Details (remembered) add which parts and how much filament
  const [details, setDetails] = useRemembered("overview-plates")
  const name = (id: string) => ov.parts.find((p) => p.id === id)?.name ?? id
  const stale = ov.slice.state === "stale"
  return (
    <Section title={ov.plates.length === 1 ? "Plate" : `Plates · ${ov.plates.length}`} right={<DetailsToggle open={details} onToggle={() => setDetails((d) => !d)} />}>
      <Table className={cn(stale && "opacity-60")}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-12">#</TableHead>
            {details && <TableHead>Parts</TableHead>}
            <TableHead>Time</TableHead>
            {details && <TableHead>Filament</TableHead>}
            <TableHead className="w-24">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ov.plates.map((p) => {
            const st = p.practice && p.status === "done" ? { label: "Practice", cls: "text-muted-foreground" } : (STATUS[p.status] ?? STATUS.pending)
            const isNext = ov.nextPlate === p.plate && !stale
            return (
              <TableRow key={p.jobId} className={cn(isNext && "bg-primary/[0.06]")}>
                <TableCell className="font-mono">{p.plate}</TableCell>
                {details && <TableCell className="max-w-0 truncate text-muted-foreground">{[...new Set(p.partIds)].map(name).join(", ")}</TableCell>}
                <TableCell className="font-mono">
                  <EstimatedTime items={[p]} />
                </TableCell>
                {details && <TableCell className="font-mono text-muted-foreground">{p.filamentG != null ? `${Math.round(p.filamentG)} g` : "–"}</TableCell>}
                <TableCell className={cn("text-caption", stale ? "text-muted-foreground" : isNext && p.status === "pending" ? "text-primary" : st.cls)}>
                  {isNext && p.status === "pending" ? "Next" : st.label}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </Section>
  )
}

function Supplies({ ov }: { ov: Overview }) {
  const s = ov.supplies!
  return (
    <Section
      // the cost estimate is one hover away (costs stay out of the simple view)
      title={s.estUsd != null ? <Tip tip={`About $${Math.round(s.estUsd)}`}>To buy · {s.toBuy}</Tip> : `To buy · ${s.toBuy}`}
      right={
        <Button size="xs" variant="ghost" onClick={() => useStudio.getState().setCenterTab("assembly")}>
          <ShoppingCartIcon /> Shopping list
        </Button>
      }
    >
      <Table>
        <TableBody>
          {s.items.map((i) => (
            <TableRow key={i.name}>
              <TableCell className="max-w-0 truncate text-foreground">{i.name}</TableCell>
              <TableCell className="w-24 text-right text-caption text-muted-foreground">{i.needText ?? (i.need != null ? `×${i.need}` : "")}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  )
}

// ---------------------------------------------------------------------------------------------

function EmptyOverview({ ov }: { ov: Overview }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-xl flex-col items-start gap-4 p-6">
        <div>
          <h1 className="text-base font-semibold">{ov.name}</h1>
          <p className="mt-1 text-xs text-muted-foreground">Nothing designed yet. Describe it in the chat.</p>
        </div>
        <div className="w-full max-w-sm">
          <Stepper steps={["Describe", "Print", "Assemble"]} at={0} />
        </div>
        <Button size="lg" className="h-11 px-4 text-sm" onClick={() => useStudio.getState().focusComposer()}>
          <MessageSquareIcon /> {ov.next.label}
          <ArrowRightIcon />
        </Button>
      </div>
    </div>
  )
}
