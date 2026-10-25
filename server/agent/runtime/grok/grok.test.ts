// Grok runtime (R11e) conformance: the real session coordinator + the real Grok adapter over a scripted ACP agent
// (FakeGrokAgent), the real MCP bridge (HTTP on 127.0.0.1) and the app-run shell. Covers the coordinator.test.ts /
// codex.test.ts scenarios through ACP: runs, streaming, app tools with app identity and their gates, questions,
// permission policy, app-performed writes and reads, terminals, interrupt, failure, duplicates, queued turns, resume
// and fork by native id, sign-in errors, and the isolation config. No Grok, no tokens.
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentEvent, AgentEventEnvelope, Project } from "../../../../shared/types"
/* eslint-disable @typescript-eslint/no-explicit-any */

const home = mkdtempSync(join(tmpdir(), "printstudio-grok-test-"))
process.env.PRINTSTUDIO_HOME = home

const { SessionCoordinator } = await import("../../coordinator")
const { deps } = await import("../../deps")
const { APPROVAL_REFUSAL, setApproved, isApproved } = await import("../../approval")
const { ToolRegistry, STUDIO_TOOLS } = await import("../../registry")
const { readEvents, nativeRef } = await import("../../transcript")
const { listQuestions } = await import("../../questions")
const { GrokAdapter, GrokRuntime, GROK_AUTH_MESSAGE, GROK_OUTDATED_MESSAGE, parseModels, grokProtectedReason } = await import("./adapter")
const { grokConfigToml, grokSandboxToml, grokEnv, grokHooksJson, linkRuntimeSockets, GROK_BLOCKED_TOOLS, BLOCKED_TOOL_REASON } = await import("./config")
const { GrokNormalizer } = await import("./normalize")
const { shellProfile, shellEnv, sandboxAvailable, Terminals } = await import("./shell")
const { FakeGrokAgent } = await import("./testing")
type Agent = InstanceType<typeof FakeGrokAgent>

afterAll(() => rmSync(home, { recursive: true, force: true }))

const P = "grok-test"
let root = ""
let project: Project
let agents: Agent[] = []
let runtime: InstanceType<typeof GrokRuntime>
let coord: InstanceType<typeof SessionCoordinator>
let runOut = ""
const realDeps = { ...deps }
const grokHome = join(home, "grok")

const last = () => agents[agents.length - 1]
const persisted = () => readEvents(P, project.activeSessionId!)
const types = (envs: AgentEventEnvelope[]) => envs.map((e) => e.event.type)
const tick = () => new Promise((r) => setTimeout(r, 5))
async function until(cond: () => boolean, what = "condition") {
  for (let i = 0; i < 600; i++) {
    if (cond()) return
    await tick()
  }
  throw new Error(`timed out waiting for ${what}`)
}
const ofType = <T extends AgentEvent["type"]>(t: T) => persisted().filter((e) => e.event.type === t).map((e) => e.event as Extract<AgentEvent, { type: T }>)

