// Shared 3D viewer pieces: model parsing (3MF with colours / STL), filament colour mapping, the build
// plate, camera framing and a guard that keeps the canvas responsive across window blur/hide.
import { useEffect, useMemo, useRef, useState } from "react"
import * as THREE from "three"
import { useThree, type ThreeElements } from "@react-three/fiber"
import { Line } from "@react-three/drei"
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js"
import { ThreeMFLoader } from "three/examples/jsm/loaders/3MFLoader.js"
import type { FilamentSlot } from "@shared/types"
import { api } from "@/lib/api"
import { useStagePalette } from "@/lib/stage"
import { useUnits } from "@/lib/units"
import { fmtDims } from "@shared/length"
import { useStageInsets } from "@/lib/stage-insets"
import { filamentTone, paletteFor } from "@shared/filament-tones"

THREE.Object3D.DEFAULT_UP.set(0, 0, 1)

export type OrbitControlsImpl = { target: THREE.Vector3; update: () => void }

export const PLATE = 260 // mm, SPARKX i7 build plate
export const MARGIN = 5

export type View = "iso" | "front" | "top" | "right"
export const VIEW_DIRS: Record<View, [number, number, number]> = {
  iso: [0.346, -0.742, 0.574], // 3/4 view from above-front: the pictures' OpenSCAD iso (rotate [55, 0, 25])
  front: [0, -1, 0.0001],
  top: [0, -0.0001, 1],
  right: [1, 0, 0.0001],
}

export interface ModelPiece {
  geometry: THREE.BufferGeometry
  color: string | null // sRGB hex from the file's color(), null = uncoloured
}
export interface LoadedModel {
  pieces: ModelPiece[]
  box: THREE.Box3
  sphere: THREE.Sphere
  offset?: THREE.Vector3 // how far the geometry was shifted from part coordinates (centre on plate)
}

export const OPENSCAD_DEFAULT = "#f9d72c" // OpenSCAD's colour for geometry without color()
// Faces cut by an uncoloured difference() come out in the colour scheme's back-face colour (Cornfield).
const OPENSCAD_UNCOLOURED = new Set([OPENSCAD_DEFAULT, "#9dcb51"])

/** Parse a colour-preserving 3MF (one mesh per color()) or a plain STL into world-space pieces. */
export function parseModel(buf: ArrayBuffer, kind: "3mf" | "stl"): ModelPiece[] {
  if (kind === "stl") {
    const g = new STLLoader().parse(buf)
    return [{ geometry: g, color: null }]
  }
  const group = new ThreeMFLoader().parse(buf)
  group.updateMatrixWorld(true)
  const pieces: ModelPiece[] = []
  group.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld)
    const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshPhongMaterial
    const hex = mat?.color ? "#" + mat.color.getHexString() : null
    pieces.push({ geometry: g, color: hex && !OPENSCAD_UNCOLOURED.has(hex.toLowerCase()) ? hex : null })
  })
  return pieces
}

/* ---------- colours: color() / project colours -> loaded filament colours ---------- */

let filamentCache: Promise<FilamentSlot[]> | null = null
export function useFilaments() {
  const [f, setF] = useState<FilamentSlot[]>([])
  useEffect(() => {
    let alive = true
    filamentCache ??= api
      .getSettings()
      .then((s) => s.printer?.filaments ?? [])
      .catch(() => {
        filamentCache = null
        return []
      })
    void filamentCache.then((x) => alive && setF(x))
    return () => {
      alive = false
    }
  }, [])
  return f
}

let probe: CanvasRenderingContext2D | null = null
/** Any CSS colour (name, #hex, rgb()) -> "#rrggbb", or null if invalid. */
export function cssToHex(c: string): string | null {
  probe ??= document.createElement("canvas").getContext("2d")
  if (!probe || !CSS.supports("color", c)) return null
  probe.fillStyle = "#000000"
  probe.fillStyle = c
  const v = String(probe.fillStyle)
  return v.startsWith("#") ? v.toLowerCase() : null
}

/**
 * Display colour for a piece: match the design colour to a loaded filament (by name or hex) and use
 * the filament's real colour. Dark colours are not lightened (that turned black parts grey); PartMaterial
 * gives them their shape instead.
 */
