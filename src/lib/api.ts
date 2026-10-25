import type {
  AboutInfo,
  ProjectPatch,
  ProjectTrashResult,
  AgentBilling,
  ProjectFilesResult,
  AgentConnectionResult,
  AgentModelList,
  AgentFailure,
  AgentProfile,
  AgentProfilesResponse,
  AgentProfileView,
  AgentRuntimeProbe,
  ProjectAgentChoice,
  RuntimeLoginStatus,
  HandoffPreview,
  HandoffRecord,
  MotionCheck,
  PlanUsage,
  AgentAnswers,
  AgentPermissionRequest,
  AgentQuestionRequest,
  AgentEnvelope,
  AgentEventEnvelope,
  AssemblyInfo,
  SourcingSettings,
  SourcingStoreInfo,
  CatalogProject,
  Checkpoint,
  IdeaComparison,
  IdeaList,
  PrintIntent,
  ProjectJobs,
  ProjectValidity,
  ProjectOverview,
  AgentConfigStatus,
  PrintJobView,
  PlatePlacement,
  PrintIntentInfo,
  SlicePreviewSummary,
  ToolpathLayer,
  Machine,
  MachineWithStatus,
  SetupCheck,
  Starter,
  CatalogSession,
  PartLatest,
  PointAnnotation,
  PrintRecord,
  PrintResult,
  PrintOutcome,
  PrintOutcomeInput,
  CalibrationReport,
  PrinterLesson,
  CheckReport,
  PrinterStatus,
  PrintRequest,
  Project,
  SyncSnapshot,
  ProjectSummary,
  RenderResult,
  ScadParameter,
  SharedParamNote,
  SecretRef,
  SecretStatus,
  SecretStoreInfo,
  Settings,
  SliceResult,
  PlateSliceResult,
  ProjectBom,
  PartsBinItem,
  BuildPackOptions,
  BuildPackPreview,
  BuildPackImportResult,
  ImportCommitRequest,
  ImportCommitResult,
  ImportInspection,
} from "@shared/types"

/** A printer model for the Add machine picker (normalised from GET /api/machines/models). */
export interface MachineModel {
  id: string // slicer profile key (Machine.slicerProfile)
  model: string
  buildVolumeMm: [number, number, number] | null // null = unknown
  nozzlesMm: number[] // nozzle sizes the model has profiles for
  nozzleMm: number // the one we use by default (0.4 when available)
  filamentSlots: number // colour slots; the catalogue doesn't say, so 1 unless we know better
  maxNozzleC?: number
  vendor?: string
  klipper?: boolean // Klipper firmware per OrcaSlicer's preset (Moonraker-capable); undefined = unknown
}

// Multi-colour units the catalogue can't tell us about (model name -> slots).
const KNOWN_SLOTS: [RegExp, number][] = [[/sparkx/i, 4]]

function toModel(x: Record<string, unknown>): MachineModel {
  const raw = x.nozzleMm
  const nozzles = (Array.isArray(raw) ? raw : typeof raw === "number" ? [raw] : []).filter((n): n is number => typeof n === "number")
  const model = String(x.model ?? x.preset ?? "Printer")
  const bv = Array.isArray(x.buildVolumeMm) && x.buildVolumeMm.length === 3 ? (x.buildVolumeMm as [number, number, number]) : null
  return {
    id: String(x.slicerProfile ?? x.id ?? model),
    model,
    buildVolumeMm: bv,
    nozzlesMm: nozzles.length ? nozzles : [0.4],
    nozzleMm: nozzles.includes(0.4) || !nozzles.length ? 0.4 : nozzles[0],
    filamentSlots:
      typeof x.filamentSlots === "number" ? x.filamentSlots : (KNOWN_SLOTS.find(([re]) => re.test(model))?.[1] ?? 1),
    ...(typeof x.maxNozzleC === "number" ? { maxNozzleC: x.maxNozzleC } : {}),
    ...(typeof x.vendor === "string" ? { vendor: x.vendor } : {}),
    ...(typeof x.klipper === "boolean" ? { klipper: x.klipper } : {}),
  }
}

