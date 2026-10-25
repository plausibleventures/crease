import { EstimatedTime } from "@/components/EstimatedTime"
import { toast } from "sonner"
import { ClockIcon, DownloadIcon, EyeIcon, Loader2Icon, MoreHorizontalIcon, PlayIcon, RefreshCwIcon, ScissorsIcon, SendIcon, ShieldCheckIcon, WeightIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { errMsg } from "@/lib/api"
import { sendBuild, sliceBuild, useBuildBusy, usePrintBlock, useProjectPrint } from "./build-actions"
import type { PrintJobStatus, PrintJobView, SlotUsage } from "@shared/types"
import { IntentPicker } from "@/components/layers/intents"
import { fmtNum } from "@/lib/format"
import { offlineNote, useTargetOffline } from "@/components/machines/MachinePicker"
import { partKey, useStudio } from "@/stores/studio"

export function Toolbar({
  projectId,
  partId,
  onShowChecks,
  onShowPrinter,
}: {
  projectId: string
  partId: string | null
  onShowChecks: () => void
  onShowPrinter: () => void
}) {
  const k = partId ? partKey(projectId, partId) : ""
  const rendering = useStudio((s) => !!s.rendering[k])
  const checking = useStudio((s) => !!s.checking[k])
  const slicing = useStudio((s) => !!s.slicing[k])
  const render = useStudio((s) => s.render)
  const check = useStudio((s) => s.check)
  // Server-owned print jobs: the latest slice per part and the plate set, with lifecycle + "out of date" reasons.
  const jobs = useStudio((s) => s.jobs[projectId])
  const partJob = partId ? jobs?.parts[partId] : undefined
  const plateSet = jobs?.plates ?? null
  const sending = useBuildBusy((s) => !!s.sending[projectId])
  const reslicing = useBuildBusy((s) => !!s.reslicing[projectId])
  // Multi-part projects slice the whole build (all parts × qty arranged together) instead of the selected part.
  const multiPart = useStudio((s) => (s.project?.id === projectId ? s.project.parts.length : 0) > 1)
  const plateSlicing = useBuildBusy((s) => !!s.slicing[projectId])

  const disabled = !partId
  // R2-FLOW-02: the Overview's next step is a check that must pass first ("Make it fit"): Print waits for it
  const block = usePrintBlock(projectId)
  // A blank new project ("Nothing designed yet") is never sliced or printed (the server refuses it too).
  const hasDesign = useStudio((s) => s.overview[projectId]?.hasDesign ?? true)

  const doRender = async () => {
    if (!partId) return
    const r = await render(projectId, partId)
    const cur = useStudio.getState().renders[k]
    if (!r && cur?.error) toast.error("Render failed", { description: cur.error })
  }
  const doCheck = async () => {
    if (!partId) return
    try {
      const r = await check(projectId, partId)
      onShowChecks()
      if (r) {
        const fails = r.items.filter((i) => i.severity === "fail").length
        const warns = r.items.filter((i) => i.severity === "warn").length
        if (fails) toast.error(`${fails} check${fails > 1 ? "s" : ""} failed`)
        else if (warns) toast.warning(`${warns} warning${warns > 1 ? "s" : ""}`)
        else toast.success("All checks passed")
      }
    } catch (e) {
      toast.error("Check failed", { description: errMsg(e) })
    }
  }
  const doSlice = () => sliceBuild(projectId, partId)
  const doSend = () => sendBuild(projectId, partId)
  // A printer without a connection: "Send" saves the print file to print by hand.
  const byHand = useStudio((s) => s.machines?.find((m) => m.id === s.targetMachineId(projectId))?.connection.type === "none")
  // STATE-05: a real printer that is offline (the header chip says Offline; Print explains on hover)
  const offline = useTargetOffline(projectId)

  const stale = multiPart ? (plateSet?.stale ?? []) : (partJob?.stale ?? [])
  const current = multiPart ? !!plateSet && !stale.length : !!partJob && !stale.length
  // while a plate prints, the main action is watching it; printing the next plate moves to More
  const printing = !!useProjectPrint(projectId)
  const nextPlate = multiPart && plateSet?.next != null ? plateSet.plates[plateSet.next] : undefined
  const canPrintNext = printing && !!nextPlate && nextPlate.status !== "printing" && nextPlate.status !== "requested"
  // the slicer's estimate for the whole print (the Overview and the status bar show the time left)
  // one solid primary per screen: on the Overview its next-step button is the main action, so Print steps back to a tint
  const onOverview = useStudio((s) => s.centerTab === "overview")
  const timeTitle = multiPart && (plateSet?.plates.length ?? 0) > 1 ? "Estimated print time, all plates" : "Estimated print time"

  return (
    <div className="flex min-w-0 shrink-0 items-center gap-1">
      {hasDesign && multiPart && plateSet && !stale.length && (
        <div className="mr-1 hidden h-7 items-center gap-2 rounded-full border bg-surface-2 px-2.5 text-caption text-muted-foreground xl:flex" title={plateSet.plates.map((p) => p.gcodePath).join(", ")}>
          <span className="text-foreground">{plateSet.plates.length === 1 ? "1 plate" : `${plateSet.plates.length} plates`}</span>
          <span className="flex items-center gap-0.5" title={timeTitle}>
            <ClockIcon className="size-3" />
            <EstimatedTime items={plateSet.plates} />
            {printing && <span className="font-sans">total</span>}
          </span>
          <span className="flex items-center gap-0.5">
            <WeightIcon className="size-3" />
            {fmtNum(sum(plateSet.plates.map((p) => p.filamentG)))} g
          </span>
          {plateSet.plates.length > 1 && <PlateStates plates={plateSet.plates} next={plateSet.next} />}
          <SlotChips slots={plateSet.plates.length === 1 ? plateSet.plates[0].filamentBySlot : undefined} />
        </div>
      )}
      {hasDesign && !multiPart && partJob && !stale.length && (
        <div className="mr-1 hidden h-7 items-center gap-2 rounded-full border bg-surface-2 px-2.5 text-caption text-muted-foreground xl:flex" title={partJob.gcodePath}>
          <span className="flex items-center gap-0.5" title={timeTitle}>
            <ClockIcon className="size-3" />
            <EstimatedTime items={[partJob]} />
            {printing && <span className="font-sans">total</span>}
          </span>
          <span className="flex items-center gap-0.5">
            <WeightIcon className="size-3" />
            {fmtNum(partJob.filamentG)} g
          </span>
          <SlotChips slots={partJob.filamentBySlot} />
        </div>
      )}
      {hasDesign ? (
        <>
          <IntentPicker projectId={projectId} />
          <Blocked reason={block.slice ? block.reason : null}>
          <Button
            variant="ghost"
            size="sm"
            disabled={(disabled && !multiPart) || slicing || plateSlicing || (!!block.reason && block.slice)}
            onClick={() => void doSlice()}
            title={multiPart ? "Lay all parts out on plates" : "Get it ready for the printer"}
          >
            {slicing || plateSlicing ? <Loader2Icon className="animate-spin" /> : <ScissorsIcon />}
            Slice
          </Button>
          </Blocked>
          {printing ? (
            <Button size="sm" onClick={onShowPrinter} title="See the printer and the print's progress">
              <EyeIcon /> Watch print
            </Button>
          ) : (
          <Blocked reason={block.reason}>
          <Button
            size="sm"
            variant={onOverview ? "tint" : "default"}
            disabled={(disabled && !multiPart) || sending || slicing || plateSlicing || !!block.reason}
            onClick={() => void doSend()}
            title={
              byHand
                ? "Save the file to print from the printer's screen"
                : offline
                  ? offlineNote(offline.name)
                  : current
                  ? "Send to the printer. You check first."
                  : stale.length
                    ? "Changed since the last slice: slices again, then you check."
                    : "Slice, then send. You check first."
            }
          >
            {sending ? <Loader2Icon className="animate-spin" /> : byHand ? <DownloadIcon /> : current ? <SendIcon /> : <PlayIcon />}
            {reslicing ? "Slicing again…" : byHand ? "Save print file" : "Print"}
          </Button>
          </Blocked>
          )}
        </>
      ) : (
        // a blank new project: nothing to slice or print yet
        <span className="px-2 text-caption text-muted-foreground">Describe it first to print</span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" title="More" aria-label="More actions" />}>
          {rendering || checking ? <Loader2Icon className="animate-spin" /> : <MoreHorizontalIcon />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={disabled || rendering} onClick={() => void doRender()}>
            <RefreshCwIcon /> Update picture
          </DropdownMenuItem>
          <DropdownMenuItem disabled={disabled || checking} onClick={() => void doCheck()}>
            <ShieldCheckIcon /> Run checks
          </DropdownMenuItem>
          {canPrintNext && (
            <DropdownMenuItem disabled={sending || !!block.reason} onClick={() => void doSend()}>
              <SendIcon /> Print plate {nextPlate!.plate}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** A button that is off for a reason: the reason shows on hover and keyboard focus (a disabled button gets neither). */
function Blocked({ reason, children }: { reason: string | null; children: React.ReactElement }) {
  if (!reason) return children
  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} aria-label={reason} className="inline-flex outline-none focus-visible:ring-2 focus-visible:ring-ring" />}>
        {children}
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{reason}</TooltipContent>
    </Tooltip>
  )
}

const sum = (xs: (number | null)[]) => (xs.some((x) => x == null) ? null : xs.reduce<number>((a, x) => a + (x ?? 0), 0))

const STATUS_LABEL: Record<PrintJobStatus, string> = {
  pending: "to print",
  requested: "waiting for OK",
  printing: "printing",
  done: "done",
  failed: "failed",
  rejected: "to print",
}
const STATUS_COLOR: Record<PrintJobStatus, string> = {
  pending: "var(--muted-foreground)",
  requested: "var(--primary)",
  printing: "var(--primary)",
  done: "var(--ok, #4ade80)",
  failed: "var(--err, #f87171)",
  rejected: "var(--muted-foreground)",
}

/** One mark per plate: what state it's in, with the next one to send outlined. */
function PlateStates({ plates, next }: { plates: PrintJobView[]; next: number | null }) {
  return (
    <span className="flex items-center gap-1" title={plates.map((p) => `Plate ${p.plate}: ${p.practice && p.status === "done" ? "practice" : STATUS_LABEL[p.status]}`).join("\n")}>
      {plates.map((p, i) => (
        <span
          key={p.id}
          className={`inline-flex h-4 min-w-4 items-center justify-center rounded-sm border px-0.5 text-micro ${i === next ? "border-foreground text-foreground" : "border-border"}`}
          style={{ color: i === next ? undefined : STATUS_COLOR[p.status], background: p.status === "done" ? "color-mix(in oklab, var(--ok, #4ade80) 20%, transparent)" : undefined }}
        >
          {p.plate}
        </span>
      ))}
      
    </span>
  )
}

/** "White · slot 1": which CFS slot/colour each filament in the slice prints with. */
function SlotChips({ slots }: { slots?: SlotUsage[] }) {
  if (!slots?.length) return null
  return (
    <>
      {slots.map((s) => (
        <span key={s.slot} className="flex items-center gap-1" title={`${s.colorName} (${s.colorHex}) · CFS slot ${s.slot}${s.grams != null ? ` · ${s.grams} g` : ""}`}>
          <span className="inline-block size-2 rounded-full border border-border" style={{ background: s.colorHex }} />
          <span className="hidden 2xl:inline">
            {s.colorName} · slot {s.slot}
          </span>
        </span>
      ))}
    </>
  )
}
