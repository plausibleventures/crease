// The direct API runtime's conversation store and history hygiene (R11f): append-only store with snapshots, closing
// unanswered tool calls, stripping thinking, trimming order, pricing.
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ConversationStore, estimateTokens, stripThinking, TRIMMED_IMAGE, TRIMMED_RESULT, trimHistory, unansweredToolResults, type ConvMessage } from "./conversation"
import { responseCostUsd } from "./pricing"
import { toAnthropicMessages } from "./anthropic"

const big = "y".repeat(4000)
const call = (id: string, name: string, input: unknown = {}): ConvMessage => ({ role: "assistant", content: [{ type: "thinking", text: "t", signature: "s" }, { type: "tool_use", id, name, input }] })
const result = (id: string, text: string, image = false): ConvMessage => ({
  role: "user",
  content: [{ type: "tool_result", toolUseId: id, isError: false, content: [{ type: "text", text }, ...(image ? [{ type: "image" as const, mediaType: "image/png", data: "A".repeat(100) }] : [])] }],
})

describe("conversation store", () => {
  it("appends, snapshots and replays (the last snapshot plus later messages)", () => {
    const dir = mkdtempSync(join(tmpdir(), "conv-"))
    try {
      const p = join(dir, "s.jsonl")
      const s = new ConversationStore(p)
      s.append({ role: "user", content: [{ type: "text", text: "a" }] })
      s.append({ role: "assistant", content: [{ type: "text", text: "b" }] })
      s.replace([{ role: "user", content: [{ type: "text", text: "summary" }] }], "test")
      s.append({ role: "user", content: [{ type: "text", text: "c" }] })
      expect(readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).t)).toEqual(["meta", "msg", "msg", "snapshot", "msg"])
      expect(new ConversationStore(p).load().map((m) => (m.content[0] as { text: string }).text)).toEqual(["summary", "c"])
      const copy = join(dir, "fork.jsonl")
      ConversationStore.copy(p, copy)
      expect(new ConversationStore(copy).load()).toHaveLength(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("history hygiene", () => {
  it("closes unanswered tool calls (all of them, as errors)", () => {
    const msgs: ConvMessage[] = [{ role: "user", content: [{ type: "text", text: "go" }] }, { role: "assistant", content: [{ type: "tool_use", id: "a", name: "x", input: {} }, { type: "tool_use", id: "b", name: "y", input: {} }] }]
    const fix = unansweredToolResults(msgs)!
    expect(fix.content.map((b) => (b.type === "tool_result" ? [b.toolUseId, b.isError] : null))).toEqual([
      ["a", true],
      ["b", true],
    ])
    expect(unansweredToolResults([...msgs, fix])).toBeNull()
  })

  it("strips thinking and the verbatim provider copies; empty turns get placeholder text", () => {
    const msgs: ConvMessage[] = [{ role: "assistant", content: [{ type: "thinking", text: "t", signature: "s" }], native: { protocol: "anthropic", content: [{ type: "thinking" }] } }]
    const s = stripThinking(msgs)
    expect(s.changed).toBe(true)
    expect(s.messages).toEqual([{ role: "assistant", content: [{ type: "text", text: "(no reply text)" }] }])
  })

  it("trims oldest first: tool images, then tool output, then file bodies; keeps the plan, answers, text and recent messages", () => {
    const msgs: ConvMessage[] = [
      { role: "user", content: [{ type: "text", text: "make a hook" }, { type: "image", mediaType: "image/jpeg", data: "PHOTO" }] },
      call("p", "share_plan", { title: "Hook" }),
      result("p", "plan shown " + big),
      call("q", "AskUserQuestion", { questions: [] }),
      result("q", 'User has answered: "Size"="Big" ' + big),
      call("r", "render_part", { partId: "main" }),
      result("r", "render " + big, true),
      call("w", "write_file", { path: "parts/a.scad", content: big }),
      result("w", "Wrote parts/a.scad"),
      { role: "assistant", content: [{ type: "text", text: "Here it is." }] },
      { role: "user", content: [{ type: "text", text: "bigger" }] },
      call("z", "render_part", {}),
      result("z", "recent " + big),
    ]
    const t = trimHistory(msgs, 3000, 2)!
    expect(t.after).toBeLessThan(t.before)
    const all = JSON.stringify(t.messages)
    expect(all).not.toContain('"thinking"')
    expect(all).toContain("PHOTO") // the user's photo stays
    expect(all).toContain("plan shown") // share_plan result stays
    expect(all).toContain("User has answered") // answers stay
    expect(all).toContain("Here it is.")
    expect(all).toContain("recent ") // the last messages stay
    const render = t.messages[6].content[0]
    expect(render.type === "tool_result" && render.content).toEqual([{ type: "text", text: TRIMMED_RESULT }])
    const w = t.messages[7].content.find((b) => b.type === "tool_use")
    expect(w?.type === "tool_use" && (w.input as { content: string }).content).toMatch(/^\[4000 characters, removed/)
    // images go before text when that's enough
    const light = trimHistory(msgs, estimateTokens(msgs) - 1000, 2)!
    const r6 = light.messages[6].content[0]
    expect(r6.type === "tool_result" && r6.content.map((c) => (c.type === "text" ? c.text.slice(0, 7) : c.type))).toEqual(["render ", TRIMMED_IMAGE.slice(0, 7)])
    expect(trimHistory([{ role: "user", content: [{ type: "text", text: "hi" }] }], 10)).toBeNull()
  })

  it("toAnthropicMessages: untouched turns verbatim, rebuilt turns skip unsigned thinking and empty text", () => {
    const out = toAnthropicMessages([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [], native: { protocol: "anthropic", content: [{ type: "thinking", thinking: "x", signature: "s" }, { type: "text", text: "a" }] } },
      { role: "assistant", content: [{ type: "thinking", text: "local reasoning" }, { type: "text", text: "" }, { type: "tool_use", id: "t", name: "n", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t", isError: true, content: [] }] },
    ])
    expect(out[1].content).toEqual([{ type: "thinking", thinking: "x", signature: "s" }, { type: "text", text: "a" }])
    expect(out[2].content).toEqual([{ type: "tool_use", id: "t", name: "n", input: {} }])
    expect(out[3].content).toEqual([{ type: "tool_result", tool_use_id: "t", is_error: true, content: [{ type: "text", text: "(no output)" }] }])
  })
})

describe("pricing (published prices, first-party API only)", () => {
  it("prices known models, Haiku 5.5's long-prompt tier, and refuses to guess unknown ones", () => {
    expect(responseCostUsd("claude-opus-5-5", { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 })).toBeCloseTo(4 + 20 + 0.2 + 5, 9)
    expect(responseCostUsd("claude-sonnet-5-5", { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(2, 9)
    expect(responseCostUsd("claude-haiku-5-5", { input: 50_000, output: 1e6, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(0.005 + 0.5, 9)
    expect(responseCostUsd("claude-haiku-5-5", { input: 200_000, output: 1e6, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(0.1 + 2.5, 9)
    expect(responseCostUsd("gpt-something", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })).toBeNull()
    expect(responseCostUsd("claude-opus-5-5-20990101", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })).toBeNull()
  })
})
