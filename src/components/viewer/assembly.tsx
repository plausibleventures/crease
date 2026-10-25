// Assembled 3D view: every printed part placed (rotate-then-translate) from assembly.json, an explode
// control, and live motions (hinges, sliders, spinning parts) animated client-side with
// requestAnimationFrame. Also used, step-limited, by the Assembly tab's step-through.
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import * as THREE from "three"
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber"
import { GizmoHelper, GizmoViewport, OrbitControls } from "@react-three/drei"
import {
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  TriangleAlertIcon,
} from "@/components/icons"
import type {
  Assembly,
  AssemblyInfo,
  AssemblyMotion,
  FilamentSlot,
  MotionCheck,
  MotionReport,
  StepArt,
} from "@shared/types"
import { instanceSteps, showFaceYaw } from "@shared/assembly-art"
import { StepArtOverlay } from "./step-art"
import { Slider } from "@/components/ui/slider"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { reasonText } from "@/components/workspace/StaleNote"
import { usePlain } from "@/lib/use-plain"
import { motionCheckText } from "@shared/motion-text"
import { useHidden } from "@/stores/plates"
import { partKey, useStudio, type Pin } from "@/stores/studio"
import { CaptureRegistrar, PinMarkers, PinPopover, usePinPicker, type DraftPin, type PickContext } from "./pins"
import { ViewToolbar } from "./view-toolbar"

const ZERO3 = new THREE.Vector3()
import {
  BuildPlate,
  CameraRig,
  CanvasGuard,
  StageShift,
  FilamentRim,
  useGizmoMargin,
  displayColor,
  PartMaterial,
  loadRawModel,
  useFilaments,
  type Fit,
  type ModelPiece,
  type View,
} from "./shared"

/* ---------- instances ---------- */

export interface PartInstance {
  key: string // "part#i"
  partId: string
  index: number
  placement: THREE.Matrix4
  step: number | null // first step that adds this part (null = never mentioned)
  stepDir: THREE.Vector3 | null // step explodeDirection (normalised), if given
  stepDist: number
  color: string | undefined // assembly part colour (filament name / hex)
}

const D2R = Math.PI / 180

export function hasPlacements(a: Assembly | null | undefined): a is Assembly {
  return !!a?.placements?.length
}

function placementMatrix(
  t: [number, number, number],
  r?: [number, number, number]
) {
  // OpenSCAD rotate([x,y,z]) = Rz * Ry * Rx, then translate
  const m = new THREE.Matrix4().makeTranslation(t[0], t[1], t[2])
  if (r) {
    m.multiply(new THREE.Matrix4().makeRotationZ(r[2] * D2R))
    m.multiply(new THREE.Matrix4().makeRotationY(r[1] * D2R))
    m.multiply(new THREE.Matrix4().makeRotationX(r[0] * D2R))
  }
  return m
}

const itemId = (it: string | { id: string }) =>
  typeof it === "string" ? it : it.id

export function buildInstances(a: Assembly): PartInstance[] {
  const out: PartInstance[] = []
  const instStep = instanceSteps(a) // copies split over steps ({id, qty}) appear at their own step
  for (const p of a.parts) {
    for (let i = 0; i < Math.max(1, p.qty || 1); i++) {
      const n = instStep.get(`${p.id}#${i}`)
      const step =
        (n != null ? a.steps.find((s) => s.n === n) : a.steps.find((s) => s.adds.some((it) => itemId(it) === p.id))) ?? null
      const pl = a.placements?.find(
        (x) => x.part === p.id && (x.instance ?? 0) === i
      )
      if (!pl) continue
      const dir = step?.explodeDirection
        ? new THREE.Vector3(...step.explodeDirection)
        : null
      out.push({
        key: `${p.id}#${i}`,
        partId: p.id,
        index: i,
        placement: placementMatrix(pl.translate, pl.rotate),
        step: step?.n ?? null,
        stepDir: dir && dir.lengthSq() > 0 ? dir.normalize() : null,
        stepDist: step?.explodeDistance ?? 30,
        color: p.color,
      })
    }
  }
  return out
}

const motionAffects = (m: AssemblyMotion, inst: PartInstance) =>
  m.parts.some((p) => p === inst.partId || p === inst.key)
export const motionRest = (m: AssemblyMotion) => m.rest ?? m.range[0]

function motionMatrix(m: AssemblyMotion, v: number): THREE.Matrix4 {
  const axis = new THREE.Vector3(...m.axis)
  if (axis.lengthSq() === 0) axis.set(0, 0, 1)
  axis.normalize()
  if (m.type === "translate")
    return new THREE.Matrix4().makeTranslation(
      axis.x * v,
      axis.y * v,
      axis.z * v
    )
  const o = m.origin ?? [0, 0, 0]
  return new THREE.Matrix4()
    .makeTranslation(o[0], o[1], o[2])
    .multiply(new THREE.Matrix4().makeRotationAxis(axis, v * D2R))
    .multiply(new THREE.Matrix4().makeTranslation(-o[0], -o[1], -o[2]))
}

