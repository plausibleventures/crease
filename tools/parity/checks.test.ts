// The parity harness's transcript checks (tools/parity/checks.ts) on synthetic sessions: no designer, no tokens.
import { describe, expect, it } from "vitest"
import type { AgentEvent, AgentEventEnvelope } from "../../shared/types"
import { asksInChat, commonChecks, narrates, REVIEW_Q, usageOf } from "./checks"

let seq = 0
const env = (event: AgentEvent, o: { runId?: string; itemId?: string } = {}): AgentEventEnvelope => ({
  schemaVersion: 1,
  eventId: String(seq),
  seq: seq++,
  ts: new Date(0).toISOString(),
  projectId: "p",
  sessionId: "s",
  runId: o.runId ?? "r1",
  itemId: o.itemId ?? `i${seq}`,
  revision: null,
  runtime: "fake",
  event,
})
const text = (t: string) => env({ type: "message.completed", role: "assistant", kind: "text", text: t })
const tool = (name: string, id: string, isError = false, out = "") => [
  env({ type: "tool.started", name, input: {} }, { itemId: id }),
  env({ type: "tool.completed", isError, text: out, images: [] }, { itemId: id }),
]
const card = (id: string, question: string, labels: string[]) => [
  env({ type: "tool.started", name: "AskUserQuestion", input: {} }, { itemId: id }),
  env({ type: "question.requested", requestId: id, questions: [{ question, header: "", multiSelect: false, options: labels.map((label) => ({ label, description: "" })) }] }, { itemId: `q:${id}` }),
  env({ type: "tool.completed", isError: false, text: "User has answered", images: [] }, { itemId: id }),
]
const end = (runId = "r1") => env({ type: "run.completed", result: { subtype: "success", isError: false, text: "", durationMs: 1, turns: 1, usage: { tokens: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0 }, billedUsd: null, estimatedApiUsd: 0.5, billing: "plan", subscription: null, final: true } } }, { runId })

describe("parity checks", () => {
  it("chat questions and tool narration", () => {
    expect(asksInChat("Do you want me to slice it now?")).toBe(true)
    expect(asksInChat("It's ready. The base is 80 mm wide.")).toBe(false)
    expect(asksInChat("Want me to make it taller? Just say so.")).toBe(true)
    expect(narrates("I'm using the printable-openscad skill to make it")).toBe(true)
    expect(narrates("Let me read the file first.")).toBe(true)
    expect(narrates("The stand leans back 15° so your phone stays put.")).toBe(false)
    expect(REVIEW_Q.test("How does your phone stand look?")).toBe(true)
    expect(REVIEW_Q.test("How do you want it to look?")).toBe(false)
  })

  it("a clean design session passes; order, duplicates and the flow are checked", () => {
    seq = 0
    const events = [
      env({ type: "run.started", input: { text: "make me a stand" } }, { itemId: "user:r1" }),
      ...card("q1", "How will you use it?", ["Desk (Recommended)", "Bed"]),
      text("Here's a sturdy desk stand."),
      env({ type: "tool.started", name: "Write", input: { file_path: "parts/a.scad" } }, { itemId: "w" }),
      env({ type: "tool.completed", isError: false, text: "", images: [] }, { itemId: "w" }),
      ...tool("mcp__studio__render_part", "r"),
      ...tool("mcp__studio__check_part", "c"),
      ...tool("mcp__studio__share_plan", "sp"),
      ...card("q2", "How does this look?", ["Looks great (Recommended)", "Bigger"]),
      ...tool("mcp__studio__slice_part", "s"),
      ...tool("mcp__studio__preview_slice", "pv"),
      ...tool("mcp__studio__request_print", "pr"),
      end(),
    ]
    const c = commonChecks(events, ["make me a stand"], { design: true, discovery: true, printed: true })
    const failed = Object.entries(c).filter(([, x]) => x.ok === false)
    expect(failed).toEqual([])
    expect(usageOf(events)).toMatchObject({ tokens: 115, costUsd: 0.5, runs: 1 })
    expect(usageOf(events, "codex").tokens).toBe(15) // Codex's input already holds the cached part
  })

  it("flags out-of-order bubbles, a message left waiting, a chat question, a gate refusal and a design before asking", () => {
    seq = 0
    const events = [
      env({ type: "run.started", input: { text: "two" } }, { itemId: "user:r1" }),
      env({ type: "run.started", input: { text: "one" }, queued: true }, { runId: "r2", itemId: "user:r2" }),
      env({ type: "tool.started", name: "Write", input: { file_path: "parts/a.scad" } }, { itemId: "w" }),
      env({ type: "tool.completed", isError: false, text: "", images: [] }, { itemId: "w" }),
      ...card("q1", "What size?", ["Small", "Large"]),
      text("Should I print it now?"),
      ...tool("mcp__studio__slice_part", "s", true, "Not yet: the user hasn't approved this design."),
      end(),
    ]
    const c = commonChecks(events, ["one", "two"], { discovery: true, printed: true })
    expect(c.bubblesInOrder.ok).toBe(false)
    expect(c.noMessageLeftWaiting.ok).toBe(false)
    expect(c.noChatTextQuestions.ok).toBe(false)
    expect(c.everyQuestionHasRecommended.ok).toBe(false)
    expect(c.discoveryCard.ok).toBe(false)
    expect(c.noGateRefusals.ok).toBe(false)
    // an answer to a card whose turn ended arrives as its own bubble: not typed text
    expect(commonChecks(events, ["two"], { answerLines: new Set(["one"]) }).bubblesInOrder.ok).toBe(true)
  })
})
