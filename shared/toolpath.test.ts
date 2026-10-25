import { describe, expect, it } from "vitest"
import { bedOf, countUpTo, decodeToolpath, encodeToolpath, mergeRuns, STRIDE, type ToolpathSource } from "./toolpath"

/** n layers of a 10 mm square outer wall (4 joined segments) + one infill line, tool 0; layer 2+ adds tool 1 infill. */
function plate(n: number, opts: { travels?: number } = {}): ToolpathSource {
  const layers: ToolpathSource["layers"] = []
  for (let i = 0; i < n; i++) {
    const segments: ToolpathSource["layers"][number]["segments"] = [
      { feature: "Outer wall", tool: 0, lineWidth: 0.42, coords: [0, 0, 10, 0, 10, 0, 10, 10, 10, 10, 0, 10, 0, 10, 0, 0] },
      { feature: "Sparse infill", tool: 0, lineWidth: 0.45, coords: [1, 1, 9, 9] },
    ]
    if (i >= 2) segments.push({ feature: "Sparse infill", tool: 1, lineWidth: 0.45, coords: [1, 9, 9, 1] })
    const travels = Array.from({ length: opts.travels ?? 1 }, (_, k) => ({ x1: 0, y1: 0, x2: 5 + k, y2: 5 }))
    layers.push({ z: 0.2 * (i + 1), height: 0.2, segments, travels })
  }
  return { layers, settings: { printable_area: "0x0,256x0,256x250,0x250", filament_colour: "#F5F5F5;#D32F2F" } }
}

const decode = (u8: Uint8Array) => decodeToolpath(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer)

describe("toolpath blob", () => {
  it("round-trips groups, layers, bed, colours and records", () => {
    const { header, data } = decode(encodeToolpath(plate(4)))
    expect(header.bed).toEqual([256, 250])
    expect(header.toolColours).toEqual(["#F5F5F5", "#D32F2F"])
    expect(header.layers).toHaveLength(4)
    expect(header.layers[3].z).toBeCloseTo(0.8)
    expect(header.layers[0].bbox).toEqual([0, 0, 10, 10])
    expect(header.groups.map((g) => `${g.feature}|${g.tool}|${g.count}`)).toEqual(["Outer wall|0|16", "Sparse infill|0|4", "Sparse infill|1|2"])
    expect(header.segments).toBe(22)
    expect(header.simplified).toBe(false)
    const wall = header.groups[0]
    // the first record: x1 y1 x2 y2 z h w layer
    expect(Array.from(data.subarray(wall.offset, wall.offset + STRIDE)).map((v) => +v.toFixed(2))).toEqual([0, 0, 10, 0, 0.2, 0.2, 0.42, 0])
    expect(header.travel.count).toBe(4)
    expect(data[header.travel.offset + STRIDE * 3 + 7]).toBe(3) // last travel is on layer 3
  })

  it("counts the records up to a layer (the height cut) by binary search", () => {
    const { header, data } = decode(encodeToolpath(plate(5)))
    const wall = header.groups[0]
    expect(countUpTo(data, wall.offset, wall.count, 0)).toBe(4)
    expect(countUpTo(data, wall.offset, wall.count, 2)).toBe(12)
    expect(countUpTo(data, wall.offset, wall.count, 99)).toBe(20)
    expect(countUpTo(data, wall.offset, wall.count, -1)).toBe(0)
    const t1 = header.groups.find((g) => g.tool === 1)!
    expect(countUpTo(data, t1.offset, t1.count, 1)).toBe(0) // tool 1 starts on layer 2
    expect(countUpTo(data, t1.offset, t1.count, 3)).toBe(2)
  })

  it("rejects something that is not a toolpath", () => {
    expect(() => decodeToolpath(new Uint8Array(16).buffer)).toThrow(/not a toolpath/)
  })

  it("over the cap: thins inner features on some layers, keeps every wall, and says so", () => {
    const src = plate(10)
    const { header } = decode(encodeToolpath(src, { maxSegments: 50 }))
    expect(header.simplified).toBe(true)
    expect(header.sourceSegments).toBe(4 * 10 + 10 + 8)
    expect(header.segments).toBeLessThanOrEqual(50)
    expect(header.groups.find((g) => g.feature === "Outer wall")!.count).toBe(40)
  })

  it("thins travel moves evenly to the cap, still sorted by layer", () => {
    const { header, data } = decode(encodeToolpath(plate(10, { travels: 10 }), { maxTravels: 25 }))
    expect(header.travel.count).toBe(25)
    let last = -1
    for (let i = 0; i < 25; i++) {
      const l = data[header.travel.offset + i * STRIDE + 7]
      expect(l).toBeGreaterThanOrEqual(last)
      last = l
    }
    expect(last).toBe(9)
  })
})

describe("mergeRuns", () => {
  it("merges a straight run of joined segments into one chord", () => {
    expect(mergeRuns([0, 0, 1, 0, 1, 0, 2, 0, 2, 0, 3, 0], 0.01)).toEqual([0, 0, 3, 0])
  })
  it("keeps corners and unjoined segments", () => {
    const square = [0, 0, 10, 0, 10, 0, 10, 10, 10, 10, 0, 10]
    expect(mergeRuns(square, 0.05)).toEqual(square)
    expect(mergeRuns([0, 0, 1, 0, 5, 5, 6, 5], 0.05)).toEqual([0, 0, 1, 0, 5, 5, 6, 5])
  })
  it("merges a fine arc within the tolerance, not beyond it", () => {
    const pts: number[] = []
    for (let k = 0; k < 32; k++) {
      const a1 = (k / 32) * Math.PI
      const a2 = ((k + 1) / 32) * Math.PI
      pts.push(10 * Math.cos(a1), 10 * Math.sin(a1), 10 * Math.cos(a2), 10 * Math.sin(a2))
    }
    const loose = mergeRuns(pts, 0.15).length / 4
    const tight = mergeRuns(pts, 0.001).length / 4
    expect(loose).toBeLessThan(32)
    expect(loose).toBeGreaterThan(2)
    expect(tight).toBe(32)
  })
})

describe("bedOf", () => {
  it("reads printable_area, with a 260 mm fallback", () => {
    expect(bedOf({ printable_area: "0x0,220x0,220x220,0x220" })).toEqual([220, 220])
    expect(bedOf({})).toEqual([260, 260])
  })
})
