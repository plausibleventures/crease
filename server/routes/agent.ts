import type { FastifyInstance } from "fastify"
import {
  answerPermission,
  answerQuestion,
  coordinator,
  getEvents,
  getStatus,
  getTimeline,
  previewHandoff,
  probeRuntimes,
  sendMessage,
  startHandoff,
  setModel,
  startCodexLogin,
  startGrokLogin,
  loginStatus,
  cancelLogin,
  stop,
  pauseAtQuestion,
  switchSession,
  type InputImage,
} from "../agent/index"
import { listPermissions } from "../agent/permissions"
import { getProject } from "../projects/store"
import { getProfile } from "../agent/profiles"
import { readHandoff } from "../agent/handoff"
import { emit } from "../events"
import { validModel } from "./agent-profiles"
import { listQuestions } from "../agent/questions"
import { getUsage } from "../agent/usage"
import type { HandoffReason, PointAnnotation } from "../../shared/types"

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

const vec3 = (v: unknown): [number, number, number] | null =>
  Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x)) ? (v as [number, number, number]) : null

/** Validate one pinned spot from the viewer; returns null if malformed. Strings are length-capped. */
function cleanAnnotation(raw: unknown): PointAnnotation | null {
  if (!raw || typeof raw !== "object") return null
  const a = raw as Record<string, unknown>
  const point = vec3(a.point)
  const normal = vec3(a.normal)
  if (typeof a.n !== "number" || !point || !normal) return null
  const assemblyPoint = a.assemblyPoint === undefined ? undefined : vec3(a.assemblyPoint)
  if (assemblyPoint === null) return null
  return {
    n: Math.round(a.n),
    partId: typeof a.partId === "string" ? a.partId.slice(0, 100) : null,
    ...(typeof a.instance === "number" ? { instance: Math.round(a.instance) } : {}),
    point,
    ...(assemblyPoint ? { assemblyPoint } : {}),
    normal,
    hint: typeof a.hint === "string" ? a.hint.slice(0, 200) : "",
    note: typeof a.note === "string" ? a.note.slice(0, 2000) : "",
  }
}

const httpErr = (statusCode: number, msg: string) => Object.assign(new Error(msg), { statusCode })
const REASONS: HandoffReason[] = ["switch", "fresh", "idea"]

/** R11g: a designer pick from a request body: profileId (null = the default; absent = keep) + model (checked). */
export async function designerPick(projectId: string, body: { profileId?: unknown; model?: unknown } | undefined): Promise<{ profileId?: string | null; model?: string | null }> {
  const { profileId, model = null } = body ?? {}
  if (profileId !== undefined && profileId !== null && (typeof profileId !== "string" || !getProfile(profileId))) throw httpErr(400, "unknown profile")
  const pid = profileId as string | null | undefined
  const runtime = (pid ? getProfile(pid) : null)?.runtime ?? coordinator.profileFor({ ...(await getProject(projectId)), ...(pid === undefined ? {} : { agentProfileId: null }) }).runtime
  if (model !== null && !validModel(runtime, model)) throw httpErr(400, "unknown model")
  return { ...(pid !== undefined ? { profileId: pid } : {}), model: model as string | null }
}

