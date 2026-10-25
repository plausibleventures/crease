// Minimal 3MF reader for imports (R23): the mesh (every build item, with component and item transforms, in mm) and
// the descriptive metadata (title, designer, licence…). The archive is untrusted: it goes through the build-pack zip
// reader (safe names, size caps), and nothing else in it is used. Slicer project settings, G-code, thumbnails and
// scripts some apps put in 3MFs are never read or applied; ignoredParts() lists them so the user is told.
import { readZip, type ZipEntry } from "../pack/zip"

export interface ThreeMf {
  triangles: Float32Array // 9 floats per triangle, mm
  metadata: Record<string, string> // name -> value (Title, Designer, LicenseTerms, Copyright, …)
  unit: string
  ignored: string[] // archive paths with settings/extras that were not used
}

type M = number[] // 12-number 3MF affine transform (row-vector convention)
const IDENTITY: M = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
const UNIT_MM: Record<string, number> = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 }

function parseTransform(s: string | undefined): M {
  if (!s) return IDENTITY
  const v = s.trim().split(/\s+/).map(Number)
  return v.length === 12 && v.every(Number.isFinite) ? v : IDENTITY
}
/** a then b (both row-vector transforms). */
function compose(a: M, b: M): M {
  const r = (i: number, j: number) => a[i * 3 + 0] * b[0 * 3 + j] + a[i * 3 + 1] * b[1 * 3 + j] + a[i * 3 + 2] * b[2 * 3 + j]
  const out: number[] = []
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out.push(r(i, j))
  for (let j = 0; j < 3; j++) out.push(a[9] * b[j] + a[10] * b[3 + j] + a[11] * b[6 + j] + b[9 + j])
  return out
}
const xf = (m: M, x: number, y: number, z: number): [number, number, number] => [
  x * m[0] + y * m[3] + z * m[6] + m[9],
  x * m[1] + y * m[4] + z * m[7] + m[10],
  x * m[2] + y * m[5] + z * m[8] + m[11],
]

const attr = (tag: string, name: string) => {
  const m = tag.match(new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${name}\\s*=\\s*"([^"]*)"`))
  return m ? m[1] : undefined
}
const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&")

interface Obj {
  verts?: number[]
  tris?: number[]
  components?: { path?: string; id: string; m: M }[]
}

function parseModel(xml: string): { objects: Map<string, Obj>; build: { path?: string; id: string; m: M }[]; metadata: Record<string, string>; unit: string } {
  const objects = new Map<string, Obj>()
  for (const om of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const id = attr(om[1], "id")
    if (!id) continue
    const body = om[2]
    const obj: Obj = {}
    const vs = body.match(/<vertices>([\s\S]*?)<\/vertices>/)
    if (vs) {
      obj.verts = []
      for (const v of vs[1].matchAll(/<vertex\b([^>]*)\/?>/g)) obj.verts.push(Number(attr(v[1], "x")), Number(attr(v[1], "y")), Number(attr(v[1], "z")))
      obj.tris = []
      const ts = body.match(/<triangles>([\s\S]*?)<\/triangles>/)
      if (ts) for (const t of ts[1].matchAll(/<triangle\b([^>]*)\/?>/g)) obj.tris.push(Number(attr(t[1], "v1")), Number(attr(t[1], "v2")), Number(attr(t[1], "v3")))
    }
    const cs = [...body.matchAll(/<component\b([^>]*)\/?>/g)]
    if (cs.length) obj.components = cs.map((c) => ({ id: attr(c[1], "objectid") ?? "", path: attr(c[1], "path"), m: parseTransform(attr(c[1], "transform")) }))
    objects.set(id, obj)
  }
  const build = [...xml.matchAll(/<item\b([^>]*)\/?>/g)].map((i) => ({ id: attr(i[1], "objectid") ?? "", path: attr(i[1], "path"), m: parseTransform(attr(i[1], "transform")) }))
  const metadata: Record<string, string> = {}
  for (const m of xml.matchAll(/<metadata\b([^>]*)>([\s\S]*?)<\/metadata>/g)) {
    const name = attr(m[1], "name")
    if (name && m[2].trim()) metadata[name.replace(/^\w+:/, "")] = unescapeXml(m[2].trim()).slice(0, 500)
  }
  const unit = attr(xml.match(/<model\b([^>]*)>/)?.[1] ?? "", "unit") ?? "millimeter"
  return { objects, build, metadata, unit }
}

/** Archive entries that carry slicer settings or other extras (never applied). */
function ignoredParts(entries: ZipEntry[]): string[] {
  return entries
    .map((e) => e.path)
    .filter((p) => !/\.model$/i.test(p) && !/^_rels\/|\[Content_Types\]\.xml$|\.rels$/i.test(p) && !/thumbnail|\.png$|\.jpe?g$/i.test(p))
}

export class ThreeMfError extends Error {}

export function readThreeMf(buf: Buffer): ThreeMf {
  let entries: ZipEntry[]
  try {
    entries = readZip(buf, { maxEntries: 2000, maxTotalBytes: 1024 * 1024 * 1024, maxEntryBytes: 512 * 1024 * 1024 })
  } catch (e) {
    throw new ThreeMfError(`This 3MF can't be opened (${(e as Error).message}).`)
  }
  const models = new Map<string, ReturnType<typeof parseModel>>()
  for (const e of entries) if (/\.model$/i.test(e.path)) models.set("/" + e.path.replace(/^\/+/, ""), parseModel(e.data.toString("utf8")))
  const rootPath = models.has("/3D/3dmodel.model") ? "/3D/3dmodel.model" : [...models.entries()].find(([, m]) => m.build.length)?.[0]
  if (!rootPath) throw new ThreeMfError("This 3MF has no 3D model in it.")
  const root = models.get(rootPath)!
  const scale = UNIT_MM[root.unit] ?? 1
  const out: number[] = []
  const emit = (path: string, id: string, m: M, depth: number) => {
    if (depth > 16) return
    const obj = models.get(path)?.objects.get(id)
    if (!obj) return
    if (obj.verts && obj.tris) {
      const v = obj.verts
      for (let t = 0; t < obj.tris.length; t += 3) {
        const idx = [obj.tris[t] * 3, obj.tris[t + 1] * 3, obj.tris[t + 2] * 3]
        if (!idx.every((i) => Number.isInteger(i) && i >= 0 && i + 2 < v.length)) continue
        for (const i of idx) {
          const p = xf(m, v[i], v[i + 1], v[i + 2])
          out.push(p[0] * scale, p[1] * scale, p[2] * scale)
        }
      }
    }
    for (const c of obj.components ?? []) emit(c.path ? "/" + c.path.replace(/^\/+/, "") : path, c.id, compose(c.m, m), depth + 1)
  }
  const items = root.build.length ? root.build : [...root.objects.keys()].map((id) => ({ id, path: undefined, m: IDENTITY }))
  for (const it of items) emit(it.path ? "/" + it.path.replace(/^\/+/, "") : rootPath, it.id, it.m, 0)
  if (!out.length) throw new ThreeMfError("This 3MF has no triangles in it.")
  return { triangles: Float32Array.from(out), metadata: root.metadata, unit: root.unit, ignored: ignoredParts(entries) }
}
