import { useEffect, useState } from "react"
import { toast } from "sonner"
import {
  CameraIcon,
  CameraOffIcon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  PrinterIcon,
  RefreshCwIcon,
  SquareIcon,
  ThermometerIcon,
} from "@/components/icons"
import { Button } from "@/components/ui/button"
import type { MachineWithStatus } from "@shared/types"
import { EmptyState } from "@/components/panel"
import { api, errMsg } from "@/lib/api"
import { fmtDuration, printerStateWord } from "@/lib/format"
import { useStudio } from "@/stores/studio"
import { PrintHistory } from "./PrintHistory"
import { MachinePicker } from "@/components/machines/MachinePicker"
import { FirmwareStopped, isUnreachable, NoAnswer } from "@/components/machines/MachinesScreen"
import { cn } from "@/lib/utils"
import { CameraView as LiveCamera, WatchPrintButton } from "@/components/camera/CameraView"
import { PrintByHandSteps, SavePrintFileButton, SupportLine } from "@/components/machines/PrinterSupport"
import { supportForMachine } from "@shared/printer-support"

export function PrinterPanel() {
  const legacyPrinter = useStudio((s) => s.printer)
  const printerError = useStudio((s) => s.printerError)
  const refreshLegacy = useStudio((s) => s.refreshPrinter)
  const machines = useStudio((s) => s.machines)
  // the printer this project is printing on (may differ from its own), else its printer
  const target = useStudio((s) => s.watchMachineId(s.project?.id))
  const projectId = useStudio((s) => s.project?.id ?? null)
  const [picked, setPicked] = useState<string | null>(null)
  const machineId = picked ?? target
  const machine = machines?.find((m) => m.id === machineId) ?? null
  // with Machines the status comes from the chosen machine; older servers: the single printer
  const printer = machine ? machine.status : legacyPrinter
  const refresh = async () => {
    await Promise.all([refreshLegacy(), useStudio.getState().loadMachines()])
  }
  const [busy, setBusy] = useState<string | null>(null)
  const picker = machines && machines.length > 0 && (
    <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
      Printer
      <MachinePicker value={machineId} onChange={setPicked} />
    </div>
  )

  const act = async (a: "pause" | "resume" | "cancel") => {
    if (a === "cancel" && !window.confirm(`Stop the print${machine ? ` on ${machine.name}` : ""}? It can't be resumed.`)) return
    setBusy(a)
    try {
      await (machine ? api.machineAction(machine.id, a) : api.printerAction(a))
      void refresh()
    } catch (e) {
      toast.error(`Couldn't ${a === "cancel" ? "stop the print" : a}`, { description: errMsg(e) })
    } finally {
      setBusy(null)
    }
  }
  const test = async () => {
    setBusy("test")
    try {
      const r = await (machine ? api.testMachine(machine.id) : api.printerTest())
      if (r.ok) toast.success("Printer reachable")
      else toast.error("Printer test failed", { description: r.error })
    } catch (e) {
      toast.error("Printer test failed", { description: errMsg(e) })
    } finally {
      setBusy(null)
      void refresh()
    }
  }

  if (machine && machine.connection.type === "none") return <PrintByHand machine={machine} picker={picker} />

  // A network printer that didn't answer: say so plainly with one way to try again (no raw network error, no
  // job controls or empty temperatures). The raw reason stays on hover.
  if (machine?.status && isUnreachable(machine))
    return (
      <div className="flex flex-col gap-3 p-3">
        {picker}
        <div className="flex items-center gap-2 text-xs">
          <PrinterIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <NoAnswer m={machine} />
        </div>
        {projectId && (
          <div>
            <div className="ps-label mb-1">Prints of this project</div>
            <PrintHistory projectId={projectId} limit={4} />
          </div>
        )}
      </div>
    )

  if (!printer)
    return (
      <div className="p-3">
      {picker}
      <EmptyState
        icon={<PrinterIcon />}
        title="Printer status unavailable"
        detail={machine ? `Checking ${machine.name}…` : printerError ? "No answer from the printer" : "Waiting for printer status…"}
        action={
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void refresh()}>
              <RefreshCwIcon /> Refresh
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void test()}
              disabled={busy === "test"}
            >
              Test connection
            </Button>
          </div>
        }
      />
      </div>
    )

  const pct = Math.round((printer.progress ?? 0) * 100)
  // Pause/Resume/Cancel only make sense for a live job on a connected printer (not complete/cancelled/standby).
  const state = String(printer.state).toLowerCase()
  const finished = (printer.progress ?? 0) >= 0.999 && state !== "paused"
  const preparing = state === "preparing"
  // preparing counts as active so Cancel works while it heats/loads filament
  const active = printer.connected && !finished && (state === "printing" || state === "paused" || preparing)
  // the printer's own estimate when it has one (Creality), else derived from progress
  const remaining =
    printer.timeLeftS ??
    (printer.progress > 0.01 && printer.printDurationS > 0 ? (printer.printDurationS / printer.progress) * (1 - printer.progress) : null)

  return (
    <div className="flex h-full gap-3 overflow-auto p-3">
      <div className="flex min-w-0 flex-1 flex-col">
        {picker}
        <div className="flex items-center gap-2">
          <PrinterIcon className="size-4 text-muted-foreground" />
          <span className="font-medium">
            {machine?.name ?? printer.host ?? "No host configured"}
          </span>
          {printer.isMock && machine?.isPractice && (
            <span className="rounded-sm bg-muted px-1 text-micro text-muted-foreground">
              practice
            </span>
          )}
          <span
            className={cn(
              "border px-1.5 text-micro",
              (printer.state === "printing" || printer.state === "preparing") && "border-primary/40 text-primary",
              printer.state === "paused" &&
                "border-warn/40 text-warn",
              printer.state === "error" && "border-err/40 text-err",
              (printer.state === "standby" || printer.state === "complete") &&
                "border-ok/40 text-ok",
              (printer.state === "disconnected" ||
                printer.state === "cancelled") &&
                "text-muted-foreground"
            )}
          >
            {printerStateWord(printer.state, printer.firmware)}
          </span>
          <div className="flex-1" />
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void test()}
            disabled={busy === "test"}
          >
            {busy === "test" ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <RefreshCwIcon />
            )}{" "}
            Test
          </Button>
        </div>
        {preparing && (
          <div className="mt-1 text-caption text-primary">
            <span title="Heating, loading filament and cleaning the nozzle. Takes a few minutes.">Preparing · {printer.phase ?? "getting ready"}</span>
          </div>
        )}
        {printer.connected && printer.firmware ? (
          <div className="mt-1 text-xs">
            <FirmwareStopped m={machine ?? undefined} firmware={printer.firmware} />
          </div>
        ) : printer.message && !preparing && (
          <div className="mt-1 text-caption text-muted-foreground">
            {printer.message}
          </div>
        )}

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Temp label="Nozzle" t={printer.extruder} />
          <Temp label="Bed" t={printer.bed} />
          <Stat label="Elapsed" value={fmtDuration(printer.printDurationS)} />
          <Stat
            label="Remaining"
            value={active ? fmtDuration(remaining) : "—"}
          />
        </div>

        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between text-caption">
            <span className="truncate font-mono">
              {printer.filename ?? "No active job"}
            </span>
            <span className="tabular-nums">
              {preparing
                ? "preparing"
                : `${printer.layer != null ? `layer ${printer.layer}${printer.totalLayers ? `/${printer.totalLayers}` : ""} · ` : ""}${pct}%`}
            </span>
          </div>
          <div
            className={cn("ps-seg", preparing && "animate-[ps-pulse_1.4s_infinite]")}
            style={{ "--p": preparing ? "100%" : `${pct}%`, "--c": printer.state === "paused" ? "var(--warn)" : undefined } as React.CSSProperties}
          >
            <i />
          </div>
        </div>

        {/* Pause / Resume / Cancel only while there is a print to control */}
        {active && (
        <div className="mt-3 flex gap-2">
          {state === "paused" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!!busy || !active}
              onClick={() => void act("resume")}
            >
              {busy === "resume" ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <PlayIcon />
              )}{" "}
              Resume
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={!!busy || !active || state !== "printing"}
              onClick={() => void act("pause")}
            >
              {busy === "pause" ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <PauseIcon />
              )}{" "}
              Pause
            </Button>
          )}
          <Button
            size="sm"
            variant="destructive"
            disabled={!!busy || !active}
            onClick={() => void act("cancel")}
          >
            {busy === "cancel" ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <SquareIcon />
            )}{" "}
            Stop
          </Button>
        </div>
        )}
        {projectId && (
          <div className="mt-4">
            <div className="ps-label mb-1">Prints of this project</div>
            <PrintHistory projectId={projectId} limit={4} />
          </div>
        )}
      </div>
      {machine?.camera?.type === "creality-webrtc" ? (
        <div className="flex w-80 shrink-0 flex-col gap-1">
          <div className="ps-label flex items-center gap-1">
            <CameraIcon className="size-3" /> Camera
            <div className="flex-1" />
            <WatchPrintButton machine={machine} />
          </div>
          <LiveCamera key={machine.id} machine={machine} className="aspect-video border" />
        </div>
      ) : (
        <CameraView key={machine?.id ?? "default"} live={active} connected={printer.connected} machineId={machine?.id ?? null} />
      )}
    </div>
  )
}

