// Simple collision shapes for bought hardware (check_motion), sized from the same metadata as the real-size guide
// drawings (hardware.ts). Frame: standing upright on z = 0, centred on the Z axis; screws stand head-up.
import type Module from "manifold-3d"
import type { AssemblyHardware } from "../../shared/types"
import { headDims, insertDims, nutDims, offcutDims, washerDims } from "./hardware"
import { lengthOf, threadOf } from "./schema"

type Wasm = Awaited<ReturnType<typeof Module>>
type Manifold = InstanceType<Wasm["Manifold"]>

export type Proxy = { mesh: Manifold; shape: string } | { mesh: null; reason: string }

const SEG = 24

/** "6x3", "8 x 22 x 7", "10 × 3 mm" -> numbers. */
function sizeNums(h: AssemblyHardware): number[] {
  const m = h.size?.match(/(\d+(?:\.\d+)?)(?:\s*(?:mm)?\s*[x×]\s*(\d+(?:\.\d+)?))?(?:\s*(?:mm)?\s*[x×]\s*(\d+(?:\.\d+)?))?/)
  return m ? [m[1], m[2], m[3]].filter((x) => x !== undefined).map(Number) : []
}

export function hardwareProxy(w: Wasm, h: AssemblyHardware): Proxy {
  const M = w.Manifold
  const cyl = (height: number, d: number, z = 0) => M.cylinder(height, d / 2, d / 2, SEG).translate([0, 0, z])
  const ring = (height: number, od: number, id: number) => {
    const outer = cyl(height, od)
    if (!(id > 0 && id < od)) return outer
    const hole = M.cylinder(height + 2, id / 2, id / 2, SEG).translate([0, 0, -1])
    const r = outer.subtract(hole)
    outer.delete()
    hole.delete()
    return r
  }
  const union = (a: Manifold, b: Manifold) => {
    const r = a.add(b)
    a.delete()
    b.delete()
    return r
  }
  const box = (x: number, y: number, z: number) => M.cube([x, y, z], false).translate([-x / 2, -y / 2, 0])
  const none = (reason: string): Proxy => ({ mesh: null, reason })
  const d = threadOf(h)
  const L = lengthOf(h)
  const n = sizeNums(h)

  switch (h.type) {
    case "screw":
    case "bolt": {
      if (!d) return none('no thread size (give size like "M3x10")')
      const len = L ?? d * 3
      const head = h.head ?? (h.type === "bolt" ? "hex" : "socket")
      if (head === "grub") return { mesh: cyl(len, d), shape: `cylinder ${d} × ${len} mm` }
      const [D, k] = headDims(head, d)
      if (head === "countersunk") {
        // overall length includes the cone head
        const shank = cyl(Math.max(0.01, len - k), d)
        const cone = M.cylinder(k, d / 2, D / 2, SEG).translate([0, 0, len - k])
        return { mesh: union(shank, cone), shape: `M${d} × ${len} mm countersunk screw` }
      }
      return { mesh: union(cyl(len, d), cyl(k, D, len)), shape: `M${d} × ${len} mm screw (cylinder + head)` }
    }
    case "nut": {
      if (!d) return none('no thread size (give size like "M3")')
      const [s, m] = nutDims(d)
      return { mesh: ring(m, s / Math.cos(Math.PI / 6), d), shape: `M${d} nut` }
    }
    case "washer": {
      if (!d) return none('no thread size (give size like "M3")')
      const [id, od, t] = washerDims(d)
      return { mesh: ring(t, od, id), shape: `M${d} washer` }
    }
    case "heat-set-insert":
    case "threaded-insert": {
      if (!d) return none('no thread size (give size like "M3")')
      const [od, l] = insertDims(d)
      return { mesh: cyl(L ?? l, od), shape: `M${d} insert` }
    }
    case "standoff": {
      if (!d || !L) return none('no size (give size like "M3x10")')
      return { mesh: cyl(L, nutDims(d)[0] / Math.cos(Math.PI / 6)), shape: `M${d} × ${L} mm standoff` }
    }
    case "magnet": {
      const m = h.magnet
      if (m?.shape === "block" && m.lengthMm && m.widthMm) return { mesh: box(m.lengthMm, m.widthMm, m.thicknessMm), shape: "block magnet" }
      const dia = m?.diaMm ?? n[0]
      const t = m?.thicknessMm ?? n[1]
      if (!dia || !t) return none('no magnet size (give a magnet spec or size like "6x3")')
      return { mesh: cyl(t, dia), shape: `disc magnet ${dia} × ${t} mm` }
    }
    case "bearing": {
      const b = h.bearing
      if (b) return { mesh: ring(b.widthMm, b.outerDiaMm, b.boreMm), shape: `${b.designation} bearing ring` }
      if (n.length === 3) return { mesh: ring(n[2], n[1], n[0]), shape: "bearing ring" }
      return none("no bearing spec (bore, outer diameter, width)")
    }
    case "spring": {
      const s = h.spring
      if (!s) return none("no spring spec (wire, outer diameter, free length)")
      return { mesh: ring(s.freeLengthMm, s.outerDiaMm, s.outerDiaMm - 2 * s.wireDiaMm), shape: `spring at its free length ${s.freeLengthMm} mm` }
    }
    case "filament-offcut": {
      const [od, l] = offcutDims(h)
      return { mesh: cyl(l, od), shape: `${od} mm filament pin, ${l} mm` }
    }
    case "rod":
    case "dowel-pin":
    case "wall-anchor": {
      const dia = h.threadMm ?? n[0]
      const len = h.lengthMm ?? n[1]
      if (!dia || !len) return none('no size (give size like "3x20": diameter x length)')
      return { mesh: cyl(len, dia), shape: `cylinder ${dia} × ${len} mm` }
    }
    case "rubber-foot": {
      if (n.length < 2) return none('no size (give size like "10x3": diameter x height)')
      return { mesh: cyl(n[1], n[0]), shape: `foot ${n[0]} × ${n[1]} mm` }
    }
    case "o-ring": {
      const id = n[0] ?? h.threadMm
      const cs = n[1] ?? 1.5
      if (!id) return none('no size (give size like "10x1.5": inner diameter x thickness)')
      return { mesh: ring(cs, id + 2 * cs, id), shape: `O-ring ${id} mm` }
    }
    case "adhesive-strip": {
      if (n.length < 2) return none('no size (give size like "20x50": width x length)')
      return { mesh: box(n[1], n[0], 1), shape: `strip ${n[1]} × ${n[0]} mm` }
    }
    default:
      // Anything else (electronics, other...) can still be a box if its size is "LxWxH".
      if (n.length === 3) return { mesh: box(n[0], n[1], n[2]), shape: `box ${n[0]} × ${n[1]} × ${n[2]} mm` }
      return none(`no simple shape for ${h.type.replace(/-/g, " ")} (give size like "20x15x5" to check it as a box)`)
  }
}
