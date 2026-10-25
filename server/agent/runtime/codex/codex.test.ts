// Codex runtime (R11d) conformance: the real session coordinator + the real Codex adapter over a scripted app-server
// (FakeAppServer) and a recorded, scrubbed transcript of a live design turn (fixtures/design-turn.jsonl). Covers the
// coordinator.test.ts scenarios through the Codex protocol: runs, streaming, app tools and their gates, questions,
// permissions, interrupt, failure, duplicates, resume by native thread id, isolation config. No Codex, no tokens.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentEvent, AgentEventEnvelope, CodexRuntimeSettings, Project } from "../../../../shared/types"
/* eslint-disable @typescript-eslint/no-explicit-any */

const home = mkdtempSync(join(tmpdir(), "printstudio-codex-test-"))
process.env.PRINTSTUDIO_HOME = home

const { SessionCoordinator } = await import("../../coordinator")
const { deps } = await import("../../deps")
const { APPROVAL_REFUSAL, setApproved, isApproved } = await import("../../approval")
const { ToolRegistry, STUDIO_TOOLS } = await import("../../registry")
const { readEvents, nativeRef } = await import("../../transcript")
const { listQuestions } = await import("../../questions")
const { listPermissions } = await import("../../permissions")
const { CodexAdapter, CodexRuntime } = await import("./adapter")
const { configOverrides, permissionProfile } = await import("./config")
const { CodexNormalizer, imageFromUrl } = await import("./normalize")
const { FakeAppServer, ReplayServer, readFixture } = await import("./testing")
type FakeServer = InstanceType<typeof FakeAppServer>

afterAll(() => rmSync(home, { recursive: true, force: true }))

const P = "codex-test"
let root = ""
let project: Project
let settings: CodexRuntimeSettings
let servers: FakeServer[] = []
let runtime: InstanceType<typeof CodexRuntime>
let coord: InstanceType<typeof SessionCoordinator>
const realDeps = { ...deps }

const last = () => servers[servers.length - 1]
const persisted = () => readEvents(P, project.activeSessionId!)
const types = (envs: AgentEventEnvelope[]) => envs.map((e) => e.event.type)
const tick = () => new Promise((r) => setTimeout(r, 5))
async function until(cond: () => boolean, what = "condition") {
  for (let i = 0; i < 400; i++) {
    if (cond()) return
    await tick()
  }
  throw new Error(`timed out waiting for ${what}`)
}
const ofType = <T extends AgentEvent["type"]>(t: T) => persisted().filter((e) => e.event.type === t).map((e) => e.event as Extract<AgentEvent, { type: T }>)

