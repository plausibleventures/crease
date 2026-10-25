import { readFileSync } from "node:fs"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { getPrint } from "../db"
import { requireMachine } from "../machines"
import { listLessons } from "../agent/lessons"
import { getSnapshot } from "../printer"
import { addPhoto, calibrationReport, decideLesson, forgetLesson, photoPath, projectOutcomes, removePhoto, saveOutcome } from "../outcomes"

// OWNER: feedback (R15, see shared/api.md "Print outcomes + calibration")
const httpErr = (statusCode: number, msg: string) => Object.assign(new Error(msg), { statusCode })

const Measurement = z.object({
  name: z.string().max(200),
  partId: z.string().max(200).nullable().optional(),
  kind: z.enum(["outside", "hole", "other"]),
  expectedMm: z.number().finite(),
  measuredMm: z.number().finite().nullable(),
})
const Fit = z.object({
  name: z.string().max(200),
  result: z.enum(["too_tight", "just_right", "too_loose"]),
  kind: z.enum(["sliding", "press"]).optional(),
  clearanceMm: z.number().finite().min(-1).max(5).nullable().optional(),
})
const OutcomeBody = z.object({
  rating: z.enum(["great", "ok", "problem", "failed"]),
  categories: z.array(z.enum(["didnt_stick", "stringing", "warping", "layer_shift", "spaghetti", "rough_top", "wrong_size", "broke", "other"])).max(9).optional(),
  notes: z.string().max(10_000).nullable().optional(),
  measurements: z.array(Measurement).max(40).optional(),
  fits: z.array(Fit).max(20).optional(),
  photos: z.array(z.string().max(120)).max(12).optional(),
})
const PhotoBody = z.union([
  z.object({ mediaType: z.string(), data: z.string().min(1) }),
  z.object({ fromCamera: z.literal(true) }),
])
const LessonBody = z.object({ action: z.enum(["accept", "dismiss", "undo"]), text: z.string().max(300).optional() })
const CalQuery = z.object({
  machineId: z.string().optional(),
  intent: z.enum(["display", "strong", "fast", "draft", "standard"]).optional(),
  material: z.string().max(40).optional(),
  nozzleMm: z.coerce.number().positive().max(2).optional(),
})

export default async function outcomeRoutes(app: FastifyInstance) {
  app.post<{ Params: { printId: string } }>("/api/prints/:printId/outcome", async (req) => {
    const body = OutcomeBody.safeParse(req.body)
    if (!body.success) throw httpErr(400, `invalid outcome: ${body.error.issues[0]?.message ?? "bad body"}`)
    return saveOutcome(req.params.printId, body.data)
  })

  app.post<{ Params: { printId: string } }>("/api/prints/:printId/photos", async (req) => {
    const body = PhotoBody.safeParse(req.body)
    if (!body.success) throw httpErr(400, "body must be {mediaType, data} or {fromCamera: true}")
    if ("fromCamera" in body.data) {
      const rec = getPrint(req.params.printId)
      if (!rec) throw httpErr(404, "print not found")
      const snap = await getSnapshot(undefined, rec.machineId ?? undefined)
      return addPhoto(req.params.printId, snap.data, snap.contentType)
    }
    const data = Buffer.from(body.data.data.replace(/^data:[^,]*,/, ""), "base64")
    return addPhoto(req.params.printId, data, body.data.mediaType)
  })

  app.get<{ Params: { printId: string; name: string } }>("/api/prints/:printId/photos/:name", async (req, reply) => {
    const f = photoPath(req.params.printId, req.params.name)
    const ext = f.split(".").pop()!.toLowerCase()
    reply.header("Content-Type", ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg").header("Cache-Control", "max-age=86400")
    return reply.send(readFileSync(f))
  })

  app.delete<{ Params: { printId: string; name: string } }>("/api/prints/:printId/photos/:name", async (req) => {
    removePhoto(req.params.printId, req.params.name)
    return { ok: true }
  })

  app.post<{ Params: { printId: string } }>("/api/prints/:printId/lesson", async (req) => {
    const body = LessonBody.safeParse(req.body)
    if (!body.success) throw httpErr(400, 'body must be {action: "accept"|"dismiss"|"undo", text?}')
    return decideLesson(req.params.printId, body.data.action, body.data.text)
  })

  app.get<{ Params: { id: string } }>("/api/projects/:id/outcomes", async (req) => projectOutcomes(req.params.id))

  app.get("/api/calibration", async (req) => {
    const q = CalQuery.safeParse(req.query)
    if (!q.success) throw httpErr(400, "invalid query: machineId?, intent?, material?, nozzleMm?")
    return calibrationReport(q.data)
  })

  app.get<{ Params: { id: string } }>("/api/machines/:id/lessons", async (req) => listLessons(requireMachine(req.params.id).id))
  app.delete<{ Params: { id: string }; Body: { line?: string } | undefined }>("/api/machines/:id/lessons", async (req) => {
    const id = requireMachine(req.params.id).id
    const line = req.body?.line
    if (!line) throw httpErr(400, "body must be {line}")
    if (!forgetLesson(id, line)) throw httpErr(404, "lesson not found")
    return listLessons(id)
  })
}
