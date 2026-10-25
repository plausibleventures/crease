import { create } from "zustand"
import type {
  AgentBilling,
  PlanUsage,
  AgentEvent,
  AgentEventEnvelope,
  AgentPermissionRequest,
  AgentQuestionRequest,
  AssemblyInfo,
  PointAnnotation,
  CheckReport,
  PrinterStatus,
  PrintRequest,
  Project,
  CatalogProject,
  PrintIntent,
  SlicePreviewSummary,
  MachineWithStatus,
  Checkpoint,
  IdeaList,
  CatalogSession,
  RenderResult,
  ServerEvent,
  SliceResult,
  ProjectJobs,
  SyncSnapshot,
  ProjectValidity,
  ProjectOverview,
} from "@shared/types"
import { toast } from "sonner"
import { PRINT_REQUEST_RESTART_NOTICE } from "@shared/types"
import { api, errMsg } from "@/lib/api"
import { defaultMachine, reconcileSnapshot, type FinishedPrintCard } from "@/lib/sync"
import { applyEvent, emptyTimeline, type TimelineState } from "@/lib/timeline"

/** A pinned spot on the model ("make this thicker"); drawn in the view it was placed in. */
export type Pin = PointAnnotation & {
  view: "part" | "assembled"
  instanceKey?: string // assembled view: "part#i"
  sent: boolean // sent with a message: still drawn until the next render, no longer a chip
}

export type CenterTab = "overview" | "model" | "renders" | "layers" | "assembly" | "compare"

export type Route = { name: "library" } | { name: "machines" } | { name: "agents" } | { name: "style"; dir?: string } | { name: "project"; id: string }
export type WsStatus = "connecting" | "open" | "closed"

export interface AgentStatus {
  running: boolean
  sessionId: string | null
  costUsd: number
}

export const partKey = (projectId: string, partId: string) => `${projectId}/${partId}`

