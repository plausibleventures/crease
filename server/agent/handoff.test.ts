// R11g: cross-runtime handoff through the session coordinator, with two fake runtimes (no tokens). Switching runtime
// creates a linked chat that gets the app's summary first; the user's edit is what's delivered; switching back offers
// (and does) a native resume of the earlier chat; a fresh chat with a summary stays on the same runtime; a designer
// changed outside the dialog still hands over. Plus the pure parts: transcript facts, markdown, redaction.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest"
import type { AgentEvent, AgentEventEnvelope, AgentProfileSnapshot, HandoffSummary, Project } from "../../shared/types"

const home = mkdtempSync(join(tmpdir(), "printstudio-handoff-test-"))
process.env.PRINTSTUDIO_HOME = home

const { SessionCoordinator } = await import("./coordinator")
const { FakeRuntime } = await import("./runtime/fake")
const { deps } = await import("./deps")
const { ToolRegistry, STUDIO_TOOLS } = await import("./registry")
const { readEvents } = await import("./transcript")
const { handoffMarkdown, pendingHandoff, readHandoff, scrubText, transcriptFacts } = await import("./handoff")

afterAll(() => rmSync(home, { recursive: true, force: true }))

const P = "handoff-test"
let root = ""
let project: Project
let fakeA: InstanceType<typeof FakeRuntime>
let fakeB: InstanceType<typeof FakeRuntime>
let coord: InstanceType<typeof SessionCoordinator>
const realDeps = { ...deps }
const summaries: (string | null)[] = []

const PROFILES: Record<string, { name: string; runtime: string }> = {
  claude: { name: "Claude", runtime: "fake" },
  codex: { name: "Codex", runtime: "fake2" },
}
const resolve = (p: Project): AgentProfileSnapshot => {
  const id = p.agentProfileId ?? "claude"
  const prof = PROFILES[id]
  return {
    profileId: id,
    name: prof.name,
    runtime: prof.runtime,
    model: p.agentModel ?? (id === "claude" ? "opus" : "gpt-5"),
    auth: { kind: "subscription" },
    endpointRef: null,
    binaryPath: null,
    effort: null,
    budget: { maxUsdPerRun: null },
    policy: "design-sandbox",
    source: p.agentProfileId ? "project" : "default",
    frozenAt: new Date().toISOString(),
  }
}

const summary = (over: Partial<HandoffSummary> = {}): HandoffSummary => ({
  project: { name: "Key hook", description: null },
  requirements: { firstAsk: "make me a key hook", answers: [{ question: "How many keys?", answer: "Three" }], asks: [] },
  design: { idea: "First idea", version: { short: "abc1234", message: "hook v1" }, revision: "r1", size: { mm: [60, 20, 30], basis: "the part" }, parts: [{ id: "main", name: "hook", qty: 1, sizeMm: [60, 20, 30], colors: ["White"], error: null }] },
  approved: false,
  decisions: [{ title: "Your key hook", bullets: ["3 hooks", "screws to the wall"] }],
  checks: { failing: [], outOfDate: [], motion: null, open: [] },
  supplies: null,
  prints: { last: null, outcomes: [] },
  references: { files: [], pins: [] },
  recent: [{ role: "user", text: "make me a key hook" }],
  ...over,
})

