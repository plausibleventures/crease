import type { FastifyInstance } from "fastify"
import type { BuildPackOptions } from "../../shared/types"
import { APP_SKILLS_DIR } from "../agent/prompt"
import { exportPack, importPack, packPreview } from "../pack/index"
import { httpError, updateProject } from "../projects/store"
import { renderPart } from "../cad/index"

// OWNER: build packs (R16). See shared/api.md "Build packs".
const MAX_PACK_BYTES = 512 * 1024 * 1024

const flag = (v: unknown) => v === true || v === "1" || v === "true"

function options(raw: Record<string, unknown> | undefined): BuildPackOptions {
  const r = raw ?? {}
  const opts: BuildPackOptions = { includeGcode: flag(r.includeGcode), includeNotes: flag(r.includeNotes) }
  if (typeof r.license === "string" && r.license.trim()) opts.license = r.license.trim().slice(0, 120)
  if (typeof r.description === "string") opts.description = r.description.slice(0, 2000)
  return opts
}

export default async function packRoutes(app: FastifyInstance) {
  // Raw zip uploads for import (scoped to this plugin).
  app.addContentTypeParser(["application/zip", "application/octet-stream", "application/x-zip-compressed"], { parseAs: "buffer", bodyLimit: MAX_PACK_BYTES }, (_req, body, done) =>
    done(null, body),
  )

  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>("/api/projects/:id/pack/preview", async (req) =>
    packPreview(req.params.id, options(req.query)),
  )

  // Build and download the pack. The chosen licence/description are remembered on the project.
  app.post<{ Params: { id: string }; Body: Record<string, unknown> | undefined }>("/api/projects/:id/pack", async (req, reply) => {
    const opts = options(req.body)
    const patch: { license?: string; description?: string } = {}
    if (opts.license) patch.license = opts.license
    if (opts.description !== undefined) patch.description = opts.description.trim()
    if (Object.keys(patch).length) await updateProject(req.params.id, patch)
    const { zip, filename } = await exportPack(req.params.id, opts)
    return reply
      .header("content-type", "application/zip")
      .header("content-disposition", `attachment; filename="${filename}"`)
      .header("cache-control", "no-store")
      .send(zip)
  })

  app.post<{ Body: Buffer }>("/api/packs/import", { bodyLimit: MAX_PACK_BYTES }, async (req) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw httpError(400, "send the build pack .zip as the request body (content-type application/zip)")
    const r = await importPack(req.body, { appSkillsDir: APP_SKILLS_DIR })
    // Render every part right away (in the background, one at a time): the part pictures and the 3D view appear
    // without the user having to press "Update the preview" first (E2E #2 P3).
    void (async () => {
      for (const p of r.project.parts) await renderPart(r.project.id, p.id).catch((e) => req.log.warn({ err: e, part: p.id }, "render after pack import failed"))
    })()
    return r
  })
}
