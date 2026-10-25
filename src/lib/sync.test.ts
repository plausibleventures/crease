// R08 client side: cursor (dedupe, gap detection, buffering), channel (hello -> replay | snapshot) and the real store's
// reconcile, driven by simulated socket frames. No DOM: the store only needs window.location / addEventListener.
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentQuestionRequest, PrintRequest, Project, ServerEvent, SyncSnapshot, WsHello } from "@shared/types"

vi.stubGlobal("window", { location: { hash: "", protocol: "http:", host: "test" }, addEventListener: () => {} })
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} })
// every API call resolves to null: the store's follow-up fetches (timeline, sessions, latest…) become no-ops
vi.mock("@/lib/api", () => ({
  api: new Proxy({}, { get: () => async () => null }),
  errMsg: (e: unknown) => String(e),
}))

const { SyncChannel, SyncCursor, reconcileSnapshot } = await import("./sync")
const { useStudio } = await import("@/stores/studio")

const P = "proj"
const question = (id: string): AgentQuestionRequest => ({
  requestId: id,
  projectId: P,
  sessionId: "s1",
  createdAt: "2026-10-08T00:00:00Z",
  questions: [{ question: `Q ${id}?`, header: "H", multiSelect: false, options: [{ label: "A", description: "" }] }],
})
const printReq = (id: string, gcodeName = "a.gcode"): PrintRequest => ({
  requestId: id,
  projectId: P,
  gcodeName,
  estimatedTimeS: 60,
  filamentG: 1,
  origin: "agent",
})
const project = (parts = ["box"]): Project =>
  ({ id: P, name: "Box", parts: parts.map((id) => ({ id, file: `${id}.scad` })), activeSessionId: "s1" }) as unknown as Project
const hello = (instanceId: string, eventSeq: number, resume: WsHello["resume"], replayed = 0): WsHello => ({
  type: "ws.hello",
  instanceId,
  eventSeq,
  resume,
  replayed,
})
const seq = <E extends ServerEvent>(n: number, e: E) => ({ ...e, eventSeq: n })
const snapshot = (over: Partial<SyncSnapshot> = {}): SyncSnapshot => ({
  instanceId: "A",
  eventSeq: 0,
  takenAt: "",
  printRequests: [],
  questions: [],
  agents: [],
  machines: [],
  project: { project: project(), agent: { projectId: P, running: false, sessionId: "s1", costUsd: 0 }, assembly: null, jobs: null },
  ...over,
})

/** A fake server connection: frames go through the real channel into the real store. */
function harness() {
  let pending: { resolve: (s: SyncSnapshot) => void; reject: (e: Error) => void } | null = null
  const fetches: number[] = []
  const reconnects: number[] = []
  const channel = new SyncChannel(new SyncCursor(), {
    apply: (events) => events.forEach((e) => useStudio.getState().handleEvent(e)),
    applySnapshot: (s) => useStudio.getState().applySnapshot(s),
    fetchSnapshot: () => {
      fetches.push(Date.now())
      return new Promise((resolve, reject) => (pending = { resolve, reject }))
    },
    reconnect: () => reconnects.push(1),
    later: () => {},
  })
  return {
    channel,
    fetches,
    reconnects,
    send: (...frames: unknown[]) => frames.forEach((f) => channel.receive(f)),
    /** resolve the in-flight snapshot fetch */
    async answer(s: SyncSnapshot) {
      const p = pending
      pending = null
      p!.resolve(s)
      await new Promise((r) => setTimeout(r, 0))
    },
  }
}

const st = () => useStudio.getState()
const qIds = () => (st().questions[P] ?? []).map((q) => q.requestId)
const prIds = () => st().printRequests.map((r) => r.requestId)

beforeEach(() => {
  useStudio.setState({ project: project(), questions: {}, printRequests: [], agent: {}, abandoned: {}, timelines: {}, assembly: {}, jobs: {} })
})

describe("SyncCursor", () => {
  it("drops duplicates and detects a gap on an ordered socket", () => {
    const c = new SyncCursor()
    c.onHello(hello("A", 0, "fresh"))
    const e = (n: number) => seq(n, { type: "jobs.changed", projectId: P })
    expect(c.onEvent(e(1))).toEqual({ kind: "apply", events: [e(1)] })
    expect(c.onEvent(e(1))).toEqual({ kind: "apply", events: [] }) // duplicate
    expect(c.onEvent(e(4))).toEqual({ kind: "snapshot" }) // 2,3 missing
    expect(c.isBuffering).toBe(true)
    expect(c.onEvent(e(5))).toEqual({ kind: "apply", events: [] }) // buffered
    // snapshot reflects up to 4: only 5 is re-applied
    expect(c.snapshotApplied({ instanceId: "A", eventSeq: 4 })).toEqual([e(5)])
    expect(c.lastSeq).toBe(5)
    expect(c.query()).toBe("since=5&instance=A")
  })

  it("a ping ahead of us means loss; a ping from another instance means reconnect", () => {
    const c = new SyncCursor()
    c.onHello(hello("A", 3, "fresh"))
    expect(c.onPing({ type: "ws.ping", eventSeq: 3, instanceId: "A" }).kind).toBe("apply")
    expect(c.onPing({ type: "ws.ping", eventSeq: 4, instanceId: "B" }).kind).toBe("reconnect")
    expect(c.onPing({ type: "ws.ping", eventSeq: 5, instanceId: "A" }).kind).toBe("snapshot")
  })

  it("an unfinished snapshot is still owed after a reconnect (no cursor sent, hello -> snapshot)", () => {
    const c = new SyncCursor()
    c.onHello(hello("A", 3, "fresh"))
    c.onHello(hello("B", 0, "snapshot")) // server restarted
    c.reset() // socket died before the snapshot arrived
    expect(c.query()).toBe("")
    expect(c.onHello(hello("B", 2, "fresh")).kind).toBe("snapshot")
  })
})

