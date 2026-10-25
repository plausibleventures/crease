// Old sessions still render (R11a): a legacy transcript (raw Claude SDK messages, as stored before normalized events)
// goes through migrate-on-read and the renderer's reducer, and comes out as the timeline it always showed. A live
// Claude stream (with partial deltas) renders the same items as its persisted replay.
// (Checked against the pre-R11a reducer on every real session at the time: identical items.)
import { describe, expect, it } from "vitest"
import type { AgentEventEnvelope } from "../../shared/types"
import { applyEvent, emptyTimeline, type TimelineState } from "../../src/lib/timeline"
import { ClaudeNormalizer } from "./runtime/claude/normalize"
import { LegacyMigrator } from "./transcript"

const SID = "legacy"
const legacyLines = [
  { type: "user_input", text: "make me a hook", images: [{ mediaType: "image/png", data: "AAAA" }] },
  { type: "system", subtype: "init", model: "claude-opus-5-5", cwd: "/Users/someone/PrintStudio/projects/hook" },
  { type: "user", message: { content: "make me a hook" } }, // Claude Code's echo of the input
  { type: "assistant", uuid: "a1", message: { id: "m1", content: [{ type: "thinking", thinking: "A J-hook." }] } },
  { type: "assistant", uuid: "a2", message: { id: "m1", content: [{ type: "text", text: "I'll make a hook." }] } },
  { type: "assistant", uuid: "a3", message: { id: "m1", content: [{ type: "tool_use", id: "toolu_r", name: "mcp__studio__render_part", input: { partId: "hook" } }] } },
  { type: "system", subtype: "status" },
  { type: "user", uuid: "u1", message: { content: [{ type: "tool_result", tool_use_id: "toolu_r", content: [{ type: "text", text: "{}" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "BBBB" } }] }] } },
  { type: "assistant", uuid: "a4", parent_tool_use_id: "toolu_task", message: { id: "m2", content: [{ type: "text", text: "(subagent)" }] } },
  { type: "assistant", uuid: "a5", message: { id: "m3", content: [{ type: "tool_use", id: "toolu_x", name: "Bash", input: { command: "ls" } }] } },
  { type: "rate_limit_event", rate_limit_info: {} },
  { type: "result", subtype: "success", is_error: false, result: "Done", duration_ms: 5000, num_turns: 4, total_cost_usd: 0.1, studio_cost_usd: 0.25 },
  { type: "app_notice", text: "Model switched to haiku" },
  { type: "app_error", error: "interrupt failed: no session" },
  { type: "result", subtype: "error_during_execution", is_error: true, errors: ["stopped"], duration_ms: 10, num_turns: 1, total_cost_usd: 0.3 },
  { type: "mystery_message", x: 1 },
]

function replay(envs: AgentEventEnvelope[]): TimelineState {
  let tl = emptyTimeline()
  for (const e of envs) tl = applyEvent(tl, e)
  return tl
}

