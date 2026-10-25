// Layers › 3D: the whole sliced plate's toolpath in 3D (like OrcaSlicer's preview). Extrusions coloured by feature
// (or by filament), travel moves optional, the layer slider as a height cut (layers above hidden, the current one
// at full colour, the rest faded a little). Orbit / pan / zoom (to the cursor) with mouse or trackpad.
// Data: one binary fetch of the plate (shared/toolpath.ts), decoded without copies into instanced GPU buffers.
import { useEffect, useMemo, useState } from "react"
import * as THREE from "three"
import { Canvas, useThree } from "@react-three/fiber"
import { GizmoHelper, GizmoViewport, OrbitControls } from "@react-three/drei"
import { decodeToolpath, type DecodedToolpath } from "@shared/toolpath"
import { BuildPlate, CameraRig, CanvasGuard, type OrbitControlsImpl, type View } from "@/components/viewer/shared"
import { useStagePalette } from "@/lib/stage"
import { colourOf } from "@/components/layers/colours"
import { buildToolpathScene, layerBox, makeUniforms, setCut, type ToolpathScene } from "@/components/layers/toolpath-geometry"

export interface ToolpathTimings {
  serverMs: number | null // server parse + encode (0-ish when cached)
  fetchMs: number // request → bytes in hand (includes serverMs)
  decodeMs: number
  buildMs: number // GPU objects (first draw uploads the buffers)
  bytes: number
}

/** Fetch + decode the plate's toolpath once per G-code file (the caller keys it by file + re-slice stamp). */
export function useToolpath(projectId: string, gcode: string, enabled: boolean) {
  const [state, setState] = useState<{ tp: DecodedToolpath; timings: Omit<ToolpathTimings, "buildMs"> } | { error: string } | null>(null)
  useEffect(() => {
    if (!enabled || state) return
    const ctrl = new AbortController()
    const t0 = performance.now()
    fetch(`/api/projects/${encodeURIComponent(projectId)}/slice-preview/toolpath?gcode=${encodeURIComponent(gcode)}`, { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
        const buf = await res.arrayBuffer()
        const t1 = performance.now()
        const tp = decodeToolpath(buf)
        const t2 = performance.now()
        const server = Number(res.headers.get("x-build-ms"))
        setState({ tp, timings: { serverMs: Number.isFinite(server) ? server : null, fetchMs: t1 - t0, decodeMs: t2 - t1, bytes: buf.byteLength } })
      })
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setState({ error: (e as Error).message })
      })
    return () => ctrl.abort()
  }, [projectId, gcode, enabled, state])
  return state
}

export type ColourBy = "feature" | "filament"

/** A camera request: preset view (or keep the current direction), framed to the whole toolpath or one layer. */
export interface FrameRequest {
  nonce: number
  view: View | null // null = keep the current viewing direction
  layer: number | null // null = the whole toolpath
}

export function toolColour(tp: DecodedToolpath, tool: number): string {
  return tp.header.toolColours[tool] ?? ["#f5f5f5", "#1a1a1a", "#d32f2f", "#1e5bd8"][tool % 4]
}

/** Filament colours as drawn: very dark ones lifted on the dark stage, very light ones dimmed on the light stage. */
function drawnToolColour(hex: string, light: boolean): THREE.Color {
  const c = new THREE.Color(hex)
  const hsl = { h: 0, s: 0, l: 0 }
  c.getHSL(hsl, THREE.SRGBColorSpace) // judge lightness as seen, not in linear light
  if (!light && hsl.l < 0.22) c.setHSL(hsl.h, hsl.s, 0.22, THREE.SRGBColorSpace)
  if (light && hsl.l > 0.68) c.setHSL(hsl.h, hsl.s, 0.68, THREE.SRGBColorSpace)
  return c
}

export function Toolpath3D({
  tp,
  cut,
  from,
  hiddenFeatures,
  hiddenTools,
  colourBy,
  travel,
  light,
  frame,
  onBuilt,
}: {
  tp: DecodedToolpath
  cut: number
  from: number
  hiddenFeatures: Set<string>
  hiddenTools: Set<number>
  colourBy: ColourBy
  travel: boolean
  light: boolean
  frame: FrameRequest
  onBuilt?: (ms: number) => void
}) {
  const pal = useStagePalette()
  const [bw, bd] = tp.header.bed
  return (
    <Canvas
      frameloop="demand"
      dpr={[1, 2]}
      camera={{ position: [250, -300, 220], fov: 35, near: 1, far: 5000, up: [0, 0, 1] }}
      gl={{ antialias: true, preserveDrawingBuffer: false }}
      fallback={<div className="p-4 text-caption text-muted-foreground">3D needs WebGL. Switch to Layer.</div>}
      aria-label="3D toolpath of the sliced plate"
    >
      <CanvasGuard />
      <ambientLight intensity={0.35} />
      <hemisphereLight args={["#ffffff", "#3b4758", 1.1]} />
      <directionalLight position={[200, -300, 400]} intensity={1.9} />
      <BuildPlate over={false} size={Math.max(bw, bd)} />
      <group position={[-bw / 2, -bd / 2, 0]}>
        <Paths
          tp={tp}
          cut={cut}
          from={from}
          hiddenFeatures={hiddenFeatures}
          hiddenTools={hiddenTools}
          colourBy={colourBy}
          travel={travel}
          light={light}
          stage={pal.bg}
          onBuilt={onBuilt}
        />
      </group>
      {/* never orbit under the plate (as the Model view) */}
      <OrbitControls makeDefault enableDamping dampingFactor={0.12} maxPolarAngle={Math.PI * 0.53} zoomToCursor />
      <Rig tp={tp} frame={frame} />
      <GizmoHelper alignment="bottom-right" margin={[56, 56]}>
        <GizmoViewport axisColors={["#ef4444", "#22c55e", "#3b82f6"]} labelColor="#fff" />
      </GizmoHelper>
    </Canvas>
  )
}

