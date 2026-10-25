// R08: WebSocket replay/snapshot reconciliation, kept free of React/DOM so it can be unit-tested.
//
// Protocol (shared/api.md "WebSocket"): the client connects with ?since=<last eventSeq>&instance=<instanceId>; the
// server's first frame is ws.hello. "replay" -> the missed events follow; "snapshot" -> nothing can be replayed
// (server restarted, gap evicted), so the client buffers live events, fetches GET /api/sync/snapshot, applies it,
// then applies the buffered events newer than the snapshot. Every reducer step is idempotent and keyed by ids, so a
// duplicate replay never duplicates a question card, print dialog or timeline message.
import type {
  AgentQuestionRequest,
  AssemblyInfo,
  MachineWithStatus,
  PrintIntent,
  PrintJobState,
  PrinterStatus,
  PrintRequest,
  Project,
  ProjectJobs,
  SequencedEvent,
  ServerEvent,
  SyncSnapshot,
  WsControl,
  WsHello,
  WsPing,
} from "@shared/types"

type Seq = ServerEvent & { eventSeq?: number }

export type CursorAction =
  | { kind: "apply"; events: ServerEvent[] }
  | { kind: "snapshot" } // take a snapshot now (live events are being buffered)
  | { kind: "reconnect" } // the socket is talking to a different server instance than we think: drop it

/** Tracks the last applied eventSeq and buffers live events while a snapshot is in flight. */
export class SyncCursor {
  instanceId: string | null = null
  lastSeq: number | null = null
  private buffering = false
  private buffer: Seq[] = []
  /** a snapshot was called for and not applied yet (survives reconnects) */
  private needSnapshot = false

  get isBuffering() {
    return this.buffering
  }
  get snapshotPending() {
    return this.needSnapshot
  }

  /** Query string for the next /ws connect ("" on the first connect). */
  query(): string {
    if (this.instanceId == null || this.lastSeq == null || this.needSnapshot) return ""
    return `since=${this.lastSeq}&instance=${encodeURIComponent(this.instanceId)}`
  }

  onHello(h: WsHello): CursorAction {
    this.buffer = []
    if (h.resume === "replay" && h.instanceId === this.instanceId && this.lastSeq != null && !this.needSnapshot) {
      this.buffering = false
      return { kind: "apply", events: [] } // replayed events follow as ordinary frames
    }
    const hadState = this.instanceId != null
    this.instanceId = h.instanceId
    this.lastSeq = h.eventSeq
    // "fresh" on the very first connect: the app is loading state on its own. Anything else means our state may be
    // stale (server restart, evicted gap, or we connected without a cursor after having state).
    if (h.resume === "fresh" && !hadState) {
      this.buffering = false
      return { kind: "apply", events: [] }
    }
    return this.beginSnapshot()
  }

  /** Start buffering live events until snapshotApplied / snapshotFailed. */
  beginSnapshot(): CursorAction {
    this.buffering = true
    this.needSnapshot = true
    return { kind: "snapshot" }
  }

  onEvent(ev: Seq): CursorAction {
    const n = ev.eventSeq
    if (typeof n !== "number") return { kind: "apply", events: [ev] } // older server: no cursor
    if (this.buffering) {
      this.buffer.push(ev)
      return { kind: "apply", events: [] }
    }
    if (this.lastSeq != null && n <= this.lastSeq) return { kind: "apply", events: [] } // duplicate (replay overlap)
    if (this.lastSeq != null && n > this.lastSeq + 1) {
      // a hole on an ordered socket: something was lost; reconcile from a snapshot
      this.buffer = [ev]
      return this.beginSnapshot()
    }
    this.lastSeq = n
    return { kind: "apply", events: [ev] }
  }

  onPing(p: WsPing): CursorAction {
    if (this.instanceId != null && p.instanceId !== this.instanceId) return { kind: "reconnect" }
    if (!this.buffering && this.lastSeq != null && p.eventSeq > this.lastSeq) {
      // everything up to p.eventSeq was sent before this ping on the same socket, so we lost some
      this.buffer = []
      return this.beginSnapshot()
    }
    return { kind: "apply", events: [] }
  }

