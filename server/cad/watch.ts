// File watcher per project: on .scad / .py (Blender part) changes emit project.changed and re-render + check affected parts.
import { watch, type FSWatcher } from "chokidar"
import { join, relative, sep } from "node:path"
import { emit } from "../events"
import { getProject, projectDir } from "../projects/store"
import { checkPart, partDependencies, renderPart } from "./index"

const DEBOUNCE_MS = 300
const watchers = new Map<string, { watcher: FSWatcher; ready: Promise<void> }>()

/** Start watching a project folder (idempotent). Resolves once the watcher is ready. */
export function watchProject(projectId: string): Promise<void> {
  const existing = watchers.get(projectId)
  if (existing) return existing.ready
  const root = projectDir(projectId)
  const watcher = watch(root, {
    ignoreInitial: true,
    ignored: (p: string) => {
      const rel = relative(root, p)
      const top = rel.split(sep)[0]
      return top === ".git" || top === "build" || top === "renders" || top === ".studio" || top === "node_modules"
    },
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  })
  const pending = new Set<string>()
  let timer: NodeJS.Timeout | null = null
  const flush = () => {
    timer = null
    const paths = [...pending]
    pending.clear()
    void onChanged(projectId, paths)
  }
  const onFs = (p: string) => {
    pending.add(relative(root, p).split(sep).join("/"))
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, DEBOUNCE_MS)
  }
  watcher.on("add", onFs).on("change", onFs).on("unlink", onFs)
  const ready = new Promise<void>((r) => watcher.once("ready", () => r()))
  watchers.set(projectId, { watcher, ready })
  return ready
}

export async function unwatchProject(projectId?: string): Promise<void> {
  const ids = projectId ? [projectId] : [...watchers.keys()]
  for (const id of ids) {
    const w = watchers.get(id)
    watchers.delete(id)
    await w?.watcher.close()
  }
}

async function onChanged(projectId: string, paths: string[]) {
  emit({ type: "project.changed", projectId, paths })
  // Job staleness is computed from the files on read: any source change (a part, a lib include, assembly.json,
  // project.json parts/qty/intent) can make the latest slice out of date, so the toolbar refetches now.
  emit({ type: "jobs.changed", projectId })
  // .scad sources, Blender part scripts (parts/*.blend.py) and the lib/*.py modules they import
  const scadChanged = paths.filter((p) => p.endsWith(".scad") || p.endsWith(".py"))
  if (!scadChanged.length) return
  try {
    const root = projectDir(projectId)
    const project = await getProject(projectId) // also syncs new parts/*.scad into project.json
    const changedAbs = new Set(scadChanged.map((p) => join(root, p)))
    for (const part of project.parts) {
      const deps = await partDependencies(join(root, part.file), root)
      if (!deps.some((d) => changedAbs.has(d))) continue
      const r = await renderPart(projectId, part.id) // with the part's saved Customizer overrides
      if (!r.error) await checkPart(projectId, part.id)
    }
  } catch (e) {
    console.error(`[watch] re-render failed for ${projectId}:`, e)
  }
}
