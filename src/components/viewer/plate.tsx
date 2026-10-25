// R13: Model › Plate — every part of the selected plate, where the slicer actually put it (from the job's G-code:
// EXCLUDE_OBJECT positions + the rotation fitted to each mesh), with a letter label per copy, eye toggles per copy,
// a stepper over every plate with its print status, and "Retry this plate". Before slicing it shows a planned
// arrangement, clearly marked as planned.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import * as THREE from "three"
import { Canvas, useFrame } from "@react-three/fiber"
import { Edges, GizmoHelper, GizmoViewport, Line, OrbitControls } from "@react-three/drei"
import { toast } from "sonner"
import type { PlacedObject, PlatePlacement, PrintJobStatus, PrintJobView } from "@shared/types"
import { BuildPlate, CameraRig, CanvasGuard, PLATE, StageShift, useGizmoMargin, displayColor, PartMaterial, useFilaments, type Fit, type ModelPiece, type View } from "./shared"
import { usePartPieces } from "./assembly"
import { CaptureRegistrar } from "./pins"
import { ViewToolbar } from "./view-toolbar"
import { ChevronLeftIcon, ChevronRightIcon, ClockIcon, EyeIcon, EyeOffIcon, Loader2Icon, RotateCcwIcon, TriangleAlertIcon, WeightIcon } from "@/components/icons"
import { api, errMsg } from "@/lib/api"
import { fmtDuration, fmtNum } from "@/lib/format"
import { cn } from "@/lib/utils"
import { usePlain } from "@/lib/use-plain"
import { useStudio } from "@/stores/studio"
import { objectKey, plateJobsOf, useHidden, usePlates } from "@/stores/plates"

/* ---------- plate lifecycle words ---------- */

export const STATUS: Record<PrintJobStatus, { label: string; tone: string; hint: string }> = {
  pending: { label: "not printed", tone: "text-muted-foreground border-line", hint: "Sliced and ready; not sent to the printer yet." },
  requested: { label: "awaiting OK", tone: "text-info border-info/50", hint: "Waiting for you to approve it in the print dialog." },
  printing: { label: "printing", tone: "text-primary border-primary/60", hint: "On the printer now." },
  done: { label: "printed", tone: "text-ok border-ok/50", hint: "Printed." },
  failed: { label: "failed", tone: "text-err border-err/50", hint: "The print failed or was cancelled. Retry this plate when ready." },
  rejected: { label: "rejected", tone: "text-warn border-warn/50", hint: "You said no (or the request expired). Retry this plate when ready." },
}

const DOT: Record<PrintJobStatus, string> = {
  pending: "bg-muted-foreground/60",
  requested: "bg-info",
  printing: "bg-primary",
  done: "bg-ok",
  failed: "bg-err",
  rejected: "bg-warn",
}

export function StatusChip({ status, practice, className }: { status: PrintJobStatus; practice?: boolean; className?: string }) {
  // a plate printed on the practice printer: "practice", not "printed" (nothing was printed)
  const m = practice && status === "done" ? { label: "practice", tone: "text-muted-foreground border-line", hint: "Printed on the practice printer. Nothing was printed." } : STATUS[status]
  return (
    <span title={`${status}: ${m.hint}`} className={cn("inline-flex h-4 items-center rounded-sm border px-1 text-micro leading-none", m.tone, className)}>
      {status === "printing" && <i className="mr-1 size-1.5 animate-pulse bg-primary rounded-full" />}
      {m.label}
    </span>
  )
}