export function displayColor(design: string | null, partColor: string | undefined, filaments: FilamentSlot[], seed?: string): string {
  const want = design ?? (partColor ? cssToHex(partColor) : null)
  let hex = want
  if (want) {
    const slot = filaments.find(
      (f) => f.colorHex?.toLowerCase() === want || cssToHex(f.colorName.replace(/\s+/g, "")) === want,
    )
    if (slot?.colorHex) hex = slot.colorHex
  }
  // filament tones (shared/filament-tones.ts; the server draws part pictures the same way, server/cad/preview.ts).
  // A part with no colour shows the filament it prints in (the first loaded), so the picture never promises a colour
  // the print won't have; with no printer known, a PLA colour picked per part.
  const printsIn = filaments.find((f) => f.loaded)?.colorHex ?? null
  hex = hex ? filamentTone(hex) : printsIn ? printsIn : seed ? paletteFor(seed) : null
  return "#" + new THREE.Color(hex ?? "#cfd3da").getHexString()
}

/**
 * Light through coloured plastic: a soft rim light from behind, in the part's most colourful tone, so the colour
 * glows at the edges and spills a little onto the stage. Nothing for grey, white or black parts.
 */
export function FilamentRim({ colors }: { colors: string[] }) {
  const tint = useMemo(() => {
    let best: { c: string; s: number } | null = null
    for (const c of colors) {
      const hsl = new THREE.Color(c).getHSL({ h: 0, s: 0, l: 0 })
      const s = hsl.s * (1 - Math.abs(hsl.l - 0.5) * 2)
      if (s > 0.15 && (!best || s > best.s)) best = { c, s }
    }
    return best?.c ?? null
  }, [colors])
  if (!tint) return null
  return (
    <>
      <directionalLight position={[-260, 320, 140]} intensity={1.6} color={tint} />
      <pointLight position={[0, 0, -40]} intensity={0.6} distance={600} decay={0} color={tint} />
    </>
  )
}

/** Colours below this HSL lightness are dark plastic (see darkLook); from here up, plain matte. */
const DARK_UNTIL = 0.3
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * How a dark colour (black, charcoal, navy, dark brown...) is drawn so it reads as that colour on the grey stage, or
 * null for every other colour (plain matte plastic). Lit by the stage lights, a dark colour comes out a grey or two
 * lighter than it is, so black looked like grey plastic: the surface colour is pushed down (greys most, saturated
 * colours less) and the part gets a satin finish that reflects a dark studio (studioScene), so faces and edges read from
 * highlights instead. Everything eases out by DARK_UNTIL, so there's no jump between neighbouring colours.
 */
export function darkLook(color: THREE.ColorRepresentation): { color: THREE.Color; roughness: number; envMapIntensity: number } | null {
  const c = new THREE.Color(color)
  const hsl = { h: 0, s: 0, l: 0 }
  c.getHSL(hsl)
  if (hsl.l >= DARK_UNTIL) return null
  const t = smooth(0.12, DARK_UNTIL, hsl.l) // 0 = black ... 1 = an ordinary colour
  const keep = Math.min(1, 0.3 + 0.35 * hsl.s + 0.7 * t)
  return {
    color: c.setHSL(hsl.h, hsl.s, Math.max(0.02, hsl.l * keep)),
    roughness: 0.3 + 0.3 * t,
    envMapIntensity: 1 - t,
  }
}

/**
 * A dark photo studio for dark parts to reflect (world is Z-up): a soft box overhead, a strip at the front-right
 * where the key light is, a thin rim strip behind and a dim one low in front. Black plastic mostly reflects the dark
 * room, so it stays black, while its top faces, rounded edges and front faces catch the boxes at different strengths.
 */
function studioScene(): THREE.Scene {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x000000)
  const box = (w: number, h: number, pos: [number, number, number], power: number) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 1).multiplyScalar(power), side: THREE.DoubleSide }),
    )
    m.position.set(...pos)
    m.lookAt(0, 0, 0)
    scene.add(m)
  }
  box(8, 8, [0, 0, 6], 3) // overhead
  box(3, 8, [5, -6, 3], 4) // front-right strip
  box(2, 8, [-5, 6, 2], 5) // back-left rim
  box(10, 3, [-3, -6, -1], 0.8) // low in front
  return scene
}

