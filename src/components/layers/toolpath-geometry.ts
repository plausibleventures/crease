// GPU geometry for the 3D toolpath view. Each extrusion segment is one instance of a small diamond-section tube
// (4 lit faces, like OrcaSlicer's preview), built in the vertex shader from the segment's record, so the decoded
// Float32 blob goes to the GPU as is: no per-vertex arrays on the main thread. One draw per feature + tool.
// The height cut is a uniform plus instanceCount (records are layer-sorted, so "up to layer n" is a prefix).
import * as THREE from "three"
import { countUpTo, STRIDE, type DecodedToolpath, type ToolpathGroupInfo } from "@shared/toolpath"

/** Uniforms every toolpath material shares (one object each, so one assignment updates every draw). */
export interface ToolpathUniforms {
  uCut: { value: number } // highest layer shown
  uFrom: { value: number } // lowest layer shown
  uDim: { value: number } // 0..1: how far layers below the cut fade toward the stage
  uStage: { value: THREE.Color }
}

export function makeUniforms(): ToolpathUniforms {
  return { uCut: { value: 1e9 }, uFrom: { value: 0 }, uDim: { value: 0 }, uStage: { value: new THREE.Color(0, 0, 0) } }
}

/**
 * Diamond cross-section (left, top, right, bottom points; four faces), open at the ends. Per vertex:
 * `corner` = (end 0|1, side −1..1, up −1..1) and `fnorm` = the face's outward normal signs (side, up).
 * Wound counter-clockwise seen from outside in the segment frame (x = along, y = side, z = up).
 */
