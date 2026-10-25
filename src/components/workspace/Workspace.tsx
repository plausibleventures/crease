import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import * as THREE from "three"
import { displayColor, useFilaments } from "@/components/viewer/shared"
import {
  ChevronDownIcon,
  CodeIcon,
  CuboidIcon,
  ImagesIcon,
  LayoutGridIcon,
  ListOrderedIcon,
  Loader2Icon,
  PrinterIcon,
  ServerCrashIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  CompareIcon,
} from "@/components/icons"
import { EmptyState, TabStrip, type TabDef } from "@/components/panel"
import { GlassTabs } from "@/components/GlassTabs"
import { setStageInsets } from "@/lib/stage-insets"
import { Button } from "@/components/ui/button"
import { Sidebar } from "./Sidebar"
import { Toolbar } from "./Toolbar"
import { TargetMachineChip } from "@/components/machines/MachinePicker"
import { ModelViewer } from "./ModelViewer"
import { RendersView } from "./RendersView"
import { LayersView } from "@/components/layers/LayersView"
import { GlyphLayers } from "@/components/icons"
import { AssemblyView } from "./AssemblyView"
import { CodePanel } from "./CodePanel"
import { ParametersPanel } from "./ParametersPanel"
import { ChecksPanel } from "./ChecksPanel"
import { PrinterPanel } from "./PrinterPanel"
import { AgentPanel } from "@/components/agent/AgentPanel"
import { ProjectMenu } from "./ProjectMenu"
import { useImportFile } from "./ImportFile"
import { ProjectOverview } from "./ProjectOverview"
import { CompareView } from "./CompareView"
import { AppNav } from "@/components/AppNav"
import { useRemembered } from "@/lib/use-remembered"
import { partKey, useStudio, type CenterTab } from "@/stores/studio"
import { cn } from "@/lib/utils"
import { chromeLayout, DOCK, readWidths, STATUS, stageInsetsFor, writeWidths, type PanelWidths } from "@/lib/chrome-layout"

type BottomTab = "code" | "params" | "checks" | "printer"
const BOTTOM_TABS: BottomTab[] = ["code", "params", "checks", "printer"]

/** The tools panel's last tab (per viewer; storage may be unavailable). */
function readBottomTab(): BottomTab {
  try {
    const v = localStorage.getItem("ps-tools-tab") as BottomTab | null
    return v && BOTTOM_TABS.includes(v) ? v : "params"
  } catch {
    return "params"
  }
}
function writeBottomTab(t: BottomTab) {
  try {
    localStorage.setItem("ps-tools-tab", t)
  } catch {
    /* not remembered */
  }
}


