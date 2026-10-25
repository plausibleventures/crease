import { CpuIcon, Loader2Icon, PrinterIcon, SettingsIcon, SparklesIcon } from "@/components/icons"
import { defaultMachine, partKey, useStudio } from "@/stores/studio"
import { fmtDuration, fmtMs, printerStateWord } from "@/lib/format"
import { Cost, PlanUsageMeter } from "@/components/agent/Cost"
import { useRemembered } from "@/lib/use-remembered"
import { cn } from "@/lib/utils"
import { modKey } from "@/lib/commands"
import { DetailsToggle } from "@/components/panel"

export function StatusBar() {
  const ws = useStudio((s) => s.wsStatus)
  const project = useStudio((s) => s.project)
  const route = useStudio((s) => s.route)
  const partId = useStudio((s) => s.selectedPartId)
  const rendering = useStudio((s) => s.rendering)
  const renders = useStudio((s) => s.renders)
  const agent = useStudio((s) => (s.project ? s.agent[s.project.id] : undefined))
  const machines = useStudio((s) => s.machines)
  const navigate = useStudio((s) => s.navigate)
  // in a project: the printer its print runs on, else the one it prints on (project.json `printer`); elsewhere a
  // printer that is printing, else the default machine
  const projectPrinter = useStudio((s) => (s.route.name === "project" && s.project ? s.watchMachineId(s.project.id) : null))
  const printingNow = machines?.find((m) => !!m.status && ["printing", "paused", "preparing"].includes(m.status.state))
  const defMachine = (projectPrinter ? machines?.find((m) => m.id === projectPrinter) : undefined) ?? printingNow ?? defaultMachine(machines)
  // that machine's live status (Machines servers), else the single legacy printer
  const legacy = useStudio((s) => s.printer)
  const printer = defMachine?.status ?? legacy
  // U2: the simple line by default; "Details" (remembered) adds render time, designer cost, layer, temps, filament
  const [details, setDetails] = useRemembered("statusbar")
  const printerError = useStudio((s) => s.printerError)
  const setSettingsOpen = useStudio((s) => s.setSettingsOpen)

  const inProject = route.name === "project" && project
  const busyParts = Object.entries(rendering).filter(([, v]) => v).map(([k]) => k.split("/").slice(1).join("/"))
  const last = inProject && partId ? renders[partKey(project.id, partId)] : undefined

  const wsColor = ws === "open" ? "text-ok" : ws === "connecting" ? "text-warn" : "text-err"
  const pState = printer?.state ?? "disconnected"
  const pColor =
    pState === "printing" || pState === "preparing"
      ? "text-primary"
      : pState === "paused"
        ? "text-warn"
        : pState === "error"
          ? "text-err"
          : pState === "disconnected"
            ? "text-muted-foreground"
            : "text-ok"

  return (
    // A live terminal status line: mono, lower case, one segment per subsystem.
    <div data-glass-chrome="status" className="flex h-6 shrink-0 items-center gap-0.5 border-t bg-sidebar px-0.5 text-caption text-muted-foreground select-none">
      <Item title={ws === "open" ? "Connected to Crease" : ws === "connecting" ? "Connecting…" : "Lost Crease, reconnecting"}>
        <span className={cn("size-1.5 bg-current rounded-full", wsColor, ws !== "open" && "animate-[ps-pulse_1.4s_infinite]")} />
        {ws === "connecting" ? "connecting…" : ws === "closed" ? "reconnecting…" : null}
      </Item>
      {inProject && (busyParts.length > 0 || last?.error || (details && last)) && (
        <Item title="Pictures">
          {busyParts.length ? (
            <>
              <Loader2Icon className="size-3 animate-spin text-primary" /> rendering {busyParts.join(", ")}
            </>
          ) : last?.error ? (
            <span className="text-err">render failed</span>
          ) : last ? (
            <>
              <CpuIcon className="size-3" /> {last.partId} {fmtMs(last.durationMs)}
              {last.cached ? " cached" : ""}
            </>
          ) : null}
        </Item>
      )}
      {inProject && (agent?.running || details) && (
        <Item title="Designer">
          <SparklesIcon className={cn("size-3", agent?.running && "text-primary")} />
          {agent?.running ? (
            <>
              designing <span className="ps-cursor !h-2.5 !w-1.5" />
            </>
          ) : (
            "designer idle"
          )}
          {details && <Cost usd={agent?.costUsd} />}
        </Item>
      )}
      <div className="flex-1" />
      <PlanUsageMeter className="px-1" />
      <Item
        title={[printerError ?? printer?.message ?? "Printer", printer?.connected ? `Nozzle ${Math.round(printer.extruder.temp)}° · bed ${Math.round(printer.bed.temp)}°` : null]
          .filter(Boolean)
          .join("\n")}
        onClick={() => navigate({ name: "machines" })}
      >
        <PrinterIcon className={cn("size-3", pColor)} />
        {defMachine && <span className="max-w-32 truncate text-foreground">{defMachine.name}</span>}
        <span className={pColor}>
          {printerError && !printer ? "offline" : printerStateWord(pState, printer?.firmware)}
        </span>
        {printer?.isMock && !defMachine && <span className="text-foreground">Practice printer</span>}
        {pState === "preparing" && (
          <>
            {/* indeterminate: the printer is heating / loading filament before the first layer */}
            <span className="ps-seg inline-block !h-1.5 w-16 animate-[ps-pulse_1.4s_infinite]" style={{ "--p": "100%" } as React.CSSProperties}>
              <i />
            </span>
            {printer?.phase && <span className="max-w-64 truncate text-foreground">{printer.phase}</span>}
          </>
        )}
        {(pState === "printing" || pState === "paused") && (
          <>
            <span
              className="ps-seg inline-block !h-1.5 w-16"
              style={{ "--p": `${Math.round((printer?.progress ?? 0) * 100)}%`, "--c": pState === "paused" ? "var(--warn)" : undefined } as React.CSSProperties}
            >
              <i />
            </span>
            <span className="text-foreground">{Math.round((printer?.progress ?? 0) * 100)}%</span>
            {details && printer?.layer != null && (
              <span title="Layer">
                L{printer.layer}
                {printer.totalLayers ? `/${printer.totalLayers}` : ""}
              </span>
            )}
            {printer?.timeLeftS != null && <span title="Time left">{fmtDuration(printer.timeLeftS)} left</span>}
          </>
        )}
        {details && printer?.connected && (
          <span>
            {Math.round(printer.extruder.temp)}°/{Math.round(printer.bed.temp)}°
          </span>
        )}
        {details && defMachine && defMachine.filaments.length > 0 && (
          <span className="flex gap-0.5">
            {defMachine.filaments.map((f) => (
              <i key={f.slot} className={cn("size-1.5 rounded-full", !f.loaded && "opacity-20")} style={{ background: f.loaded ? f.colorHex : "var(--faint)" }} />
            ))}
          </span>
        )}
      </Item>
      <DetailsToggle
        open={details}
        onToggle={() => setDetails((d) => !d)}
        className="h-full font-sans"
        title="Render time, designer cost, temperatures, filament"
      />
      <button className="flex h-5 items-center rounded-md px-2 hover:bg-muted hover:text-foreground" onClick={() => setSettingsOpen(true)} title={`Settings (${modKey(",")})`} aria-label="Settings">
        <SettingsIcon className="size-3" />
      </button>
    </div>
  )
}

function Item({ children, title, onClick }: { children: React.ReactNode; title?: string; onClick?: () => void }) {
  if (onClick)
    return (
      <button className="flex h-5 items-center gap-1.5 rounded-md px-2 whitespace-nowrap hover:bg-muted/60" title={title} onClick={onClick}>
        {children}
      </button>
    )
  return (
    <div className="flex h-5 items-center gap-1.5 rounded-md px-2 whitespace-nowrap hover:bg-muted/60" title={title}>
      {children}
    </div>
  )
}
