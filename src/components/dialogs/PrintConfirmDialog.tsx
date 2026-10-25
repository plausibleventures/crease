import { EstimatedTime } from "@/components/EstimatedTime"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { BotIcon, CheckIcon, ClockIcon, Loader2Icon, OctagonXIcon, PrinterIcon, TriangleAlertIcon, UserIcon, WeightIcon } from "@/components/icons"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { api, errMsg } from "@/lib/api"
import { fmtNum } from "@/lib/format"
import { partKey, useStudio } from "@/stores/studio"
import { MachinePicker } from "@/components/machines/MachinePicker"
import type { GcodeQualityIssue, MachineWithStatus, PrintRequest, SlicePreviewSummary } from "@shared/types"
import { intentLabel, usePrintIntents } from "@/components/layers/intents"
import { ruleLabel } from "@/components/workspace/ChecksPanel"
import { DetailsToggle } from "@/components/panel"
import { useUnits } from "@/lib/units"
import { fmtDims } from "@shared/length"

/**
 * Blocking confirmation for every print request (agent- or user-initiated). The main view is for beginners: time,
 * filament, printer, colour, what may look rough, "The bed is clear", Print. Files, jobs, settings and the slicer's own
 * words are behind "Details". A user's print of a design not approved yet shows its checks, and Print approves it.
 */