function makeRuntime(onSpawn?: (a: Agent) => void) {
  return new GrokRuntime({
    findBinary: () => "/fake/grok",
    spawn: (o) => {
      const a = new FakeGrokAgent(o.args, o.env)
      onSpawn?.(a)
      agents.push(a)
      return a
    },
    home: () => grokHome,
    secret: (ref) => (ref === "profile.k.apiKey" ? "xai-test-key-0000000000" : null),
    run: async (_bin, args) => ({ code: 0, out: args[0] === "--version" ? "grok 1.0.5 (abc) [stable]" : runOut }),
    sandbox: () => true,
    // commands run without sandbox-exec in tests (the profile itself is tested below)
    spawner: (argv, o) => spawn(argv[0], argv.slice(1), { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"], detached: true }),
  })
}

/** The bridge's URL + token from session/new (or session/resume). */
function bridgeOf(a: Agent) {
  const p = (a.requests("session/new")[0] ?? a.requests("session/resume")[0]).params as any
  const s = p.mcpServers[0]
  return { url: s.url as string, auth: s.headers[0].value as string }
}
async function mcp(a: Agent, method: string, params: unknown = {}, auth?: string) {
  const b = bridgeOf(a)
  const r = await fetch(b.url, { method: "POST", headers: { authorization: auth ?? b.auth, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
  return { status: r.status, body: r.status === 200 ? ((await r.json()) as any) : null }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "grok-proj-"))
  mkdirSync(join(root, "parts"), { recursive: true })
  mkdirSync(join(root, "build"), { recursive: true })
  writeFileSync(join(root, "parts", "main.scad"), "cube(20);")
  project = {
    id: P,
    name: "Grok",
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
  agents = []
  runOut = "Default model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n"
  runtime = makeRuntime()
  coord = new SessionCoordinator({
    runtimes: [runtime],
    tools: new ToolRegistry(STUDIO_TOOLS),
    prepare: async () => ({ instructions: "brief", policy: { denyRead: [join(home, "secrets.json")] }, model: "grok-4.5", notices: [] }),
  })
})
afterEach(() => {
  coord.dispose()
  Object.assign(deps, realDeps)
  setApproved(P, false)
  rmSync(root, { recursive: true, force: true })
})

async function send(text: string, n = 1) {
  const r = await coord.sendMessage(P, text, [], [], text)
  await until(() => last()?.requests("session/prompt").length >= n, "session/prompt")
  return r
}

describe("Grok adapter through the session coordinator", () => {
  it("starts a session: isolated env + config, client fs/terminal capabilities, MCP bridge, rules; maps app id -> session id", async () => {
    const { sessionId } = await send("make a cube")
    const a = last()
    expect(a.args).toEqual(["agent", "--no-leader", "stdio"])
    expect(a.env).toMatchObject({ GROK_HOME: grokHome, HOME: join(grokHome, "home"), GROK_SANDBOX: "printstudio", GROK_SUBAGENTS: "0", GROK_WEB_FETCH: "0", GROK_MEMORY: "0" })
    expect(a.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(a.env.XAI_API_KEY).toBeUndefined()
    expect(a.received.every((m) => m.jsonrpc === "2.0")).toBe(true)
    expect((a.requests("initialize")[0].params as any).clientCapabilities).toEqual({ fs: { readTextFile: true, writeTextFile: true }, terminal: true })
    const nw = a.requests("session/new")[0].params as any
    expect(nw.cwd).toBe(root)
    expect(nw._meta.rules).toContain("brief")
    expect(nw._meta.rules).toContain("studio__")
    expect(nw.mcpServers[0]).toMatchObject({ type: "http", name: "studio", url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/) })
    expect(nw.mcpServers[0].headers[0]).toMatchObject({ name: "Authorization", value: expect.stringMatching(/^Bearer [0-9a-f]{48}$/) })
    // the project's model (a Grok model) is switched to
    expect(a.requests("session/set_model")[0].params).toEqual({ sessionId: a.sessionId, modelId: "grok-4.5" })
    const cfg = readFileSync(join(grokHome, "config.toml"), "utf8")
    expect(cfg).toContain("[compat.claude]\nskills = false")
    expect(cfg).toContain(`Read(${join(home, "secrets.json")})`)
    expect(cfg).toContain(`Read(${join(grokHome, "auth.json")})`)
    expect(readFileSync(join(grokHome, "sandbox.toml"), "utf8")).toContain('extends = "strict"')
    expect(JSON.parse(readFileSync(join(grokHome, "hooks", "printstudio.json"), "utf8")).hooks.PreToolUse[0].matcher).toContain("scheduler_create")
    expect(existsSync(join(grokHome, "home"))).toBe(true)
    expect(nativeRef(P, sessionId!)).toEqual({ runtime: "grok", nativeId: a.sessionId })
    expect(project.sessions.find((x) => x.id === sessionId)?.runtime).toBe("grok")
  })

  it("streams a run: deltas live, blocks, app tools over MCP with app identity, usage tokens (no money), run.completed", async () => {
    await send("make a cube")
    const a = last()
    a.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking" } })
    a.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } })
    a.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } })
    a.update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "use_tool", rawInput: { tool_name: "studio__list_parts", tool_input: { projectId: "other" } }, _meta: { "x.ai/tool": { name: "use_tool" } } })
    const tools = await mcp(a, "tools/list")
    expect(tools.body.result.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(["list_parts", "render_part", "slice_part", "request_print", "view_image"]))
    expect(tools.body.result.tools.find((t: any) => t.name === "slice_part").inputSchema.$schema).toBeUndefined()
    expect((await mcp(a, "tools/list", {}, "Bearer wrong")).status).toBe(401)
    const call = await mcp(a, "tools/call", { name: "list_parts", arguments: { projectId: "other" } })
    expect(call.body.result.content[0].text).toContain('"id": "main"') // this project, whatever the input said
    a.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", rawOutput: { type: "MCP", tool_name: "list_parts", server_name: "studio", output: { OkayOutput: call.body.result.content[0].text } } })
    a.update({ sessionUpdate: "tool_call", toolCallId: "c2", title: "run_terminal_command", rawInput: { command: "ls", description: "list" }, _meta: { "x.ai/tool": { name: "run_terminal_command" } } })
    a.update({ sessionUpdate: "tool_call_update", toolCallId: "c2", status: "completed", content: [{ type: "content", content: { type: "text", text: "parts\n" } }] })
    a.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } })
    a.endPrompt()
    await until(() => ofType("run.completed").length === 1, "run.completed")
    const ev = persisted()
    expect(types(ev)).toEqual(["notice", "run.started", "message.completed", "message.completed", "tool.started", "tool.completed", "tool.started", "tool.completed", "message.completed", "run.completed"])
    expect(ev.every((e) => e.event.type !== "message.delta")).toBe(true)
    expect(ofType("tool.started").map((t) => t.name)).toEqual(["mcp__studio__list_parts", "Bash"])
    expect(ofType("message.completed").map((m) => `${m.kind}:${m.text}`)).toEqual(["thinking:Thinking", "text:Hello", "text:Done."])
    const done = ofType("run.completed")[0].result
    // ACP inputTokens includes cache; the app's input is the uncached part
    expect(done.usage).toMatchObject({ tokens: { input: 100, output: 7, cacheRead: 40, cacheWrite: 10 }, billedUsd: null, estimatedApiUsd: null, billing: "plan", final: true })
    expect(done.turns).toBe(2)
    expect((await coord.getStatus(P)).running).toBe(false)
  })

  it("gates hold through MCP: slice_part before approval is refused; the user's words approve; an app write withdraws it", async () => {
    await send("make a cube")
    const a = last()
    const r1 = await mcp(a, "tools/call", { name: "slice_part", arguments: { partId: "main" } })
    expect(r1.body.result).toMatchObject({ isError: true, content: [{ type: "text", text: `Error: ${APPROVAL_REFUSAL}` }] })
    expect(deps.slicePart).not.toHaveBeenCalled()
    a.endPrompt()
    await until(() => ofType("run.completed").length === 1)
    await coord.sendMessage(P, "looks right, print it", [], [], "looks right, print it")
    await until(() => a.requests("session/prompt").length === 2)
    const r2 = await mcp(a, "tools/call", { name: "slice_part", arguments: { partId: "main" } })
    expect(r2.body.result.isError).toBe(false)
    // Grok's write (performed by the app) to a part withdraws the approval (geometry changed)
    const w = await a.request("fs/write_text_file", { path: join(root, "parts", "main.scad"), content: "cube(30);" })
    expect(w.error).toBeUndefined()
    expect(readFileSync(join(root, "parts", "main.scad"), "utf8")).toBe("cube(30);")
    await until(() => !isApproved(P), "approval withdrawn")
  })

  it("questions: _x.ai/ask_user_question goes through the app's question cards", async () => {
    await send("make me a hook")
    const a = last()
    a.update({ sessionUpdate: "tool_call", toolCallId: "q1", title: "ask_user_question", rawInput: { questions: [] }, _meta: { "x.ai/tool": { name: "ask_user_question" } } })
    const asked = a.request("_x.ai/ask_user_question", {
      toolCallId: "q1",
      questions: [{ question: "How big?", options: [{ label: "Small (Recommended)", description: "5 cm" }, { label: "Big", description: "10 cm" }], multiSelect: null }],
      mode: "default",
    })
    await until(() => listQuestions(P).length === 1, "question")
    const q = ofType("question.requested")[0]
    expect(q.questions[0]).toMatchObject({ question: "How big?" })
    await coord.answerQuestion(P, q.requestId, { "How big?": "Big" })
    expect((await asked).result).toEqual({ outcome: "accepted", answers: { "How big?": "Big" }, annotations: {} })
  })

  it("permission policy: app tools, edits and commands allowed once; other MCP servers and unknown tools refused; never 'always'", async () => {
    await send("go")
    const a = last()
    const opts = [
      { optionId: "allow-edits-session", kind: "allow_always" },
      { optionId: "allow-once", kind: "allow_once" },
      { optionId: "reject-once", kind: "reject_once" },
    ]
    const ask = async (name: string, rawInput: Record<string, unknown>) =>
      ((await a.request("session/request_permission", { toolCall: { toolCallId: "x", rawInput, _meta: { "x.ai/tool": { name } } }, options: opts })).result as any).outcome.optionId
    expect(await ask("use_tool", { tool_name: "studio__render_part" })).toBe("allow-once")
    expect(await ask("use_tool", { tool_name: "other__thing" })).toBe("reject-once")
    expect(await ask("write", { file_path: "parts/a.scad" })).toBe("allow-once")
    expect(await ask("search_replace", { file_path: "build/x.stl" })).toBe("allow-once") // refused when written (fs)
    expect(await ask("run_terminal_command", { command: "curl http://10.0.0.24" })).toBe("allow-once") // runs sandboxed
    // read-only tools on a path Grok's own sandbox denies: allowed, so only that call fails (a refusal ends the turn)
    expect(await ask("grep", { pattern: "iron", path: "build/plate.gcode" })).toBe("allow-once")
    expect(await ask("read_file", { target_file: "build/plate.gcode" })).toBe("allow-once")
    expect(await ask("spawn_subagent", { prompt: "x" })).toBe("reject-once")
    expect(await ask("web_fetch", { url: "http://10.0.0.24" })).toBe("reject-once")
    expect(await ask("image_gen", { prompt: "x" })).toBe("reject-once")
  })

  it("files: the app performs writes and reads, refusing app-owned paths, G-code, outside paths and secrets", async () => {
    writeFileSync(join(home, "secrets.json"), '{"k":"sk-not-real"}')
    await send("go")
    const a = last()
    const write = async (path: string) => (await a.request("fs/write_text_file", { path, content: "x" })).error?.message ?? "ok"
    expect(await write(join(root, "parts", "new.scad"))).toBe("ok")
    expect(await write("parts/rel.scad")).toBe("ok")
    expect(await write(join(root, "build", "plate.gcode"))).toMatch(/Blocked by Crease: G-code/)
    expect(await write(join(root, "build", "main.stl"))).toMatch(/Blocked by Crease: build\//)
    expect(await write(join(root, ".claude", "settings.json"))).toMatch(/Blocked/)
    expect(await write(join(root, ".grok", "config.toml"))).toMatch(/Blocked/)
    expect(await write(join(root, "AGENTS.md"))).toMatch(/Blocked/)
    expect(await write(join(root, "project.json"))).toMatch(/Blocked/)
    expect(await write(join(home, "evil.txt"))).toMatch(/Blocked.*outside/)
    expect(existsSync(join(root, "parts", "rel.scad"))).toBe(true)
    const read = async (path: string, extra = {}) => {
      const r = await a.request("fs/read_text_file", { path, ...extra })
      return r.error ? `ERR ${r.error.message}` : (r.result as any).content
    }
    expect(await read(join(root, "parts", "main.scad"))).toBe("cube(20);")
    expect(await read(join(home, "secrets.json"))).toMatch(/^ERR Blocked/)
    expect(await read("/etc/hosts")).toMatch(/^ERR Blocked/)
    writeFileSync(join(root, "parts", "multi.scad"), "a\nb\nc\nd")
    expect(await read(join(root, "parts", "multi.scad"), { line: 2, limit: 2 })).toBe("b\nc")
  })

  it("terminals: commands run through the app (cwd inside the project), output and exit codes come back; stop kills them", async () => {
    await send("go")
    const a = last()
    const c = await a.request("terminal/create", { command: "/bin/bash -lc 'echo hi; exit 3'", cwd: root, env: [{ name: "XAI_API_KEY", value: "leak" }, { name: "FOO", value: "1" }] })
    const id = (c.result as any).terminalId
    expect((await a.request("terminal/wait_for_exit", { terminalId: id })).result).toEqual({ exitCode: 3, signal: null })
    expect((await a.request("terminal/output", { terminalId: id })).result).toMatchObject({ output: "hi\n", truncated: false, exitStatus: { exitCode: 3 } })
    const env = await a.request("terminal/create", { command: "env", cwd: root, env: [{ name: "XAI_API_KEY", value: "leak" }, { name: "FOO", value: "1" }] })
    await a.request("terminal/wait_for_exit", { terminalId: (env.result as any).terminalId })
    const out = ((await a.request("terminal/output", { terminalId: (env.result as any).terminalId })).result as any).output
    expect(out).toContain("FOO=1")
    expect(out).not.toContain("leak")
    expect((await a.request("terminal/create", { command: "ls", cwd: "/etc" })).error?.message).toMatch(/inside the project/)
    const long = await a.request("terminal/create", { command: "sleep 30", cwd: root })
    const waiting = a.request("terminal/wait_for_exit", { terminalId: (long.result as any).terminalId })
    await coord.stop(P)
    expect(((await waiting).result as any).signal).toBe("SIGTERM")
    await until(() => ofType("run.interrupted").length === 1, "run.interrupted")
  })

  it("interrupt: stop sends session/cancel, pending questions are refused, the run ends as run.interrupted", async () => {
    await send("make a cube")
    const a = last()
    const asked = a.request("_x.ai/ask_user_question", { toolCallId: "q1", questions: [{ question: "Size?", options: [{ label: "A", description: "" }, { label: "B", description: "" }] }] })
    await until(() => listQuestions(P).length === 1)
    await coord.stop(P)
    expect(a.notifications("session/cancel")[0].params).toEqual({ sessionId: a.sessionId })
    expect((await asked).result).toEqual({ outcome: "cancelled" })
    await until(() => ofType("run.interrupted").length === 1, "run.interrupted")
    expect((await coord.getStatus(P)).running).toBe(false)
  })

  it("failure: a failed prompt is run.failed; the agent dying fails the run; the next message resumes the same session", async () => {
    await send("make a cube")
    const a = last()
    a.failPrompt("Internal error: boom")
    await until(() => ofType("run.failed").length === 1)
    expect(ofType("run.failed")[0].error).toContain("boom")
    await coord.sendMessage(P, "again", [], [], "again")
    await until(() => a.requests("session/prompt").length === 2)
    a.die("Grok stopped unexpectedly (exit 1).")
    await until(() => ofType("run.failed").length === 2)
    expect(ofType("run.failed")[1].error).toContain("Grok stopped unexpectedly")
    await send("try again")
    expect(last()).not.toBe(a)
    expect(last().requests("session/resume")[0].params).toMatchObject({ sessionId: a.sessionId, cwd: root })
    expect(last().requests("session/new")).toHaveLength(0)
  })

  it("failure reason: the agent's own error replaces 'Internal error'; an outdated Grok says to update it (parity run 2026-10-11)", async () => {
    await send("make a cube")
    const a = last()
    const outdated = "API error (status 426 Upgrade Required): Your Grok CLI version (1.0.5) is outdated. Please update to version 1.0.13 or later via `grok update`."
    a.notify("_x.ai/session_notification", { sessionId: a.sessionId, update: { sessionUpdate: "retry_state", type: "failed", error_type: "api", message: outdated } })
    a.notify("_x.ai/session/prompt_complete", { sessionId: a.sessionId, stopReason: "error", agentResult: outdated })
    a.failPrompt("Internal error")
    await until(() => ofType("run.failed").length === 1)
    expect(ofType("run.failed")[0].error).toBe(GROK_OUTDATED_MESSAGE)
    expect(ofType("notice").some((n) => n.code === "grok.outdated" && n.level === "error")).toBe(true)
    // a turn that ends normally with stopReason "error" is a failure too, with the agent's reason
    await coord.sendMessage(P, "again", [], [], "again")
    await until(() => a.requests("session/prompt").length === 2)
    a.notify("_x.ai/session/prompt_complete", { sessionId: a.sessionId, stopReason: "error", agentResult: "API error (status 503 Service Unavailable): overloaded" })
    a.endPrompt("error")
    await until(() => ofType("run.failed").length === 2)
    expect(ofType("run.failed")[1].error).toBe("xAI answered 503: overloaded")
    expect(ofType("run.completed")).toHaveLength(0)
  })

  it("duplicates: the same tool completion twice is persisted once", async () => {
    await send("make a cube")
    const a = last()
    a.update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "read_file", rawInput: { target_file: "parts/main.scad" }, _meta: { "x.ai/tool": { name: "read_file" } } })
    const done = { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", content: [{ type: "content", content: { type: "text", text: "cube(20);" } }] }
    a.update(done)
    a.update(done)
    a.endPrompt()
    await until(() => ofType("run.completed").length === 1)
    expect(ofType("tool.completed")).toHaveLength(1)
    expect(ofType("tool.started")[0]).toMatchObject({ name: "Read", input: { file_path: "parts/main.scad" } })
  })

  it("queued turns: messages during a turn wait, then all go in the next prompt", async () => {
    await send("one")
    const a = last()
    await coord.sendMessage(P, "two", [], [], "two")
    await coord.sendMessage(P, "three", [], [], "three")
    await tick()
    expect(a.requests("session/prompt")).toHaveLength(1)
    expect(ofType("run.started").map((r) => r.queued ?? false)).toEqual([false, true, true])
    a.endPrompt()
    await until(() => a.requests("session/prompt").length === 2, "second turn")
    // they say they waited, so the model treats them as corrections to the turn that just ended
    expect((a.requests("session/prompt")[1].params as any).prompt.map((p: any) => p.text)).toEqual([`${GrokAdapter.WHILE_BUSY}\n\ntwo`, "three"])
    await until(() => ofType("input.status").length === 2)
    a.endPrompt()
    await until(() => ofType("run.completed").length === 2)
    expect((await coord.getStatus(P)).running).toBe(false)
  })

  it("images: attached images are saved in the project and shown with view_image (ACP prompts take none)", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    await coord.sendMessage(P, "like this", [{ mediaType: "image/png", data: png }], [], "like this")
    await until(() => last()?.requests("session/prompt").length === 1)
    const a = last()
    const text = (a.requests("session/prompt")[0].params as any).prompt[0].text as string
    const path = /(\.studio\/agent-images\/[0-9a-f]+\.png)/.exec(text)?.[1]
    expect(path).toBeTruthy()
    expect(text).toContain("studio__view_image")
    const v = await mcp(a, "tools/call", { name: "view_image", arguments: { path } })
    expect(v.body.result.content[1]).toEqual({ type: "image", data: png, mimeType: "image/png" })
    expect((await mcp(a, "tools/call", { name: "view_image", arguments: { path: "/etc/hosts" } })).body.result.isError).toBe(true)
  })

  it("sign-in: a signed-out Grok is a plain error with the sign-in fix; probe and test connection say so without a model call", async () => {
    agents = []
    const rt = makeRuntime((a) => (a.handlers["session/new"] = () => Promise.reject(Object.assign(new Error("Authentication required"), { code: -32000, data: "no auth method id provided" }))))
    const c = new SessionCoordinator({ runtimes: [rt], tools: new ToolRegistry(STUDIO_TOOLS), prepare: async () => ({ instructions: "b", policy: {}, model: null, notices: [] }) })
    await expect(c.sendMessage(P, "hi", [], [], "hi")).rejects.toThrow(GROK_AUTH_MESSAGE)
    c.dispose()
    runOut = "You are not authenticated.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n"
    const probe = await rt.probe()
    expect(probe).toMatchObject({ runtime: "grok", installed: true, version: "1.0.5", auth: { status: "missing" }, ready: false, login: { fix: { kind: "grok-login" } } })
    expect(probe.capabilities).toMatchObject({ appTools: true, userQuestions: true, permissionRequests: true, resume: true, fork: true, modelSwitch: true, usage: "tokens", isolation: { level: "full" } })
    const profile = { profileId: null, name: "Grok", runtime: "grok", model: null, auth: { kind: "subscription" as const }, endpointRef: null, binaryPath: null, effort: null, budget: { maxUsdPerRun: null }, policy: "design-sandbox" as const, source: "default" as const, frozenAt: "" }
    const check = await rt.checkConnection(profile)
    expect(check).toMatchObject({ ok: false, fix: { kind: "grok-login" } })
  })

  it("API-key profiles: the key goes only into the agent's environment (own Grok home), never into config files", async () => {
    agents = []
    const rt = makeRuntime()
    const c = new SessionCoordinator({ runtimes: [rt], tools: new ToolRegistry(STUDIO_TOOLS), prepare: async () => ({ instructions: "b", policy: {}, model: null, notices: [] }) })
    const ad = rt.create({ emit: () => {}, native: () => {}, askUser: async () => ({ answered: false, message: "" }), askPermission: async () => ({ allow: false }), nativeToolAllowed: () => {}, nativeSessionChanged: () => {}, ended: () => {} })
    await ad.start({
      projectId: P,
      sessionId: "s",
      cwd: root,
      resume: null,
      instructions: "b",
      tools: new ToolRegistry(STUDIO_TOOLS).bind(() => ({ projectId: P, sessionId: "s", runId: null }) as any),
      policy: {},
      priorCostUsd: 0,
      profile: { profileId: "k", name: "Grok key", runtime: "grok", model: null, auth: { kind: "api-key", credentialRef: "profile.k.apiKey" }, endpointRef: null, binaryPath: null, effort: "low", budget: { maxUsdPerRun: null }, policy: "design-sandbox", source: "default", frozenAt: "" },
    })
    expect(last().env.XAI_API_KEY).toBe("xai-test-key-0000000000")
    expect(last().args).toEqual(["agent", "--no-leader", "--reasoning-effort", "low", "stdio"])
    expect(readFileSync(join(grokHome, "config.toml"), "utf8")).not.toContain("xai-test-key")
    ad.close()
    c.dispose()
  })

  it("fork: _x.ai/session/fork on the session that holds the conversation; the new app session maps to the fork", async () => {
    const { sessionId } = await send("make a cube")
    const a = last()
    a.endPrompt()
    await until(() => ofType("run.completed").length === 1)
    const { sessionId: forked } = await coord.fork(P, sessionId!, "idea 2")
    expect(nativeRef(P, forked)).toEqual({ runtime: "grok", nativeId: `${a.sessionId}-fork` })
    expect(last().requests("_x.ai/session/fork")[0].params).toEqual({ sourceSessionId: a.sessionId, sourceCwd: root, newCwd: root })
  })
})

