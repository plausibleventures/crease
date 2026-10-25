import type { FastifyInstance } from "fastify"
import type { ImportCommitRequest } from "../../shared/types"
import { checkPart, renderPart, setPartOrientation, watchProject } from "../cad/index"
import { commitImport, inspectImport, MAX_IMPORT_BYTES } from "../cad/imports"
import { getProject, httpError } from "../projects/store"

// OWNER: printability (R23). See shared/api.md "Imports + orientation".
export default async function importRoutes(app: FastifyInstance) {
  // Raw file bytes for inspect (scoped to this plugin).
  app.addContentTypeParser(["application/octet-stream", "model/stl", "model/3mf", "text/plain"], { parseAs: "buffer", bodyLimit: MAX_IMPORT_BYTES }, (_req, body, done) =>
    done(null, body),
  )

  app.post<{ Params: { id: string }; Querystring: { name?: string }; Body: Buffer }>(
    "/api/projects/:id/imports/inspect",
    { bodyLimit: MAX_IMPORT_BYTES },
    async (req) => {
      if (!Buffer.isBuffer(req.body)) throw httpError(400, "send the file as the request body (content-type application/octet-stream) with ?name=<file name>")
      return inspectImport(req.params.id, req.query.name ?? "", req.body)
    },
  )

  app.post<{ Params: { id: string }; Body: ImportCommitRequest }>("/api/projects/:id/imports", async (req) => {
    const r = await commitImport(req.params.id, req.body)
    await watchProject(req.params.id)
    // Render + check now (the watcher may have seen the files before the part was registered).
    void renderPart(req.params.id, r.part.id)
      .then((res) => (res.error ? null : checkPart(req.params.id, r.part.id)))
      .catch((e) => app.log.warn(e))
    return r
  })

  app.post<{ Params: { id: string; partId: string }; Body: { rotate?: unknown } | undefined }>("/api/projects/:id/parts/:partId/orientation", async (req) => {
    await getProject(req.params.id)
    await watchProject(req.params.id) // the change is seen, rendered and checked
    return setPartOrientation(req.params.id, req.params.partId, req.body?.rotate as [number, number, number])
  })
}
