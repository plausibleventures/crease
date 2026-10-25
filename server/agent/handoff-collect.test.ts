// R11g: the handoff summary from a real fixture project (temp home): the user's requests and answers, plan cards,
// the design's parts and size, failing checks and the motion check, refs and pins, prints with outcomes, and the last
// messages. Redacted: no secrets, no absolute paths (the project folder, the home folder, temp folders).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { AgentEvent, AgentEventEnvelope } from "../../shared/types"

const home = mkdtempSync(join(tmpdir(), "printstudio-handoff-collect-"))
process.env.PRINTSTUDIO_HOME = home

const store = await import("../projects/store")
const db = await import("../db")
const outcomes = await import("../outcomes")
const { appendEvent } = await import("./transcript")
const { collectHandoffSummary } = await import("./handoff-collect")
const { handoffMarkdown } = await import("./handoff")
const { setApproved } = await import("./approval")

afterAll(() => rmSync(home, { recursive: true, force: true }))

let P = ""
let root = ""
const SID = "11111111-2222-3333-4444-555555555555"

let seq = 0
const add = (event: AgentEvent, itemId: string | null = null) => {
  const env: AgentEventEnvelope = {
    schemaVersion: 1,
    eventId: String(seq),
    seq: seq++,
    ts: new Date(1_760_000_000_000 + seq * 1000).toISOString(),
    projectId: P,
    sessionId: SID,
    runId: null,
    itemId,
    revision: null,
    runtime: event.type === "run.started" ? "app" : "claude",
    event,
  }
  appendEvent(env)
}

beforeAll(async () => {
  const p = await store.createProject("Key hook")
  P = p.id
  root = store.projectDir(P)
  writeFileSync(join(root, "parts", "main.scad"), "// key hook\ncube([60, 20, 30]);\n")
  mkdirSync(join(root, "build"), { recursive: true })
  writeFileSync(
    join(root, "build", "main.render.json"),
    JSON.stringify({ hash: "h1", stats: { sizeMm: [60, 20, 30], bbox: { min: [0, 0, 0], max: [60, 20, 30] } } }),
  )
  mkdirSync(join(root, ".studio", "checks"), { recursive: true })
  writeFileSync(join(root, ".studio", "checks", "main.json"), JSON.stringify({ items: [{ severity: "fail", message: "the hook wall is 0.6 mm thick (thinner than 2 lines)" }] }))
  writeFileSync(join(root, "build", "motion-check.json"), JSON.stringify({ inputs: "old", check: { ok: false, summary: "the lid hits the box at 80°" } }))
  mkdirSync(join(root, "refs"), { recursive: true })
  writeFileSync(join(root, "refs", "wall-photo.jpg"), "jpg")
  await store.updateProject(P, { activeSessionId: SID, sessions: [{ id: SID, title: "Design session", forkedFrom: null, runtime: "claude" }] })

  add({ type: "run.started", input: { text: "make me a key hook for 3 keys" }, model: "opus", profile: { id: "claude", name: "Claude", runtime: "claude", budgetUsd: null } }, "user:1")
  add({ type: "tool.started", name: "AskUserQuestion", input: { questions: [{ question: "How will it hang?" }] } }, "q1")
  add({ type: "tool.completed", isError: false, text: 'User has answered your questions: "How will it hang?"="Screws (Recommended)".', images: [] }, "q1")
  add({ type: "tool.started", name: "mcp__studio__share_plan", input: { title: "Your key hook", bullets: ["3 hooks, 60 mm wide", "2 screws into the wall"] } }, "p1")
  add({ type: "message.completed", role: "assistant", kind: "text", text: `Saved it to ${root}/parts/main.scad (key sk-ant-api03-SECRETSECRETSECRET). Have a look at ${homedir()}/Desktop/notes.txt` }, "t1")
  add(
    {
      type: "run.started",
      input: { text: "make the hooks longer", annotations: [{ n: 1, partId: "main", point: [1, 2, 3], normal: [0, 0, 1], hint: "front face", note: "longer here" }] },
      model: "opus",
      profile: { id: "claude", name: "Claude", runtime: "claude", budgetUsd: null },
    },
    "user:2",
  )
  add({ type: "message.completed", role: "assistant", kind: "text", text: "Done: the hooks are 10 mm longer." }, "t2")

  // a print that came out too tight
  const rec = db.recordPrintStart({ projectId: P, partIds: ["main"], gcodeName: "main.gcode", printerFilename: null, estimatedTimeS: 1200, filamentG: 8, machineId: null })
  db.recordPrintFinish(rec.id, "complete", new Date(Date.parse(rec.startedAt) + 25 * 60_000).toISOString())
  outcomes.saveOutcome(rec.id, { rating: "problem", categories: ["wrong_size"], notes: `the slot was too tight; photo in ${homedir()}/Pictures/hook.jpg`, fits: [{ name: "key slot", result: "too_tight", clearanceMm: 0.2 }] })
  setApproved(P, false)
})

