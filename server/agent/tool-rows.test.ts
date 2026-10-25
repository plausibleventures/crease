// The designer chat (src/lib/tool-rows.ts) reads the app's own refusals (approval.ts, done.ts) as "waiting", not as
// failures: this keeps the two in step.
import { describe, expect, it } from "vitest"
import { APPROVAL_REFUSAL, BLANK_DESIGN_AGENT_REFUSAL, STALE_APPROVAL_REFUSAL } from "./approval"
import type { TimelineItem } from "../../src/lib/timeline"
import { foldRepeats, friendlyTool, toolOutcome, type ToolItem } from "../../src/lib/tool-rows"

const tool = (key: string, name: string, status: ToolItem["status"] = "done", resultText = ""): ToolItem => ({
  kind: "tool",
  key,
  id: key,
  name,
  input: {},
  partialInput: "",
  status,
  startedAt: "2026-10-10T00:00:00Z",
  endedAt: null,
  resultText,
  images: [],
  sub: false,
})
const text = (key: string): TimelineItem => ({ kind: "text", key, text: "hi", streaming: false, ts: "", sub: false })

describe("toolOutcome", () => {
  it("reads the app's refusals as waiting, with the reason in plain words", () => {
    expect(toolOutcome({ status: "error", resultText: `Error: ${APPROVAL_REFUSAL}` })).toEqual({ state: "waiting", reason: "Waits for your OK" })
    expect(toolOutcome({ status: "error", resultText: `Error: ${STALE_APPROVAL_REFUSAL}` })).toEqual({ state: "waiting", reason: "Changed since your OK" })
    expect(toolOutcome({ status: "error", resultText: `Error: ${BLANK_DESIGN_AGENT_REFUSAL}` })).toEqual({ state: "waiting", reason: "Nothing designed yet" })
    expect(toolOutcome({ status: "error", resultText: "Error: Almost there: its parts go together, so it needs its picture guide" }).reason).toBe(
      "Needs the picture guide first",
    )
  })
  it("gives a real failure its first line, or says it didn't work", () => {
    expect(toolOutcome({ status: "error", resultText: "Error: OrcaSlicer exited with code 1\nstack…" })).toEqual({ state: "failed", reason: "OrcaSlicer exited with code 1" })
    expect(toolOutcome({ status: "error", resultText: "" })).toEqual({ state: "failed", reason: "It didn't work" })
    expect(toolOutcome({ status: "done", resultText: "{}" })).toEqual({ state: "done", reason: null })
  })
})

describe("friendlyTool", () => {
  it("does not say a step happened when it didn't", () => {
    expect(friendlyTool("slice_plate")).toBe("Sliced")
    expect(friendlyTool("slice_plate", false)).toBe("Slice")
  })
})

describe("foldRepeats", () => {
  it("folds a run of the same step into one entry", () => {
    const e = foldRepeats([tool("a", "mcp__studio__slice_part"), tool("b", "mcp__studio__slice_plate", "error"), tool("c", "mcp__studio__render_part"), text("t")])
    expect(e.map((x) => (x.kind === "group" ? `${x.label}×${x.items.length}` : x.item.key))).toEqual(["Sliced×2", "c", "t"])
  })
  it("keeps running steps and questions on their own", () => {
    const e = foldRepeats([tool("a", "mcp__studio__render_part"), tool("b", "mcp__studio__render_part", "running"), tool("q", "AskUserQuestion"), tool("r", "AskUserQuestion")])
    expect(e.map((x) => x.kind)).toEqual(["item", "item", "item", "item"])
  })
})
