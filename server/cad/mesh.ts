// STL parsing, mesh stats (manifold-3d WASM) and printability checks.
import Module from "manifold-3d"
import type { CheckItem, CheckSeverity, MeshStats, OrientationAdvice } from "../../shared/types"
import { describePoint, thinMarkers, type ThicknessReport } from "./thickness"

type Wasm = Awaited<ReturnType<typeof Module>>
let wasmP: Promise<Wasm> | null = null
function wasm(): Promise<Wasm> {
  wasmP ??= Module().then((w) => {
    w.setup()
    return w
  })
  return wasmP
}

export interface IndexedMesh {
  verts: Float64Array // xyz per vertex (deduplicated)
  tris: Uint32Array // 3 indices per triangle
}

/** Parse ASCII or binary STL into an indexed mesh with exact-duplicate vertices merged. */
export function parseStl(buf: Buffer): IndexedMesh {
  const raw: number[] = []
  // Binary STL size is exactly 84 + 50*n; ASCII files (even ones starting "solid") essentially never match.
  const isBinary = buf.length >= 84 && 84 + buf.readUInt32LE(80) * 50 === buf.length
  if (isBinary) {
    const n = buf.readUInt32LE(80)
    for (let i = 0; i < n; i++) {
      const o = 84 + i * 50 + 12
      for (let k = 0; k < 9; k++) raw.push(buf.readFloatLE(o + k * 4))
    }
  } else {
    const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g
    const text = buf.toString("utf8")
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) raw.push(Number(m[1]), Number(m[2]), Number(m[3]))
  }
  const index = new Map<string, number>()
  const verts: number[] = []
  const tris = new Uint32Array(raw.length / 3)
  for (let i = 0; i < raw.length; i += 3) {
    const key = `${raw[i]},${raw[i + 1]},${raw[i + 2]}`
    let idx = index.get(key)
    if (idx === undefined) {
      idx = verts.length / 3
      index.set(key, idx)
      verts.push(raw[i], raw[i + 1], raw[i + 2])
    }
    tris[i / 3] = idx
  }
  return { verts: Float64Array.from(verts), tris }
}

/** Connected components by shared vertices (works even when the mesh isn't manifold). */
function countBodies(mesh: IndexedMesh): number {
  const nv = mesh.verts.length / 3
  const parent = new Int32Array(nv).map((_, i) => i)
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]]
    return x
  }
  const used = new Uint8Array(nv)
  for (let t = 0; t < mesh.tris.length; t += 3) {
    const [a, b, c] = [mesh.tris[t], mesh.tris[t + 1], mesh.tris[t + 2]]
    used[a] = used[b] = used[c] = 1
    parent[find(a)] = find(b)
    parent[find(b)] = find(c)
  }
  const roots = new Set<number>()
  for (let i = 0; i < nv; i++) if (used[i]) roots.add(find(i))
  return roots.size
}

export interface MeshAnalysis {
  stats: MeshStats
  firstLayerAreaMm2: number
  surfaceAreaMm2: number
  overhangAreaMm2: number
  overhangZ: [number, number] | null
  manifoldError: string | null
}

