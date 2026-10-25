// R14: the step illustration plan (server/assembly/illustrate.ts, AssemblyInfo.art) drawn in the 3D step-through:
// the same insertion arrows, callouts (leader lines to the actual instances, part letters) and glue regions as the
// printed guide, in assembly coordinates. Moving items' overlays follow the explode amount.
import { useMemo, type ReactNode } from "react"
import * as THREE from "three"
import { Html, Line } from "@react-three/drei"
import type { ArtArrow, ArtGlue, StepArt, Vec3 } from "@shared/types"
import { arcPoints } from "@shared/assembly-art"
import { cn } from "@/lib/utils"

const ARROW = "#ffd23f"
const GLUE = "#e0a000"
const NO_GLUE = "#ff5c7a"
const UP = new THREE.Vector3(0, 1, 0)

const v3 = (p: Vec3) => new THREE.Vector3(p[0], p[1], p[2])

/** Shaft + cone from `a` to `b`. */
function ArrowMesh({ a, b, opacity }: { a: THREE.Vector3; b: THREE.Vector3; opacity: number }) {
  const d = b.clone().sub(a)
  const L = d.length()
  if (L < 1e-3) return null
  const r = Math.min(2.4, Math.max(0.9, L * 0.05))
  const head = Math.min(L * 0.4, r * 5)
  const q = new THREE.Quaternion().setFromUnitVectors(UP, d.clone().normalize())
  const shaftMid = a.clone().add(d.clone().multiplyScalar((L - head) / 2 / L))
  const headMid = b.clone().sub(d.clone().normalize().multiplyScalar(head / 2))
  const mat = <meshBasicMaterial color={ARROW} transparent opacity={opacity} depthTest={false} />
  return (
    <group renderOrder={10}>
      <mesh position={shaftMid} quaternion={q} renderOrder={10}>
        <cylinderGeometry args={[r, r, Math.max(0.01, L - head), 12]} />
        {mat}
      </mesh>
      <mesh position={headMid} quaternion={q} renderOrder={10}>
        <coneGeometry args={[r * 2.3, head, 16]} />
        {mat}
      </mesh>
    </group>
  )
}

function ArcMesh({ r, shift, opacity }: { r: ArtArrow; shift: THREE.Vector3; opacity: number }) {
  const { geom, tip, prev } = useMemo(() => {
    const pts = arcPoints(r.center!, r.axis!, r.radius!).map((p) => v3(p))
    const curve = new THREE.CatmullRomCurve3(pts.slice(0, -2))
    const tube = Math.min(1.6, Math.max(0.4, r.radius! * 0.06))
    return { geom: new THREE.TubeGeometry(curve, 48, tube, 8, false), tip: pts[pts.length - 1], prev: pts[pts.length - 3] }
  }, [r])
  return (
    <group position={shift}>
      <mesh geometry={geom} renderOrder={10}>
        <meshBasicMaterial color={ARROW} transparent opacity={opacity} depthTest={false} />
      </mesh>
      <ArrowMesh a={prev} b={tip.clone().add(tip.clone().sub(prev).multiplyScalar(0.6))} opacity={opacity} />
    </group>
  )
}

function GlueBox({ g, shift }: { g: ArtGlue; shift: THREE.Vector3 }) {
  const size = g.max.map((v, i) => Math.max(0.8, v - g.min[i])) as Vec3
  const c = v3(g.min).add(v3(g.max)).multiplyScalar(0.5).add(shift)
  const color = g.kind === "glue" ? GLUE : NO_GLUE
  const edges = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(...size)), [size[0], size[1], size[2]]) // eslint-disable-line react-hooks/exhaustive-deps
  // the label sits where the printed step put it (clear of the other labels), relative to the box centre
  const label = g.labelAt ? v3(g.labelAt).add(shift).sub(c) : null
  return (
    <group position={c}>
      <mesh renderOrder={9}>
        <boxGeometry args={size} />
        <meshBasicMaterial color={color} transparent opacity={0.35} depthTest={false} />
      </mesh>
      <lineSegments geometry={edges} renderOrder={9}>
        <lineBasicMaterial color={color} depthTest={false} transparent />
      </lineSegments>
      {label && (
        <Line points={[new THREE.Vector3(), label]} color={color} lineWidth={1} transparent opacity={0.9} depthTest={false} renderOrder={11} />
      )}
      <Html position={label ?? undefined} center zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
        <span
          className={cn(
            "border bg-surface-1/90 px-1 text-micro whitespace-nowrap",
            g.kind === "glue" ? "border-warn text-warn" : "border-err text-err"
          )}
        >
          {g.kind === "glue" ? "GLUE" : "NO GLUE"}
          {g.label ? `: ${g.label}` : ""}
        </span>
      </Html>
    </group>
  )
}