function makeRuntime(onSpawn?: (s: FakeServer) => void) {
  return new CodexRuntime({
    findBinary: () => "/fake/codex",
    spawn: (o) => {
      const s = new FakeAppServer(o.args)
      onSpawn?.(s)
      servers.push(s)
      return s
    },
    settings: () => settings,
    home: () => join(home, "codex"),
    secret: () => null,
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codex-proj-"))
  mkdirSync(join(root, "parts"), { recursive: true })
  writeFileSync(join(root, "parts", "main.scad"), "cube(20);")
  project = {
    id: P,
    name: "Codex",
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
  settings = { login: "app" }
  servers = []
  runtime = makeRuntime()
  coord = new SessionCoordinator({
    runtimes: [runtime],
    tools: new ToolRegistry(STUDIO_TOOLS),
    prepare: async () => ({ instructions: "brief", policy: { denyRead: ["/studio/secrets.json"] }, model: "gpt-test", notices: [] }),
  })
})
afterEach(() => {
  coord.dispose()
  Object.assign(deps, realDeps)
  setApproved(P, false)
  rmSync(root, { recursive: true, force: true })
})

/** Send a message and wait until the session's app-server got turn/start. */
async function send(text: string) {
  const r = await coord.sendMessage(P, text, [], [], text)
  await until(() => last()?.requests("turn/start").length > 0, "turn/start")
  return r
}
const turnDone = (s: FakeServer, status = "completed", text = "Done.") =>
  s.notify("turn/completed", { threadId: "thr-1", turn: { id: s.turnId, items: [{ type: "agentMessage", id: "m9", text }], status, error: status === "failed" ? { message: "boom" } : null } })

describe("Codex adapter through the session coordinator", () => {
  it("starts a session: preflight, isolation config, app skills, thread/start with the app's tools; maps app id -> thread id", async () => {
    const { sessionId } = await send("make a cube")
    expect(servers).toHaveLength(2) // preflight + session
    const s = last()
    const args = s.args.join(" ")
    expect(args).toContain('default_permissions="printstudio"')
    expect(args).toContain("network={enabled=false}")
    expect(args).toContain('"build"="read"')
    expect(args).toContain('"**/*.gcode"="deny"')
    expect(args).toContain('"/studio/secrets.json"="deny"')
    expect(args).toContain("project_doc_max_bytes=0")
    expect(args).toContain("features.plugins=false")
    expect(args).toContain('mcp_servers."mine".enabled=false') // user MCP servers off
    expect(args).toContain('{path="/Users/user/.agents/skills/other/SKILL.md", enabled=false}') // foreign skills off
    expect(s.requests("skills/extraRoots/set")[0].params).toEqual({ extraRoots: [join(root, ".claude", "skills")] })
    const start = s.requests("thread/start")[0].params as any
    expect(start).toMatchObject({ cwd: root, model: "gpt-test", approvalPolicy: "on-request", approvalsReviewer: "user" })
    expect(start.developerInstructions).toContain("brief")
    const names = start.dynamicTools.map((t: any) => t.name)
    expect(names).toEqual(expect.arrayContaining(["list_parts", "render_part", "slice_part", "request_print", "AskUserQuestion"]))
    expect(start.dynamicTools.find((t: any) => t.name === "slice_part").inputSchema.$schema).toBeUndefined()
    expect(nativeRef(P, sessionId!)).toEqual({ runtime: "codex", nativeId: "thr-1" })
    expect(project.sessions.find((x) => x.id === sessionId)?.runtime).toBe("codex")
  })

  it("streams a run: deltas live, items, app tool calls with app identity, usage tokens (no money), run.completed", async () => {
    await send("make a cube")
    const s = last()
    const T = s.turnId
    s.notify("turn/started", { threadId: "thr-1", turn: { id: T, items: [], status: "inProgress" } })
    s.notify("item/agentMessage/delta", { threadId: "thr-1", turnId: T, itemId: "m1", delta: "Hel" })
    s.notify("item/completed", { threadId: "thr-1", turnId: T, item: { type: "agentMessage", id: "m1", text: "Hello" } })
    s.notify("item/started", { threadId: "thr-1", turnId: T, item: { type: "dynamicToolCall", id: "c1", tool: "list_parts", arguments: { projectId: "other" }, status: "inProgress" } })
    const r = await s.request("item/tool/call", { threadId: "thr-1", turnId: T, callId: "c1", namespace: null, tool: "list_parts", arguments: { projectId: "other" } })
    const out = r.result as any
    expect(out.success).toBe(true)
    expect(out.contentItems[0].text).toContain('"id": "main"') // this project, whatever the input said
    s.notify("item/completed", { threadId: "thr-1", turnId: T, item: { type: "dynamicToolCall", id: "c1", tool: "list_parts", arguments: {}, status: "completed", contentItems: out.contentItems, success: true } })
    s.notify("item/started", { threadId: "thr-1", turnId: T, item: { type: "commandExecution", id: "x1", command: "ls", cwd: root, status: "inProgress" } })
    s.notify("item/completed", { threadId: "thr-1", turnId: T, item: { type: "commandExecution", id: "x1", command: "ls", cwd: root, status: "completed", exitCode: 0, aggregatedOutput: "parts\n" } })
    s.notify("thread/tokenUsage/updated", { threadId: "thr-1", turnId: T, tokenUsage: { total: { inputTokens: 100, outputTokens: 7, cachedInputTokens: 50, cacheWriteInputTokens: 0 } } })
    turnDone(s)
    await until(() => ofType("run.completed").length === 1, "run.completed")
    const ev = persisted()
    expect(types(ev)).toEqual(["notice", "run.started", "message.completed", "tool.started", "tool.completed", "tool.started", "tool.completed", "run.completed"])
    expect(ev.every((e) => e.event.type !== "message.delta")).toBe(true) // live only
    const tools = ofType("tool.started").map((t) => t.name)
    expect(tools).toEqual(["mcp__studio__list_parts", "Bash"])
    // item ids are scoped to the turn so a reused id can't merge two timeline items
    expect(ev.find((e) => e.event.type === "message.completed")?.itemId).toBe(`${T}:m1`)
    const done = ofType("run.completed")[0].result
    expect(done.usage).toMatchObject({ tokens: { input: 100, output: 7, cacheRead: 50 }, billedUsd: null, estimatedApiUsd: null, billing: "plan", final: true })
    expect(done.text).toBe("Done.")
    expect((await coord.getStatus(P)).running).toBe(false)
  })

  it("gates hold through the Codex tool path: slice_part before approval is refused; the user's words approve", async () => {
    await send("make a cube")
    const s = last()
    const r1 = await s.request("item/tool/call", { threadId: "thr-1", turnId: s.turnId, callId: "c1", tool: "slice_part", arguments: { partId: "main" } })
    expect(r1.result).toMatchObject({ success: false, contentItems: [{ type: "inputText", text: `Error: ${APPROVAL_REFUSAL}` }] })
    expect(deps.slicePart).not.toHaveBeenCalled()
    turnDone(s)
    await until(() => ofType("run.completed").length === 1)
    await coord.sendMessage(P, "looks right, print it", [], [], "looks right, print it")
    await until(() => s.requests("turn/start").length === 2)
    const r2 = await s.request("item/tool/call", { threadId: "thr-1", turnId: s.turnId, callId: "c2", tool: "slice_part", arguments: { partId: "main" } })
    expect((r2.result as any).success).toBe(true)
    // a Codex patch to a part withdraws the approval (geometry changed), like Claude's Write/Edit
    s.notify("item/started", { threadId: "thr-1", turnId: s.turnId, item: { type: "fileChange", id: "f1", changes: [{ path: "parts/main.scad", kind: { type: "update" }, diff: "" }], status: "inProgress" } })
    await until(() => !isApproved(P), "approval withdrawn")
  })

  it("questions: AskUserQuestion is answered through the app's question cards", async () => {
    await send("make me a hook")
    const s = last()
    const asked = s.request("item/tool/call", {
      threadId: "thr-1",
      turnId: s.turnId,
      callId: "q1",
      tool: "AskUserQuestion",
      arguments: { questions: [{ question: "How big?", header: "Size", multiSelect: false, options: [{ label: "Small (Recommended)", description: "" }, { label: "Big", description: "" }] }] },
    })
    await until(() => listQuestions(P).length === 1, "question")
    expect(ofType("question.requested")[0]).toMatchObject({ requestId: "q1", questions: [{ question: "How big?" }] })
    await coord.answerQuestion(P, "q1", { "How big?": "Big" })
    const r = (await asked).result as any
    expect(r.success).toBe(true)
    expect(r.contentItems[0].text).toContain('"How big?"="Big"')
  })

  it("approvals: leaving the sandbox is refused by policy; reading a file outside the project asks the user", async () => {
    await send("use my photo")
    const s = last()
    const cmd = await s.request("item/commandExecution/requestApproval", { threadId: "thr-1", turnId: s.turnId, itemId: "x1", command: "curl http://10.0.0.24:7125", reason: "needs network" })
    expect(cmd.result).toEqual({ decision: "decline" })
    const patch = await s.request("item/fileChange/requestApproval", { threadId: "thr-1", turnId: s.turnId, itemId: "f1", grantRoot: "/" })
    expect(patch.result).toEqual({ decision: "decline" })
    const net = await s.request("item/permissions/requestApproval", { threadId: "thr-1", turnId: s.turnId, itemId: "p1", cwd: root, reason: null, permissions: { network: { enabled: true }, fileSystem: null } })
    expect(net.result).toEqual({ permissions: {}, scope: "turn" })
    expect(listPermissions(P)).toHaveLength(0) // never asked
    const secret = await s.request("item/permissions/requestApproval", { threadId: "thr-1", turnId: s.turnId, itemId: "p2", cwd: root, reason: null, permissions: { fileSystem: { read: ["/studio/secrets.json"], write: null } } })
    expect(secret.result).toEqual({ permissions: {}, scope: "turn" })
    const photo = s.request("item/permissions/requestApproval", { threadId: "thr-1", turnId: s.turnId, itemId: "p3", cwd: root, reason: "to measure it", permissions: { fileSystem: { read: ["/Users/user/Downloads/hook.jpg"], write: ["/Users/user/Downloads"] } } })
    await until(() => listPermissions(P).length === 1, "permission card")
    const req = listPermissions(P)[0]
    expect(req.detail).toContain("/Users/user/Downloads/hook.jpg")
    expect(ofType("permission.requested")[0]).toMatchObject({ requestId: req.requestId, tool: "permissions" })
    await coord.answerPermission(P, req.requestId, true)
    // read granted; the write outside the project is not
    expect((await photo).result).toEqual({ permissions: { fileSystem: { read: ["/Users/user/Downloads/hook.jpg"], write: null } }, scope: "turn" })
  })

  it("interrupt: stop sends turn/interrupt, pending questions are refused, the run ends as run.interrupted", async () => {
    await send("make a cube")
    const s = last()
    const asked = s.request("item/tool/call", { threadId: "thr-1", turnId: s.turnId, callId: "q1", tool: "AskUserQuestion", arguments: { questions: [{ question: "Size?", header: "S", multiSelect: false, options: [{ label: "A", description: "" }, { label: "B", description: "" }] }] } })
    await until(() => listQuestions(P).length === 1)
    await coord.stop(P)
    expect(s.requests("turn/interrupt")[0].params).toEqual({ threadId: "thr-1", turnId: s.turnId })
    expect(((await asked).result as any).success).toBe(false)
    await until(() => ofType("run.interrupted").length === 1, "run.interrupted")
    expect((await coord.getStatus(P)).running).toBe(false)
  })

  it("failure: a failed turn is run.failed with the error; the app-server dying mid-run fails the run, next message starts again", async () => {
    await send("make a cube")
    const s = last()
    turnDone(s, "failed")
    await until(() => ofType("run.failed").length === 1)
    expect(ofType("run.failed")[0]).toMatchObject({ error: "boom", result: { isError: true } })
    await coord.sendMessage(P, "again", [], [], "again")
    await until(() => s.requests("turn/start").length === 2)
    s.die("Codex stopped unexpectedly (exit 1).")
    await until(() => ofType("run.failed").length === 2)
    expect(ofType("run.failed")[1].error).toContain("Codex stopped unexpectedly")
    // next message: a new app-server resumes the same thread (native id from the map)
    await send("try again")
    expect(last()).not.toBe(s)
    expect(last().requests("thread/resume")[0].params).toMatchObject({ threadId: "thr-1" })
  })

  it("duplicates: the same item/completed twice is persisted once", async () => {
    await send("make a cube")
    const s = last()
    const item = { threadId: "thr-1", turnId: s.turnId, item: { type: "agentMessage", id: "m1", text: "Same" } }
    s.notify("item/completed", item)
    s.notify("item/completed", item)
    turnDone(s)
    await until(() => ofType("run.completed").length === 1)
    expect(ofType("message.completed").filter((m) => m.text === "Same")).toHaveLength(1)
  })

  it("steers a message sent mid-turn into the running turn (images too); it reads as received when the model has it", async () => {
    await send("one")
    const s = last()
    const T = s.turnId
    s.handlers["turn/steer"] = (p) => ({ turnId: p.expectedTurnId })
    s.notify("turn/started", { threadId: "thr-1", turn: { id: T, items: [], status: "inProgress" } })
    await until(() => persisted().length >= 2)
    await coord.sendMessage(P, "two", [{ mediaType: "image/png", data: "AAAA" }], [], "two")
    await until(() => s.requests("turn/steer").length === 1, "turn/steer")
    const [r1, r2] = persisted()
      .filter((e) => e.event.type === "run.started")
      .map((e) => e.runId!)
    const steer = s.requests("turn/steer")[0].params as any
    expect(steer).toEqual({
      threadId: "thr-1",
      expectedTurnId: T,
      clientUserMessageId: r2,
      input: [
        { type: "text", text: "two", text_elements: [] },
        { type: "image", url: "data:image/png;base64,AAAA" },
      ],
    })
    expect(ofType("run.started")[1].queued).toBe(true)
    await tick()
    expect(ofType("input.status")).toEqual([]) // accepted, not read yet
    s.notify("item/started", { threadId: "thr-1", turnId: T, item: { type: "userMessage", id: "u2", clientId: r2, content: steer.input } })
    await until(() => ofType("input.status").length === 1, "received")
    expect(persisted().at(-1)).toMatchObject({ runId: r2, event: { type: "input.status", status: "received" } })
    s.notify("item/completed", { threadId: "thr-1", turnId: T, item: { type: "agentMessage", id: "m2", text: "Got it, switching." } })
    turnDone(s)
    await until(() => ofType("run.completed").length === 1)
    // one turn: no second turn/start, the steered run joined run one, nothing left running
    expect(s.requests("turn/start")).toHaveLength(1)
    expect(persisted().filter((e) => e.event.type === "message.completed").map((e) => e.runId)).toEqual([r1])
    expect(ofType("run.completed")[0].result.queued).toBe(0)
    expect((await coord.getStatus(P)).running).toBe(false)
  })

  it("steering refused (a compact turn): the message waits and starts the next turn; several go in one turn", async () => {
    await send("one")
    const s = last()
    s.handlers["turn/steer"] = () => Promise.reject(new Error("cannot steer a compact turn"))
    await coord.sendMessage(P, "two", [], [], "two")
    await until(() => s.requests("turn/steer").length === 1)
    await tick()
    await coord.sendMessage(P, "three", [], [], "three")
    await tick()
    expect(s.requests("turn/steer")).toHaveLength(1) // behind the queued one, not ahead of it
    expect(s.requests("turn/start")).toHaveLength(1)
    turnDone(s)
    await until(() => s.requests("turn/start").length === 2, "next turn")
    expect((s.requests("turn/start")[1].params as any).input.map((i: any) => i.text)).toEqual(["two", "three"])
    await until(() => ofType("input.status").length === 2)
    expect(ofType("run.completed")[0].result.queued).toBe(2)
    turnDone(s)
    await until(() => ofType("run.completed").length === 2)
    const runs = persisted().filter((e) => e.event.type === "run.started").map((e) => e.runId)
    expect(persisted().filter((e) => e.event.type === "run.completed").map((e) => e.runId)).toEqual([runs[0], runs[1]])
    expect((await coord.getStatus(P)).running).toBe(false)
  })

  it("a turn that ends as it is steered: the message starts the next turn right away", async () => {
    await send("one")
    const s = last()
    // the turn completes first, then the steer is refused ("no active turn")
    s.handlers["turn/steer"] = (_p, srv) => {
      turnDone(srv)
      return Promise.reject(new Error("no active turn to steer"))
    }
    await coord.sendMessage(P, "two", [], [], "two")
    await until(() => s.requests("turn/start").length === 2, "next turn")
    expect((s.requests("turn/start")[1].params as any).input[0].text).toBe("two")
    await until(() => ofType("input.status").length === 1)
    turnDone(s)
    await until(() => ofType("run.completed").length === 2)
    expect((await coord.getStatus(P)).running).toBe(false)

    // accepted, but the turn ended before the model read it: it goes in the next turn
    s.handlers["turn/steer"] = (p) => ({ turnId: p.expectedTurnId })
    await send("three")
    await coord.sendMessage(P, "four", [], [], "four")
    await until(() => s.requests("turn/steer").length === 2)
    await tick()
    turnDone(s)
    await until(() => s.requests("turn/start").length === 4, "turn for the unread message")
    expect((s.requests("turn/start")[3].params as any).input[0].text).toBe("four")
  })

  it("stop while the turn is still starting: the turn is interrupted as soon as it starts (parity run 2026-10-11)", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    runtime = makeRuntime((s) => {
      const start = s.handlers["turn/start"]
      s.handlers["turn/start"] = async (p, srv) => {
        await gate
        return start(p, srv)
      }
    })
    coord = new SessionCoordinator({ runtimes: [runtime], tools: new ToolRegistry(STUDIO_TOOLS), prepare: async () => ({ instructions: "brief", policy: {}, model: "gpt-test", notices: [] }) })
    await coord.sendMessage(P, "make a cube", [], [], "make a cube")
    await until(() => last()?.requests("turn/start").length > 0, "turn/start")
    await coord.stop(P)
    release()
    await until(() => last().requests("turn/interrupt").length === 1, "turn/interrupt")
    await until(() => ofType("run.interrupted").length === 1, "run.interrupted")
    expect(ofType("run.completed")).toHaveLength(0)
  })

  it("stop drops what's queued: no next turn, the waiting message reads as dropped", async () => {
    await send("one")
    const s = last()
    s.handlers["turn/steer"] = () => Promise.reject(new Error("cannot steer a review turn"))
    await coord.sendMessage(P, "two", [], [], "two")
    await until(() => s.requests("turn/steer").length === 1)
    await tick()
    await coord.stop(P)
    await until(() => ofType("run.interrupted").length === 1)
    await tick()
    expect(s.requests("turn/start")).toHaveLength(1)
    expect(ofType("input.status")).toEqual([{ type: "input.status", status: "dropped" }])
    expect((await coord.getStatus(P)).running).toBe(false)
  })

  it("isolation: login 'user' without the user's OK refuses to start; a missing sign-in is a plain error", async () => {
    settings = { login: "user" }
    await expect(coord.sendMessage(P, "hi", [], [], "hi")).rejects.toThrow(/partly isolates/)
    settings = { login: "app" }
    const s = new FakeAppServer()
    s.handlers["account/read"] = () => ({ account: null, requiresOpenaiAuth: true })
    const rt = new CodexRuntime({ findBinary: () => "/fake/codex", spawn: () => s, settings: () => settings, home: () => home, secret: () => null })
    const probe = await rt.probe()
    expect(probe).toMatchObject({ runtime: "codex", installed: true, auth: { status: "missing" }, ready: false, login: { fix: { kind: "codex-login" } } })
    expect(probe.capabilities.isolation.level).toBe("full")
    settings = { login: "user", allowPartialIsolation: true }
    expect(rt.capabilities.isolation).toMatchObject({ level: "partial" })
  })

  it("fork: thread/fork on the thread that holds the conversation; the new app session maps to the fork", async () => {
    const { sessionId } = await send("make a cube")
    turnDone(last())
    await until(() => ofType("run.completed").length === 1)
    const { sessionId: forked } = await coord.fork(P, sessionId!, "idea 2")
    expect(forked).not.toBe("thr-1-fork") // app ids stay the app's
    expect(nativeRef(P, forked)).toEqual({ runtime: "codex", nativeId: "thr-1-fork" })
    expect(last().requests("thread/fork")[0].params).toMatchObject({ threadId: "thr-1" })
  })
})

describe("recorded protocol fixtures", () => {
  const fixture = (n: string) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url))

  it("replays a live design turn (list_parts + render_part through app tools) into the expected normalized events", async () => {
    const lines = readFixture(fixture("design-turn.jsonl"))
    const replays = ["preflight", "session"].map((c) => new ReplayServer(lines.filter((l) => l.conn === c)))
    let k = 0
    const events: { event: AgentEvent; itemId?: string | null }[] = []
    const calls: { name: string; input: unknown }[] = []
    const adapter = new CodexAdapter(
      {
        emit: (event, o) => events.push({ event, itemId: o?.itemId }),
        native: () => {},
        askUser: async () => ({ answered: false, message: "no" }),
        askPermission: async () => ({ allow: false }),
        nativeToolAllowed: () => {},
        nativeSessionChanged: () => {},
        ended: () => {},
      },
      { findBinary: () => "/fake/codex", spawn: () => replays[k++], settings: () => ({ login: "user", allowPartialIsolation: true }), home: () => home, secret: () => null }
    )
    const tools = {
      list: () => STUDIO_TOOLS,
      call: async (name: string, input: unknown) => {
        calls.push({ name, input })
        return name === "render_part"
          ? { content: [{ type: "text" as const, text: '{"partId":"main"}' }, { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" }] }
          : { content: [{ type: "text" as const, text: '[{"id":"main"}]' }] }
      },
    }
    const { nativeSessionId } = await adapter.start({
      projectId: "codex-live-check",
      sessionId: "app-1",
      cwd: "/projects/codex-live-check",
      resume: null,
      instructions: "brief",
      tools,
      policy: {},
      priorCostUsd: 0,
      profile: { profileId: null, name: "Codex", runtime: "codex", model: "gpt-5.6-luna", auth: { kind: "subscription" }, endpointRef: null, binaryPath: null, effort: "low", budget: { maxUsdPerRun: null }, policy: "design-sandbox", source: "default", frozenAt: "" },
    })
    expect(nativeSessionId).toMatch(/^[0-9a-f-]{36}$/)
    adapter.send({ text: "check", agentText: "check", images: [], annotations: [] })
    await until(() => events.some((e) => e.event.type === "run.completed"), "run.completed")
    adapter.close()
    expect(replays.flatMap((r) => r.mismatches)).toEqual([])
    expect(calls.map((c) => c.name)).toEqual(["list_parts", "render_part"])
    const kinds = events.filter((e) => e.event.type !== "message.delta" && e.event.type !== "usage.updated").map((e) => (e.event.type === "tool.started" ? `tool.started:${e.event.name}` : e.event.type))
    expect(kinds).toEqual([
      "notice",
      "message.completed",
      "tool.started:mcp__studio__list_parts",
      "tool.completed",
      "tool.started:mcp__studio__render_part",
      "tool.completed",
      "message.completed",
      "run.completed",
    ])
    const rendered = events.filter((e) => e.event.type === "tool.completed")[1].event as Extract<AgentEvent, { type: "tool.completed" }>
    expect(rendered.images.length).toBeGreaterThan(0)
    const done = events.find((e) => e.event.type === "run.completed")!.event as Extract<AgentEvent, { type: "run.completed" }>
    expect(done.result.usage).toMatchObject({ billing: "plan", billedUsd: null, estimatedApiUsd: null, final: true })
    expect(done.result.usage?.tokens?.input).toBeGreaterThan(0)
  })

  it("normalizes the recorded boundary turn: every shell command is a Bash row, sandbox denials are errors", () => {
    const n = new CodexNormalizer()
    const out = readFixture(fixture("boundary-turn.jsonl"))
      .filter((l) => l.conn === "session" && l.dir === "<" && l.msg.method)
      .flatMap((l) => n.convert(l.msg.method!, l.msg.params))
    const bash = out.filter((o) => o.event.type === "tool.started" && o.event.name === "Bash")
    expect(bash.length).toBeGreaterThan(0)
    const curl = out.find((o) => o.event.type === "tool.completed" && o.itemId === bash[0].itemId)!.event as Extract<AgentEvent, { type: "tool.completed" }>
    expect(curl.isError).toBe(true) // curl to the fake printer failed inside the sandbox
  })
})

describe("config and normalizer units", () => {
  it("permission profile: workspace writable, app paths read-only, G-code denied, secrets and Codex auth unreadable, no network", () => {
    const p = permissionProfile({ codexHome: "/h", denyRead: ["/s/secrets.json"] })
    for (const k of ['"."="write"', '".studio"="read"', '".git"="read"', '".claude"="read"', '"AGENTS.md"="read"', '"**/*.gcode"="deny"', '"/s/secrets.json"="deny"', '"/h/auth.json"="deny"', "network={enabled=false}"])
      expect(p).toContain(k)
    const args = configOverrides({ cwd: "/p", codexHome: "/h" })
    expect(args.filter((a) => a === "-c").length).toBe(args.length / 2)
    expect(args).toContain('projects."/p".trust_level="untrusted"')
  })

  it("normalizer: data-URL images, declined commands, file changes", () => {
    expect(imageFromUrl("data:image/png;base64,AAAA")).toEqual({ mediaType: "image/png", data: "AAAA" })
    const n = new CodexNormalizer()
    const declined = n.convert("item/completed", { turnId: "t", item: { type: "commandExecution", id: "x", command: "curl", status: "declined" } })
    expect(declined.map((o) => o.event.type)).toEqual(["tool.started", "tool.completed"])
    expect(declined[1].event).toMatchObject({ isError: true, text: expect.stringContaining("Blocked by Crease") })
    const fc = n.convert("item/started", { turnId: "t", item: { type: "fileChange", id: "f", changes: [{ path: "parts/a.scad", kind: { type: "add" }, diff: "+x" }] } })
    expect(fc[0].event).toMatchObject({ type: "tool.started", name: "Edit", input: { file_path: "parts/a.scad" } })
  })
})