export async function analyzeStl(buf: Buffer): Promise<MeshAnalysis> {
  const mesh = parseStl(buf)
  const { verts, tris } = mesh
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < verts.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], verts[i + k])
      max[k] = Math.max(max[k], verts[i + k])
    }
  }
  const triangles = tris.length / 3
  if (triangles === 0) {
    return {
      stats: { bbox: { min: [0, 0, 0], max: [0, 0, 0] }, sizeMm: [0, 0, 0], volumeMm3: 0, triangles: 0, bodies: 0, manifold: false },
      firstLayerAreaMm2: 0,
      surfaceAreaMm2: 0,
      overhangAreaMm2: 0,
      overhangZ: null,
      manifoldError: "empty mesh",
    }
  }

  // Per-face geometry: area, downward faces at the bed, overhangs.
  const zTol = 0.01
  const overhangNz = -Math.sin(Math.PI / 4) // normal more than 45 deg below horizontal => face >45 deg from vertical
  let surface = 0
  let firstLayer = 0
  let overhang = 0
  let ohMin = Infinity
  let ohMax = -Infinity
  let signedVol = 0
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3
    const b = tris[t + 1] * 3
    const c = tris[t + 2] * 3
    const ux = verts[b] - verts[a], uy = verts[b + 1] - verts[a + 1], uz = verts[b + 2] - verts[a + 2]
    const vx = verts[c] - verts[a], vy = verts[c + 1] - verts[a + 1], vz = verts[c + 2] - verts[a + 2]
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz)
    if (len === 0) continue
    const area = len / 2
    surface += area
    signedVol +=
      (verts[a] * (verts[b + 1] * verts[c + 2] - verts[b + 2] * verts[c + 1]) -
        verts[a + 1] * (verts[b] * verts[c + 2] - verts[b + 2] * verts[c]) +
        verts[a + 2] * (verts[b] * verts[c + 1] - verts[b + 1] * verts[c])) /
      6
    const unz = nz / len
    const zMax = Math.max(verts[a + 2], verts[b + 2], verts[c + 2])
    const onBed = zMax <= min[2] + zTol
    if (onBed && unz < -0.99) firstLayer += area
    else if (!onBed && unz < overhangNz) {
      overhang += area
      const zMin = Math.min(verts[a + 2], verts[b + 2], verts[c + 2])
      ohMin = Math.min(ohMin, zMin)
      ohMax = Math.max(ohMax, zMax)
    }
  }

  let manifold = false
  let manifoldError: string | null = null
  let volume = Math.abs(signedVol)
  let bodies = countBodies(mesh)
  const w = await wasm()
  try {
    const m = new w.Manifold(
      new w.Mesh({ numProp: 3, vertProperties: Float32Array.from(verts), triVerts: Uint32Array.from(tris) }),
    )
    const status = m.status()
    if (status === "NoError") {
      manifold = true
      volume = m.volume()
      const parts = m.decompose()
      bodies = parts.length
      for (const p of parts) p.delete()
    } else manifoldError = String(status)
    m.delete()
  } catch (e) {
    manifoldError = (e as Error).message
  }

  return {
    stats: {
      bbox: { min, max },
      sizeMm: [max[0] - min[0], max[1] - min[1], max[2] - min[2]].map((v) => round(v, 3)) as [number, number, number],
      volumeMm3: round(volume, 2),
      triangles,
      bodies,
      manifold,
    },
    firstLayerAreaMm2: round(firstLayer, 2),
    surfaceAreaMm2: round(surface, 2),
    overhangAreaMm2: round(overhang, 2),
    overhangZ: overhang > 0 ? [round(ohMin, 2), round(ohMax, 2)] : null,
    manifoldError,
  }
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d

// Thresholds (SPEC section 5). Kept in one place so they can be tuned.
export const CHECK_RULES = {
  bedMarginMm: 5,
  firstLayerMinShare: 0.01,
  firstLayerMinMm2: 50,
  overhangMaxShare: 0.05,
  tallThinRatio: 4,
  plaDensityGcm3: 1.24,
}

export interface CheckContext {
  buildVolumeMm: [number, number, number]
  filamentSlots: number
  declaredBodies: number
  colorCount: number
  nozzleMm?: number
  thickness?: ThicknessReport // R23 thin walls (measureThinWalls)
  orientation?: OrientationAdvice // R23 how to lay it on the bed (adviseOrientation)
}