export function PrintConfirmDialog() {
  const requests = useStudio((s) => s.printRequests)
  const removePrintRequest = useStudio((s) => s.removePrintRequest)
  const legacyPrinter = useStudio((s) => s.printer)
  const machines = useStudio((s) => s.machines)
  const req = requests[0]
  // target machine: the request's, unless the user picks another one here (for this print only)
  const [pick, setPick] = useState<{ id: string | null; machine: string } | null>(null)
  const defaultTarget = useStudio((s) => req?.machineId ?? s.targetMachineId(req?.projectId))
  const machineId = pick && pick.id === req?.requestId ? pick.machine : defaultTarget
  const machine = machines?.find((m) => m.id === machineId) ?? null
  const printer = machine ? machine.status : legacyPrinter
  const reason = useEligibility(req?.projectId ?? null)
  // the job's immutable snapshot: exactly the bytes that will be uploaded
  const preview = useSlicePreview(req?.projectId ?? null, req?.gcodeName ?? null, req?.job?.snapshotPath ?? null)
  const intents = usePrintIntents()
  const checks = useApprovalChecks(req)
  const blocked = machine ? reason(machine) : null
  // the checkbox is per request: a new request always starts unchecked
  const [bed, setBed] = useState<{ id: string | null; clear: boolean }>({ id: null, clear: false })
  const bedClear = !!req && bed.id === req.requestId && bed.clear
  const setBedClear = (clear: boolean) => setBed({ id: req?.requestId ?? null, clear })
  // "Use for this project": the printer picked here becomes the project's printer after it starts (per request)
  const [keep, setKeep] = useState<{ id: string | null; on: boolean }>({ id: null, on: false })
  const useForProject = !!req && keep.id === req.requestId && keep.on
  const projectPrinter = useStudio((s) => (req && s.project?.id === req.projectId ? s.targetMachineId(req.projectId) : null))
  const [busy, setBusy] = useState<"approve" | "reject" | "recheck" | "reslice" | null>(null)
  // the simple facts by default; Details adds file, job, settings, slots and the slicer's words. Never remembered:
  // this is the commitment moment, so every print starts with the short version (R2-DISC-02).
  const [detailsFor, setDetailsFor] = useState<string | null>(null)
  const details = !!req && detailsFor === req.requestId
  const setDetails = (f: (d: boolean) => boolean) => setDetailsFor(f(details) ? (req?.requestId ?? null) : null)
  // Another printer picked: the job was made for the request's machine, so it needs a new slice (a new job) first.
  const otherMachine = !!req?.machineId && !!machine && machine.id !== req.machineId
  const addPrintRequest = useStudio((s) => s.addPrintRequest)
  // e.g. a CFS slot the file uses isn't set up on the printer (server re-checks on approve and on "Check again")
  // (they were computed for the request's machine; a different pick is checked by the server on approve)
  const blockers = req && (!machine || !req.machineId || machine.id === req.machineId) ? (req.blockers ?? []) : []

  const recheck = async () => {
    if (!req) return
    setBusy("recheck")
    try {
      const r = await api.recheckPrintRequest(req.requestId)
      addPrintRequest(r)
      if (!r.blockers?.length) toast.success("The printer is ready")
    } catch (e) {
      toast.error("Couldn't check the printer", { description: errMsg(e) })
    } finally {
      setBusy(null)
    }
  }

  const [resliceError, setResliceError] = useState<{ id: string; text: string } | null>(null)
  const reslice = async () => {
    if (!req || !machine) return
    setBusy("reslice")
    setResliceError(null)
    try {
      const r = await api.reslicePrintRequest(req.requestId, machine.id)
      addPrintRequest(r)
      setPick(null)
      toast.success(`Ready for ${machine.name}`, { description: "Check the new time, then print." })
    } catch (e) {
      // shown in the dialog (a toast can hide behind it): the request stays open on its old job
      setResliceError({ id: req.requestId, text: errMsg(e) })
    } finally {
      setBusy(null)
    }
  }

  const resolve = async (approved: boolean) => {
    if (!req) return
    setBusy(approved ? "approve" : "reject")
    try {
      // Print on a design not approved yet approves this exact version too (the server checks it's still current)
      const r = await api.resolvePrintRequest(req.requestId, approved, approved && bedClear, machine?.id ?? null, approved && !!req.needsApproval)
      removePrintRequest(req.requestId)
      if (approved) {
        if (r.ok) {
          toast.success(`Printing on ${machine?.name ?? "the printer"}`, { description: "It heats up first. That takes a few minutes." })
          if (useForProject && machine && machine.id !== projectPrinter) {
            await useStudio
              .getState()
              .setProjectMachine(req.projectId, machine.id)
              .catch((e) => toast.error("Couldn't change the project's printer", { description: errMsg(e) }))
          }
          useStudio.getState().loadOverview(req.projectId)
        } else toast.error("The printer didn't start")
      }
      // "Don't print": nothing was sent, so there is nothing to report
    } catch (e) {
      toast.error(approved ? "Couldn't start the print" : "Couldn't close the request", { description: errMsg(e) })
      // a 404 means the server no longer knows this request: drop it so the UI isn't stuck
      if (e && typeof e === "object" && "status" in e && (e as { status: number }).status === 404) removePrintRequest(req.requestId)
    } finally {
      setBusy(null)
    }
  }

  const busyPrinter = printer && (printer.state === "printing" || printer.state === "paused" || printer.state === "preparing")
  const warns = preview?.issues.filter((i) => i.severity === "warn") ?? []
  const colourNote = req ? colourMismatch(req) : null

  return (
    <Dialog open={!!req} onOpenChange={() => {}} disablePointerDismissal>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        {req && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <PrinterIcon className="size-4 text-primary" aria-hidden /> Print it?
              </DialogTitle>
              {/* who asked only matters when it wasn't you: the button you just pressed needs no caption */}
              {(req.origin === "agent" || requests.length > 1) && (
                <DialogDescription className="flex items-center gap-1">
                  {req.origin === "agent" ? <BotIcon className="size-3" /> : <UserIcon className="size-3" />}
                  Asked by {req.origin === "agent" ? "the designer" : "you"}
                  {requests.length > 1 && <span> · {requests.length - 1} more waiting</span>}
                </DialogDescription>
              )}
            </DialogHeader>
            <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 border bg-muted/30 p-2.5">
              <span className="flex items-center gap-1 text-muted-foreground">
                <ClockIcon className="size-3" aria-hidden /> Time
              </span>
              <EstimatedTime items={[req]} />
              <span className="flex items-center gap-1 text-muted-foreground">
                <WeightIcon className="size-3" aria-hidden /> Filament
              </span>
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                <span>{req.filamentG != null ? `${fmtNum(req.filamentG)} g` : "–"}</span>
                {req.slotFilaments?.map((f) => (
                  <span key={f.slot} className="flex items-center gap-1 text-foreground">
                    <span className="inline-block size-2.5 rounded-full border border-border" style={{ background: f.colorHex }} aria-hidden />
                    {f.colorName}
                  </span>
                ))}
              </span>
              <span className="flex items-center gap-1 text-muted-foreground">
                <PrinterIcon className="size-3" aria-hidden /> Printer
              </span>
              {machines && machines.length > 0 ? (
                <MachinePicker value={machineId} onChange={(id) => setPick({ id: req.requestId, machine: id })} reason={reason} label="Print on" className="w-full" />
              ) : (
                <span>{printer ? `${printer.host ?? "?"} · ${printer.state}` : "status unknown"}</span>
              )}
            </div>
            {colourNote && (
              <p className="flex items-start gap-1.5 text-caption text-warn">
                <TriangleAlertIcon className="mt-px size-3 shrink-0" aria-hidden />
                {colourNote}
              </p>
            )}
            {machine && projectPrinter && machine.id !== projectPrinter && !blocked && (
              <label className="flex cursor-pointer items-center gap-2 text-caption text-muted-foreground">
                <Checkbox checked={useForProject} onCheckedChange={(c) => setKeep({ id: req.requestId, on: !!c })} />
                Use {machine.name} for this project
              </label>
            )}
            {otherMachine && (
              <div className="flex flex-col gap-1.5 border border-warn/40 bg-warn/5 p-2.5 text-caption">
                <span>
                  This was made for <span className="font-medium">{req.job?.machineName ?? "another printer"}</span>. Get it ready for{" "}
                  <span className="font-medium">{machine?.name}</span> first.
                </span>
                <Button variant="outline" size="sm" className="self-start" onClick={() => void reslice()} disabled={!!busy}>
                  {busy === "reslice" && <Loader2Icon className="animate-spin" />}
                  Slice for {machine?.name}
                </Button>
                {resliceError?.id === req.requestId && (
                  <span className="text-err" role="alert">
                    Couldn't slice for {machine?.name}: {resliceError.text}
                  </span>
                )}
              </div>
            )}
            {blocked && <p className="text-caption text-err">Can't print on {machine?.name}: {blocked}. Pick another printer.</p>}
            {busyPrinter && <p className="text-caption text-warn">The printer is {printer!.state}. Starting may fail.</p>}
            {blockers.length > 0 && (
              <div className="flex flex-col gap-1.5 border border-err/40 bg-err/5 p-2.5 text-caption">
                <span className="font-medium text-err">Not ready:</span>
                <ul className="list-disc pl-4 text-muted-foreground">
                  {blockers.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
                <Button variant="outline" size="sm" className="self-start" onClick={() => void recheck()} disabled={!!busy}>
                  {busy === "recheck" && <Loader2Icon className="animate-spin" />}
                  Check again
                </Button>
              </div>
            )}
            {req.needsApproval && <ChecksSummary checks={checks} />}
            {!req.needsApproval && req.failingChecks && req.failingChecks.length > 0 && (
              <p className="flex items-start gap-1.5 text-caption text-err">
                <OctagonXIcon className="mt-px size-3 shrink-0" aria-hidden />
                {req.failingChecks.length === 1 ? "1 check failed." : `${req.failingChecks.length} checks failed.`} It may not print well.
              </p>
            )}
            {warns.length > 0 && (
              <ul className="flex flex-col gap-1 text-caption text-warn" aria-label="May not look perfect">
                {/* a visible label, so "Checks passed" above and these warnings don't read as a contradiction */}
                <li className="text-muted-foreground">Some spots can look rough:</li>
                {warns.slice(0, 3).map((w, i) => (
                  <li key={i} className="flex items-start gap-1.5">
                    <TriangleAlertIcon className="mt-px size-3 shrink-0" aria-hidden />
                    <span>{plainIssue(w)}</span>
                  </li>
                ))}
              </ul>
            )}
            <DetailsToggle open={details} onToggle={() => setDetails((d) => !d)} controls="print-dialog-details" className="-my-1 justify-self-start" />
            {details && (
              <div id="print-dialog-details" className="border-t pt-2">
                <Details req={req} preview={preview} settings={preview ? intentLabel(intents, preview.intent) : null} printerState={printer?.state ?? null} practice={!!machine?.isPractice} />
              </div>
            )}
            <label className="flex cursor-pointer items-center gap-2 border border-warn/30 bg-warn/5 p-2.5">
              <Checkbox checked={bedClear} onCheckedChange={(c) => setBedClear(!!c)} />
              <span className="font-medium">The bed is clear</span>
            </label>
            {req.needsApproval && <p className="-mt-1 text-micro text-muted-foreground">Print also approves this version of the design.</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => void resolve(false)} disabled={!!busy}>
                {busy === "reject" && <Loader2Icon className="animate-spin" />}
                Don't print
              </Button>
              <Button onClick={() => void resolve(true)} disabled={!bedClear || !!busy || !!blocked || blockers.length > 0 || otherMachine}>
                {busy === "approve" && <Loader2Icon className="animate-spin" />}
                Print
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Everything a maker may want, in the slicer's and app's own words: file, job, settings, slots, full warnings. */
function Details({
  req,
  preview,
  settings,
  printerState,
  practice,
}: {
  req: PrintRequest
  preview: SlicePreviewSummary | null
  settings: string | null
  printerState: string | null
  practice: boolean
}) {
  const rows: [string, React.ReactNode][] = [
    ["File", <span className="font-mono">{req.gcodeName}</span>],
    ...(settings ? ([["Settings", settings]] as [string, React.ReactNode][]) : []),
    ...(req.job
      ? ([
          ["Sliced", `${new Date(req.job.createdAt).toLocaleString()} for ${req.job.machineName}`],
          ...(req.job.plate && req.job.plateCount && req.job.plateCount > 1 ? ([["Plate", `${req.job.plate} of ${req.job.plateCount}`]] as [string, React.ReactNode][]) : []),
          ["Job", <span className="font-mono" title={`Design revision ${req.job.designRevision}`}>{req.job.id.slice(0, 12)}</span>],
        ] as [string, React.ReactNode][])
      : []),
    ...(req.slotFilaments?.length
      ? ([["Slots", req.slotFilaments.map((f) => `${f.slot}: ${f.colorName} ${f.material !== "unknown" ? f.material : ""}`.trim()).join(" · ")]] as [string, React.ReactNode][])
      : []),
    ["Printer", `${printerState ?? "status unknown"}${practice ? " · practice" : ""}`],
  ]
  const issues = preview?.issues ?? []
  return (
    <div className="flex flex-col gap-2 text-caption">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="min-w-0 truncate">{v}</dd>
          </div>
        ))}
      </dl>
      {issues.length > 0 && (
        <ul className="flex flex-col gap-1">
          {issues.map((w, i) => (
            <li key={i} className={w.severity === "warn" ? "text-warn" : "text-muted-foreground"}>
              {w.message}
              {w.fix && <span className="text-muted-foreground"> {w.fix}</span>}
            </li>
          ))}
        </ul>
      )}
      {req.failingChecks && req.failingChecks.length > 0 && (
        <ul className="flex flex-col gap-1 text-err">
          {req.failingChecks.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** A slicer warning as one short, plain line (the full text is in Details). */
const ISSUE_PLAIN: Record<string, string> = {
  gap_infill_on_top: "The top edge may look ragged.",
  no_ironing_flat_top: "The top may look stripy.",
  fast_visible_walls: "Edges may look less crisp.",
  starts_mid_air: "Something starts in mid-air and may droop.",
  top_lines_hit_curves: "The top edge may look rough.",
  bottom_lines_hit_curves: "The plate-side edge may show a groove.",
  stringing_risk: "Some thin strings are likely.",
}
const plainIssue = (w: GcodeQualityIssue) => ISSUE_PLAIN[w.code] ?? (w.title ? `${w.title}.` : w.message.split(/(?<=\.)\s/)[0])

/** "Design is Black · prints in White." when the print uses another colour than the design asks for. */
function colourMismatch(req: PrintRequest): string | null {
  const want = (req.designColors ?? []).map((c) => c.trim()).filter(Boolean)
  const got = req.slotFilaments ?? []
  if (!want.length || !got.length) return null
  const norm = (c: string) => c.toLowerCase().replace(/[^a-z0-9#]/g, "")
  const printed = new Set(got.flatMap((f) => [norm(f.colorName), norm(f.colorHex)]))
  if (want.every((c) => printed.has(norm(c)))) return null
  const cap = (s: string) => (s.startsWith("#") ? s : s.charAt(0).toUpperCase() + s.slice(1))
  return `Design is ${want.map(cap).join(", ")} · prints in ${[...new Set(got.map((f) => f.colorName))].join(", ")}.`
}

interface ApprovalChecks {
  state: "checking" | "passed" | "failed"
  failing: { partId: string; text: string }[]
}

/**
 * The checks of the design a print would approve: the latest check of each part when it's current, else they run now
 * (checks never change the design, so the request stays current).
 */
function useApprovalChecks(req: PrintRequest | undefined): ApprovalChecks {
  const projectId = req?.needsApproval ? req.projectId : null
  const partIds = req?.needsApproval ? (req.job?.partIds ?? []) : []
  const ids = [...new Set(partIds)].join(",")
  const validity = useStudio((s) => (projectId ? s.validity[projectId] : undefined))
  const checks = useStudio((s) => s.checks)
  const checking = useStudio((s) => s.checking)
  const started = useRef(new Set<string>())
  useEffect(() => {
    if (!projectId || !ids) return
    const st = useStudio.getState()
    if (!validity) {
      st.loadValidity(projectId)
      return
    }
    for (const pid of ids.split(",")) {
      const k = partKey(projectId, pid)
      if (started.current.has(k)) continue
      started.current.add(k)
      if (validity.parts[pid]?.check.state === "fresh") {
        if (!st.checks[k]) void st.loadLatest(projectId, pid)
      } else void st.check(projectId, pid).catch(() => {})
    }
  }, [projectId, ids, validity])
  if (!projectId) return { state: "passed", failing: [] }
  const failing: ApprovalChecks["failing"] = []
  let pending = false
  for (const pid of ids.split(",").filter(Boolean)) {
    const k = partKey(projectId, pid)
    const r = checks[k]
    if (checking[k] || !r) {
      pending = true
      continue
    }
    for (const i of r.items.filter((x) => x.severity === "fail")) failing.push({ partId: pid, text: `${ruleLabel(i.rule)}: ${i.message.split(/(?<=\.)\s/)[0]}` })
  }
  return { state: failing.length ? "failed" : pending ? "checking" : "passed", failing }
}

function ChecksSummary({ checks }: { checks: ApprovalChecks }) {
  if (checks.state === "checking")
    return (
      <p className="flex items-center gap-1.5 text-caption text-muted-foreground" role="status">
        <Loader2Icon className="size-3 animate-spin" aria-hidden /> Checking the design…
      </p>
    )
  if (checks.state === "passed")
    return (
      <p className="flex items-center gap-1.5 text-caption text-ok" role="status">
        <CheckIcon className="size-3" aria-hidden /> Checks passed
      </p>
    )
  return (
    <div className="flex flex-col gap-1 border border-err/40 bg-err/5 p-2.5 text-caption" role="status">
      <span className="flex items-center gap-1.5 font-medium text-err">
        <OctagonXIcon className="size-3" aria-hidden /> {checks.failing.length === 1 ? "1 check failed" : `${checks.failing.length} checks failed`}. It may not print well.
      </span>
      <ul className="list-disc pl-4 text-muted-foreground">
        {checks.failing.map((c, i) => (
          <li key={i}>{c.text}</li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Why a machine can't take this project's job (plain words), or null: bed too small for the biggest
 * part, colours the model needs not loaded, no connection, offline, or busy.
 */
function useEligibility(projectId: string | null) {
  const renders = useStudio((s) => s.renders)
  const slices = useStudio((s) => s.slices)
  const project = useStudio((s) => s.project)
  const units = useUnits((s) => s.units)
  return (m: MachineWithStatus): string | null => {
    if (!projectId) return null
    if (!m.enabled) return "turned off"
    if (m.connection.type === "none") return "no connection (send the file by hand)"
    const st = m.status
    if (!st || !st.connected || st.state === "disconnected") return "offline"
    if (st.state === "printing" || st.state === "paused" || st.state === "preparing") return "busy printing"
    // size: largest rendered part of the project
    const size = Object.entries(renders)
      .filter(([k]) => k.startsWith(`${projectId}/`))
      .map(([, r]) => r.stats?.sizeMm)
      .filter((x): x is [number, number, number] => !!x)
      .reduce<[number, number, number]>((a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])], [0, 0, 0])
    const [bx, by, bz] = m.buildVolumeMm
    const fits = (size[0] <= bx && size[1] <= by) || (size[1] <= bx && size[0] <= by)
    if (size[0] && (!fits || size[2] > bz)) return `too big for its ${fmtDims([bx, by, bz], units)} bed`
    // colours: from a multicolour slice if we have one, else the project's part colours
    const sliced = Object.entries(slices)
      .filter(([k]) => k.startsWith(`${projectId}/`))
      .flatMap(([, r]) => r.filamentBySlot?.map((u) => u.colorName) ?? [])
    const wanted = sliced.length ? sliced : project?.id === projectId ? project.parts.flatMap((p) => p.colors ?? []) : []
    const norm = (c: string) => c.toLowerCase().replace(/[^a-z0-9#]/g, "")
    const loaded = m.filaments.filter((f) => f.loaded)
    const missing = [...new Set(wanted.map(norm))].filter((c) => c && !loaded.some((f) => norm(f.colorName) === c || norm(f.colorHex) === c))
    if (missing.length && loaded.length) return `needs ${missing.join(", ")} loaded`
    return null
  }
}

/** The slice preview of the file being printed (matched by name to the project's last slice, else build/<name>). */
function useSlicePreview(projectId: string | null, gcodeName: string | null, snapshotPath: string | null): SlicePreviewSummary | null {
  const last = useStudio((s) => (projectId ? s.lastGcode[projectId] : undefined))
  const path = snapshotPath ?? (gcodeName ? (last && last.split("/").pop() === gcodeName ? last : `build/${gcodeName}`) : null)
  const cached = useStudio((s) => (projectId && path ? s.previews[`${projectId}|${path}`] : undefined))
  const loadPreview = useStudio((s) => s.loadPreview)
  useEffect(() => {
    if (projectId && path && !cached) void loadPreview(projectId, path)
  }, [projectId, path, cached, loadPreview])
  return cached ?? null
}
