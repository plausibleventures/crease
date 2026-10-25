// Direct API runtime (R11f) conformance: the real session coordinator + the real API adapter + the real Anthropic SDK
// endpoint, against a scripted Messages API server (testing.ts FakeMessagesApi on 127.0.0.1). Covers the
// coordinator.test.ts / codex / grok scenarios through the app-owned loop: runs and streaming, tool calls with streamed
// input and app identity, gates, file-tool policy (protected writes refused), schema failures, retries (529, 429,
// overloaded mid-stream), max_tokens, questions, interrupt, budget stop, step limit, trimming, resume/fork from the
// store, auth errors, images, connection test, skills. No real API, no tokens.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentEvent, AgentEventEnvelope, AgentProfileSnapshot, Project } from "../../../../shared/types"
/* eslint-disable @typescript-eslint/no-explicit-any */

const home = mkdtempSync(join(tmpdir(), "printstudio-api-test-"))
process.env.PRINTSTUDIO_HOME = home

const { SessionCoordinator } = await import("../../coordinator")
const { deps } = await import("../../deps")
const { APPROVAL_REFUSAL, setApproved, isApproved } = await import("../../approval")
const { ToolRegistry, STUDIO_TOOLS } = await import("../../registry")
const { readEvents } = await import("../../transcript")
const { listQuestions } = await import("../../questions")
const { listFailures } = await import("../../failures")
const { ApiRuntime, defaultApiDeps, API_PRINTER_ENDPOINT, API_NO_KEY } = await import("./adapter")
const { AnthropicEndpoint } = await import("./anthropic")
const { apiSessionPath, ConversationStore, TRIMMED_RESULT } = await import("./conversation")
const { FakeMessagesApi, messageStream, overloaded, overloadedMidStream, rateLimited } = await import("./testing")
type Fake = InstanceType<typeof FakeMessagesApi>

afterAll(() => rmSync(home, { recursive: true, force: true }))

const P = "api-test"
let root = ""
let project: Project
let fake: Fake
let coord: InstanceType<typeof SessionCoordinator>
let runtime: InstanceType<typeof ApiRuntime>
let apiDeps: typeof defaultApiDeps & { trimAt?: number }
let profile: AgentProfileSnapshot
let maxTurns: number | undefined
let slept: number[] = []
const realDeps = { ...deps }

const persisted = () => readEvents(P, project.activeSessionId!)
const types = (envs: AgentEventEnvelope[]) => envs.map((e) => e.event.type)
const tick = () => new Promise((r) => setTimeout(r, 5))
async function until(cond: () => boolean, what = "condition") {
  for (let i = 0; i < 800; i++) {
    if (cond()) return
    await tick()
  }
  throw new Error(`timed out waiting for ${what}`)
}
const ofType = <T extends AgentEvent["type"]>(t: T) => persisted().filter((e) => e.event.type === t).map((e) => e.event as Extract<AgentEvent, { type: T }>)
const ends = () => persisted().filter((e) => /^run\.(completed|failed|interrupted)$/.test(e.event.type)).length
/** tool_result blocks of a request's last user message, by tool_use_id. */
const results = (body: any) => {
  const last = body.messages[body.messages.length - 1]
  return Object.fromEntries(last.content.filter((b: any) => b.type === "tool_result").map((b: any) => [b.tool_use_id, b]))
}
const resultText = (r: any) => r.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")

function snapshot(o: Partial<AgentProfileSnapshot> = {}): AgentProfileSnapshot {
  return {
    profileId: "api1",
    name: "API",
    runtime: "api",
    model: null,
    auth: { kind: "api-key", credentialRef: "profile.api1.apiKey" },
    endpointRef: fake.url,
    binaryPath: null,
    apiProtocol: "anthropic",
    effort: null,
    budget: { maxUsdPerRun: null },
    policy: "design-sandbox",
    source: "default",
    frozenAt: "",
    ...o,
  }
}

