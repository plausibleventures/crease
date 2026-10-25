// Layers tab: the sliced toolpath with the slicer-quality issues beside it. Two views, one click apart (remembered):
// 3D (default): the whole plate in 3D, the layer slider cuts it (Toolpath3D.tsx);
// Layer: one layer at a time, drawn top-down on a 2D canvas (pan/zoom). Layers load lazily in windows of 40.
// Both colour by feature with the same legend.
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { GcodeQualityIssue, PlatePlacement, SlicePreviewSummary, ToolpathLayer } from "@shared/types"
import { EmptyState } from "@/components/panel"
import { Slider } from "@/components/ui/slider"
import { Button } from "@/components/ui/button"
import { CheckIcon, ChevronRightIcon, Loader2Icon, MoreHorizontalIcon, TriangleAlertIcon, InfoIcon, LightbulbIcon } from "@/components/icons"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { useStagePalette, type StagePalette } from "@/lib/stage"
import { useResolvedTheme } from "@/components/theme-provider"
import { useStudio } from "@/stores/studio"
import { colourOf, LEGEND_ORDER, plainFeature } from "@/components/layers/colours"
import { Toolpath3D, toolColour, useToolpath, type ColourBy, type FrameRequest } from "@/components/layers/Toolpath3D"
import { useRemembered } from "@/lib/use-remembered"
import { useLength } from "@/lib/units"
import { sliceBuild } from "@/components/workspace/build-actions"
import type { View as CameraView } from "@/components/viewer/shared"
import { PlateStepper, StatusChip, useInspectedPlate, usePlacement } from "@/components/viewer/plate"

const WINDOW = 40


type View = { scale: number; ox: number; oy: number } // screen = (x * scale + ox, -y * scale + oy)

function useLayers(projectId: string, gcode: string | null) {
  const cache = useRef(new Map<number, ToolpathLayer>())
  const pending = useRef(new Set<number>())
  const [version, setVersion] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // (the caller remounts per G-code file, so the cache never mixes files)
  const ensure = useCallback(
    (index: number, count: number) => {
      if (!gcode) return
      const start = Math.max(0, Math.floor(index / WINDOW) * WINDOW)
      if (pending.current.has(start) || cache.current.has(start) || (count && start >= count)) return
      pending.current.add(start)
      const to = count ? Math.min(count - 1, start + WINDOW - 1) : start + WINDOW - 1
      api
        .sliceLayers(projectId, gcode, start, to)
        .then((ls) => {
          for (const l of ls ?? []) cache.current.set(l.index, l)
          setError(null)
          setVersion((v) => v + 1)
        })
        .catch((e) => {
          pending.current.delete(start)
          setError((e as Error).message)
        })
    },
    [projectId, gcode],
  )
  return { get: (i: number) => cache.current.get(i), ensure, version, error }
}

