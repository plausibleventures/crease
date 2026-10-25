// Keeps the catalog fresh from server events (renders refresh thumbnails, checks refresh summaries).
import { onEvent } from "../events"
import { getProject } from "../projects/store"
import { upsertProject } from "."

let installed = false

export function installCatalogHooks() {
  if (installed) return
  installed = true
  onEvent((e) => {
    if (e.type !== "render.done" && e.type !== "check.done") return
    getProject(e.projectId)
      .then((p) => upsertProject(p))
      .catch((err) => console.error("[catalog] refresh failed", err))
  })
}
