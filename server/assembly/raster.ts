// Small deterministic software rasteriser for the guide's step art (R14): orthographic z-buffer, flat two-light
// shading, silhouette + crease lines (IKEA-ish line art), 2x supersampling. Pure TypeScript, no GPU, so the same
// inputs always give the same pixels and the projection is exactly the one the SVG overlay uses.
import { deflateSync } from "node:zlib"
import { cross, dot, norm, project, type OrthoView } from "../../shared/assembly-art"
import type { Vec3 } from "../../shared/types"
import { liftDark } from "../cad/preview"

export type RasterStyle = "new" | "muted" | "plain"

export interface RasterMesh {
  tris: Float32Array // 9 floats per triangle, world mm
  color: [number, number, number] // 0..1
  style: RasterStyle
}

export interface RasterResult {
  width: number
  height: number
  rgb: Buffer // width*height*3, on white
  rgba: Buffer // width*height*4, background transparent (for the app's pages)
  id: Int32Array // mesh index per pixel (final resolution), -1 = background
  depth: Float32Array // mm along view.dir per pixel (final resolution), -Infinity = background
}

const LINE_DARK: [number, number, number] = [26, 27, 30]
const LINE_MUTED: [number, number, number] = [150, 155, 163]
const MUTED_PAPER: [number, number, number] = [0.9, 0.91, 0.925]

interface Buffers {
  W: number
  H: number
  depth: Float32Array
  id: Int32Array
  face: Int32Array
}

/** Z-buffer pass. `faceCb` receives each triangle's facing normal (toward the eye) and returns its colour index. */
function zbuffer(meshes: RasterMesh[], view: OrthoView, W: number, H: number, onFace?: (mesh: number, n: Vec3) => void): Buffers {
  const depth = new Float32Array(W * H).fill(-Infinity)
  const id = new Int32Array(W * H).fill(-1)
  const face = new Int32Array(W * H).fill(-1)
  let faceIdx = 0
  const { right: R, up: U, dir: D, s, ox, oy } = view
  for (let m = 0; m < meshes.length; m++) {
    const t = meshes[m].tris
    for (let k = 0; k + 8 < t.length; k += 9, faceIdx++) {
      const ax = t[k], ay = t[k + 1], az = t[k + 2]
      const bx = t[k + 3], by = t[k + 4], bz = t[k + 5]
      const cx = t[k + 6], cy = t[k + 7], cz = t[k + 8]
      if (onFace) {
        let n = cross([bx - ax, by - ay, bz - az], [cx - ax, cy - ay, cz - az])
        n = norm(n)
        if (dot(n, D) < 0) n = [-n[0], -n[1], -n[2]]
        onFace(m, n)
      }
      const x0 = ox + s * (ax * R[0] + ay * R[1] + az * R[2])
      const y0 = oy - s * (ax * U[0] + ay * U[1] + az * U[2])
      const z0 = ax * D[0] + ay * D[1] + az * D[2]
      const x1 = ox + s * (bx * R[0] + by * R[1] + bz * R[2])
      const y1 = oy - s * (bx * U[0] + by * U[1] + bz * U[2])
      const z1 = bx * D[0] + by * D[1] + bz * D[2]
      const x2 = ox + s * (cx * R[0] + cy * R[1] + cz * R[2])
      const y2 = oy - s * (cx * U[0] + cy * U[1] + cz * U[2])
      const z2 = cx * D[0] + cy * D[1] + cz * D[2]
      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
      if (Math.abs(area) < 1e-9) continue
      const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)))
      const maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)))
      const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)))
      const maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)))
      if (minX > maxX || minY > maxY) continue
      const inv = 1 / area
      for (let py = minY; py <= maxY; py++) {
        const sy = py + 0.5
        for (let px = minX; px <= maxX; px++) {
          const sx = px + 0.5
          const w0 = ((x1 - sx) * (y2 - sy) - (x2 - sx) * (y1 - sy)) * inv
          const w1 = ((x2 - sx) * (y0 - sy) - (x0 - sx) * (y2 - sy)) * inv
          const w2 = 1 - w0 - w1
          if (w0 < -1e-7 || w1 < -1e-7 || w2 < -1e-7) continue
          const z = w0 * z0 + w1 * z1 + w2 * z2
          const i = py * W + px
          if (z > depth[i]) {
            depth[i] = z
            id[i] = m
            face[i] = faceIdx
          }
        }
      }
    }
  }
  return { W, H, depth, id, face }
}

