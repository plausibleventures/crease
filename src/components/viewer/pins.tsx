// "Point" tool: click the model to drop numbered pins with a note ("make this thicker"). Pins are
// sent with the next chat message as structured annotations plus a picture of the view.
import { useEffect, useMemo, useRef, useState } from "react"
import * as THREE from "three"
import { useThree, type ThreeEvent } from "@react-three/fiber"
import { CrosshairIcon } from "@/components/icons"
import { useStudio, type Pin } from "@/stores/studio"
import { cn } from "@/lib/utils"

/* ---------- describing a spot in plain words ---------- */

/** "top face, near the back-left corner" from the normal and where the point sits in the part's box. */
export function describeSpot(p: THREE.Vector3, n: THREE.Vector3, box: THREE.Box3): string {
  const a = [Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)]
  const i = a.indexOf(Math.max(...a))
  const sign = [n.x, n.y, n.z][i] >= 0
  const size = box.getSize(new THREE.Vector3())
  const rel = (v: number, lo: number, s: number) => (s > 1e-6 ? (v - lo) / s : 0.5)
  const t = [rel(p.x, box.min.x, size.x), rel(p.y, box.min.y, size.y), rel(p.z, box.min.z, size.z)]
  // outer face if the point sits on the box side the normal points to; otherwise an inner surface
  // (inside of a wall, floor of a pocket, …)
  const outer = sign ? t[i] > 0.85 : t[i] < 0.15
  const dirWord = [sign ? "right" : "left", sign ? "back" : "front", sign ? "up" : "down"][i]
  const face = outer
    ? [sign ? "right side" : "left side", sign ? "back side" : "front side", sign ? "top face" : "underside"][i]
    : i === 2
      ? sign
        ? "inner floor / ledge (facing up)"
        : "inner ceiling / overhang (facing down)"
      : `inside wall surface (facing ${dirWord})`
  const words: [string, string][] = [
    ["left", "right"],
    ["front", "back"],
    ["bottom", "top"],
  ]
  const parts: string[] = []
  for (const k of [2, 1, 0]) {
    if (k === i) continue
    if (t[k] < 0.2) parts.push(words[k][0])
    else if (t[k] > 0.8) parts.push(words[k][1])
  }
  const where =
    parts.length === 2 ? `near the ${parts.join("-")} corner` : parts.length === 1 ? `near the ${parts[0]} edge` : "in the middle"
  return `${face}, ${where}`
}

/* ---------- pick handling ---------- */

export interface PickContext {
  partId: string | null
  /** geometry-local -> part coordinates (part view geometry is shifted to sit on the plate) */
  localToPart: THREE.Vector3
  partBox: THREE.Box3 // part coordinates
  view: "part" | "assembled"
  instance?: number
  instanceKey?: string
  placement?: THREE.Matrix4 // part -> assembly coordinates (assembled view)
}

export interface DraftPin {
  pin: Omit<Pin, "n" | "sent">
  x: number // px within the viewer container
  y: number
}

/** onClick handler factory for meshes: in Point mode, a click (not a drag) opens the note popover. */
export function usePinPicker(onDraft: (d: DraftPin) => void) {
  return (e: ThreeEvent<MouseEvent>, ctx: PickContext) => {
    if (!useStudio.getState().pinMode) return
    if (e.delta > 5) return // that was an orbit drag
    e.stopPropagation()
    const obj = e.object
    const local = obj.worldToLocal(e.point.clone())
    const part = local.clone().sub(ctx.localToPart)
    const normal = (e.face?.normal ?? new THREE.Vector3(0, 0, 1)).clone().normalize()
    const asm = ctx.placement ? part.clone().applyMatrix4(ctx.placement) : null
    const r = (v: THREE.Vector3) => [v.x, v.y, v.z].map((x) => Math.round(x * 100) / 100) as [number, number, number]
    const canvas = (e.nativeEvent.target as HTMLElement | null)?.closest("[data-viewer]") as HTMLElement | null
    const rect = canvas?.getBoundingClientRect()
    onDraft({
      pin: {
        partId: ctx.partId,
        ...(ctx.instance !== undefined ? { instance: ctx.instance } : {}),
        point: r(part),
        ...(asm ? { assemblyPoint: r(asm) } : {}),
        normal: r(normal),
        hint: describeSpot(part, normal, ctx.partBox),
        note: "",
        view: ctx.view,
        ...(ctx.instanceKey ? { instanceKey: ctx.instanceKey } : {}),
      },
      x: e.nativeEvent.clientX - (rect?.left ?? 0),
      y: e.nativeEvent.clientY - (rect?.top ?? 0),
    })
  }
}

/* ---------- markers ---------- */

const texCache = new Map<string, THREE.CanvasTexture>()
function pinTexture(n: number, hot: boolean, sent: boolean) {
  const key = `${n}:${hot}:${sent}`
  let t = texCache.get(key)
  if (!t) {
    const c = document.createElement("canvas")
    c.width = c.height = 128
    const g = c.getContext("2d")!
    g.beginPath()
    g.arc(64, 64, 52, 0, Math.PI * 2)
    g.fillStyle = hot ? "#f59e0b" : sent ? "rgba(100,116,139,0.9)" : "#e11d48"
    g.fill()
    g.lineWidth = 10
    g.strokeStyle = "#ffffff"
    g.stroke()
    g.fillStyle = "#ffffff"
    g.font = "bold 64px system-ui, sans-serif"
    g.textAlign = "center"
    g.textBaseline = "middle"
    g.fillText(String(n), 64, 68)
    t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    texCache.set(key, t)
  }
  return t
}

