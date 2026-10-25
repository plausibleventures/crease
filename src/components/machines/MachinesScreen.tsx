// Machines: every printer the user has (one at home, or a farm). Live state, temps, progress, loaded
// colours; grid or compact table; filter by state / tag from one menu. Secondary actions live in each printer's ⋯ menu.
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import {
  CameraOffIcon,
  CheckIcon,
  ChevronDownIcon,
  LayoutGridIcon,
  ListIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  PrinterIcon,
  RefreshCwIcon,
  ServerCrashIcon,
  SquareIcon,
  StarIcon,
  ThermometerIcon,
} from "@/components/icons"
import type { MachineWithStatus } from "@shared/types"
import { AppNav } from "@/components/AppNav"
import { LittlePrinter } from "@/design/illustrations"
import { DetailsToggle, EmptyState, PageHeader } from "@/components/panel"
import { Button } from "@/components/ui/button"
import { Segmented } from "@/components/ui/segmented"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { api, errMsg } from "@/lib/api"
import { fmtDuration } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useRemembered } from "@/lib/use-remembered"
import { CameraView as LiveCamera, WatchPrintButton } from "@/components/camera/CameraView"
import { useStudio } from "@/stores/studio"
import { FilamentSwatches } from "./FilamentSlotsEditor"
import { SupportLine } from "./PrinterSupport"
import { supportForMachine } from "@shared/printer-support"
import { useLength } from "@/lib/units"

/** The line under a printer's name: its model, unless the name already says it. */
const subtitle = (m: MachineWithStatus) => {
  const s = m.isPractice ? "Practice printer" : m.model
  return s === m.name ? "" : s
}

const connKind =(m: MachineWithStatus) => (m.connection.type === "none" ? "none" : m.isPractice ? "practice" : "network")

type StateFilter = "all" | "printing" | "idle" | "byhand" | "offline" | "problem"
const FILTER_LABEL: Record<StateFilter, string> = { all: "All", printing: "Printing", idle: "Ready", byhand: "By hand", offline: "Offline", problem: "Needs attention" }

export function machineState(m: MachineWithStatus): { key: StateFilter; label: string; tone: string } {
  if (!m.enabled) return { key: "offline", label: "Turned off", tone: "text-muted-foreground" }
  if (m.connection.type === "none") return { key: "byhand", label: "By hand", tone: "text-muted-foreground" }
  const st = m.status
  if (!st || !st.connected || st.state === "disconnected") return { key: "offline", label: "Offline", tone: "text-muted-foreground" }
  if (st.firmware === "shutdown") return { key: "problem", label: "Stopped for safety", tone: "text-err" }
  if (st.firmware === "startup") return { key: "problem", label: "Starting up", tone: "text-warn" }
  switch (st.state) {
    case "printing":
      return { key: "printing", label: "Printing", tone: "text-primary" }
    case "preparing":
      return { key: "printing", label: "Preparing", tone: "text-primary" }
    case "paused":
      return { key: "printing", label: "Paused", tone: "text-warn" }
    case "error":
      return { key: "problem", label: "Needs attention", tone: "text-err" }
    case "complete":
      return { key: "idle", label: "Done", tone: "text-ok" }
    default:
      return { key: "idle", label: "Ready", tone: "text-ok" }
  }
}