export function runChecks(a: MeshAnalysis, ctx: CheckContext): CheckItem[] {
  const R = CHECK_RULES
  const s = a.stats
  const [sx, sy, sz] = s.sizeMm
  const items: CheckItem[] = []
  const add = (rule: string, severity: CheckSeverity, measured: string, threshold: string, message: string, location?: string, markers?: CheckItem["markers"]) =>
    items.push({ rule, severity, measured, threshold, message, ...(location ? { location } : {}), ...(markers?.length ? { markers } : {}) })

  add(
    "manifold",
    s.manifold ? "pass" : "fail",
    s.manifold ? "watertight" : `not manifold (${a.manifoldError ?? "unknown"})`,
    "watertight, manifold mesh",
    s.manifold
      ? "Mesh is watertight and manifold."
      : "Mesh is not manifold. Check for zero-thickness walls, touching faces between separate objects, or bad imports; union() overlapping parts with a small overlap.",
  )

  const [bx, by, bz] = ctx.buildVolumeMm
  const maxX = bx - 2 * R.bedMarginMm
  const maxY = by - 2 * R.bedMarginMm
  const fits = sx <= maxX && sy <= maxY && sz <= bz
  add(
    "fits_bed",
    fits ? "pass" : "fail",
    `${sx.toFixed(1)} x ${sy.toFixed(1)} x ${sz.toFixed(1)} mm`,
    `<= ${maxX} x ${maxY} x ${bz} mm (build volume ${bx}x${by}x${bz} with ${R.bedMarginMm} mm XY margin)`,
    fits ? "Part fits the build plate." : "Part is larger than the usable build volume. Scale it down or split it into parts.",
  )

  add(
    "bodies",
    s.bodies <= ctx.declaredBodies ? "pass" : "fail",
    `${s.bodies}`,
    `<= ${ctx.declaredBodies}`,
    s.bodies <= ctx.declaredBodies
      ? "No floating or disconnected bodies."
      : `Mesh has ${s.bodies} disconnected bodies. Connect them or split them into separate parts.`,
  )

  const footprint = sx * sy
  const minContact = Math.min(footprint * R.firstLayerMinShare, R.firstLayerMinMm2)
  const okContact = a.firstLayerAreaMm2 >= minContact
  add(
    "first_layer",
    okContact ? "pass" : "warn",
    `${a.firstLayerAreaMm2.toFixed(1)} mm²`,
    `>= ${minContact.toFixed(1)} mm² (min of 1% of footprint, 50 mm²)`,
    okContact
      ? "Good bed contact."
      : "Little or no flat contact with the bed at the lowest Z. Put a large flat face down or add a flat base.",
    `z=${s.bbox.min[2].toFixed(2)}`,
  )

  const share = a.surfaceAreaMm2 > 0 ? a.overhangAreaMm2 / a.surfaceAreaMm2 : 0
  const okOverhang = share <= R.overhangMaxShare
  add(
    "overhangs",
    okOverhang ? "pass" : "warn",
    `${(share * 100).toFixed(1)}% of surface (${a.overhangAreaMm2.toFixed(0)} mm²)`,
    `<= ${R.overhangMaxShare * 100}% faces steeper than 45° from vertical`,
    okOverhang
      ? "Overhangs within limits."
      : "Significant overhangs will need supports. Chamfer downward edges at 45°, reorient the part, or split it.",
    a.overhangZ ? `z=${a.overhangZ[0]}..${a.overhangZ[1]}` : undefined,
  )

  const narrow = Math.min(sx, sy)
  const tall = narrow > 0 && sz > R.tallThinRatio * narrow
  add(
    "tall_thin",
    tall ? "warn" : "pass",
    `height ${sz.toFixed(1)} mm / narrowest side ${narrow.toFixed(1)} mm = ${(narrow > 0 ? sz / narrow : 0).toFixed(1)}`,
    `<= ${R.tallThinRatio}`,
    tall ? "Tall and thin: likely to wobble or snap. Widen the base, add a brim, or print lying down." : "Aspect ratio OK.",
  )

  if (ctx.thickness) {
    const th = ctx.thickness
    const lines = `2 lines of ${th.lineWidthMm} mm${ctx.nozzleMm ? ` (${ctx.nozzleMm} mm nozzle)` : ""}`
    const where = (p: [number, number, number]) => describePoint(p, s.bbox)
    const more = (n: number) => (n > 1 ? ` ${n - 1} more spot${n > 2 ? "s are" : " is"} marked in the 3D view.` : " It's marked in the 3D view.")
    const walls = th.spots.filter((x) => !x.vanishes)
    const vanish = th.spots.filter((x) => x.vanishes)
    const w = walls[0]
    add(
      "thin_walls",
      w ? "warn" : "pass",
      w ? `thinnest ${w.thicknessMm.toFixed(2)} mm (${walls.length} spot${walls.length === 1 ? "" : "s"})` : `no side wall under ${th.minWallMm} mm`,
      `>= ${th.minWallMm} mm (${lines})`,
      w
        ? `This wall is ${w.thicknessMm.toFixed(1)} mm thick (${where(w.at)}). Make it at least ${th.minWallMm} mm, or it may print with gaps or come out weak.${more(walls.length)}`
        : "Walls are thick enough to print solid.",
      w ? `x=${w.at[0]}, y=${w.at[1]}, z=${w.at[2]}` : undefined,
      thinMarkers(walls),
    )
    if (vanish.length) {
      const v = vanish[0]
      add(
        "thin_features",
        "warn",
        `thinnest ${v.thicknessMm.toFixed(2)} mm (${vanish.length} spot${vanish.length === 1 ? "" : "s"})`,
      `>= ${th.lineWidthMm} mm (one line); ${th.minWallMm} mm to print well`,
        `This part is only ${v.thicknessMm.toFixed(1)} mm thick (${where(v.at)}): thinner than one ${th.lineWidthMm} mm line, so it may not print at all. Make it at least ${th.minWallMm} mm, or leave it out.${more(vanish.length)}`,
        `x=${v.at[0]}, y=${v.at[1]}, z=${v.at[2]}`,
        thinMarkers(vanish).map((m) => ({ ...m, severity: "fail" as const })),
      )
    }
  }

  if (ctx.orientation) {
    const o = ctx.orientation
    const c = o.suggestion ?? o.current
    add(
      "orientation",
      o.suggestion ? "info" : "pass",
      `${o.current.label.toLowerCase()}: ${o.current.supportMm2} mm² needs support, ${o.current.heightMm} mm tall`,
      o.suggestion ? `${c.label.toLowerCase()}: ${c.supportMm2} mm² needs support, ${c.heightMm} mm tall` : `${o.candidates.length} ways to lay it compared`,
      o.summary,
    )
  }

  add(
    "colors",
    ctx.colorCount <= ctx.filamentSlots ? "pass" : "fail",
    `${ctx.colorCount} distinct color() values`,
    `<= ${ctx.filamentSlots} filament slots`,
    ctx.colorCount <= ctx.filamentSlots ? "Colour count fits the filament unit." : "More colours than filament slots.",
  )

  const grams = (s.volumeMm3 / 1000) * R.plaDensityGcm3
  add(
    "estimates",
    "info",
    `volume ${(s.volumeMm3 / 1000).toFixed(2)} cm³, ~${grams.toFixed(1)} g PLA, bbox ${sx.toFixed(1)} x ${sy.toFixed(1)} x ${sz.toFixed(1)} mm, ${s.triangles} triangles`,
    `PLA ${R.plaDensityGcm3} g/cm³ (solid; slicer infill will use less)`,
    `About ${grams.toFixed(1)} g of PLA if printed solid.`,
  )
  return items
}

export function worstSeverity(items: CheckItem[]): CheckSeverity {
  if (items.some((i) => i.severity === "fail")) return "fail"
  if (items.some((i) => i.severity === "warn")) return "warn"
  return "pass"
}