/** Numbered pins at part-coordinate points (parent supplies the part's transform). */
export function PinMarkers({ pins, localOffset }: { pins: Pin[]; localOffset?: THREE.Vector3 }) {
  const hover = useStudio((s) => s.hoverPin)
  const off = localOffset ?? ZERO
  return (
    <>
      {pins.map((p) => {
        const hot = hover === p.n && !p.sent
        const pos = new THREE.Vector3(...p.point).add(off)
        return (
          <group key={`${p.n}:${p.sent}`} position={pos}>
            <mesh renderOrder={998}>
              <sphereGeometry args={[0.9, 12, 12]} />
              <meshBasicMaterial color={hot ? "#f59e0b" : "#e11d48"} depthTest={false} transparent />
            </mesh>
            <sprite renderOrder={999} scale={hot ? [0.06, 0.06, 1] : [0.045, 0.045, 1]} center={[0.5, -0.15]}>
              <spriteMaterial map={pinTexture(p.n, hot, p.sent)} sizeAttenuation={false} depthTest={false} transparent />
            </sprite>
          </group>
        )
      })}
    </>
  )
}
const ZERO = new THREE.Vector3()

/* ---------- note popover (HTML, positioned over the canvas) ---------- */

export function PinPopover({ draft, projectId, onClose }: { draft: DraftPin; projectId: string; onClose: () => void }) {
  const [note, setNote] = useState("")
  const addPin = useStudio((s) => s.addPin)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.focus(), [])
  const add = () => {
    addPin(projectId, { ...draft.pin, note: note.trim() })
    onClose()
  }
  return (
    <div
      className="absolute z-20 flex w-64 flex-col gap-1.5 rounded-lg border bg-popover p-2 text-xs shadow-xl ring-1 ring-foreground/10"
      style={{ left: Math.max(8, draft.x + 12), top: Math.max(8, draft.y - 12) }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="text-micro text-muted-foreground">
        {draft.pin.partId ?? "model"} · {draft.pin.hint}
      </div>
      <input
        ref={ref}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") add()
          if (e.key === "Escape") onClose()
          e.stopPropagation()
        }}
        placeholder="What should change here?"
        className="h-7 border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring dark:bg-input/30"
      />
      <div className="flex justify-end gap-1.5">
        <button className="h-6 rounded-md px-2 text-muted-foreground hover:text-foreground" onClick={onClose}>
          Cancel
        </button>
        <button className="h-6 rounded-md bg-primary px-2.5 font-medium text-primary-foreground hover:bg-primary/80" onClick={add}>
          Add
        </button>
      </div>
    </div>
  )
}

/* ---------- toolbar button + P shortcut ---------- */

export function PointToolButton() {
  const on = useStudio((s) => s.pinMode)
  const setPinMode = useStudio((s) => s.setPinMode)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
      const t = e.target as HTMLElement | null
      if (t && t.closest("input, textarea, select, [contenteditable='true'], .monaco-editor")) return
      if (e.key === "p" || e.key === "P") setPinMode(!useStudio.getState().pinMode)
      if (e.key === "Escape" && useStudio.getState().pinMode) setPinMode(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [setPinMode])
  return (
    <button
      onClick={() => setPinMode(!on)}
      title="Point at the model to tell the designer what to change (P)"
      aria-label="Point tool"
      aria-pressed={on}
      className={cn(
        "flex h-6 items-center gap-1 rounded-sm px-1.5 text-caption text-muted-foreground hover:bg-muted hover:text-foreground",
        on && "bg-pin/20 text-pin",
      )}
    >
      <CrosshairIcon className="size-3.5" /> Point
    </button>
  )
}

/* ---------- capture of the current view (sent with pinned messages) ---------- */

/** Registers a function that renders the current frame and returns it as a JPEG (max 1280 px). */
export function CaptureRegistrar() {
  const gl = useThree((s) => s.gl)
  const get = useThree((s) => s.get)
  const setViewerCapture = useStudio((s) => s.setViewerCapture)
  const fn = useMemo(
    () => () => {
      try {
        const { scene, camera } = get()
        gl.render(scene, camera) // same task as toDataURL, so it works without preserveDrawingBuffer
        const src = gl.domElement
        const scale = Math.min(1, 1280 / Math.max(src.width, src.height))
        const c = document.createElement("canvas")
        c.width = Math.round(src.width * scale)
        c.height = Math.round(src.height * scale)
        const g = c.getContext("2d")!
        g.fillStyle = "#121418"
        g.fillRect(0, 0, c.width, c.height)
        g.drawImage(src, 0, 0, c.width, c.height)
        return c.toDataURL("image/jpeg", 0.85)
      } catch {
        return null
      }
    },
    [gl, get],
  )
  useEffect(() => {
    setViewerCapture(fn)
    return () => {
      if (useStudio.getState().viewerCapture === fn) setViewerCapture(null)
    }
  }, [fn, setViewerCapture])
  return null
}