export function MachinesScreen() {
  const machines = useStudio((s) => s.machines)
  const error = useStudio((s) => s.machinesError)
  const load = useStudio((s) => s.loadMachines)
  const setDialog = useStudio((s) => s.setMachineDialog)
  const [view, setView] = useState<"grid" | "list">(() => {
    try {
      return localStorage.getItem("ps-machines-view") === "list" ? "list" : "grid"
    } catch {
      return "grid"
    }
  })
  const [stateFilter, setStateFilter] = useState<StateFilter>("all")
  // U2: simple cards/rows by default; Details (remembered) adds temperatures, what works, and tags
  const [details, setDetails] = useRemembered("machines")
  const [tag, setTag] = useState<string | null>(null)

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 5000) // states also arrive over WS; this keeps temps/progress fresh
    return () => clearInterval(t)
  }, [load])

  const list = useMemo(() => machines ?? [], [machines])
  const tags = useMemo(() => [...new Set(list.flatMap((m) => m.tags ?? []))].sort(), [list])
  const counts = useMemo(() => {
    const c: Record<StateFilter, number> = { all: 0, printing: 0, idle: 0, byhand: 0, offline: 0, problem: 0 }
    for (const m of list) c[machineState(m).key]++
    return c
  }, [list])
  const shown = list.filter((m) => (stateFilter === "all" || machineState(m).key === stateFilter) && (!tag || m.tags?.includes(tag)))

  const setViewKeep = (v: "grid" | "list") => {
    setView(v)
    try {
      localStorage.setItem("ps-machines-view", v)
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="relative flex h-full flex-col">
      <header data-glass-chrome="top" className="flex h-10 shrink-0 items-center gap-2 border-b bg-sidebar px-3">
        <AppNav />
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 p-5">
          <PageHeader
            title="Machines"
            primary={
              <Button size="sm" onClick={() => setDialog({ id: null })}>
                <PlusIcon /> Add printer
              </Button>
            }
          >
        {list.length > 1 && (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="sm" title="Show" />}>
                {FILTER_LABEL[stateFilter]}
                {tag ? ` · ${tag}` : ""}
                <ChevronDownIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {(Object.keys(FILTER_LABEL) as StateFilter[])
                  .filter((f) => f === "all" || counts[f] > 0)
                  .map((f) => (
                    <DropdownMenuItem key={f} onClick={() => setStateFilter(f)}>
                      {stateFilter === f ? <CheckIcon /> : <span className="size-3.5" />} {FILTER_LABEL[f]}
                      <span className="ml-auto pl-3 text-micro text-muted-foreground">{f === "all" ? list.length : counts[f]}</span>
                    </DropdownMenuItem>
                  ))}
                {tags.length > 0 && <DropdownMenuSeparator />}
                {tags.map((t) => (
                  <DropdownMenuItem key={t} onClick={() => setTag(tag === t ? null : t)}>
                    {tag === t ? <CheckIcon /> : <span className="size-3.5" />} {t}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Segmented
              label="View"
              value={view}
              onChange={setViewKeep}
              className="h-7"
              options={[
                { value: "grid", label: <><LayoutGridIcon className="size-3.5" aria-hidden /><span className="sr-only">Grid</span></>, title: "Grid" },
                { value: "list", label: <><ListIcon className="size-3.5" aria-hidden /><span className="sr-only">List</span></>, title: "List" },
              ]}
            />
          </>
        )}
        {list.length > 0 && <DetailsToggle open={details} onToggle={() => setDetails((d) => !d)} />}
          </PageHeader>
          {machines === null && error ? (
            <EmptyState
              icon={<ServerCrashIcon />}
              title="Couldn't load your printers"
              detail={error}
              action={
                <Button variant="outline" size="sm" onClick={() => void load()}>
                  Retry
                </Button>
              }
            />
          ) : machines === null ? (
            <EmptyState icon={<Loader2Icon className="animate-spin" />} title="Loading…" />
          ) : list.length === 0 ? (
            <EmptyState
              art="machines"
              title="No printers yet"
              action={
                <Button size="sm" onClick={() => setDialog({ id: null })}>
                  <PlusIcon /> Add printer
                </Button>
              }
            />
          ) : shown.length === 0 ? (
            <EmptyState icon={<PrinterIcon />} title="No printers match" />
          ) : view === "grid" ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
              {shown.map((m) => (
                <MachineCard key={m.id} m={m} details={details} />
              ))}
            </div>
          ) : (
            <MachineTable list={shown} details={details} />
          )}
        </div>
      </div>
    </div>
  )
}

function useMachineActions(m: MachineWithStatus) {
  const load = useStudio((s) => s.loadMachines)
  const [busy, setBusy] = useState<string | null>(null)
  const run = async (what: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(what)
    try {
      await fn()
      if (ok) toast.success(ok)
    } catch (e) {
      toast.error(`Couldn't ${what}`, { description: errMsg(e) })
    } finally {
      setBusy(null)
      void load()
    }
  }
  return {
    busy,
    toggleEnabled: () => run("change it", () => api.updateMachine(m.id, { enabled: !m.enabled })),
    makeDefault: () => run("make it the default", () => api.setDefaultMachine(m.id), `${m.name} is now the default`),
    act: (a: "pause" | "resume" | "cancel") => {
      if (a === "cancel" && !window.confirm(`Stop the print on ${m.name}? It can't be resumed.`)) return
      void run(a === "cancel" ? "stop the print" : a, () => api.machineAction(m.id, a))
    },
  }
}

/** Edit · make default · turn on/off: everything a printer offers besides Pause/Stop. */
function MachineMenu({ m }: { m: MachineWithStatus }) {
  const setDialog = useStudio((s) => s.setMachineDialog)
  const { busy, toggleEnabled, makeDefault } = useMachineActions(m)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" title="More" aria-label={`More for ${m.name}`} />}>
        {busy ? <Loader2Icon className="animate-spin" /> : <MoreHorizontalIcon />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setDialog({ id: m.id })}>
          <PencilIcon /> Edit…
        </DropdownMenuItem>
        {!m.isDefault && (
          <DropdownMenuItem onClick={() => void makeDefault()} disabled={!!busy}>
            <StarIcon /> Make default
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => void toggleEnabled()} disabled={!!busy}>
          {m.enabled ? <CheckIcon /> : <span className="size-3.5" />} Available for prints
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Temps({ m }: { m: MachineWithStatus }) {
  const st = m.status
  if (!st?.connected) return null
  return (
    <span className="flex items-center gap-1 text-caption text-muted-foreground tabular-nums" title="Nozzle / bed temperature">
      <ThermometerIcon className={cn("size-3", (st.extruder.target > 0 || st.bed.target > 0) && "text-warn")} />
      {Math.round(st.extruder.temp)}° / {Math.round(st.bed.temp)}°
    </span>
  )
}

function Progress({ m }: { m: MachineWithStatus }) {
  const st = m.status
  if (st?.state === "preparing")
    return (
      <div className="flex flex-col gap-1">
        <div className="truncate text-caption text-primary" title={st.filename ?? undefined}>
          {st.phase ?? "Getting ready"}
        </div>
        <div className="ps-seg animate-[ps-pulse_1.4s_infinite]" style={{ "--p": "100%" } as React.CSSProperties}>
          <i />
        </div>
      </div>
    )
  if (!st || (st.state !== "printing" && st.state !== "paused")) return null
  const pct = Math.round((st.progress ?? 0) * 100)
  const remaining = st.timeLeftS ?? (st.progress > 0.01 && st.printDurationS > 0 ? (st.printDurationS / st.progress) * (1 - st.progress) : null)
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-caption" title={st.filename ?? undefined}>
        <span className="tabular-nums">{pct}%</span>
        {remaining ? <span className="tabular-nums text-muted-foreground">{fmtDuration(remaining)} left</span> : null}
      </div>
      <div className="ps-seg" style={{ "--p": `${pct}%`, "--c": st.state === "paused" ? "var(--warn)" : undefined } as React.CSSProperties}>
        <i />
      </div>
    </div>
  )
}

function Camera({ m }: { m: MachineWithStatus }) {
  // The practice printer has no camera: a drawing of a printer, not an empty camera frame. Same frame as a camera,
  // so cards in the grid line up.
  if (m.isPractice)
    return (
      <div className="flex aspect-video items-center justify-center border-b border-line bg-surface-1 text-muted-foreground [--sb-accent:var(--primary)] [--sb-art-stroke:2]">
        <LittlePrinter width={88} height={88} />
      </div>
    )
  // WebRTC cameras (Creality): a live thumbnail, connected only while the card is on screen.
  if (m.camera?.type === "creality-webrtc" && m.status?.connected)
    return <LiveCamera machine={m} className="aspect-video border-b border-line" overlay={<WatchCorner m={m} />} />
  return <SnapshotCamera m={m} />
}

function WatchCorner({ m }: { m: MachineWithStatus }) {
  return (
    <div className="absolute top-1.5 right-1.5">
      <WatchPrintButton machine={m} />
    </div>
  )
}

function SnapshotCamera({ m }: { m: MachineWithStatus }) {
  const live = m.status?.state === "printing"
  const [t, setT] = useState(() => Date.now())
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!live) return
    const i = setInterval(() => setT(Date.now()), 10000)
    return () => clearInterval(i)
  }, [live])
  if (!m.status?.connected || failed)
    return (
      <div className="flex aspect-video items-center justify-center border-b border-line bg-surface-1 text-faint [--sb-accent:var(--faint)] [--sb-art-stroke:1.25]">
        <LittlePrinter width={88} height={88} />
      </div>
    )
  return (
    <div className="relative aspect-video overflow-hidden bg-surface-2">
      <img src={api.machineSnapshotUrl(m.id, t)} alt={`${m.name} camera`} className="size-full object-cover" onError={() => setFailed(true)} />
      {failed && <CameraOffIcon className="absolute inset-0 m-auto size-6 text-muted-foreground" />}
    </div>
  )
}