/** Printer camera frame via GET /api/printer/snapshot; refreshes every 5 s while printing. */
function CameraView({
  live,
  connected,
  machineId,
}: {
  live: boolean
  connected: boolean
  machineId: string | null
}) {
  const [tick, setTick] = useState(() => Date.now())
  const [state, setState] = useState<"loading" | "ok" | "none">("loading")
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => setTick(Date.now()), 5000)
    return () => clearInterval(t)
  }, [live])
  const reload = () => {
    setState("loading")
    setTick(Date.now())
  }
  return (
    <div className="flex w-72 shrink-0 flex-col gap-1">
      <div className="ps-label flex items-center gap-1">
        <CameraIcon className="size-3" /> Camera
        {live && state === "ok" && (
          <span
            className="ml-1 size-1.5 animate-pulse bg-err rounded-full"
            title="refreshing every 5 s"
          />
        )}
        <div className="flex-1" />
        <button
          className="normal-case hover:text-foreground"
          onClick={reload}
          title="Refresh frame"
        >
          <RefreshCwIcon className="size-3" />
        </button>
      </div>
      <div className="relative flex aspect-[4/3] items-center justify-center overflow-hidden border bg-black/40">
        {connected && state !== "none" && (
          <img
            src={machineId ? api.machineSnapshotUrl(machineId, tick) : `/api/printer/snapshot?t=${tick}`}
            alt="Printer camera"
            className={cn(
              "size-full object-contain",
              state !== "ok" && "opacity-0"
            )}
            onLoad={() => setState("ok")}
            onError={() => setState("none")}
          />
        )}
        {(!connected || state === "none") && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-caption text-muted-foreground">
            <CameraOffIcon className="size-5 opacity-50" />
            {connected ? "No camera frame" : "Offline"}
          </div>
        )}
        {connected && state === "loading" && (
          <Loader2Icon className="absolute size-4 animate-spin text-muted-foreground" />
        )}
      </div>
    </div>
  )
}

