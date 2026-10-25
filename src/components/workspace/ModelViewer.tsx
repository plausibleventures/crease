import { useEffect, useMemo, useRef, useState } from "react"
import * as THREE from "three"
import { Canvas } from "@react-three/fiber"
import { GizmoHelper, GizmoViewport, OrbitControls } from "@react-three/drei"
import {
  BuildPlate,
  CameraRig,
  CanvasGuard,
  MARGIN,
  StageShift,
  FilamentRim,
  useGizmoMargin,
  PLATE,
  displayColor,
  PartMaterial,
  parseModel,
  useFilaments,
  type Fit,
  type LoadedModel,
  type View,
} from "@/components/viewer/shared"
import { EyeOffIcon, Loader2Icon, TriangleAlertIcon } from "@/components/icons"
import { EmptyState } from "@/components/panel"
import { AssembledViewer, hasPlacements } from "@/components/viewer/assembly"
import { PlateViewer } from "@/components/viewer/plate"
import { useHidden, usePlates, type ModelMode } from "@/stores/plates"
import { CaptureRegistrar, PinMarkers, PinPopover, usePinPicker, type DraftPin } from "@/components/viewer/pins"
import { ViewToolbar } from "@/components/viewer/view-toolbar"
import { CheckMarkers } from "@/components/viewer/check-markers"
import { partKey, useStudio } from "@/stores/studio"
import { fmtMs } from "@/lib/format"
import { useUnits } from "@/lib/units"
import { fmtDims } from "@shared/length"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { api, errMsg } from "@/lib/api"
import { toast } from "sonner"

function useModel(url: string | undefined, kind: "3mf" | "stl") {
  const [model, setModel] = useState<LoadedModel | null>(null)
  // which URL the current model / error belong to; "loading" is derived from it
  const [done, setDone] = useState<{ url: string; error: string | null } | null>(null)
  useEffect(() => {
    if (!url) return
    const ctrl = new AbortController()
    fetch(url, { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
        const pieces = parseModel(await res.arrayBuffer(), kind)
        if (!pieces.length) throw new Error("model contains no meshes")
        const box = new THREE.Box3()
        for (const p of pieces) {
          p.geometry.computeBoundingBox()
          box.union(p.geometry.boundingBox!)
        }
        // arrange like a slicer: centre on the plate in XY, drop onto the bed
        const off = new THREE.Vector3(-(box.min.x + box.max.x) / 2, -(box.min.y + box.max.y) / 2, -box.min.z)
        for (const p of pieces) {
          p.geometry.translate(off.x, off.y, off.z)
          p.geometry.computeVertexNormals()
        }
        box.translate(off)
        const sphere = box.getBoundingSphere(new THREE.Sphere())
        setModel((old) => {
          old?.pieces.forEach((p) => p.geometry.dispose())
          return { pieces, box, sphere, offset: off }
        })
        setDone({ url, error: null })
      })
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setDone({ url, error: (e as Error).message })
      })
    return () => ctrl.abort()
  }, [url, kind])
  const loading = !!url && done?.url !== url
  const error = done && done.url === url ? done.error : null
  // URL the shown model was loaded from (may lag behind `url` while the next one loads)
  const loadedFrom = done && !done.error ? done.url : null
  return { model: url ? model : null, loading, error, loadedFrom }
}


/** A build pack's Blender scripts run only after the user says so (they run sandboxed either way). */
function AllowSculptButton({ projectId, partId }: { projectId: string; partId: string }) {
  const render = useStudio((s) => s.render)
  const [busy, setBusy] = useState(false)
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={busy}
      className="font-sans"
      onClick={async () => {
        setBusy(true)
        try {
          await api.allowSculptScripts(projectId)
          await render(projectId, partId)
        } catch (e) {
          toast.error("Couldn't allow the scripts", { description: errMsg(e) })
        } finally {
          setBusy(false)
        }
      }}
    >
      {busy && <Loader2Icon className="animate-spin" />}Allow sculpt scripts
    </Button>
  )
}