/** Plate tabs (1 · 2 · 3) with each plate's print status. Shared by Model › Plate and Layers. */
export function PlateStepper({
  plates,
  value,
  onChange,
  next,
  compact = false,
}: {
  plates: PrintJobView[]
  value: number
  onChange: (i: number) => void
  next?: number | null
  compact?: boolean // a small dot per plate instead of the status word (crowded toolbars)
}) {
  if (plates.length <= 1) return null
  return (
    <div className="flex items-center gap-px rounded-md border bg-surface-1/90 p-px backdrop-blur" role="tablist" aria-label="Plates">
      <button
        className="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
        disabled={value <= 0}
        onClick={() => onChange(value - 1)}
        aria-label="Previous plate"
      >
        <ChevronLeftIcon className="size-3" />
      </button>
      {plates.map((p, i) => (
        <button
          key={p.id}
          role="tab"
          aria-selected={i === value}
          onClick={() => onChange(i)}
          title={`Plate ${i + 1}: ${STATUS[p.status].hint}${next === i ? " (next to print)" : ""}`}
          className={cn(
            "flex h-6 items-center gap-1.5 rounded-sm px-2 text-caption text-muted-foreground hover:bg-muted hover:text-foreground",
            i === value && "bg-primary/15 text-foreground",
          )}
        >
          {compact ? `P${i + 1}` : `Plate ${i + 1}`}
          {compact ? <i className={cn("size-1.5 rounded-full", DOT[p.status], p.status === "printing" && "animate-pulse")} /> : <StatusChip status={p.status} practice={p.practice} />}
        </button>
      ))}
      <button
        className="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
        disabled={value >= plates.length - 1}
        onClick={() => onChange(value + 1)}
        aria-label="Next plate"
      >
        <ChevronRightIcon className="size-3" />
      </button>
    </div>
  )
}

/** The inspected plate of a project: the user's pick, else the plate set's cursor (next to print). */
export function useInspectedPlate(projectId: string, partId: string | null) {
  const jobs = useStudio((s) => s.jobs[projectId])
  const plates = useMemo(() => plateJobsOf(jobs, partId), [jobs, partId])
  const picked = usePlates((s) => s.plate[projectId])
  const setPlate = usePlates((s) => s.setPlate)
  const index = Math.max(0, Math.min(plates.length - 1, picked ?? jobs?.plates?.next ?? 0))
  return { plates, index, job: plates[index] as PrintJobView | undefined, setIndex: (i: number) => setPlate(projectId, i), next: jobs?.plates?.next ?? null }
}

/** Placement of a job (cached per job id: a job's bytes never change). */
export function usePlacement(projectId: string, jobId: string | undefined) {
  const entry = usePlates((s) => (jobId ? s.placements[jobId] : undefined))
  const load = usePlates((s) => s.loadPlacement)
  useEffect(() => {
    if (jobId) void load(projectId, jobId)
  }, [projectId, jobId, load])
  if (!jobId) return { placement: null, error: null, loading: false }
  if (!entry) return { placement: null, error: null, loading: true }
  if ("error" in entry) return { placement: null, error: entry.error, loading: false }
  return { placement: entry as PlatePlacement, error: null, loading: false }
}

/* ---------- planned arrangement (before slicing) ---------- */

