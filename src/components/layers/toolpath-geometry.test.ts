import * as THREE from "three"
import { describe, expect, it } from "vitest"
import { decodeToolpath, encodeToolpath, type ToolpathSource } from "@shared/toolpath"
import { buildToolpathScene, diamondBase, layerBox, makeUniforms, setCut } from "./toolpath-geometry"

function source(n: number): ToolpathSource {
  return {
    layers: Array.from({ length: n }, (_, i) => ({
      z: 0.2 * (i + 1),
      height: 0.2,
      segments: [
        { feature: "Outer wall" as const, tool: 0, lineWidth: 0.42, coords: [10, 10, 30, 10, 30, 10, 30, 20] },
        ...(i % 2 ? [{ feature: "Top surface" as const, tool: 1, lineWidth: 0.4, coords: [12, 12, 28, 18] }] : []),
      ],
      travels: [{ x1: 0, y1: 0, x2: 10, y2: 10 }],
    })),
    settings: {},
  }
}
const tp = () => {
  const u8 = encodeToolpath(source(6))
  return decodeToolpath(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer)
}

describe("diamond base", () => {
  it("has four faces, each wound outward", () => {
    const g = diamondBase()
    expect(g.getAttribute("corner").count).toBe(16)
    const idx = g.index!.array
    expect(idx.length).toBe(24)
    const c = g.getAttribute("corner")
    const n = g.getAttribute("fnorm")
    const v = (i: number) => new THREE.Vector3(c.getX(i), c.getY(i), c.getZ(i))
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, d] = [idx[t], idx[t + 1], idx[t + 2]]
      const normal = v(b).sub(v(a)).cross(v(d).sub(v(a)))
      expect(normal.dot(new THREE.Vector3(0, n.getX(a), n.getY(a)))).toBeGreaterThan(0)
    }
  })
})

describe("toolpath scene", () => {
  it("one draw per feature + tool, instanced straight from the blob", () => {
    const t = tp()
    const scene = buildToolpathScene(t, makeUniforms())
    expect(scene.draws.map((d) => `${d.group.feature}|${d.group.tool}`)).toEqual(["Outer wall|0", "Top surface|1"])
    expect(scene.draws[0].geometry.instanceCount).toBe(12)
    // zero-copy: the instance buffer is a view on the decoded data
    const attr = scene.draws[0].geometry.getAttribute("iA") as THREE.InterleavedBufferAttribute
    expect((attr.data.array as Float32Array).buffer).toBe(t.data.buffer)
    expect(scene.box.min.toArray()).toEqual([10, 10, 0])
    expect(scene.box.max.z).toBeCloseTo(1.2)
    scene.dispose()
  })

  it("the height cut shrinks each draw to the layers at or below it and fades the rest", () => {
    const t = tp()
    const u = makeUniforms()
    const scene = buildToolpathScene(t, u)
    setCut(scene, t.data, u, 0, 2, 5)
    expect(scene.draws[0].geometry.instanceCount).toBe(6) // layers 0..2, 2 segments each
    expect(scene.draws[1].geometry.instanceCount).toBe(1) // top surface on odd layers: layer 1
    expect(scene.travel!.geometry.instanceCount).toBe(3)
    expect(u.uCut.value).toBe(2)
    expect(u.uDim.value).toBeGreaterThan(0)
    // every material shares the same uniform objects
    expect(scene.draws.every((d) => d.material.uniforms.uCut === u.uCut)).toBe(true)
    setCut(scene, t.data, u, 0, 5, 5)
    expect(u.uDim.value).toBe(0)
    expect(scene.draws[0].geometry.instanceCount).toBe(12)
    scene.dispose()
  })

  it("frames one layer", () => {
    const b = layerBox(tp(), 3)!
    expect(b.min.x).toBe(10)
    expect(b.max.toArray().map((v) => +v.toFixed(2))).toEqual([30, 20, 0.8])
    expect(layerBox(tp(), 99)).toBeNull()
  })
})
