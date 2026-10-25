import type { FastifyInstance } from "fastify"
import { watchProject } from "../cad/index"
import { emit } from "../events"
import { deleteProjectFile, listProjectFiles, makeProjectFolder, MAX_FILE_BYTES, renameProjectFile, uploadProjectFile } from "../projects/files"
import { getProject, httpError } from "../projects/store"

// The sidebar's Files section. See shared/api.md "Projects" (files) and server/projects/files.ts for the rules.
export default async function fileRoutes(app: FastifyInstance) {
  // Raw bytes for uploads (scoped to this plugin).
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: MAX_FILE_BYTES }, (_req, body, done) => done(null, body))

  /**
   * After a change: getProject syncs parts/*.scad into project.json (a new .scad becomes a part, a deleted one stops
   * being one), and the renderer refetches the project. The watcher also reports the files and re-renders .scad.
   */
  const changed = async (projectId: string, paths: string[]) => {
    const touchesParts = paths.some((p) => /^parts\/[^/]*\.(scad|blend\.py)$/i.test(p) || p === "parts")
    await getProject(projectId)
    emit({ type: "project.changed", projectId, paths: touchesParts ? [...paths, "project.json"] : paths })
  }

  app.get<{ Params: { id: string } }>("/api/projects/:id/files", async (req) => listProjectFiles(req.params.id))

  app.post<{ Params: { id: string }; Querystring: { path?: string; replace?: string }; Body: Buffer }>(
    "/api/projects/:id/files/upload",
    { bodyLimit: MAX_FILE_BYTES },
    async (req) => {
      if (!Buffer.isBuffer(req.body)) throw httpError(400, "send the file as the request body (content-type application/octet-stream) with ?path=<folder/name>")
      await getProject(req.params.id) // 404 if missing
      await watchProject(req.params.id) // a new .scad is rendered and checked
      const path = await uploadProjectFile(req.params.id, req.query.path ?? "", req.body, { replace: req.query.replace === "1" })
      await changed(req.params.id, [path])
      return { path }
    },
  )

  app.post<{ Params: { id: string }; Body: { path?: string } | undefined }>("/api/projects/:id/files/folder", async (req) => {
    await getProject(req.params.id)
    const path = await makeProjectFolder(req.params.id, req.body?.path ?? "")
    await changed(req.params.id, [path])
    return { path }
  })

  app.post<{ Params: { id: string }; Body: { from?: string; to?: string } | undefined }>("/api/projects/:id/files/rename", async (req) => {
    await getProject(req.params.id)
    await watchProject(req.params.id)
    const from = req.body?.from ?? ""
    const path = await renameProjectFile(req.params.id, from, req.body?.to ?? "")
    await changed(req.params.id, [from, path])
    return { path }
  })

  app.delete<{ Params: { id: string }; Querystring: { path?: string } }>("/api/projects/:id/files", async (req) => {
    await getProject(req.params.id)
    await watchProject(req.params.id)
    const path = req.query.path ?? ""
    await deleteProjectFile(req.params.id, path)
    await changed(req.params.id, [path])
    return { ok: true }
  })
}
