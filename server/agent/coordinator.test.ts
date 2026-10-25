// Coordinator contract (R11a): a fake runtime drives the session coordinator through the normalized event sequence
// (runs, streaming, tool calls through the registry, questions, interrupt, failure, duplicates, queued turns) and
// the transcript/migration rules. No Claude, no tokens.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import type { AgentEvent, AgentEventEnvelope, Project, ServerEvent } from "../../shared/types"

// config.ts reads PRINTSTUDIO_HOME at import time: keep the catalog and settings in a temp home.
const home = mkdtempSync(join(tmpdir(), "printstudio-coordinator-test-"))
process.env.PRINTSTUDIO_HOME = home

const { SessionCoordinator } = await import("./coordinator")
const { FakeRuntime } = await import("./runtime/fake")
const { deps } = await import("./deps")
const { onEvent } = await import("../events")
const { APPROVAL_REFUSAL, isApproved, setApproved } = await import("./approval")
const { defineTool, ToolRegistry, STUDIO_TOOLS } = await import("./registry")
const { readEvents, eventsPath, nativePath } = await import("./transcript")
const { listQuestions } = await import("./questions")

afterAll(() => rmSync(home, { recursive: true, force: true }))

const P = "coord-test"
let root = ""
let project: Project
let runtime: InstanceType<typeof FakeRuntime>
let coord: InstanceType<typeof SessionCoordinator>
let ws: ServerEvent[] = []
let stopWs: () => void
const realDeps = { ...deps }
const seenCtx: unknown[] = []

const whoTool = defineTool({
  name: "who",
  description: "reports the caller identity (test only)",
  input: { note: z.string().optional() },
  handler: async (ctx) => {
    seenCtx.push(ctx)
    return { content: [{ type: "text", text: `${ctx.projectId} ${ctx.sessionId} ${ctx.runId}` }] }
  },
})

const persisted = (sid = project.activeSessionId!) => readEvents(P, sid)
const types = (envs: AgentEventEnvelope[]) => envs.map((e) => e.event.type)
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "coord-"))
  mkdirSync(join(root, "parts"), { recursive: true })
  writeFileSync(join(root, "parts", "main.scad"), "cube(20);")
  project = {
    id: P,
    name: "Coord",
    createdAt: "",
    printer: "",
    engine: "openscad",
    tags: [],
    parts: [{ id: "main", file: "parts/main.scad", qty: 1, colors: [] }],
    activeSessionId: null,
    sessions: [],
    source: null,
  } as unknown as Project
  writeFileSync(join(root, "project.json"), JSON.stringify(project))
  setApproved(P, false)
  Object.assign(deps, {
    projectDir: () => root,
    getProject: async () => project,
    updateProject: async (_id: string, patch: Partial<Project>) => (project = { ...project, ...patch }),
    readAssembly: async () => ({ assembly: null }),
    slicePart: vi.fn(async () => ({ gcodePath: "build/main.gcode" })),
  })
  runtime = new FakeRuntime()
  coord = new SessionCoordinator({
    runtimes: [runtime],
    tools: new ToolRegistry([...STUDIO_TOOLS, whoTool]),
    prepare: async () => ({ instructions: "brief", policy: {}, model: "fake-model", notices: [] }),
    pauseGraceMs: 30,
  })
  ws = []
  stopWs = onEvent((e) => ws.push(e))
  seenCtx.length = 0
})
afterEach(() => {
  stopWs()
  coord.dispose()
  Object.assign(deps, realDeps)
  setApproved(P, false)
  rmSync(root, { recursive: true, force: true })
})