export function ModelViewer({ projectId, partId }: { projectId: string; partId: string | null }) {
  const k = partId ? partKey(projectId, partId) : ""
  const result = useStudio((s) => s.renders[k])
  const rendering = useStudio((s) => !!s.rendering[k])
  const part = useStudio((s) => s.project?.parts.find((p) => p.id === partId))
  const kind: "3mf" | "stl" = result?.modelUrl ? "3mf" : "stl"
  const { model, loading, error, loadedFrom } = useModel((result?.modelUrl ?? result?.stlUrl) || undefined, kind)
  const filaments = useFilaments()
  const yaw = ({ "-y": 0, "+x": 90, "+y": 180, "-x": 270 }[result?.front ?? "-y"] * Math.PI) / 180
  const [view, setView] = useState<View>("iso")
  const [fit, setFit] = useState<Fit>("part")
  const [nonce, setNonce] = useState(0)
  const asmInfo = useStudio((s) => s.assembly[projectId])
  const pinMode = useStudio((s) => s.pinMode)
  const allPins = useStudio((s) => s.pins[projectId])
  const partPins = useMemo(() => (allPins ?? []).filter((p) => p.view === "part" && p.partId === partId), [allPins, partId])
  // R23: spots the checks point at (thin walls…), unless the check is of an older version of the part
  const checkReport = useStudio((s) => s.checks[k])
  const checkStale = useStudio((s) => (partId ? s.validity[projectId]?.parts[partId]?.check.state === "stale" : false))
  const checkMarkers = useMemo(
    () => (checkReport && !checkStale ? checkReport.items.flatMap((i) => i.markers ?? []) : []),
    [checkReport, checkStale],
  )
  const [draft, setDraft] = useState<DraftPin | null>(null)
  const pick = usePinPicker(setDraft)
  const canAssemble = hasPlacements(asmInfo?.assembly)
  const storedMode = usePlates((s) => s.mode[projectId] ?? "part")
  const mode: ModelMode = storedMode === "assembled" && !canAssemble ? "part" : storedMode
  const setMode = usePlates((s) => s.setMode)
  const chooseMode = (m: ModelMode) => setMode(projectId, m)
  const hiddenPart = useHidden(projectId).parts.includes(partId ?? "")
  const togglePart = usePlates((s) => s.togglePart)

  // Re-fit when switching parts or when the first mesh for a part arrives.
  const fittedFor = useRef<string | null>(null)
  useEffect(() => {
    // only once the mesh of *this* part is in (not the previous part's while the new one loads)
    const mine = !!partId && !!loadedFrom && loadedFrom.includes(`/build/${partId}.`)
    if (model && mine && fittedFor.current !== k) {
      fittedFor.current = k
      setView("iso")
      setFit("part")
      setNonce((n) => n + 1)
    }
  }, [model, k, loadedFrom, partId])

  const snap = (v: View, f: Fit = fit) => {
    setView(v)
    setFit(f)
    setNonce((n) => n + 1)
  }

  const colors = useMemo(
    () => model?.pieces.map((p) => displayColor(p.color, part?.colors?.[0], filaments, partId ?? undefined)) ?? [],
    [model, part, filaments, partId],
  )

  const units = useUnits((s) => s.units)
  const gizmoMargin = useGizmoMargin()
  const size = result?.stats?.sizeMm
  const over = !!size && (size[0] > PLATE - 2 * MARGIN || size[1] > PLATE - 2 * MARGIN)

  const modeToggle = (
    <>
      {(canAssemble ? (["part", "assembled", "plate"] as const) : (["part", "plate"] as const)).map((m) => (
        <button
          key={m}
          onClick={() => chooseMode(m)}
          aria-pressed={mode === m}
          title={
            m === "part"
              ? "The selected part on its own"
              : m === "assembled"
                ? "All parts put together, with moving parts"
                : "Every part on the print bed, where the slicer puts it, with labels"
          }
          className={cn(
            "h-6 rounded-sm px-1.5 text-caption capitalize text-muted-foreground hover:bg-muted hover:text-foreground",
            mode === m && "bg-primary/15 text-foreground",
          )}
        >
          {m}
        </button>
      ))}
    </>
  )

  if (canAssemble && mode === "assembled" && asmInfo)
    return <AssembledViewer projectId={projectId} info={asmInfo} toolbar={modeToggle} />
  if (mode === "plate") return <PlateViewer projectId={projectId} partId={partId} toolbar={modeToggle} />

  if (!partId) return <EmptyState art="render" title="No part selected" detail="Ask the designer, or pick a part." />

  return (
    <div data-viewer className={cn("absolute inset-0 ps-stage", pinMode && "cursor-crosshair")}>
      <Canvas
        dpr={[1, 2]}
        camera={{ position: [250, -300, 220], fov: 35, near: 1, far: 5000, up: [0, 0, 1] }}
        gl={{ antialias: true, preserveDrawingBuffer: false }}
      >
        <CanvasGuard />
        <StageShift />
        <CaptureRegistrar />
        <ambientLight intensity={0.35} />
        <hemisphereLight args={["#ffffff", "#3b4758", 1.1]} />
        <directionalLight position={[200, -300, 400]} intensity={1.9} />
        <directionalLight position={[-300, 200, 150]} intensity={0.7} />
        <BuildPlate over={over} />
        <FilamentRim colors={colors} />
        {model?.pieces.map((p, i) => (
          <mesh
            key={i}
            geometry={p.geometry}
            onClick={(e) =>
              model.offset &&
              pick(e, {
                partId,
                view: "part",
                localToPart: model.offset,
                partBox: model.box.clone().translate(model.offset.clone().negate()),
              })
            }
          >
            <PartMaterial color={colors[i]} />
          </mesh>
        ))}
        {model?.offset && partPins.length > 0 && <PinMarkers pins={partPins} localOffset={model.offset} />}
        {model?.offset && checkMarkers.length > 0 && <CheckMarkers markers={checkMarkers} localOffset={model.offset} />}
        {/* never orbit under the plate (keeps the default and user views "from above") */}
        <OrbitControls makeDefault enableDamping dampingFactor={0.12} maxPolarAngle={Math.PI * 0.53} />
        <CameraRig view={view} fit={fit} nonce={nonce} bounds={model} yaw={yaw} />
        <GizmoHelper alignment="bottom-right" margin={gizmoMargin}>
          <GizmoViewport axisColors={["#ef4444", "#22c55e", "#3b82f6"]} labelColor="#fff" />
        </GizmoHelper>
      </Canvas>

      {/* view controls */}
      <div className="absolute top-2 left-2 max-w-[calc(100%-7rem)]">
        <ViewToolbar show={modeToggle} view={view} fit={fit} onView={(v) => snap(v)} onFit={(f) => snap(view, f)} />
      </div>
      {hiddenPart && (
        <button
          className="absolute top-10 left-2 flex items-center gap-1.5 border border-line bg-surface-1/90 px-2 py-1 text-caption text-muted-foreground backdrop-blur hover:text-foreground"
          onClick={() => togglePart(projectId, partId!)}
          title="This part is hidden in the Assembled and Plate views"
        >
          <EyeOffIcon className="size-3" /> Hidden in Assembled and Plate · Show
        </button>
      )}

      {/* stats */}
      {result?.stats && (
        // the size only; mesh numbers (volume, triangles, bodies, closed shape, render time) are on hover (COPY-02)
        <div
          className="ps-glass-ctl absolute top-2 right-2 flex flex-col items-end gap-0.5 border bg-surface-1/90 px-2 py-1 text-micro text-muted-foreground backdrop-blur"
          title={`${units === "in" ? `${(result.stats.volumeMm3 / 16387.064).toFixed(2)} in³` : `${(result.stats.volumeMm3 / 1000).toFixed(1)} cm³`} · ${result.stats.triangles.toLocaleString()} triangles · ${result.stats.bodies} bod${result.stats.bodies === 1 ? "y" : "ies"} · ${result.stats.manifold ? "closed shape" : "not a closed shape"} · ${fmtMs(result.durationMs)}${result.cached ? " (cached)" : ""}`}
        >
          <div className={cn("text-foreground", over && "text-err")}>
            {fmtDims(result.stats.sizeMm, units)}
          </div>
          {!result.stats.manifold && <div className="font-sans text-err">Not a closed shape</div>}
        </div>
      )}

      {/* render-complete reveal: an edge sweeps across when a new mesh lands */}
      {loadedFrom && <div key={loadedFrom} className="ps-reveal" aria-hidden />}
      {draft && <PinPopover draft={draft} projectId={projectId} onClose={() => setDraft(null)} />}
      {(rendering || loading) && (
        <div className="absolute bottom-2 left-2 flex items-center gap-1.5 border bg-surface-1/90 px-2 py-1 text-caption text-muted-foreground backdrop-blur">
          <Loader2Icon className="size-3 animate-spin" /> {rendering ? "Rendering…" : "Loading mesh…"}
        </div>
      )}

      {(result?.error || error) && (
        <div className="absolute inset-x-2 bottom-2 flex max-h-32 items-start gap-1.5 overflow-auto border border-err/40 bg-err/15 px-2 py-1.5 font-mono text-caption whitespace-pre-wrap text-err backdrop-blur">
          <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" />
          <div className="flex flex-col items-start gap-1.5">
            {result?.error ? `Render error: ${result.error}` : `Couldn't load mesh: ${error}`}
            {result?.errorCode === "BLOCKED" && <AllowSculptButton projectId={projectId} partId={partId} />}
          </div>
        </div>
      )}

      {!result && !rendering && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <EmptyState art="render" title="No render yet" detail="Press Render." className="h-auto" />
        </div>
      )}
    </div>
  )
}
