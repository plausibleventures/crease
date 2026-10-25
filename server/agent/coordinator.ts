// Session coordinator (R11a): owns agent sessions and runs, whatever the runtime.
//
// One live session per project. A run is one user turn: run.started when the user sends, run.completed / failed /
// interrupted when the runtime ends it (FIFO, so queued turns line up). A message sent while a run is open is queued
// until the runtime reports it received (host.received): a later turn started with it, or it was folded/steered into
// the running turn (then its run joins the head run). The coordinator wraps every event an adapter
// emits in an AgentEventEnvelope (seq, ids, run, design revision), drops exact duplicates, persists it
// (transcript.ts) and pushes it over WS. It also owns what must not depend on the runtime: the question broker and
// its review gate, approval tracking from the user's words and answers, cost/status, idle shutdown.
import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import {
  AGENT_EVENT_SCHEMA_VERSION,
  type AgentEnvelope,
  type AgentEvent,
  type AgentEventEnvelope,
  type AgentStatusInfo,
  type AgentInputImage,
  type AgentProfileSnapshot,
  type HandoffDesigner,
  type HandoffPreview,
  type HandoffReason,
  type HandoffRecord,
  type HandoffSummary,
  type PointAnnotation,
  type Project,
  type ProjectSession,
} from "../../shared/types"
import { touchSession, upsertSession } from "../db"
import { emit, onEvent } from "../events"
import { currentIdeaAt } from "../projects/revision"
import { redactDeep, redactSecrets } from "../secrets"
import { onQuestionsAnswered, onToolAllowed, onUserMessage } from "./approval"
import { deps } from "./deps"
import { recordFailure } from "./failures"
import { designerFromEvents, designerLabel, designerOf, handoffMarkdown, handoffMessage, markDelivered, pendingHandoff, runtimeLabel, saveHandoff, setPending } from "./handoff"
import type { PolicyOptions } from "./policy"
import { answerPermission as answerPendingPermission, askPermission, cancelPermissions, listPermissions } from "./permissions"
import { answeredText, answerQuestion as answerPendingQuestion, askUser, cancelDetachedQuestions, cancelQuestions, listQuestions, pauseQuestion, replyInChat } from "./questions"
import type { ToolRegistry } from "./registry"
import { reviewQuestionGate } from "./review"
import { designRevision } from "./revision"
import type { AdapterHost, AgentAdapter, AgentRuntime, AgentTurnInput, EmitOptions, QuestionOutcome } from "./runtime/types"
import { sessionFingerprint } from "./profiles"
import { appendEvent, appendNative, copyNative, nativeRef, nextSeq, readEvents, readNative, sessionCostFrom, sessionsDir, setNativeRef, writeEvents } from "./transcript"

/** What the app prepares for a session before the runtime starts (agent config, skills, prompt, policy, model). */
export interface PreparedSession {
  instructions: string
  policy: PolicyOptions
  /** A model override for every session (tests/evals); null = the effective profile's model. */
  model: string | null
  maxTurns?: number
  /** Notices to show at the start (e.g. project assistant settings that were turned off). */
  notices: string[]
}

export interface CoordinatorOptions {
  runtimes: AgentRuntime[]
  /** Runtime for a project (R11a). Superseded by resolveProfile; used only when that's absent. */
  pick?: (project: Project) => string
  /** R11b: the project's effective agent profile (its own pick, else the default), frozen at each call. */
  resolveProfile?: (project: Project) => AgentProfileSnapshot
  tools: ToolRegistry
  prepare: (projectId: string, project: Project, dir: string) => Promise<PreparedSession>
  /** Idle sessions (not running, no question waiting) are closed after this long. 0 = never. */
  idleMs?: number
  /** After Pause at a question, how long the designer gets to end its turn before it is stopped. Default 30 s. */
  pauseGraceMs?: number
  /**
   * R11g: the app's handoff summary of the project (handoff-collect.ts), for a new chat on another runtime or a fresh
   * chat. Absent = switching runtimes starts fresh with a notice (no summary).
   */
  summarize?: (projectId: string, fromSessionId: string | null) => Promise<HandoffSummary>
}

/** Options for an explicit handoff (the dialog's choice). profileId undefined = keep the project's designer. */
export interface HandoffStart {
  reason: HandoffReason
  profileId?: string | null
  model?: string | null
  /** the user's edit of the summary; empty/undefined = the generated one */
  markdown?: string
  /** "resume": back to an earlier chat of the target runtime (native resume), told what changed since */
  mode?: "new" | "resume"
  resumeSessionId?: string
  /** idea the new chat belongs to ("Try this with another designer") */
  branch?: string | null
  title?: string
}

interface Live {
  projectId: string
  sessionId: string
  runtime: AgentRuntime
  adapter: AgentAdapter
  model: string | null
  /** The profile this runtime process was started with (frozen). */
  profile: AgentProfileSnapshot
  projectName: string | null
  /** Per run: the profile frozen when it started, the session cost then, and whether its budget stopped it. */
  runProfiles: Map<string, { profile: AgentProfileSnapshot; startCost: number; budgetStopped: boolean }>
  seq: number
  nativeSeq: number
  /** Open runs, oldest first: the head is the one the runtime is working on. */
  runs: string[]
  /** Runs whose message was sent while another ran (run.started queued) and the designer hasn't read yet. */
  waiting: Set<string>
  running: boolean
  /** The user (or a budget) stopped the designer: its open question cards close instead of waiting (askUser). */
  stopped?: boolean
  costUsd: number
  lastActivity: number
  revision: string | null
  /** type|itemId -> last persisted payload, to drop exact duplicates (replays, reconnects). */
  seen: Map<string, string>
}

const RUN_END = new Set(["run.completed", "run.failed", "run.interrupted"])
const isRunEnd = (e: AgentEvent): e is Extract<AgentEvent, { type: "run.completed" | "run.failed" | "run.interrupted" }> => RUN_END.has(e.type)

export class SessionCoordinator {
  private sessions = new Map<string, Live>()
  private runtimes = new Map<string, AgentRuntime>()
  private stopWatch: () => void
  private reaper: NodeJS.Timeout | null = null