describe("handoff summary from a fixture project", () => {
  it("collects requirements, design, decisions, checks, prints and references", async () => {
    const s = await collectHandoffSummary(P, SID)
    expect(s.project.name).toBe("Key hook")
    expect(s.requirements.firstAsk).toBe("make me a key hook for 3 keys")
    expect(s.requirements.answers).toEqual([{ question: "How will it hang?", answer: "Screws" }])
    expect(s.requirements.asks).toEqual(["make the hooks longer"])
    expect(s.design.parts).toEqual([expect.objectContaining({ id: "main", qty: 1, sizeMm: [60, 20, 30] })])
    expect(s.design.size).toMatchObject({ mm: [60, 20, 30] })
    expect(s.design.version?.short).toMatch(/^[0-9a-f]{7}$/)
    expect(s.approved).toBe(false)
    expect(s.decisions).toEqual([{ title: "Your key hook", bullets: ["3 hooks, 60 mm wide", "2 screws into the wall"] }])
    expect(s.checks.failing).toEqual(["main: the hook wall is 0.6 mm thick (thinner than 2 lines)"])
    expect(s.checks.motion).toContain("the lid hits the box at 80°")
    expect(s.references.files).toEqual(["wall-photo.jpg"])
    expect(s.references.pins).toEqual(["Pin 1 on main (front face): longer here"])
    expect(s.prints.last).toMatch(/^Last print finished/)
    expect(s.prints.outcomes[0]).toMatch(/had a problem/)
    expect(s.prints.outcomes[0]).toMatch(/fit "key slot" too tight at 0.2 mm\/side/)
    expect(s.recent.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"])
  })

  it("is redacted: no secrets, no absolute paths, the project folder relative", async () => {
    const s = await collectHandoffSummary(P, SID)
    const md = handoffMarkdown(s, { profileId: "claude", name: "Claude (Opus)", runtime: "claude", model: "opus" }, "switch")
    const all = JSON.stringify(s) + md
    expect(all).not.toContain(root)
    expect(all).not.toContain(home)
    expect(all).not.toContain(homedir())
    expect(all).not.toMatch(/(^|[\s"'(])\/(Users|var|private|tmp|home)\//)
    expect(all).not.toContain("SECRETSECRET")
    expect(md).toContain("Saved it to parts/main.scad")
    expect(md).toContain("~/Desktop/notes.txt")
    expect(md).toContain("~/Pictures/hook.jpg")
  })

  it("a chat that started from a handoff keeps the earlier requirements (chained handoffs)", async () => {
    const { saveHandoff } = await import("./handoff")
    const prior = await collectHandoffSummary(P, SID)
    const SID2 = "99999999-2222-3333-4444-555555555555"
    saveHandoff(P, {
      id: "h-prior",
      createdAt: new Date().toISOString(),
      reason: "switch",
      mode: "new",
      fromSessionId: SID,
      toSessionId: SID2,
      from: null,
      to: { profileId: "codex", name: "Codex", runtime: "codex", model: null },
      summary: prior,
      generated: "",
      markdown: "",
      edited: false,
      deliveredAt: new Date().toISOString(),
    })
    const p = await store.getProject(P)
    await store.updateProject(P, { sessions: [...p.sessions, { id: SID2, title: "Handed over", forkedFrom: null, runtime: "codex", handoff: { id: "h-prior", fromSessionId: SID, from: "Claude (Opus)", reason: "switch" } }] })
    const s = await collectHandoffSummary(P, SID2) // no events in the new chat yet
    expect(s.requirements.firstAsk).toBe("make me a key hook for 3 keys")
    expect(s.requirements.answers).toEqual([{ question: "How will it hang?", answer: "Screws" }])
    expect(s.decisions).toHaveLength(1)
  })

  it("a chat resumed with a catch-up keeps what the other designer was asked, once each", async () => {
    const { saveHandoff } = await import("./handoff")
    const prior = await collectHandoffSummary(P, SID)
    saveHandoff(P, {
      id: "h-resume",
      createdAt: new Date(Date.now() + 1000).toISOString(),
      reason: "resume",
      mode: "resume",
      fromSessionId: "other",
      toSessionId: SID,
      from: null,
      to: { profileId: "claude", name: "Claude", runtime: "claude", model: null },
      summary: { ...prior, requirements: { ...prior.requirements, asks: ["make the hooks longer", "countersink the screw holes"] } },
      generated: "",
      markdown: "",
      edited: false,
      deliveredAt: null,
    })
    const s = await collectHandoffSummary(P, SID)
    expect(s.requirements.firstAsk).toBe("make me a key hook for 3 keys")
    expect(s.requirements.asks).toEqual(["make the hooks longer", "countersink the screw holes"])
  })
})