function parseHash(): Route {
  const h = window.location.hash.replace(/^#\/?/, "")
  const m = h.match(/^p\/(.+)$/)
  if (m) return { name: "project", id: decodeURIComponent(m[1]) }
  if (h === "machines") return { name: "machines" }
  if (h === "agents") return { name: "agents" }
  if (h === "style" || h.startsWith("style/")) return { name: "style", dir: h.split("/")[1] }
  return { name: "library" }
}

interface StudioState {
  route: Route
  /** Bumped when agent profiles / a project's designer change (WS agent.profiles.changed): refetch. */
  agentProfilesRev: number
  /** Bumped when a run fails (WS agent.failure). */
  agentFailuresRev: number
  wsStatus: WsStatus
  settingsOpen: boolean
  settingsSection: "about" | null
  /** print intent per project (remembered in localStorage) */
  intents: Record<string, PrintIntent>
  setIntent: (projectId: string, intent: PrintIntent) => void
  intentFor: (projectId: string) => PrintIntent
  /** the G-code the Layers tab shows, per project (last slice) */
  lastGcode: Record<string, string>
  /** slice preview summaries by `${projectId}|${gcodePath}` */
  previews: Record<string, SlicePreviewSummary>
  /** record a fresh slice: remember its G-code + summary (fetched if not given); returns the summary */
  noteSliced: (projectId: string, gcodePath: string, preview?: SlicePreviewSummary | null) => Promise<SlicePreviewSummary | null>
  /** force: refetch even if cached (the file may have been re-sliced under the same name) */
  loadPreview: (projectId: string, gcodePath: string, force?: boolean) => Promise<SlicePreviewSummary | null>
  /** bumps whenever a preview is replaced, so views of the same G-code path reload their layers */
  previewStamp: Record<string, number>
  machines: MachineWithStatus[] | null
  /** Add/Edit machine dialog: null = closed, {id: null} = add a new one */
  machineDialog: { id: string | null } | null
  setMachineDialog: (d: { id: string | null } | null) => void
  machinesError: string | null
  loadMachines: () => Promise<void>
  /** the machine this project prints on (project.json `printer`), else the default machine */
  targetMachineId: (projectId?: string | null) => string | null
  /**
   * The printer to watch for this project: the one its print is running on (a printer picked in the print dialog
   * can differ from the project's), else the project's printer. Status bar, Printer panel and "Watch it print".
   */
  watchMachineId: (projectId?: string | null) => string | null
  setProjectMachine: (projectId: string, machineId: string) => Promise<void>
  /** first-run setup wizard; step index (0 = welcome). `only`: "Finish setup" walks just these screens, then Done. */
  onboarding: { open: boolean; step: number; only?: number[] }
  setOnboarding: (o: { open: boolean; step?: number; only?: number[] }) => void
  /** suggested first message for a project started from an idea (the agent panel may show it) */
  starterHint: Record<string, string>

  projects: CatalogProject[] | null
  pinMode: boolean
  setPinMode: (on: boolean) => void
  pins: Record<string, Pin[]>
  hoverPin: number | null
  setHoverPin: (n: number | null) => void
  addPin: (projectId: string, pin: Omit<Pin, "n" | "sent">) => void
  removePin: (projectId: string, n: number) => void
  markPinsSent: (projectId: string) => void
  /** Snapshot of the visible 3D view (with pins) as a JPEG data URL; set by the mounted viewer. */
  viewerCapture: (() => string | null) | null
  setViewerCapture: (fn: (() => string | null) | null) => void
  centerTab: CenterTab
  setCenterTab: (t: CenterTab) => void
  assembly: Record<string, AssemblyInfo | null>
  assemblyError: Record<string, string | null>
  loadAssembly: (projectId: string) => Promise<void>
  libraryQuery: { q: string; tag: string | null }
  setLibraryQuery: (q: Partial<{ q: string; tag: string | null }>) => void
  sessions: Record<string, CatalogSession[]>
  checkpoints: Record<string, { branch: string; list: Checkpoint[] }>
  /** versions + ideas (R22: the ideas list is reloaded with the versions) */
  loadCheckpoints: (projectId: string) => Promise<void>
  ideas: Record<string, IdeaList>
  /** R22: what the Compare tab shows (an idea's branch, a version's commit, or "current") */
  comparePick: Record<string, { a: string; b: string }>
  openCompare: (projectId: string, a: string, b: string) => void
  /** R22: open another idea: its files and its own chat come back */
  switchIdea: (projectId: string, branch: string) => Promise<void>
  /** after files changed under us (restore / idea switch): reload everything that mirrors the project */
  resync: (projectId: string) => Promise<void>
  abandoned: Record<string, string[]>
  loadSessions: (projectId: string) => Promise<void>
  switchSession: (projectId: string, sessionId: string | null) => Promise<void>
  finishedPrints: FinishedPrintCard[]
  /** "Later" / closed without rating: a snapshot doesn't bring these back (kept in localStorage) */
  laterPrints: string[]
  dismissFinished: (printId: string) => void
  /** R15: (re)open the "How did it turn out?" card for a print, e.g. from the project's print history */
  openPrintResult: (p: FinishedPrintCard) => void
  /** bumps on prints.changed (an outcome or lesson was saved): calibration and lesson lists refetch */
  printsRev: number
  projectsError: string | null
  projectsLoading: boolean

  project: Project | null
  projectError: string | null
  /** U4: the last project opened, shown in the top nav as a one-click way back from Library/Machines/Designers */
  recentProject: { id: string; name: string } | null
  /** after a project was renamed or moved to the Trash */
  updateRecentProject: (id: string, name: string | null) => void
  selectedPartId: string | null

  timelines: Record<string, TimelineState>
  timelineError: Record<string, string | null>
  agent: Record<string, AgentStatus>
  /** questions the agent is waiting on (AskUserQuestion), per project */
  questions: Record<string, AgentQuestionRequest[]>
  /** permission requests the agent is waiting on (runtimes with permission callbacks, e.g. Codex), per project */
  permissions: Record<string, AgentPermissionRequest[]>
  loadPermissions: (projectId: string) => Promise<void>
  /** "plan" = claude.ai login (costs are API-price estimates), "api" = API key (real costs) */
  billing: AgentBilling
  planUsage: PlanUsage | null
  loadUsage: () => Promise<void>
  loadQuestions: (projectId: string) => Promise<void>

  renders: Record<string, RenderResult>
  rendering: Record<string, boolean>
  checks: Record<string, CheckReport>
  checking: Record<string, boolean>
  slices: Record<string, SliceResult>
  slicing: Record<string, boolean>

  printer: PrinterStatus | null
  printerError: string | null
  printRequests: PrintRequest[]
  /** server-owned print jobs per project: latest job per part + plate set, with lifecycle and staleness */
  jobs: Record<string, ProjectJobs>
  loadJobs: (projectId: string) => Promise<ProjectJobs | null>
  /** R07: freshness of renders, checks, guide and motion check per project (server-computed from content hashes) */
  validity: Record<string, ProjectValidity>
  /** refetch validity (coalesced: many events in a burst cause one request) */
  loadValidity: (projectId: string) => void
  /** R12: project overview (hero, sizes, plates, supplies, next action, composer suggestions) per project */
  overview: Record<string, ProjectOverview>
  /** refetch the overview (coalesced; also runs with every loadValidity) */
  loadOverview: (projectId: string) => void
  /** bump to focus the agent composer (optionally with a draft to put in it) */
  composerFocus: { n: number; draft?: string }
  focusComposer: (draft?: string) => void

  /** bumps whenever project.changed fires for the open project */
  fileChange: { projectId: string; paths: string[]; n: number } | null

  navigate: (r: Route) => void
  /** `section` opens Settings at that section (e.g. "about" from the app menu). */
  setSettingsOpen: (o: boolean, section?: "about") => void
  setWsStatus: (s: WsStatus) => void
  loadProjects: () => Promise<void>
  openProject: (id: string) => Promise<void>
  refreshProject: () => Promise<void>
  selectPart: (id: string) => void
  /** A .scad that is not a part (lib/…) open in the code editor; null = the selected part's file. Picking a part clears it. */
  codeFile: string | null
  openCodeFile: (path: string | null) => void
  loadTimeline: (projectId: string, reset?: boolean) => Promise<void>
  loadAgentStatus: (projectId: string) => Promise<void>
  appendLocal: (projectId: string, event: AgentEvent) => void
  refreshPrinter: () => Promise<void>

  /** force: overwrite what we hold (after a WS gap the cached render/check may be older than the server's) */
  loadLatest: (projectId: string, partId: string, force?: boolean) => Promise<void>
  render: (projectId: string, partId: string, params?: Record<string, number | string | boolean>) => Promise<RenderResult | null>
  check: (projectId: string, partId: string) => Promise<CheckReport | null>
  slice: (projectId: string, partId: string) => Promise<SliceResult | null>
  addPrintRequest: (r: PrintRequest) => void
  removePrintRequest: (id: string) => void

  handleEvent: (e: ServerEvent) => void
  /** R08: reconcile with a server snapshot after a WS gap / server restart (idempotent), then refetch the rest. */
  applySnapshot: (snap: SyncSnapshot) => void
}

/**
 * A print request that was open when the server restarted comes back as a pending job with this notice (the
 * timeline says it too): toast it once per job + time, so the user knows nothing was sent and can ask again.
 */
function noteRestartCancelled(j: ProjectJobs) {
  const views = [...Object.values(j.parts ?? {}), ...(j.plates?.plates ?? [])]
  for (const v of views) {
    if (v.error !== PRINT_REQUEST_RESTART_NOTICE || v.status !== "pending") continue
    const key = `ps-restart-notice-${v.id}-${v.updatedAt}`
    try {
      if (localStorage.getItem(key)) continue
      localStorage.setItem(key, "1")
    } catch {
      /* no storage: may show again after a reload */
    }
    toast.warning("Print request cancelled", { id: key, description: PRINT_REQUEST_RESTART_NOTICE, duration: 15000 })
  }
}

let localSeq = 1_000_000_000
const validityTimers = new Map<string, ReturnType<typeof setTimeout>>()
const overviewTimers = new Map<string, ReturnType<typeof setTimeout>>()
const overviewSeq = new Map<string, number>()
// Slice-preview requests per key: a response that started before a newer slice of the same path is dropped, so the
// Layers tab can't fall back to the previous slice's issues (plan.md bug).
const previewGen = new Map<string, number>()

export { defaultMachine }

// Agent tool calls that change the assembly (update_assembly, build_assembly_guide, render_assembly_step…):
// refresh assembly info when their result arrives (build/ and renders/ aren't file-watched).
const pendingAssemblyTools = new Set<string>()
/** Assembly/motion tool calls: refresh the assembly and validity when their results land. */
function trackAssemblyTools(env: AgentEventEnvelope, refresh: () => void) {
  const ev = env.event
  if (!env.itemId) return
  if (ev.type === "tool.started" && /assembly|motion/i.test(ev.name)) pendingAssemblyTools.add(env.itemId)
  else if (ev.type === "tool.completed" && pendingAssemblyTools.delete(env.itemId)) refresh()
}

export const useStudio = create<StudioState>((set, get) => ({
  route: parseHash(),
  agentProfilesRev: 0,
  agentFailuresRev: 0,
  wsStatus: "connecting",
  settingsOpen: false,
  settingsSection: null,

  projects: null,
  pinMode: false,
  setPinMode: (on) => set({ pinMode: on }),
  pins: {},
  hoverPin: null,
  setHoverPin: (n) => set({ hoverPin: n }),
  addPin: (projectId, pin) =>
    set((s) => {
      // pins from an earlier message are stale once you start pointing again
      const cur = (s.pins[projectId] ?? []).filter((p) => !p.sent)
      const n = cur.reduce((m, p) => Math.max(m, p.n), 0) + 1
      return { pins: { ...s.pins, [projectId]: [...cur, { ...pin, n, sent: false }] } }
    }),
  removePin: (projectId, n) =>
    set((s) => {
      const left = (s.pins[projectId] ?? []).filter((p) => p.sent || p.n !== n)
      // renumber the remaining chips so numbers match what the agent will see
      let i = 0
      return { pins: { ...s.pins, [projectId]: left.map((p) => (p.sent ? p : { ...p, n: ++i })) } }
    }),
  markPinsSent: (projectId) =>
    set((s) => ({ pins: { ...s.pins, [projectId]: (s.pins[projectId] ?? []).map((p) => ({ ...p, sent: true })) } })),
  viewerCapture: null,
  setViewerCapture: (fn) => set({ viewerCapture: fn }),
  centerTab: "model",
  setCenterTab: (t) => set({ centerTab: t }),
  assembly: {},
  assemblyError: {},
  loadAssembly: async (projectId) => {
    try {
      const info = await api.assembly(projectId)
      set((s) => ({ assembly: { ...s.assembly, [projectId]: info }, assemblyError: { ...s.assemblyError, [projectId]: null } }))
      get().loadOverview(projectId)
    } catch (e) {
      set((s) => ({ assemblyError: { ...s.assemblyError, [projectId]: errMsg(e) } }))
    }
  },
  libraryQuery: { q: "", tag: null },
  setLibraryQuery: (q) => {
    set((s) => ({ libraryQuery: { ...s.libraryQuery, ...q } }))
    void get().loadProjects()
  },
  sessions: {},
  checkpoints: {},
  loadCheckpoints: async (projectId) => {
    try {
      const r = await api.checkpoints(projectId)
      set((s) => ({ checkpoints: { ...s.checkpoints, [projectId]: { branch: r.branch, list: r.checkpoints ?? [] } } }))
    } catch {
      /* no git history available */
    }
    try {
      const ideas = await api.ideas(projectId)
      set((s) => ({ ideas: { ...s.ideas, [projectId]: ideas } }))
    } catch {
      /* no ideas list (older server) */
    }
  },
  ideas: {},
  comparePick: {},
  openCompare: (projectId, a, b) => set((s) => ({ comparePick: { ...s.comparePick, [projectId]: { a, b } }, centerTab: "compare" })),
  switchIdea: async (projectId, branch) => {
    const prev = get().agent[projectId]?.sessionId ?? get().project?.activeSessionId ?? null
    const r = await api.activateIdea(projectId, branch)
    set((s) => {
      const ab = new Set(s.abandoned[projectId] ?? [])
      if (prev && prev !== r.sessionId) ab.add(prev)
      if (r.sessionId) ab.delete(r.sessionId)
      return {
        abandoned: { ...s.abandoned, [projectId]: [...ab] },
        agent: { ...s.agent, [projectId]: { running: false, sessionId: r.sessionId, costUsd: 0 } },
        timelines: { ...s.timelines, [projectId]: emptyTimeline() },
        project: s.project && s.project.id === projectId ? { ...s.project, activeSessionId: r.sessionId } : s.project,
      }
    })
    await get().resync(projectId)
  },
  resync: async (projectId) => {
    set((s) => ({ timelines: { ...s.timelines, [projectId]: emptyTimeline() }, fileChange: { projectId, paths: ["*"], n: (s.fileChange?.n ?? 0) + 1 } }))
    await Promise.all([
      get().refreshProject(),
      get().loadTimeline(projectId, true),
      get().loadAgentStatus(projectId),
      get().loadSessions(projectId),
      get().loadCheckpoints(projectId),
      get().loadAssembly(projectId),
      get().loadJobs(projectId),
    ])
    get().loadValidity(projectId) // artifact freshness (R07)
  },
  abandoned: {},
  loadSessions: async (projectId) => {
    try {
      const list = await api.sessions(projectId)
      if (Array.isArray(list)) set((s) => ({ sessions: { ...s.sessions, [projectId]: list } }))
    } catch {
      /* sidebar falls back to project.json sessions */
    }
  },
  switchSession: async (projectId, sessionId) => {
    const prev = get().agent[projectId]?.sessionId ?? get().project?.activeSessionId ?? null
    // a session on another idea brings its files along (the server saves uncommitted edits first)
    const r = sessionId ? await api.activateSession(projectId, sessionId) : await api.switchSession(projectId, null)
    set((s) => {
      const ab = new Set(s.abandoned[projectId] ?? [])
      if (prev && prev !== r.sessionId) ab.add(prev)
      if (r.sessionId) ab.delete(r.sessionId)
      const cur = s.agent[projectId]
      return {
        abandoned: { ...s.abandoned, [projectId]: [...ab] },
        agent: { ...s.agent, [projectId]: { running: false, sessionId: r.sessionId, costUsd: r.sessionId === cur?.sessionId ? cur.costUsd : 0 } },
        timelines: { ...s.timelines, [projectId]: emptyTimeline() },
        project: s.project && s.project.id === projectId ? { ...s.project, activeSessionId: r.sessionId } : s.project,
      }
    })
    await Promise.all([get().loadTimeline(projectId, true), get().loadAgentStatus(projectId), get().loadSessions(projectId)])
    if ("switched" in r && r.switched) await get().resync(projectId)
  },
  finishedPrints: [],
  printsRev: 0,
  laterPrints: readLaterPrints(),
  dismissFinished: (printId) =>
    set((s) => {
      const laterPrints = [...s.laterPrints.filter((x) => x !== printId), printId].slice(-100)
      writeLaterPrints(laterPrints)
      return { finishedPrints: s.finishedPrints.filter((f) => f.printId !== printId), laterPrints }
    }),
  openPrintResult: (p) =>
    set((s) => {
      const laterPrints = s.laterPrints.filter((x) => x !== p.printId)
      writeLaterPrints(laterPrints)
      // shown now: first in the queue
      return { finishedPrints: [{ ...p, expanded: true }, ...s.finishedPrints.filter((f) => f.printId !== p.printId)], laterPrints }
    }),
  projectsError: null,
  projectsLoading: false,

  project: null,
  projectError: null,
  recentProject: null,
  updateRecentProject: (id, name) =>
    set((s) => (s.recentProject?.id !== id ? {} : { recentProject: name === null ? null : { id, name } })),
  selectedPartId: null,

  timelines: {},
  timelineError: {},
  agent: {},
  questions: {},
  billing: "plan",
  planUsage: null,
  loadUsage: async () => {
    try {
      const r = await api.agentUsage()
      set({ billing: r.billing, planUsage: r.usage })
    } catch {
      /* older server */
    }
  },
  permissions: {},
  loadPermissions: async (projectId) => {
    try {
      const list = await api.agentPermissions(projectId)
      set((s) => ({ permissions: { ...s.permissions, [projectId]: Array.isArray(list) ? list : [] } }))
    } catch {
      /* older server */
    }
  },
  loadQuestions: async (projectId) => {
    try {
      const list = await api.agentQuestions(projectId)
      set((s) => ({ questions: { ...s.questions, [projectId]: Array.isArray(list) ? list : [] } }))
    } catch {
      /* older server */
    }
  },

  renders: {},
  rendering: {},
  checks: {},
  checking: {},
  slices: {},
  slicing: {},

  printer: null,
  printerError: null,
  printRequests: [],
  validity: {},
  loadValidity: (projectId) => {
    const prev = validityTimers.get(projectId)
    if (prev) clearTimeout(prev)
    validityTimers.set(
      projectId,
      setTimeout(() => {
        validityTimers.delete(projectId)
        api
          .validity(projectId)
          .then((v) => set((s) => ({ validity: { ...s.validity, [projectId]: v } })))
          .catch(() => {})
      }, 150),
    )
    get().loadOverview(projectId)
  },
  overview: {},
  loadOverview: (projectId) => {
    const prev = overviewTimers.get(projectId)
    if (prev) clearTimeout(prev)
    overviewTimers.set(
      projectId,
      setTimeout(() => {
        overviewTimers.delete(projectId)
        // only the newest answer counts: an older, slower fetch must not put back a stale next action (E2E #2 P2-e)
        const seq = (overviewSeq.get(projectId) ?? 0) + 1
        overviewSeq.set(projectId, seq)
        api
          .overview(projectId)
          .then((o) => o && overviewSeq.get(projectId) === seq && set((s) => ({ overview: { ...s.overview, [projectId]: o } })))
          .catch(() => {})
      }, 200),
    )
  },
  composerFocus: { n: 0 },
  focusComposer: (draft) => set((s) => ({ composerFocus: { n: s.composerFocus.n + 1, draft } })),
  jobs: {},
  loadJobs: async (projectId) => {
    try {
      const j = await api.projectJobs(projectId)
      // the server's intent wins over a local pick (e.g. the agent just sliced with Display)
      set((s) => {
        const intents = { ...s.intents }
        if (j.intent) delete intents[projectId]
        return { jobs: { ...s.jobs, [projectId]: j }, intents }
      })
      get().loadOverview(projectId)
      noteRestartCancelled(j)
      return j
    } catch {
      return null
    }
  },
  fileChange: null,

  navigate: (r) => {
    const hash =
      r.name === "project"
        ? `#/p/${encodeURIComponent(r.id)}`
        : r.name === "machines"
          ? "#/machines"
          : r.name === "agents"
            ? "#/agents"
          : r.name === "style"
            ? `#/style${r.dir ? `/${r.dir}` : ""}`
            : "#/"
    if (window.location.hash !== hash) window.location.hash = hash
    set({ route: r })
  },
  setSettingsOpen: (o, section) => set({ settingsOpen: o, settingsSection: o ? (section ?? null) : null }),
  intents: {},
  intentFor: (projectId) => {
    const cur = get().intents[projectId]
    if (cur) return cur
    // server-owned: project.json `intent` (every slice sets it, so the picker follows the latest slice)
    const st = get()
    const server = st.jobs[projectId]?.intent ?? (st.project?.id === projectId ? st.project.intent : undefined)
    if (server) return server
    try {
      const v = localStorage.getItem(`ps-intent-${projectId}`)
      if (v) return v as PrintIntent
    } catch {
      /* ignore */
    }
    return "standard"
  },
  setIntent: (projectId, intent) => {
    try {
      localStorage.setItem(`ps-intent-${projectId}`, intent)
    } catch {
      /* ignore */
    }
    set((s) => ({ intents: { ...s.intents, [projectId]: intent } }))
    // the server owns it: a different intent makes earlier slices out of date
    void api
      .setProjectIntent(projectId, intent)
      .then(() => get().loadJobs(projectId))
      .catch(() => {})
  },
  lastGcode: {},
  previews: {},
  previewStamp: {},
  loadPreview: async (projectId, gcodePath, force) => {
    const key = `${projectId}|${gcodePath}`
    const have = get().previews[key]
    if (have && !force) return have
    const gen = previewGen.get(key) ?? 0
    try {
      const p = await api.slicePreview(projectId, gcodePath)
      if ((previewGen.get(key) ?? 0) !== gen) return get().previews[key] ?? null // a newer slice landed meanwhile
      const prev = get().previews[key]
      // only bump when it actually changed (avoids reloading layers on every revalidation)
      if (prev && JSON.stringify(prev) === JSON.stringify(p)) return prev
      set((s) => ({ previews: { ...s.previews, [key]: p }, previewStamp: { ...s.previewStamp, [key]: (s.previewStamp[key] ?? 0) + 1 } }))
      return p
    } catch {
      return null
    }
  },
  noteSliced: async (projectId, gcodePath, preview) => {
    const k = `${projectId}|${gcodePath}`
    previewGen.set(k, (previewGen.get(k) ?? 0) + 1)
    set((s) => {
      const key = `${projectId}|${gcodePath}`
      const previews = { ...s.previews }
      if (preview) previews[key] = preview
      else delete previews[key] // stale summary of an earlier slice
      return {
        lastGcode: { ...s.lastGcode, [projectId]: gcodePath },
        previews,
        previewStamp: { ...s.previewStamp, [key]: (s.previewStamp[key] ?? 0) + 1 },
      }
    })
    return preview ?? (await get().loadPreview(projectId, gcodePath))
  },
  machines: null,
  machineDialog: null,
  setMachineDialog: (d) => set({ machineDialog: d }),
  machinesError: null,
  loadMachines: async () => {
    try {
      const list = await api.machines()
      set({ machines: Array.isArray(list) ? list : [], machinesError: null })
    } catch (e) {
      set({ machinesError: errMsg(e) })
    }
  },
  targetMachineId: (projectId) => {
    const st = get()
    const list = st.machines ?? []
    const want = projectId && st.project?.id === projectId ? st.project.printer : null
    const hit = want ? list.find((m) => m.id === want) : null
    return hit?.id ?? defaultMachine(list)?.id ?? null
  },
  watchMachineId: (projectId) => {
    const st = get()
    const list = st.machines ?? []
    if (projectId) {
      const on = st.overview[projectId]?.printingOn?.machineId
      if (on && list.some((m) => m.id === on)) return on
      // the overview may lag the printer: a machine busy with this project's file (uploaded as <project>_<file>)
      const busy = list.find(
        (m) => m.status && ["printing", "paused", "preparing"].includes(m.status.state) && !!m.status.filename?.startsWith(`${projectId}_`),
      )
      if (busy) return busy.id
    }
    return st.targetMachineId(projectId)
  },
  setProjectMachine: async (projectId, machineId) => {
    // project.json `printer` holds the target machine id (versioned with the design)
    const f = await api.readFile(projectId, "project.json")
    const pj = JSON.parse(f.content)
    pj.printer = machineId
    await api.writeFile(projectId, "project.json", JSON.stringify(pj, null, 2) + "\n")
    set((s) => ({
      project: s.project && s.project.id === projectId ? { ...s.project, printer: machineId } : s.project,
      // earlier slices were for another printer
      slices: Object.fromEntries(Object.entries(s.slices).filter(([k]) => !k.startsWith(`${projectId}/`))),
    }))
  },
  onboarding: { open: false, step: 0 },
  setOnboarding: (o) => set((s) => ({ onboarding: { open: o.open, step: o.step ?? s.onboarding.step, only: o.open ? (o.only ?? (o.step === 0 ? undefined : s.onboarding.only)) : undefined } })),
  starterHint: {},
  setWsStatus: (s) => set({ wsStatus: s }),

  loadProjects: async () => {
    set({ projectsLoading: true })
    try {
      const { q, tag } = get().libraryQuery
      const projects = await api.catalog({ q: q.trim() || undefined, tag: tag ?? undefined })
      set({ projects: Array.isArray(projects) ? projects : [], projectsError: null })
    } catch (e) {
      set({ projectsError: errMsg(e) })
    } finally {
      set({ projectsLoading: false })
    }
  },

  openProject: async (id) => {
    if (get().project?.id !== id) set({ project: null, selectedPartId: null, codeFile: null })
    set({ projectError: null })
    try {
      const project = await api.getProject(id)
      const sel = get().selectedPartId
      set({
        project,
        recentProject: { id: project.id, name: project.name },
        selectedPartId: sel && project.parts.some((p) => p.id === sel) ? sel : (project.parts[0]?.id ?? null),
      })
    } catch (e) {
      set({ projectError: errMsg(e) })
    }
    void get().loadTimeline(id)
    void get().loadAgentStatus(id)
    void get().loadSessions(id)
    void get().loadAssembly(id)
    void get().loadCheckpoints(id)
    void get().loadJobs(id)
    get().loadValidity(id)
  },

  refreshProject: async () => {
    const cur = get().project
    if (!cur) return
    try {
      const project = await api.getProject(cur.id)
      const sel = get().selectedPartId
      set({
        project,
        selectedPartId: sel && project.parts.some((p) => p.id === sel) ? sel : (project.parts[0]?.id ?? null),
      })
    } catch {
      /* keep stale */
    }
  },

  selectPart: (id) => set({ selectedPartId: id, codeFile: null }),
  codeFile: null,
  openCodeFile: (path) => set({ codeFile: path }),

  loadTimeline: async (projectId, reset) => {
    try {
      const envs = await api.events(projectId)
      let tl = emptyTimeline()
      for (const env of Array.isArray(envs) ? envs : []) tl = applyEvent(tl, env)
      // re-apply anything that streamed in live while we were fetching
      const live = get().timelines[projectId]
      if (live && !reset) {
        // live items not in replay: keep it simple — the replay is authoritative,
        // and live events after this point are deduped by seq.
        for (const k of live.seen) tl.seen.add(k)
      }
      set((s) => ({ timelines: { ...s.timelines, [projectId]: tl }, timelineError: { ...s.timelineError, [projectId]: null } }))
    } catch (e) {
      set((s) => ({
        timelines: { ...s.timelines, [projectId]: s.timelines[projectId] ?? emptyTimeline() },
        timelineError: { ...s.timelineError, [projectId]: errMsg(e) },
      }))
    }
  },

  loadAgentStatus: async (projectId) => {
    void get().loadQuestions(projectId)
    void get().loadPermissions(projectId)
    void get().loadUsage()
    try {
      const st = await api.agentStatus(projectId)
      set((s) => ({ agent: { ...s.agent, [projectId]: st } }))
    } catch {
      /* ignore */
    }
  },

  appendLocal: (projectId, event) => {
    const seq = localSeq++
    const env: AgentEventEnvelope = {
      schemaVersion: 1,
      eventId: String(seq),
      seq,
      ts: new Date().toISOString(),
      projectId,
      sessionId: "local",
      runId: null,
      itemId: `local:${seq}`,
      revision: null,
      runtime: "app",
      event,
    }
    set((s) => ({
      timelines: { ...s.timelines, [projectId]: applyEvent(s.timelines[projectId] ?? emptyTimeline(), env) },
    }))
  },

  refreshPrinter: async () => {
    api
      .listPrintRequests()
      .then((list) => {
        if (!Array.isArray(list)) return
        const ids = new Set(list.map((r) => r.requestId))
        set((s) => ({ printRequests: [...s.printRequests.filter((r) => ids.has(r.requestId)), ...list.filter((r) => !s.printRequests.some((x) => x.requestId === r.requestId))] }))
      })
      .catch(() => {})
    try {
      const printer = await api.printerStatus()
      set({ printer, printerError: null })
    } catch (e) {
      set({ printerError: errMsg(e) })
    }
  },

  loadLatest: async (projectId, partId, force) => {
    const k = partKey(projectId, partId)
    try {
      const r = await api.latest(projectId, partId)
      set((s) => ({
        renders: r?.render && (force || !s.renders[k]) ? { ...s.renders, [k]: r.render } : s.renders,
        checks: r?.check && (force || !s.checks[k]) ? { ...s.checks, [k]: r.check } : s.checks,
      }))
    } catch {
      /* nothing cached / endpoint missing: panels show their empty states */
    }
  },

  render: async (projectId, partId, params) => {
    const k = partKey(projectId, partId)
    set((s) => ({ rendering: { ...s.rendering, [k]: true } }))
    try {
      const r = await api.render(projectId, partId, params)
      set((s) => ({ renders: { ...s.renders, [k]: r } }))
      return r
    } catch (e) {
      const prev = get().renders[k]
      set((s) => ({
        renders: {
          ...s.renders,
          [k]: { partId, stlUrl: prev?.stlUrl ?? "", images: prev?.images ?? [], stats: prev?.stats ?? null, cached: false, durationMs: 0, error: errMsg(e) },
        },
      }))
      return null
    } finally {
      set((s) => ({ rendering: { ...s.rendering, [k]: false } }))
    }
  },

  check: async (projectId, partId) => {
    const k = partKey(projectId, partId)
    set((s) => ({ checking: { ...s.checking, [k]: true } }))
    try {
      const r = await api.check(projectId, partId)
      set((s) => ({ checks: { ...s.checks, [k]: r } }))
      return r
    } finally {
      set((s) => ({ checking: { ...s.checking, [k]: false } }))
    }
  },

  slice: async (projectId, partId) => {
    const k = partKey(projectId, partId)
    set((s) => ({ slicing: { ...s.slicing, [k]: true } }))
    try {
      // the toolbar re-slices what was sliced last: the agent's per-part settings (e.g. 4 walls) stay
      const r = await api.slice(projectId, partId, get().targetMachineId(projectId), get().intentFor(projectId), true)
      set((s) => ({ slices: { ...s.slices, [k]: r } }))
      return r
    } finally {
      set((s) => ({ slicing: { ...s.slicing, [k]: false } }))
    }
  },

  addPrintRequest: (r) =>
    // a re-sent request (e.g. refreshed blockers after "Check again") replaces the old copy in place
    set((s) =>
      s.printRequests.some((x) => x.requestId === r.requestId)
        ? { printRequests: s.printRequests.map((x) => (x.requestId === r.requestId ? r : x)) }
        : { printRequests: [...s.printRequests, r] },
    ),
  removePrintRequest: (id) => set((s) => ({ printRequests: s.printRequests.filter((r) => r.requestId !== id) })),

  applySnapshot: (snap) => {
    set((s) => reconcileSnapshot(s, snap))
    const st = get()
    void st.loadUsage()
    if (st.route.name === "library") void st.loadProjects()
    const p = snap.project?.project
    if (!p || st.project?.id !== p.id) return
    // Not in the snapshot (large or file-backed): the transcript (deduped by envelope seq), sidebar lists, cached
    // render/check per part, and any open file (fileChange "*": editors re-read, keeping unsaved edits).
    set((s) => ({ fileChange: { projectId: p.id, paths: ["*"], n: (s.fileChange?.n ?? 0) + 1 } }))
    void st.loadTimeline(p.id)
    void st.loadSessions(p.id)
    st.loadOverview(p.id)
    void st.loadCheckpoints(p.id)
    for (const part of p.parts) void st.loadLatest(p.id, part.id, true)
  },

  handleEvent: (e) => {
    switch (e.type) {
      case "agent.event": {
        const { type: _t, ...env } = e
        void _t
        // late frames from a session we switched away from
        if (get().abandoned[env.projectId]?.includes(env.sessionId)) return
        set((s) => ({
          timelines: { ...s.timelines, [env.projectId]: applyEvent(s.timelines[env.projectId] ?? emptyTimeline(), env) },
        }))
        const ev = env.event
        const ended = ev.type === "run.completed" || ev.type === "run.failed" || ev.type === "run.interrupted"
        if (ended && ev.result) {
          void get().loadSessions(env.projectId)
          void get().loadCheckpoints(env.projectId)
        }
        trackAssemblyTools(env, () => {
          void get().loadAssembly(env.projectId)
          get().loadValidity(env.projectId) // check_motion / build_assembly_guide record what they were built from
        })
        const usage = ended ? ev.result?.usage : null
        const cost = usage?.final ? (usage.billedUsd ?? usage.estimatedApiUsd) : null
        if (typeof cost === "number") {
          set((s) => {
            const cur = s.agent[env.projectId] ?? { running: false, sessionId: env.sessionId, costUsd: 0 }
            // agent.status carries the live value; the run's cumulative figure is authoritative
            return { agent: { ...s.agent, [env.projectId]: { ...cur, costUsd: cost } } }
          })
        }
        return
      }
      case "agent.status": {
        if (e.sessionId && get().abandoned[e.projectId]?.includes(e.sessionId)) return
        const known = get().sessions[e.projectId]
        if (e.sessionId && (!known || !known.some((x) => x.id === e.sessionId))) {
          void get().loadSessions(e.projectId)
          if (get().project?.id === e.projectId) void get().refreshProject()
        }
        set((s) => ({ agent: { ...s.agent, [e.projectId]: { running: e.running, sessionId: e.sessionId, costUsd: e.costUsd } } }))
        return
      }
      case "agent.question": {
        const r = e.request
        set((s) => {
          const cur = s.questions[r.projectId] ?? []
          // Sent again when it changes (paused): update it in place.
          const next = cur.some((x) => x.requestId === r.requestId) ? cur.map((x) => (x.requestId === r.requestId ? r : x)) : [...cur, r]
          return { questions: { ...s.questions, [r.projectId]: next } }
        })
        return
      }
      case "agent.permission": {
        const r = e.request
        set((s) => {
          const cur = s.permissions[r.projectId] ?? []
          return cur.some((x) => x.requestId === r.requestId) ? s : { permissions: { ...s.permissions, [r.projectId]: [...cur, r] } }
        })
        return
      }
      case "agent.permission.resolved":
        set((s) => ({
          permissions: { ...s.permissions, [e.projectId]: (s.permissions[e.projectId] ?? []).filter((x) => x.requestId !== e.requestId) },
        }))
        return
      case "agent.usage":
        set({ billing: e.billing, planUsage: e.billing === "plan" ? e.usage : null })
        return
      case "agent.profiles.changed":
        set((s) => ({ agentProfilesRev: s.agentProfilesRev + 1 }))
        return
      case "agent.failure":
        set((s) => ({ agentFailuresRev: s.agentFailuresRev + 1 }))
        return
      case "agent.question.resolved":
        set((s) => ({
          questions: { ...s.questions, [e.projectId]: (s.questions[e.projectId] ?? []).filter((x) => x.requestId !== e.requestId) },
        }))
        return
      case "camera.capture.request":
        // The server wants a frame (e.g. the agent's printer_snapshot): grab one from the WebRTC camera.
        void import("@/lib/camera")
          .then(({ captureFrame }) => {
            const m = get().machines?.find((x) => x.id === e.machineId)
            if (!m) throw new Error("that printer isn't in this window's list")
            return captureFrame(m)
          })
          .then((dataUrl) => api.deliverCapture(e.requestId, { dataUrl }))
          .catch((err: Error) => api.deliverCapture(e.requestId, { error: err.message }).catch(() => {}))
        return
      case "print.finished":
        get().loadOverview(e.projectId)
        if (e.practice) {
          // nothing real to judge: never asks for a rating (UX round 2)
          set((s) => ({ printsRev: s.printsRev + 1 }))
          toast(e.state === "complete" ? "Practice print finished" : "Practice print stopped", {
            id: `practice-${e.printId}`,
            description: "Nothing was printed. A real printer does the same steps.",
            duration: 10000,
          })
          return
        }
        set((s) =>
          s.finishedPrints.some((f) => f.printId === e.printId)
            ? { printsRev: s.printsRev + 1 }
            : { printsRev: s.printsRev + 1, finishedPrints: [...s.finishedPrints, { printId: e.printId, projectId: e.projectId, state: e.state }] },
        )
        return
      case "prints.changed":
        set((s) => ({ printsRev: s.printsRev + 1 }))
        get().loadOverview(e.projectId)
        // shown estimates use the time factor from finished prints
        if (get().project?.id) void get().loadJobs(get().project!.id)
        return
      case "project.changed": {
        const prev = get().fileChange
        set({ fileChange: { projectId: e.projectId, paths: e.paths ?? [], n: (prev?.n ?? 0) + 1 } })
        if (get().project?.id === e.projectId && (e.paths ?? []).some((p) => p.endsWith("project.json")))
          void get().refreshProject()
        if ((e.paths ?? []).some((p) => /(^|\/)assembly\.(json|scad)$/.test(p))) void get().loadAssembly(e.projectId)
        // staleness is computed by the server on read: any edit may have put the latest slice (and any check,
        // render, guide or motion check) out of date
        if (get().project?.id === e.projectId) {
          void get().loadJobs(e.projectId)
          get().loadValidity(e.projectId)
        }
        if (get().route.name === "library") void get().loadProjects()
        return
      }
      case "render.started": {
        const k = partKey(e.projectId, e.partId)
        set((s) => ({ rendering: { ...s.rendering, [k]: true } }))
        return
      }
      case "render.done": {
        const k = partKey(e.projectId, e.result.partId)
        set((s) => ({
          renders: { ...s.renders, [k]: e.result },
          rendering: { ...s.rendering, [k]: false },
          // sent pins stay on the model until the next render of it arrives
          ...(s.pins[e.projectId]?.some((p) => p.sent) && !e.result.cached
            ? { pins: { ...s.pins, [e.projectId]: s.pins[e.projectId].filter((p) => !p.sent) } }
            : {}),
        }))
        if (get().project?.id === e.projectId) get().loadValidity(e.projectId)
        return
      }
      case "check.done": {
        const k = partKey(e.projectId, e.report.partId)
        set((s) => ({ checks: { ...s.checks, [k]: e.report } }))
        if (get().project?.id === e.projectId) get().loadValidity(e.projectId)
        return
      }
      case "slice.done": {
        const k = partKey(e.projectId, e.result.partId)
        set((s) => ({ slices: { ...s.slices, [k]: e.result } }))
        // a new slice (e.g. by the agent): the Layers tab follows it with a fresh summary
        void get().noteSliced(e.projectId, e.result.gcodePath, (e.result as { preview?: SlicePreviewSummary }).preview)
        return
      }
      case "printer.status": {
        const mid = e.status.machineId
        const list = get().machines
        if (mid && list) set({ machines: list.map((m) => (m.id === mid ? { ...m, status: e.status } : m)) })
        // `printer` mirrors the default machine (status bar, legacy panels)
        const def = list ? defaultMachine(list) : null
        if (!mid || !def || def.id === mid) set({ printer: e.status, printerError: null })
        return
      }
      case "print.request":
        get().addPrintRequest(e.request)
        return
      case "print.request.resolved":
        get().removePrintRequest(e.requestId)
        return
      case "versions.changed": {
        if (get().project?.id !== e.projectId) return
        void get().loadCheckpoints(e.projectId)
        return
      }
      case "jobs.changed": {
        if (get().project?.id !== e.projectId) return
        void get().loadJobs(e.projectId)
        // also sent after a restore / idea switch: artifact freshness and the Layers summary may have changed
        get().loadValidity(e.projectId)
        const g = get().lastGcode[e.projectId]
        if (g) void get().loadPreview(e.projectId, g, true)
        return
      }
      default:
        return
    }
  },
}))

// Prints whose result card was put off: remembered per browser so a reconnect snapshot doesn't nag again.
function readLaterPrints(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem("ps-later-prints") ?? "[]") as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}
function writeLaterPrints(ids: string[]) {
  try {
    localStorage.setItem("ps-later-prints", JSON.stringify(ids))
  } catch {
    /* ignore */
  }
}

// U2: the Beginner/Maker mode is gone (one product, two depths: per-panel Details). Forget an old stored mode.
try {
  localStorage.removeItem("ps-ui-mode")
} catch {
  /* storage unavailable: nothing to forget */
}

window.addEventListener("hashchange", () => {
  useStudio.setState({ route: parseHash() })
})