const finish = (a: InstanceType<typeof FakeRuntime>["last"], n: number) =>
  a.host.emit(
    {
      type: "run.completed",
      result: { subtype: "success", isError: false, text: "ok", durationMs: 1, turns: 1, usage: { tokens: null, billedUsd: null, estimatedApiUsd: 0.1 * n, billing: "plan", subscription: null, final: true } },
    },
    { itemId: `end${n}` },
  )

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "handoff-"))
  mkdirSync(join(root, "parts"), { recursive: true })
  writeFileSync(join(root, "parts", "main.scad"), "cube(20);")
  project = {
    id: P,
    name: "Key hook",
    createdAt: "",
    printer: "",
    engine: "openscad",
    tags: [],
    parts: [{ id: "main", file: "parts/main.scad", qty: 1, colors: [] }],
    activeSessionId: null,
    sessions: [],
    source: null,
  } as unknown as Project
  Object.assign(deps, {
    projectDir: () => root,
    getProject: async () => project,
    updateProject: async (_id: string, patch: Partial<Project>) => (project = { ...project, ...patch }),
    readAssembly: async () => ({ assembly: null }),
  })
  fakeA = new FakeRuntime("fake")
  fakeB = new FakeRuntime("fake2")
  summaries.length = 0
  coord = new SessionCoordinator({
    runtimes: [fakeA, fakeB],
    resolveProfile: resolve,
    tools: new ToolRegistry([...STUDIO_TOOLS]),
    prepare: async () => ({ instructions: "brief", policy: {}, model: null, notices: [] }),
    summarize: async (_p, from) => {
      summaries.push(from)
      return summary()
    },
  })
})
afterEach(() => {
  coord.dispose()
  Object.assign(deps, realDeps)
  rmSync(root, { recursive: true, force: true })
})

