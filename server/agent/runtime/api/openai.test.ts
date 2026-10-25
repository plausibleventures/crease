// Direct API runtime (R11f), second protocol: OpenAI-compatible Chat Completions through the coordinator against a
// scripted server (testing.ts FakeChatApi). Endpoint capability tests: streamed tool-call deltas (arguments split
// across chunks, parallel calls by index), images (user photos and tool-result images), usage (tokens, cached tokens;
// never a cost), model list, retries, a key-less local server. Real servers stay "untested" on the Agents card.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest"
import type { AgentEvent, AgentProfileSnapshot, Project } from "../../../../shared/types"
/* eslint-disable @typescript-eslint/no-explicit-any */

const home = mkdtempSync(join(tmpdir(), "printstudio-api-oai-test-"))
process.env.PRINTSTUDIO_HOME = home

const { SessionCoordinator } = await import("../../coordinator")
const { deps } = await import("../../deps")
const { setApproved } = await import("../../approval")
const { ToolRegistry, STUDIO_TOOLS } = await import("../../registry")
const { readEvents } = await import("../../transcript")
const { ApiRuntime, defaultApiDeps } = await import("./adapter")
const { toChatMessages } = await import("./openai")
const { FakeChatApi, chatStream } = await import("./testing")

afterAll(() => rmSync(home, { recursive: true, force: true }))

const P = "api-oai-test"
let root = ""
let project: Project
let fake: InstanceType<typeof FakeChatApi>
let coord: InstanceType<typeof SessionCoordinator>
let runtime: InstanceType<typeof ApiRuntime>
let profile: AgentProfileSnapshot
let slept: number[] = []
const realDeps = { ...deps }

const persisted = () => readEvents(P, project.activeSessionId!)
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

function snapshot(o: Partial<AgentProfileSnapshot> = {}): AgentProfileSnapshot {
  return {
    profileId: "oai",
    name: "Local",
    runtime: "api",
    model: "llama-test",
    auth: { kind: "api-key", credentialRef: "profile.oai.apiKey" },
    endpointRef: `${fake.url}/v1`,
    binaryPath: null,
    apiProtocol: "openai-chat",
    effort: null,
    budget: { maxUsdPerRun: null },
    policy: "design-sandbox",
    source: "default",
    frozenAt: "",
    ...o,
  }
}

beforeEach(async () => {
  fake = await new FakeChatApi().start()
  root = mkdtempSync(join(tmpdir(), "api-oai-proj-"))
  mkdirSync(join(root, "parts"), { recursive: true })
  writeFileSync(join(root, "parts", "main.scad"), "cube(20);")
  project = { id: P, name: "OAI", createdAt: "", printer: "", engine: "openscad", tags: [], parts: [{ id: "main", file: "parts/main.scad", qty: 1, colors: [] }], activeSessionId: null, sessions: [], source: null } as unknown as Project
  writeFileSync(join(root, "project.json"), JSON.stringify(project))
  setApproved(P, false)
  Object.assign(deps, {
    projectDir: () => root,
    getProject: async () => project,
    updateProject: async (_id: string, patch: Partial<Project>) => (project = { ...project, ...patch }),
    readAssembly: async () => ({ assembly: null }),
  })
  slept = []
  runtime = new ApiRuntime({
    ...defaultApiDeps,
    secret: (ref) => (ref === "profile.oai.apiKey" ? "test-key" : null),
    sleep: async (ms) => void slept.push(ms),
    printerHosts: () => ["10.0.0.24"],
  })
  profile = snapshot()
  coord = new SessionCoordinator({
    runtimes: [runtime],
    resolveProfile: () => ({ ...profile, frozenAt: new Date().toISOString() }),
    tools: new ToolRegistry(STUDIO_TOOLS),
    prepare: async () => ({ instructions: "BRIEF", policy: { denyRead: [] }, model: null, notices: [] }),
  })
})
afterEach(() => {
  coord.dispose()
  fake.close()
  Object.assign(deps, realDeps)
  rmSync(root, { recursive: true, force: true })
})

async function turn(text: string, images: any[] = []) {
  const before = ends()
  await coord.sendMessage(P, text, images, [], text)
  await until(() => ends() > before, "run end")
}