export interface Tolerances {
  slidingFitMm: number | null
  pressFitMm: number | null
  holeCompensationMm: number | null
}

export interface InputImage {
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"
  data: string // base64 without data: prefix
}

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (e) {
    throw new ApiError(`Server unreachable (${(e as Error).message})`, 0)
  }
  const text = await res.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  if (!res.ok) {
    const msg =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : typeof data === "string" && data && !data.startsWith("<")
          ? data
          : `${res.status} ${res.statusText}`
    throw new ApiError(msg, res.status)
  }
  return data as T
}

const enc = encodeURIComponent
const p = (id: string) => `/api/projects/${enc(id)}`

export const api = {
  // projects
  listProjects: () => request<ProjectSummary[]>("GET", "/api/projects"),
  createProject: (name: string) => request<Project>("POST", "/api/projects", { name }),
  getProject: (id: string) => request<Project>("GET", p(id)),
  // U4: rename / tags, duplicate, move to the Trash
  patchProject: (id: string, patch: ProjectPatch) => request<Project>("PATCH", p(id), patch),
  duplicateProject: (id: string, name?: string) => request<Project>("POST", `${p(id)}/duplicate`, name ? { name } : {}),
  trashProject: (id: string) => request<ProjectTrashResult>("DELETE", p(id)),
  readFile: (id: string, path: string) =>
    request<{ path: string; content: string }>("GET", `${p(id)}/file?path=${enc(path)}`),
  writeFile: (id: string, path: string, content: string) =>
    request<{ ok: true }>("PUT", `${p(id)}/file`, { path, content }),
  parameters: (id: string, partId: string) =>
    request<ScadParameter[]>("GET", `${p(id)}/parts/${enc(partId)}/parameters`),
  /** the part's saved Customizer values (every render/check/slice uses them; a render with params sets them) */
  partOverrides: (id: string, partId: string) =>
    request<{ overrides: Record<string, number | string | boolean> | null; notes?: SharedParamNote[] }>("GET", `${p(id)}/parts/${enc(partId)}/overrides`),
  /** forget the "parts had different values" notes of these shared settings (all when omitted) */
  dismissSharedNotes: (id: string, names?: string[]) => request<{ ok: true }>("POST", `${p(id)}/shared-notes/dismiss`, names ? { names } : {}),
  render: (id: string, partId: string, params?: Record<string, number | string | boolean>) =>
    request<RenderResult>("POST", `${p(id)}/parts/${enc(partId)}/render`, params ? { params } : {}),
  latest: (id: string, partId: string) => request<PartLatest>("GET", `${p(id)}/parts/${enc(partId)}/latest`),
  check: (id: string, partId: string) =>
    request<CheckReport>("POST", `${p(id)}/parts/${enc(partId)}/check`, {}),
  checkpoints: (id: string) => request<{ branch: string; checkpoints: Checkpoint[] }>("GET", `${p(id)}/checkpoints`),
  restoreCheckpoint: (id: string, commit: string) =>
    request<{ commit: string; restored: string }>("POST", `${p(id)}/checkpoints/${enc(commit)}/restore`, {}),
  createVariant: (id: string, fromCommit?: string) =>
    request<{ branch: string; sessionId: string | null; title: string }>("POST", `${p(id)}/variants`, fromCommit ? { fromCommit } : {}),
  activateSession: (id: string, sessionId: string) =>
    request<{ sessionId: string; branch: string; switched: boolean; savedWork: boolean }>(
      "POST",
      `${p(id)}/sessions/${enc(sessionId)}/activate`,
      {},
    ),
  checkpoint: (id: string, message: string) =>
    request<{ commit: string }>("POST", `${p(id)}/checkpoints`, { message }),
  // ideas + comparison (R22)
  ideas: (id: string) => request<IdeaList>("GET", `${p(id)}/ideas`),
  renameIdea: (id: string, branch: string, name: string) => request<IdeaList>("PATCH", `${p(id)}/ideas/${enc(branch)}`, { name }),
  activateIdea: (id: string, branch: string) =>
    request<{ branch: string; sessionId: string | null; switched: boolean; savedWork: boolean }>("POST", `${p(id)}/ideas/${enc(branch)}/activate`, {}),
  compare: (id: string, a: string, b: string) => request<IdeaComparison>("GET", `${p(id)}/compare?a=${enc(a)}&b=${enc(b)}`),

  // assembly
  assembly: (id: string) => request<AssemblyInfo>("GET", `${p(id)}/assembly`),
  sourcingStores: () =>
    request<{ stores: SourcingStoreInfo[]; countries: string[]; defaults: SourcingSettings }>("GET", "/api/sourcing/stores"),
  buildAssemblyGuide: (id: string) => request<{ guideUrl: string; steps: number }>("POST", `${p(id)}/assembly/guide`, {}),
  checkMotion: (id: string) => request<MotionCheck>("POST", `${p(id)}/assembly/check-motion`, {}),
  // R07: freshness of every derived artifact (computed on read)
  validity: (id: string) => request<ProjectValidity>("GET", `${p(id)}/validity`),
  // R12: project overview (aggregate + next action) and the overview's "Approve the design"
  overview: (id: string) => request<ProjectOverview>("GET", `${p(id)}/overview`),
  // R09: the project's own assistant settings (off until the user turns them on)
  agentConfig: (id: string) => request<AgentConfigStatus>("GET", `${p(id)}/agent-config`),
  enableAgentConfig: (id: string, paths?: string[]) =>
    request<{ enabled: string[]; skipped: string[] }>("POST", `${p(id)}/agent-config/enable`, paths ? { paths } : {}),
  disableAgentConfig: (id: string) => request<{ ok: true }>("POST", `${p(id)}/agent-config/disable`, {}),
  // R09: Blender part scripts that came in a build pack (off until the user allows them)
  allowSculptScripts: (id: string) => request<{ allowed: string[] }>("POST", `${p(id)}/sculpt-scripts/allow`, {}),
  setApproval: (id: string, approved: boolean) => request<{ approved: boolean }>("POST", `${p(id)}/approval`, { approved }),
  // bill of materials (R17)
  bom: (id: string) => request<ProjectBom>("GET", `${p(id)}/bom`),
  setHave: (id: string, key: string, have: boolean | null) => request<ProjectBom>("PUT", `${p(id)}/bom/have`, { key, have }),
  partsBin: () => request<PartsBinItem[]>("GET", "/api/parts-bin"),
  setInBin: (key: string, name: string, inBin: boolean) => request<PartsBinItem[]>("PUT", "/api/parts-bin", { key, name, inBin }),
  // build packs (R16)
  packPreview: (id: string, o: BuildPackOptions = {}) => {
    const q = new URLSearchParams({ includeGcode: o.includeGcode ? "1" : "0", includeNotes: o.includeNotes ? "1" : "0" })
    if (o.license) q.set("license", o.license)
    return request<BuildPackPreview>("GET", `${p(id)}/pack/preview?${q}`)
  },
  exportPack: (id: string, o: BuildPackOptions) => downloadPost(`${p(id)}/pack`, o),
  // R23: geometry import (STL / 3MF / SCAD) + orientation
  inspectImport: async (id: string, file: File): Promise<ImportInspection> => {
    let res: Response
    try {
      res = await fetch(`${p(id)}/imports/inspect?name=${enc(file.name)}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file })
    } catch (e) {
      throw new ApiError(`Server unreachable (${(e as Error).message})`, 0)
    }
    const data = (await res.json().catch(() => null)) as (ImportInspection & { error?: string }) | null
    if (!res.ok) throw new ApiError(data?.error ?? `${res.status} ${res.statusText}`, res.status)
    return data as ImportInspection
  },
  // sidebar Files section (shared/api.md "Projects")
  listFiles: (id: string) => request<ProjectFilesResult>("GET", `${p(id)}/files`),
  uploadFile: async (id: string, path: string, file: Blob, replace = false): Promise<{ path: string }> => {
    let res: Response
    try {
      res = await fetch(`${p(id)}/files/upload?path=${enc(path)}${replace ? "&replace=1" : ""}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: file,
      })
    } catch (e) {
      throw new ApiError(`Server unreachable (${(e as Error).message})`, 0)
    }
    const data = (await res.json().catch(() => null)) as { path?: string; error?: string } | null
    if (!res.ok) throw new ApiError(data?.error ?? (res.status === 413 ? "That file is over 100 MB" : `${res.status} ${res.statusText}`), res.status)
    return { path: data?.path ?? path }
  },
  makeFolder: (id: string, path: string) => request<{ path: string }>("POST", `${p(id)}/files/folder`, { path }),
  renameFile: (id: string, from: string, to: string) => request<{ path: string }>("POST", `${p(id)}/files/rename`, { from, to }),
  deleteFile: (id: string, path: string) => request<{ ok: true }>("DELETE", `${p(id)}/files?path=${enc(path)}`),
  commitImport: (id: string, req: ImportCommitRequest) => request<ImportCommitResult>("POST", `${p(id)}/imports`, req),
  setOrientation: (id: string, partId: string, rotate: [number, number, number]) =>
    request<{ file: string; rotate: [number, number, number] }>("POST", `${p(id)}/parts/${enc(partId)}/orientation`, { rotate }),

  importPack: async (file: Blob): Promise<BuildPackImportResult> => {
    let res: Response
    try {
      res = await fetch("/api/packs/import", { method: "POST", headers: { "content-type": "application/zip" }, body: file })
    } catch (e) {
      throw new ApiError(`Server unreachable (${(e as Error).message})`, 0)
    }
    const data = (await res.json().catch(() => null)) as (BuildPackImportResult & { error?: string }) | null
    if (!res.ok) throw new ApiError(data?.error ?? `${res.status} ${res.statusText}`, res.status)
    return data as BuildPackImportResult
  },

  // agent
  sendMessage: (id: string, text: string, images?: InputImage[], annotations?: PointAnnotation[]) =>
    request<{ sessionId: string }>("POST", `${p(id)}/agent/message`, {
      text,
      ...(images?.length ? { images } : {}),
      ...(annotations?.length ? { annotations } : {}),
    }),
  switchSession: (id: string, sessionId: string | null) =>
    request<{ sessionId: string | null }>("POST", `${p(id)}/agent/session`, { sessionId }),
  sessions: (id: string) => request<CatalogSession[]>("GET", `${p(id)}/sessions`),

  // catalog
  catalog: (opts: { q?: string; tag?: string } = {}) => {
    const qs = new URLSearchParams()
    if (opts.q) qs.set("q", opts.q)
    if (opts.tag) qs.set("tag", opts.tag)
    const s = qs.toString()
    return request<CatalogProject[]>("GET", `/api/catalog${s ? `?${s}` : ""}`)
  },
  catalogTags: () => request<{ tag: string; count: number }[]>("GET", "/api/catalog/tags"),
  getPrint: (printId: string) => request<PrintRecord>("GET", `/api/prints/${enc(printId)}`),
  listPrints: (projectId: string) => request<PrintRecord[]>("GET", `/api/prints?projectId=${enc(projectId)}`),
  setPrintResult: (printId: string, body: { result: PrintResult; notes: string | null }) =>
    request<PrintRecord>("POST", `/api/prints/${enc(printId)}`, body),
  // print outcomes + calibration (R15)
  saveOutcome: (printId: string, body: PrintOutcomeInput) => request<PrintRecord>("POST", `/api/prints/${enc(printId)}/outcome`, body),
  addPrintPhoto: (printId: string, body: { mediaType: string; data: string } | { fromCamera: true }) =>
    request<{ name: string; url: string }>("POST", `/api/prints/${enc(printId)}/photos`, body),
  removePrintPhoto: (printId: string, name: string) => request<{ ok: true }>("DELETE", `/api/prints/${enc(printId)}/photos/${enc(name)}`),
  printPhotoUrl: (printId: string, name: string) => `/api/prints/${enc(printId)}/photos/${enc(name)}`,
  decideLesson: (printId: string, action: "accept" | "dismiss" | "undo", text?: string) =>
    request<PrintRecord>("POST", `/api/prints/${enc(printId)}/lesson`, { action, ...(text != null ? { text } : {}) }),
  projectOutcomes: (id: string) => request<PrintOutcome[]>("GET", `${p(id)}/outcomes`),
  calibration: (q: { machineId: string; intent?: PrintIntent; material?: string }) => {
    const qs = new URLSearchParams({ machineId: q.machineId, ...(q.intent ? { intent: q.intent } : {}), ...(q.material ? { material: q.material } : {}) })
    return request<CalibrationReport>("GET", `/api/calibration?${qs}`)
  },
  machineLessons: (machineId: string) => request<PrinterLesson[]>("GET", `/api/machines/${enc(machineId)}/lessons`),
  removeMachineLesson: (machineId: string, line: string) => request<PrinterLesson[]>("DELETE", `/api/machines/${enc(machineId)}/lessons`, { line }),
  stopAgent: (id: string) => request<{ ok: true }>("POST", `${p(id)}/agent/stop`, {}),
  /** Normalized agent events of the active session (what the timeline renders). */
  events: (id: string) => request<AgentEventEnvelope[]>("GET", `${p(id)}/agent/events`),
  /** Native runtime messages (diagnostics). */
  timeline: (id: string) => request<AgentEnvelope[]>("GET", `${p(id)}/agent/timeline`),
  agentUsage: () => request<{ billing: AgentBilling; usage: PlanUsage | null }>("GET", "/api/agent/usage"),
  agentQuestions: (id: string) => request<AgentQuestionRequest[]>("GET", `${p(id)}/agent/questions`),
  answerQuestion: (id: string, requestId: string, answers: AgentAnswers, notes?: Record<string, string>) =>
    request<{ ok: true }>("POST", `${p(id)}/agent/answer`, { requestId, answers, notes }),
  /** Pause the designer at a question: its turn ends, the question stays open (paused). */
  pauseAtQuestion: (id: string, requestId: string) => request<{ ok: true }>("POST", `${p(id)}/agent/pause`, { requestId }),
  agentPermissions: (id: string) => request<AgentPermissionRequest[]>("GET", `${p(id)}/agent/permissions`),
  answerPermission: (id: string, requestId: string, allow: boolean) => request<{ ok: true }>("POST", `${p(id)}/agent/permission`, { requestId, allow }),
  agentStatus: (id: string) =>
    request<{ running: boolean; sessionId: string | null; costUsd: number }>("GET", `${p(id)}/agent/status`),

  // slicing + printer
  // reuseLatest: slice the same thing as the latest slice (its per-part and process overrides, plate composition)
  slice: (id: string, partId: string, machineId?: string | null, intent?: PrintIntent, reuseLatest?: boolean) =>
    request<SliceResult & { intent?: PrintIntent; preview?: SlicePreviewSummary }>("POST", `${p(id)}/parts/${enc(partId)}/slice`, {
      ...(machineId ? { machineId } : {}),
      ...(intent ? { intent } : {}),
      ...(reuseLatest ? { reuseLatest } : {}),
    }),
  slicePlate: (id: string, parts?: { partId: string; qty?: number }[], machineId?: string | null, intent?: PrintIntent, reuseLatest?: boolean) =>
    request<PlateSliceResult & { intent?: PrintIntent; preview?: SlicePreviewSummary; plates: { preview?: SlicePreviewSummary }[] }>(
      "POST",
      `${p(id)}/slice-plate`,
      { ...(parts ? { parts } : {}), ...(machineId ? { machineId } : {}), ...(intent ? { intent } : {}), ...(reuseLatest ? { reuseLatest } : {}) },
    ),
  printIntents: () => request<PrintIntentInfo[]>("GET", "/api/print-intents"),
  slicePreview: (id: string, gcode: string) =>
    request<SlicePreviewSummary>("GET", `${p(id)}/slice-preview?gcode=${enc(gcode)}`),
  sliceLayers: (id: string, gcode: string, from: number, to: number) =>
    request<ToolpathLayer[]>("GET", `${p(id)}/slice-preview/layers?gcode=${enc(gcode)}&from=${from}&to=${to}`),
  printerStatus: () => request<PrinterStatus>("GET", "/api/printer/status"),
  printerTest: () => request<{ ok: boolean; info?: unknown; error?: string }>("POST", "/api/printer/test", {}),
  listPrintRequests: () => request<PrintRequest[]>("GET", "/api/print-requests"),
  createPrintRequest: (id: string, gcodePath: string, machineId?: string | null) =>
    request<PrintRequest>("POST", `${p(id)}/print-requests`, { gcodePath, ...(machineId ? { machineId } : {}) }),
  reslicePrintRequest: (requestId: string, machineId: string) =>
    request<PrintRequest>("POST", `/api/print-requests/${enc(requestId)}/reslice`, { machineId }),
  projectJobs: (id: string) => request<ProjectJobs>("GET", `${p(id)}/jobs`),
  projectJob: (id: string, jobId: string) => request<PrintJobView>("GET", `${p(id)}/jobs/${enc(jobId)}`),
  jobPlacement: (id: string, jobId: string) => request<PlatePlacement>("GET", `${p(id)}/jobs/${enc(jobId)}/placement`),
  syncSnapshot: (projectId?: string | null) =>
    request<SyncSnapshot>("GET", `/api/sync/snapshot${projectId ? `?projectId=${enc(projectId)}` : ""}`),
  setProjectIntent: (id: string, intent: PrintIntent) => request<{ intent: PrintIntent }>("PUT", `${p(id)}/intent`, { intent }),
  recheckPrintRequest: (requestId: string) => request<PrintRequest>("POST", `/api/print-requests/${enc(requestId)}/recheck`, {}),
  resolvePrintRequest: (requestId: string, approved: boolean, bedClear: boolean, machineId?: string | null, approveDesign?: boolean) =>
    request<{ ok: boolean; filename?: string }>("POST", `/api/print-requests/${enc(requestId)}`, {
      approved,
      bedClear,
      ...(machineId ? { machineId } : {}),
      ...(approveDesign ? { approveDesign: true } : {}),
    }),

  // machines (printer farm)
  machines: () => request<MachineWithStatus[]>("GET", "/api/machines"),
  createMachine: (m: Partial<Machine>) => request<Machine>("POST", "/api/machines", m),
  updateMachine: (id: string, m: Partial<Machine>) => request<Machine>("PUT", `/api/machines/${enc(id)}`, m),
  deleteMachine: (id: string) => request<{ ok: boolean }>("DELETE", `/api/machines/${enc(id)}`),
  setDefaultMachine: (id: string) => request<{ ok: boolean }>("POST", `/api/machines/${enc(id)}/default`, {}),
  testMachine: (id: string) =>
    request<{ ok: boolean; info?: { hostname?: string; software_version?: string; state?: string }; error?: string }>(
      "POST",
      `/api/machines/${enc(id)}/test`,
      {},
    ),
  /** Probe an address before saving a printer (read-only). */
  testAddress: (host: string, port: number) =>
    request<{ ok: boolean; info?: { hostname?: string; software_version?: string; state?: string }; error?: string }>("POST", "/api/machines/test", {
      host,
      port,
    }),
  machineAction: (id: string, action: "pause" | "resume" | "cancel") =>
    request<{ ok: boolean }>("POST", `/api/machines/${enc(id)}/${action}`, {}),
  /** Restart a shut-down printer's firmware (only while status.firmware is "shutdown" or "error"). */
  restartFirmware: (id: string) => request<{ ok: boolean }>("POST", `/api/machines/${enc(id)}/firmware-restart`, {}),
  machineSnapshotUrl: (id: string, t = Date.now()) => `/api/machines/${enc(id)}/snapshot?t=${t}`,
  /** "Save print file": download the current slice (G-code) or the part's 3MF model; returns the saved file name. */
  savePrintFile: async (projectId: string, gcodePath: string, format: "gcode" | "3mf" = "gcode"): Promise<string> => {
    let res: Response
    try {
      res = await fetch(`${p(projectId)}/print-file?gcode=${enc(gcodePath)}${format === "3mf" ? "&format=3mf" : ""}`)
    } catch (e) {
      throw new ApiError(`Server unreachable (${(e as Error).message})`, 0)
    }
    if (!res.ok) {
      const text = await res.text()
      let msg = `${res.status} ${res.statusText}`
      try {
        msg = String((JSON.parse(text) as { error?: unknown }).error ?? msg)
      } catch {
        /* not JSON */
      }
      throw new ApiError(msg, res.status)
    }
    const name = res.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? `print.${format}`
    const url = URL.createObjectURL(await res.blob())
    const a = document.createElement("a")
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    return name
  },
  // Creality WebRTC camera: the server relays our SDP offer to the printer and returns its answer.
  cameraWebrtc: (id: string, offer: { type: string; sdp: string }) =>
    request<{ type: "answer"; sdp: string }>("POST", `/api/machines/${enc(id)}/camera/webrtc`, { offer }),
  deliverCapture: (requestId: string, body: { dataUrl?: string; error?: string }) =>
    request<{ ok: boolean }>("POST", `/api/camera/captures/${enc(requestId)}`, body),
  machineModels: async (q = "") =>
    (await request<Record<string, unknown>[]>("GET", `/api/machines/models${q ? `?q=${enc(q)}` : ""}`)).map(toModel),
  printerRestartFirmware: () => request<{ ok: boolean }>("POST", "/api/printer/firmware-restart", {}),
  printerAction: (action: "pause" | "resume" | "cancel") =>
    request<{ ok: boolean }>("POST", `/api/printer/${action}`, {}),

  setAgentModel: (id: string, model: string) => request<{ model: string }>("POST", `${p(id)}/agent/model`, { model }),
  // agent profiles + Agents screen (R11b/c)
  agentRuntimes: () => request<AgentRuntimeProbe[]>("GET", "/api/agent/runtimes"),
  agentProfiles: () => request<AgentProfilesResponse>("GET", "/api/agent/profiles"),
  createAgentProfile: (body: Partial<AgentProfile>) => request<AgentProfileView>("POST", "/api/agent/profiles", body),
  updateAgentProfile: (id: string, patch: Partial<AgentProfile>) => request<AgentProfileView>("PUT", `/api/agent/profiles/${enc(id)}`, patch),
  deleteAgentProfile: (id: string) => request<{ ok: boolean }>("DELETE", `/api/agent/profiles/${enc(id)}`),
  setDefaultAgentProfile: (profileId: string) => request<AgentProfilesResponse>("PUT", "/api/agent/default-profile", { profileId }),
  setAgentProfileKey: (id: string, value: string) => request<AgentProfileView>("PUT", `/api/agent/profiles/${enc(id)}/key`, { value }),
  removeAgentProfileKey: (id: string) => request<AgentProfileView>("DELETE", `/api/agent/profiles/${enc(id)}/key`),
  testAgentProfile: (id: string, message = false) => request<AgentConnectionResult>("POST", `/api/agent/profiles/${enc(id)}/test`, { message }),
  agentProfileModels: (id: string) => request<AgentModelList>("GET", `/api/agent/profiles/${enc(id)}/models`),
  agentFailures: (profileId?: string, limit = 20) =>
    request<AgentFailure[]>("GET", `/api/agent/failures?limit=${limit}${profileId ? `&profileId=${enc(profileId)}` : ""}`),
  projectAgent: (id: string) => request<ProjectAgentChoice>("GET", `${p(id)}/agent/profile`),
  setProjectAgent: (id: string, profileId: string | null, model: string | null) =>
    request<ProjectAgentChoice>("POST", `${p(id)}/agent/profile`, { profileId, model }),
  // R11g: portable handoff (preview changes nothing; markdown only when the user edited it)
  handoffPreview: (id: string, reason: "switch" | "fresh" | "idea", target?: { profileId: string | null; model: string | null }) =>
    request<HandoffPreview>("POST", `${p(id)}/agent/handoff/preview`, { reason, ...(target ?? {}) }),
  startHandoff: (
    id: string,
    body: { reason: "switch" | "fresh"; profileId?: string | null; model?: string | null; markdown?: string; mode?: "new" | "resume"; resumeSessionId?: string },
  ) => request<{ sessionId: string; handoffId: string }>("POST", `${p(id)}/agent/handoff`, body),
  handoff: (id: string, handoffId: string) => request<HandoffRecord>("GET", `${p(id)}/agent/handoffs/${enc(handoffId)}`),
  tryWithDesigner: (id: string, body: { profileId: string | null; model: string | null; markdown?: string; title?: string }) =>
    request<{ branch: string; sessionId: string; handoffId: string }>("POST", `${p(id)}/ideas/try-with`, body),
  // onboarding + starters
  about: () => request<AboutInfo>("GET", "/api/about"),
  setupChecks: () => request<{ claude: SetupCheck; openscad: SetupCheck; orcaslicer: SetupCheck; blender?: SetupCheck }>("GET", "/api/onboarding/checks"),
  /** R11d: start the ChatGPT sign-in for Crease's own Codex home; open authUrl in the browser. */
  codexLogin: () => request<{ authUrl: string; loginId: string }>("POST", "/api/agent/runtimes/codex/login", {}),
  /** R11e: start the Grok device sign-in for Crease's own Grok home; open authUrl (it carries the code). */
  grokLogin: () => request<{ authUrl: string; code: string }>("POST", "/api/agent/runtimes/grok/login", {}),
  /** Where the last browser sign-in (codex | grok) stands; poll until state leaves "waiting". */
  runtimeLoginStatus: (kind: string) => request<RuntimeLoginStatus>("GET", `/api/agent/runtimes/${encodeURIComponent(kind)}/login`),
  cancelRuntimeLogin: (kind: string) => request<{ ok: boolean }>("DELETE", `/api/agent/runtimes/${encodeURIComponent(kind)}/login`),
  claudeLogin: () => request<{ ok: boolean; command: string; error?: string }>("POST", "/api/onboarding/claude-login", {}),
  setupPrinter: (body: { name?: string; host?: string; port?: number; practice?: boolean }) =>
    request<{ ok: boolean; practice?: boolean; info?: { hostname?: string; software_version?: string; state?: string }; error?: string }>(
      "POST",
      "/api/onboarding/printer",
      body,
    ),
  getTolerances: (machineId?: string | null) =>
    request<Tolerances>("GET", `/api/machines/tolerances${machineId ? `?machine=${enc(machineId)}` : ""}`),
  setTolerances: (t: Partial<Tolerances>, machineId?: string | null) =>
    request<Tolerances>("PUT", `/api/machines/tolerances${machineId ? `?machine=${enc(machineId)}` : ""}`, t),
  starters: () => request<Starter[]>("GET", "/api/starters"),
  useStarter: (id: string, name?: string) => request<Project>("POST", `/api/starters/${enc(id)}/use`, name ? { name } : {}),

  // settings
  getSettings: () => request<Settings>("GET", "/api/settings"),
  putSettings: (s: Partial<Settings>) => request<Settings>("PUT", "/api/settings", s),
  // secrets (write-only values; responses are masked status)
  listSecrets: () => request<{ store: SecretStoreInfo; secrets: Record<SecretRef, SecretStatus> }>("GET", "/api/secrets"),
  setSecret: (ref: SecretRef, value: string) => request<SecretStatus>("PUT", `/api/secrets/${enc(ref)}`, { value }),
  deleteSecret: (ref: SecretRef) => request<SecretStatus>("DELETE", `/api/secrets/${enc(ref)}`),
  testOpenscad: () => request<{ ok: boolean; version?: string; error?: string }>("POST", "/api/settings/test-openscad", {}),
}

/** POST JSON and save the response as a file (name from content-disposition). Returns the file name. */
async function downloadPost(url: string, body: unknown): Promise<string> {
  let res: Response
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  } catch (e) {
    throw new ApiError(`Server unreachable (${(e as Error).message})`, 0)
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(data?.error ?? `${res.status} ${res.statusText}`, res.status)
  }
  const name = res.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? "download.zip"
  const href = URL.createObjectURL(await res.blob())
  const a = document.createElement("a")
  a.href = href
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(href), 60_000)
  return name
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