export function LayersView({ projectId }: { projectId: string }) {
  const lastGcode = useStudio((s) => s.lastGcode[projectId] ?? null)
  // fall back to the newest per-part slice we know about
  const fallbackGcode = useStudio((s) => {
    const own = Object.entries(s.slices).filter(([k]) => k.startsWith(`${projectId}/`))
    return own.length ? own[own.length - 1][1].gcodePath : null
  })
  // R13: read the immutable job snapshot (.studio/jobs/<sha>/…), not build/: the plate the Model › Plate view
  // inspects, or the part sliced last. A new slice is a new snapshot path, so nothing stale lingers.
  const selectedPartId = useStudio((s) => s.selectedPartId)
  const partJobs = useStudio((s) => s.jobs[projectId]?.parts)
  const { plates, index, job: plateJob, setIndex, next } = useInspectedPlate(projectId, selectedPartId)
  const hasPlateSet = plates.some((p) => p.kind === "plate")
  const lastPartJob = lastGcode ? Object.values(partJobs ?? {}).find((j) => j.gcodePath === lastGcode) : undefined
  const [preferPlates, setPreferPlates] = useState(false)
  const job = hasPlateSet ? (lastPartJob && !preferPlates ? lastPartJob : plateJob) : (lastPartJob ?? plateJob)
  const gcode = job?.snapshotPath ?? lastGcode ?? fallbackGcode
  const { placement } = usePlacement(projectId, job?.id)
  const summary = useStudio((s) => (gcode ? s.previews[`${projectId}|${gcode}`] : undefined))
  const loadPreview = useStudio((s) => s.loadPreview)
  const [summaryState, setSummaryState] = useState<"loading" | "missing" | "ok">("loading")

  // Revalidate on open and when the window regains focus: the file may have been re-sliced under the same
  // name (plate slices from the agent don't announce themselves).
  useEffect(() => {
    if (!gcode) return
    let alive = true
    const load = (force: boolean) =>
      void loadPreview(projectId, gcode, force).then((p) => alive && setSummaryState(p ? "ok" : "missing"))
    load(true)
    const onFocus = () => load(true)
    window.addEventListener("focus", onFocus)
    const t = setInterval(() => !document.hidden && load(true), 15000)
    return () => {
      alive = false
      window.removeEventListener("focus", onFocus)
      clearInterval(t)
    }
  }, [projectId, gcode, loadPreview])
  const stamp = useStudio((s) => (gcode ? (s.previewStamp[`${projectId}|${gcode}`] ?? 0) : 0))

  if (!gcode)
    return (
      <EmptyState
        art="render"
        title="Not sliced yet"
        detail="Slice to see each layer."
      />
    )
  if (!summary)
    return summaryState === "missing" ? (
      <EmptyState art="render" title="No layer preview" detail="Slice again to see the layers." />
    ) : (
      <EmptyState icon={<Loader2Icon className="animate-spin" />} title="Loading layers…" />
    )
  // keyed by file + stamp: a re-slice under the same name starts with a fresh layer cache
  const source = hasPlateSet ? (
    job?.kind === "part" ? (
      <Button size="xs" variant="ghost" onClick={() => setPreferPlates(true)} title="Show the sliced plates instead of this part">
        {job.partIds[0]} · show plates
      </Button>
    ) : (
      <PlateStepper
        compact
        plates={plates}
        value={index}
        next={next}
        onChange={(i) => {
          setPreferPlates(true)
          setIndex(i)
        }}
      />
    )
  ) : null
  return (
    <LayersCanvas
      key={`${gcode}|${stamp}`}
      projectId={projectId}
      gcode={gcode}
      summary={summary}
      placement={placement}
      source={source}
      status={job ? <StatusChip status={job.status} practice={job.practice} /> : null}
    />
  )
}

