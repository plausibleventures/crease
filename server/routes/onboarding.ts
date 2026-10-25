import type { FastifyInstance } from "fastify"
import { createReadStream, existsSync } from "node:fs"
import { join } from "node:path"
import { listStarters, getMachineTolerances, openClaudeLogin, setMachineTolerances, setupFirstMachine, starterDir, systemChecks } from "../onboarding"
import { createProjectFromStarter } from "../projects/store"
import { renderPart, watchProject } from "../cad/index"
import { track } from "../telemetry"

// First-run setup + starter gallery. See shared/api.md "Onboarding".
export default async function onboardingRoutes(app: FastifyInstance) {
  app.get("/api/onboarding/checks", async () => systemChecks())
  app.post("/api/onboarding/claude-login", async () => openClaudeLogin())

  app.post<{ Body: { name?: string; host?: string; port?: number; practice?: boolean; model?: string } | undefined }>(
    "/api/onboarding/printer",
    async (req) => setupFirstMachine(req.body ?? {}),
  )

  app.get<{ Querystring: { machine?: string } }>("/api/machines/tolerances", async (req) => getMachineTolerances(req.query.machine))
  app.put<{ Querystring: { machine?: string }; Body: Record<string, unknown> | undefined }>("/api/machines/tolerances", async (req) =>
    setMachineTolerances(req.query.machine, req.body ?? {}),
  )

  app.get("/api/starters", async () => listStarters())

  app.get<{ Params: { id: string } }>("/api/starters/:id/thumbnail.png", async (req, reply) => {
    const d = starterDir(req.params.id)
    const f = d && join(d, "thumbnail.png")
    if (!f || !existsSync(f)) return reply.status(404).send({ error: "no thumbnail" })
    reply.header("Content-Type", "image/png").header("Cache-Control", "max-age=3600")
    return reply.send(createReadStream(f))
  })

  app.post<{ Params: { id: string }; Body: { name?: string } | undefined }>("/api/starters/:id/use", async (req, reply) => {
    const d = starterDir(req.params.id)
    if (!d) return reply.status(404).send({ error: "starter not found" })
    const p = await createProjectFromStarter(d, req.body?.name)
    void watchProject(p.id)
    for (const part of p.parts) void renderPart(p.id, part.id).catch(() => {})
    track("project_created", { from_starter: true })
    return p
  })
}