function PauseStop({ m }: { m: MachineWithStatus }) {
  const { busy, act } = useMachineActions(m)
  const active = m.status?.state === "printing" || m.status?.state === "paused" || m.status?.state === "preparing"
  if (!active) return null
  return (
    <>
      {m.status?.state === "paused" ? (
        <Button size="xs" variant="ghost" onClick={() => act("resume")} disabled={!!busy}>
          <PlayIcon /> Resume
        </Button>
      ) : (
        <Button size="xs" variant="ghost" onClick={() => act("pause")} disabled={!!busy}>
          <PauseIcon /> Pause
        </Button>
      )}
      <Button size="xs" variant="ghost" className="text-err" onClick={() => act("cancel")} disabled={!!busy}>
        <SquareIcon /> Stop
      </Button>
    </>
  )
}

/** On, has a network connection, but the last status found no printer. */
export const isUnreachable = (m: MachineWithStatus) => m.enabled && m.connection.type !== "none" && machineState(m).key === "offline"

/** MACH-01: "No answer from Garage i7 · Check again": the state you can act on, in place. */
export function NoAnswer({ m }: { m: MachineWithStatus }) {
  const load = useStudio((s) => s.loadMachines)
  const [busy, setBusy] = useState(false)
  const check = async () => {
    setBusy(true)
    try {
      const r = await api.testMachine(m.id)
      if (r.ok) toast.success(`${m.name} answered`)
      else toast.error(`Still no answer from ${m.name}`, { description: "Is it on, and on the same Wi-Fi?" })
    } catch (e) {
      toast.error(`Couldn't check ${m.name}`, { description: errMsg(e) })
    } finally {
      setBusy(false)
      void load()
    }
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-muted-foreground">
      <span title={m.status?.message ?? undefined}>
        No answer from {m.name}
      </span>
      <span aria-hidden>·</span>
      <Button size="xs" variant="link" className="h-auto px-0" onClick={() => void check()} disabled={busy}>
        {busy && <Loader2Icon className="animate-spin" />}
        Check again
      </Button>
    </span>
  )
}