  constructor(private o: CoordinatorOptions) {
    for (const r of o.runtimes) this.runtimes.set(r.kind, r)
    // Files changing while a run is going: artifact.changed in that session's stream. The app's own bookkeeping
    // (.claude skills it installs, .studio records, .git) isn't a design artifact.
    this.stopWatch = onEvent((e) => {
      if (e.type !== "project.changed") return
      const live = this.sessions.get(e.projectId)
      const paths = e.paths.filter((p) => !/^(\.claude|\.studio|\.git)(\/|$)/.test(p))
      if (live?.running && paths.length) this.record(live, { type: "artifact.changed", paths }, { itemId: null })
    })
    const idle = o.idleMs ?? 0
    if (idle > 0) {
      this.reaper = setInterval(() => this.reapIdle(idle), Math.min(60_000, Math.max(1000, idle / 4)))
      this.reaper.unref()
    }
  }

  dispose() {
    this.stopWatch()
    if (this.reaper) clearInterval(this.reaper)
    for (const id of [...this.sessions.keys()]) this.closeSession(id)
  }

  /** The project's effective profile, frozen now. Without resolveProfile: the R11a pick / first runtime. */
  profileFor(project: Project): AgentProfileSnapshot {
    if (this.o.resolveProfile) return this.o.resolveProfile(project)
    const runtime = this.o.pick?.(project) ?? this.o.runtimes[0]?.kind ?? "none"
    return {
      profileId: null,
      name: runtime,
      runtime,
      model: project.agentModel ?? null,
      auth: { kind: "subscription" },
      endpointRef: null,
      binaryPath: null,
      effort: null,
      budget: { maxUsdPerRun: null },
      policy: "design-sandbox",
      source: "legacy",
      frozenAt: new Date().toISOString(),
    }
  }

  private runtimeOf(profile: AgentProfileSnapshot): AgentRuntime {
    const r = this.runtimes.get(profile.runtime)
    if (!r)
      throw Object.assign(
        new Error(`The designer "${profile.name}" can't run here: it isn't available in this version of Crease. Pick another designer in Agents.`),
        { statusCode: 400 }
      )
    return r
  }

  /** Runtime of a session recorded before R11b (no `runtime` field): Claude's, when Claude is registered. */
  private legacyRuntime(fallback: string): string {
    return this.runtimes.has("claude") ? "claude" : fallback
  }

  private runtimeFor(project: Project): AgentRuntime {
    return this.runtimeOf(this.profileFor(project))
  }

  /** The runtime that holds a session's conversation (sessions from before R11b are Claude's). */
  private heldBy(projectId: string, project: Project, sessionId: string, fallback: string): string {
    return nativeRef(projectId, sessionId)?.runtime ?? project.sessions.find((x) => x.id === sessionId)?.runtime ?? this.legacyRuntime(fallback)
  }

  /** Who held a session: its last run's frozen profile, else what project.json recorded. */
  private sessionDesigner(projectId: string, project: Project, sessionId: string | null): HandoffDesigner | null {
    if (!sessionId) return null
    const runtime = this.heldBy(projectId, project, sessionId, this.profileFor(project).runtime)
    const fromEvents = designerFromEvents(readEvents(projectId, sessionId), runtime)
    if (fromEvents) return fromEvents
    const entry = project.sessions.find((x) => x.id === sessionId)
    return entry ? { profileId: entry.profileId ?? null, name: designerLabel(runtimeLabel(runtime), entry.model ?? null), runtime, model: entry.model ?? null } : null
  }

  /** The profile the project would have with this designer/model pick (undefined = its current pick). */
  private targetProfile(project: Project, profileId: string | null | undefined, model: string | null | undefined): AgentProfileSnapshot {
    if (profileId === undefined) return this.profileFor(model ? { ...project, agentModel: model, agentModelRuntime: this.profileFor(project).runtime } : project)
    const runtime = this.profileFor({ ...project, agentProfileId: profileId, agentModel: null }).runtime
    return this.profileFor({ ...project, agentProfileId: profileId, agentModel: model ?? null, agentModelRuntime: model ? runtime : null })
  }

  // ---------------------------------------------------------------------------------------------
  // Recording
  // ---------------------------------------------------------------------------------------------

  private emitStatus(s: Live) {
    emit({
      type: "agent.status",
      projectId: s.projectId,
      running: s.running,
      sessionId: s.sessionId,
      costUsd: s.costUsd,
    })
  }

  private refreshRevision(s: Live) {
    try {
      s.revision = designRevision(s.projectId)
    } catch {
      /* keep the last one */
    }
  }

  /** Wrap, dedupe, persist and broadcast one event of a live session. */
  private record(s: Live, event: AgentEvent, opts: EmitOptions & { runId?: string | null; runtime?: string } = {}) {
    const persist = opts.persist !== false
    const itemId = opts.itemId ?? null
    if (persist && itemId !== null) {
      const key = `${event.type}|${itemId}`
      const payload = JSON.stringify(event)
      if (s.seen.get(key) === payload) return // exact duplicate
      s.seen.set(key, payload)
    }
    if (event.type === "run.started" || event.type === "tool.completed" || isRunEnd(event)) this.refreshRevision(s)
    s.lastActivity = Date.now()
    const env: AgentEventEnvelope = {
      schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
      eventId: String(s.seq),
      seq: s.seq++,
      ts: new Date().toISOString(),
      projectId: s.projectId,
      sessionId: s.sessionId,
      runId: opts.runId !== undefined ? opts.runId : (s.runs[0] ?? null),
      itemId,
      revision: s.revision,
      runtime: opts.runtime ?? s.runtime.kind,
      // The agent can see its own env (e.g. a Bash `env`): keep key values out of transcripts and the timeline.
      event: redactDeep(event),
    }
    if (persist) {
      try {
        appendEvent(env)
      } catch (e) {
        console.error("[agent] transcript write failed", e)
      }
      try {
        const cost = isRunEnd(event) ? (event.result?.usage?.billedUsd ?? event.result?.usage?.estimatedApiUsd ?? undefined) : undefined
        touchSession(s.projectId, s.sessionId, {
          lastMessageAt: env.ts,
          userPrompt: event.type === "run.started" ? event.input.text : undefined,
          costUsd: cost ?? undefined,
        })
      } catch (e) {
        console.error("[catalog] touchSession failed", e)
      }
    }
    emit({ type: "agent.event", ...env })
    this.afterEvent(s, env)
  }