function Paths({
  tp,
  cut,
  from,
  hiddenFeatures,
  hiddenTools,
  colourBy,
  travel,
  light,
  stage,
  onBuilt,
}: {
  tp: DecodedToolpath
  cut: number
  from: number
  hiddenFeatures: Set<string>
  hiddenTools: Set<number>
  colourBy: ColourBy
  travel: boolean
  light: boolean
  stage: string
  onBuilt?: (ms: number) => void
}) {
  const invalidate = useThree((s) => s.invalidate)
  const uniforms = useMemo(() => makeUniforms(), [])
  const scene = useMemo<ToolpathScene>(() => buildToolpathScene(tp, uniforms), [tp, uniforms])
  useEffect(() => {
    const t0 = performance.now()
    // the first frame uploads the instance buffers; report build + upload once it has drawn
    requestAnimationFrame(() => requestAnimationFrame(() => onBuilt?.(performance.now() - t0)))
    return () => scene.dispose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene])

  const top = tp.header.layers.length - 1
  useEffect(() => {
    setCut(scene, tp.data, uniforms, from, cut, top)
    invalidate()
  }, [scene, tp, uniforms, from, cut, top, invalidate])

  useEffect(() => {
    uniforms.uStage.value.set(stage)
    for (const d of scene.draws)
      (d.material.uniforms.uColor.value as THREE.Color).copy(
        colourBy === "filament" ? drawnToolColour(toolColour(tp, d.group.tool), light) : new THREE.Color(colourOf(d.group.feature, light)),
      )
    if (scene.travel) (scene.travel.material.uniforms.uColor.value as THREE.Color).set(light ? "#3a7bd5" : "#5aa9ff")
    invalidate()
  }, [scene, tp, uniforms, colourBy, light, stage, invalidate])

  return (
    <>
      {scene.draws.map((d, i) => (
        <mesh
          key={i}
          geometry={d.geometry}
          material={d.material}
          frustumCulled={false}
          visible={!hiddenFeatures.has(d.group.feature) && !hiddenTools.has(d.group.tool)}
        />
      ))}
      {scene.travel && travel && <lineSegments geometry={scene.travel.geometry} material={scene.travel.material} frustumCulled={false} />}
    </>
  )
}

/** Frames the camera on request: a preset view or the current direction; the whole toolpath or one layer. */
function Rig({ tp, frame }: { tp: DecodedToolpath; frame: FrameRequest }) {
  const get = useThree((s) => s.get)
  const [bw, bd] = tp.header.bed
  const { bounds, viewDir } = useMemo(() => {
    const shift = new THREE.Vector3(-bw / 2, -bd / 2, 0)
    let box = frame.layer != null ? layerBox(tp, frame.layer) : null
    if (!box) {
      box = new THREE.Box3()
      for (const l of tp.header.layers)
        if (l.bbox) {
          box.expandByPoint(new THREE.Vector3(l.bbox[0], l.bbox[1], 0))
          box.expandByPoint(new THREE.Vector3(l.bbox[2], l.bbox[3], l.z))
        }
      if (box.isEmpty()) box.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(bw, bd, 1))
    }
    box.translate(shift)
    let dir: [number, number, number] | undefined
    if (frame.view == null) {
      const { camera, controls } = get()
      const target = (controls as unknown as OrbitControlsImpl | null)?.target
      if (target) {
        const d = camera.position.clone().sub(target).normalize()
        dir = [d.x, d.y, d.z]
      }
    }
    // CameraRig fits the sphere to the vertical field of view; in a tall, narrow pane fit the width instead
    const { width, height } = get().size
    const sphere = box.getBoundingSphere(new THREE.Sphere())
    if (width > 0 && height > width) sphere.radius *= height / width
    return { bounds: { box, sphere }, viewDir: dir }
    // recomputed per request only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame.nonce, tp])
  return <CameraRig view={frame.view ?? "iso"} fit="part" nonce={frame.nonce} bounds={bounds} yaw={0} viewDir={viewDir} />
}