const FIRMWARE_LINE = {
  shutdown: "The printer stopped itself for safety.",
  error: "The printer's firmware has a problem.",
  startup: "Starting up…",
} as const

/**
 * Klipper isn't ready (status.firmware): one plain sentence and the way back, in place. The firmware's own text
 * stays in the server log. No Pause / Stop meanwhile: a shut-down printer takes no print commands.
 */
export function FirmwareStopped({
  m,
  machineId,
  firmware,
  inline = false,
}: {
  m?: MachineWithStatus
  machineId?: string | null
  firmware: "shutdown" | "error" | "startup"
  inline?: boolean // a table cell: "sentence · Restart printer" on one line
}) {
  const load = useStudio((s) => s.loadMachines)
  const refreshPrinter = useStudio((s) => s.refreshPrinter)
  const [busy, setBusy] = useState(false)
  const id = m?.id ?? machineId ?? null
  const restart = async () => {
    setBusy(true)
    try {
      await (id ? api.restartFirmware(id) : api.printerRestartFirmware())
    } catch (e) {
      toast.error("Couldn't restart the printer", { description: errMsg(e) })
    } finally {
      setBusy(false)
      void load()
      void refreshPrinter()
    }
  }
  if (firmware === "startup")
    return (
      <span className="flex items-center gap-1.5 text-warn">
        <Loader2Icon className="size-3 animate-spin" aria-hidden />
        {FIRMWARE_LINE.startup}
      </span>
    )
  const sentence = (
    <span className="text-err" role="status" title="Restarting moves and heats nothing. The print on it can't continue.">
      {FIRMWARE_LINE[firmware]}
    </span>
  )
  if (inline)
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
        {sentence}
        <span aria-hidden className="text-muted-foreground">·</span>
        <Button size="xs" variant="link" className="h-auto px-0" onClick={() => void restart()} disabled={busy}>
          {busy && <Loader2Icon className="animate-spin" />}
          Restart printer
        </Button>
      </span>
    )
  return (
    <div className="flex flex-col items-start gap-2">
      {sentence}
      <Button size="sm" variant="outline" onClick={() => void restart()} disabled={busy}>
        {busy ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
        Restart printer
      </Button>
    </div>
  )
}