function LayersCanvas({
  projectId,
  gcode,
  summary,
  placement,
  source,
  status,
}: {
  projectId: string
  gcode: string
  summary: SlicePreviewSummary
  placement: PlatePlacement | null
  source: React.ReactNode
  status: React.ReactNode
}) {
  const lenFmt = useLength()
  const [labels, setLabels] = useState(true)
  const count = summary.layerCount
  // 3D (the whole plate, the slider cuts it) by default; "Layer" is the 2D single-layer canvas. Remembered.
  const [is3d, setIs3d] = useRemembered("layers-3d", true)
  const [index, setIndex] = useState(() =>
    Math.max(0, is3d ? count - 1 : Math.min(count - 1, summary.topLayers.at(-1) ?? summary.firstLayer ?? 0)),
  )
  const [from, setFrom] = useState(0) // 3D: lowest layer shown (the slider's second handle)
  const [ghost, setGhost] = useState(true)
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(["Skirt"]))
  const [hiddenTools, setHiddenTools] = useState<Set<number>>(() => new Set())
  const [colourBy, setColourBy] = useState<ColourBy>("feature")
  const [travel, setTravel] = useState(false)
  const [frame, setFrame] = useState<FrameRequest>({ nonce: 0, view: "iso", layer: null })
  const reframe = (v: CameraView | null, layerN: number | null = null) => setFrame((f) => ({ nonce: f.nonce + 1, view: v, layer: layerN }))
  const { get, ensure, version, error } = useLayers(projectId, gcode)
  const layer = get(index)
  const prev = index > 0 ? get(index - 1) : undefined
  const toolpath = useToolpath(projectId, gcode, is3d)
  const tp = toolpath && "tp" in toolpath ? toolpath.tp : null
  const [buildMs, setBuildMs] = useState<number | null>(null)

  useEffect(() => {
    if (is3d) return
    ensure(index, count)
    if (index > 0) ensure(index - 1, count)
  }, [index, count, ensure, is3d])

  const issuesHere = summary.issues.filter((i) => i.layers?.includes(index))

  /* ---------- canvas ---------- */
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const pal = useStagePalette()
  const light = useResolvedTheme() === "light"
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [userView, setView] = useState<View | null>(null) // null = auto-fit
  useEffect(() => {
    const el = wrap.current
    if (!el || is3d) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [is3d])

  // auto-fit to the toolpath extent of the first layer we have (until the user pans / zooms)
  const fitLayer = get(summary.firstLayer) ?? layer
  const autoView = useMemo((): View | null => {
    const l = fitLayer
    if (!l || !size.w) return null
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const s of l.segments)
      for (let i = 0; i < s.coords.length; i += 2) {
        const x = s.coords[i], y = s.coords[i + 1]
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    if (!isFinite(minX)) return null
    const pad = 40 // room for the plate labels above and "front of printer" below
    const scale = Math.min((size.w - pad * 2) / Math.max(1, maxX - minX), (size.h - pad * 2) / Math.max(1, maxY - minY))
    return { scale, ox: size.w / 2 - ((minX + maxX) / 2) * scale, oy: size.h / 2 + ((minY + maxY) / 2) * scale }
  }, [fitLayer, size])
  const view = userView ?? autoView

  useEffect(() => {
    const c = canvas.current
    if (!c || !size.w || is3d) return
    const dpr = window.devicePixelRatio || 1
    c.width = Math.round(size.w * dpr)
    c.height = Math.round(size.h * dpr)
    const g = c.getContext("2d")!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.fillStyle = pal.bg
    g.fillRect(0, 0, size.w, size.h)
    if (!view) return
    const { scale, ox, oy } = view
    // 10 mm hairline grid
    const step = scale * 10 > 14 ? 10 : 50
    g.strokeStyle = pal.canvasGrid
    g.lineWidth = 1
    g.beginPath()
    const x0 = Math.floor(-ox / scale / step) * step
    for (let x = x0; x * scale + ox < size.w; x += step) {
      const sx = Math.round(x * scale + ox) + 0.5
      g.moveTo(sx, 0)
      g.lineTo(sx, size.h)
    }
    const y0 = Math.floor((oy - size.h) / scale / step) * step
    for (let y = y0; -y * scale + oy > 0; y += step) {
      const sy = Math.round(-y * scale + oy) + 0.5
      g.moveTo(0, sy)
      g.lineTo(size.w, sy)
    }
    g.stroke()
    g.lineCap = "round"
    const drawLayer = (l: ToolpathLayer, ghostMode: boolean) => {
      for (const s of l.segments) {
        if (hidden.has(s.feature)) continue
        g.strokeStyle = ghostMode ? pal.ghost : colourOf(s.feature, light)
        g.lineWidth = Math.max(ghostMode ? 1 : 1.25, Math.min(s.lineWidth * scale * 0.85, 14))
        g.beginPath()
        const k = s.coords
        for (let i = 0; i + 3 < k.length; i += 4) {
          g.moveTo(k[i] * scale + ox, -k[i + 1] * scale + oy)
          g.lineTo(k[i + 2] * scale + ox, -k[i + 3] * scale + oy)
        }
        g.stroke()
      }
    }
    if (ghost && prev) drawLayer(prev, true)
    if (layer) drawLayer(layer, false)
    if (placement) drawPlacement(g, placement, { scale, ox, oy }, labels, pal)
  }, [size, view, layer, prev, ghost, hidden, version, placement, labels, pal, light, is3d])

  // pan + zoom
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  const onWheel = (e: React.WheelEvent) => {
    if (!view) return
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const mx = e.clientX - r.left
    const my = e.clientY - r.top
    const k = Math.exp(-e.deltaY * 0.0015)
    const scale = Math.min(400, Math.max(0.5, view.scale * k))
    const f = scale / view.scale
    setView({ scale, ox: mx - (mx - view.ox) * f, oy: my - (my - view.oy) * f })
  }

  // keyboard: ← → (shift = 10), Home / End
  const step = useCallback((d: number) => setIndex((i) => Math.max(0, Math.min(count - 1, i + d))), [count])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && t.closest("input, textarea, select, [contenteditable='true'], .monaco-editor, [role='slider']")) return
      if (e.key === "ArrowRight" || e.key === "ArrowUp") step(e.shiftKey ? 10 : 1)
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") step(e.shiftKey ? -10 : -1)
      else if (e.key === "Home") setIndex(0)
      else if (e.key === "End") setIndex(count - 1)
      else return
      e.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [step, count])

  const features = useMemo(() => {
    const present = new Set<string>(is3d ? (tp?.header.groups.map((g) => g.feature) ?? []) : (layer?.segments.map((s) => s.feature) ?? []))
    return LEGEND_ORDER.filter((f) => present.has(f)).concat([...present].filter((f) => !LEGEND_ORDER.includes(f)))
  }, [layer, tp, is3d])
  const tools = useMemo(() => [...new Set(tp?.header.groups.map((g) => g.tool) ?? [])].sort((a, b) => a - b), [tp])
  const byFilament = is3d && colourBy === "filament" && tools.length > 1
  const shownFrom = Math.min(from, index)
  const layerInfo = is3d ? tp?.header.layers[index] : layer
  const toggle = <T,>(set: React.Dispatch<React.SetStateAction<Set<T>>>, v: T) =>
    set((h) => {
      const n = new Set(h)
      if (n.has(v)) n.delete(v)
      else n.add(v)
      return n
    })
  /** Go to a layer; in 3D also frame it (keeping the current viewing direction). */
  const jump = (n: number) => {
    setIndex(n)
    if (is3d) reframe(null, n)
  }

  const topLayer = summary.topLayers.length ? summary.topLayers[summary.topLayers.length - 1] : count - 1
  const loadError = toolpath && "error" in toolpath ? toolpath.error : null

  return (
    <div className="@container absolute inset-0 flex">
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* toolbar: which view, where to look, then the rest behind ⋯ */}
        <div className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto overflow-y-hidden px-2 whitespace-nowrap">
          <div role="group" aria-label="View" className="flex gap-px rounded-full border border-line p-px">
            {([true, false] as const).map((three) => (
              <button
                key={String(three)}
                aria-pressed={is3d === three}
                onClick={() => {
                  setIs3d(three)
                  if (three && !is3d) setFrame((f) => ({ nonce: f.nonce + 1, view: "iso", layer: null }))
                }}
                title={three ? "The whole plate in 3D. The slider cuts it at a layer." : "One layer at a time, from above"}
                className={cn(
                  "h-5 rounded-full px-2 text-caption text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-1 focus-visible:outline-ring",
                  is3d === three && "bg-primary/20 text-foreground",
                )}
              >
                {three ? "3D" : "Layer"}
              </button>
            ))}
          </div>
          <Button size="xs" variant="ghost" onClick={() => jump(summary.firstLayer ?? 0)}>
            First
          </Button>
          {is3d ? (
            <Button size="xs" variant="ghost" onClick={() => { setFrom(0); setIndex(count - 1) }} title="Show every layer">
              All
            </Button>
          ) : (
            <Button size="xs" variant="ghost" onClick={() => setIndex(topLayer)} disabled={!summary.topLayers.length}>
              Top
            </Button>
          )}
          <div className="ml-1">{source}</div>
          {status}
          <div className="flex-1" />
          {is3d && (
            <div role="group" aria-label="Camera" className="flex">
              {(["iso", "top", "front"] as const).map((v) => (
                <Button key={v} size="xs" variant="ghost" className="capitalize" onClick={() => reframe(v)} title={`${v[0].toUpperCase()}${v.slice(1)} view, fitted`}>
                  {v}
                </Button>
              ))}
              <Button size="xs" variant="ghost" onClick={() => reframe(null)} title="Fit the toolpath in view">
                Fit
              </Button>
            </div>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" title="View options" aria-label="View options" />}>
              <MoreHorizontalIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {is3d ? (
                <>
                  <DropdownMenuItem onClick={() => setTravel(!travel)}>
                    <CheckIcon className={cn(!travel && "invisible")} /> Travel moves
                  </DropdownMenuItem>
                  {tools.length > 1 && (
                    <DropdownMenuItem onClick={() => setColourBy(colourBy === "feature" ? "filament" : "feature")}>
                      <CheckIcon className={cn(colourBy !== "filament" && "invisible")} /> Colour by filament
                    </DropdownMenuItem>
                  )}
                  {shownFrom > 0 && <DropdownMenuItem onClick={() => setFrom(0)}>Show from layer 1</DropdownMenuItem>}
                </>
              ) : (
                <>
                  <DropdownMenuItem onClick={() => setGhost(!ghost)}>
                    <CheckIcon className={cn(!ghost && "invisible")} /> Layer below
                  </DropdownMenuItem>
                  {placement && placement.objects.length > 0 && (
                    <DropdownMenuItem onClick={() => setLabels(!labels)}>
                      <CheckIcon className={cn(!labels && "invisible")} /> Part labels
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => setView(null)}>Fit to view</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {/* canvas */}
        {is3d ? (
          <div
            className="relative min-h-0 flex-1 overflow-hidden ps-stage"
            data-toolpath-ms={toolpath && "tp" in toolpath ? JSON.stringify({ ...toolpath.timings, buildMs }) : undefined}
          >
            {tp && (
              <Toolpath3D
                tp={tp}
                cut={index}
                from={shownFrom}
                hiddenFeatures={byFilament ? NONE : hidden}
                hiddenTools={byFilament ? hiddenTools : NONE_N}
                colourBy={byFilament ? "filament" : "feature"}
                travel={travel}
                light={light}
                frame={frame}
                onBuilt={setBuildMs}
              />
            )}
            {!tp && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-caption text-muted-foreground" role="status">
                {loadError ? (
                  <>
                    <span>Couldn’t load the toolpath. {loadError}</span>
                    <Button size="xs" variant="outline" onClick={() => setIs3d(false)}>
                      Show one layer
                    </Button>
                  </>
                ) : (
                  <>
                    <Loader2Icon className="size-4 animate-spin" aria-hidden />
                    <span>Loading toolpath…</span>
                  </>
                )}
              </div>
            )}
            {tp?.header.simplified && (
              <div
                className="pointer-events-none absolute top-2 right-2 border border-line bg-surface-1/90 px-2 py-1 text-micro text-muted-foreground backdrop-blur"
                title={`${tp.header.segments.toLocaleString()} of ${tp.header.sourceSegments.toLocaleString()} lines drawn. Use Layer to see every line.`}
              >
                simplified · large file
              </div>
            )}
          </div>
        ) : (
          <div
            ref={wrap}
            className="relative min-h-0 flex-1 cursor-grab overflow-hidden bg-stage active:cursor-grabbing"
            onWheel={onWheel}
            onPointerDown={(e) => {
              if (!view) return
              ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
              drag.current = { x: e.clientX, y: e.clientY, ox: view.ox, oy: view.oy }
            }}
            onPointerMove={(e) => {
              const d = drag.current
              if (!d || !view) return
              setView({ ...view, ox: d.ox + e.clientX - d.x, oy: d.oy + e.clientY - d.y })
            }}
            onPointerUp={() => (drag.current = null)}
            onPointerCancel={() => (drag.current = null)}
          >
            <canvas ref={canvas} className="absolute inset-0 size-full" aria-label={`Layer ${index + 1} toolpath`} />
            {!layer && (
              <div className="absolute inset-0 flex items-center justify-center text-caption text-muted-foreground">
                {error ? `Couldn't load layers: ${error}` : <Loader2Icon className="size-4 animate-spin" />}
              </div>
            )}
          </div>
        )}
        {/* layer readout (over either view) */}
        <div className="pointer-events-none absolute top-10 left-2 border border-line bg-surface-1/90 px-2 py-1 text-caption text-muted-foreground backdrop-blur">
          {is3d && shownFrom > 0 && <>layers {shownFrom + 1}–</>}
          <span className="text-foreground">{is3d && shownFrom > 0 ? index + 1 : `layer ${index + 1}`}</span> / {count}
          {layerInfo && (
            <>
              {" "}· z <span className="text-foreground">{lenFmt.units === "in" ? lenFmt.num(layerInfo.z) : layerInfo.z.toFixed(2)}</span> {lenFmt.unit} · h{" "}
              {lenFmt.units === "in" ? lenFmt.num(layerInfo.height) : layerInfo.height.toFixed(2)} {lenFmt.unit}
            </>
          )}
          {issuesHere.length > 0 && <span className="ml-1 text-warn">· {issuesHere.length} to check</span>}
        </div>
        {/* legend with toggles: features, or filaments when 3D colours by filament */}
        <div className="pointer-events-none absolute bottom-11 left-2 flex max-w-[calc(100%-8rem)] flex-wrap gap-1">
          {byFilament && tp
            ? tools.map((t) => (
                <LegendChip
                  key={t}
                  label={`Filament ${t + 1}`}
                  colour={toolColour(tp, t)}
                  off={hiddenTools.has(t)}
                  onClick={() => toggle(setHiddenTools, t)}
                />
              ))
            : features.map((f) => (
                <LegendChip key={f} label={plainFeature(f)} slicerName={f} colour={colourOf(f, light)} off={hidden.has(f)} onClick={() => toggle(setHidden, f)} />
              ))}
        </div>
        {/* layer slider: in 3D a range (from … cut), in Layer the one layer shown */}
        <div className="flex h-9 shrink-0 items-center gap-3 px-3">
          <span className="w-10 font-mono text-caption text-muted-foreground">1</span>
          <Slider
            min={0}
            max={Math.max(0, count - 1)}
            step={1}
            value={is3d ? [shownFrom, index] : [index]}
            onValueChange={(v) => {
              const a = Array.isArray(v) ? v : [v as number]
              if (is3d && a.length === 2) {
                setFrom(a[0])
                setIndex(a[1])
              } else setIndex(a[0])
            }}
            thumbLabel={(i) => (is3d ? (i === 0 ? "Lowest layer shown" : "Highest layer shown") : "Layer")}
            thumbValueText={(v) => `layer ${v + 1} of ${count}`}
          />
          <span className="w-10 text-right font-mono text-caption text-muted-foreground">{count}</span>
        </div>
      </div>
      <QualityPanel summary={summary} index={index} onJump={jump} />
    </div>
  )
}

const NONE = new Set<string>()
const NONE_N = new Set<number>()

function LegendChip({ label, slicerName, colour, off, onClick }: { label: string; slicerName?: string; colour: string; off: boolean; onClick: () => void }) {
  return (
    <button
      aria-pressed={!off}
      title={`${off ? "Show" : "Hide"} ${label.toLowerCase()}${slicerName && slicerName !== label ? ` (slicer: ${slicerName.toLowerCase()})` : ""}`}
      onClick={onClick}
      className={cn(
        "pointer-events-auto flex h-6 items-center gap-1.5 border border-line bg-surface-1/90 px-1.5 text-micro backdrop-blur hover:border-line-strong focus-visible:outline-1 focus-visible:outline-ring",
        off ? "text-faint" : "text-muted-foreground",
      )}
    >
      <i aria-hidden className={cn("size-2.5 rounded-xs", off && "opacity-25")} style={{ background: colour }} />
      {label}
    </button>
  )
}

/* ---------- quality panel ---------- */

const USE_DISPLAY = /^Use Display piece:\s*/

/** A fix tip. "Use Display piece: …" is a button: it switches this project to Display piece and slices again. */
function FixTip({ fix }: { fix: string }) {
  const projectId = useStudio((s) => s.project?.id ?? null)
  const [busy, setBusy] = useState(false)
  if (!USE_DISPLAY.test(fix) || !projectId) return <span>{fix}</span>
  const apply = async () => {
    setBusy(true)
    try {
      const st = useStudio.getState()
      st.setIntent(projectId, "display")
      await sliceBuild(projectId, st.selectedPartId)
    } finally {
      setBusy(false)
    }
  }
  return (
    <span className="flex flex-col items-start gap-1">
      <span>{fix.replace(USE_DISPLAY, "").replace(/^./, (c) => c.toUpperCase())}</span>
      <Button size="xs" variant="outline" onClick={() => void apply()} disabled={busy}>
        {busy && <Loader2Icon className="animate-spin" />}
        Use Display piece
      </Button>
    </span>
  )
}

/** One-line name for an issue: the server's title, or the message up to its first clause. */
export function issueTitle(i: GcodeQualityIssue): string {
  if (i.title) return i.title
  const m = i.message.split(/(?<=[a-z)])[.:(]\s|\s\(/)[0]
  return m.length > 60 ? `${m.slice(0, 57)}…` : m
}

/** Fix tips that more than one issue shares: shown once above the list, not under each issue. */
function sharedFixes(issues: GcodeQualityIssue[]): Set<string> {
  const n = new Map<string, number>()
  for (const i of issues) if (i.fix) n.set(i.fix, (n.get(i.fix) ?? 0) + 1)
  return new Set([...n].filter(([, c]) => c > 1).map(([f]) => f))
}

const SEV_ORDER = { warn: 0, info: 1 } as Record<string, number>

function QualityPanel({ summary, index, onJump }: { summary: SlicePreviewSummary; index: number; onJump: (n: number) => void }) {
  const issues = useMemo(() => [...summary.issues].sort((a, b) => (SEV_ORDER[a.severity] ?? 2) - (SEV_ORDER[b.severity] ?? 2)), [summary])
  const warns = issues.filter((i) => i.severity === "warn")
  const shared = useMemo(() => sharedFixes(issues), [issues])
  const [open, setOpen] = useState<number | null>(null)
  return (
    <aside className="mb-2 flex w-44 shrink-0 flex-col @2xl:w-64 overflow-hidden rounded-xl border border-line bg-card">
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-line px-2 text-xs">
        {warns.length ? <TriangleAlertIcon className="size-3.5 text-warn" /> : <CheckIcon className="size-3.5 text-ok" />}
        <span className="font-medium">{warns.length ? `${warns.length} to check` : "Looks good"}</span>
        {/* the list also holds the minor (info) ones: count them, so the header matches the rows below */}
        {issues.length > warns.length && <span className="text-muted-foreground">· {issues.length - warns.length} minor</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {[...shared].map((f) => (
          <div key={f} className="flex items-start gap-1.5 border-b border-line px-2 py-1.5 text-caption text-ok">
            <LightbulbIcon className="mt-px size-3 shrink-0" />
            <FixTip fix={f} />
          </div>
        ))}
        {issues.length > 0 && (
          <ul aria-label="Things to check">
            {issues.map((i, n) => (
              <IssueRow
                key={n}
                issue={i}
                showFix={!!i.fix && !shared.has(i.fix)}
                active={!!i.layers?.includes(index)}
                open={open === n}
                onClick={() => {
                  setOpen(open === n ? null : n)
                  if (i.layers?.length) onJump(i.layers[0])
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}

function IssueRow({
  issue,
  showFix,
  active,
  open,
  onClick,
}: {
  issue: GcodeQualityIssue
  showFix: boolean
  active: boolean
  open: boolean
  onClick: () => void
}) {
  const warn = issue.severity === "warn"
  const first = issue.layers?.[0]
  return (
    <li className={cn("border-b border-line", active && "bg-surface-2")}>
      <button onClick={onClick} aria-expanded={open} className="flex h-7 w-full items-center gap-1.5 rounded-none px-2 text-left text-xs hover:bg-surface-3">
        {warn ? <TriangleAlertIcon className="size-3.5 shrink-0 text-warn" /> : <InfoIcon className="size-3.5 shrink-0 text-info" />}
        <span className="min-w-0 flex-1 truncate text-foreground">{issueTitle(issue)}</span>
        {first !== undefined && <span className="shrink-0 text-micro text-muted-foreground">L{first + 1}</span>}
        <ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="flex flex-col gap-1 px-2 pb-2 pl-7 text-caption text-muted-foreground">
          <span>{issue.message}</span>
          {showFix && (
            <span className="flex items-start gap-1.5 text-ok">
              <LightbulbIcon className="mt-px size-3 shrink-0" />
              <FixTip fix={issue.fix!} />
            </span>
          )}
          {issue.layers && issue.layers.length > 1 && (
            <span className="font-mono text-micro text-faint">
              layers {issue.layers.slice(0, 6).map((l) => l + 1).join(", ")}
              {issue.layers.length > 6 ? "…" : ""}
            </span>
          )}
        </div>
      )}
    </li>
  )
}

/* ---------- plate overlay (R13): bed outline, front edge, each object's footprint + letter ---------- */

function drawPlacement(g: CanvasRenderingContext2D, pl: PlatePlacement, v: View, labels: boolean, pal: StagePalette) {
  const { scale, ox, oy } = v
  const X = (x: number) => x * scale + ox
  const Y = (y: number) => -y * scale + oy
  const [bw, bd] = pl.bedMm
  // bed outline + the front edge (bed Y = 0 is the front of the printer: the bottom of this view)
  g.save()
  g.strokeStyle = pal.gridMajor
  g.lineWidth = 1
  g.setLineDash([])
  g.strokeRect(X(0), Y(bd), bw * scale, bd * scale)
  g.strokeStyle = pal.edge
  g.lineWidth = 3
  g.beginPath()
  g.moveTo(X(bw / 2 - 25), Y(0) + 6)
  g.lineTo(X(bw / 2 + 25), Y(0) + 6)
  g.stroke()
  g.font = '11px "Geist", ui-sans-serif, system-ui, sans-serif'
  g.fillStyle = pal.edge
  g.textAlign = "center"
  g.textBaseline = "top"
  g.fillText("front of printer", X(bw / 2), Y(0) + 11)
  if (labels) {
    for (const o of pl.objects) {
      if (o.polygon.length > 2) {
        g.strokeStyle = pal.footprint
        g.lineWidth = 1
        g.setLineDash([4, 3])
        g.beginPath()
        o.polygon.forEach((p, i) => (i ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1]))))
        g.closePath()
        g.stroke()
        g.setLineDash([])
      }
      // badge just behind (above, in this top-down view) the footprint, so it doesn't cover the toolpath
      const top = o.polygon.length ? Math.max(...o.polygon.map((p) => p[1])) : o.center[1]
      const cx = X(o.center[0])
      const cy = Y(top) - 6
      g.font = '600 11px "Geist", ui-sans-serif, system-ui, sans-serif'
      const lw = Math.max(16, g.measureText(o.label).width + 8)
      g.font = '11px "Geist", ui-sans-serif, system-ui, sans-serif'
      const name = o.partId
      const nw = g.measureText(name).width + 10
      const w = lw + nw
      const x0 = cx - w / 2
      g.fillStyle = pal.badgeBg
      g.fillRect(x0, cy - 16, w, 16)
      g.strokeStyle = pal.badgeLine
      g.strokeRect(x0 + 0.5, cy - 15.5, w - 1, 15)
      g.fillStyle = pal.letterBg
      g.fillRect(x0 + 1, cy - 15, lw - 2, 14)
      g.fillStyle = pal.letterText
      g.textAlign = "center"
      g.textBaseline = "middle"
      g.font = '600 11px "Geist", ui-sans-serif, system-ui, sans-serif'
      g.fillText(o.label, x0 + lw / 2, cy - 8)
      g.fillStyle = pal.badgeText
      g.font = '11px "Geist", ui-sans-serif, system-ui, sans-serif'
      g.textAlign = "left"
      g.fillText(name, x0 + lw + 4, cy - 8)
    }
  }
  g.restore()
}