beforeEach(async () => {
  fake = await new FakeMessagesApi().start()
  root = mkdtempSync(join(tmpdir(), "api-proj-"))
  mkdirSync(join(root, "parts"), { recursive: true })
  mkdirSync(join(root, "build"), { recursive: true })
  writeFileSync(join(root, "parts", "main.scad"), "cube(20);")
  project = {
    id: P,
    name: "API",
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
  slept = []
  maxTurns = undefined
  apiDeps = {
    ...defaultApiDeps,
    secret: (ref: string) => (ref === "profile.api1.apiKey" ? "test-key" : null),
    priced: () => true,
    sleep: async (ms: number) => void slept.push(ms),
    printerHosts: () => ["10.0.0.24"],
  }
  runtime = new ApiRuntime(apiDeps)
  profile = snapshot()
  coord = new SessionCoordinator({
    runtimes: [runtime],
    resolveProfile: () => ({ ...profile, frozenAt: new Date().toISOString() }),
    tools: new ToolRegistry(STUDIO_TOOLS),
    prepare: async () => ({ instructions: "BRIEF-TEXT", policy: { printerHosts: ["10.0.0.24"], denyRead: [join(home, "secrets.json")] }, model: null, maxTurns, notices: [] }),
  })
})
afterEach(() => {
  coord.dispose()
  fake.close()
  Object.assign(deps, realDeps)
  setApproved(P, false)
  rmSync(root, { recursive: true, force: true })
})

async function send(text: string, images: any[] = []) {
  const before = ends()
  await coord.sendMessage(P, text, images, [], text)
  return before
}
async function turn(text: string, images: any[] = []) {
  const before = await send(text, images)
  await until(() => ends() > before, "run end")
}

describe("API runtime through the session coordinator (Anthropic Messages API, scripted)", () => {
  it("runs a turn: frozen system prompt + tools, caching, adaptive thinking; streamed blocks; billed usage from published prices", async () => {
    fake.push({ sse: messageStream([{ thinking: "Plan: a cube." }, { text: "Here is your cube." }], { usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1000 } }) })
    await turn("make a cube")
    const body = fake.calls[0]
    expect(body.model).toBe("claude-opus-5-5")
    expect(body.stream).toBe(true)
    expect(body.system[0].text).toContain("Crease design assistant")
    expect(body.system[0].text).toContain("BRIEF-TEXT")
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" })
    expect(body.cache_control).toEqual({ type: "ephemeral" })
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" })
    const names = body.tools.map((t: any) => t.name)
    expect(names).toEqual(expect.arrayContaining(["read_file", "list_files", "write_file", "edit_file", "read_skill", "list_parts", "slice_part", "request_print", "AskUserQuestion"]))
    expect(names.some((n: string) => /bash|shell|exec/i.test(n))).toBe(false)
    expect(body.tools.every((t: any) => t.input_schema?.type === "object" && t.input_schema.$schema === undefined)).toBe(true)
    expect(body.tools[0].eager_input_streaming).toBeUndefined() // custom base URL: off
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "make a cube" }] }])
    expect(fake.requests[0].headers["x-api-key"]).toBe("test-key")
    const ev = persisted()
    expect(types(ev)).toEqual(["notice", "run.started", "message.completed", "message.completed", "run.completed"])
    expect(ev[0].event).toMatchObject({ code: "session.started", data: { runtime: "api", model: "claude-opus-5-5", protocol: "anthropic" } })
    expect(ofType("message.completed").map((m) => `${m.kind}:${m.text}`)).toEqual(["thinking:Plan: a cube.", "text:Here is your cube."])
    const done = ofType("run.completed")[0].result
    // 100 in × $4 + 1000 cache read × $0.20 + 20 out × $20 per MTok
    expect(done.usage).toMatchObject({ tokens: { input: 100, output: 20, cacheRead: 1000, cacheWrite: 0 }, billing: "api", final: true })
    expect(done.usage!.billedUsd).toBeCloseTo((100 * 4 + 1000 * 0.2 + 20 * 20) / 1e6, 10)
    expect(done).toMatchObject({ subtype: "success", isError: false, text: "Here is your cube.", turns: 1 })
    expect((await coord.getStatus(P)).costUsd).toBeCloseTo(done.usage!.billedUsd!, 10)
    // the conversation is kept by the app, Anthropic blocks verbatim (signature included)
    const stored = new ConversationStore(apiSessionPath(root, project.activeSessionId!)).load()
    expect(stored[1].native?.content).toEqual([{ type: "thinking", thinking: "Plan: a cube.", signature: "sig-0" }, { type: "text", text: "Here is your cube." }])
  })

  it("tool loop: streamed tool input, app identity (not the model's), results back in one user message, Claude-shaped timeline rows", async () => {
    fake.push(
      { sse: messageStream([{ text: "Looking." }, { tool: { id: "toolu_1", name: "list_parts", chunks: ['{"projectId"', ': "other"}'] } }]) },
      { sse: messageStream([{ text: "You have one part." }]) }
    )
    await turn("what parts?")
    expect(fake.calls).toHaveLength(2)
    const second = fake.calls[1]
    expect(second.messages[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "toolu_1", name: "list_parts", input: { projectId: "other" } }] })
    const r = results(second).toolu_1
    expect(r.is_error).toBeUndefined()
    expect(resultText(r)).toContain('"id": "main"') // this project, whatever the input said
    const started = ofType("tool.started")
    expect(started.map((t) => t.name)).toEqual(["mcp__studio__list_parts"])
    expect(started[0].input).toEqual({ projectId: "other" })
    expect(ofType("tool.completed")[0]).toMatchObject({ isError: false })
    expect(ofType("run.completed")[0].result).toMatchObject({ text: "You have one part.", turns: 2 })
    expect(persisted().every((e) => e.event.type !== "message.delta")).toBe(true)
  })

  it("gates hold: slice_part before approval is refused; the user's words approve; a write_file to a part withdraws it", async () => {
    fake.push({ sse: messageStream([{ tool: { id: "t1", name: "slice_part", input: { partId: "main" } } }]) }, { sse: messageStream([{ text: "Needs approval." }]) })
    await turn("make it")
    expect(results(fake.calls[1]).t1).toMatchObject({ is_error: true })
    expect(resultText(results(fake.calls[1]).t1)).toBe(`Error: ${APPROVAL_REFUSAL}`)
    expect(deps.slicePart).not.toHaveBeenCalled()
    fake.push(
      { sse: messageStream([{ tool: { id: "t2", name: "slice_part", input: { partId: "main" } } }]) },
      { sse: messageStream([{ tool: { id: "t3", name: "write_file", input: { path: "parts/main.scad", content: "cube(30);" } } }]) },
      { sse: messageStream([{ text: "Done." }]) }
    )
    await turn("looks right, print it")
    expect(results(fake.calls[3]).t2.is_error).toBeUndefined()
    expect(deps.slicePart).toHaveBeenCalled()
    expect(readFileSync(join(root, "parts", "main.scad"), "utf8")).toBe("cube(30);")
    expect(isApproved(P)).toBe(false) // the geometry changed
  })

  it("file tools: reads inside the project only (never app secrets); protected writes refused; edits exact; images come back as images", async () => {
    writeFileSync(join(home, "secrets.json"), '{"k":"sk-not-real"}')
    writeFileSync(join(root, "parts", "png.png"), Buffer.from("89504e470d0a1a0a", "hex"))
    const calls = [
      ["r1", "read_file", { path: "parts/main.scad" }],
      ["r2", "read_file", { path: join(home, "secrets.json") }],
      ["r3", "read_file", { path: "/etc/hosts" }],
      ["r4", "read_file", { path: "parts/png.png" }],
      ["w1", "write_file", { path: "parts/new.scad", content: "sphere(5);" }],
      ["w2", "write_file", { path: "build/plate.gcode", content: "G1" }],
      ["w3", "write_file", { path: "build/main.stl", content: "x" }],
      ["w4", "write_file", { path: ".studio/approval.json", content: "{}" }],
      ["w5", "write_file", { path: "project.json", content: "{}" }],
      ["w6", "write_file", { path: join(home, "evil.txt"), content: "x" }],
      ["w7", "write_file", { path: ".claude/settings.json", content: "{}" }],
      ["e1", "edit_file", { path: "parts/new.scad", old_string: "sphere(5)", new_string: "sphere(6)" }],
      ["e2", "edit_file", { path: "parts/new.scad", old_string: "nope", new_string: "x" }],
      ["l1", "list_files", {}],
    ] as const
    fake.push({ sse: messageStream(calls.map(([id, name, input]) => ({ tool: { id, name, input } }))) }, { sse: messageStream([{ text: "ok" }]) })
    await turn("files")
    const r = results(fake.calls[1])
    expect(resultText(r.r1)).toBe("cube(20);")
    for (const id of ["r2", "r3"]) expect(resultText(r[id])).toMatch(/^Error: Blocked by Crease: you can only read files in this project/)
    expect(r.r4.content[1]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png" } })
    expect(r.w1.is_error).toBeUndefined()
    expect(resultText(r.w2)).toMatch(/Blocked by Crease: G-code/)
    expect(resultText(r.w3)).toMatch(/Blocked by Crease: build\//)
    expect(resultText(r.w4)).toMatch(/Blocked by Crease: \.studio/)
    expect(resultText(r.w5)).toMatch(/Blocked by Crease: project\.json/)
    expect(resultText(r.w6)).toMatch(/Blocked by Crease: Writes are only allowed inside the project folder/)
    expect(resultText(r.w7)).toMatch(/Blocked by Crease/)
    for (const id of ["w2", "w3", "w4", "w5", "w6", "w7", "e2", "r2", "r3"]) expect(r[id].is_error).toBe(true)
    expect(existsSync(join(root, "build", "plate.gcode"))).toBe(false)
    expect(existsSync(join(home, "evil.txt"))).toBe(false)
    expect(readFileSync(join(root, "parts", "new.scad"), "utf8")).toBe("sphere(6);")
    expect(resultText(r.l1)).toContain("parts/main.scad")
    expect(resultText(r.l1)).not.toContain(".studio")
    // timeline rows use Claude's names
    expect(ofType("tool.started").slice(0, 5).map((t) => t.name)).toEqual(["Read", "Read", "Read", "Read", "Write"])
    expect(ofType("tool.started")[4].input).toEqual({ file_path: "parts/new.scad", content: "sphere(5);" })
  })

  it("schema failures go back to the model: invalid registry input, malformed JSON input, invalid AskUserQuestion", async () => {
    fake.push(
      {
        sse: messageStream([
          { tool: { id: "s1", name: "set_parameters", input: { nope: 1 } } },
          { tool: { id: "s2", name: "render_part", chunks: ['{"partId": "ma'] } },
          { tool: { id: "s3", name: "AskUserQuestion", input: { questions: [{ question: "?" }] } } },
          { tool: { id: "s4", name: "no_such_tool", input: {} } },
        ]),
      },
      { sse: messageStream([{ text: "Fixed." }]) }
    )
    await turn("go")
    const r = results(fake.calls[1])
    expect(resultText(r.s1)).toMatch(/^Error: Invalid input for set_parameters/)
    expect(JSON.parse(resultText(r.s2))).toEqual({ INVALID_JSON: '{"partId": "ma' })
    expect(resultText(r.s3)).toMatch(/^Error: Invalid input for AskUserQuestion/)
    expect(resultText(r.s4)).toBe("Error: Unknown tool no_such_tool.")
    for (const id of ["s1", "s2", "s3", "s4"]) expect(r[id].is_error).toBe(true)
    // the malformed call goes back as a valid (empty) object so the history stays sendable
    expect(fake.calls[1].messages[1].content[1]).toEqual({ type: "tool_use", id: "s2", name: "render_part", input: {} })
    expect(listQuestions(P)).toHaveLength(0)
  })

  it("retries with backoff on 529, 429 (retry-after) and an overloaded error mid-stream; one notice", async () => {
    fake.push(overloaded(), rateLimited("2"), overloadedMidStream(), { sse: messageStream([{ text: "Made it." }]) })
    await turn("hello")
    expect(fake.calls).toHaveLength(4)
    expect(slept).toHaveLength(3)
    expect(slept[1]).toBe(2000) // retry-after honoured
    expect(ofType("notice").filter((n) => n.code === "api.retry")).toHaveLength(1)
    expect(ofType("run.completed")[0].result.text).toBe("Made it.")
    // the broken attempt's partial text isn't kept anywhere
    expect(ofType("message.completed").map((m) => m.text)).toEqual(["Made it."])
    expect(fake.calls[3].messages).toHaveLength(1)
  })

  it("gives up after repeated failures: run.failed in plain words", async () => {
    for (let i = 0; i < 6; i++) fake.push(overloaded())
    await turn("hello")
    expect(fake.calls).toHaveLength(6)
    expect(ofType("run.failed")[0].error).toMatch(/kept failing after several tries/)
  })

  it("max_tokens: a cut-off tool call isn't run (the model is told why); a cut-off reply is continued", async () => {
    fake.push(
      { sse: messageStream([{ tool: { id: "m1", name: "write_file", chunks: ['{"path": "parts/a.scad", "content": "cube('] } }], { stop: "max_tokens" }) },
      { sse: messageStream([{ text: "Long answer cut" }], { stop: "max_tokens" }) },
      { sse: messageStream([{ text: "…finished." }]) }
    )
    await turn("big file")
    expect(resultText(results(fake.calls[1]).m1)).toMatch(/hit the output length limit/)
    expect(existsSync(join(root, "parts", "a.scad"))).toBe(false)
    const third = fake.calls[2].messages
    expect(third[third.length - 1].content[0].text).toMatch(/cut off at the length limit/)
    expect(ofType("run.completed")[0].result.text).toBe("…finished.")
  })

  it("questions: AskUserQuestion goes through the app's question cards; the answer comes back as the tool result", async () => {
    const q = { questions: [{ question: "How big?", header: "Size", multiSelect: false, options: [{ label: "Small (Recommended)", description: "5 cm" }, { label: "Big", description: "10 cm" }] }] }
    fake.push({ sse: messageStream([{ tool: { id: "q1", name: "AskUserQuestion", input: q } }]) }, { sse: messageStream([{ text: "Big it is." }]) })
    await send("make me a hook")
    await until(() => listQuestions(P).length === 1, "question")
    const asked = ofType("question.requested")[0]
    expect(asked.questions[0]).toMatchObject({ question: "How big?" })
    await coord.answerQuestion(P, asked.requestId, { "How big?": "Big" })
    await until(() => ends() === 1)
    expect(resultText(results(fake.calls[1]).q1)).toBe('User has answered your questions: "How big?"="Big". You can now continue with the user\'s answers in mind.')
  })

  it("interrupt: stop during a question ends the run (run.interrupted); unanswered calls are closed so the next turn is valid", async () => {
    const q = { questions: [{ question: "Size?", header: "Size", multiSelect: false, options: [{ label: "A", description: "" }, { label: "B", description: "" }] }] }
    fake.push({ sse: messageStream([{ tool: { id: "q1", name: "AskUserQuestion", input: q } }, { tool: { id: "q2", name: "list_parts", input: {} } }]) })
    await send("go")
    await until(() => listQuestions(P).length === 1)
    await coord.stop(P)
    await until(() => ofType("run.interrupted").length === 1, "run.interrupted")
    expect(listQuestions(P)).toHaveLength(0)
    expect((await coord.getStatus(P)).running).toBe(false)
    fake.push({ sse: messageStream([{ text: "Again." }]) })
    await turn("try again")
    const msgs = fake.calls[1].messages
    // assistant(q1,q2) -> user(results for both) -> user(new text)
    expect(msgs[1].content.map((b: any) => b.id)).toEqual(["q1", "q2"])
    expect(msgs[2].content.map((b: any) => [b.tool_use_id, b.is_error])).toEqual([
      ["q1", true],
      ["q2", true],
    ])
    expect(msgs[3]).toEqual({ role: "user", content: [{ type: "text", text: "try again" }] })
  })

  it("interrupt while the model is streaming: nothing half-written is kept", async () => {
    let release!: () => void
    fake.push(() => new Promise((r) => (release = () => r({ sse: messageStream([{ text: "late" }]) }))))
    await send("go")
    await until(() => fake.calls.length === 1)
    await coord.stop(P)
    await until(() => ofType("run.interrupted").length === 1)
    release()
    const stored = new ConversationStore(apiSessionPath(root, project.activeSessionId!)).load()
    expect(stored.map((m) => m.role)).toEqual(["user"])
  })

  it("budget stop: a run that passes its profile's budget is interrupted with a plain notice; its tool calls don't run", async () => {
    profile = snapshot({ budget: { maxUsdPerRun: 0.01 } })
    // 10k in × $4 + 1k out × $20 per MTok = $0.06
    fake.push({ sse: messageStream([{ tool: { id: "b1", name: "write_file", input: { path: "parts/x.scad", content: "cube(1);" } } }], { usage: { input_tokens: 10_000, output_tokens: 1000 } }) })
    await turn("expensive")
    const n = ofType("notice").find((x) => x.code === "budget.exceeded")
    expect(n?.text).toMatch(/reached its \$0\.01 budget/)
    expect(ofType("run.interrupted")).toHaveLength(1)
    expect(existsSync(join(root, "parts", "x.scad"))).toBe(false)
    expect(listFailures({ limit: 5 }).some((f) => f.kind === "budget" && f.runtime === "api")).toBe(true)
  })

  it("step limit: a run that keeps calling tools stops at maxTurns (error_max_turns, plain words)", async () => {
    maxTurns = 2
    for (let i = 0; i < 3; i++) fake.push({ sse: messageStream([{ tool: { id: `x${i}`, name: "list_parts", input: {} } }]) })
    await turn("loop")
    expect(fake.calls).toHaveLength(2)
    expect(ofType("run.completed")[0].result).toMatchObject({ subtype: "error_max_turns", isError: true, turns: 2 })
    expect(ofType("run.completed")[0].result.text).toMatch(/Stopped after 2 steps/)
  })

  it("trimming: a large history drops old tool output first and strips thinking; text, questions and the plan stay", async () => {
    apiDeps.trimAt = 3000
    const big = "x".repeat(8000)
    writeFileSync(join(root, "parts", "big.scad"), big)
    fake.push(
      { sse: messageStream([{ thinking: "hmm" }, { tool: { id: "p1", name: "share_plan", input: { title: "Hook", items: [] } } }]) },
      { sse: messageStream([{ tool: { id: "k1", name: "read_file", input: { path: "parts/big.scad" } } }]) },
      { sse: messageStream([{ tool: { id: "k2", name: "read_file", input: { path: "parts/big.scad" } } }]) },
      { sse: messageStream([{ tool: { id: "k3", name: "read_file", input: { path: "parts/big.scad" } } }]) },
      { sse: messageStream([{ text: "Read it all." }], { usage: { input_tokens: 5000 } }) }
    )
    await turn("first")
    fake.push({ sse: messageStream([{ text: "Second." }]) })
    await turn("second")
    const msgs = fake.calls[5].messages
    const all = JSON.stringify(msgs)
    expect(all).not.toContain('"thinking"')
    expect(all).toContain(TRIMMED_RESULT)
    expect(all).toContain('"first"')
    expect(all).toContain('"Read it all."')
    // the plan's call and result stay
    expect(msgs[1].content.find((b: any) => b.type === "tool_use").name).toBe("share_plan")
    expect(resultText(msgs[2].content[0])).not.toBe(TRIMMED_RESULT)
    // recent tool output stays
    expect(resultText(results({ messages: msgs.slice(0, 9) }).k3)).toBe(big)
    expect(ofType("notice").some((n) => n.code === "context.trimmed")).toBe(true)
  })

  it("resume: the next message after the session closed rebuilds the conversation from the store (earlier thinking dropped)", async () => {
    fake.push({ sse: messageStream([{ thinking: "deep" }, { text: "First answer." }]) })
    await turn("one")
    const sessionId = project.activeSessionId
    coord.closeSession(P)
    fake.push({ sse: messageStream([{ text: "Second answer." }]) })
    await turn("two")
    expect(project.activeSessionId).toBe(sessionId)
    expect(fake.calls[1].messages).toEqual([
      { role: "user", content: [{ type: "text", text: "one" }] },
      { role: "assistant", content: [{ type: "text", text: "First answer." }] },
      { role: "user", content: [{ type: "text", text: "two" }] },
    ])
  })

  it("fork: the new session starts from a copy of the conversation", async () => {
    fake.push({ sse: messageStream([{ text: "Original." }]) })
    await turn("one")
    const from = project.activeSessionId!
    const { sessionId } = await coord.fork(P, from)
    expect(sessionId).not.toBe(from)
    expect(new ConversationStore(apiSessionPath(root, sessionId)).load().map((m) => m.role)).toEqual(["user", "assistant"])
  })

  it("model switch: the next request uses the new model, earlier thinking dropped (bound to the old model)", async () => {
    fake.push({ sse: messageStream([{ thinking: "t" }, { text: "a" }]) })
    await turn("one")
    profile = snapshot({ model: "claude-haiku-4-5" })
    fake.push({ sse: messageStream([{ text: "b" }], { model: "claude-haiku-4-5" }) })
    await turn("two")
    expect(fake.calls[1].model).toBe("claude-haiku-4-5")
    expect(fake.calls[1].thinking).toBeUndefined() // no adaptive thinking on Haiku 4.5
    expect(JSON.stringify(fake.calls[1].messages)).not.toContain('"thinking"')
  })

  it("auth: a refused key fails the run with a sign-in notice (failure log) in plain words", async () => {
    fake.key = "other-key"
    await turn("hello")
    expect(ofType("notice").find((n) => n.code === "api.auth")?.text).toMatch(/refused the API key/)
    expect(ofType("run.failed")[0].error).toMatch(/refused the API key/)
    expect(listFailures({ limit: 5 }).some((f) => f.kind === "auth" && f.runtime === "api")).toBe(true)
  })

  it("images: an attached photo goes to the model as an image block", async () => {
    fake.push({ sse: messageStream([{ text: "Nice photo." }]) })
    await turn("this one", [{ mediaType: "image/png", data: "iVBORw0KGgo=" }])
    expect(fake.calls[0].messages[0].content).toEqual([
      { type: "text", text: "this one" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
    ])
  })

  it("read_skill: lists the bundled skills and reads one", async () => {
    fake.push({ sse: messageStream([{ tool: { id: "k1", name: "read_skill", input: {} } }, { tool: { id: "k2", name: "read_skill", input: { name: "print-finish" } } }]) }, { sse: messageStream([{ text: "ok" }]) })
    await turn("skills")
    const r = results(fake.calls[1])
    expect(resultText(r.k1)).toMatch(/- printable-openscad: /)
    expect(resultText(r.k2)).toContain("# Print finish")
  })

  it("a message sent during a reply joins the turn: the model answers it before the turn ends", async () => {
    let release!: () => void
    fake.push(() => new Promise((r) => (release = () => r({ sse: messageStream([{ text: "first" }]) }))), { sse: messageStream([{ text: "second" }]) })
    await send("one")
    await until(() => fake.calls.length === 1)
    await coord.sendMessage(P, "two", [], [], "two")
    release()
    await until(() => ends() === 1, "the run")
    expect(fake.calls[1].messages.map((m: any) => m.role)).toEqual(["user", "assistant", "user"])
    expect(fake.calls[1].messages[2].content[0].text).toBe("(New message from the user, sent while you were working:)\ntwo")
    expect(ofType("run.completed").map((r) => r.result.text)).toEqual(["second"])
    expect(ofType("input.status")).toEqual([{ type: "input.status", status: "received" }])
    expect((await coord.getStatus(P)).running).toBe(false)
  })

  it("a message sent during a tool call goes to the model with the tool results", async () => {
    let release!: () => void
    fake.push(
      () => new Promise((r) => (release = () => r({ sse: messageStream([{ tool: { id: "t1", name: "list_parts", input: {} } }]) }))),
      { sse: messageStream([{ text: "Changed course." }]) },
    )
    await send("one")
    await until(() => fake.calls.length === 1)
    await coord.sendMessage(P, "make it round", [{ mediaType: "image/png", data: "iVBORw0KGgo=" }], [], "make it round")
    release()
    await until(() => ends() === 1, "the run")
    const last = fake.calls[1].messages.at(-1)
    expect(last.content.map((c: any) => c.type)).toEqual(["tool_result", "text", "image"])
    expect(last.content[1].text).toContain("make it round")
    expect(ofType("input.status")).toHaveLength(1)
  })

  it("never talks to a printer: an endpoint on a printer's address is refused before any request", async () => {
    profile = snapshot({ endpointRef: "http://10.0.0.24:7125" })
    await expect(coord.sendMessage(P, "hi", [], [], "hi")).rejects.toThrow(API_PRINTER_ENDPOINT)
    expect(fake.requests).toHaveLength(0)
  })
})

describe("API runtime: Agents screen calls", () => {
  it("probe: built in, ready, suggested models, efforts", async () => {
    const p = await runtime.probe()
    expect(p).toMatchObject({ runtime: "api", installed: true, ready: true, defaultModel: "claude-opus-5-5", capabilities: { appTools: true, permissionRequests: false, resume: true, fork: true, usage: "reported" } })
    expect(p.effortLevels).toContain("xhigh")
  })

  it("Test connection lists the endpoint's models (free) and checks the model; a bad key is a plain refusal; no key is caught first", async () => {
    const ok = await runtime.checkConnection(snapshot())
    expect(ok.ok).toBe(true)
    expect(ok.models?.map((m) => m.value)).toEqual(["claude-opus-5-5", "claude-haiku-4-5"])
    expect(ok.steps.map((s) => s.label)).toEqual(["API key saved", "API key accepted", "Model claude-opus-5-5"])
    expect(fake.calls).toHaveLength(0) // no model call
    fake.key = "different"
    const bad = await runtime.checkConnection(snapshot())
    expect(bad.ok).toBe(false)
    expect(bad.summary).toMatch(/Replace the key/)
    const none = await runtime.checkConnection(snapshot({ auth: { kind: "api-key", credentialRef: "profile.none.apiKey" } }))
    expect(none.summary).toBe(API_NO_KEY)
    expect((await runtime.listModels(snapshot())).error).toBe("The key was refused.")
  })

  it("Send a test message: one tiny call with no tools; reports the reply and its cost", async () => {
    fake.push({ sse: messageStream([{ text: "Ready to design." }], { model: "claude-haiku-4-5", usage: { input_tokens: 30, output_tokens: 5 } }) })
    const r = await runtime.testMessage(snapshot({ model: "claude-haiku-4-5" }))
    expect(r).toMatchObject({ ok: true, reply: "Ready to design." })
    expect(r.costUsd).toBeCloseTo((30 * 1 + 5 * 5) / 1e6, 12)
    expect(fake.calls[0].tools).toEqual([])
  })

  it("eager input streaming is on for the first-party API only", () => {
    const req = { model: "claude-opus-5-5", system: "s", tools: [{ name: "t", description: "d", inputSchema: { type: "object", properties: {} } }], messages: [], maxTokens: 10 }
    expect(new AnthropicEndpoint({ apiKey: "k" }).params(req).tools![0]).toMatchObject({ eager_input_streaming: true })
    expect((new AnthropicEndpoint({ apiKey: "k", baseUrl: "http://127.0.0.1:1" }).params(req).tools![0] as any).eager_input_streaming).toBeUndefined()
    expect(new AnthropicEndpoint({ apiKey: "k" }).params({ ...req, effort: "high" }).output_config).toEqual({ effort: "high" })
    expect(new AnthropicEndpoint({ apiKey: "k" }).params({ ...req, model: "claude-haiku-4-5", effort: "high" }).output_config).toBeUndefined()
  })
})
