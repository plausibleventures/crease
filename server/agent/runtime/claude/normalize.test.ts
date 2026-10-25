// Claude SDK messages -> normalized events: the streamed/complete pairing, tool calls, sub-agents, echoes and ends.
import { describe, expect, it } from "vitest"
import { ClaudeNormalizer, type NormalizedEvent } from "./normalize"

const opts = { billing: "plan" as const }
const se = (event: unknown, parent: string | null = null) => ({ type: "stream_event", event, parent_tool_use_id: parent })
const kept = (evs: NormalizedEvent[]) => evs.filter((e) => e.persist).map((e) => ({ ...e.event, itemId: e.itemId }))

describe("ClaudeNormalizer", () => {
  it("streams text live, keeps it once at block stop, and doesn't repeat it when the assistant message matches", () => {
    const n = new ClaudeNormalizer()
    const live: NormalizedEvent[] = []
    for (const m of [
      se({ type: "message_start", message: { id: "msg1" } }),
      se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }),
      se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }),
      se({ type: "content_block_stop", index: 0 }),
    ])
      live.push(...n.convert(m, "b", opts))
    expect(live.filter((e) => !e.persist).map((e) => (e.event.type === "message.delta" ? e.event.delta : ""))).toEqual(["", "Hel", "lo"])
    expect(kept(live)).toEqual([{ type: "message.completed", role: "assistant", kind: "text", text: "Hello", parentToolId: null, stepId: "msg1", itemId: "t:msg1#0" }])
    // the complete message: same text, nothing new
    expect(n.convert({ type: "assistant", uuid: "u1", message: { id: "msg1", content: [{ type: "text", text: "Hello" }] } }, "b2", opts)).toEqual([])
  })

  it("an assistant message without a stream (or with different text) makes its own item", () => {
    const n = new ClaudeNormalizer()
    const evs = n.convert({ type: "assistant", uuid: "u1", message: { id: "m", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "  " }, { type: "text", text: "Hi" }] } }, "b", opts)
    expect(kept(evs).map((e) => [e.type, e.itemId])).toEqual([
      ["message.completed", "u1:0"],
      ["message.completed", "u1:2"],
    ])
  })

  it("tool calls: started at the stream (input fragments live), input from the assistant message, result from the user message", () => {
    const n = new ClaudeNormalizer()
    const evs = [
      se({ type: "message_start", message: { id: "m2" } }),
      se({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "mcp__studio__render_part", input: {} } }),
      se({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"partId":' } }),
      se({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"hook"}' } }),
      se({ type: "content_block_stop", index: 1 }),
      { type: "assistant", uuid: "u2", message: { id: "m2", content: [{ type: "tool_use", id: "toolu_1", name: "mcp__studio__render_part", input: { partId: "hook" } }] } },
      {
        type: "user",
        uuid: "u3",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: false, content: [{ type: "text", text: "ok" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }] }] },
      },
    ].flatMap((m, i) => n.convert(m, `b${i}`, opts))
    expect(evs.filter((e) => !e.persist).map((e) => e.event)).toEqual([
      { type: "tool.started", name: "mcp__studio__render_part", inputDelta: '{"partId":', parentToolId: null },
      { type: "tool.started", name: "mcp__studio__render_part", inputDelta: '"hook"}', parentToolId: null },
      { type: "tool.started", name: "mcp__studio__render_part", input: { partId: "hook" }, parentToolId: null },
    ])
    expect(kept(evs)).toEqual([
      { type: "tool.started", name: "mcp__studio__render_part", parentToolId: null, stepId: "m2", itemId: "toolu_1" },
      { type: "tool.started", name: "mcp__studio__render_part", input: { partId: "hook" }, parentToolId: null, stepId: "m2", itemId: "toolu_1" },
      { type: "tool.completed", isError: false, text: "ok", images: [{ mediaType: "image/png", data: "AAA" }], itemId: "toolu_1" },
    ])
  })

  it("sub-agent messages carry their parent; echoes of the user's input and slash commands are dropped", () => {
    const n = new ClaudeNormalizer()
    n.userInput("make a hook")
    expect(n.convert({ type: "user", uuid: "a", message: { content: "make a hook" } }, "b", opts)).toEqual([])
    expect(n.convert({ type: "user", uuid: "b", message: { content: "<local-command-stdout>Set model to haiku</local-command-stdout>" } }, "b", opts)).toEqual([])
    expect(kept(n.convert({ type: "user", uuid: "c", message: { content: [{ type: "text", text: "and blue" }] } }, "b", opts))).toEqual([
      { type: "message.completed", role: "user", kind: "text", text: "and blue", itemId: "c" },
    ])
    const sub = n.convert({ type: "assistant", uuid: "d", parent_tool_use_id: "toolu_task", message: { id: "x", content: [{ type: "text", text: "sub" }] } }, "b", opts)
    expect(sub[0].event).toMatchObject({ parentToolId: "toolu_task" })
  })

  it("init once, compaction, results (completed / failed / interrupted) with usage kept apart from billing", () => {
    const n = new ClaudeNormalizer()
    const init = { type: "system", subtype: "init", model: "opus", cwd: "/p" }
    expect(kept(n.convert(init, "i", opts))).toEqual([{ type: "notice", level: "info", code: "session.started", text: "Session started · opus", data: { model: "opus", cwd: "/p", version: null }, itemId: "init:i" }])
    expect(n.convert(init, "i2", opts)).toEqual([])
    expect(kept(n.convert({ type: "system", subtype: "compact_boundary" }, "c", opts))[0]).toMatchObject({ code: "context.compacted" })
    expect(n.convert({ type: "rate_limit_event" }, "r", opts)).toEqual([])
    const result = { type: "result", subtype: "success", is_error: false, result: "done", duration_ms: 5, num_turns: 3, total_cost_usd: 0.2, studio_cost_usd: 0.5, usage: { input_tokens: 10, output_tokens: 20 } }
    expect(n.convert(result, "e", opts)[0].event).toEqual({
      type: "run.completed",
      result: {
        subtype: "success",
        isError: false,
        text: "done",
        durationMs: 5,
        turns: 3,
        queued: null,
        usage: { tokens: { input: 10, output: 20, cacheRead: null, cacheWrite: null }, billedUsd: null, estimatedApiUsd: 0.5, billing: "plan", subscription: null, final: true },
      },
    })
    expect(n.convert(result, "e", { billing: "api" })[0].event).toMatchObject({ result: { usage: { billedUsd: 0.5, estimatedApiUsd: 0.5 } } })
    expect(n.convert({ ...result, subtype: "error_max_turns", is_error: true, result: undefined, errors: ["too many"] }, "e", opts)[0].event).toMatchObject({ type: "run.failed", error: "too many" })
    expect(n.convert({ ...result, subtype: "error_during_execution", is_error: true }, "e", { ...opts, interrupted: true })[0].event.type).toBe("run.interrupted")
    expect(n.convert({ type: "mystery", x: 1 }, "m", opts)[0]).toMatchObject({ event: { type: "native", message: { type: "mystery" } }, itemId: "m" })
  })
})

describe("Stop with an open question card", () => {
  it("the SDK's 'returned an error result' after Stop ends quietly; the same error without a Stop is shown", async () => {
    const { stoppedQuietly } = await import("./adapter")
    const e = new Error("Claude Code returned an error result: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use")
    expect(stoppedQuietly(e, true)).toBe(true)
    expect(stoppedQuietly(e, false)).toBe(false)
    expect(stoppedQuietly(new Error("process exited with code 1"), true)).toBe(false)
  })
})