// One studio reflection map per renderer (made on first use, kept for the canvas's life).
const envMaps = new WeakMap<THREE.WebGLRenderer, THREE.Texture>()
function useStudioEnv(): THREE.Texture {
  const gl = useThree((s) => s.gl)
  let tex = envMaps.get(gl)
  if (!tex) {
    const pm = new THREE.PMREMGenerator(gl)
    const scene = studioScene()
    tex = pm.fromScene(scene, 0.02).texture
    pm.dispose()
    scene.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) {
        m.geometry.dispose()
        ;(m.material as THREE.Material).dispose()
      }
    })
    envMaps.set(gl, tex)
  }
  return tex
}

/** A printed part's surface: matte plastic, or for dark colours the darkLook satin finish. */
export function PartMaterial({
  color,
  ...rest
}: { color: THREE.ColorRepresentation } & Omit<ThreeElements["meshStandardMaterial"], "color">) {
  const env = useStudioEnv()
  const key = new THREE.Color(color).getHex()
  const dark = useMemo(() => darkLook(key), [key])
  if (!dark) return <meshStandardMaterial color={color} metalness={0.05} roughness={0.6} {...rest} />
  return (
    <meshPhysicalMaterial
      color={dark.color}
      metalness={0}
      roughness={dark.roughness}
      envMap={env}
      envMapIntensity={dark.envMapIntensity}
      {...rest}
    />
  )
}

/** The bed, centred on the origin; front edge at -Y (marked). `size` = bed width/depth in mm (default the i7's 260). */
export function BuildPlate({ over, size = PLATE }: { over: boolean; size?: number }) {
  const pal = useStagePalette()
  const units = useUnits((s) => s.units)
  const { minor, major } = useMemo(() => {
    const h = size / 2
    const minorPts: number[] = []
    const majorPts: number[] = []
    // the grid in the user's unit: 10 mm squares, every 5th darker; inches: 1/2" squares, every 2" darker
    const [cell, every] = units === "in" ? [12.7, 4] : [10, 5]
    const line = (v: number, majorLine: boolean) => (majorLine ? majorPts : minorPts).push(v, -h, 0.02, v, h, 0.02, -h, v, 0.02, h, v, 0.02)
    if (units === "in") {
      // from the centre out, so whole inches line up with the middle of the plate
      for (let i = 0; i * cell <= h + 0.001; i++) {
        line(i * cell, i % every === 0)
        if (i) line(-i * cell, i % every === 0)
      }
    } else
      for (let v = -h; v <= h + 0.001; v += cell) {
        line(v, Math.abs(v % (cell * every)) < 0.001)
      }
    const mk = (pts: number[]) => {
      const g = new THREE.BufferGeometry()
      g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3))
      return g
    }
    return { minor: mk(minorPts), major: mk(majorPts) }
  }, [size, units])
  const h = size / 2
  const m = h - MARGIN
  const edge = over ? "#ff5c7a" : pal.edge // hairline plate outline; coral when the part is too big
  const rect = (r: number, z: number): [number, number, number][] => [
    [-r, -r, z],
    [r, -r, z],
    [r, r, z],
    [-r, r, z],
    [-r, -r, z],
  ]
  return (
    <group>
      {/* the plate itself: a solid slab, set off from the stage so its extent reads at a glance */}
      <mesh position={[0, 0, -1.5]}>
        <boxGeometry args={[size, size, 3]} />
        <meshStandardMaterial color={pal.plate} roughness={0.95} metalness={0} />
      </mesh>
      <lineSegments geometry={minor}>
        <lineBasicMaterial color={pal.gridMinor} />
      </lineSegments>
      <lineSegments geometry={major}>
        <lineBasicMaterial color={pal.gridMajor} />
      </lineSegments>
      <Line points={rect(h, 0.05)} color={edge} lineWidth={1.5} />
      <Line points={rect(h, -3)} color={edge} lineWidth={1} transparent opacity={0.5} />
      <Line points={rect(m, 0.04)} color={pal.margin} lineWidth={1} dashed dashSize={4} gapSize={3} />
      {/* front marker */}
      <Line
        points={[
          [-25, -h - 8, 0],
          [25, -h - 8, 0],
        ]}
        color={edge}
        lineWidth={3}
      />
{/* label drawn on the plate surface (a canvas texture; drei <Html> broke React's DOM on unmount) */}
      <PlateLabel text={`${fmtDims([size, size], units)} plate · front`} x={-h} y={-h - 4} color={pal.label} />
    </group>
  )
}