describe("API runtime over an OpenAI-compatible Chat Completions endpoint (scripted)", () => {
  it("streams text, parallel tool calls with arguments split across chunks; results go back as tool messages", async () => {
    fake.push(
      chatStream({
        text: "Let me look.",
        tools: [
          { id: "call_a", name: "list_parts", args: ['{"proj', 'ectId": "x"', "}"] },
          { id: "call_b", name: "read_file", args: ['{"path":', ' "parts/main.scad"}'] },
        ],
      }),
      chatStream({ text: "One part: a cube.", usage: { prompt_tokens: 120, completion_tokens: 8, cached: 100 } })
    )
    await turn("what's here?")
    const [first, second] = fake.calls
    expect(first).toMatchObject({ model: "llama-test", stream: true, stream_options: { include_usage: true } })
    expect(first.messages[0]).toEqual({ role: "system", content: expect.stringContaining("BRIEF") })
    expect(first.messages[1]).toEqual({ role: "user", content: "what's here?" })
    expect(first.tools.map((t: any) => t.function.name)).toEqual(expect.arrayContaining(["read_file", "write_file", "list_parts", "AskUserQuestion"]))
    expect(first.tools[0]).toMatchObject({ type: "function", function: { parameters: { type: "object" } } })
    expect(fake.requests[0].headers.authorization).toBe("Bearer test-key")
    expect(second.messages[2]).toEqual({
      role: "assistant",
      content: "Let me look.",
      tool_calls: [
        { id: "call_a", type: "function", function: { name: "list_parts", arguments: '{"projectId":"x"}' } },
        { id: "call_b", type: "function", function: { name: "read_file", arguments: '{"path":"parts/main.scad"}' } },
      ],
    })
    expect(second.messages[3]).toMatchObject({ role: "tool", tool_call_id: "call_a", content: expect.stringContaining('"id": "main"') })
    expect(second.messages[4]).toEqual({ role: "tool", tool_call_id: "call_b", content: "cube(20);" })
    expect(ofType("tool.started").map((t) => t.name)).toEqual(["mcp__studio__list_parts", "Read"])
    const done = ofType("run.completed")[0].result
    expect(done.text).toBe("One part: a cube.")
    // tokens only (cached split out); never a cost for a non-Anthropic endpoint
    expect(done.usage).toMatchObject({ tokens: { input: 50 + 20, output: 18, cacheRead: 100 }, billedUsd: null, estimatedApiUsd: null, billing: "api" })
  })

  it("images: a user photo and a tool result's image go as image_url data URLs", async () => {
    writeFileSync(join(root, "parts", "pic.png"), Buffer.from("89504e470d0a1a0a", "hex"))
    fake.push(chatStream({ tools: [{ id: "c1", name: "read_file", args: ['{"path": "parts/pic.png"}'] }] }), chatStream({ text: "I see it." }))
    await turn("look", [{ mediaType: "image/png", data: "iVBORw0KGgo=" }])
    expect(fake.calls[0].messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
      ],
    })
    const m = fake.calls[1].messages
    expect(m[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "parts/pic.png" })
    expect(m[4].role).toBe("user")
    expect(m[4].content[0]).toEqual({ type: "text", text: "Images from the tool results above:" })
    expect(m[4].content[1].image_url.url).toMatch(/^data:image\/png;base64,/)
  })

  it("reasoning is shown, never sent back; a server that says 'stop' while calling tools still runs them; bad JSON is reported", async () => {
    fake.push(chatStream({ reasoning: "thinking…", tools: [{ id: "c1", name: "render_part", args: ['{"partId": '] }], finish: "stop" }), chatStream({ text: "ok" }))
    await turn("go")
    expect(ofType("message.completed").map((x) => `${x.kind}:${x.text}`)).toEqual(["thinking:thinking…", "text:ok"])
    expect(JSON.stringify(fake.calls[1].messages)).not.toContain("thinking…")
    expect(fake.calls[1].messages[3]).toEqual({ role: "tool", tool_call_id: "c1", content: `Error: ${JSON.stringify({ INVALID_JSON: '{"partId": ' })}` })
  })

  it("retries a 503 and a stream that breaks off; no usage reported = unknown tokens, not zero", async () => {
    fake.push({ status: 503, body: { error: { message: "loading model" } } }, { sse: [{ id: "x", choices: [{ index: 0, delta: { content: "par" } }] }], plain: true, truncate: true }, chatStream({ text: "fine", usage: null }))
    await turn("hi")
    expect(fake.calls).toHaveLength(3)
    expect(slept).toHaveLength(2)
    expect(ofType("run.completed")[0].result.usage).toMatchObject({ tokens: { input: null, output: null }, billedUsd: null })
  })

  it("a local server needs no key; Test connection lists its models and labels tool calls / images / usage untested", async () => {
    fake.requireKey = false
    const local = snapshot({ auth: { kind: "api-key", credentialRef: "profile.none.apiKey" } })
    const r = await runtime.checkConnection(local)
    expect(r.ok).toBe(true)
    expect(r.models?.map((m) => m.value)).toEqual(["llama-test", "qwen-test"])
    expect(r.steps.find((s) => s.label === "Tool calls, images, usage")).toMatchObject({ ok: null, detail: expect.stringMatching(/^untested/) })
    expect(r.summary).toMatch(/no costs/)
    expect(fake.requests[0].headers.authorization).toBeUndefined()
    // a remote endpoint without a key is refused before any request
    const remote = await runtime.checkConnection(snapshot({ auth: { kind: "api-key", credentialRef: "profile.none.apiKey" }, endpointRef: "https://example.invalid/v1" }))
    expect(remote.ok).toBe(false)
    // no model picked: listed, and asked for
    const noModel = await runtime.checkConnection(snapshot({ model: null }))
    expect(noModel).toMatchObject({ ok: false, summary: "Connected. Now pick a model." })
    expect((await runtime.listModels(snapshot({ model: null }))).defaultModel).toBe("llama-test")
  })

  it("toChatMessages: assistant text + calls, tool results, a following user message; thinking dropped", () => {
    const out = toChatMessages("S", [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "thinking", text: "t", signature: "sig" }, { type: "tool_use", id: "c", name: "x", input: { a: 1 } }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "c", isError: true, content: [{ type: "text", text: "bad" }] }] },
      { role: "user", content: [{ type: "text", text: "again" }] },
    ])
    expect(out).toEqual([
      { role: "system", content: "S" },
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "x", arguments: '{"a":1}' } }] },
      { role: "tool", tool_call_id: "c", content: "Error: bad" },
      { role: "user", content: "again" },
    ])
  })
})
