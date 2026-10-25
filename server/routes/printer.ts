import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { slicePart, slicePlate } from "../slicer"
import { INTENTS } from "../slicer/intents"
import { toolpathBlob } from "../gcode/toolpath"
import { parseGcodeFile } from "../gcode/parse"
import { analyzeGcode } from "../gcode/analyze"
import { layerPng, type LayerSelector } from "../gcode/render"
import { assertHasDesign, resolveProjectPath } from "../projects/store"
import { isApproved, setApproved } from "../agent/approval"
import type { PrintIntent } from "../../shared/types"
import { jobPlacement, jobView, projectJobs, recoverInterruptedRequests, setProjectIntent } from "../jobs"
import { appendNotice } from "../agent/index"
import { PRINT_REQUEST_RESTART_NOTICE } from "../../shared/types"
import {
  answerPrintRequest,
  recheckPrintRequest,
  reslicePrintRequest,
  cancelPrint,
  createPrintRequest,
  exportPrintFile,
  getPrinterStatus,
  getSnapshot,
  listWebcams,
  listPrintRequests,
  pausePrint,
  restartFirmware,
  resumePrint,
  setApprovalHooks,
  startPrinterPolling,
  testPrinter,
} from "../printer"

// OWNER: slicer/printer agent (see shared/api.md "Slicing + printer")
const PrintRequestBody = z.object({ gcodePath: z.string().min(1), machineId: z.string().optional() })
const IntentOpts = {
  intent: z.enum(["display", "strong", "fast", "draft", "standard"]).optional(),
  overrides: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  // Slice the same thing as the latest slice (its parts, per-part and process overrides); given fields still win.
  reuseLatest: z.boolean().optional(),
}
const SliceBody = z.object({ machineId: z.string().optional(), ...IntentOpts }).optional()
const PlateBody = z
  .object({
    ...IntentOpts,
    machineId: z.string().optional(),
    // Farm: spread plates over these machines, or "idle" for every idle machine.
    machineIds: z.union([z.array(z.string()), z.literal("idle")]).optional(),
    parts: z
      .array(
        z.object({
          partId: z.string().min(1),
          qty: z.number().int().min(1).max(50).optional(),
          overrides: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(), // per-part process settings
        }),
      )
      .optional(),
  })
  .optional()
// approveDesign: the user's Print in the dialog also approves the design revision it was sliced from (U1)
const AnswerBody = z.object({ approved: z.boolean(), bedClear: z.boolean(), machineId: z.string().optional(), approveDesign: z.boolean().optional() })

function badRequest(msg: string) {
  return Object.assign(new Error(msg), { statusCode: 400 })
}

