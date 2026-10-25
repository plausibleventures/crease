// The chat's user bubbles: a message sent while the designer was busy shows as waiting until the designer reads it
// (input.status received), or as not read when Stop came first.
import { describe, expect, it } from "vitest"
import type { AgentEvent, AgentEventEnvelope } from "../../shared/types"
import { applyEvent, emptyTimeline, type TimelineState } from "./timeline"

let seq = 0
const env = (event: AgentEvent, runId: string, itemId: string): AgentEventEnvelope => ({
  schemaVersion: 1,
  eventId: String(seq),
  seq: seq++,
  ts: "2026-10-10T00:00:00.000Z",
  projectId: "p",
  sessionId: "s",
  runId,
  itemId,
  revision: null,
  runtime: "app",
  event,
})
const started = (runId: string, text: string, queued?: boolean) => env({ type: "run.started", input: { text }, ...(queued ? { queued } : {}) }, runId, `user:${runId}`)
const status = (runId: string, s: "received" | "dropped") => env({ type: "input.status", status: s }, runId, `input:${runId}`)
const bubbles = (tl: TimelineState) => tl.items.flatMap((it) => (it.kind === "user" ? [[it.text, it.delivery ?? "sent"]] : []))

describe("queued messages in the timeline", () => {
  it("waiting until received, not read when dropped; the first message is never waiting", () => {
    let tl = emptyTimeline()
    for (const e of [started("r1", "one"), started("r2", "two", true), started("r3", "three", true)]) tl = applyEvent(tl, e)
    expect(bubbles(tl)).toEqual([
      ["one", "sent"],
      ["two", "waiting"],
      ["three", "waiting"],
    ])
    tl = applyEvent(tl, status("r2", "received"))
    tl = applyEvent(tl, status("r3", "dropped"))
    expect(bubbles(tl)).toEqual([
      ["one", "sent"],
      ["two", "sent"],
      ["three", "dropped"],
    ])
    expect(tl.items).toHaveLength(3) // no rows of their own
  })
})