export function Workspace({ projectId }: { projectId: string }) {
  const project = useStudio((s) => s.project)
  const projectError = useStudio((s) => s.projectError)
  const openProject = useStudio((s) => s.openProject)
  const navigate = useStudio((s) => s.navigate)
  const selectedPartId = useStudio((s) => s.selectedPartId)
  const loadLatest = useStudio((s) => s.loadLatest)
  const checkReport = useStudio((s) => (selectedPartId ? s.checks[partKey(projectId, selectedPartId)] : undefined))
  const printerState = useStudio((s) => s.printer?.state)

  const center = useStudio((s) => s.centerTab)
  const setCenter = useStudio((s) => s.setCenterTab)
  const hasAssembly = useStudio((s) => !!s.assembly[projectId]?.assembly)
  const layerIssues = useStudio((s) => {
    const g = s.lastGcode[projectId]
    return g ? (s.previews[`${projectId}|${g}`]?.issues.filter((i) => i.severity === "warn").length ?? 0) : 0
  })
  // U2: Layers once there is a slice to look at (before that it can only say "slice first")
  const hasSlice = useStudio((s) => {
    const j = s.jobs[projectId]
    return !!s.lastGcode[projectId] || Object.keys(j?.parts ?? {}).length > 0 || (j?.plates?.plates.length ?? 0) > 0
  })
  const partCount = project?.id === projectId ? project.parts.length : 0
  // The tools panel (code, parameters, checks, printer): hidden until asked for (the header's Code, the strip under
  // the model, the toolbar's Check), then remembered open or closed. Hidden rather than unmounted, so unsaved code
  // edits survive.
  const [bottom, setBottomTab] = useState<BottomTab>(readBottomTab)
  const [toolsOpen, setToolsOpen] = useRemembered("tools", false)
  const showTools = (t?: BottomTab) => {
    if (t) {
      setBottomTab(t)
      writeBottomTab(t)
    }
    // the tools sit under the 3D view: leave the Overview / Compare overlays for it
    const c = useStudio.getState().centerTab
    if (c === "overview" || c === "compare") setCenter("model")
    setToolsOpen(true)
  }
  const hideTools = () => setToolsOpen(false)
  const setBottom = (t: BottomTab) => showTools(t)
  // command palette "Show code"
  useEffect(() => {
    const onShowCode = () => showTools("code")
    document.addEventListener("printstudio:show-code", onShowCode)
    return () => document.removeEventListener("printstudio:show-code", onShowCode)
  })
  const stageOnly = center !== "overview" && center !== "compare"
  const codeOpen = toolsOpen && bottom === "code" && stageOnly
  const overview = useStudio((s) => s.overview[projectId])
  // R22: Compare shows once there are two ideas or two saved versions
  const canCompare = useStudio((s) => (s.ideas[projectId]?.ideas.length ?? 0) > 1 || (s.checkpoints[projectId]?.list.length ?? 0) > 1)

  // the floating chrome's sizes follow the window, and the viewers learn how much of the stage it covers
  const { layout, resize } = useChromeLayout()
  const toolsShown = stageOnly && toolsOpen
  useEffect(() => {
    setStageInsets(stageInsetsFor(layout, toolsShown))
    return () => setStageInsets(null)
  }, [layout, toolsShown])

  // the stage takes a faint light from the project's most colourful filament: colour comes from the user's work,
  // not from a brand tint
  const filaments = useFilaments()
  const filamentLight = useMemo(() => {
    let best: { hex: string; s: number } | null = null
    for (const p of project?.id === projectId ? project.parts : []) {
      const hex = displayColor(null, p.colors?.[0], filaments, p.id)
      const hsl = new THREE.Color(hex).getHSL({ h: 0, s: 0, l: 0 })
      const score = hsl.s * (1 - Math.abs(hsl.l - 0.5) * 2)
      if (score > 0.15 && (!best || score > best.s)) best = { hex, s: score }
    }
    return best?.hex ?? null
  }, [project, projectId, filaments])

  const imp = useImportFile(projectId)

  useEffect(() => {
    void openProject(projectId)
    // R12: a project opens on its overview (the chat stays on the right, one click away)
    setCenter("overview")
  }, [projectId, openProject, setCenter])

  // Show the last cached render + check the first time a part is shown (never re-runs).
  const autoDone = useRef(new Set<string>())
  useEffect(() => {
    if (!project || project.id !== projectId || !selectedPartId) return
    const k = partKey(projectId, selectedPartId)
    if (autoDone.current.has(k)) return
    autoDone.current.add(k)
    void loadLatest(projectId, selectedPartId)
  }, [project, projectId, selectedPartId, loadLatest])

  if (!project || project.id !== projectId) {
    return (
      <div className="ps-bleed relative flex h-full flex-col">
        <div data-glass-chrome="top" className="flex items-center gap-2">
          <AppNav compact />
          <span className="text-faint" aria-hidden>
            /
          </span>
          <span className="text-muted-foreground">{projectId}</span>
        </div>
        {projectError ? (
          <EmptyState
            icon={<ServerCrashIcon />}
            title="Couldn't open project"
            detail={projectError}
            action={
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => void openProject(projectId)}>
                  Retry
                </Button>
                <Button size="sm" variant="ghost" onClick={() => navigate({ name: "library" })}>
                  Back to library
                </Button>
              </div>
            }
          />
        ) : (
          <EmptyState icon={<Loader2Icon className="animate-spin" />} title="Opening project…" />
        )}
      </div>
    )
  }

  const sevDot =
    checkReport?.summary === "fail" ? "bg-err" : checkReport?.summary === "warn" ? "bg-warn" : checkReport ? "bg-ok" : null

  const headerInner = (
    <>
      <AppNav compact />
      <span className="text-faint" aria-hidden>
        /
      </span>
      <h1 className="min-w-0 truncate text-sm font-semibold">{project.name}</h1>
      <ProjectMenu projectId={projectId} />
      <div className="flex-1" />
      <Button
        variant="ghost"
        size="sm"
        className={cn("mr-1", codeOpen && "bg-muted text-foreground")}
        aria-pressed={codeOpen}
        onClick={() => (codeOpen ? hideTools() : showTools("code"))}
        title={codeOpen ? "Hide the code" : "Show the design's code"}
        aria-label="Code"
      >
        {/* icon only below xl, like the section nav, so the project title keeps its room */}
        <CodeIcon /> <span className="hidden xl:inline">Code</span>
      </Button>
      <TargetMachineChip projectId={projectId} />
      <Toolbar projectId={projectId} partId={selectedPartId} onShowChecks={() => setBottom("checks")} onShowPrinter={() => setBottom("printer")} />
    </>
  )

  const centerTabs: TabDef<CenterTab>[] = [
    {
      id: "overview",
      label: "Overview",
      icon: <LayoutGridIcon />,
      badge: overview && overview.outOfDate.length > 0 && <span className="size-1.5 bg-warn rounded-full" title="Something is out of date" />,
    },
    { id: "model", label: "Model", icon: <CuboidIcon /> },
    // U2: Assembly when there is something to put together (a guide, or more than one part)
    ...(hasAssembly || partCount > 1 || center === "assembly"
      ? [
          {
            id: "assembly" as const,
            label: "Assembly",
            icon: <ListOrderedIcon />,
            badge: hasAssembly && <span className="size-1.5 bg-primary rounded-full" />,
          },
        ]
      : []),
    ...(canCompare || center === "compare" ? [{ id: "compare" as const, label: "Compare", icon: <CompareIcon /> }] : []),
  ]
  // U2: inspection views sit at the far end, quieter: one click for experts, not a newcomer's first stop
  const centerSecondary: TabDef<CenterTab>[] = [
    { id: "renders", label: "Renders", icon: <ImagesIcon /> },
    ...(hasSlice || center === "layers"
      ? [{ id: "layers" as const, label: "Layers", icon: <GlyphLayers />, badge: layerIssues > 0 && <span className="size-1.5 bg-warn rounded-full" /> }]
      : []),
  ]

  const overviewEl = (
    <ProjectOverview
      projectId={projectId}
      onOpenTool={(t) => {
        setCenter("model")
        setBottom(t)
      }}
    />
  )

  const stageView =
    center === "renders" ? (
      <RendersView projectId={projectId} partId={selectedPartId} />
    ) : center === "layers" ? (
      <LayersView projectId={projectId} />
    ) : center === "assembly" ? (
      <AssemblyView projectId={projectId} />
    ) : (
      <ModelViewer projectId={projectId} partId={selectedPartId} />
    )

  const toolsTabs = (right: ReactNode, className?: string) => (
    <TabStrip<BottomTab>
      value={bottom}
      onChange={setBottom}
      className={className}
      tabs={[
        { id: "code" as const, label: "Code", icon: <CodeIcon /> },
        { id: "params" as const, label: "Parameters", icon: <SlidersHorizontalIcon /> },
        {
          id: "checks",
          label: "Checks",
          icon: <ShieldCheckIcon />,
          badge: sevDot && <span className={cn("size-1.5 rounded-full", sevDot)} />,
        },
        {
          id: "printer",
          label: "Printer",
          icon: <PrinterIcon />,
          badge: (printerState === "printing" || printerState === "preparing") && <span className="size-1.5 animate-pulse bg-primary rounded-full" />,
        },
      ]}
      right={right}
    />
  )
  const toolsBody = (
    <div className="min-h-0 flex-1">
      {/* Code stays mounted to keep unsaved edits and editor state */}
      <div className={cn("h-full", bottom !== "code" && "hidden")}>
        <CodePanel projectId={projectId} />
      </div>
      {bottom === "params" && <ParametersPanel key={selectedPartId ?? ""} projectId={projectId} partId={selectedPartId} />}
      {bottom === "checks" && <ChecksPanel projectId={projectId} partId={selectedPartId} />}
      {bottom === "printer" && <PrinterPanel />}
    </div>
  )
  const hideButton = (
    <Button variant="ghost" size="icon-xs" onClick={hideTools} title="Hide" aria-label="Hide tools">
      <ChevronDownIcon />
    </Button>
  )
  // the strip of tools under the stage while the panel is closed; icons only when the gap is narrow
  const toolButton = (t: BottomTab, icon: ReactNode, label: string, badge?: ReactNode) => (
    <Button variant="ghost" size="xs" onClick={() => showTools(t)} title={label} aria-label={layout.compact ? label : undefined}>
      {icon}
      {!layout.compact && label}
      {badge}
    </Button>
  )
  const toolsStrip = (
    <>
      {toolButton("params", <SlidersHorizontalIcon />, "Parameters")}
      {toolButton("checks", <ShieldCheckIcon />, "Checks", sevDot && <span className={cn("size-1.5 rounded-full", sevDot)} />)}
      {toolButton("printer", <PrinterIcon />, "Printer")}
    </>
  )

  // The stage spans the window; the header, parts list, chat, view switcher and tools float over it. Glass only for
  // the header pill and the switcher; the panels people read in are solid.
  const ins = stageInsetsFor(layout, toolsShown)
  const gap = { left: layout.l, right: layout.r }
  return (
    <div className="ps-bleed relative h-full overflow-hidden" style={filamentLight ? ({ "--filament": filamentLight } as CSSProperties) : undefined} {...imp.dropHandlers}>
      {imp.element}
      <div
        className="absolute"
        style={{ left: ins.l, right: ins.r, top: ins.t, bottom: ins.b, "--bl": `${ins.l}px`, "--br": `${ins.r}px`, "--bt": `${ins.t}px`, "--bb": `${ins.b}px` } as CSSProperties}
        data-stage
      >
        {stageView}
      </div>
      {!stageOnly && (
        <div className="ps-glass-sheet absolute z-10 overflow-hidden" style={{ ...gap, top: layout.t, bottom: layout.b }}>
          {center === "overview" ? overviewEl : <CompareView projectId={projectId} />}
        </div>
      )}
      <header className="ps-glass ps-glass-bar absolute top-2 z-30 flex h-11 items-center gap-2" data-glass-chrome>
        {headerInner}
      </header>
      <aside className="ps-glass ps-glass-panel absolute left-2 z-20 overflow-hidden" style={{ top: layout.t, width: layout.sidebar, bottom: STATUS + 8 }} data-glass-chrome>
        <Sidebar />
        <PanelEdge side="left" width={layout.sidebar} onResize={(px) => resize("sidebar", px)} label="Resize the parts list" />
      </aside>
      <aside className="ps-glass ps-glass-panel absolute right-2 z-20 overflow-hidden" style={{ top: layout.t, width: layout.chat, bottom: STATUS + 8 }} data-glass-chrome>
        <AgentPanel projectId={projectId} />
        <PanelEdge side="right" width={layout.chat} onResize={(px) => resize("chat", px)} label="Resize the chat" />
      </aside>
      {/* hidden, not unmounted, while closed: unsaved code edits survive */}
      <section
        className={cn("ps-glass ps-glass-panel absolute z-20 flex flex-col overflow-hidden", !toolsShown && "hidden")}
        style={{ ...gap, bottom: STATUS + 8 + DOCK, height: layout.tools }}
        aria-label="Tools"
        data-glass-chrome
      >
        {toolsTabs(hideButton, "border-b-line bg-transparent")}
        {toolsBody}
      </section>
      <div className="absolute z-20 flex items-center justify-center gap-2" style={{ ...gap, bottom: STATUS + 8, height: DOCK - 8 }}>
        <GlassTabs<CenterTab> label="View" value={center} onChange={setCenter} tabs={centerTabs} secondary={centerSecondary} compact={layout.compact} />
        {stageOnly && !toolsOpen && <div className="ps-glass ps-glass-pill flex h-9 items-center gap-0.5 px-1">{toolsStrip}</div>}
      </div>
    </div>
  )
}