describe("reconnect reconciliation (real store)", () => {
  it("disconnect during a question: answered elsewhere + a new one asked while offline -> replay", () => {
    const h = harness()
    h.send(hello("A", 0, "fresh"), seq(1, { type: "agent.question", request: question("q1") }))
    expect(qIds()).toEqual(["q1"])
    h.channel.detach() // socket drops
    expect(h.channel.attach()).toBe("since=1&instance=A")
    const missed = [
      seq(2, { type: "agent.question.resolved", projectId: P, requestId: "q1", answers: { "Q q1?": "A" } }),
      seq(3, { type: "agent.question", request: question("q2") }),
    ] as const
    h.send(hello("A", 3, "replay", 2), ...missed)
    expect(qIds()).toEqual(["q2"])
    // the same replay delivered again (e.g. a reconnect raced the first): nothing duplicates
    h.send(...missed)
    expect(qIds()).toEqual(["q2"])
    expect(h.fetches).toHaveLength(0)
  })

  it("print request created and answered while offline, server restarted -> snapshot, no dialog", async () => {
    const h = harness()
    h.send(hello("A", 0, "fresh"), seq(1, { type: "print.request", request: printReq("r-old") }))
    expect(prIds()).toEqual(["r-old"])
    h.channel.detach()
    h.channel.attach()
    // new server instance: r-old died with it, r-new was created and approved before we got back
    h.send(hello("B", 7, "snapshot"))
    expect(h.fetches).toHaveLength(1)
    // a live event arrives while the snapshot is in flight: buffered, not applied yet
    h.send(seq(8, { type: "agent.question", request: question("q9") }))
    expect(qIds()).toEqual([])
    await h.answer(snapshot({ instanceId: "B", eventSeq: 7 }))
    expect(prIds()).toEqual([]) // no stale dialog
    expect(qIds()).toEqual(["q9"]) // buffered event newer than the snapshot applied after it
    expect(h.channel.cursor.query()).toBe("since=8&instance=B")
  })

  it("snapshot + overlapping buffered events never duplicate dialogs or question cards", async () => {
    const h = harness()
    h.send(hello("A", 0, "fresh"), seq(1, { type: "print.request", request: printReq("r1") }), seq(2, { type: "agent.question", request: question("q1") }))
    h.channel.detach()
    h.channel.attach()
    h.send(hello("A", 50, "snapshot")) // gap was evicted
    // events racing the snapshot: one already reflected by it (seq 9), one newer (seq 51) re-sending r1 with blockers
    h.send(seq(9, { type: "print.request", request: printReq("r2") }))
    h.send(seq(51, { type: "print.request", request: { ...printReq("r1"), blockers: ["slot 2 empty"] } }))
    await h.answer(snapshot({ eventSeq: 50, printRequests: [printReq("r1"), printReq("r2")], questions: [question("q1"), question("q1")] }))
    expect(prIds()).toEqual(["r1", "r2"])
    expect(st().printRequests[0].blockers).toEqual(["slot 2 empty"])
    expect(qIds()).toEqual(["q1"])
  })

  it("a question timed out / answered in another window disappears on snapshot; agent status reconciles", async () => {
    useStudio.setState({ agent: { [P]: { running: true, sessionId: "s1", costUsd: 0.1 }, other: { running: true, sessionId: "x", costUsd: 0 } } })
    const h = harness()
    h.send(hello("A", 0, "fresh"), seq(1, { type: "agent.question", request: question("q1") }))
    h.channel.detach()
    h.channel.attach()
    h.send(hello("B", 0, "snapshot"))
    await h.answer(
      snapshot({
        instanceId: "B",
        project: { project: project(["box", "lid"]), agent: { projectId: P, running: false, sessionId: "s1", costUsd: 0.25 }, assembly: null, jobs: null },
      }),
    )
    expect(qIds()).toEqual([])
    expect(st().agent[P]).toEqual({ running: false, sessionId: "s1", costUsd: 0.25 })
    expect(st().agent.other.running).toBe(false) // no live session on the restarted server
    expect(st().project?.parts.map((p) => p.id)).toEqual(["box", "lid"])
  })

  it("replayed agent envelopes don't duplicate timeline messages", () => {
    const h = harness()
    const env = (n: number) =>
      seq(n, {
        type: "agent.event" as const,
        schemaVersion: 1 as const,
        eventId: String(n),
        projectId: P,
        sessionId: "s1",
        seq: n,
        ts: "",
        runId: `r${n}`,
        itemId: `user:r${n}`,
        revision: null,
        runtime: "app",
        event: { type: "run.started" as const, input: { text: `m${n}` } },
      })
    h.send(hello("A", 0, "fresh"), env(1))
    h.channel.detach()
    h.channel.attach()
    h.send(hello("A", 2, "replay", 1), env(2))
    st().handleEvent(env(2)) // even if a duplicate slipped past the cursor, the timeline dedupes by event id
    expect(st().timelines[P].items.map((i) => (i.kind === "user" ? i.text : i.kind))).toEqual(["m1", "m2"])
  })

  it("a failed snapshot applies what was buffered and retries", async () => {
    let fail = true
    const retries: (() => void)[] = []
    const snaps: SyncSnapshot[] = []
    const ch = new SyncChannel(new SyncCursor(), {
      apply: (events) => events.forEach((e) => st().handleEvent(e)),
      applySnapshot: (s) => snaps.push(s),
      fetchSnapshot: async () => {
        if (fail) throw new Error("down")
        return snapshot({ instanceId: "B", eventSeq: 5 })
      },
      reconnect: () => {},
      later: (fn) => retries.push(fn),
    })
    ch.attach()
    ch.receive(hello("B", 3, "snapshot"))
    ch.receive(seq(4, { type: "agent.question", request: question("q4") }))
    await new Promise((r) => setTimeout(r, 0))
    expect(qIds()).toEqual(["q4"]) // best effort while the snapshot is owed
    fail = false
    retries.shift()!()
    await new Promise((r) => setTimeout(r, 0))
    expect(snaps).toHaveLength(1)
    expect(ch.cursor.snapshotPending).toBe(false)
  })
})