export default async function printerRoutes(app: FastifyInstance) {
  startPrinterPolling()
  // The print dialog's Print approves an unapproved design (user prints only; the designer stays gated by R05).
  setApprovalHooks({ isApproved, approve: (projectId) => setApproved(projectId, true) })
  // Print requests open when the server stopped are gone: their jobs go back to pending, and the timeline says so.
  for (const projectId of recoverInterruptedRequests()) void appendNotice(projectId, PRINT_REQUEST_RESTART_NOTICE).catch(() => {})

  app.post<{ Params: { id: string; partId: string } }>("/api/projects/:id/parts/:partId/slice", async (req) => {
    const body = SliceBody.safeParse(req.body ?? undefined)
    if (!body.success) throw badRequest("body must be {machineId?, intent?: display|strong|fast|draft|standard, overrides?: {key: value}}")
    const b = body.data ?? {}
    assertHasDesign(req.params.id)
    return slicePart(req.params.id, req.params.partId, b.machineId || undefined, { intent: b.intent, overrides: b.overrides, reuseLatest: b.reuseLatest })
  })

  app.get("/api/print-intents", async () => INTENTS)

  // Sliced-toolpath preview + quality issues (see shared/api.md "Print intent + slice preview").
  const gcodeOf = (id: string, rel?: string) => {
    if (!rel || !/\.gcode$/i.test(rel)) throw badRequest("gcode=<path to a .gcode in the project> is required")
    return resolveProjectPath(id, rel)
  }
  app.get<{ Params: { id: string }; Querystring: { gcode?: string } }>("/api/projects/:id/slice-preview", async (req) => {
    const parsed = parseGcodeFile(gcodeOf(req.params.id, req.query.gcode))
    const intent = (parsed.settings.printstudio_intent ?? "standard") as PrintIntent
    return analyzeGcode(parsed, req.query.gcode!, intent)
  })
  app.get<{ Params: { id: string }; Querystring: { gcode?: string; from?: string; to?: string } }>(
    "/api/projects/:id/slice-preview/layers",
    async (req) => {
      const parsed = parseGcodeFile(gcodeOf(req.params.id, req.query.gcode))
      const from = Math.max(0, Number(req.query.from) || 0)
      const to = Math.min(parsed.layers.length - 1, req.query.to != null ? Number(req.query.to) : from + 39, from + 39)
      return parsed.layers.slice(from, to + 1).map(({ index, z, height, segments }) => ({ index, z, height, segments }))
    },
  )
  // The whole plate's toolpath (binary, shared/toolpath.ts) for the 3D Layers view; x-build-ms = parse + encode.
  app.get<{ Params: { id: string }; Querystring: { gcode?: string } }>("/api/projects/:id/slice-preview/toolpath", async (req, reply) => {
    const { blob, ms } = toolpathBlob(gcodeOf(req.params.id, req.query.gcode))
    return reply
      .type("application/octet-stream")
      .header("cache-control", "no-store")
      .header("x-build-ms", String(ms))
      .send(Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength))
  })
  app.get<{ Params: { id: string }; Querystring: { gcode?: string; layer?: string; zoom?: string } }>(
    "/api/projects/:id/slice-preview/image",
    async (req, reply) => {
      const parsed = parseGcodeFile(gcodeOf(req.params.id, req.query.gcode))
      const l = req.query.layer ?? "top"
      const sel: LayerSelector = l === "top" || l === "first" ? l : Math.max(0, Number(l) - 0 || 0)
      const z = req.query.zoom?.split(",").map(Number)
      const zoom = z && z.length === 4 && z.every(Number.isFinite) ? (z as [number, number, number, number]) : undefined
      const png = await layerPng(parsed, sel, { zoom })
      return reply.type("image/png").header("cache-control", "no-store").send(png)
    },
  )

  app.post<{ Params: { id: string } }>("/api/projects/:id/slice-plate", async (req) => {
    const body = PlateBody.safeParse(req.body ?? undefined)
    if (!body.success) throw badRequest('body must be {parts?: {partId, qty?}[], machineId?, machineIds?: string[] | "idle"}')
    assertHasDesign(req.params.id)
    return slicePlate(req.params.id, body.data?.parts, body.data?.machineId, { machineIds: body.data?.machineIds }, {
      intent: body.data?.intent,
      overrides: body.data?.overrides,
      reuseLatest: body.data?.reuseLatest,
    })
  })

  app.get("/api/printer/status", async () => getPrinterStatus())
  app.post("/api/printer/test", async () => testPrinter())
  app.get("/api/printer/webcams", async () => listWebcams())
  // One camera frame, proxied from the printer (the renderer can't reach the printer directly / CORS).
  app.get<{ Querystring: { name?: string } }>("/api/printer/snapshot", async (req, reply) => {
    const snap = await getSnapshot(req.query.name || undefined)
    return reply.type(snap.contentType).header("cache-control", "no-store").header("x-camera", snap.camera).send(snap.data)
  })

  app.post<{ Params: { id: string } }>("/api/projects/:id/print-requests", async (req) => {
    const body = PrintRequestBody.safeParse(req.body)
    if (!body.success) throw badRequest("body must be {gcodePath: string, machineId?: string}")
    assertHasDesign(req.params.id)
    const { request } = await createPrintRequest(req.params.id, body.data.gcodePath, "user", body.data.machineId)
    return request
  })
  // Export-only path: download the current slice to print by hand (G-code), or the part's model (3MF).
  app.get<{ Params: { id: string }; Querystring: { gcode?: string; format?: string } }>("/api/projects/:id/print-file", async (req, reply) => {
    if (!req.query.gcode) throw badRequest("gcode (the slice's path, e.g. build/main.gcode) is required")
    assertHasDesign(req.params.id)
    const f = await exportPrintFile(req.params.id, req.query.gcode, req.query.format === "3mf" ? "3mf" : "gcode")
    return reply
      .type(f.contentType)
      .header("content-disposition", `attachment; filename="${f.filename}"`)
      .header("x-sliced-for", encodeURIComponent(f.machineName))
      .header("cache-control", "no-store")
      .send(f.data)
  })
  // Pending requests (lets a freshly loaded UI re-show a dialog it missed on the WS).
  app.get("/api/print-requests", async () => listPrintRequests())

  app.post<{ Params: { requestId: string } }>("/api/print-requests/:requestId", async (req) => {
    const body = AnswerBody.safeParse(req.body)
    if (!body.success) throw badRequest("body must be {approved: boolean, bedClear: boolean, machineId?: string, approveDesign?: boolean}")
    return answerPrintRequest(req.params.requestId, body.data.approved, body.data.bedClear, body.data.machineId, { approveDesign: body.data.approveDesign })
  })

  // "Check again" in the dialog: re-read the printer (CFS slots) and refresh the request's blockers.
  app.post<{ Params: { requestId: string } }>("/api/print-requests/:requestId/recheck", async (req) => recheckPrintRequest(req.params.requestId))

  // Another machine picked in the dialog: slice the job's inputs for it and swap the request to the new job.
  app.post<{ Params: { requestId: string } }>("/api/print-requests/:requestId/reslice", async (req) => {
    const body = z.object({ machineId: z.string().min(1) }).safeParse(req.body)
    if (!body.success) throw badRequest("body must be {machineId: string}")
    return reslicePrintRequest(req.params.requestId, body.data.machineId)
  })

  // Print jobs (immutable sliced G-code + lifecycle; staleness computed now). See shared/api.md "Print jobs".
  app.get<{ Params: { id: string } }>("/api/projects/:id/jobs", async (req) => projectJobs(req.params.id))
  app.get<{ Params: { id: string; jobId: string } }>("/api/projects/:id/jobs/:jobId", async (req) => {
    const v = await jobView(req.params.id, req.params.jobId)
    if (!v) throw Object.assign(new Error(`no job ${req.params.jobId}`), { statusCode: 404 })
    return v
  })
  app.get<{ Params: { id: string; jobId: string } }>("/api/projects/:id/jobs/:jobId/placement", async (req) => {
    const v = jobPlacement(req.params.id, req.params.jobId)
    if (!v) throw Object.assign(new Error(`no job ${req.params.jobId}`), { statusCode: 404 })
    return v
  })
  app.put<{ Params: { id: string } }>("/api/projects/:id/intent", async (req) => {
    const body = z.object({ intent: z.enum(["display", "strong", "fast", "draft", "standard"]) }).safeParse(req.body)
    if (!body.success) throw badRequest("body must be {intent: display|strong|fast|draft|standard}")
    return { intent: await setProjectIntent(req.params.id, body.data.intent) }
  })

  // Legacy single-printer routes act on the default machine (per-machine: /api/machines/:id/...).
  // MoonrakerError carries statusCode (502/409) which the global error handler uses.
  app.post("/api/printer/pause", () => pausePrint())
  app.post("/api/printer/resume", () => resumePrint())
  app.post("/api/printer/cancel", () => cancelPrint())
  app.post("/api/printer/firmware-restart", () => restartFirmware())
}