function PlateLabel({ text, x, y, color }: { text: string; x: number; y: number; color: string }) {
  const { tex, w, hgt } = useMemo(() => {
    const c = document.createElement("canvas")
    const px = 48
    const ctx = c.getContext("2d")!
    ctx.font = `${px}px "Geist", ui-sans-serif, system-ui, sans-serif`
    c.width = Math.ceil(ctx.measureText(text).width) + 8
    c.height = Math.ceil(px * 1.3)
    ctx.font = `${px}px "Geist", ui-sans-serif, system-ui, sans-serif`
    ctx.fillStyle = color
    ctx.textBaseline = "middle"
    ctx.fillText(text, 4, c.height / 2)
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = 4
    const hgt = 7 // mm on the plate
    return { tex, w: (c.width / c.height) * hgt, hgt }
  }, [text, color])
  useEffect(() => () => tex.dispose(), [tex])
  return (
    <mesh position={[x + w / 2, y - hgt / 2, 0.06]}>
      <planeGeometry args={[w, hgt]} />
      <meshBasicMaterial map={tex} transparent depthWrite={false} />
    </mesh>
  )
}

export type Fit = "part" | "plate"

export function CameraRig({
  view,
  fit,
  nonce,
  bounds,
  yaw,
  viewDir,
}: {
  view: View
  fit: Fit
  nonce: number
  bounds: { box: THREE.Box3; sphere: THREE.Sphere } | null
  yaw: number // radians; rotates the view directions so "front" is the part's detected front
  viewDir?: [number, number, number] // explicit eye direction (overrides view + yaw), e.g. a guide step's camera
}) {
  const get = useThree((s) => s.get)
  const controlsReady = useThree((s) => !!s.controls)
  const stageInsets = useStageInsets()
  useEffect(() => {
    const camera = get().camera as THREE.PerspectiveCamera
    const controls = get().controls as unknown as OrbitControlsImpl | null
    if (!controls) return
    let center: THREE.Vector3
    let r: number
    if (fit === "plate" || !bounds) {
      const zTop = bounds?.box.max.z ?? 0
      center = new THREE.Vector3(0, 0, Math.min(zTop / 2, PLATE / 2))
      r = Math.max(Math.SQRT2 * (PLATE / 2), bounds?.sphere.radius ?? 0) * 0.92
    } else {
      // framed to the part, with a little margin so some plate shows around it
      center = bounds.sphere.center.clone()
      r = Math.max(bounds.sphere.radius * 1.12, 40)
    }
    const fov = ((camera.fov ?? 35) * Math.PI) / 180
    let dist = (r / Math.sin(fov / 2)) * 1.05
    // the canvas may span the window (the workspace), but only the gap between the floating panels shows the part
    const { width: W, height: H } = get().size
    const gw = W - stageInsets.l - stageInsets.r
    const gh = H - stageInsets.t - stageInsets.b
    if (gw > 0 && gh > 0 && (gw < W || gh < H)) {
      const hfov = 2 * Math.atan(Math.tan(fov / 2) * (W / H))
      dist = Math.max(dist * (H / gh), (r / Math.sin(hfov / 2)) * 1.05 * (W / gw))
    }
    const dir = (viewDir ? new THREE.Vector3(...viewDir) : new THREE.Vector3(...VIEW_DIRS[view]).applyAxisAngle(new THREE.Vector3(0, 0, 1), yaw)).normalize()
    camera.position.copy(center.clone().add(dir.multiplyScalar(dist)))
    camera.near = Math.max(0.1, dist / 100)
    camera.far = dist * 20 + PLATE * 4
    camera.updateProjectionMatrix()
    controls.target.copy(center)
    controls.update()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, controlsReady])

  // When the visible gap changes (the tools open or close, a panel is resized), move the camera in or out along its
  // current direction so the part keeps its size in the gap; the user's orbit is kept.
  const size = useThree((s) => s.size)
  const prevSpan = useRef<number | null>(null)
  useEffect(() => {
    const { width: W, height: H } = size
    const gw = W - stageInsets.l - stageInsets.r
    const gh = H - stageInsets.t - stageInsets.b
    if (gw <= 0 || gh <= 0) return
    // the same rule as the framing above: whichever of the gap's height or width limits the part
    const fov = (((get().camera as THREE.PerspectiveCamera).fov ?? 35) * Math.PI) / 180
    const hfov = 2 * Math.atan(Math.tan(fov / 2) * (W / H))
    const span = Math.max(H / gh, ((W / gw) * Math.sin(fov / 2)) / Math.sin(hfov / 2))
    const prev = prevSpan.current
    prevSpan.current = span
    const controls = get().controls as unknown as OrbitControlsImpl | null
    if (prev == null || !controls || Math.abs(span / prev - 1) < 0.01) return
    const camera = get().camera
    camera.position.sub(controls.target).multiplyScalar(span / prev).add(controls.target)
    controls.update()
    get().invalidate()
  }, [stageInsets, size, get])
  return null
}