/* ---------- motion state (mutable, read every frame; UI subscribes at ~15 Hz) ---------- */

export class MotionState {
  values: Record<string, number> = {}
  playing = new Set<string>()
  private dir: Record<string, 1 | -1> = {}
  private listeners = new Set<() => void>()
  private sinceNotify = 0
  version = 0

  private motions: AssemblyMotion[]
  constructor(motions: AssemblyMotion[]) {
    this.motions = motions
    for (const m of motions) this.values[m.id] = motionRest(m)
  }
  setMotions(motions: AssemblyMotion[]) {
    this.motions = motions
    for (const m of motions)
      if (!(m.id in this.values)) this.values[m.id] = motionRest(m)
    this.notify()
  }
  set(id: string, v: number) {
    this.values[id] = v
    this.notify()
  }
  toggle(id: string, on?: boolean) {
    const play = on ?? !this.playing.has(id)
    if (play) this.playing.add(id)
    else this.playing.delete(id)
    this.notify()
  }
  reset() {
    this.playing.clear()
    for (const m of this.motions) this.values[m.id] = motionRest(m)
    this.notify()
  }
  /** Advance playing motions; returns true if anything moved. */
  tick(dt: number): boolean {
    if (!this.playing.size) return false
    const step = Math.min(dt, 0.1)
    for (const id of this.playing) {
      const m = this.motions.find((x) => x.id === id)
      if (!m) continue
      const [lo, hi] =
        m.range[0] <= m.range[1] ? m.range : [m.range[1], m.range[0]]
      const span = hi - lo || 1
      const speed = span / (m.continuous ? 3 : m.type === "rotate" ? 1.6 : 1.3) // full sweep time (s)
      let v = (this.values[id] ?? lo) + (this.dir[id] ?? 1) * speed * step
      if (m.continuous) {
        if (v > hi) v = lo + (v - hi)
      } else if (v >= hi) {
        v = hi
        this.dir[id] = -1
      } else if (v <= lo) {
        v = lo
        this.dir[id] = 1
      }
      this.values[id] = v
    }
    this.sinceNotify += step
    if (this.sinceNotify > 0.066) {
      this.sinceNotify = 0
      this.notify()
    }
    return true
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  getVersion = () => this.version
  private notify() {
    this.version++
    for (const l of this.listeners) l()
  }
}

export function useMotionState(motions: AssemblyMotion[] | undefined) {
  const [state] = useState(() => new MotionState(motions ?? []))
  useEffect(() => {
    state.setMotions(motions ?? [])
  }, [state, motions])
  // deliberately not subscribed: the 3D scene reads values every frame; only UI widgets subscribe
  return state
}

/* ---------- loading every part's mesh ---------- */

type PartModelsInfo = AssemblyInfo & { partModels?: Record<string, string> }

/** Each assembly part's mesh: AssemblyInfo.partModels, else the part's latest render (3MF, then STL). */
export function useAssemblyPieces(
  projectId: string,
  info: AssemblyInfo | null | undefined
) {
  const a = info?.assembly
  const partIds = useMemo(
    () => (a ? [...new Set(a.parts.map((p) => p.id))] : []),
    [a]
  )
  const partModels = (info as PartModelsInfo | null | undefined)?.partModels
  return usePartPieces(projectId, partIds, partModels)
}

/** Meshes of these parts in their own coordinates: `partModels` URLs, else each part's latest render (3MF, then STL). */
export function usePartPieces(
  projectId: string,
  partIds: string[],
  partModels?: Record<string, string>
) {
  // re-resolve when any of these parts gets re-rendered
  const renderSig = useStudio((s) =>
    partIds
      .map(
        (id) =>
          s.renders[partKey(projectId, id)]?.modelUrl ??
          s.renders[partKey(projectId, id)]?.stlUrl ??
          ""
      )
      .join("|")
  )
  const [state, setState] = useState<{
    pieces: Record<string, ModelPiece[]>
    missing: string[]
    error: string | null
    sig: string
  } | null>(null)
  const sig = `${JSON.stringify(partModels ?? {})}::${renderSig}::${partIds.join(",")}`

  useEffect(() => {
    let alive = true
    const resolveUrl = async (id: string): Promise<string | null> => {
      const direct = partModels?.[id]
      if (direct) return direct
      const r = useStudio.getState().renders[partKey(projectId, id)]
      if (r && !r.error && (r.modelUrl || r.stlUrl))
        return r.modelUrl || r.stlUrl
      try {
        const latest = await api.latest(projectId, id)
        return latest.render?.modelUrl || latest.render?.stlUrl || null
      } catch {
        return null
      }
    }
    void (async () => {
      const pieces: Record<string, ModelPiece[]> = {}
      const missing: string[] = []
      let error: string | null = null
      await Promise.all(
        partIds.map(async (id) => {
          const url = await resolveUrl(id)
          if (!url) return void missing.push(id)
          try {
            pieces[id] = await loadRawModel(url)
          } catch (e) {
            error = `${id}: ${(e as Error).message}`
            missing.push(id)
          }
        })
      )
      if (alive) setState({ pieces, missing, error, sig })
    })()
    return () => {
      alive = false
    }
    // sig captures every input
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])

  return {
    pieces: state?.pieces ?? null,
    missing: state?.missing ?? [],
    error: state?.error ?? null,
    loading: !state || state.sig !== sig,
  }
}

/* ---------- the scene ---------- */

export interface SceneBounds {
  box: THREE.Box3
  sphere: THREE.Sphere
}

const DIM = new THREE.Color("#8b929c")

export function AssemblyScene({
  assembly,
  pieces,
  filaments,
  explode,
  motion,
  upto = null,
  onBounds,
  onExplodedBounds,
  onPick,
  pins,
  art,
  children,
}: {
  assembly: Assembly
  pieces: Record<string, ModelPiece[]>
  filaments: FilamentSlot[]
  explode: number // 0..1
  motion: MotionState
  upto?: number | null // step-through: only parts added up to this step; that step's parts highlighted
  onBounds?: (b: SceneBounds) => void
  onExplodedBounds?: (b: SceneBounds) => void // bounds at the current explode amount (for camera follow)
  onPick?: (e: ThreeEvent<MouseEvent>, ctx: PickContext) => void // Point tool
  pins?: Pin[] // assembled-view pins, drawn on their part instance (they follow motion/explode)
  art?: StepArt | null // R14: this step's illustration plan (explode offsets, highlighted instances)
  children?: ReactNode // drawn in assembly coordinates (same centring offset as the parts)
}) {
  const instances = useMemo(() => buildInstances(assembly), [assembly])
  const motions = useMemo(() => assembly.motions ?? [], [assembly])
  const multiStep = assembly.steps.length > 1

  // rest-pose bounds: per instance and overall (used for radial explode and to sit the build on the plate)
  const { instBox, offset, bounds } = useMemo(() => {
    const instBox = new Map<string, THREE.Box3>()
    const all = new THREE.Box3()
    for (const inst of instances) {
      const b = new THREE.Box3()
      for (const pc of pieces[inst.partId] ?? []) {
        if (pc.geometry.boundingBox)
          b.union(pc.geometry.boundingBox.clone().applyMatrix4(inst.placement))
      }
      if (!b.isEmpty()) {
        instBox.set(inst.key, b)
        all.union(b)
      }
    }
    if (all.isEmpty())
      all.set(new THREE.Vector3(-10, -10, 0), new THREE.Vector3(10, 10, 10))
    const offset = new THREE.Vector3(
      -(all.min.x + all.max.x) / 2,
      -(all.min.y + all.max.y) / 2,
      -all.min.z
    )
    const box = all.clone().translate(offset)
    return {
      instBox,
      offset,
      bounds: { box, sphere: box.getBoundingSphere(new THREE.Sphere()) },
    }
  }, [instances, pieces])

  useEffect(() => {
    onBounds?.(bounds)
  }, [bounds, onBounds])

  // explode vectors (unit direction * distance at explode = 1)
  const explodeVec = useMemo(() => {
    const center = bounds.box.getCenter(new THREE.Vector3()).sub(offset)
    const out = new Map<string, THREE.Vector3>()
    for (const inst of instances) {
      if (multiStep && inst.step === 1 && !inst.stepDir) {
        out.set(inst.key, new THREE.Vector3()) // the base stays put
        continue
      }
      let dir = inst.stepDir?.clone()
      if (!dir) {
        const c = instBox.get(inst.key)?.getCenter(new THREE.Vector3())
        dir = c ? c.sub(center) : new THREE.Vector3(0, 0, 1)
        if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1)
        dir.normalize()
      }
      const size =
        instBox.get(inst.key)?.getSize(new THREE.Vector3()).length() ?? 30
      out.set(inst.key, dir.multiplyScalar(Math.max(inst.stepDist, size * 0.6)))
    }
    // R14: the step art says exactly how each new item comes in (the same offsets the printed picture uses)
    for (const ai of art?.instances ?? []) if (ai.role === "new") out.set(ai.key, new THREE.Vector3(...ai.offset))
    return out
  }, [instances, instBox, bounds, offset, multiStep, art])