const scaled = (v: OrthoView, k: number): OrthoView => ({ ...v, s: v.s * k, ox: v.ox * k, oy: v.oy * k })

/** Black filament would shade to a flat silhouette under the dark lines: lift dark colours (0..1) the way part previews do. */
export function liftDarkUnit(c: [number, number, number]): [number, number, number] {
  const lifted = liftDark([c[0] * 255, c[1] * 255, c[2] * 255])
  return lifted ? [lifted[0] / 255, lifted[1] / 255, lifted[2] / 255] : c
}

/** Ids + depth only (camera scoring, visibility): one sample per pixel. */
export function rasterIds(meshes: RasterMesh[], view: OrthoView, width: number, height: number): { id: Int32Array; depth: Float32Array } {
  const b = zbuffer(meshes, view, width, height)
  return { id: b.id, depth: b.depth }
}

/** Shaded line-art render at width x height (supersampled `ss` times per axis). */
export function rasterize(meshes: RasterMesh[], view: OrthoView, width: number, height: number, ss = 2): RasterResult {
  const W = width * ss
  const H = height * ss
  const v2 = scaled(view, ss)
  // Lights in view space: key from upper left, fill from the right.
  const L1 = norm([-0.45 * v2.right[0] + 0.65 * v2.up[0] + 0.62 * v2.dir[0], -0.45 * v2.right[1] + 0.65 * v2.up[1] + 0.62 * v2.dir[1], -0.45 * v2.right[2] + 0.65 * v2.up[2] + 0.62 * v2.dir[2]])
  const L2 = norm([0.7 * v2.right[0] + 0.1 * v2.up[0] + 0.5 * v2.dir[0], 0.7 * v2.right[1] + 0.1 * v2.up[1] + 0.5 * v2.dir[1], 0.7 * v2.right[2] + 0.1 * v2.up[2] + 0.5 * v2.dir[2]])
  const faceRgb: number[] = []
  const faceN: number[] = []
  const b = zbuffer(meshes, v2, W, H, (m, n) => {
    const mesh = meshes[m]
    const l = Math.max(0, dot(n, L1))
    const f = Math.max(0, dot(n, L2))
    let c = mesh.color
    let shade: number
    if (mesh.style === "muted") {
      c = [c[0] * 0.1 + MUTED_PAPER[0] * 0.9, c[1] * 0.1 + MUTED_PAPER[1] * 0.9, c[2] * 0.1 + MUTED_PAPER[2] * 0.9]
      shade = 0.8 + 0.16 * l + 0.06 * f
    } else {
      // Very light colours (white filament) would vanish on paper: keep them a touch darker.
      const lum = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]
      if (lum > 0.85) c = [c[0] * 0.92, c[1] * 0.92, c[2] * 0.93]
      c = liftDarkUnit(c)
      shade = 0.42 + 0.5 * l + 0.2 * f
    }
    faceRgb.push(Math.min(255, c[0] * shade * 255), Math.min(255, c[1] * shade * 255), Math.min(255, c[2] * shade * 255))
    faceN.push(n[0], n[1], n[2])
  })
  const { depth, id, face } = b
  // Edges: instance / background boundaries, depth jumps and creases. Lines take the colour of the nearer side.
  const line = new Int8Array(W * H) // 0 none, 1 muted, 2 dark thin, 3 dark thick
  const dz = Math.max(1.5, 10 / v2.s)
  const cosCrease = Math.cos((38 * Math.PI) / 180)
  const mark = (i: number, kind: number) => {
    if (kind > line[i]) line[i] = kind
  }
  const styleKind = (m: number, silhouette: boolean) => (meshes[m].style === "muted" ? 1 : silhouette ? 3 : 2)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      for (const j of [x + 1 < W ? i + 1 : -1, y + 1 < H ? i + W : -1]) {
        if (j < 0) continue
        const a = id[i]
        const c = id[j]
        if (a < 0 && c < 0) continue
        if (a !== c) {
          // silhouette: owned by the nearer one
          const near = depth[i] >= depth[j] ? i : j
          mark(near, styleKind(id[near], true))
          continue
        }
        if (Math.abs(depth[i] - depth[j]) > dz) {
          const near = depth[i] >= depth[j] ? i : j
          mark(near, styleKind(a, true))
          continue
        }
        const fa = face[i]
        const fb = face[j]
        if (fa !== fb && fa >= 0 && fb >= 0) {
          const d = faceN[fa * 3] * faceN[fb * 3] + faceN[fa * 3 + 1] * faceN[fb * 3 + 1] + faceN[fa * 3 + 2] * faceN[fb * 3 + 2]
          if (d < cosCrease) mark(i, styleKind(a, false))
        }
      }
    }
  }
  // Thick lines: dilate kind 3 by one pixel (at 2x that is ~1.5 px in the final image).
  const thick = new Uint8Array(W * H)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (line[y * W + x] !== 3) continue
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          const yy = y + dy
          if (xx >= 0 && yy >= 0 && xx < W && yy < H) thick[yy * W + xx] = 1
        }
    }
  // Shade + lines at supersampled resolution, then box-filter down.
  const rgb = Buffer.alloc(width * height * 3)
  const rgba = Buffer.alloc(width * height * 4) // the same picture on a transparent background (app pages)
  const outId = new Int32Array(width * height)
  const outDepth = new Float32Array(width * height)
  const n = ss * ss
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, bl = 0
      let cr = 0, cg = 0, cb = 0, covered = 0
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const i = (y * ss + sy) * W + (x * ss + sx)
          let pr = 255, pg = 255, pb = 255
          const f = face[i]
          if (f >= 0) {
            pr = faceRgb[f * 3]
            pg = faceRgb[f * 3 + 1]
            pb = faceRgb[f * 3 + 2]
          }
          const k = thick[i] ? 3 : line[i]
          if (k === 1) [pr, pg, pb] = [pr * 0.35 + LINE_MUTED[0] * 0.65, pg * 0.35 + LINE_MUTED[1] * 0.65, pb * 0.35 + LINE_MUTED[2] * 0.65]
          else if (k === 2) [pr, pg, pb] = [pr * 0.3 + LINE_DARK[0] * 0.7, pg * 0.3 + LINE_DARK[1] * 0.7, pb * 0.3 + LINE_DARK[2] * 0.7]
          else if (k === 3) [pr, pg, pb] = LINE_DARK
          r += pr
          g += pg
          bl += pb
          if (f >= 0 || k) {
            cr += pr
            cg += pg
            cb += pb
            covered++
          }
        }
      const o = (y * width + x) * 3
      rgb[o] = Math.round(r / n)
      rgb[o + 1] = Math.round(g / n)
      rgb[o + 2] = Math.round(bl / n)
      if (covered) {
        const q = (y * width + x) * 4
        rgba[q] = Math.round(cr / covered)
        rgba[q + 1] = Math.round(cg / covered)
        rgba[q + 2] = Math.round(cb / covered)
        rgba[q + 3] = Math.round((255 * covered) / n)
      }
      const c = (y * ss + (ss >> 1)) * W + (x * ss + (ss >> 1))
      outId[y * width + x] = id[c]
      outDepth[y * width + x] = depth[c]
    }
  }
  return { width, height, rgb, rgba, id: outId, depth: outDepth }
}