export function diamondBase(): THREE.BufferGeometry {
  const pts: [number, number][] = [
    [-1, 0],
    [0, 1],
    [1, 0],
    [0, -1],
  ]
  const corner: number[] = []
  const fnorm: number[] = []
  const index: number[] = []
  for (let f = 0; f < 4; f++) {
    const a = pts[f]
    const b = pts[(f + 1) % 4]
    const n: [number, number] = [Math.sign(a[0] + b[0]), Math.sign(a[1] + b[1])]
    const base = corner.length / 3
    corner.push(0, a[0], a[1], 0, b[0], b[1], 1, a[0], a[1], 1, b[0], b[1])
    for (let k = 0; k < 4; k++) fnorm.push(n[0], n[1])
    // triangle (s·a, s·b, e·a): pick the order whose normal points out
    const local = (end: number, p: [number, number]) => new THREE.Vector3(end, p[0], p[1])
    const v0 = local(0, a)
    const v1 = local(0, b)
    const v2 = local(1, a)
    const out = new THREE.Vector3(0, n[0], n[1])
    const ccw = v1.clone().sub(v0).cross(v2.clone().sub(v0)).dot(out) > 0
    if (ccw) index.push(base, base + 1, base + 2, base + 2, base + 1, base + 3)
    else index.push(base, base + 2, base + 1, base + 1, base + 2, base + 3)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("corner", new THREE.Float32BufferAttribute(corner, 3))
  g.setAttribute("fnorm", new THREE.Float32BufferAttribute(fnorm, 2))
  g.setIndex(index)
  return g
}

const EXTRUSION_VS = /* glsl */ `
attribute vec4 iA; // x1 y1 x2 y2
attribute vec4 iB; // z height width layer
attribute vec3 corner;
attribute vec2 fnorm;
uniform float uCut;
uniform float uFrom;
varying vec3 vN;
varying float vCur;
void main() {
  float layer = iB.w;
  if (layer > uCut + 0.5 || layer < uFrom - 0.5) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); vN = vec3(0.0, 0.0, 1.0); vCur = 0.0; return; }
  vec2 d = iA.zw - iA.xy;
  float len = length(d);
  vec2 dir = len > 1e-5 ? d / len : vec2(1.0, 0.0);
  vec2 side = vec2(-dir.y, dir.x);
  float hw = max(iB.z, 0.15) * 0.5;
  float hh = max(iB.y, 0.04) * 0.5;
  // ends pushed out a little so joined segments meet without gaps at corners
  vec2 p = corner.x < 0.5 ? iA.xy - dir * hh : iA.zw + dir * hh;
  vec3 pos = vec3(p + side * corner.y * hw, iB.x - hh + corner.z * hh);
  vN = normalize(vec3(side * fnorm.x * hh, fnorm.y * hw));
  vCur = layer > uCut - 0.5 ? 1.0 : 0.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
`

const EXTRUSION_FS = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uStage;
uniform float uDim;
varying vec3 vN;
varying float vCur;
void main() {
  vec3 n = normalize(vN);
  float key = max(dot(n, normalize(vec3(0.35, -0.55, 0.78))), 0.0);
  float fill = max(dot(n, normalize(vec3(-0.6, 0.55, 0.25))), 0.0);
  vec3 c = uColor * (0.5 + 0.55 * key + 0.15 * fill);
  c = mix(c, uStage, (1.0 - vCur) * uDim);
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}
`

const TRAVEL_VS = /* glsl */ `
attribute vec4 iA;
attribute vec4 iB;
attribute float end;
uniform float uCut;
uniform float uFrom;
void main() {
  float layer = iB.w;
  if (layer > uCut + 0.5 || layer < uFrom - 0.5) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; }
  vec2 p = end < 0.5 ? iA.xy : iA.zw;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, iB.x + 0.05, 1.0);
}
`
const TRAVEL_FS = /* glsl */ `
uniform vec3 uColor;
void main() {
  gl_FragColor = vec4(uColor, 0.55);
  #include <colorspace_fragment>
}
`

export interface ToolpathDraw {
  group: ToolpathGroupInfo
  geometry: THREE.InstancedBufferGeometry
  material: THREE.ShaderMaterial
}

export interface ToolpathScene {
  draws: ToolpathDraw[]
  travel: { geometry: THREE.InstancedBufferGeometry; material: THREE.ShaderMaterial } | null
  /** extent of all extrusions, in bed mm (z from 0 to the top layer) */
  box: THREE.Box3
  dispose: () => void
}

function instanced(base: THREE.BufferGeometry, data: Float32Array, offset: number, count: number) {
  const g = new THREE.InstancedBufferGeometry()
  g.index = base.index
  for (const [name, attr] of Object.entries(base.attributes)) g.setAttribute(name, attr)
  // a view into the decoded blob: no copy
  const buf = new THREE.InstancedInterleavedBuffer(data.subarray(offset, offset + count * STRIDE), STRIDE, 1)
  g.setAttribute("iA", new THREE.InterleavedBufferAttribute(buf, 4, 0))
  g.setAttribute("iB", new THREE.InterleavedBufferAttribute(buf, 4, 4))
  g.instanceCount = count
  return g
}

/** Build the GPU objects for a decoded toolpath. Colours are set later (setColours); call dispose() when done. */
export function buildToolpathScene(tp: DecodedToolpath, uniforms: ToolpathUniforms): ToolpathScene {
  const { header, data } = tp
  const base = diamondBase()
  const draws: ToolpathDraw[] = header.groups
    .filter((g) => g.count > 0)
    .map((group) => ({
      group,
      geometry: instanced(base, data, group.offset, group.count),
      material: new THREE.ShaderMaterial({
        vertexShader: EXTRUSION_VS,
        fragmentShader: EXTRUSION_FS,
        uniforms: { ...uniforms, uColor: { value: new THREE.Color() } },
      }),
    }))
  let travel: ToolpathScene["travel"] = null
  if (header.travel.count > 0) {
    const lineBase = new THREE.BufferGeometry()
    lineBase.setAttribute("end", new THREE.Float32BufferAttribute([0, 1], 1))
    const geometry = instanced(lineBase, data, header.travel.offset, header.travel.count)
    const material = new THREE.ShaderMaterial({
      vertexShader: TRAVEL_VS,
      fragmentShader: TRAVEL_FS,
      uniforms: { uCut: uniforms.uCut, uFrom: uniforms.uFrom, uColor: { value: new THREE.Color() } },
      transparent: true,
      depthWrite: false,
    })
    travel = { geometry, material }
  }
  const box = new THREE.Box3()
  for (const l of header.layers) {
    if (!l.bbox) continue
    box.expandByPoint(new THREE.Vector3(l.bbox[0], l.bbox[1], Math.max(0, l.z - l.height)))
    box.expandByPoint(new THREE.Vector3(l.bbox[2], l.bbox[3], l.z))
  }
  if (box.isEmpty()) box.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(header.bed[0], header.bed[1], 1))
  return {
    draws,
    travel,
    box,
    dispose: () => {
      base.dispose()
      for (const d of draws) {
        d.geometry.dispose()
        d.material.dispose()
      }
      travel?.geometry.dispose()
      travel?.material.dispose()
    },
  }
}

/** Show layers from..cut: shrink each draw to the records on layers ≤ cut (the shader hides those below `from`). */
export function setCut(scene: ToolpathScene, data: Float32Array, uniforms: ToolpathUniforms, from: number, cut: number, top: number) {
  uniforms.uCut.value = cut
  uniforms.uFrom.value = from
  uniforms.uDim.value = cut < top ? 0.4 : 0
  for (const d of scene.draws) d.geometry.instanceCount = countUpTo(data, d.group.offset, d.group.count, cut)
  if (scene.travel) {
    // travel records sit after the groups; same layer-sorted layout
    const g = scene.travel.geometry
    const attr = g.getAttribute("iA") as THREE.InterleavedBufferAttribute
    const arr = attr.data.array as Float32Array
    g.instanceCount = countUpTo(arr, 0, arr.length / STRIDE, cut)
  }
}

/** The box (bed mm) of one layer's extrusions, for "frame this layer"; null if the layer is empty. */
export function layerBox(tp: DecodedToolpath, layer: number): THREE.Box3 | null {
  const l = tp.header.layers[layer]
  if (!l?.bbox) return null
  return new THREE.Box3(new THREE.Vector3(l.bbox[0], l.bbox[1], Math.max(0, l.z - l.height)), new THREE.Vector3(l.bbox[2], l.bbox[3], l.z))
}