  // bounds at the current explode amount (rest pose of motions), in plate coordinates
  useEffect(() => {
    if (!onExplodedBounds) return
    const box = new THREE.Box3()
    for (const inst of instances) {
      if (!(upto == null || inst.step == null || inst.step <= upto)) continue
      const b = instBox.get(inst.key)
      if (!b) continue
      const e = upto != null && inst.step !== upto ? 0 : explode
      const ev = explodeVec.get(inst.key)
      box.union(ev && e ? b.clone().translate(ev.clone().multiplyScalar(e)) : b)
    }
    if (box.isEmpty()) return
    box.translate(offset)
    onExplodedBounds({ box, sphere: box.getBoundingSphere(new THREE.Sphere()) })
  }, [explode, instances, instBox, explodeVec, offset, upto, onExplodedBounds])

  const partBoxes = useMemo(() => {
    const m = new Map<string, THREE.Box3>()
    for (const [id, pcs] of Object.entries(pieces)) {
      const b = new THREE.Box3()
      for (const pc of pcs) if (pc.geometry.boundingBox) b.union(pc.geometry.boundingBox)
      m.set(id, b)
    }
    return m
  }, [pieces])

  const visible = (inst: PartInstance) =>
    upto == null || inst.step == null || inst.step <= upto
  const isNew = (inst: PartInstance) => upto != null && inst.step === upto
  const focused = useMemo(() => new Set((art?.instances ?? []).filter((x) => x.role === "focus").map((x) => x.key)), [art])
  const dimmed = (inst: PartInstance) => upto != null && !isNew(inst) && !focused.has(inst.key)

