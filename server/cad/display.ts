// Part pictures for the app's pages. OpenSCAD renders a part on the dark scheme (renders/<part>-<view>.png); the
// designer looks at those files as they are. Pages ask for `?bg=clear` and get a copy with a transparent background
// (<name>.clear.png next to the render, redone whenever the render is newer), so one picture suits both themes.
import { existsSync, statSync } from "node:fs"
import { readFile, rename, writeFile } from "node:fs/promises"
import { clearBackground } from "../assembly/png"

/** Part renders (renders/<part>-<view>.png) and compare views (build/compare/<key>/out/view-<hash>.png). */
const CLEARABLE = /^(renders\/[^/]+-(iso|front|top|right|bed|back)|build\/compare\/[^/]+\/out\/view-[0-9a-f]+)\.png$/

export const isClearable = (rel: string) => CLEARABLE.test(rel)

/** Artifact URL for a picture shown in the app; part renders get the transparent variant. */
export function displayUrl(projectId: string, rel: string, v: string | number): string {
  const path = rel.split("/").map(encodeURIComponent).join("/")
  return `/api/projects/${encodeURIComponent(projectId)}/artifacts/${path}?v=${v}${isClearable(rel) ? "&bg=clear" : ""}`
}

const pending = new Map<string, Promise<string>>()

/** Absolute path of the transparent copy of a render (made or refreshed on demand). */
export function clearedRender(abs: string): Promise<string> {
  const out = abs.replace(/\.png$/, ".clear.png")
  if (existsSync(out) && statSync(out).mtimeMs >= statSync(abs).mtimeMs) return Promise.resolve(out)
  let p = pending.get(out)
  if (!p) {
    p = (async () => {
      const tmp = `${out}.${process.pid}.tmp`
      await writeFile(tmp, clearBackground(await readFile(abs)))
      await rename(tmp, out)
      return out
    })().finally(() => pending.delete(out))
    pending.set(out, p)
  }
  return p
}