  /** Status bookkeeping driven by events. */
  private afterEvent(s: Live, env: AgentEventEnvelope) {
    const ev = env.event
    if (ev.type === "usage.updated") {
      const v = ev.usage.billedUsd ?? ev.usage.estimatedApiUsd
      if (typeof v !== "number") return
      // live estimates never go down; a reconciled total replaces them
      if (ev.usage.final ? Math.abs(v - s.costUsd) > 1e-9 : v > s.costUsd + 1e-6) {
        s.costUsd = ev.usage.final ? v : Math.max(s.costUsd, v)
        if (this.sessions.get(s.projectId) === s) this.emitStatus(s)
      }
      this.checkBudget(s, env.runId ?? s.runs[0] ?? null)
    } else if (isRunEnd(ev)) {
      if (ev.type === "run.failed") {
        const run = env.runId ? s.runProfiles.get(env.runId) : undefined
        this.failure(s, env.runId, run?.profile ?? s.profile, "failed", ev.error)
      }
      if (env.runId) s.runProfiles.delete(env.runId)
      const usage = ev.result?.usage
      const v = usage?.final ? (usage.billedUsd ?? usage.estimatedApiUsd) : null
      if (typeof v === "number") s.costUsd = v
      s.runs.shift()
      // Nothing queued behind it: any other open run was folded into this turn by the runtime.
      if (!ev.result?.queued) s.runs.length = 0
      s.running = s.runs.length > 0
      // Waiting messages whose run closed without a received: folded into a turn that ran to its end, or dropped (Stop,
      // the runtime itself failed).
      this.settleWaiting(s, ev.type === "run.interrupted" || (ev.type === "run.failed" && !ev.result) ? "dropped" : "received")
      if (this.sessions.get(s.projectId) === s) this.emitStatus(s)
    }
  }

  /** The runtime has the message of `runId`: a run that isn't the head joins the head run (folded/steered in). */
  private received(s: Live, runId: string) {
    const i = s.runs.indexOf(runId)
    if (i > 0) {
      s.runs.splice(i, 1)
      s.runProfiles.delete(runId)
    }
    if (s.waiting.delete(runId)) this.record(s, { type: "input.status", status: "received" }, { itemId: `input:${runId}`, runId, runtime: "app" })
  }

  /** Close the queued state of waiting messages whose run is no longer open. */
  private settleWaiting(s: Live, status: "received" | "dropped") {
    for (const runId of [...s.waiting]) {
      if (s.runs.includes(runId)) continue
      s.waiting.delete(runId)
      this.record(s, { type: "input.status", status }, { itemId: `input:${runId}`, runId, runtime: "app" })
    }
  }

  /**
   * Budget: a run whose spend (session cost now minus at its start; billed with an API key, the estimate on a
   * subscription) passes its frozen profile's maxUsdPerRun is stopped, with a plain notice. Once per run.
   */
  private checkBudget(s: Live, runId: string | null) {
    const run = runId ? s.runProfiles.get(runId) : undefined
    const limit = run?.profile.budget.maxUsdPerRun
    if (!run || !runId || typeof limit !== "number" || run.budgetStopped) return
    const spent = s.costUsd - run.startCost
    if (spent <= limit) return
    run.budgetStopped = true
    const text = `Stopped: this request reached its $${limit.toFixed(2)} budget (about $${spent.toFixed(2)} used). Your design so far is kept. To keep going, raise the budget for “${run.profile.name}” in Agents, or ask for a smaller change.`
    this.recordNative(s, { type: "app_error", error: text })
    this.record(
      s,
      { type: "notice", level: "error", code: "budget.exceeded", text, data: { limitUsd: limit, spentUsd: spent, profileId: run.profile.profileId } },
      { itemId: `budget:${runId}`, runtime: "app" }
    )
    this.failure(s, runId, run.profile, "budget", text)
    s.stopped = true
    void s.adapter.interrupt().catch(() => {})
  }

  private failure(s: Live, runId: string | null, profile: AgentProfileSnapshot, kind: "failed" | "budget" | "auth", error: string) {
    try {
      recordFailure({
        projectId: s.projectId,
        projectName: s.projectName,
        sessionId: s.sessionId,
        runId,
        profileId: profile.profileId,
        profileName: profile.name,
        runtime: profile.runtime,
        kind,
        error,
      })
    } catch (e) {
      console.error("[agent] failure record failed", e)
    }
  }

  /** A native runtime message (or the app's legacy-format line) for diagnostics, evals and the legacy timeline. */
  private recordNative(s: Live, message: unknown, persist = true) {
    const env: AgentEnvelope = {
      projectId: s.projectId,
      sessionId: s.sessionId,
      seq: s.nativeSeq++,
      ts: new Date().toISOString(),
      message: redactDeep(message),
    }
    if (persist) {
      try {
        appendNative(env)
      } catch (e) {
        console.error("[agent] native log write failed", e)
      }
    }
  }

  /** An app notice in a live session (normalized + its legacy-format mirror). */
  private notice(s: Live, text: string, level: "info" | "error" = "info") {
    this.recordNative(s, level === "info" ? { type: "app_notice", text } : { type: "app_error", error: text })
    this.record(s, { type: "notice", level, text }, { itemId: `notice:${s.seq}`, runtime: "app" })
  }

  /** An answer to a card whose turn already ended (paused, or the runtime moved on): sent as the next message. */
  private lateAnswer(projectId: string, asked: { question: string }[]) {
    return (later: QuestionOutcome) => {
      if (!later.answered) return
      onQuestionsAnswered(projectId, asked, later.answers)
      const line = Object.values(later.answers)
        .map((a) => a.replace(/\s*\(recommended\)/gi, ""))
        .join(" · ")
      void this.sendMessage(projectId, line, [], [], answeredText(later), { fromAnswer: true }).catch((e) =>
        console.error("[agent] sending a late answer failed", e)
      )
    }
  }