  const groups = useRef(new Map<string, THREE.Group>())
  const explodeRef = useRef(explode)
  useEffect(() => {
    explodeRef.current = explode
  }, [explode])

  const tmp = useMemo(() => new THREE.Matrix4(), [])
  useFrame((_, dt) => {
    motion.tick(dt)
    for (const inst of instances) {
      const g = groups.current.get(inst.key)
      if (!g) continue
      // explode (in step mode only the new parts move)
      const e = upto != null && !isNew(inst) ? 0 : explodeRef.current
      const ev = explodeVec.get(inst.key)
      const m = g.matrix.identity()
      for (const mo of motions)
        if (motionAffects(mo, inst))
          m.premultiply(
            tmp.copy(motionMatrix(mo, motion.values[mo.id] ?? motionRest(mo)))
          )
      // placement first, then explode offset, then motions about assembly-space axes
      const base = new THREE.Matrix4().copy(inst.placement)
      if (ev && e)
        base.premultiply(tmp.makeTranslation(ev.x * e, ev.y * e, ev.z * e))
      m.multiply(base)
      g.matrixWorldNeedsUpdate = true
    }
  })

  return (
    <group position={offset}>
      {instances.filter(visible).map((inst) => (
        <group
          key={inst.key}
          matrixAutoUpdate={false}
          ref={(g) => {
            if (g) groups.current.set(inst.key, g)
            else groups.current.delete(inst.key)
          }}
        >
          {(pieces[inst.partId] ?? []).map((pc, i) => {
            const c = new THREE.Color(
              displayColor(pc.color, inst.color, filaments, inst.partId)
            )
            const dim = dimmed(inst)
            if (dim) c.lerp(DIM, 0.55)
            return (
              <mesh
                key={i}
                geometry={pc.geometry}
                onClick={
                  onPick
                    ? (e) =>
                        onPick(e, {
                          partId: inst.partId,
                          view: "assembled",
                          instance: inst.index,
                          instanceKey: inst.key,
                          localToPart: ZERO3,
                          partBox: partBoxes.get(inst.partId) ?? new THREE.Box3(),
                          placement: inst.placement,
                        })
                    : undefined
                }
              >
                <PartMaterial
                  color={c}
                  transparent={dim}
                  opacity={dim ? 0.55 : 1}
                  depthWrite={!dim}
                  emissive={isNew(inst) ? c : "#000000"}
                  emissiveIntensity={isNew(inst) ? 0.12 : 0}
                />
              </mesh>
            )
          })}
          {pins && pins.some((p) => p.instanceKey === inst.key) && (
            <PinMarkers pins={pins.filter((p) => p.instanceKey === inst.key)} />
          )}
        </group>
      ))}
      {children}
    </group>
  )
}

/* ---------- camera follow: ease to keep changing bounds (explode) in frame ---------- */

/** Same framing as CameraRig's "part" fit, but eased every frame, keeping the current view direction. */
export function CameraFollow({ bounds }: { bounds: SceneBounds | null }) {
  const goal = useRef<{ center: THREE.Vector3; dist: number } | null>(null)
  const get = useThree((s) => s.get)
  useEffect(() => {
    if (!bounds) return
    const camera = get().camera as THREE.PerspectiveCamera
    const r = Math.max(bounds.sphere.radius * 1.2, 40)
    const fov = ((camera.fov ?? 35) * Math.PI) / 180
    goal.current = {
      center: bounds.sphere.center.clone(),
      dist: (r / Math.sin(fov / 2)) * 1.05,
    }
  }, [bounds, get])
  useFrame((state, dt) => {
    const g = goal.current
    const controls = state.controls as unknown as {
      target: THREE.Vector3
      update: () => void
    } | null
    if (!g || !controls) return
    const camera = state.camera as THREE.PerspectiveCamera
    const k = 1 - Math.exp(-Math.min(dt, 0.1) * 7)
    const dir = camera.position.clone().sub(controls.target)
    const dist = dir.length()
    dir.normalize()
    controls.target.lerp(g.center, k)
    const nd = dist + (g.dist - dist) * k
    camera.position.copy(controls.target).addScaledVector(dir, nd)
    camera.far = Math.max(camera.far, nd * 20)
    camera.updateProjectionMatrix()
    controls.update()
    if (
      controls.target.distanceTo(g.center) < 0.05 &&
      Math.abs(nd - g.dist) < 0.1
    )
      goal.current = null
  })
  return null
}

