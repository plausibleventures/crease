// Minimal PNG post-processing for OpenSCAD renders:
//  - whitenBackground: guide renders sit on a white page without a grey box (flood-fills from the borders, so light
//    parts are never touched).
//  - clearBackground: part previews get a transparent background so one picture suits the light and the dark theme
//    (with a faint halo round dark parts so they keep their outline on the dark stage).
// Handles 8-bit RGB / RGBA, non-interlaced (what OpenSCAD writes); anything else is returned unchanged.
import { deflateSync, inflateSync } from "node:zlib"

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

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

function paeth(a: number, b: number, c: number) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

interface Raster {
  w: number
  h: number
  bpp: 3 | 4
  px: Buffer
}

/** Decode an 8-bit RGB / RGBA, non-interlaced PNG; null for anything else. */
function decode(png: Buffer): Raster | null {
  if (png.length < 33 || !png.subarray(0, 8).equals(SIG)) return null
  let pos = 8
  let w = 0, h = 0, depth = 0, ctype = 0, interlace = 0
  const idat: Buffer[] = []
  while (pos < png.length) {
    const len = png.readUInt32BE(pos)
    const type = png.toString("ascii", pos + 4, pos + 8)
    const data = png.subarray(pos + 8, pos + 8 + len)
    if (type === "IHDR") {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      depth = data[8]
      ctype = data[9]
      interlace = data[12]
    } else if (type === "IDAT") idat.push(data)
    pos += 12 + len
  }
  if (depth !== 8 || (ctype !== 2 && ctype !== 6) || interlace !== 0) return null
  const bpp = ctype === 6 ? 4 : 3
  const stride = w * bpp
  const raw = inflateSync(Buffer.concat(idat))
  const px = Buffer.alloc(h * stride)
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = px.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[i - bpp] : 0
      const b = prev ? prev[i] : 0
      const c = prev && i >= bpp ? prev[i - bpp] : 0
      const v = src[i]
      out[i] = (ft === 0 ? v : ft === 1 ? v + a : ft === 2 ? v + b : ft === 3 ? v + ((a + b) >> 1) : v + paeth(a, b, c)) & 0xff
    }
  }
  return { w, h, bpp, px }
}

/** Encode (filter type "up" compresses renders well). */
function encode({ w, h, bpp, px }: Raster): Buffer {
  const stride = w * bpp
  const filtered = Buffer.alloc(h * (stride + 1))
  for (let y = 0; y < h; y++) {
    filtered[y * (stride + 1)] = 2
    for (let i = 0; i < stride; i++) {
      const up = y > 0 ? px[(y - 1) * stride + i] : 0
      filtered[y * (stride + 1) + 1 + i] = (px[y * stride + i] - up) & 0xff
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = bpp === 4 ? 6 : 2
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(filtered, { level: 9 })), chunk("IEND", Buffer.alloc(0))])
}

export function whitenBackground(png: Buffer, tolerance = 2): Buffer {
  const r = decode(png)
  if (!r) return png
  const { w, h, bpp, px } = r
  // Background colour = top-left pixel; flood fill from every border pixel that matches it.
  const bg = [px[0], px[1], px[2]]
  const isBg = (i: number) => Math.abs(px[i] - bg[0]) <= tolerance && Math.abs(px[i + 1] - bg[1]) <= tolerance && Math.abs(px[i + 2] - bg[2]) <= tolerance
  const seen = new Uint8Array(w * h)
  const stack: number[] = []
  const push = (x: number, y: number) => {
    const k = y * w + x
    if (!seen[k] && isBg(k * bpp)) {
      seen[k] = 1
      stack.push(k)
    }
  }
  for (let x = 0; x < w; x++) {
    push(x, 0)
    push(x, h - 1)
  }
  for (let y = 0; y < h; y++) {
    push(0, y)
    push(w - 1, y)
  }
  while (stack.length) {
    const k = stack.pop()!
    const i = k * bpp
    px[i] = px[i + 1] = px[i + 2] = 255
    const x = k % w
    const y = (k - x) / w
    if (x > 0) push(x - 1, y)
    if (x < w - 1) push(x + 1, y)
    if (y > 0) push(x, y - 1)
    if (y < h - 1) push(x, y + 1)
  }
  return encode(r)
}

/**
 * Part previews for the app's pages: OpenSCAD's flat background made transparent, so one picture suits a light and a
 * dark page. OpenSCAD draws without anti-aliasing and lights every face, so the background colour (all four corners
 * agree on it) appears only where nothing was drawn, holes included. Returns the input unchanged if the corners
 * disagree or the format isn't one OpenSCAD writes.
 */
export function clearBackground(png: Buffer): Buffer {
  const r = decode(png)
  if (!r) return png
  const { w, h, bpp, px } = r
  const at = (x: number, y: number) => (y * w + x) * bpp
  const bg = [px[0], px[1], px[2]]
  const same = (i: number) => px[i] === bg[0] && px[i + 1] === bg[1] && px[i + 2] === bg[2]
  if (![at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)].every(same)) return png
  const out = Buffer.alloc(w * h * 4)
  for (let k = 0; k < w * h; k++) {
    const i = k * bpp
    const o = k * 4
    out[o] = px[i]
    out[o + 1] = px[i + 1]
    out[o + 2] = px[i + 2]
    out[o + 3] = same(i) ? 0 : bpp === 4 ? px[i + 3] : 255
  }
  haloDark(out, w, h)
  return encode({ w, h, bpp: 4, px: out })
}

/** Brightest drawn pixel (by its brightest channel) this dark or darker = a dark part's edge. */
const DARK_EDGE = 72
// halo strength by distance from the part (px): close, then fading
const HALO_ALPHA = [0, 72, 36]

/**
 * A faint light halo just outside dark parts (black, charcoal, navy): on the dark theme's stage a black part would
 * otherwise lose its outline. Only where every drawn pixel within 2 px is dark, so pale parts get none (and on a light
 * page the halo is invisible). Works on the RGBA buffer in place.
 */
function haloDark(px: Buffer, w: number, h: number) {
  const R = HALO_ALPHA.length - 1
  const set: [number, number][] = []
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] !== 0) continue
      let near = Infinity
      let brightest = -1
      for (let dy = -R; dy <= R; dy++)
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx
          const yy = y + dy
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
          const j = (yy * w + xx) * 4
          if (px[j + 3] === 0) continue
          near = Math.min(near, Math.max(Math.abs(dx), Math.abs(dy)))
          brightest = Math.max(brightest, px[j], px[j + 1], px[j + 2])
        }
      if (near <= R && brightest <= DARK_EDGE) set.push([y * w + x, HALO_ALPHA[near]])
    }
  for (const [k, a] of set) {
    px[k * 4] = px[k * 4 + 1] = px[k * 4 + 2] = 200
    px[k * 4 + 3] = a
  }
}