  private host(s: Live): AdapterHost {
    return {
      emit: (event, opts) => {
        this.record(s, event, opts)
        if (event.type === "notice" && event.level === "error" && /auth/.test(event.code ?? "")) this.failure(s, s.runs[0] ?? null, s.profile, "auth", event.text)
      },
      native: (message, opts) => this.recordNative(s, message, opts?.persist !== false),
      askUser: async (input, o) => {
        const qs = (Array.isArray(input.questions) ? input.questions : []) as {
          question?: unknown
        }[]
        const asked = qs.map((q) => ({ question: String(q?.question ?? "") }))
        // "How does this look?" before the picture guide a build needs: finish it first, so one approval covers it all.
        const early = await reviewQuestionGate(s.projectId, asked)
        if (early) return { answered: false, message: early }
        const r = await askUser(s.projectId, s.sessionId, input, {
          ...o,
          // The turn ended without the answer (Codex doesn't wait for it): keep the card, and send the answer as the
          // user's next message so the designer carries on from it. Not when the user stopped it or the chat closed.
          keepOnAbort: () => (s.stopped || this.sessions.get(s.projectId) !== s ? null : this.lateAnswer(s.projectId, asked)),
          onAsked: (req) =>
            this.record(
              s,
              {
                type: "question.requested",
                requestId: req.requestId,
                questions: req.questions,
              },
              { itemId: `q:${req.requestId}`, runtime: "app" }
            ),
        })
        // "Looks great" on the review question approves the design; any other review answer means more changes.
        if (r.answered) onQuestionsAnswered(s.projectId, asked, r.answers)
        return r
      },
      askPermission: (ask, o) =>
        askPermission(s.projectId, s.sessionId, ask, {
          ...o,
          onAsked: (req) =>
            this.record(
              s,
              { type: "permission.requested", requestId: req.requestId, tool: req.tool, input: { title: req.title, detail: req.detail }, reason: req.title },
              { itemId: `perm:${req.requestId}`, runtime: "app" }
            ),
        }),
      nativeToolAllowed: (name, input) => onToolAllowed(s.projectId, name, input),
      received: (inputId) => this.received(s, inputId),
      nativeSessionChanged: (id) => {
        // Runtimes with their own ids: the app session id stays; only the map changes.
        if (s.runtime.ownSessionIds) return setNativeRef(s.projectId, s.sessionId, { runtime: s.runtime.kind, nativeId: id })
        s.sessionId = id
        void deps.updateProject(s.projectId, { activeSessionId: id }).catch(() => {})
      },
      ended: ({ error }) => {
        if (error) {
          if (s.runs.length) {
            this.recordNative(s, { type: "app_error", error })
            this.record(s, { type: "run.failed", error }, { itemId: `fail:${s.seq}`, runtime: "app" })
          } else this.notice(s, error, "error")
        } else this.closeOpenRun(s)
        s.runs.length = 0
        s.running = false
        this.settleWaiting(s, "dropped")
        // A session replaced via switchSession/closeSession must not overwrite the new session's status.
        if (this.sessions.get(s.projectId) === s) {
          this.sessions.delete(s.projectId)
          this.emitStatus(s)
        }
      },
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------

  private async start(projectId: string, profile?: AgentProfileSnapshot): Promise<Live> {
    const project = await deps.getProject(projectId)
    profile ??= this.profileFor(project)
    const runtime = this.runtimeOf(profile)
    const dir = deps.projectDir(projectId)
    mkdirSync(sessionsDir(projectId), { recursive: true })
    const prepared = await this.o.prepare(projectId, project, dir)
    if (prepared.model) profile = { ...profile, model: prepared.model }
    // A conversation can only be resumed by the runtime that holds it (sessions from before R11b are Claude's).
    let resumeId = project.activeSessionId
    const leftId = resumeId
    // R11d: runtimes that choose their own ids (Codex threads) resume by the native id in the session's map.
    const ref = resumeId ? nativeRef(projectId, resumeId) : null
    const heldBy = resumeId ? this.heldBy(projectId, project, resumeId, runtime.kind) : null
    const switched = !!heldBy && heldBy !== runtime.kind
    if (switched) resumeId = null
    // R11g: a chat created by a handoff has no native conversation yet: the runtime starts one (Claude pins its id).
    const fresh = resumeId ? pendingHandoff(projectId, resumeId)?.mode === "new" : false
    const resumeNative = resumeId && !fresh ? (ref?.nativeId ?? (runtime.ownSessionIds ? null : resumeId)) : null
    const sessionId = resumeId ?? randomUUID()
    // R11g: the designer changed outside the handoff dialog (the default in Agents, an old chat): the new chat still
    // starts from the app's summary of the one it leaves, never from nothing.
    let auto: HandoffRecord | null = null
    if (switched && this.o.summarize && leftId && readEvents(projectId, leftId).some((e) => e.event.type === "run.started")) {
      try {
        auto = await this.createHandoff(projectId, project, { reason: "auto", mode: "new", fromId: leftId, to: profile, toSessionId: sessionId })
      } catch (e) {
        console.error("[agent] handoff summary failed", e)
      }
    }
    const prior = readEvents(projectId, sessionId)
    const s = {
      projectId,
      sessionId,
      runtime,
      model: profile.model,
      profile,
      projectName: project.name ?? null,
      runProfiles: new Map(),
      seq: nextSeq(projectId, sessionId),
      nativeSeq: readNative(projectId, sessionId).reduce((m, e) => Math.max(m, (typeof e.seq === "number" ? e.seq : -1) + 1), 0),
      runs: [],
      waiting: new Set(),
      running: false,
      costUsd: sessionCostFrom(prior),
      lastActivity: Date.now(),
      revision: null,
      seen: new Map(),
    } as Omit<Live, "adapter"> as Live
    s.adapter = runtime.create(this.host(s))
    // App tools bound to this session; the run is read at each call.
    const tools = this.o.tools.bind(() => ({
      projectId,
      sessionId: s.sessionId,
      runId: s.runs[0] ?? null,
      runtime: runtime.kind,
    }))
    this.sessions.set(projectId, s)
    try {
      const { nativeSessionId } = await s.adapter.start({
        projectId,
        sessionId,
        cwd: dir,
        resume: resumeNative,
        instructions: prepared.instructions,
        tools,
        policy: prepared.policy,
        priorCostUsd: s.costUsd,
        maxTurns: prepared.maxTurns,
        profile,
      })
      if (nativeSessionId) setNativeRef(projectId, sessionId, { runtime: runtime.kind, nativeId: nativeSessionId })
    } catch (e) {
      if (this.sessions.get(projectId) === s) this.sessions.delete(projectId)
      throw e
    }
    for (const text of prepared.notices) this.notice(s, text)
    if (auto) {
      this.record(s, this.handoffMarker(auto), { itemId: `handoff:${auto.id}`, runtime: "app" })
      this.leftMarker(projectId, auto)
    } else if (switched)
      this.notice(s, `Started a new conversation with ${profile.name}: conversations don't carry over between designers. Your design files are all here.`)

    if (!resumeId) {
      const entry: ProjectSession = {
        id: sessionId,
        title: auto ? `Handed over to ${runtimeLabel(runtime.kind)}` : "Design session",
        forkedFrom: null,
        runtime: runtime.kind,
        profileId: project.agentProfileId ?? null,
        model: project.agentModel ?? null,
        ...(auto ? { handoff: { id: auto.id, fromSessionId: auto.fromSessionId, from: auto.from?.name ?? "", reason: auto.reason } } : {}),
      }
      await deps.updateProject(projectId, {
        activeSessionId: sessionId,
        sessions: [...project.sessions.filter((x) => x.id !== sessionId), entry],
      })
      try {
        upsertSession(projectId, sessionId, {
          title: "Design session",
          forkedFrom: null,
          createdAt: new Date().toISOString(),
        })
      } catch (e) {
        console.error("[catalog] upsertSession failed", e)
      }
    }
    return s
  }

  async sendMessage(
    projectId: string,
    text: string,
    images: AgentInputImage[],
    annotations: PointAnnotation[],
    agentText: string,
    opts: { fromAnswer?: boolean } = {}
  ): Promise<{ sessionId: string | null }> {
    // A typed message replaces any card left open from an earlier turn (an answer to one comes through here too).
    // A message sent while the designer waits on a question (photos, pins, a check's button) is the reply: the
    // question closes unanswered so the message isn't stuck behind it until the user also answers the card.
    if (!opts.fromAnswer) {
      cancelDetachedQuestions(projectId)
      replyInChat(projectId)
    }
    let s = this.sessions.get(projectId)
    // Freeze the effective profile for this run. A live, idle session started with a different sign-in, runtime or
    // effort is restarted (resumed when the runtime is the same); a model-only change is switched in place.
    let profile = this.profileFor(await deps.getProject(projectId))
    if (s?.adapter.alive && !s.running) {
      if (sessionFingerprint(profile) !== sessionFingerprint(s.profile)) {
        this.closeSession(projectId)
        s = undefined
      } else if (profile.model && profile.model !== s.model) {
        if (s.runtime.capabilities.modelSwitch && s.adapter.setModel) {
          await s.adapter.setModel(profile.model)
          s.model = profile.model
          this.notice(s, `Model switched to ${profile.model}`)
        } else {
          this.closeSession(projectId)
          s = undefined
        }
      }
    }
    if (!s || !s.adapter.alive) s = await this.start(projectId, profile)
    // Queued behind a live run: it runs in that process, so its runtime and sign-in are the live session's.
    if (sessionFingerprint(profile) !== sessionFingerprint(s.profile)) profile = { ...s.profile, budget: profile.budget, frozenAt: profile.frozenAt }
    profile = { ...profile, model: s.model }
    const runId = randomUUID()
    // Another run is open: the designer reads this when it can (input.status follows).
    const queued = s.runs.length > 0
    s.runs.push(runId)
    if (queued) s.waiting.add(runId)
    s.stopped = false
    s.runProfiles.set(runId, { profile, startCost: s.costUsd, budgetStopped: false })
    const input = {
      text,
      ...(images.length ? { images } : {}),
      ...(annotations.length ? { annotations } : {}),
    }
    this.recordNative(s, { type: "user_input", ...input })
    this.record(
      s,
      {
        type: "run.started",
        input,
        model: s.model,
        profile: { id: profile.profileId, name: profile.name, runtime: profile.runtime, budgetUsd: profile.budget.maxUsdPerRun },
        ...(queued ? { queued: true } : {}),
      },
      { itemId: `user:${runId}`, runId, runtime: "app" }
    )
    onUserMessage(projectId, text) // "print it", "send it to the printer", "…and print" approve the design
    s.running = true
    s.lastActivity = Date.now()
    this.emitStatus(s)
    // R11g: a chat started from a handoff gets the summary as the start of its first message (the bubble shows only
    // what the user typed). Delivered once; the record keeps when.
    const handoff = pendingHandoff(projectId, s.sessionId)
    if (handoff) {
      agentText = handoffMessage(handoff, agentText)
      try {
        markDelivered(projectId, handoff)
      } catch (e) {
        console.error("[agent] handoff delivery record failed", e)
      }
      this.recordNative(s, { type: "app_handoff", handoffId: handoff.id, chars: handoff.markdown.length })
    }
    const turn: AgentTurnInput = { id: runId, text, agentText, images, annotations }
    s.adapter.send(turn)
    return { sessionId: s.sessionId }
  }

  async answerQuestion(projectId: string, requestId: string, answers: Record<string, string>, notes?: Record<string, string>) {
    const s = this.sessions.get(projectId)
    if (s?.adapter.alive) s.adapter.answerQuestion(requestId, answers, notes)
    else answerPendingQuestion(projectId, requestId, answers, notes)
  }

  /**
   * The user pauses the designer at a question: the question stays open (paused), the turn ends, and the answer or
   * any new message continues as the user's next message. Runtime-neutral: every runtime asks through host.askUser.
   */
  async pause(projectId: string, requestId: string) {
    const request = listQuestions(projectId).find((q) => q.requestId === requestId)
    const s = this.sessions.get(projectId)
    if (!request || !s || !pauseQuestion(projectId, requestId, this.lateAnswer(projectId, request.questions))) {
      throw Object.assign(new Error("No open question with that id (already answered, paused or cancelled)."), { statusCode: 404 })
    }
    this.notice(s, "Paused. Answer when you're ready.")
    // The designer is told to end its turn (a clean end, no "Stopped" error). If it is still going after a while,
    // stop the turn so it doesn't carry on meanwhile. Not with messages queued behind it: an interrupt drops them.
    const run = s.runs[0]
    const t = setTimeout(() => {
      if (this.sessions.get(projectId) !== s || !s.running || s.runs[0] !== run || s.waiting.size) return
      if (!listQuestions(projectId).some((q) => q.requestId === requestId && q.paused)) return
      void s.adapter.interrupt().catch((e) => console.error("[agent] pausing: interrupt failed", e))
    }, this.o.pauseGraceMs ?? 30_000)
    t.unref?.()
  }

  /** Answer a permission.requested (runtimes ask through host.askPermission; the broker resolves that promise). */
  async answerPermission(projectId: string, requestId: string, allow: boolean) {
    answerPendingPermission(projectId, requestId, allow)
  }

  private async interruptLive(projectId: string) {
    const live = this.sessions.get(projectId)
    if (live) live.stopped = true
    if (live?.running) {
      try {
        await live.adapter.interrupt()
      } catch {
        /* closing anyway */
      }
    }
  }

  /**
   * Make `sessionId` the project's active session (or start fresh with `null`): ends the live session, updates
   * project.json; the next message resumes the chosen session.
   */
  async switchSession(projectId: string, sessionId: string | null): Promise<{ sessionId: string | null }> {
    const project = await deps.getProject(projectId)
    if (sessionId && !project.sessions.some((x) => x.id === sessionId)) {
      throw Object.assign(new Error(`session not found: ${sessionId}`), {
        statusCode: 404,
      })
    }
    if (this.sessions.has(projectId)) {
      await this.interruptLive(projectId)
      this.closeSession(projectId)
    }
    // R11g: a chat held by another runtime than the project's designer brings its designer back (when recorded), so
    // opening it resumes it natively instead of handing it over.
    const entry = sessionId ? project.sessions.find((x) => x.id === sessionId) : undefined
    const designer =
      entry && entry.profileId !== undefined && this.heldBy(projectId, project, entry.id, this.profileFor(project).runtime) !== this.profileFor(project).runtime
        ? { agentProfileId: entry.profileId, agentModel: entry.model ?? null, agentModelRuntime: entry.model ? (entry.runtime ?? null) : null }
        : {}
    await deps.updateProject(projectId, { activeSessionId: sessionId, ...designer })
    emit({
      type: "agent.status",
      projectId,
      running: false,
      sessionId,
      costUsd: this.sessionCost(projectId, sessionId),
    })
    return { sessionId }
  }

  /** Cumulative session cost from the transcript. */
  sessionCost(projectId: string, sessionId: string | null): number {
    return sessionId ? sessionCostFrom(readEvents(projectId, sessionId)) : 0
  }

  async stop(projectId: string): Promise<void> {
    // Stop also closes a card left open by a turn that already ended (Codex): nothing is waiting on it any more.
    cancelDetachedQuestions(projectId)
    const s = this.sessions.get(projectId)
    if (!s || !s.adapter.alive) return
    s.stopped = true
    try {
      await s.adapter.interrupt()
    } catch (e) {
      this.notice(s, `interrupt failed: ${e instanceof Error ? e.message : String(e)}`, "error")
    }
    s.running = false
    this.emitStatus(s)
  }

  /**
   * An app notice in the project's timeline (e.g. a print request cancelled by a restart): recorded in the live
   * session, else appended to the active session's transcript (shown on the next timeline load). No session = none.
   */
  async appendNotice(projectId: string, text: string): Promise<void> {
    const live = this.sessions.get(projectId)
    if (live) return this.notice(live, text)
    const sessionId = (await deps.getProject(projectId)).activeSessionId
    if (!sessionId) return
    const env = this.offlineNotice(projectId, sessionId, text)
    emit({ type: "agent.event", ...env })
  }

  /** Append a notice to a session that isn't live (both logs). */
  private offlineNotice(projectId: string, sessionId: string, text: string | Extract<AgentEvent, { type: "notice" }>): AgentEventEnvelope {
    const event: Extract<AgentEvent, { type: "notice" }> = typeof text === "string" ? { type: "notice", level: "info", text } : text
    text = event.text
    const seq = nextSeq(projectId, sessionId)
    const ts = new Date().toISOString()
    const env: AgentEventEnvelope = {
      schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
      eventId: String(seq),
      seq,
      ts,
      projectId,
      sessionId,
      runId: null,
      itemId: event.code === "handoff.started" ? `handoff:${String(event.data?.handoffId ?? seq)}` : `notice:${seq}`,
      revision: null,
      runtime: "app",
      event: redactDeep(event),
    }
    appendEvent(env)
    const nseq = readNative(projectId, sessionId).reduce((m, e) => Math.max(m, (typeof e.seq === "number" ? e.seq : -1) + 1), 0)
    appendNative({
      projectId,
      sessionId,
      seq: nseq,
      ts,
      message: { type: "app_notice", text },
    })
    return env
  }

  /**
   * Switch the agent model for this project: saved with the project (.studio/state.json `agentModel`, used by its
   * next session) and applied to its live session (if any) from the next turn. The Settings default is unchanged.
   */
  async setModel(projectId: string, model: string): Promise<{ model: string }> {
    const runtime = this.profileFor(await deps.getProject(projectId)).runtime
    await deps.updateProject(projectId, { agentModel: model, agentModelRuntime: runtime })
    const s = this.sessions.get(projectId)
    if (s?.adapter.alive && s.runtime.kind === runtime && s.runtime.capabilities.modelSwitch && s.adapter.setModel) {
      await s.adapter.setModel(model)
      s.model = model
      this.notice(s, `Model switched to ${model}`)
    }
    return { model }
  }

  /**
   * R11b: the project's designer (its own profile, or null = the default) and optionally its model. Takes effect from
   * the next message (a live session started with a different sign-in/runtime is restarted then; see sendMessage).
   */
  async setProjectProfile(projectId: string, profileId: string | null, model: string | null): Promise<AgentProfileSnapshot> {
    const project = await deps.getProject(projectId)
    const runtime = this.profileFor({ ...project, agentProfileId: profileId, agentModel: null }).runtime
    const patch = { agentProfileId: profileId, agentModel: model, agentModelRuntime: model ? runtime : null }
    await deps.updateProject(projectId, patch)
    return this.profileFor({ ...project, ...patch })
  }

  /**
   * "Try another idea": fork the conversation so the new session keeps the history but diverges. Ends the live
   * session, forks the runtime's own session (no model call) and copies the timeline so it replays up to the fork
   * point. The caller records the new session in project.json and activates it.
   */
  async fork(projectId: string, fromSessionId: string, title?: string): Promise<{ sessionId: string; inheritedCostUsd: number }> {
    await this.interruptLive(projectId)
    this.closeSession(projectId)
    // The runtime that holds the conversation forks it (sessions from before R11b are Claude's), by its native id.
    const project = await deps.getProject(projectId)
    const ref = nativeRef(projectId, fromSessionId)
    const heldBy = ref?.runtime ?? project.sessions.find((x) => x.id === fromSessionId)?.runtime ?? this.legacyRuntime(this.profileFor(project).runtime)
    const runtime = this.runtimes.get(heldBy) ?? this.runtimeFor(project)
    if (!runtime.fork) throw Object.assign(new Error(`${runtime.kind} sessions can't be forked`), { statusCode: 400 })
    const { nativeSessionId } = await runtime.fork(ref?.nativeId ?? fromSessionId, {
      cwd: deps.projectDir(projectId),
      title,
    })
    const sessionId = runtime.ownSessionIds ? randomUUID() : nativeSessionId
    setNativeRef(projectId, sessionId, { runtime: runtime.kind, nativeId: nativeSessionId })
    const copied = readEvents(projectId, fromSessionId).map((e) => ({ ...e, sessionId }))
    writeEvents(projectId, sessionId, copied)
    copyNative(projectId, fromSessionId, sessionId)
    this.offlineNotice(projectId, sessionId, "Trying another idea from here: the earlier version is kept")
    // the copied timeline carries the parent's cost so far: the new idea's own cost is what comes on top of it
    return { sessionId, inheritedCostUsd: sessionCostFrom(copied) }
  }

  // ---------------------------------------------------------------------------------------------
  // R11g: portable handoff (new chat from the app's summary; never a claim of native resume across runtimes)
  // ---------------------------------------------------------------------------------------------

  private requireSummarize() {
    if (!this.o.summarize) throw Object.assign(new Error("handoff isn't available"), { statusCode: 400 })
    return this.o.summarize
  }

  /** An earlier chat on the open idea held by `runtime` (not `exceptId`), newest first: "Continue the earlier … chat". */
  private resumeCandidate(projectId: string, project: Project, runtime: string, exceptId: string | null): ProjectSession | null {
    const idea = currentIdeaAt(deps.projectDir(projectId))
    let best: { s: ProjectSession; at: string } | null = null
    for (const x of project.sessions) {
      if (x.id === exceptId || (x.branch ?? idea) !== idea) continue
      if (this.heldBy(projectId, project, x.id, runtime) !== runtime) continue
      const events = readEvents(projectId, x.id)
      if (!events.some((e) => e.event.type === "run.started")) continue
      const at = events[events.length - 1]?.ts ?? ""
      if (!best || at > best.at) best = { s: x, at }
    }
    return best?.s ?? null
  }

  /**
   * What a handoff would tell the next designer (nothing is changed). `target` = the designer picked (undefined = the
   * project's own, for a fresh chat). `needed` is false when there's nothing to carry over: no earlier messages, or a
   * switch within one runtime (it resumes natively).
   */
  async previewHandoff(projectId: string, reason: HandoffReason, target?: { profileId?: string | null; model?: string | null }): Promise<HandoffPreview> {
    const summarize = this.requireSummarize()
    const project = await deps.getProject(projectId)
    const to = this.targetProfile(project, target?.profileId, target?.model)
    const fromId = this.sessions.get(projectId)?.sessionId ?? project.activeSessionId
    const ran = !!fromId && readEvents(projectId, fromId).some((e) => e.event.type === "run.started")
    const fromRuntime = fromId ? this.heldBy(projectId, project, fromId, to.runtime) : null
    const from = this.sessionDesigner(projectId, project, fromId)
    const summary = await summarize(projectId, fromId)
    const resume = reason === "switch" && fromRuntime !== to.runtime ? this.resumeCandidate(projectId, project, to.runtime, fromId) : null
    return {
      needed: ran && (reason !== "switch" || fromRuntime !== to.runtime),
      reason,
      from,
      fromSessionId: fromId,
      to: designerOf(to),
      summary,
      markdown: handoffMarkdown(summary, from, reason),
      resume: resume ? { sessionId: resume.id, title: resume.title, designer: this.sessionDesigner(projectId, project, resume.id)?.name ?? runtimeLabel(to.runtime) } : null,
      resumeMarkdown: resume ? handoffMarkdown(summary, from, "resume") : null,
    }
  }

  /** The timeline marker at the top of the chat a handoff starts (or resumes). */
  private handoffMarker(rec: HandoffRecord): Extract<AgentEvent, { type: "notice" }> {
    const text =
      rec.mode === "resume"
        ? `Back with ${rec.to.name}: this chat continues, with a summary of what changed since${rec.from ? ` (${rec.from.name} worked on it)` : ""}`
        : rec.reason === "fresh"
          ? "Fresh chat: started from a summary of the earlier one — read the summary"
          : `Handed over from ${rec.from?.name ?? "an earlier chat"} — read the summary`
    return {
      type: "notice",
      level: "info",
      code: "handoff.started",
      text,
      data: { handoffId: rec.id, reason: rec.reason, mode: rec.mode, from: rec.from?.name ?? null, to: rec.to.name, fromSessionId: rec.fromSessionId },
    }
  }

  /** A line in the chat that was left: where the work went. */
  private leftMarker(projectId: string, rec: HandoffRecord) {
    if (!rec.fromSessionId || rec.fromSessionId === rec.toSessionId) return
    try {
      this.offlineNotice(projectId, rec.fromSessionId, {
        type: "notice",
        level: "info",
        code: "handoff.left",
        text: rec.reason === "fresh" ? "Continued in a fresh chat, with a summary of this one" : `Handed over to ${rec.to.name}, with a summary of this chat`,
        data: { handoffId: rec.id, toSessionId: rec.toSessionId },
      })
    } catch (e) {
      console.error("[agent] handoff note in the old chat failed", e)
    }
  }

  /** Build, save and queue a handoff for `toSessionId` (delivered with that chat's next message). */
  private async createHandoff(
    projectId: string,
    project: Project,
    o: { reason: HandoffReason; mode: "new" | "resume"; fromId: string | null; to: AgentProfileSnapshot; toSessionId: string; markdown?: string; branch?: string | null },
  ): Promise<HandoffRecord> {
    const summary = await this.requireSummarize()(projectId, o.fromId)
    const from = this.sessionDesigner(projectId, project, o.fromId)
    const generated = handoffMarkdown(summary, from, o.mode === "resume" ? "resume" : o.reason)
    const mine = o.markdown?.trim() ? redactSecrets(o.markdown.trim()) + "\n" : null
    const rec: HandoffRecord = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      reason: o.mode === "resume" ? "resume" : o.reason,
      mode: o.mode,
      fromSessionId: o.fromId,
      toSessionId: o.toSessionId,
      from,
      to: designerOf(o.to),
      summary,
      generated,
      markdown: mine ?? generated,
      edited: !!mine && mine.trim() !== generated.trim(),
      deliveredAt: null,
      branch: o.branch ?? null,
    }
    saveHandoff(projectId, rec)
    setPending(projectId, o.toSessionId, rec.id)
    return rec
  }

  /**
   * Hand the project to a new chat (another designer, or the same one with a clean context): ends the live session,
   * applies the designer pick, creates the chat linked to the one it leaves (or picks the earlier chat to resume),
   * saves the summary (the user's edit if any) and makes it the active chat. The summary goes to the designer with the
   * next message.
   */
  async startHandoff(projectId: string, o: HandoffStart): Promise<{ sessionId: string; handoffId: string }> {
    this.requireSummarize()
    await this.interruptLive(projectId)
    this.closeSession(projectId)
    let project = await deps.getProject(projectId)
    const fromId = project.activeSessionId
    // The chat being left remembers its designer, so opening it again resumes it with that designer.
    if (fromId)
      project = await deps.updateProject(projectId, {
        sessions: project.sessions.map((x) => (x.id === fromId && x.profileId === undefined ? { ...x, profileId: project.agentProfileId ?? null, model: project.agentModel ?? null } : x)),
      })
    if (o.profileId !== undefined) await this.setProjectProfile(projectId, o.profileId, o.model ?? null)
    else if (o.model) await this.setModel(projectId, o.model)
    project = await deps.getProject(projectId)
    const to = this.profileFor(project)
    this.runtimeOf(to) // refuses a designer this build can't run, before anything is written
    const mode = o.mode ?? "new"
    let sessionId: string
    if (mode === "resume") {
      const target = project.sessions.find((x) => x.id === o.resumeSessionId)
      if (!target || target.id === fromId) throw Object.assign(new Error("that earlier chat isn't here"), { statusCode: 404 })
      if (this.heldBy(projectId, project, target.id, to.runtime) !== to.runtime)
        throw Object.assign(new Error(`that chat is held by another designer; it can't be continued with ${to.name}`), { statusCode: 400 })
      sessionId = target.id
    } else sessionId = randomUUID()
    const rec = await this.createHandoff(projectId, project, { reason: o.reason, mode, fromId, to, toSessionId: sessionId, markdown: o.markdown, branch: o.branch })
    if (mode === "new") {
      const title =
        o.title?.trim().slice(0, 80) ||
        (o.reason === "fresh" ? "Fresh start (with a summary)" : o.reason === "idea" ? `Tried with ${rec.to.name}` : `Handed over to ${rec.to.name}`)
      const entry: ProjectSession = {
        id: sessionId,
        title,
        forkedFrom: o.reason === "idea" ? fromId : null,
        runtime: to.runtime,
        profileId: project.agentProfileId ?? null,
        model: project.agentModel ?? null,
        handoff: { id: rec.id, fromSessionId: fromId, from: rec.from?.name ?? "", reason: rec.reason },
        ...(o.branch ? { branch: o.branch } : {}),
      }
      await deps.updateProject(projectId, { sessions: [...project.sessions.filter((x) => x.id !== sessionId), entry] })
      try {
        upsertSession(projectId, sessionId, { title, forkedFrom: entry.forkedFrom, createdAt: rec.createdAt })
      } catch (e) {
        console.error("[catalog] upsertSession failed", e)
      }
    }
    const marker = this.offlineNotice(projectId, sessionId, this.handoffMarker(rec))
    this.leftMarker(projectId, rec)
    await this.switchSession(projectId, sessionId)
    emit({ type: "agent.event", ...marker })
    return { sessionId, handoffId: rec.id }
  }

  /**
   * The runtime went away with a run still open (the chat was switched or closed mid-turn, or the process ended
   * quietly): the transcript gets the run's end, so its tool rows and "Waiting" bubbles don't stay open on every reload.
   */
  private closeOpenRun(s: Live) {
    const runId = s.runs[0]
    if (!runId) return
    this.record(
      s,
      { type: "run.interrupted", result: { subtype: "interrupted", isError: false, text: "", durationMs: null, turns: null, usage: null, queued: 0 } },
      { itemId: `closed:${runId}`, runId, runtime: "app" }
    )
  }

  /** Fully end a project's session (project close / server shutdown). */
  closeSession(projectId: string) {
    cancelQuestions(projectId)
    cancelPermissions(projectId)
    const s = this.sessions.get(projectId)
    if (!s) return
    this.sessions.delete(projectId)
    this.closeOpenRun(s)
    s.adapter.close()
  }

  /** End every live session and make sure runtime processes die. Synchronous (runs from exit/signal handlers). */
  shutdown() {
    for (const id of [...this.sessions.keys()]) this.closeSession(id)
    for (const r of this.runtimes.values()) r.shutdown?.()
  }

  // Idle reaper: a session with no activity (not running, no question waiting) has its runtime closed. project.json
  // keeps activeSessionId, so the next message resumes it transparently.
  private reapIdle(idleMs: number) {
    const now = Date.now()
    for (const [id, s] of this.sessions) {
      if (!s.running && listQuestions(id).length === 0 && listPermissions(id).length === 0 && now - s.lastActivity > idleMs) {
        console.log(`[agent] closing idle session ${s.sessionId} (${id})`)
        this.closeSession(id)
        emit({
          type: "agent.status",
          projectId: id,
          running: false,
          sessionId: s.sessionId,
          costUsd: s.costUsd,
        })
      }
    }
  }

  private async activeSessionId(projectId: string): Promise<string | null> {
    return this.sessions.get(projectId)?.sessionId ?? (await deps.getProject(projectId)).activeSessionId
  }

  /** Normalized events of the active session (legacy transcripts migrated). */
  async getEvents(projectId: string): Promise<AgentEventEnvelope[]> {
    const sessionId = await this.activeSessionId(projectId)
    return sessionId ? readEvents(projectId, sessionId) : []
  }

  /** Native/legacy view of the active session (diagnostics, evals). */
  async getNativeTimeline(projectId: string): Promise<AgentEnvelope[]> {
    const sessionId = await this.activeSessionId(projectId)
    return sessionId ? readNative(projectId, sessionId) : []
  }

  listStatuses(): AgentStatusInfo[] {
    return [...this.sessions.entries()].map(([projectId, s]) => ({
      projectId,
      running: s.running,
      sessionId: s.sessionId,
      costUsd: s.costUsd,
    }))
  }

  async getStatus(projectId: string): Promise<{ running: boolean; sessionId: string | null; costUsd: number }> {
    const s = this.sessions.get(projectId)
    if (s) return { running: s.running, sessionId: s.sessionId, costUsd: s.costUsd }
    const project = await deps.getProject(projectId)
    return {
      running: false,
      sessionId: project.activeSessionId,
      costUsd: this.sessionCost(projectId, project.activeSessionId),
    }
  }
}