/* ---------- motion controls overlay ---------- */

/** One line per motion from the last collision check: always with how many positions and which range. */
function motionResultLine(r: MotionReport): { text: string; tone: "ok" | "warn" | "err" } {
  const u = r.unit === "°" ? "°" : " mm"
  const c = r.coverage
  if (!r.ok) {
    const hit = r.collisions[0]
    return {
      text: `${hit.a} hits ${hit.b} at ${hit.atValues.length > 1 ? `${hit.atValues[0]}–${hit.atValues[hit.atValues.length - 1]}` : hit.atValues[0]}${u}${r.collisions.length > 1 ? ` (+${r.collisions.length - 1} more)` : ""}`,
      tone: "err",
    }
  }
  const gap = r.minClearanceMm
  return {
    text:
      `No collisions in ${c.positions} positions, ${c.from}–${c.to}${u}` +
      (gap !== null ? ` · closest gap ${gap} mm${r.clearanceAt !== null ? ` at ${+r.clearanceAt.toFixed(1)}${u}` : ""}` : "") +
      (gap !== null && gap < 0.2 ? " (may rub)" : ""),
    tone: gap !== null && gap < 0.2 ? "warn" : "ok",
  }
}

function MotionCheckFooter({
  check,
  checking,
  error,
  onCheck,
}: {
  check: MotionCheck | null | undefined
  checking: boolean
  error: string | null
  onCheck?: () => void
}) {
  const plain = usePlain()
  let line: ReactNode
  if (!check) line = "Not checked for collisions yet."
  else if (check.stale)
    line = (
      <span className="flex flex-col text-warn" title={check.staleReasons?.join("\n")} role="status">
        <span className="flex items-center gap-1 font-medium">
          <TriangleAlertIcon className="size-3 shrink-0" /> Out of date — re-run
        </span>
        <span className="truncate font-mono text-warn">
          {check.staleReasons?.length ? reasonText({ state: "stale", reasons: check.staleReasons, builtAt: null }, plain) : "changed since the last collision check"}
        </span>
      </span>
    )
  else if (check.status === "incomplete")
    line = (
      <span className="text-warn" title={check.incomplete.join("\n")}>
        Check incomplete: {check.incomplete[0]}
        {check.incomplete.length > 1 ? ` (+${check.incomplete.length - 1} more)` : ""}
      </span>
    )
  else if (check.restCollisions.length)
    line = (
      <span className="text-err">
        {check.restCollisions[0].a} and {check.restCollisions[0].b} overlap when put together.
      </span>
    )
  else {
    const bad = check.combined.filter((s) => !s.ok)
    line = check.combined.length ? (
      bad.length ? (
        <span className="text-err">Together: {bad[0].label} collide.</span>
      ) : (
        `Also checked ${check.combined.length} combination${check.combined.length > 1 ? "s" : ""} of moves together.`
      )
    ) : null
  }
  const scope = check && !check.stale
  return (
    <div className="flex flex-col gap-1 border-t pt-1.5 text-micro leading-snug text-muted-foreground">
      {line && <div>{line}</div>}
      {scope && (
        <div title={check.scope.skipped.map((s) => `${s.id}: ${s.reason}`).join("\n")}>
          Only those positions were checked
          {check.scope.hardware.length ? `, with ${check.scope.hardware.length} hardware item${check.scope.hardware.length > 1 ? "s" : ""}` : ""}
          {check.scope.skipped.length ? `; ${check.scope.skipped.length} item${check.scope.skipped.length > 1 ? "s" : ""} not included` : ""}. Strength and
          friction aren't checked.
        </div>
      )}
      {error && <div className="text-err">{error}</div>}
      {onCheck && (
        <button
          className="flex h-6 items-center justify-center gap-1.5 border text-caption text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-60"
          onClick={onCheck}
          disabled={checking}
          title="Move every part through its range and look for parts that hit each other"
        >
          {checking && <Loader2Icon className="size-3 animate-spin" />}
          {checking ? "Checking…" : check ? "Check again" : "Check for collisions"}
        </button>
      )}
    </div>
  )
}