  /** The snapshot was applied: returns the buffered events that are newer than it, in order, deduped. */
  snapshotApplied(snap: Pick<SyncSnapshot, "eventSeq" | "instanceId">): ServerEvent[] {
    if (snap.instanceId !== this.instanceId) {
      // server restarted between hello and snapshot: the snapshot is still the freshest state we have
      // (buffered events are from the old instance and older than the snapshot; their seqs don't compare)
      this.instanceId = snap.instanceId
      this.buffer = []
    }
    const out: ServerEvent[] = []
    let last = snap.eventSeq
    for (const ev of [...this.buffer].sort((a, b) => (a.eventSeq ?? 0) - (b.eventSeq ?? 0))) {
      const n = ev.eventSeq ?? 0
      if (n <= last) continue
      out.push(ev)
      last = n
    }
    this.buffer = []
    this.buffering = false
    this.needSnapshot = false
    this.lastSeq = last
    return out
  }

  /** The snapshot could not be fetched: apply what we buffered (best effort); a snapshot is still owed. */
  snapshotFailed(): ServerEvent[] {
    const out = this.buffer
    this.buffer = []
    this.buffering = false
    for (const ev of out) if (typeof ev.eventSeq === "number" && (this.lastSeq == null || ev.eventSeq > this.lastSeq)) this.lastSeq = ev.eventSeq
    return out
  }

  /** The socket closed: a snapshot in flight for it is abandoned (still owed: the next connect asks for one). */
  reset() {
    this.buffering = false
    this.buffer = []
  }
}

export function defaultMachine<T extends { isDefault: boolean; enabled: boolean }>(list: T[] | null | undefined): T | null {
  if (!list?.length) return null
  return list.find((m) => m.isDefault && m.enabled) ?? list.find((m) => m.isDefault) ?? list[0]
}

export interface AgentStatusLite {
  running: boolean
  sessionId: string | null
  costUsd: number
}

/** The part of the studio store a snapshot reconciles. */
export interface SyncSlice {
  questions: Record<string, AgentQuestionRequest[]>
  printRequests: PrintRequest[]
  agent: Record<string, AgentStatusLite>
  abandoned: Record<string, string[]>
  project: Project | null
  selectedPartId: string | null
  assembly: Record<string, AssemblyInfo | null>
  jobs: Record<string, ProjectJobs>
  intents: Record<string, PrintIntent>
  machines: MachineWithStatus[] | null
  printer: PrinterStatus | null
  /** "How did it turn out?" cards waiting to be shown (first = shown now) */
  finishedPrints: FinishedPrintCard[]
  /** prints whose card the user put off ("Later" / closed): not brought back by a snapshot */
  laterPrints: string[]
}

export interface FinishedPrintCard {
  printId: string
  projectId: string
  state: PrintJobState
  /** opened on purpose (Rate it, print history): the full form at once, not the one-line ask */
  expanded?: boolean
}

