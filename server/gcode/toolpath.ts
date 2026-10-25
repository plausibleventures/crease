// The whole plate's toolpath as a binary blob for the 3D Layers view (format: shared/toolpath.ts).
// Built from the cached parse, and cached itself per file + mtime (the 3D view refetches on focus).
import { statSync } from "node:fs"
import { encodeToolpath } from "../../shared/toolpath"
import { parseGcodeFile } from "./parse"

const cache = new Map<string, { mtimeMs: number; blob: Uint8Array; ms: number }>()

export function toolpathBlob(abs: string): { blob: Uint8Array; ms: number } {
  const { mtimeMs } = statSync(abs)
  const hit = cache.get(abs)
  if (hit && hit.mtimeMs === mtimeMs) return hit
  const t0 = performance.now()
  const blob = encodeToolpath(parseGcodeFile(abs))
  const entry = { mtimeMs, blob, ms: Math.round(performance.now() - t0) }
  cache.set(abs, entry)
  if (cache.size > 4) cache.delete(cache.keys().next().value!)
  return entry
}