export function MovesPanel({
  motions,
  state,
  className,
  check,
  onCheck,
}: {
  motions: AssemblyMotion[]
  state: MotionState
  className?: string
  check?: MotionCheck | null // last check_motion result (AssemblyInfo.motionCheck)
  onCheck?: () => Promise<void>
}) {
  useSyncExternalStore(state.subscribe, state.getVersion)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!motions.length) return null
  const fresh = check && !check.stale ? check : null
  const runCheck = onCheck
    ? () => {
        setChecking(true)
        setError(null)
        onCheck()
          .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
          .finally(() => setChecking(false))
      }
    : undefined
  return (
    <div
      className={cn(
        "flex w-64 flex-col gap-2 rounded-lg border bg-surface-1/90 p-2 backdrop-blur",
        className
      )}
    >
      <div className="ps-label flex items-center">
        Moves
        <div className="flex-1" />
        <button
          className="font-normal normal-case hover:text-foreground"
          onClick={() => state.reset()}
          title="Back to the resting pose"
        >
          Reset
        </button>
      </div>
      {motions.map((m) => {
        const [lo, hi] =
          m.range[0] <= m.range[1] ? m.range : [m.range[1], m.range[0]]
        const v = state.values[m.id] ?? motionRest(m)
        const playing = state.playing.has(m.id)
        const unit = m.type === "rotate" ? "°" : " mm"
        return (
          <div key={m.id} className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => state.toggle(m.id)}
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center border text-muted-foreground hover:text-foreground",
                  playing && "border-primary/60 bg-primary/15 text-primary"
                )}
                title={
                  playing
                    ? "Pause"
                    : m.continuous
                      ? "Play (loop)"
                      : "Play (back and forth)"
                }
                aria-label={`${playing ? "Pause" : "Play"} ${m.label}`}
                aria-pressed={playing}
              >
                {playing ? (
                  <PauseIcon className="size-3.5" />
                ) : (
                  <PlayIcon className="size-3.5" />
                )}
              </button>
              <span className="min-w-0 flex-1 truncate text-xs font-medium">
                {m.label}
              </span>
              <span className="text-micro text-muted-foreground tabular-nums">
                {Math.round(v)}
                {unit}
              </span>
            </div>
            <Slider
              min={lo}
              max={hi}
              step={(hi - lo) / 200 || 0.1}
              value={[Math.min(hi, Math.max(lo, v))]}
              onValueChange={(x) => {
                state.toggle(m.id, false)
                state.set(m.id, Array.isArray(x) ? x[0] : (x as number))
              }}
            />
            {(() => {
              const r = fresh?.motions.find((x) => x.id === m.id)
              if (!r) return null
              const { text, tone } = motionResultLine(r)
              return (
                <div
                  className={cn(
                    "text-micro leading-snug",
                    tone === "ok" && "text-muted-foreground",
                    tone === "warn" && "text-warn",
                    tone === "err" && "text-err"
                  )}
                  title={r.text}
                >
                  {text}
                </div>
              )
            })()}
            {m.check && (
              <div className="text-micro leading-snug text-muted-foreground">
                Check by hand: {motionCheckText(m, fresh)}
              </div>
            )}
          </div>
        )
      })}
      <MotionCheckFooter check={check} checking={checking} error={error} onCheck={runCheck} />
    </div>
  )
}

/* ---------- full assembled viewer (Model tab) ---------- */