/** A printer that is heating or hot shows its temperatures even without Details. */
const heating = (m: MachineWithStatus) => !!m.status?.connected && (m.status.extruder.target > 0 || m.status.bed.target > 0)

function MachineCard({ m, details }: { m: MachineWithStatus; details: boolean }) {
  const length = useLength()
  const st = machineState(m)
  return (
    <div className={cn("flex flex-col overflow-hidden rounded-lg border bg-card", !m.enabled && "opacity-60")}>
      <Camera m={m} />
      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium">{m.name}</span>
              {m.isDefault && <StarIcon className="size-3 shrink-0 fill-current text-primary" aria-label="Default" />}
            </div>
            <div className="truncate text-caption text-muted-foreground" title={`Bed ${length.dims(m.buildVolumeMm.slice(0, 2))}`}>
              {subtitle(m)}
            </div>
            {details && <SupportLine support={supportForMachine(m)} connection={connKind(m)} />}
          </div>
          <MachineMenu m={m} />
        </div>
        {isUnreachable(m) && (
          <div className="text-xs">
            <NoAnswer m={m} />
          </div>
        )}
        {m.status?.connected && m.status.firmware && (
          <div className="text-xs">
            <FirmwareStopped m={m} firmware={m.status.firmware} />
          </div>
        )}
        <div className="flex items-center gap-2 text-xs">
          {!isUnreachable(m) && !m.status?.firmware && <span className={cn("font-medium", st.tone)}>{st.label}</span>}
          {(details || heating(m)) && <Temps m={m} />}
          <div className="flex-1" />
          <FilamentSwatches slots={m.filaments} />
        </div>
        <Progress m={m} />
        {m.status && ["printing", "paused", "preparing"].includes(m.status.state) && (
          <div className="flex items-center justify-end gap-1 border-t pt-2">
            <PauseStop m={m} />
          </div>
        )}
      </div>
    </div>
  )
}

function MachineTable({ list, details }: { list: MachineWithStatus[]; details: boolean }) {
  const setDialog = useStudio((s) => s.setMachineDialog)
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Printer</TableHead>
          <TableHead>State</TableHead>
          <TableHead>Print</TableHead>
          {details && <TableHead>Temps</TableHead>}
          <TableHead>Loaded</TableHead>
          {details && <TableHead>Tags</TableHead>}
          <TableHead className="w-10" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {list.map((m) => {
          const st = machineState(m)
          const job = m.status && (m.status.state === "printing" || m.status.state === "paused")
          const prep = m.status?.state === "preparing"
          return (
            <TableRow key={m.id} className={cn("cursor-pointer focus-within:bg-muted/40", !m.enabled && "opacity-60")} onClick={() => setDialog({ id: m.id })}>
              <TableCell>
                <div className="flex items-center gap-1.5">
                  <button type="button" className="font-medium text-foreground outline-offset-2 hover:underline" aria-label={`Edit ${m.name}`} onClick={(e) => {
                    e.stopPropagation()
                    setDialog({ id: m.id })
                  }}>
                    {m.name}
                  </button>
                  {m.isDefault && <StarIcon className="size-3 fill-primary text-primary" aria-label="Default" />}
                </div>
                <div className="text-micro text-muted-foreground">{subtitle(m)}</div>
              </TableCell>
              <TableCell className={cn("font-medium", st.tone)} onClick={(e) => (isUnreachable(m) || m.status?.firmware) && e.stopPropagation()}>
                {isUnreachable(m) ? <NoAnswer m={m} /> : m.status?.connected && m.status.firmware ? <FirmwareStopped m={m} firmware={m.status.firmware} inline /> : st.label}
              </TableCell>
              <TableCell>
                {prep ? (
                  <span className="text-caption text-primary">{m.status!.phase ?? "Getting ready"}</span>
                ) : job ? (
                  <span className="font-mono text-caption" title={m.status!.filename ?? undefined}>
                    {Math.round((m.status!.progress ?? 0) * 100)}%
                  </span>
                ) : (
                  <span className="text-faint">–</span>
                )}
              </TableCell>
              {details && (
                <TableCell>
                  <Temps m={m} />
                </TableCell>
              )}
              <TableCell>
                <FilamentSwatches slots={m.filaments} />
              </TableCell>
              {details && <TableCell className="text-caption text-muted-foreground">{(m.tags ?? []).join(", ")}</TableCell>}
              <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                <span className="inline-flex items-center gap-1">
                  <PauseStop m={m} />
                  <MachineMenu m={m} />
                </span>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