describe("recorded protocol fixture", () => {
  it("normalizes the recorded boundary turn (real Grok 1.0.5, scripted model): Claude-shaped rows, every escape an error", () => {
    const n = new GrokNormalizer()
    n.startTurn("t")
    const lines = readFileSync(fileURLToPath(new URL("./fixtures/boundary-turn.jsonl", import.meta.url)), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    const out = lines.filter((l) => l.msg.method === "session/update").flatMap((l) => n.convert(l.msg.params.update))
    const rows = new Map<string, { name: string; input: any; isError?: boolean; text?: string }>()
    for (const o of out) {
      if (o.event.type === "tool.started") rows.set(o.itemId!, { name: o.event.name, input: o.event.input })
      if (o.event.type === "tool.completed") Object.assign(rows.get(o.itemId!)!, { isError: o.event.isError, text: o.event.text })
    }
    const all = [...rows.values()]
    expect(all.map((r) => r.name)).toEqual([...Array(8).fill("Bash"), "Write", "Write", "Write", "Write", "Write", "Edit", "Read", "Grep", "web_fetch", "spawn_subagent", "scheduler_create", "image_gen", "workflow", "mcp__studio__printer_ping", "Read", "Bash", "Write", "mcp__other__thing"])
    // the 8 boundary-crossing commands and the blocked writes/edit/read all failed; the allowed steps worked
    expect(all.slice(0, 15).every((r) => r.isError)).toBe(true)
    // tools that never ask permission are denied by the app's PreToolUse hook: a tool error, and the turn goes on
    for (const name of ["scheduler_create", "image_gen"]) expect(all.find((r) => r.name === name)).toMatchObject({ isError: true, text: expect.stringContaining("Hook denied: Blocked by Crease") })
    expect(all.find((r) => r.name === "workflow")).toMatchObject({ isError: true, text: expect.stringContaining("Tool not found") }) // GROK_WORKFLOWS=0
    expect(all.find((r) => r.name === "mcp__studio__printer_ping")).toMatchObject({ isError: false, text: expect.stringContaining("pong") })
    expect(all.at(-3)).toMatchObject({ name: "Bash", isError: false })
    expect(all.at(-2)).toMatchObject({ name: "Write", isError: false })
    // every shell command and file write went through the client (the app), never Grok's own process
    const reqs = lines.filter((l) => l.msg.method && l.msg.id !== undefined).map((l) => l.msg.method)
    expect(reqs.filter((m) => m === "terminal/create")).toHaveLength(8) // `cat <secret>` was stopped by the deny rule first
    expect(reqs.filter((m) => m === "fs/write_text_file").length).toBeGreaterThanOrEqual(6)
  })
})

describe("config, shell and normalizer units", () => {
  it("config.toml / sandbox.toml / env: compat off, deny rules, strict profile with G-code denied, no inherited keys", () => {
    const cfg = grokConfigToml({ home: "/h", denyRead: ["/s/secrets.json"] })
    for (const k of ["auto_update = false", "telemetry = false", "load_envrc = false", "[compat.cursor]", "mcps = false", "hooks = false", '"Read(/h/auth.json)"', '"Read(/s/secrets.json)"', "timeout_enabled = false"]) expect(cfg).toContain(k)
    const sb = grokSandboxToml({ denyRead: ["/s/secrets.json"], readOnly: ["/lib"] })
    for (const k of ["[profiles.printstudio]", 'extends = "strict"', "restrict_network = true", '"**/*.gcode"', '"/s/secrets.json"', 'read_only = ["/lib"]']) expect(sb).toContain(k)
    const env = grokEnv("/h", null, { PATH: "/bin", ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "b", HOME: "/Users/u" })
    expect(env).toMatchObject({ PATH: "/bin", HOME: "/h/home", GROK_HOME: "/h" })
    expect(Object.keys(env).some((k) => /ANTHROPIC|OPENAI|XAI/.test(k))).toBe(false)
  })

  it("exit reason: an agent that quits at start says why (its last stderr error line)", async () => {
    const { grokExitReason } = await import("./process")
    expect(grokExitReason("warning: sandbox could not be applied: x\nerror: could not apply the 'printstudio' sandbox profile; see the warning above\n")).toBe("could not apply the 'printstudio' sandbox profile; see the warning above")
    expect(grokExitReason("panic at foo\n")).toBe("panic at foo")
    expect(grokExitReason("")).toBeNull()
  })

  it("runtime sockets: a Docker socket linked into the real home is mirrored under the fake HOME (Grok 1.0.13+ sandbox)", () => {
    const t = mkdtempSync(join(tmpdir(), "grok-sock-"))
    const realHome = join(t, "user")
    mkdirSync(join(realHome, ".docker", "run"), { recursive: true })
    writeFileSync(join(realHome, ".docker", "run", "docker.sock"), "")
    symlinkSync(join(realHome, ".docker", "run", "docker.sock"), join(t, "docker.sock"))
    const fake = join(t, "grokhome", "home")
    mkdirSync(fake, { recursive: true })
    linkRuntimeSockets(fake, realHome, [join(t, "docker.sock"), join(t, "missing.sock")])
    expect(realpathSync(join(fake, ".docker", "run", "docker.sock"))).toBe(realpathSync(join(realHome, ".docker", "run", "docker.sock")))
    linkRuntimeSockets(fake, realHome, [join(t, "docker.sock")]) // idempotent
    // Docker not running: the link dangles, its folder is still mirrored
    const fake2 = join(t, "grokhome2", "home")
    rmSync(join(realHome, ".docker", "run", "docker.sock"))
    linkRuntimeSockets(fake2, realHome, [join(t, "docker.sock")])
    expect(realpathSync(join(fake2, ".docker", "run"))).toBe(realpathSync(join(realHome, ".docker", "run")))
    rmSync(t, { recursive: true, force: true })
  })

  it("blocking hook: a PreToolUse deny for tools that never ask permission (scheduler, media generation, workflows)", async () => {
    const h = JSON.parse(grokHooksJson())
    const group = h.hooks.PreToolUse[0]
    const re = new RegExp(group.matcher)
    for (const t of ["scheduler_create", "image_gen", "image_edit", "image_to_video", "reference_to_video", "workflow", "spawn_subagent", "web_fetch"]) expect(re.test(t)).toBe(true)
    for (const t of ["write", "run_terminal_command", "read_file", "studio__render_part", "scheduler_create_x", "my_image_gen"]) expect(re.test(t)).toBe(false)
    expect(GROK_BLOCKED_TOOLS).toContain("scheduler_create")
    // the handler prints exactly the deny decision (run it the way Grok does: a shell command)
    const out = await new Promise<string>((res) => {
      const c = spawn("/bin/sh", ["-c", group.hooks[0].command], { stdio: ["ignore", "pipe", "ignore"] })
      let s = ""
      c.stdout.on("data", (d) => (s += d))
      c.on("exit", () => res(s))
    })
    expect(JSON.parse(out)).toEqual({ decision: "deny", reason: BLOCKED_TOOL_REASON })
  })

  it("shell profile: no network, project writes only, app paths and G-code denied, secrets unreadable; env without secrets", () => {
    const p = shellProfile({ root: "/proj", denyRead: ["/s/secrets.json"] })
    for (const k of ["(deny network*)", "(deny file-write*)", '(subpath "/proj")', '(subpath "/proj/build")', '(subpath "/proj/project.json")', "\\.git(/|$)", "\\.claude(/|$)", "\\.grok(/|$)", "(gcode|bgcode|gco|g)$", '(deny file-read* (literal "/s/secrets.json")'])
      expect(p).toContain(k)
    expect(shellEnv({ PATH: "/bin", XAI_API_KEY: "k", GH_TOKEN: "t", GROK_HOME: "/h" }, [{ name: "A", value: "1" }, { name: "MY_SECRET", value: "x" }])).toEqual({ PATH: "/bin", A: "1" })
  })

  it.skipIf(!sandboxAvailable())("shell sandbox (macOS): network and app paths blocked, project writes allowed", async () => {
    const r = mkdtempSync(join(tmpdir(), "grok-sh-"))
    mkdirSync(join(r, "build"))
    const t = new Terminals({ root: r })
    const run = async (command: string) => {
      const { terminalId } = t.create({ command, cwd: r })
      const e = await t.waitForExit(terminalId)
      return { code: e.exitCode, out: t.output(terminalId).output }
    }
    expect((await run("echo ok > a.scad && cat a.scad")).out).toBe("ok\n")
    expect((await run("echo x > build/x")).code).not.toBe(0)
    expect((await run("echo x > p.gcode")).code).not.toBe(0)
    expect((await run("curl -s -m 3 http://127.0.0.1:9/ ; echo $?")).out.trim()).not.toBe("0")
    rmSync(r, { recursive: true, force: true })
  })

  it("protected paths: Claude's list plus .grok/, .agents/ and AGENTS.md (symlinks resolved)", () => {
    const r = mkdtempSync(join(tmpdir(), "grok-pp-"))
    expect(grokProtectedReason(r, "parts/a.scad")).toBeNull()
    for (const p of [".grok/config.toml", "sub/.agents/skills/x.md", "AGENTS.md", "build/a.stl", ".studio/x", "a.gcode", "/etc/x"]) expect(grokProtectedReason(r, p)).not.toBeNull()
    rmSync(r, { recursive: true, force: true })
  })

  it("grok models output: sign-in state and models", () => {
    expect(parseModels("You are not authenticated.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n")).toEqual({
      signedIn: false,
      models: [
        { value: "grok-4.6", label: "grok-4.6" },
        { value: "grok-4.5", label: "grok-4.5" },
      ],
      defaultModel: "grok-4.6",
    })
    expect(parseModels("Available models:\n  * grok-4.6 (default)\n").signedIn).toBe(true)
  })

  it("normalizer: Claude-shaped tool names, MCP outputs, failures, diffs", () => {
    const n = new GrokNormalizer()
    n.startTurn("t1")
    const tool = (name: string, rawInput: unknown) => n.convert({ sessionUpdate: "tool_call", toolCallId: name, title: name, rawInput, _meta: { "x.ai/tool": { name } } }).at(-1)!.event
    expect(tool("write", { file_path: "a", content: "b" })).toMatchObject({ name: "Write", input: { file_path: "a", content: "b" } })
    expect(tool("search_replace", { file_path: "a", old_string: "x", new_string: "y" })).toMatchObject({ name: "Edit" })
    expect(tool("use_tool", { tool_name: "studio__render_part", tool_input: { partId: "main" } })).toMatchObject({ name: "mcp__studio__render_part", input: { partId: "main" } })
    expect(tool("ask_user_question", { questions: [] })).toMatchObject({ name: "AskUserQuestion" })
    const mcpDone = n.convert({ sessionUpdate: "tool_call_update", toolCallId: "use_tool", status: "completed", rawOutput: { type: "MCP", output: { OkayOutput: "rendered" } } })
    expect(mcpDone[0]).toMatchObject({ itemId: "t1:use_tool", event: { type: "tool.completed", isError: false, text: "rendered" } })
    const failed = n.convert({ sessionUpdate: "tool_call_update", toolCallId: "write", status: "failed", content: [{ type: "content", content: { type: "text", text: "Tool `write` failed: Blocked" } }] })
    expect(failed[0].event).toMatchObject({ isError: true, text: expect.stringContaining("Blocked") })
    const diff = n.convert({ sessionUpdate: "tool_call_update", toolCallId: "search_replace", status: "completed", content: [{ type: "diff", path: "/p/a.scad", oldText: "x", newText: "y" }] })
    expect(diff[0].event).toMatchObject({ text: "Updated /p/a.scad" })
    expect(n.convert({ sessionUpdate: "tool_call_update", toolCallId: "write", status: "in_progress" })).toEqual([])
  })
})