describe("session coordinator with a fake runtime", () => {
  it("wraps a run in envelopes: run.started … run.completed, deltas live only, seq increasing, ids from the app", async () => {
    const { sessionId } = await coord.sendMessage(P, "make a cube", [], [], "make a cube (agent text)")
    const a = runtime.last
    expect(a.ctx).toMatchObject({ projectId: P, sessionId, cwd: root, resume: null, instructions: "brief", profile: { runtime: "fake", model: "fake-model" } })
    expect(a.sent).toEqual([{ id: expect.any(String), text: "make a cube", agentText: "make a cube (agent text)", images: [], annotations: [] }])
    expect(project.activeSessionId).toBe(sessionId)
    expect(await coord.getStatus(P)).toMatchObject({ running: true, sessionId })

    a.host.emit({ type: "message.delta", role: "assistant", kind: "text", delta: "Hel" }, { itemId: "t1", persist: false })
    a.host.emit({ type: "message.completed", role: "assistant", kind: "text", text: "Hello" }, { itemId: "t1" })
    a.host.emit({ type: "tool.started", name: "who", input: {} }, { itemId: "call1" })
    // the runtime calls the app's tool through its binding; it can't choose the identity
    const r = await a.ctx.tools.call("who", { note: "x", projectId: "other", runId: "spoofed" })
    a.host.emit({ type: "tool.completed", isError: false, text: r.content[0].type === "text" ? r.content[0].text : "", images: [] }, { itemId: "call1" })
    a.host.emit({ type: "usage.updated", usage: { tokens: null, billedUsd: null, estimatedApiUsd: 0.05, billing: "plan", subscription: null, final: false } }, { persist: false })
    expect((await coord.getStatus(P)).costUsd).toBeCloseTo(0.05)
    a.host.emit(
      {
        type: "run.completed",
        result: {
          subtype: "success",
          isError: false,
          text: "done",
          durationMs: 10,
          turns: 1,
          usage: { tokens: { input: 1, output: 2, cacheRead: null, cacheWrite: null }, billedUsd: null, estimatedApiUsd: 0.04, billing: "plan", subscription: null, final: true },
        },
      },
      { itemId: "end1" },
    )

    const envs = persisted()
    expect(types(envs)).toEqual(["run.started", "message.completed", "tool.started", "tool.completed", "run.completed"])
    const runId = envs[0].runId
    expect(runId).toBeTruthy()
    expect(envs.every((e) => e.runId === runId && e.sessionId === sessionId && e.projectId === P && e.schemaVersion === 1)).toBe(true)
    expect(envs.map((e) => e.seq)).toEqual([...envs.map((e) => e.seq)].sort((x, y) => x - y))
    expect(new Set(envs.map((e) => e.eventId)).size).toBe(envs.length)
    expect(envs[0]).toMatchObject({ itemId: `user:${runId}`, runtime: "app", event: { input: { text: "make a cube" }, model: "fake-model" } })
    expect(envs[0].revision).toMatch(/^[0-9a-f]{16}$/)
    expect(envs[3].event).toMatchObject({ text: `${P} ${sessionId} ${runId}` })
    expect(seenCtx[0]).toMatchObject({ projectId: P, sessionId, runId, runtime: "fake" })
    // live frames went over WS but not to disk
    expect(ws.some((e) => e.type === "agent.event" && e.event.type === "message.delta")).toBe(true)
    const st = await coord.getStatus(P)
    expect(st).toMatchObject({ running: false, costUsd: 0.04 }) // reconciled to the final figure
    // native log mirrors the app's input for diagnostics/evals
    expect(readFileSync(nativePath(P, sessionId!), "utf8")).toContain('"user_input"')
  })

  it("drops exact duplicate events (replays, reconnects) but keeps real updates", async () => {
    await coord.sendMessage(P, "hi", [], [], "hi")
    const a = runtime.last
    const done: AgentEvent = { type: "tool.completed", isError: false, text: "ok", images: [] }
    a.host.emit({ type: "tool.started", name: "Read", input: { file_path: "a" } }, { itemId: "c1" })
    a.host.emit(done, { itemId: "c1" })
    a.host.emit(done, { itemId: "c1" })
    a.host.emit({ type: "message.completed", role: "assistant", kind: "text", text: "a" }, { itemId: "m1" })
    a.host.emit({ type: "message.completed", role: "assistant", kind: "text", text: "ab" }, { itemId: "m1" })
    a.host.emit({ type: "message.completed", role: "assistant", kind: "text", text: "ab" }, { itemId: "m1" })
    expect(types(persisted())).toEqual(["run.started", "tool.started", "tool.completed", "message.completed", "message.completed"])
  })

  it("questions: question.requested, answered through the coordinator, review answer approves the design", async () => {
    await coord.sendMessage(P, "make it", [], [], "make it")
    const a = runtime.last
    const abort = new AbortController()
    const pending = a.host.askUser(
      { questions: [{ question: "How does this look?", header: "Look", multiSelect: false, options: [{ label: "Looks great", description: "" }] }] },
      { signal: abort.signal, toolUseID: "toolu_q1" },
    )
    await flush()
    expect(listQuestions(P).map((q) => q.requestId)).toEqual(["toolu_q1"])
    expect(ws.some((e) => e.type === "agent.question" && e.request.requestId === "toolu_q1")).toBe(true)
    const q = persisted().find((e) => e.event.type === "question.requested")!
    expect(q).toMatchObject({ itemId: "q:toolu_q1", event: { requestId: "toolu_q1", questions: [{ question: "How does this look?" }] } })
    await coord.answerQuestion(P, "toolu_q1", { "How does this look?": "Looks great" })
    expect(await pending).toEqual({ answered: true, answers: { "How does this look?": "Looks great" } })
    expect(isApproved(P)).toBe(true)

    // stopping the designer closes a waiting question
    const stop = new AbortController()
    a.onInterrupt = () => stop.abort()
    const second = a.host.askUser({ questions: [{ question: "Colour?", header: "C", multiSelect: false, options: [] }] }, { signal: stop.signal, toolUseID: "toolu_q2" })
    await flush()
    await coord.stop(P)
    expect(await second).toMatchObject({ answered: false })
    expect(listQuestions(P)).toEqual([])
  })

  it("questions: a turn that ends before the answer keeps the card; the answer comes back as the next message", async () => {
    // Codex 0.161 runs AskUserQuestion in the background: the model moves on and its turn ends with the card open.
    await coord.sendMessage(P, "a pot", [], [], "a pot")
    const a = runtime.last
    const turn = new AbortController()
    const asked = a.host.askUser(
      { questions: [{ question: "How big?", header: "Size", multiSelect: false, options: [{ label: "Small (Recommended)", description: "" }, { label: "Big", description: "" }] }] },
      { signal: turn.signal, toolUseID: "toolu_q3" },
    )
    await flush()
    turn.abort() // the turn ended without the answer
    expect(await asked).toMatchObject({ answered: false, message: expect.stringMatching(/next message/) })
    expect(listQuestions(P).map((q) => q.requestId)).toEqual(["toolu_q3"])
    expect(ws.some((e) => e.type === "agent.question.resolved" && e.requestId === "toolu_q3")).toBe(false)

    await coord.answerQuestion(P, "toolu_q3", { "How big?": "Small (Recommended)" })
    await flush()
    expect(listQuestions(P)).toEqual([])
    expect(ws.some((e) => e.type === "agent.question.resolved" && e.requestId === "toolu_q3")).toBe(true)
    const next = a.sent.at(-1)!
    expect(next.text).toBe("Small")
    expect(next.agentText).toBe('User has answered your questions: "How big?"="Small (Recommended)". You can now continue with the user\'s answers in mind.')
    expect(persisted().filter((e) => e.event.type === "run.started").at(-1)).toMatchObject({ event: { input: { text: "Small" } } })

    // a typed message instead of an answer closes a card left open
    const turn2 = new AbortController()
    void a.host.askUser({ questions: [{ question: "Colour?", header: "C", multiSelect: false, options: [] }] }, { signal: turn2.signal, toolUseID: "toolu_q4" })
    await flush()
    turn2.abort()
    await flush()
    expect(listQuestions(P).map((q) => q.requestId)).toEqual(["toolu_q4"])
    await coord.sendMessage(P, "actually make it round", [], [], "actually make it round")
    expect(listQuestions(P)).toEqual([])

    // Stop closes a card left open too, even when no turn is running (parity run 2026-10-11)
    const turn3 = new AbortController()
    void a.host.askUser({ questions: [{ question: "Lid?", header: "L", multiSelect: false, options: [] }] }, { signal: turn3.signal, toolUseID: "toolu_q5" })
    await flush()
    turn3.abort()
    await flush()
    expect(listQuestions(P).map((q) => q.requestId)).toEqual(["toolu_q5"])
    await coord.stop(P)
    expect(listQuestions(P)).toEqual([])
  })

  it("pause at a question: the runtime is told to stop, the turn ends, the card stays and its answer is the next message", async () => {
    await coord.sendMessage(P, "a bear", [], [], "a bear")
    const a = runtime.last
    const turn = new AbortController()
    a.onInterrupt = () => {
      turn.abort()
      a.host.emit({ type: "run.interrupted" }, { itemId: "end:p" })
    }
    const asked = a.host.askUser(
      { questions: [{ question: "How does this look?", header: "Look", multiSelect: false, options: [{ label: "Looks great", description: "" }] }] },
      { signal: turn.signal, toolUseID: "toolu_p1" },
    )
    await flush()
    await coord.pause(P, "toolu_p1")
    expect(await asked).toMatchObject({ answered: false, message: expect.stringMatching(/paused/) })
    // told to end its turn; stopped only if it keeps going past the grace time
    expect(a.interrupts).toBe(0)
    await new Promise((r) => setTimeout(r, 60))
    expect(a.interrupts).toBe(1)
    expect(await coord.getStatus(P)).toMatchObject({ running: false })
    expect(listQuestions(P)).toMatchObject([{ requestId: "toolu_p1", paused: true }])
    expect(ws.some((e) => e.type === "agent.question" && e.request.requestId === "toolu_p1" && e.request.paused)).toBe(true)
    expect(persisted().some((e) => e.event.type === "notice" && /Paused/.test(e.event.text))).toBe(true)
    // pausing twice (or an unknown question) is a 404
    await expect(coord.pause(P, "toolu_p1")).rejects.toMatchObject({ statusCode: 404 })

    await coord.answerQuestion(P, "toolu_p1", { "How does this look?": "Looks great" })
    await flush()
    expect(listQuestions(P)).toEqual([])
    expect(a.sent.at(-1)).toMatchObject({ text: "Looks great", agentText: expect.stringMatching(/^User has answered your questions/) })
    expect(isApproved(P)).toBe(true)
  })

  it("a message sent while a question waits (photos, a check's button) is the reply: the question closes, the message goes", async () => {
    await coord.sendMessage(P, "a bear", [], [], "a bear")
    const a = runtime.last
    const asked = a.host.askUser(
      { questions: [{ question: "What next?", header: "Next", multiSelect: false, options: [{ label: "Save for later", description: "" }] }] },
      { signal: new AbortController().signal, toolUseID: "toolu_r1" },
    )
    await flush()
    await coord.sendMessage(P, "see this", [{ mediaType: "image/png", data: "AA==" }], [], "see this")
    expect(await asked).toMatchObject({ answered: false, message: expect.stringMatching(/new message/) })
    expect(listQuestions(P)).toEqual([])
    expect(a.sent.at(-1)).toMatchObject({ text: "see this" })
  })

  it("tool gates hold through the coordinator's binding: slicing before approval is refused", async () => {
    await coord.sendMessage(P, "make a cube", [], [], "make a cube")
    const a = runtime.last
    const refused = await a.ctx.tools.call("slice_part", { partId: "main" })
    expect(refused).toMatchObject({ isError: true, content: [{ text: `Error: ${APPROVAL_REFUSAL}` }] })
    expect(deps.slicePart).not.toHaveBeenCalled()
    // the user's own words approve ("print it"), whatever the runtime
    await coord.sendMessage(P, "looks right, print it", [], [], "looks right, print it")
    const ok = await a.ctx.tools.call("slice_part", { partId: "main" })
    expect(ok.isError).toBeFalsy()
    expect(deps.slicePart).toHaveBeenCalledWith(P, "main", undefined, { intent: undefined, overrides: undefined })
    // native file edits the runtime allows withdraw approval (geometry changed)
    a.host.nativeToolAllowed("Write", { file_path: "parts/main.scad" })
    expect(isApproved(P)).toBe(false)
  })

  it("interrupt: stop asks the runtime, the run ends as run.interrupted, status goes idle", async () => {
    await coord.sendMessage(P, "go", [], [], "go")
    await coord.stop(P)
    expect(runtime.last.interrupts).toBe(1)
    expect(types(persisted())).toEqual(["run.started", "run.interrupted"])
    expect(await coord.getStatus(P)).toMatchObject({ running: false })
  })

  it("closing a chat mid-turn ends its run in the transcript (no tool row or bubble left open on reload)", async () => {
    const { sessionId } = await coord.sendMessage(P, "go", [], [], "go")
    await coord.sendMessage(P, "and this", [], [], "and this")
    runtime.last.host.emit({ type: "tool.started", name: "AskUserQuestion", input: {} }, { itemId: "q" })
    runtime.last.onInterrupt = () => {} // the runtime's own end of the run hasn't arrived when the chat closes
    await coord.switchSession(P, null)
    const envs = readEvents(P, sessionId!)
    expect(types(envs)).toEqual(["run.started", "run.started", "tool.started", "run.interrupted", "input.status"])
    expect(envs[3]).toMatchObject({ runtime: "app", runId: envs[0].runId, event: { result: { subtype: "interrupted" } } })
    expect(envs[4].event).toMatchObject({ status: "dropped" })
    // a runtime that ends quietly with a run open closes it the same way
    await coord.sendMessage(P, "again", [], [], "again")
    runtime.last.die()
    expect(types(persisted()).slice(-2)).toEqual(["run.started", "run.interrupted"])
  })

  it("failure: the runtime dying mid-run fails the run; the next message starts (resumes) a new runtime session", async () => {
    const { sessionId } = await coord.sendMessage(P, "go", [], [], "go")
    runtime.last.die("process exited with code 1")
    const envs = persisted()
    expect(types(envs)).toEqual(["run.started", "run.failed"])
    expect(envs[1]).toMatchObject({ runtime: "app", event: { error: "process exited with code 1" } })
    expect(envs[1].runId).toBe(envs[0].runId)
    expect(await coord.getStatus(P)).toMatchObject({ running: false, sessionId })
    // dying while idle is a notice, not a run
    await coord.sendMessage(P, "again", [], [], "again")
    expect(runtime.adapters).toHaveLength(2)
    expect(runtime.last.ctx.resume).toBe(sessionId)
    runtime.last.host.emit({ type: "run.completed", result: { subtype: "success", isError: false, text: "", durationMs: null, turns: null, usage: null } }, { itemId: "e" })
    runtime.last.die("sandbox unavailable")
    expect(persisted().at(-1)?.event).toMatchObject({ type: "notice", level: "error", text: "sandbox unavailable" })
  })

  it("queued turns: each send is a run; results end them in order", async () => {
    await coord.sendMessage(P, "one", [], [], "one")
    await coord.sendMessage(P, "two", [], [], "two")
    const a = runtime.last
    const end = (queued: number, id: string) =>
      a.host.emit({ type: "run.completed", result: { subtype: "success", isError: false, text: "", durationMs: null, turns: null, usage: null, queued } }, { itemId: id })
    end(1, "e1")
    expect((await coord.getStatus(P)).running).toBe(true)
    end(0, "e2")
    expect((await coord.getStatus(P)).running).toBe(false)
    const envs = persisted()
    const [r1, r2] = envs.filter((e) => e.event.type === "run.started").map((e) => e.runId)
    expect(r1).not.toBe(r2)
    expect(envs.filter((e) => e.event.type === "run.completed").map((e) => e.runId)).toEqual([r1, r2])
  })

  it("queued messages: waiting until received; one folded into the running turn joins its run; Stop drops the rest", async () => {
    await coord.sendMessage(P, "one", [], [], "one")
    await coord.sendMessage(P, "two", [], [], "two")
    await coord.sendMessage(P, "three", [], [], "three")
    const a = runtime.last
    const [r1, r2, r3] = persisted().filter((e) => e.event.type === "run.started").map((e) => e.runId!)
    expect(a.sent.map((t) => t.id)).toEqual([r1, r2, r3])
    expect(persisted().map((e) => (e.event as { queued?: boolean }).queued ?? false)).toEqual([false, true, true])
    // the first message is never "waiting": its received is no event
    a.host.received!(r1)
    // "two" is steered into the running turn: it joins run one (no run of its own to end)
    a.host.received!(r2)
    expect(persisted().at(-1)).toMatchObject({ runId: r2, itemId: `input:${r2}`, runtime: "app", event: { type: "input.status", status: "received" } })
    a.host.emit({ type: "message.completed", role: "assistant", kind: "text", text: "on it" }, { itemId: "t1" })
    expect(persisted().at(-1)?.runId).toBe(r1)
    const end = (type: "run.completed" | "run.interrupted", queued: number, id: string) =>
      a.host.emit({ type, result: { subtype: "success", isError: false, text: "", durationMs: null, turns: null, usage: null, queued } }, { itemId: id })
    // "three" was refused and queued: the turn ends with one queued, so the next turn is run three
    end("run.completed", 1, "e1")
    expect((await coord.getStatus(P)).running).toBe(true)
    a.host.received!(r3)
    a.host.emit({ type: "message.completed", role: "assistant", kind: "text", text: "three" }, { itemId: "t3" })
    expect(persisted().at(-1)?.runId).toBe(r3)
    end("run.completed", 0, "e3")
    expect((await coord.getStatus(P)).running).toBe(false)
    expect(persisted().filter((e) => e.event.type === "input.status").map((e) => e.runId)).toEqual([r2, r3])

    // Stop: a message still waiting is dropped
    await coord.sendMessage(P, "four", [], [], "four")
    await coord.sendMessage(P, "five", [], [], "five")
    const r5 = persisted().filter((e) => e.event.type === "run.started").at(-1)!.runId
    await coord.stop(P)
    expect(persisted().at(-1)).toMatchObject({ runId: r5, event: { type: "input.status", status: "dropped" } })
  })

  it("queued messages a runtime folds without saying so are received when the turn ends; a dying runtime drops them", async () => {
    await coord.sendMessage(P, "one", [], [], "one")
    await coord.sendMessage(P, "two", [], [], "two")
    const a = runtime.last
    a.host.emit({ type: "run.completed", result: { subtype: "success", isError: false, text: "", durationMs: null, turns: null, usage: null, queued: 0 } }, { itemId: "e1" })
    expect(persisted().at(-1)?.event).toEqual({ type: "input.status", status: "received" })
    await coord.sendMessage(P, "three", [], [], "three")
    await coord.sendMessage(P, "four", [], [], "four")
    a.die("process exited")
    expect(persisted().at(-1)?.event).toEqual({ type: "input.status", status: "dropped" })
  })

  it("model switch and notices are events; appendNotice reaches a session that isn't live", async () => {
    await coord.sendMessage(P, "go", [], [], "go")
    await coord.setModel(P, "haiku")
    expect(runtime.last.models).toEqual(["haiku"])
    expect(persisted().at(-1)?.event).toEqual({ type: "notice", level: "info", text: "Model switched to haiku" })
    coord.closeSession(P)
    await coord.appendNotice(P, "Print request cancelled by a restart")
    expect(persisted().at(-1)?.event).toEqual({ type: "notice", level: "info", text: "Print request cancelled by a restart" })
  })

  it("fork copies the timeline under the runtime's new session id", async () => {
    const { sessionId } = await coord.sendMessage(P, "go", [], [], "go")
    const { sessionId: forked, inheritedCostUsd } = await coord.fork(P, sessionId!)
    expect(inheritedCostUsd).toBe(0) // the parent cost nothing yet; the sidebar shows an idea's own cost on top of this
    expect(runtime.forks).toEqual([sessionId])
    const envs = readEvents(P, forked)
    expect(types(envs)).toEqual(["run.started", "run.interrupted", "notice"]) // the live run was stopped first
    expect(envs.every((e) => e.sessionId === forked)).toBe(true)
    expect(envs[2].event).toMatchObject({ text: "Trying another idea from here: the earlier version is kept" })
  })
})

