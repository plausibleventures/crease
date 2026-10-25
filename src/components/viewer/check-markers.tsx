// R23: spots a printability check points at (thin walls, features too thin to print), drawn on the model in the
// part view. Positions are part (STL) coordinates; the parent passes the offset the viewer applied to the mesh.
import * as THREE from "three"
import type { CheckMarker } from "@shared/types"

const COLOR: Record<string, string> = { fail: "#ef4444", warn: "#f59e0b", info: "#38bdf8", pass: "#22c55e" }

const texCache = new Map<string, THREE.CanvasTexture>()
function labelTexture(text: string, color: string) {
  const key = `${text}|${color}`
  let t = texCache.get(key)
  if (!t) {
    const c = document.createElement("canvas")
    c.width = 256
    c.height = 64
    const g = c.getContext("2d")!
    g.font = "600 34px 'Geist', ui-sans-serif, system-ui, sans-serif"
    const w = Math.min(248, g.measureText(text).width + 28)
    g.fillStyle = "rgba(0,0,0,0.85)"
    g.fillRect((256 - w) / 2, 6, w, 52)
    g.strokeStyle = color
    g.lineWidth = 4
    g.strokeRect((256 - w) / 2, 6, w, 52)
    g.fillStyle = "#ffffff"
    g.textAlign = "center"
    g.textBaseline = "middle"
    g.fillText(text, 128, 34)
    t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    texCache.set(key, t)
  }
  return t
}

export function CheckMarkers({ markers, localOffset }: { markers: CheckMarker[]; localOffset: THREE.Vector3 }) {
  return (
    <>
      {markers.map((m, i) => {
        const color = COLOR[m.severity] ?? COLOR.warn
        const pos = new THREE.Vector3(...m.at).add(localOffset)
        return (
          <group key={i} position={pos} name={`check-marker-${i}`}>
            <mesh renderOrder={996}>
              <sphereGeometry args={[0.9, 14, 14]} />
              <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.95} />
            </mesh>
            <sprite renderOrder={997} scale={[0.13, 0.0325, 1]} center={[0.5, -0.6]}>
              <spriteMaterial map={labelTexture(m.label, color)} sizeAttenuation={false} depthTest={false} transparent />
            </sprite>
          </group>
        )
      })}
    </>
  )
}