export function AssembledViewer({
  projectId,
  info,
  toolbar,
}: {
  projectId: string
  info: AssemblyInfo
  toolbar: ReactNode
}) {
  const a = info.assembly!
  const { pieces: allPieces, missing, error, loading } = useAssemblyPieces(projectId, info)
  // parts hidden with the sidebar eye toggles (R13)
  const hiddenParts = useHidden(projectId).parts
  const pieces = useMemo(
    () => (allPieces && hiddenParts.length ? Object.fromEntries(Object.entries(allPieces).filter(([id]) => !hiddenParts.includes(id))) : allPieces),
    [allPieces, hiddenParts]
  )
  const filaments = useFilaments()
  const motion = useMotionState(a.motions)
  const [explode, setExplode] = useState(0)
  const [bounds, setBounds] = useState<SceneBounds | null>(null)
  const [exploded, setExploded] = useState<SceneBounds | null>(null)
  const [view, setView] = useState<View>("iso")
  const [fit, setFit] = useState<Fit>("part")
  const [nonce, setNonce] = useState(0)
  // face-down pieces (show face on the plate): look at their show faces, as the guide's picture does
  const faceDown = useStudio((s) => a.parts.filter((p) => s.renders[partKey(projectId, p.id)]?.showFaceDown).map((p) => p.id).join(","))
  const yaw = useMemo(() => (showFaceYaw(a, faceDown ? faceDown.split(",") : []) * Math.PI) / 180, [a, faceDown])

  // frame once the first bounds arrive
  const framed = useRef(false)
  useEffect(() => {
    if (bounds && !framed.current) {
      framed.current = true
      setNonce((n) => n + 1)
    }
  }, [bounds])

  const snap = (v: View, f: Fit = fit) => {
    setView(v)
    setFit(f)
    setNonce((n) => n + 1)
  }
  // snaps frame the current (exploded) bounds; while exploding, CameraFollow eases the camera instead
  const framedBounds = exploded ?? bounds
  const [follow, setFollow] = useState(false)
  const pinMode = useStudio((s) => s.pinMode)
  const loadAssembly = useStudio((s) => s.loadAssembly)
  const allPins = useStudio((s) => s.pins[projectId])
  const asmPins = useMemo(() => (allPins ?? []).filter((p) => p.view === "assembled"), [allPins])
  const [draft, setDraft] = useState<DraftPin | null>(null)
  const pick = usePinPicker(setDraft)
  const gizmoMargin = useGizmoMargin()
  // the rim light takes the most colourful part's tone
  const rimColors = useMemo(
    () => buildInstances(a).map((i) => displayColor(null, i.color, filaments, i.partId)),
    [a, filaments],
  )

  return (
    <div
      data-viewer
      className={cn("absolute inset-0 ps-stage", pinMode && "cursor-crosshair")}
    >
      <Canvas
        dpr={[1, 2]}
        camera={{
          position: [250, -300, 220],
          fov: 35,
          near: 1,
          far: 5000,
          up: [0, 0, 1],
        }}
      >
        <CanvasGuard />
        <StageShift />
        <CaptureRegistrar />
        <ambientLight intensity={0.35} />
        <hemisphereLight args={["#ffffff", "#3b4758", 1.1]} />
        <directionalLight position={[200, -300, 400]} intensity={1.9} />
        <directionalLight position={[-300, 200, 150]} intensity={0.7} />
        <FilamentRim colors={rimColors} />
        <BuildPlate over={false} />
        {pieces && (
          <AssemblyScene
            assembly={a}
            pieces={pieces}
            filaments={filaments}
            explode={explode}
            motion={motion}
            onBounds={setBounds}
            onExplodedBounds={setExploded}
            onPick={pick}
            pins={asmPins}
          />
        )}
        {follow && fit === "part" && <CameraFollow bounds={exploded} />}
        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.12}
          maxPolarAngle={Math.PI * 0.53}
        />
        <CameraRig
          view={view}
          fit={fit}
          nonce={nonce + yaw} // re-frames when the renders say which pieces are face down
          bounds={framedBounds}
          yaw={yaw}
        />
        <GizmoHelper alignment="bottom-right" margin={gizmoMargin}>
          <GizmoViewport
            axisColors={["#ef4444", "#22c55e", "#3b82f6"]}
            labelColor="#fff"
          />
        </GizmoHelper>
      </Canvas>

      <div className={cn("absolute top-2 left-2 flex flex-col items-start gap-2", (a.motions?.length ?? 0) > 0 && "max-w-[calc(100%-17.5rem)]")}>
        <ViewToolbar
          show={toolbar}
          view={view}
          fit={fit}
          onView={(v) => snap(v)}
          onFit={(f) => snap(view, f)}
          fitTitles={{ part: "Zoom to the parts", plate: "Show the whole bed" }}
        />
        <div className="flex w-56 items-center gap-2 border bg-surface-1/90 px-2 py-1 text-caption text-muted-foreground backdrop-blur">
          Explode
          <Slider
            min={0}
            max={1}
            step={0.01}
            value={[explode]}
            onValueChange={(x) => {
              setFollow(true)
              setExplode(Array.isArray(x) ? x[0] : (x as number))
            }}
          />
        </div>
      </div>

      {draft && <PinPopover draft={draft} projectId={projectId} onClose={() => setDraft(null)} />}
      <MovesPanel
        motions={a.motions ?? []}
        state={motion}
        check={info.motionCheck}
        onCheck={async () => {
          await api.checkMotion(projectId)
          await loadAssembly(projectId)
          useStudio.getState().loadValidity(projectId)
        }}
        className="absolute top-2 right-2 max-h-[calc(100%-1rem)] overflow-y-auto"
      />

      {hiddenParts.some((id) => a.parts.some((p) => p.id === id)) && (
        <div className="absolute bottom-10 left-2 border bg-surface-1/90 px-2 py-1 text-caption text-muted-foreground backdrop-blur">
          Hidden: {hiddenParts.filter((id) => a.parts.some((p) => p.id === id)).join(", ")} (eye in the Parts list)
        </div>
      )}
      {(loading || missing.length > 0 || error) && (
        <div className="absolute bottom-2 left-2 flex max-w-md items-center gap-1.5 border bg-surface-1/90 px-2 py-1 text-caption text-muted-foreground backdrop-blur">
          {loading ? (
            <>
              <Loader2Icon className="size-3 animate-spin" /> Loading parts…
            </>
          ) : (
            <>
              <TriangleAlertIcon className="size-3 text-warn" />
              {missing.length
                ? `Not rendered yet: ${missing.join(", ")} (render those parts to see them here)`
                : error}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/* ---------- small live view for one assembly step ---------- */

export function StepScene({
  projectId,
  info,
  step,
  className,
  fallback = null,
}: {
  projectId: string
  info: AssemblyInfo
  step: number // 0 = finished assembly
  className?: string
  fallback?: ReactNode // shown when the parts can't be loaded (e.g. not rendered yet)
}) {
  const a = info.assembly!
  const { pieces, loading, missing } = useAssemblyPieces(projectId, info)
  const filaments = useFilaments()
  const motion = useMotionState(a.motions)
  const [bounds, setBounds] = useState<SceneBounds | null>(null)
  const [explode, setExplode] = useState(1)
  const stepDef = a.steps.find((s) => s.n === step)
  const showMotion = stepDef?.showMotion
  const art = useMemo(() => info.art?.steps.find((s) => s.n === step) ?? null, [info.art, step])
  const hold = art && art.arrows.length ? 1600 : 0 // R14: show the arrows (as in the printed step) before gliding in
  const [replay, setReplay] = useState(0)

  // entering a step: new parts glide in from their exploded position, then the step's motion plays
  useEffect(() => {
    motion.reset()
    let raf = 0
    const t0 = performance.now()
    const tick = () => {
      const t = Math.max(0, Math.min(1, (performance.now() - t0 - hold) / 900))
      setExplode(step === 0 ? 0 : 1 - t * t * (3 - 2 * t))
      if (t < 1) raf = requestAnimationFrame(tick)
      else if (showMotion) motion.toggle(showMotion, true)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [step, showMotion, motion, hold, replay])

  const [nonce, setNonce] = useState(0)
  const framedFor = useRef<number | null>(null)
  useEffect(() => {
    if (bounds && framedFor.current !== step) {
      framedFor.current = step
      setNonce((n) => n + 1)
    }
  }, [bounds, step])
  const framedBounds = useMemo(() => {
    if (!bounds) return null
    const box = bounds.box.clone().expandByScalar(20)
    return { box, sphere: box.getBoundingSphere(new THREE.Sphere()) }
  }, [bounds])

  const usable = !!pieces && Object.keys(pieces).length > 0
  if (!loading && !usable) return <>{fallback}</>

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-lg border bg-stage",
        className
      )}
    >
      <Canvas
        dpr={[1, 2]}
        camera={{
          position: [250, -300, 220],
          fov: 35,
          near: 1,
          far: 5000,
          up: [0, 0, 1],
        }}
      >
        <CanvasGuard />
        <ambientLight intensity={0.35} />
        <hemisphereLight args={["#ffffff", "#3b4758", 1.1]} />
        <directionalLight position={[200, -300, 400]} intensity={1.9} />
        <directionalLight position={[-300, 200, 150]} intensity={0.7} />
        {pieces && (
          <AssemblyScene
            assembly={a}
            pieces={pieces}
            filaments={filaments}
            explode={explode}
            motion={motion}
            upto={step === 0 ? null : step}
            onBounds={setBounds}
            art={art}
          >
            {art && <StepArtOverlay art={art} explode={explode} />}
          </AssemblyScene>
        )}
        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.12}
          maxPolarAngle={Math.PI * 0.53}
        />
        <CameraRig
          view="iso"
          fit="part"
          nonce={nonce}
          bounds={framedBounds}
          yaw={0}
          viewDir={art?.camera.dir}
        />
      </Canvas>
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
        </div>
      )}
      {art && hold > 0 && (
        <button
          className="absolute bottom-1.5 left-1.5 flex items-center gap-1 border bg-surface-1/90 px-1.5 py-0.5 text-micro text-muted-foreground backdrop-blur hover:text-foreground"
          onClick={() => setReplay((r) => r + 1)}
          title="Show the arrows again, then put the new parts in"
        >
          <PlayIcon className="size-3" /> Show how it goes in
        </button>
      )}
      {showMotion && (
        <PlayChip
          state={motion}
          id={showMotion}
          label={a.motions?.find((m) => m.id === showMotion)?.label ?? "Motion"}
        />
      )}
      {missing.length > 0 && !loading && (
        <div className="absolute top-1.5 left-1.5 text-micro text-warn">
          Missing: {missing.join(", ")}
        </div>
      )}
    </div>
  )
}

function PlayChip({
  state,
  id,
  label,
}: {
  state: MotionState
  id: string
  label: string
}) {
  useSyncExternalStore(state.subscribe, state.getVersion)
  const on = state.playing.has(id)
  return (
    <button
      className="absolute right-1.5 bottom-1.5 flex items-center gap-1 border bg-surface-1/90 px-1.5 py-0.5 text-micro text-muted-foreground backdrop-blur hover:text-foreground"
      onClick={() => state.toggle(id)}
      aria-label={`${on ? "Pause" : "Play"} ${label}`}
    >
      {on ? <PauseIcon className="size-3" /> : <PlayIcon className="size-3" />}
      {label}
    </button>
  )
}