describe("legacy transcripts", () => {
  const legacy = (sid: string, messages: unknown[]) =>
    messages.map((m, i) => JSON.stringify({ projectId: P, sessionId: sid, seq: i, ts: `2026-10-07T10:00:0${i}.000Z`, message: m })).join("\n") + "\n"

  it("are migrated on read, cost carried over, and a resumed session appends normalized events after them", async () => {
    const sid = "old-session"
    mkdirSync(join(root, ".studio", "sessions"), { recursive: true })
    writeFileSync(
      eventsPath(P, sid),
      legacy(sid, [
        { type: "user_input", text: "make a hook" },
        { type: "system", subtype: "init", model: "claude-opus", cwd: root, session_id: sid },
        { type: "assistant", uuid: "u1", message: { id: "msg1", content: [{ type: "text", text: "Sure." }, { type: "tool_use", id: "toolu_1", name: "mcp__studio__render_part", input: { partId: "hook" } }] } },
        { type: "user", uuid: "u2", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "rendered" }] }] } },
        { type: "result", subtype: "success", is_error: false, result: "Here it is", duration_ms: 1200, num_turns: 2, total_cost_usd: 0.3, studio_cost_usd: 0.42 },
        { type: "app_notice", text: "Model switched to haiku" },
      ]) + "{torn",
    )
    const envs = readEvents(P, sid)
    expect(types(envs)).toEqual(["run.started", "notice", "message.completed", "tool.started", "tool.completed", "run.completed", "notice"])
    expect(envs[0]).toMatchObject({ runId: "legacy-0", itemId: "user:legacy-0", event: { input: { text: "make a hook" } } })
    expect(envs[1].event).toMatchObject({ code: "session.started", text: "Session started · claude-opus" })
    expect(envs[2]).toMatchObject({ eventId: "2", seq: 2, itemId: "u1:0", event: { role: "assistant", text: "Sure." } })
    expect(envs[3]).toMatchObject({ eventId: "2.1", seq: 2, itemId: "toolu_1", event: { name: "mcp__studio__render_part", input: { partId: "hook" } } })
    expect(envs[5].event).toMatchObject({ result: { subtype: "success", text: "Here it is", durationMs: 1200, turns: 2, usage: { estimatedApiUsd: 0.42, billing: "unknown", final: true } } })
    expect(envs[5].runId).toBe("legacy-0")
    expect(envs[6].runId).toBeNull()

    project = { ...project, activeSessionId: sid, sessions: [{ id: sid, title: "Design session", forkedFrom: null }] }
    expect(await coord.getStatus(P)).toMatchObject({ costUsd: 0.42 })
    await coord.sendMessage(P, "make it bigger", [], [], "make it bigger")
    expect(runtime.last.ctx).toMatchObject({ resume: sid, priorCostUsd: 0.42 })
    const after = readEvents(P, sid)
    expect(after.slice(0, 7)).toEqual(envs) // the old lines read the same
    expect(after[7]).toMatchObject({ seq: 6, eventId: "6", event: { type: "run.started", input: { text: "make it bigger" } } })
    // the legacy endpoint still serves the raw lines (diagnostics, evals) followed by the native log
    const native = await coord.getNativeTimeline(P)
    expect(native.map((e) => e.message.type)).toEqual(["user_input", "system", "assistant", "user", "result", "app_notice", "user_input"])
    expect(existsSync(nativePath(P, sid))).toBe(true)
  })
})
