import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateSync, inflateSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { clearBackground } from "../assembly/png"
import { clearedRender, displayUrl, isClearable } from "./display"

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const chunk = (t: string, d: Buffer) => {
  const l = Buffer.alloc(4)
  l.writeUInt32BE(d.length)
  return Buffer.concat([l, Buffer.from(t), d, Buffer.alloc(4)])
}
/** w x h RGB PNG (filter 0), pixel colour from `at`. */
function rgbPng(w: number, h: number, at: (x: number, y: number) => [number, number, number]): Buffer {
  const rows: number[] = []
  for (let y = 0; y < h; y++) {
    rows.push(0)
    for (let x = 0; x < w; x++) rows.push(...at(x, y))
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from(rows))), chunk("IEND", Buffer.alloc(0))])
}
/** Alpha channel of our own RGBA output (filter 2 "up"). */
function alphas(png: Buffer, w: number, h: number): number[] {
  const raw = inflateSync(png.subarray(41, png.length - 16))
  const stride = w * 4
  const px = Buffer.alloc(h * stride)
  for (let y = 0; y < h; y++)
    for (let i = 0; i < stride; i++) px[y * stride + i] = (raw[y * (stride + 1) + 1 + i] + (y ? px[(y - 1) * stride + i] : 0)) & 0xff
  return Array.from({ length: w * h }, (_, k) => px[k * 4 + 3])
}

describe("part pictures for both themes", () => {
  it("makes the flat background transparent, holes included, and keeps the part opaque", () => {
    // 5x5 black background, a grey ring around one black pixel (a hole you can see through)
    const ring = (x: number, y: number) => x >= 1 && x <= 3 && y >= 1 && y <= 3 && !(x === 2 && y === 2)
    const out = clearBackground(rgbPng(5, 5, (x, y) => (ring(x, y) ? [198, 202, 209] : [0, 0, 0])))
    expect(out[8 + 8 + 9]).toBe(6) // IHDR colour type: RGBA
    const a = alphas(out, 5, 5)
    expect(a[0]).toBe(0)
    expect(a[2 * 5 + 2]).toBe(0) // the hole
    expect(a[1 * 5 + 1]).toBe(255)
    expect(a.filter((v) => v === 255)).toHaveLength(8)
  })

  it("rings a dark part with a faint light halo, a pale part with none", () => {
    // 7x7 black background, a 3x3 square in the middle
    const square = (rgb: [number, number, number]) =>
      clearBackground(rgbPng(7, 7, (x, y) => (x >= 2 && x <= 4 && y >= 2 && y <= 4 ? rgb : [0, 0, 0])))
    const dark = alphas(square([51, 51, 51]), 7, 7)
    expect(dark[3 * 7 + 3]).toBe(255) // the part
    expect(dark[3 * 7 + 1]).toBeGreaterThan(dark[3 * 7 + 0]) // halo next to it, fading outward
    expect(dark[3 * 7 + 0]).toBeGreaterThan(0)
    const pale = alphas(square([198, 202, 209]), 7, 7)
    expect(pale.filter((v) => v > 0 && v < 255)).toHaveLength(0)
  })

  it("leaves a picture alone when its corners disagree (not a flat background)", () => {
    const png = rgbPng(3, 3, (x, y) => (x === 2 && y === 2 ? [255, 255, 255] : [0, 0, 0]))
    expect(clearBackground(png)).toBe(png)
  })

  it("only part renders and compare views get the transparent variant", () => {
    expect(isClearable("renders/main-iso.png")).toBe(true)
    expect(isClearable("renders/main-bed.png")).toBe(true)
    expect(isClearable("build/compare/abc123/out/view-0123456789.png")).toBe(true)
    expect(isClearable("renders/assembly-complete.png")).toBe(false)
    expect(isClearable("renders/main-iso.clear.png")).toBe(false)
    expect(isClearable("build/main.stl")).toBe(false)
    expect(displayUrl("p1", "renders/main-iso.png", "h")).toBe("/api/projects/p1/artifacts/renders/main-iso.png?v=h&bg=clear")
    expect(displayUrl("p1", "build/main.stl", "h")).toBe("/api/projects/p1/artifacts/build/main.stl?v=h")
  })

  it("keeps the transparent copy next to the render and redoes it when the render is newer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ps-display-"))
    const src = join(dir, "main-iso.png")
    writeFileSync(src, rgbPng(2, 2, () => [0, 0, 0]))
    const out = await clearedRender(src)
    expect(out).toBe(join(dir, "main-iso.clear.png"))
    expect(alphas(readFileSync(out), 2, 2)).toEqual([0, 0, 0, 0])
    // a new render (newer than the copy): the copy is redone
    writeFileSync(src, rgbPng(3, 2, (x, y) => (x === 1 && y === 1 ? [200, 0, 0] : [0, 0, 0])))
    const later = new Date(statSync(out).mtimeMs + 5000)
    utimesSync(src, later, later)
    expect(alphas(readFileSync(await clearedRender(src)), 3, 2)).toEqual([0, 0, 0, 0, 255, 0])
  })
})