const uniqBy = <T>(list: T[], key: (t: T) => string) => {
  const seen = new Set<string>()
  return list.filter((x) => {
    const k = key(x)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/**
 * Pure reducer: the server's snapshot wins for everything it covers. Pending questions and print dialogs are replaced
 * as whole sets (answered elsewhere / timed out -> gone; none duplicated); existing items keep their position.
 */
export function reconcileSnapshot(s: SyncSlice, snap: SyncSnapshot): Partial<SyncSlice> {
  const out: Partial<SyncSlice> = {}

  // questions: every project's pending set, replaced
  const questions: Record<string, AgentQuestionRequest[]> = {}
  for (const k of Object.keys(s.questions)) questions[k] = []
  for (const q of uniqBy(snap.questions, (q) => q.requestId)) (questions[q.projectId] ??= []).push(q)
  for (const [k, list] of Object.entries(questions)) {
    const before = s.questions[k] ?? []
    // keep the order the user saw them in; new ones after
    const pos = new Map(before.map((q, i) => [q.requestId, i]))
    questions[k] = [...list].sort((a, b) => (pos.get(a.requestId) ?? Infinity) - (pos.get(b.requestId) ?? Infinity))
  }
  out.questions = questions

  // print dialogs: the pending set, replaced (each carries its current job)
  const reqs = uniqBy(snap.printRequests, (r) => r.requestId)
  const byId = new Map(reqs.map((r) => [r.requestId, r]))
  out.printRequests = [
    ...s.printRequests.filter((r) => byId.has(r.requestId)).map((r) => byId.get(r.requestId)!),
    ...reqs.filter((r) => !s.printRequests.some((x) => x.requestId === r.requestId)),
  ]

  // agent status: open sessions are listed; any other project we knew about has no live session -> not running
  const agent: Record<string, AgentStatusLite> = {}
  for (const [k, v] of Object.entries(s.agent)) agent[k] = { ...v, running: false }
  const statuses = [...snap.agents, ...(snap.project ? [snap.project.agent] : [])]
  for (const a of statuses) {
    if (a.sessionId && s.abandoned[a.projectId]?.includes(a.sessionId)) continue // a session we switched away from
    agent[a.projectId] = { running: a.running, sessionId: a.sessionId, costUsd: a.costUsd }
  }
  out.agent = agent

  // the open project, its assembly and jobs
  const p = snap.project
  if (p && s.project?.id === p.project.id) {
    const id = p.project.id
    const sel = s.selectedPartId
    out.project = p.project
    out.selectedPartId = sel && p.project.parts.some((x) => x.id === sel) ? sel : (p.project.parts[0]?.id ?? null)
    out.assembly = { ...s.assembly, [id]: p.assembly }
    if (p.jobs) {
      out.jobs = { ...s.jobs, [id]: p.jobs }
      if (p.jobs.intent && id in s.intents) {
        const intents = { ...s.intents }
        delete intents[id]
        out.intents = intents
      }
    }
  }

  // finished prints nobody rated (a print.finished missed while away): queue their cards, unless put off already
  const missed = (snap.unratedPrints ?? []).filter(
    (u) => !s.finishedPrints.some((f) => f.printId === u.printId) && !s.laterPrints.includes(u.printId),
  )
  if (missed.length) out.finishedPrints = [...s.finishedPrints, ...missed.map(({ printId, projectId, state }) => ({ printId, projectId, state }))]

  // printers: last polled status per machine; `printer` mirrors the default machine
  out.machines = snap.machines
  const def = defaultMachine(snap.machines)
  if (def?.status) out.printer = def.status
  return out
}

export interface SyncDeps {
  apply: (events: ServerEvent[]) => void
  applySnapshot: (snap: SyncSnapshot) => void
  fetchSnapshot: () => Promise<SyncSnapshot>
  /** drop the current socket and reconnect now */
  reconnect: () => void
  later?: (fn: () => void, ms: number) => void
}

/**
 * The glue between socket frames, the cursor and the store. One instance for the app; `attach` for each new socket
 * (returns its ?query), `detach` when it closes. Snapshot work started for a detached socket is discarded.
 */
export class SyncChannel {
  private gen = 0
  readonly cursor: SyncCursor
  private readonly deps: SyncDeps
  constructor(cursor: SyncCursor, deps: SyncDeps) {
    this.cursor = cursor
    this.deps = deps
  }

  attach(): string {
    this.gen++
    return this.cursor.query()
  }

  detach() {
    this.gen++
    this.cursor.reset()
  }

  /** One parsed frame from the socket. */
  receive(frame: unknown) {
    if (!frame || typeof frame !== "object" || !("type" in frame)) return
    const f = frame as SequencedEvent | WsControl
    if (f.type === "ws.hello") this.act(this.cursor.onHello(f))
    else if (f.type === "ws.ping") this.act(this.cursor.onPing(f))
    else this.act(this.cursor.onEvent(f))
  }

  private act(a: CursorAction) {
    if (a.kind === "apply") {
      if (a.events.length) this.deps.apply(a.events)
    } else if (a.kind === "snapshot") this.snapshot(this.gen, 0)
    else this.deps.reconnect()
  }

  private snapshot(gen: number, tries: number) {
    this.deps
      .fetchSnapshot()
      .then((snap) => {
        if (gen !== this.gen) return // that socket is gone; the next hello decides again
        this.deps.applySnapshot(snap)
        const rest = this.cursor.snapshotApplied(snap)
        if (rest.length) this.deps.apply(rest)
      })
      .catch(() => {
        if (gen !== this.gen) return
        const rest = this.cursor.snapshotFailed()
        if (rest.length) this.deps.apply(rest)
        const later = this.deps.later ?? ((fn, ms) => void setTimeout(fn, ms))
        later(() => {
          if (gen !== this.gen || !this.cursor.snapshotPending) return
          this.cursor.beginSnapshot()
          this.snapshot(gen, tries + 1)
        }, Math.min(10_000, 1000 * 2 ** tries))
      })
  }
}