/** Projected 2D bounds (unit view: s = 1, origin 0) of a set of triangles. */
export function projectedBounds(meshes: { tris: Float32Array }[], view: OrthoView, acc?: [number, number, number, number]): [number, number, number, number] {
  const b = acc ?? [Infinity, Infinity, -Infinity, -Infinity]
  for (const m of meshes) {
    const t = m.tris
    for (let k = 0; k + 2 < t.length; k += 3) {
      const [x, y] = project(view, [t[k], t[k + 1], t[k + 2]])
      if (x < b[0]) b[0] = x
      if (y < b[1]) b[1] = y
      if (x > b[2]) b[2] = x
      if (y > b[3]) b[3] = y
    }
  }
  return b
}

/* ---------- PNG ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, "ascii"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

/** 8-bit RGB (or RGBA with channels = 4) PNG ("up" filter). */
export function encodePng(rgb: Buffer, width: number, height: number, channels: 3 | 4 = 3): Buffer {
  const stride = width * channels
  const filtered = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    filtered[y * (stride + 1)] = 2
    for (let i = 0; i < stride; i++) {
      const up = y > 0 ? rgb[(y - 1) * stride + i] : 0
      filtered[y * (stride + 1) + 1 + i] = (rgb[y * stride + i] - up) & 0xff
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = channels === 4 ? 6 : 2
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(filtered, { level: 6 })), chunk("IEND", Buffer.alloc(0))])
}