/** The floating chrome for this window, with the panel widths the user dragged to (remembered per viewer). */
function useChromeLayout() {
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  const [widths, setWidths] = useState<PanelWidths>(readWidths)
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener("resize", on)
    return () => window.removeEventListener("resize", on)
  }, [])
  const layout = useMemo(() => chromeLayout(size.w, size.h, widths), [size.w, size.h, widths])
  const resize = (which: keyof PanelWidths, px: number | undefined) =>
    setWidths((cur) => {
      const next = { ...cur, [which]: px }
      if (px === undefined) delete next[which]
      writeWidths(next)
      return next
    })
  return { layout, resize }
}

/**
 * A drag handle on a floating panel's inner edge: drag to resize it, double-click for its default width. Arrow keys
 * resize it too (focusable separator).
 */
function PanelEdge({ side, width, onResize, label }: { side: "left" | "right"; width: number; onResize: (px: number | undefined) => void; label: string }) {
  const start = useRef<{ x: number; w: number } | null>(null)
  const dir = side === "left" ? 1 : -1 // the parts list grows rightwards, the chat leftwards
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      className={cn(
        "group absolute top-4 bottom-4 z-30 w-2 cursor-col-resize touch-none outline-none",
        side === "left" ? "right-0" : "left-0",
      )}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { x: e.clientX, w: width }
      }}
      onPointerMove={(e) => {
        if (start.current) onResize(start.current.w + dir * (e.clientX - start.current.x))
      }}
      onPointerUp={() => (start.current = null)}
      onPointerCancel={() => (start.current = null)}
      onDoubleClick={() => onResize(undefined)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault()
          onResize(width + (e.key === "ArrowRight" ? 16 : -16) * dir)
        }
      }}
    >
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 rounded-full bg-transparent transition-colors group-hover:bg-line-strong group-focus-visible:bg-ring" />
    </div>
  )
}