describe("reconcileSnapshot (pure)", () => {
  it("keeps on-screen order and ignores sessions we switched away from", () => {
    const out = reconcileSnapshot(
      {
        questions: { [P]: [question("b"), question("a")] },
        printRequests: [],
        agent: {},
        abandoned: { [P]: ["old"] },
        project: null,
        selectedPartId: null,
        assembly: {},
        jobs: {},
        intents: {},
        machines: null,
        printer: null,
        finishedPrints: [],
        laterPrints: [],
      },
      snapshot({
        questions: [question("a"), question("c"), question("b")],
        agents: [{ projectId: P, running: true, sessionId: "old", costUsd: 1 }],
        project: null,
      }),
    )
    expect(out.questions?.[P].map((q) => q.requestId)).toEqual(["b", "a", "c"])
    expect(out.agent?.[P]).toBeUndefined()
  })
})

describe("missed print.finished (R08 follow-up)", () => {
  const base = { questions: {}, printRequests: [], agent: {}, abandoned: {}, project: null, selectedPartId: null, assembly: {}, jobs: {}, intents: {}, machines: null, printer: null }
  const unrated = [
    { printId: "new", projectId: P, state: "complete" as const, finishedAt: "2026-10-09T10:00:00Z" },
    { printId: "shown", projectId: P, state: "complete" as const, finishedAt: "2026-10-09T09:00:00Z" },
    { printId: "later", projectId: P, state: "cancelled" as const, finishedAt: "2026-10-09T08:00:00Z" },
  ]
  it("queues unrated prints from the snapshot, but not ones already queued or put off with Later", () => {
    const out = reconcileSnapshot(
      { ...base, finishedPrints: [{ printId: "shown", projectId: P, state: "complete" }], laterPrints: ["later"] },
      snapshot({ unratedPrints: unrated }),
    )
    expect(out.finishedPrints?.map((f) => f.printId)).toEqual(["shown", "new"])
    expect(reconcileSnapshot({ ...base, finishedPrints: [], laterPrints: ["new", "shown", "later"] }, snapshot({ unratedPrints: unrated })).finishedPrints).toBeUndefined()
  })
  it("the store shows the card after a snapshot; Later keeps it away on the next one; reopening brings it back", () => {
    useStudio.setState({ finishedPrints: [], laterPrints: [] })
    useStudio.getState().applySnapshot(snapshot({ unratedPrints: unrated.slice(0, 1) }))
    expect(useStudio.getState().finishedPrints.map((f) => f.printId)).toEqual(["new"])
    useStudio.getState().dismissFinished("new")
    useStudio.getState().applySnapshot(snapshot({ unratedPrints: unrated.slice(0, 1) }))
    expect(useStudio.getState().finishedPrints).toEqual([])
    useStudio.getState().openPrintResult({ printId: "new", projectId: P, state: "complete" })
    expect(useStudio.getState().finishedPrints.map((f) => f.printId)).toEqual(["new"])
    expect(useStudio.getState().laterPrints).not.toContain("new")
  })
})