/* ---------- raw (un-centred) model fetch with a cache, for assembly scenes ---------- */

const rawCache = new Map<string, Promise<ModelPiece[]>>()
/** Pieces in the part's own coordinates (placements apply to these). Cached by URL; never mutate them. */
export function loadRawModel(url: string): Promise<ModelPiece[]> {
  let p = rawCache.get(url)
  if (!p) {
    const kind: "3mf" | "stl" = /\.3mf(\?|$)/i.test(url) ? "3mf" : "stl"
    p = fetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
        const pieces = parseModel(await res.arrayBuffer(), kind)
        for (const pc of pieces) {
          pc.geometry.computeVertexNormals()
          pc.geometry.computeBoundingBox()
        }
        return pieces
      })
      .catch((e) => {
        rawCache.delete(url)
        throw e
      })
    rawCache.set(url, p)
  }
  return p
}

/**
 * Keeps the canvas healthy when the window is hidden, minimised or loses focus:
 *  - a drag that ends outside the window (or while hidden) never delivers pointerup, which leaves
 *    OrbitControls thinking a button is still held, so the next click rotates/pans wrongly ("stuck");
 *    we cancel any tracked pointer on blur/hide;
 *  - on return we force a fresh frame (rAF is paused while hidden; demand-driven parts need a kick).
 */
export function CanvasGuard() {
  const gl = useThree((s) => s.gl)
  const invalidate = useThree((s) => s.invalidate)
  const get = useThree((s) => s.get)
  useEffect(() => {
    const el = gl.domElement
    const cancelPointers = () => {
      const controls = get().controls as unknown as { domElement?: HTMLElement } | null
      const target = controls?.domElement ?? el
      // the mouse is pointerId 1 in Chromium/Electron
      try {
        target.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1, pointerType: "mouse", bubbles: true }))
      } catch {
        /* ignore */
      }
    }
    const wake = () => {
      invalidate()
      requestAnimationFrame(() => invalidate())
    }
    const onVis = () => (document.hidden ? cancelPointers() : wake())
    const onLost = (e: Event) => e.preventDefault() // allow the context to be restored
    window.addEventListener("blur", cancelPointers)
    window.addEventListener("focus", wake)
    document.addEventListener("visibilitychange", onVis)
    el.addEventListener("webglcontextlost", onLost)
    el.addEventListener("webglcontextrestored", wake)
    return () => {
      window.removeEventListener("blur", cancelPointers)
      window.removeEventListener("focus", wake)
      document.removeEventListener("visibilitychange", onVis)
      el.removeEventListener("webglcontextlost", onLost)
      el.removeEventListener("webglcontextrestored", wake)
    }
  }, [gl, invalidate, get])
  return null
}

/**
 * The workspace canvas spans the whole window under floating panels (src/lib/stage-insets.ts). Shift the projection so
 * the orbit centre sits in the middle of the visible gap (a view offset, so framing and orbiting are unchanged).
 * A no-op where nothing floats over the canvas.
 */
export function StageShift() {
  const ins = useStageInsets()
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera
    const dx = (ins.l - ins.r) / 2
    const dy = (ins.t - ins.b) / 2
    if (!dx && !dy) cam.clearViewOffset()
    else cam.setViewOffset(size.width, size.height, -dx, -dy, size.width, size.height)
    invalidate()
  }, [camera, size.width, size.height, ins, invalidate])
  return null
}

/** The axis gizmo's margin: out from under the floating chat and bottom chrome when the stage bleeds. */
export function useGizmoMargin(): [number, number] {
  const ins = useStageInsets()
  return [56 + ins.r, 56 + ins.b]
}
