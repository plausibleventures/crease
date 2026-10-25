import type { FastifyInstance } from "fastify"
import type { Machine } from "../../shared/types"
import { createMachine, deleteMachine, ensurePracticeMachine, requireMachine, setDefaultMachine, updateMachine } from "../machines"
import {
  cancelPrint,
  getPrinterStatus,
  getSnapshot,
  listMachinesWithStatus,
  listWebcams,
  machineIsBusy,
  pausePrint,
  restartFirmware,
  resumePrint,
  testMachine,
} from "../printer"
import { searchMachineModels } from "../slicer/profiles"
import { crealityWebrtcAnswer, deliverCapture, detectCamera } from "../printer/camera"
import { pinProjectsToCurrentDefault, updateProject } from "../projects/store"
import { emit } from "../events"
import { emitJobsChangedEverywhere } from "../jobs"

// OWNER: slicer/printer agent (see shared/api.md "Machines")
const httpErr = (statusCode: number, msg: string) => Object.assign(new Error(msg), { statusCode })

export default async function machinesRoutes(app: FastifyInstance) {
  app.get("/api/machines", async () => listMachinesWithStatus())

  // Add-machine form: printer models OrcaSlicer has profiles for (vendor, model, bed, nozzles).
  app.get<{ Querystring: { q?: string; limit?: string } }>("/api/machines/models", async (req) =>
    searchMachineModels(req.query.q ?? "", Math.min(500, Number(req.query.limit) || 50)),
  )

  // Probe an address before saving a machine (read-only).
  app.post<{ Body: { host?: string; port?: number; apiKey?: string | null } | undefined }>("/api/machines/test", async (req) => {
    const host = req.body?.host?.trim()
    if (!host) throw httpErr(400, "host required")
    const probe = { ...requireLike(), name: host, connection: { type: "moonraker" as const, host, port: Number(req.body?.port) || 7125, apiKey: req.body?.apiKey ?? null } }
    return testMachine(probe)
  })

  app.post<{ Body: (Partial<Machine> & { isPractice?: boolean }) | undefined }>("/api/machines", async (req) => {
    const body = req.body ?? {}
    // The built-in practice printer (served in-process, works in packaged builds); the form's fields are its own.
    if (body.isPractice) return ensurePracticeMachine({ makeDefault: !!body.isDefault, fields: body })
    return createMachine(body)
  })

  app.put<{ Params: { id: string }; Body: Partial<Machine> | undefined }>("/api/machines/:id", async (req) => {
    const m = updateMachine(req.params.id, req.body ?? {})
    emitJobsChangedEverywhere() // its slicing config may have changed: slices for it can now be out of date
    return m
  })

  app.delete<{ Params: { id: string } }>("/api/machines/:id", async (req) => {
    requireMachine(req.params.id)
    if (machineIsBusy(req.params.id)) throw httpErr(409, "that printer is printing; cancel or wait before removing it")
    deleteMachine(req.params.id)
    emitJobsChangedEverywhere()
    return { ok: true }
  })

  // A project's target machine (project.json `printer`).
  app.put<{ Params: { id: string }; Body: { machineId?: string } | undefined }>("/api/projects/:id/machine", async (req) => {
    const machineId = req.body?.machineId
    if (!machineId) throw httpErr(400, "body must be {machineId}")
    requireMachine(machineId)
    const project = await updateProject(req.params.id, { printer: machineId })
    emit({ type: "project.changed", projectId: req.params.id, paths: ["project.json"] })
    emit({ type: "jobs.changed", projectId: req.params.id }) // slices for the old machine are now out of date
    return project
  })

  app.post<{ Params: { id: string } }>("/api/machines/:id/default", async (req) => {
    requireMachine(req.params.id)
    // the default is for new projects: existing ones keep the printer they use now
    for (const projectId of await pinProjectsToCurrentDefault()) emit({ type: "project.changed", projectId, paths: ["project.json"] })
    setDefaultMachine(req.params.id)
    emitJobsChangedEverywhere()
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>("/api/machines/:id/test", async (req) => testMachine(requireMachine(req.params.id)))
  app.get<{ Params: { id: string } }>("/api/machines/:id/status", async (req) => getPrinterStatus(requireMachine(req.params.id).id))
  app.get<{ Params: { id: string } }>("/api/machines/:id/webcams", async (req) => listWebcams(requireMachine(req.params.id).id))
  app.get<{ Params: { id: string }; Querystring: { name?: string } }>("/api/machines/:id/snapshot", async (req, reply) => {
    const snap = await getSnapshot(req.query.name || undefined, requireMachine(req.params.id).id)
    return reply.type(snap.contentType).header("cache-control", "no-store").header("x-camera", snap.camera).send(snap.data)
  })

  // Camera. WebRTC (Creality): the app sends its SDP offer here; we relay it to the printer and return the answer.
  app.post<{ Params: { id: string }; Body: { offer?: { type: string; sdp: string } } | undefined }>(
    "/api/machines/:id/camera/webrtc",
    async (req) => crealityWebrtcAnswer(requireMachine(req.params.id), req.body?.offer ?? { type: "", sdp: "" }),
  )
  // Re-detect the camera now (read-only probe).
  app.post<{ Params: { id: string } }>("/api/machines/:id/camera/detect", async (req) => {
    const m = requireMachine(req.params.id)
    let cams: Awaited<ReturnType<typeof listWebcams>> = []
    try {
      cams = await listWebcams(m.id)
    } catch {
      /* none */
    }
    return updateMachine(m.id, { camera: await detectCamera(m, cams) }).camera
  })
  // The app's answer to a camera.capture.request event.
  app.post<{ Params: { requestId: string }; Body: { dataUrl?: string; error?: string } | undefined }>("/api/camera/captures/:requestId", async (req) => {
    if (!deliverCapture(req.params.requestId, req.body ?? {})) throw httpErr(404, "no such capture request (timed out?)")
    return { ok: true }
  })

  for (const [action, fn] of [
    ["pause", pausePrint],
    ["resume", resumePrint],
    ["cancel", cancelPrint],
    ["firmware-restart", restartFirmware],
  ] as const) {
    app.post<{ Params: { id: string } }>(`/api/machines/:id/${action}`, async (req) => fn(requireMachine(req.params.id).id))
  }
}

/** A throwaway Machine shape for probing an address that isn't saved yet. */
function requireLike(): Machine {
  return {
    id: "probe",
    name: "printer",
    model: "",
    slicerProfile: "generic",
    buildVolumeMm: [220, 220, 250],
    nozzleMm: 0.4,
    maxNozzleC: 260,
    filamentSlots: 1,
    filaments: [],
    filamentsConfirmed: false,
    tolerances: { slidingFitMm: null, pressFitMm: null, holeCompensationMm: null },
    connection: { type: "none" },
    enabled: true,
    isDefault: false,
  }
}