describe("legacy transcripts render as before", () => {
  it("migrated events -> the same items the old reducer produced", () => {
    const m = new LegacyMigrator()
    const envs = legacyLines.flatMap((message, seq) => m.migrate({ projectId: "p", sessionId: SID, seq, ts: `t${seq}`, message }))
    const tl = replay(envs)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const items = tl.items.map(({ key, ...rest }) => ("detail" in rest ? { ...rest, detail: undefined } : rest))
    expect(tl.root).toBe("/Users/someone/PrintStudio/projects/hook")
    expect(items).toEqual([
      { kind: "user", text: "make me a hook", ts: "t0", images: [{ mediaType: "image/png", data: "AAAA" }] },
      { kind: "system", ts: "t1", label: "Session started · claude-opus-5-5", detail: undefined },
      { kind: "thinking", text: "A J-hook.", streaming: false, ts: "t3" },
      { kind: "text", text: "I'll make a hook.", streaming: false, ts: "t4", sub: false },
      {
        kind: "tool",
        id: "toolu_r",
        name: "mcp__studio__render_part",
        input: { partId: "hook" },
        partialInput: "",
        status: "done",
        startedAt: "t5",
        endedAt: "t7",
        resultText: "{}",
        images: [{ mediaType: "image/png", data: "BBBB" }],
        sub: false,
      },
      { kind: "text", text: "(subagent)", streaming: false, ts: "t8", sub: true },
      // still running when the turn ended: closed by the result
      { kind: "tool", id: "toolu_x", name: "Bash", input: { command: "ls" }, partialInput: "", status: "done", startedAt: "t9", endedAt: "t11", resultText: "", images: [], sub: false },
      { kind: "result", ts: "t11", subtype: "success", isError: false, costUsd: 0.25, durationMs: 5000, turns: 4, text: "Done" },
      { kind: "system", ts: "t12", label: "Model switched to haiku", detail: undefined },
      { kind: "error", ts: "t13", text: "interrupt failed: no session" },
      { kind: "result", ts: "t14", subtype: "error_during_execution", isError: true, costUsd: 0.3, durationMs: 10, turns: 1, text: "stopped" },
      { kind: "raw", ts: "t15", json: { type: "mystery_message", x: 1 } },
    ])
    // replaying twice (reconnect, duplicate delivery) changes nothing
    let again = tl
    for (const e of envs) again = applyEvent(again, e)
    expect(again.items).toEqual(tl.items)
  })

  it("a sign-in failure shows one error with its code (the sign-in button), not the raw authentication_failed", () => {
    const m = new LegacyMigrator()
    const lines = [
      { type: "assistant", uuid: "a1", error: "authentication_failed", message: { id: "m1", content: [{ type: "text", text: "Not logged in · Please run /login" }] } },
      { type: "app_error", code: "claude_auth", error: "Sign in please" },
    ]
    const tl = replay(lines.flatMap((message, seq) => m.migrate({ projectId: "p", sessionId: SID, seq, ts: `t${seq}`, message })))
    expect(tl.items.filter((i) => i.kind === "error")).toEqual([{ kind: "error", key: "l1", ts: "t1", text: "Sign in please", code: "claude_auth" }])
  })

  it("a live stream renders the same items as its persisted replay", () => {
    const n = new ClaudeNormalizer()
    const stream = [
      { type: "stream_event", event: { type: "message_start", message: { id: "m1" } } },
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Making " } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "it." } } },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      { type: "assistant", uuid: "a1", message: { id: "m1", content: [{ type: "text", text: "Making it." }] } },
      { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "Read", input: {} } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"file_path":"a"}' } } },
      { type: "stream_event", event: { type: "content_block_stop", index: 1 } },
      { type: "assistant", uuid: "a2", message: { id: "m1", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a" } }] } },
      { type: "user", uuid: "u1", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file a" }] } },
      { type: "result", uuid: "r1", subtype: "success", is_error: false, result: "", duration_ms: 1, num_turns: 1, total_cost_usd: 0.01 },
    ]
    let seq = 0
    const live: AgentEventEnvelope[] = []
    for (const m of stream)
      for (const e of n.convert(m, `b${seq}`, { billing: "plan" }))
        live.push({ schemaVersion: 1, eventId: String(seq), seq: seq++, ts: "t", projectId: "p", sessionId: SID, runId: "r", itemId: e.itemId, revision: null, runtime: "claude", event: e.event, ...(e.persist ? {} : { live: true }) } as AgentEventEnvelope)
    const liveTl = replay(live)
    const persisted = replay(live.filter((e) => !(e as { live?: boolean }).live))
    // (live tool rows also keep the streamed input text, as before; the parsed input is the same)
    const strip = (t: TimelineState) => t.items.map((i) => (i.kind === "tool" ? { ...i, partialInput: "" } : i))
    expect(strip(liveTl)).toEqual(strip(persisted))
    expect(liveTl.items.map((i) => i.kind)).toEqual(["text", "tool", "result"])
    expect(liveTl.items[0]).toMatchObject({ text: "Making it.", streaming: false })
    expect(liveTl.items[1]).toMatchObject({ input: { file_path: "a" }, status: "done", resultText: "file a" })
  })
})