function Temp({
  label,
  t,
}: {
  label: string
  t: { temp: number; target: number }
}) {
  const heating = t.target > 0
  return (
    <div className="border bg-card px-2 py-1.5">
      <div className="ps-label flex items-center gap-1">
        <ThermometerIcon
          className={cn("size-3", heating && "text-warn")}
        />
        {label}
      </div>
      <div className="text-sm tabular-nums">
        {Math.round(t.temp)}°
        <span className="text-caption text-muted-foreground">
          {" "}
          / {Math.round(t.target)}°
        </span>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border bg-card px-2 py-1.5">
      <div className="ps-label">
        {label}
      </div>
      <div className="text-sm tabular-nums">{value}</div>
    </div>
  )
}

/** Export-only path: a printer Crease can't reach. Save the current slice and print it from the printer. */
function PrintByHand({ machine, picker }: { machine: MachineWithStatus; picker: React.ReactNode }) {
  const project = useStudio((s) => s.project)
  const partId = useStudio((s) => s.selectedPartId)
  const jobs = useStudio((s) => (project ? s.jobs[project.id] : undefined))
  const multi = (project?.parts.length ?? 0) > 1
  const plates = multi ? (jobs?.plates?.plates ?? []).filter((p) => p.machineId === machine.id) : []
  const part = !multi && partId ? jobs?.parts[partId] : undefined
  const slices = (multi ? plates : part && part.machineId === machine.id ? [part] : []).filter((j) => !j.stale.length)
  return (
    <div className="flex flex-col gap-3 p-3">
      {picker}
      <div>
        <div className="flex items-center gap-2 text-sm font-medium">
          <PrinterIcon className="size-4 text-muted-foreground" /> {machine.name} has no connection
        </div>
        <SupportLine support={supportForMachine(machine)} connection="none" className="mt-0.5" />
      </div>
      <PrintByHandSteps printerName={machine.name} />
      {project && slices.length ? (
        <div className="flex flex-col gap-2">
          {slices.map((j, i) => (
            <div key={j.id} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-mono text-muted-foreground">{multi ? `Plate ${i + 1}` : j.gcodeName}</span>
              <SavePrintFileButton projectId={project.id} gcodePath={j.gcodePath} allow3mf={!multi} size="xs" />
            </div>
          ))}
        </div>
      ) : (
        <p className="text-caption text-muted-foreground">Slice first.</p>
      )}
    </div>
  )
}