export function letterFor(i: number): string {
  let s = ""
  let n = i
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

function piecesBox(pieces: ModelPiece[]): THREE.Box3 {
  const box = new THREE.Box3()
  for (const p of pieces) {
    if (!p.geometry.boundingBox) p.geometry.computeBoundingBox()
    box.union(p.geometry.boundingBox!)
  }
  return box
}

/**
 * Shelf-pack every part × qty (in project order, so letters match what a slice of all parts would give) and centre
 * the block on the bed. Only an approximation: the slicer picks the real spots (and may rotate parts).
 */
function plannedLayout(parts: { id: string; qty: number }[], pieces: Record<string, ModelPiece[]>, bed: [number, number]): PlacedObject[] {
  const gap = 8
  const items: { partId: string; entry: number; instance: number; w: number; d: number; minX: number; minY: number }[] = []
  parts.forEach((p, entry) => {
    const pc = pieces[p.id]
    if (!pc?.length) return
    const b = piecesBox(pc)
    for (let i = 0; i < Math.max(1, p.qty); i++)
      items.push({ partId: p.id, entry, instance: i + 1, w: b.max.x - b.min.x, d: b.max.y - b.min.y, minX: b.min.x, minY: b.min.y })
  })
  const maxW = bed[0] - 20
  let x = 0, y = 0, row = 0, width = 0
  const pos: [number, number][] = []
  for (const it of items) {
    if (x > 0 && x + it.w > maxW) {
      y += row + gap
      x = 0
      row = 0
    }
    pos.push([x, y])
    x += it.w + gap
    row = Math.max(row, it.d)
    width = Math.max(width, x - gap)
  }
  const height = y + row
  // rows go from the front (y small) toward the back
  const ox = (bed[0] - width) / 2, oy = (bed[1] - height) / 2
  let key = 0
  return items.map((it, i) => {
    const x0 = ox + pos[i][0], y0 = oy + pos[i][1]
    const k = key++
    // letters follow entry order × qty, like the slicer's (entry 0 copy 1 = A)
    return {
      name: `${it.partId}#${it.instance}`,
      partId: it.partId,
      entry: it.entry,
      instance: it.instance,
      label: letterFor(k),
      center: [x0 + it.w / 2, y0 + it.d / 2],
      polygon: [[x0, y0], [x0 + it.w, y0], [x0 + it.w, y0 + it.d], [x0, y0 + it.d]],
      rotationDeg: 0,
      translate: [x0 - it.minX, y0 - it.minY],
    }
  })
}

const byLabel = (a: PlacedObject, b: PlacedObject) => a.label.length - b.label.length || a.label.localeCompare(b.label)

/* ---------- 3D pieces ---------- */

const toView = (p: [number, number], bed: [number, number], z = 0): [number, number, number] => [p[0] - bed[0] / 2, p[1] - bed[1] / 2, z]

function PlacedMesh({
  obj,
  pieces,
  bed,
  colors,
  hot,
  selected,
  onHover,
  onPick,
}: {
  obj: PlacedObject
  pieces: ModelPiece[]
  bed: [number, number]
  colors: string[]
  hot: boolean
  selected: boolean
  onHover: (on: boolean) => void
  onPick: () => void
}) {
  const minZ = useMemo(() => piecesBox(pieces).min.z, [pieces])
  const [tx, ty] = obj.translate!
  return (
    <group position={[tx - bed[0] / 2, ty - bed[1] / 2, -minZ]} rotation={[0, 0, ((obj.rotationDeg ?? 0) * Math.PI) / 180]}>
      {pieces.map((pc, i) => (
        <mesh
          key={i}
          geometry={pc.geometry}
          onPointerOver={(e) => {
            e.stopPropagation()
            onHover(true)
          }}
          onPointerOut={() => onHover(false)}
          onClick={(e) => {
            e.stopPropagation()
            onPick()
          }}
        >
          {/* true filament colours always: hover/selection are an outline, never a tint (a tint made black parts lavender) */}
          <PartMaterial color={colors[i]} />
          {(hot || selected) && <Edges threshold={25} color={hot ? "#3fe0b0" : "#8fa6ff"} lineWidth={selected ? 2.5 : 1.5} />}
        </mesh>
      ))}
    </group>
  )
}

/** Footprint outline on the bed (always), plus a flat fill when there's no mesh to show (not rendered / changed). */
function Footprint({ obj, bed, color, filled }: { obj: PlacedObject; bed: [number, number]; color: string; filled: boolean }) {
  const pts = useMemo(() => [...obj.polygon, obj.polygon[0]].map((p) => toView(p, bed, 0.12)), [obj, bed])
  const shape = useMemo(() => {
    if (!filled || obj.polygon.length < 3) return null
    const s = new THREE.Shape(obj.polygon.map((p) => new THREE.Vector2(p[0] - bed[0] / 2, p[1] - bed[1] / 2)))
    return new THREE.ShapeGeometry(s)
  }, [obj, bed, filled])
  useEffect(() => () => shape?.dispose(), [shape])
  if (obj.polygon.length < 2) return null
  return (
    <group>
      <Line points={pts} color={color} lineWidth={1.25} transparent opacity={0.9} />
      {shape && (
        <mesh geometry={shape} position={[0, 0, 0.1]}>
          <meshBasicMaterial color={color} transparent opacity={0.22} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      )}
    </group>
  )
}

/** Projects label anchors to the screen every frame and moves the DOM labels there (crisp text, always upright). */
function LabelTracker({ anchors, els }: { anchors: { key: string; p: THREE.Vector3 }[]; els: React.RefObject<Map<string, HTMLElement>> }) {
  const v = useMemo(() => new THREE.Vector3(), [])
  useFrame(({ camera, size }) => {
    for (const a of anchors) {
      const el = els.current?.get(a.key)
      if (!el) continue
      v.copy(a.p).project(camera)
      const behind = v.z > 1
      el.style.transform = `translate(${((v.x + 1) / 2) * size.width}px, ${((1 - v.y) / 2) * size.height}px) translate(-50%, -100%)`
      el.style.visibility = behind ? "hidden" : "visible"
    }
  })
  return null
}

/* ---------- the viewer ---------- */

export function PlateViewer({ projectId, partId, toolbar }: { projectId: string; partId: string | null; toolbar: ReactNode }) {
  const gizmoMargin = useGizmoMargin()
  const plain = usePlain()
  const project = useStudio((s) => (s.project?.id === projectId ? s.project : null))
  const selectPart = useStudio((s) => s.selectPart)
  const addPrintRequest = useStudio((s) => s.addPrintRequest)
  const { plates, index, job, setIndex, next } = useInspectedPlate(projectId, partId)
  const { placement, error: placementError, loading: placementLoading } = usePlacement(projectId, job?.id)
  const hidden = useHidden(projectId)
  const toggleObject = usePlates((s) => s.toggleObject)
  const setObjectsHidden = usePlates((s) => s.setObjectsHidden)
  const filaments = useFilaments()
  const sliced = !!job
  const bed: [number, number] = placement?.bedMm ?? [PLATE, PLATE]

  // Meshes: every part on this plate (sliced) or every project part (planned).
  const projectParts = useMemo(() => project?.parts.map((p) => ({ id: p.id, qty: p.qty })) ?? [], [project])
  const partIds = useMemo(
    () => (sliced ? [...new Set(placement?.objects.map((o) => o.partId) ?? [])] : projectParts.map((p) => p.id)),
    [sliced, placement, projectParts],
  )
  const { pieces, missing, loading: piecesLoading } = usePartPieces(projectId, partIds)

  const objects: PlacedObject[] = useMemo(() => {
    if (sliced) return placement?.objects ?? []
    return pieces ? plannedLayout(projectParts, pieces, bed) : []
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sliced, placement, pieces, projectParts, bed[0], bed[1]])
  const planned = !sliced

  const visible = (o: PlacedObject) => !hidden.parts.includes(o.partId) && !hidden.objects.includes(objectKey(o))
  const [hot, setHot] = useState<string | null>(null)
  const partColor = (id: string) => project?.parts.find((p) => p.id === id)?.colors?.[0]

  // Camera bounds: the visible objects (or the bed when nothing shows)
  const bounds = useMemo(() => {
    const box = new THREE.Box3()
    for (const o of objects) {
      if (!visible(o)) continue
      const pc = pieces?.[o.partId]
      const h = pc ? piecesBox(pc).max.z - piecesBox(pc).min.z : 2
      for (const p of o.polygon) box.expandByPoint(new THREE.Vector3(...toView(p, bed, 0)))
      box.expandByPoint(new THREE.Vector3(...toView(o.center, bed, h)))
    }
    if (box.isEmpty()) return null
    return { box, sphere: box.getBoundingSphere(new THREE.Sphere()) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objects, pieces, hidden, bed[0], bed[1]])

  const [view, setView] = useState<View>("iso")
  const [fit, setFit] = useState<Fit>("part")
  const [nonce, setNonce] = useState(0)
  const snap = (v: View, f: Fit = fit) => {
    setView(v)
    setFit(f)
    setNonce((n) => n + 1)
  }
  // frame when the plate (or what's on it) first arrives
  const framedFor = useRef<string | null>(null)
  const frameKey = `${job?.id ?? "planned"}|${objects.length}|${!!pieces}`
  useEffect(() => {
    if (bounds && framedFor.current !== frameKey) {
      framedFor.current = frameKey
      setNonce((n) => n + 1)
    }
  }, [bounds, frameKey])

  // label anchors: above each object's top
  const els = useRef(new Map<string, HTMLElement>())
  const anchors = useMemo(
    () =>
      objects.filter(visible).map((o) => {
        const pc = pieces?.[o.partId]
        const h = pc && o.rotationDeg != null ? piecesBox(pc).max.z - piecesBox(pc).min.z : 1
        return { key: objectKey(o), p: new THREE.Vector3(...toView(o.center, bed, h + 1.5)) }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [objects, pieces, hidden, bed[0], bed[1]],
  )

  const [retrying, setRetrying] = useState(false)
  const retry = async () => {
    if (!job) return
    setRetrying(true)
    try {
      addPrintRequest(await api.createPrintRequest(projectId, job.snapshotPath, job.machineId))
    } catch (e) {
      toast.error("Couldn't send this plate", { description: errMsg(e) })
    } finally {
      setRetrying(false)
    }
  }

  const keys = objects.map(objectKey)
  const allShown = keys.every((k) => !hidden.objects.includes(k))
  const entryParts = project?.parts ?? []
  const multiCopy = (o: PlacedObject) => objects.filter((x) => x.partId === o.partId).length > 1

  return (
    <div data-viewer className="absolute inset-0 ps-stage">
      <Canvas dpr={[1, 2]} camera={{ position: [250, -300, 220], fov: 35, near: 1, far: 5000, up: [0, 0, 1] }}>
        <CanvasGuard />
        <StageShift />
        <CaptureRegistrar />
        <ambientLight intensity={0.35} />
        <hemisphereLight args={["#ffffff", "#3b4758", 1.1]} />
        <directionalLight position={[200, -300, 400]} intensity={1.9} />
        <directionalLight position={[-300, 200, 150]} intensity={0.7} />
        <BuildPlate over={false} size={bed[0]} />
        {objects.map((o) => {
          if (!visible(o)) return null
          const k = objectKey(o)
          const pc = pieces?.[o.partId]
          const fitted = !!pc && o.rotationDeg != null && !!o.translate
          const outline = hot === k ? "#3fe0b0" : planned ? "#ffd23f" : o.partId === partId ? "#6f8dff" : "#8f97a8"
          return (
            <group key={k}>
              <Footprint obj={o} bed={bed} color={outline} filled={!fitted} />
              {fitted && (
                <PlacedMesh
                  obj={o}
                  pieces={pc}
                  bed={bed}
                  colors={pc.map((p) => displayColor(p.color, partColor(o.partId), filaments, o.partId))}
                  hot={hot === k}
                  selected={o.partId === partId}
                  onHover={(on) => setHot(on ? k : null)}
                  onPick={() => selectPart(o.partId)}
                />
              )}
            </group>
          )
        })}
        <LabelTracker anchors={anchors} els={els} />
        <OrbitControls makeDefault enableDamping dampingFactor={0.12} maxPolarAngle={Math.PI * 0.53} />
        <CameraRig view={view} fit={fit} nonce={nonce} bounds={bounds} yaw={0} />
        <GizmoHelper alignment="bottom-right" margin={gizmoMargin}>
          <GizmoViewport axisColors={["#ef4444", "#22c55e", "#3b82f6"]} labelColor="#fff" />
        </GizmoHelper>
      </Canvas>

      {/* labels (DOM, positioned by LabelTracker): letter + part name, upright as seen from the front */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {objects.filter(visible).map((o) => {
          const k = objectKey(o)
          return (
            <div
              key={k}
              ref={(el) => {
                if (el) els.current.set(k, el)
                else els.current.delete(k)
              }}
              className="absolute top-0 left-0 will-change-transform"
              style={{ visibility: "hidden" }}
            >
              <div
                className={cn(
                  "pointer-events-auto flex cursor-pointer items-center gap-1 border bg-surface-1/90 py-0.5 pr-1.5 pl-0.5 text-caption whitespace-nowrap backdrop-blur",
                  hot === k ? "border-ok" : planned ? "border-dashed border-warn/70" : "border-line-strong",
                )}
                onMouseEnter={() => setHot(k)}
                onMouseLeave={() => setHot(null)}
                onClick={() => selectPart(o.partId)}
              >
                <span className={cn("flex h-4 min-w-4 items-center justify-center rounded-sm px-0.5 text-caption font-semibold", planned ? "bg-warn text-background" : "bg-primary text-primary-foreground")}>
                  {o.label}
                </span>
                <span className="text-foreground">{o.partId}</span>
                {multiCopy(o) && o.entry != null && entryParts.length > 0 && <span className="text-muted-foreground">#{o.instance}</span>}
              </div>
            </div>
          )
        })}
      </div>

      {/* toolbar + plate stepper */}
      <div className="absolute top-2 left-2 flex max-w-[calc(100%-16.5rem)] flex-col items-start gap-1.5">
        <ViewToolbar
          show={toolbar}
          view={view}
          fit={fit}
          onView={(v) => snap(v)}
          onFit={(f) => snap(view, f)}
          fitTitles={{ part: "Zoom to the parts", plate: "Show the whole bed" }}
        />
        <PlateStepper plates={plates} value={index} onChange={setIndex} next={next} />
        {planned ? (
          <div className="max-w-xs border border-dashed border-warn/60 bg-surface-1/90 px-2 py-1 text-caption text-warn backdrop-blur">
            <span className="font-semibold">Planned</span> — not sliced yet. Slicing picks the real spots (and may turn parts).
          </div>
        ) : job && job.stale.length > 0 ? (
          <div className="flex max-w-sm items-start gap-1.5 border border-warn/50 bg-surface-1/90 px-2 py-1 text-caption text-warn backdrop-blur" title={job.stale.join("\n")}>
            <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" />
            <span>Out of date — this is the last slice; {plain(job.stale[0])}. Slice again to see the new layout.</span>
          </div>
        ) : null}
      </div>

      {/* what's on this plate */}
      <aside className="absolute top-2 right-2 flex max-h-[calc(100%-1rem)] w-60 flex-col overflow-hidden rounded-lg border bg-surface-1/90 backdrop-blur">
        <div className="flex h-7 shrink-0 items-center gap-2 border-b px-2">
          <span className="ps-label" style={{ "--h": planned ? "var(--warn)" : "var(--primary)" } as React.CSSProperties}>
            {planned ? "Planned plate" : plates.length > 1 ? `Plate ${index + 1} of ${plates.length}` : job?.kind === "part" ? "Sliced part" : "Sliced plate"}
          </span>
          <div className="flex-1" />
          {objects.length > 1 && (
            <button
              className="text-micro text-muted-foreground hover:text-foreground"
              onClick={() => setObjectsHidden(projectId, allShown ? [...hidden.objects, ...keys] : hidden.objects.filter((k) => !keys.includes(k)))}
              title={allShown ? "Hide every copy on this plate" : "Show every copy on this plate"}
            >
              {allShown ? "Hide all" : "Show all"}
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {(placementLoading || (piecesLoading && planned)) && (
            <div className="flex items-center gap-1.5 px-2 py-1 text-caption text-muted-foreground">
              <Loader2Icon className="size-3 animate-spin" /> Reading the plate…
            </div>
          )}
          {placementError && <div className="px-2 py-1 text-caption text-err">Couldn't read where the parts are: {placementError}</div>}
          {!placementLoading && !placementError && objects.length === 0 && (
            <div className="px-2 py-1 text-caption text-muted-foreground">
              {sliced ? "This slice doesn't record where its parts are. Slice again to see them here." : "Render the parts to plan the plate."}
            </div>
          )}
          {[...objects].sort(byLabel).map((o) => {
            const k = objectKey(o)
            const partOff = hidden.parts.includes(o.partId)
            const off = partOff || hidden.objects.includes(k)
            const ov = o.overrides ? Object.entries(o.overrides).map(([a, b]) => `${a}=${b}`).join(", ") : null
            return (
              <div
                key={k}
                className={cn("group flex items-start gap-1.5 px-2 py-0.5 text-xs", hot === k && "bg-muted/70", off && "opacity-50")}
                onMouseEnter={() => setHot(k)}
                onMouseLeave={() => setHot(null)}
              >
                <button
                  className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground disabled:cursor-not-allowed"
                  onClick={() => toggleObject(projectId, k)}
                  disabled={partOff}
                  aria-pressed={!off}
                  aria-label={`${off ? "Show" : "Hide"} ${o.label} (${o.partId})`}
                  title={partOff ? `${o.partId} is hidden in the Parts list` : off ? "Show this copy" : "Hide this copy"}
                >
                  {off ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
                </button>
                <span className={cn("mt-0.5 flex h-4 min-w-4 shrink-0 items-center justify-center rounded-sm px-0.5 text-caption font-semibold", planned ? "bg-warn text-background" : "bg-primary text-primary-foreground")}>
                  {o.label}
                </span>
                <button className="min-w-0 flex-1 text-left" onClick={() => selectPart(o.partId)} title={`Select ${o.partId}`}>
                  <span className={cn("block truncate", o.partId === partId ? "text-foreground" : "text-muted-foreground")}>
                    {o.partId}
                    {multiCopy(o) ? <span className="text-faint"> #{o.instance}</span> : null}
                  </span>
                  {ov && <span className="block truncate text-micro text-info" title={ov}>{ov}</span>}
                  {!planned && o.rotationDeg != null && Math.abs(o.rotationDeg) > 0.5 && (
                    <span className="block text-micro text-faint">turned {Math.round(o.rotationDeg)}° by the slicer</span>
                  )}
                  {!planned && o.rotationDeg == null && <span className="block text-micro text-faint">outline only (mesh changed or not rendered)</span>}
                </button>
              </div>
            )
          })}
          {missing.length > 0 && <div className="px-2 py-1 text-micro text-faint">Not rendered yet: {missing.join(", ")}</div>}
        </div>
        <div className="shrink-0 border-t px-2 py-1.5 text-micro text-muted-foreground">
          {job && (
            <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              <StatusChip status={job.status} practice={job.practice} />
              <span className="flex items-center gap-0.5">
                <ClockIcon className="size-3" /> {fmtDuration(job.estimatedTimeS)}
              </span>
              <span className="flex items-center gap-0.5">
                <WeightIcon className="size-3" /> {fmtNum(job.filamentG)} g
              </span>
              {plates.length > 1 && <span className="truncate">{job.machineName}</span>}
            </div>
          )}
          {job?.error && (job.status === "failed" || job.status === "rejected") && <div className="mb-1 text-err">{job.error}</div>}
          {job && (job.status === "failed" || job.status === "rejected") && (
            <button
              onClick={() => void retry()}
              disabled={retrying || job.stale.length > 0}
              title={job.stale.length ? `Out of date — slice again first: ${job.stale.join("; ")}` : "Ask to print this plate again (you approve it in the print dialog)"}
              className="mb-1 flex h-6 w-full items-center justify-center gap-1.5 border border-primary/60 bg-primary/15 text-caption text-foreground hover:bg-primary/25 disabled:opacity-50"
            >
              {retrying ? <Loader2Icon className="size-3 animate-spin" /> : <RotateCcwIcon className="size-3" />}
              Retry this plate
            </button>
          )}
          <div className="text-faint">Seen from the front of the printer: the front edge is nearest you (bar under the bed).</div>
        </div>
      </aside>
    </div>
  )
}