describe("handoff through the coordinator", () => {
  it("switching runtime: preview, then a linked new chat that gets the (edited) summary first; back-switch resumes natively", async () => {
    // a chat with Claude
    const first = (await coord.sendMessage(P, "make me a key hook", [], [], "make me a key hook")).sessionId!
    finish(fakeA.last, 1)

    // the dialog's preview: what Codex would be told; no earlier Codex chat yet
    const pv = await coord.previewHandoff(P, "switch", { profileId: "codex", model: null })
    expect(pv).toMatchObject({ needed: true, fromSessionId: first, from: { name: "Claude (Opus)", runtime: "fake" }, to: { name: "Codex (gpt-5)", runtime: "fake2" }, resume: null })
    expect(pv.markdown).toContain("taking over this project from another designer (Claude (Opus))")
    expect(pv.markdown).toContain("How many keys? → Three")
    expect(project.activeSessionId).toBe(first) // preview changes nothing
    // a switch inside one runtime needs no handoff (it resumes natively)
    expect((await coord.previewHandoff(P, "switch", { profileId: "claude", model: "sonnet" })).needed).toBe(false)

    // the user edits the summary and hands over
    const edited = pv.markdown + "\nAlso: the user wants it in blue.\n"
    const { sessionId, handoffId } = await coord.startHandoff(P, { reason: "switch", profileId: "codex", model: null, markdown: edited })
    expect(sessionId).not.toBe(first)
    expect(project.activeSessionId).toBe(sessionId)
    expect(project.agentProfileId).toBe("codex")
    const entry = project.sessions.find((x) => x.id === sessionId)!
    expect(entry).toMatchObject({ runtime: "fake2", profileId: "codex", handoff: { id: handoffId, fromSessionId: first, from: "Claude (Opus)", reason: "switch" } })
    // the chat it left remembers its designer
    expect(project.sessions.find((x) => x.id === first)).toMatchObject({ profileId: null })
    // stored as .studio/handoffs/<id>.json + .md, waiting for the next message
    expect(existsSync(join(root, ".studio", "handoffs", `${handoffId}.md`))).toBe(true)
    const rec = readHandoff(P, handoffId)!
    expect(rec).toMatchObject({ edited: true, deliveredAt: null, fromSessionId: first, toSessionId: sessionId, mode: "new" })
    expect(readFileSync(join(root, ".studio", "handoffs", `${handoffId}.md`), "utf8")).toContain("in blue")
    // timeline: the new chat opens with the marker; the old one says where the work went
    const opened = readEvents(P, sessionId)
    expect(opened[0].event).toMatchObject({ type: "notice", code: "handoff.started", text: "Handed over from Claude (Opus) — read the summary", data: { handoffId } })
    expect(opened[0].itemId).toBe(`handoff:${handoffId}`)
    expect(readEvents(P, first).at(-1)!.event).toMatchObject({ code: "handoff.left", text: "Handed over to Codex (gpt-5), with a summary of this chat" })

    // the next message starts Codex fresh (no native resume claimed) with the summary first
    await coord.sendMessage(P, "make it taller", [], [], "make it taller")
    const b = fakeB.last
    expect(b.ctx).toMatchObject({ sessionId, resume: null, profile: { runtime: "fake2" } })
    expect(b.sent[0].text).toBe("make it taller") // the bubble shows only what the user typed
    expect(b.sent[0].agentText).toMatch(/^\[Crease handoff/)
    expect(b.sent[0].agentText).toContain("Also: the user wants it in blue.")
    expect(b.sent[0].agentText.endsWith("make it taller")).toBe(true)
    expect(readHandoff(P, handoffId)!.deliveredAt).toBeTruthy()
    expect(pendingHandoff(P, sessionId)).toBeNull()
    finish(b, 2)
    // delivered once
    await coord.sendMessage(P, "thanks", [], [], "thanks")
    expect(b.sent[1].agentText).toBe("thanks")
    finish(b, 3)

    // back to Claude: the earlier Claude chat is offered for native resume
    const back = await coord.previewHandoff(P, "switch", { profileId: "claude", model: null })
    expect(back.resume).toMatchObject({ sessionId: first, designer: "Claude (Opus)" })
    expect(back.resumeMarkdown).toContain("Since then another designer (Codex (gpt-5)) worked on it")
    const r = await coord.startHandoff(P, { reason: "switch", profileId: null, mode: "resume", resumeSessionId: first })
    expect(r.sessionId).toBe(first)
    expect(project.activeSessionId).toBe(first)
    expect(readEvents(P, first).at(-1)!.event).toMatchObject({ code: "handoff.started", data: { mode: "resume" } })
    await coord.sendMessage(P, "go on", [], [], "go on")
    const a2 = fakeA.last
    expect(a2.ctx).toMatchObject({ sessionId: first, resume: first }) // native resume of its own conversation
    expect(a2.sent[0].agentText).toMatch(/^\[Crease: what changed while you were away/)
    expect(summaries).toContain(sessionId) // the catch-up is a summary of the Codex chat
  })

  it("a fresh chat with a summary stays on the same runtime", async () => {
    const first = (await coord.sendMessage(P, "make me a key hook", [], [], "make me a key hook")).sessionId!
    finish(fakeA.last, 1)
    const pv = await coord.previewHandoff(P, "fresh")
    expect(pv).toMatchObject({ needed: true, to: { runtime: "fake" }, resume: null })
    expect(pv.markdown).toContain("This is a fresh chat about this project")
    const { sessionId, handoffId } = await coord.startHandoff(P, { reason: "fresh" })
    expect(project.sessions.find((x) => x.id === sessionId)).toMatchObject({ runtime: "fake", title: "Fresh start (with a summary)", handoff: { fromSessionId: first, reason: "fresh" } })
    expect(readEvents(P, sessionId)[0].event).toMatchObject({ code: "handoff.started", text: expect.stringContaining("Fresh chat") })
    await coord.sendMessage(P, "hi", [], [], "hi")
    expect(fakeA.last.ctx).toMatchObject({ sessionId, resume: null })
    expect(fakeA.last.sent[0].agentText).toContain("# Handoff: Key hook")
    expect(readHandoff(P, handoffId)!.edited).toBe(false)
  })

  it("per-chat designer, model, version and cost labels for comparing ideas (known / estimated / unknown)", async () => {
    const { ideaDesigners } = await import("../projects/compare")
    const first = (await coord.sendMessage(P, "make me a key hook", [], [], "x")).sessionId!
    fakeA.last.host.emit({ type: "notice", level: "info", code: "session.started", text: "Session started", data: { model: "opus", version: "2.1.0" } }, { itemId: "init" })
    finish(fakeA.last, 1) // plan login: an estimate
    const { sessionId } = await coord.startHandoff(P, { reason: "switch", profileId: "codex" })
    await coord.sendMessage(P, "go", [], [], "go")
    const b = fakeB.last
    b.host.emit(
      { type: "run.completed", result: { subtype: "success", isError: false, text: "", durationMs: 1, turns: 1, usage: { tokens: null, billedUsd: 0.25, estimatedApiUsd: null, billing: "api", subscription: null, final: true } } },
      { itemId: "endb" },
    )
    const { sessionId: third } = await coord.startHandoff(P, { reason: "fresh" })
    await coord.sendMessage(P, "go", [], [], "go")
    fakeB.last.host.emit({ type: "run.completed", result: { subtype: "success", isError: false, text: "", durationMs: 1, turns: 1, usage: null } }, { itemId: "endc" })
    const d = ideaDesigners(P, project.sessions)
    expect(d.find((x) => x.sessionId === first)).toMatchObject({ runtime: "fake", designer: "Claude", model: "opus", version: "2.1.0", costUsd: 0.1, cost: "estimated" })
    expect(d.find((x) => x.sessionId === sessionId)).toMatchObject({ runtime: "fake2", designer: "Codex", costUsd: 0.25, cost: "known", handedOverFrom: "Claude (Opus)" })
    expect(d.find((x) => x.sessionId === third)).toMatchObject({ costUsd: null, cost: "unknown" })
  })

  it("a designer changed elsewhere (no dialog) still hands over with the summary", async () => {
    const first = (await coord.sendMessage(P, "make me a key hook", [], [], "make me a key hook")).sessionId!
    finish(fakeA.last, 1)
    project = { ...project, agentProfileId: "codex" } // e.g. the default changed in Agents
    const { sessionId } = await coord.sendMessage(P, "continue", [], [], "continue")
    expect(sessionId).not.toBe(first)
    const b = fakeB.last
    expect(b.ctx.resume).toBeNull()
    expect(b.sent[0].agentText).toMatch(/^\[Crease handoff/)
    const evs = readEvents(P, sessionId!)
    expect(evs.some((e) => e.event.type === "notice" && e.event.code === "handoff.started")).toBe(true)
    expect(project.sessions.find((x) => x.id === sessionId)?.handoff?.fromSessionId).toBe(first)
    // opening the earlier chat brings its designer back (it resumes natively instead of handing over again)
    await coord.switchSession(P, first)
    expect(project.agentProfileId).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------------------------

let seq = 0
const env = (event: AgentEvent, itemId: string | null = null, runtime = "claude"): AgentEventEnvelope => ({
  schemaVersion: 1,
  eventId: String(seq),
  seq: seq++,
  ts: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
  projectId: P,
  sessionId: "s",
  runId: null,
  itemId,
  revision: null,
  runtime,
  event,
})

describe("transcript facts", () => {
  it("requests, answers (latest wins, no '(recommended)'), plan cards, pins and the last messages", () => {
    const events = [
      env({ type: "run.started", input: { text: "make me a key hook" } }, "user:1", "app"),
      env({ type: "tool.started", name: "AskUserQuestion", input: { questions: [{ question: "How many keys?" }, { question: "Colour?" }] } }, "q1"),
      env({ type: "tool.completed", isError: false, text: 'User has answered your questions: "How many keys?"="3 (Recommended)", "Colour?"="White". You can now continue', images: [] }, "q1"),
      env({ type: "tool.started", name: "mcp__studio__share_plan", input: { title: "Your hook", bullets: ["3 hooks", "2 screws"] } }, "p1"),
      env({ type: "message.completed", role: "assistant", kind: "text", text: "Here it is." }, "t1"),
      env({ type: "message.completed", role: "assistant", kind: "text", text: "Here it is, 60 mm wide." }, "t1"), // upsert
      env({ type: "message.completed", role: "assistant", kind: "text", text: "sub-agent chatter", parentToolId: "x" }, "t2"),
      env(
        {
          type: "run.started",
          input: { text: "make the hook longer", annotations: [{ n: 1, partId: "main", point: [0, 0, 0], normal: [0, 0, 1], hint: "top face", note: "longer here" }] },
        },
        "user:2",
        "app",
      ),
      env({ type: "tool.started", name: "ask_user_question", input: { questions: [{ question: "How many keys?" }] } }, "q2"),
      env({ type: "tool.completed", isError: false, text: 'User has answered your questions: "How many keys?"="4".', images: [] }, "q2"),
    ]
    const f = transcriptFacts(events)
    expect(f.firstAsk).toBe("make me a key hook")
    expect(f.asks).toEqual(["make the hook longer"])
    expect(f.answers).toEqual([
      { question: "Colour?", answer: "White" },
      { question: "How many keys?", answer: "4" },
    ])
    expect(f.plans).toEqual([{ title: "Your hook", bullets: ["3 hooks", "2 screws"] }])
    expect(f.pins).toEqual(["Pin 1 on main (top face): longer here"])
    expect(f.recent.map((m) => m.text)).toEqual(["make me a key hook", "Here it is, 60 mm wide.", "make the hook longer"])
  })
})

describe("redaction", () => {
  it("no secrets and no absolute paths; the project folder becomes relative", () => {
    const projectRoot = "/Users/someone/PrintStudio/projects/key-hook"
    const t = scrubText(
      `wrote ${projectRoot}/parts/main.scad, read /Users/someone/Desktop/photo.jpg and /var/folders/x/y.tmp; key sk-ant-api03-abcdefghijklmnop and sk-proj-ABCDEFGHIJKLMNOPQRSTUV and xai-ABCDEFGHIJKLMNOPQRSTUVWX; C:\\Users\\me\\a.stl`,
      projectRoot,
    )
    expect(t).toContain("wrote parts/main.scad")
    expect(t).not.toMatch(/\/Users\/|\/var\/|C:\\/)
    expect(t).not.toMatch(/sk-ant-api03-abc|sk-proj-ABC|xai-ABC/)
    expect(t).toContain("[redacted]")
  })

  it("markdown covers every section in plain words", () => {
    const md = handoffMarkdown(
      summary({
        approved: true,
        checks: { failing: ["main: wall too thin"], outOfDate: ["preview of main (main.scad changed)"], motion: "passed: the lid opens", open: ["Build the picture guide"] },
        supplies: [{ name: "Wood screws", need: "2" }],
        prints: { last: "Last print finished (2026-10-01); the user rated it", outcomes: ["- 2026-10-01 main: had a problem; fit \"peg\" too tight"] },
        references: { files: ["photo.jpg"], pins: ["Pin 1 on main (top face): longer here"] },
      }),
      { profileId: "claude", name: "Claude (Opus)", runtime: "claude", model: "opus" },
      "switch",
    )
    for (const s of [
      "## What the user asked for",
      "First request: “make me a key hook”",
      "How many keys? → Three",
      "Idea: First idea · latest saved version abc1234 “hook v1”",
      "60 × 20 × 30 mm",
      "hook (main) × 1 — 60 × 20 × 30 mm — White",
      "the user approved this exact design",
      "Your key hook:",
      "Failing: main: wall too thin",
      "Out of date: preview of main",
      "Motion check: passed",
      "Still open: Build the picture guide",
      "## Things to buy",
      "Wood screws: 2",
      "Last print finished",
      "too tight",
      "Files the user gave (refs/): photo.jpg",
      "Pin 1 on main",
      "**User:** make me a key hook",
    ])
      expect(md).toContain(s)
  })
})