/** A bought item as a simple shape: a cylinder along its long axis when its cross-section is round-ish, else a box. */
function HardwareShape({ inst, shift }: { inst: StepArt["instances"][number]; shift: THREE.Vector3 }) {
  const b = inst.box!
  const size = b.max.map((v, i) => Math.max(0.3, v - b.min[i]))
  const c = v3(b.min).add(v3(b.max)).multiplyScalar(0.5).add(shift)
  const order = [0, 1, 2].sort((p, q) => size[q] - size[p])
  const [l, m, s] = order.map((i) => size[i])
  const round = m / s < 1.35 && l / m > 1.6 // pin / rod / screw: long and round
  const disc = l / m < 1.35 && m / s > 1.6 // magnet / foot / washer: flat and round
  const color = inst.role === "done" ? "#5d636c" : "#b7bfca"
  let shape: ReactNode
  if (round || disc) {
    const axis = round ? order[0] : order[2]
    const rot: [number, number, number] = axis === 0 ? [0, 0, Math.PI / 2] : axis === 2 ? [Math.PI / 2, 0, 0] : [0, 0, 0]
    const r = round ? (m + s) / 4 : (l + m) / 4
    shape = (
      <mesh rotation={rot}>
        <cylinderGeometry args={[r, r, size[axis], 20]} />
        <meshStandardMaterial color={color} metalness={0.5} roughness={0.35} />
      </mesh>
    )
  } else
    shape = (
      <mesh>
        <boxGeometry args={size as [number, number, number]} />
        <meshStandardMaterial color={color} metalness={0.3} roughness={0.5} />
      </mesh>
    )
  return <group position={c}>{shape}</group>
}

export function StepArtOverlay({ art, explode }: { art: StepArt; explode: number }) {
  const offsets = useMemo(() => new Map(art.instances.map((i) => [i.key, v3(i.offset)])), [art])
  // overlays of moving items follow them; arrows fade as the items glide home
  const shiftOf = (key: string | undefined) => (key ? (offsets.get(key) ?? new THREE.Vector3()).clone().multiplyScalar(explode) : new THREE.Vector3())
  const arrowShift = (key: string) => (offsets.get(key) ?? new THREE.Vector3()).clone().multiplyScalar(explode - 1)
  const arrowOpacity = Math.max(0, Math.min(1, (explode - 0.15) / 0.6))
  return (
    <group>
      {art.instances
        .filter((x) => x.kind === "hardware" && x.box && x.role !== "hidden")
        .map((x) => (
          <HardwareShape key={x.key} inst={x} shift={shiftOf(x.key)} />
        ))}
      {arrowOpacity > 0.02 &&
        art.arrows.map((r, i) => {
          const s = arrowShift(r.targets[0])
          return (
            <group key={i}>
              {r.kind !== "twist" && <ArrowMesh a={v3(r.from).add(s)} b={v3(r.to).add(s)} opacity={arrowOpacity} />}
              {(r.kind === "twist" || r.kind === "screw") && r.axis && r.center && r.radius && <ArcMesh r={r} shift={s} opacity={arrowOpacity} />}
              {r.kind === "snap" && (
                <Html position={v3(r.to).add(s)} zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
                  <span className="ml-2 text-caption text-warn italic">click!</span>
                </Html>
              )}
            </group>
          )
        })}
      {art.glue.map((g, i) => (
        <GlueBox key={i} g={g} shift={shiftOf(g.ownerKey)} />
      ))}
      {art.callouts.map((c, i) => {
        const at = v3(c.labelAt)
        return (
          <group key={i}>
            {c.anchors.map((q, k) => (
              <Line
                key={k}
                points={[v3(q.point).add(shiftOf(q.key)), at]}
                color={c.tone === "new" ? "#e8e8ea" : "#8d929b"}
                lineWidth={1.2}
                transparent
                opacity={0.9}
                depthTest={false}
                renderOrder={11}
              />
            ))}
            <Html position={at} center zIndexRange={[30, 0]} style={{ pointerEvents: "none" }}>
              <span
                className={cn(
                  "flex items-center gap-1 border bg-background/90 py-0.5 pr-1.5 pl-0.5 text-caption whitespace-nowrap",
                  c.tone === "new" ? "text-foreground" : "text-muted-foreground"
                )}
                data-letters={c.letters ?? ""}
              >
                {(c.letters || c.qty) && (
                  <span className={cn("px-1 font-semibold", c.tone === "new" ? "bg-foreground text-background" : "border")}>
                    {c.letters ?? `${c.qty}×`}
                  </span>
                )}
                {c.label}
              </span>
            </Html>
          </group>
        )
      })}
    </group>
  )
}