// OWNER: agent agent. See shared/api.md "Agent".
export default async function agentRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string }; Body: { text?: string; images?: InputImage[]; annotations?: unknown[] } }>(
    "/api/projects/:id/agent/message",
    async (req, reply) => {
      const text = typeof req.body?.text === "string" ? req.body.text : ""
      const raw = Array.isArray(req.body?.images) ? req.body.images : []
      const images = raw.filter((i) => i && IMAGE_TYPES.has(i.mediaType) && typeof i.data === "string" && i.data.length > 0)
      if (images.length !== raw.length) return reply.status(400).send({ error: "images must be {mediaType: png|jpeg|gif|webp, data: base64}" })
      const rawAnn = Array.isArray(req.body?.annotations) ? req.body.annotations : []
      const annotations = rawAnn.map(cleanAnnotation)
      if (annotations.some((a) => !a)) return reply.status(400).send({ error: "annotations must be {n, point[3], normal[3], hint, note, partId?}" })
      if (!text.trim() && !images.length && !annotations.length) return reply.status(400).send({ error: "text, images or annotations is required" })
      return sendMessage(req.params.id, text, images, annotations as PointAnnotation[])
    },
  )

  app.post<{ Params: { id: string }; Body: { sessionId?: string | null } }>("/api/projects/:id/agent/session", async (req, reply) => {
    const sid = req.body?.sessionId
    if (sid !== null && sid !== undefined && typeof sid !== "string") return reply.status(400).send({ error: "sessionId must be a string or null" })
    return switchSession(req.params.id, sid || null)
  })

  app.post<{ Params: { id: string }; Body: { model?: string } }>("/api/projects/:id/agent/model", async (req, reply) => {
    const model = req.body?.model
    // Checked against the project's effective runtime (Claude: the switcher's aliases).
    const runtime = coordinator.profileFor(await getProject(req.params.id)).runtime
    if (!validModel(runtime, model)) return reply.status(400).send({ error: "unknown model" })
    return setModel(req.params.id, model)
  })
  app.post<{ Params: { id: string } }>("/api/projects/:id/agent/stop", async (req) => {
    await stop(req.params.id)
    return { ok: true }
  })

  // Normalized events (R11a): what the timeline renders. Legacy transcripts are migrated on read.
  app.get<{ Params: { id: string } }>("/api/projects/:id/agent/events", async (req) => getEvents(req.params.id))
  // Native/legacy envelopes (raw runtime messages): diagnostics and evals.
  app.get<{ Params: { id: string } }>("/api/projects/:id/agent/timeline", async (req) => getTimeline(req.params.id))

  app.get("/api/agent/runtimes", async () => probeRuntimes())
  // R11d: sign in to Codex for Crease (its own Codex home). Returns the ChatGPT sign-in URL to open.
  app.post("/api/agent/runtimes/codex/login", async () => startCodexLogin())
  app.post("/api/agent/runtimes/grok/login", async () => startGrokLogin())
  // Where the last sign-in stands (the sign-in modal polls this until state leaves "waiting"); DELETE cancels it.
  app.get<{ Params: { kind: string } }>("/api/agent/runtimes/:kind/login", async (req, reply) => {
    const s = loginStatus(req.params.kind)
    return s ?? reply.status(404).send({ error: "no browser sign-in for this runtime" })
  })
  app.delete<{ Params: { kind: string } }>("/api/agent/runtimes/:kind/login", async (req, reply) =>
    cancelLogin(req.params.kind) ? { ok: true } : reply.status(404).send({ error: "no browser sign-in for this runtime" })
  )

  // R11d: permission requests (runtimes with permission callbacks). Re-show after reload; answer Allow once / Deny.
  app.get<{ Params: { id: string } }>("/api/projects/:id/agent/permissions", async (req) => listPermissions(req.params.id))
  app.post<{ Params: { id: string }; Body: { requestId?: string; allow?: unknown } }>("/api/projects/:id/agent/permission", async (req, reply) => {
    const { requestId, allow } = req.body ?? {}
    if (typeof requestId !== "string" || typeof allow !== "boolean") return reply.status(400).send({ error: "requestId and allow (boolean) are required" })
    await answerPermission(req.params.id, requestId, allow)
    return { ok: true }
  })

  // R11g: portable handoff. Preview what the next designer is told (nothing changes), then start the new chat with it
  // (or continue an earlier chat of that designer). The summary is the app's, from project records; see agent/handoff.ts.
  app.post<{ Params: { id: string }; Body: { reason?: unknown; profileId?: unknown; model?: unknown } | undefined }>(
    "/api/projects/:id/agent/handoff/preview",
    async (req) => {
      const reason = (req.body?.reason ?? "switch") as HandoffReason
      if (!REASONS.includes(reason)) throw httpErr(400, "reason must be switch, fresh or idea")
      return previewHandoff(req.params.id, reason, await designerPick(req.params.id, req.body))
    },
  )
  app.post<{ Params: { id: string }; Body: { reason?: unknown; profileId?: unknown; model?: unknown; markdown?: unknown; mode?: unknown; resumeSessionId?: unknown } | undefined }>(
    "/api/projects/:id/agent/handoff",
    async (req) => {
      const b = req.body ?? {}
      const reason = (b.reason ?? "switch") as HandoffReason
      if (reason !== "switch" && reason !== "fresh") throw httpErr(400, "reason must be switch or fresh (ideas: POST /ideas/try-with)")
      if (b.markdown !== undefined && (typeof b.markdown !== "string" || b.markdown.length > 60_000)) throw httpErr(400, "markdown must be a string (up to 60k characters)")
      if (b.mode !== undefined && b.mode !== "new" && b.mode !== "resume") throw httpErr(400, "mode must be new or resume")
      if (b.mode === "resume" && typeof b.resumeSessionId !== "string") throw httpErr(400, "resumeSessionId is required to continue an earlier chat")
      const pick = await designerPick(req.params.id, b)
      const r = await startHandoff(req.params.id, {
        reason,
        ...pick,
        markdown: b.markdown as string | undefined,
        mode: (b.mode as "new" | "resume" | undefined) ?? "new",
        resumeSessionId: b.resumeSessionId as string | undefined,
      })
      emit({ type: "agent.profiles.changed" })
      return r
    },
  )
  app.get<{ Params: { id: string; handoffId: string } }>("/api/projects/:id/agent/handoffs/:handoffId", async (req) => {
    await getProject(req.params.id)
    const rec = readHandoff(req.params.id, req.params.handoffId)
    if (!rec) throw httpErr(404, "handoff not found")
    return rec
  })

  app.get<{ Params: { id: string } }>("/api/projects/:id/agent/status", async (req) => getStatus(req.params.id))

  app.get("/api/agent/usage", async () => getUsage())

  app.get<{ Params: { id: string } }>("/api/projects/:id/agent/questions", async (req) => listQuestions(req.params.id))

  app.post<{ Params: { id: string }; Body: { requestId?: string } }>("/api/projects/:id/agent/pause", async (req, reply) => {
    const requestId = req.body?.requestId
    if (typeof requestId !== "string" || !requestId) return reply.status(400).send({ error: "requestId is required" })
    await pauseAtQuestion(req.params.id, requestId)
    return { ok: true }
  })

  app.post<{ Params: { id: string }; Body: { requestId?: string; answers?: Record<string, unknown>; notes?: Record<string, unknown> } }>(
    "/api/projects/:id/agent/answer",
    async (req, reply) => {
      const { requestId, answers, notes } = req.body ?? {}
      if (typeof requestId !== "string" || !answers || typeof answers !== "object") {
        return reply.status(400).send({ error: "requestId and answers are required" })
      }
      const str = (o: Record<string, unknown> | undefined) =>
        Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => typeof v === "string")) as Record<string, string>
      await answerQuestion(req.params.id, requestId, str(answers), str(notes))
      return { ok: true }
    },
  )
}
