import { describe, expect, it } from "vitest"
import { calibrate, estimateCostUsd, TurnEstimator } from "./cost"

describe("live cost estimate", () => {
  it("matches the CLI's own pricing for known models", () => {
    // real modelUsage rows (costUSD from the CLI)
    const opus = estimateCostUsd("claude-opus-5-5", { input_tokens: 10, output_tokens: 5109, cache_read_input_tokens: 175385, cache_creation_input_tokens: 27853 })
    expect(opus).toBeCloseTo(0.3601, 3)
    const haiku = estimateCostUsd("claude-haiku-4-5-20251001", { input_tokens: 1059, output_tokens: 10577, cache_read_input_tokens: 913178, cache_creation_input_tokens: 70158 })
    expect(haiku).toBeCloseTo(0.2856, 3)
  })

  it("counts each API message once across stream events and per-block assistant frames", () => {
    const t = new TurnEstimator()
    const usage = { input_tokens: 10, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 5_000, output_tokens: 1 }
    t.observe({ type: "stream_event", event: { type: "message_start", message: { id: "m1", model: "claude-haiku-4-5", usage } } })
    t.observe({ type: "assistant", message: { id: "m1", model: "claude-haiku-4-5", usage } }) // thinking block
    t.observe({ type: "assistant", message: { id: "m1", model: "claude-haiku-4-5", usage } }) // text block
    t.observe({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 400 } } })
    t.observe({ type: "assistant", message: { id: "m1", model: "claude-haiku-4-5", usage: { ...usage, output_tokens: 3 } } }) // stale count
    const once = estimateCostUsd("claude-haiku-4-5", { ...usage, output_tokens: 400 })
    expect(t.usd).toBeCloseTo(once, 9)
  })

  it("calibrates unknown models from modelUsage.costUSD", () => {
    const u = { input_tokens: 0, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    const before = estimateCostUsd("claude-future-9", u)
    calibrate({ "claude-future-9": { inputTokens: 0, outputTokens: 1000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: before * 2 } })
    expect(estimateCostUsd("claude-future-9", u)).toBeCloseTo(before * 2, 9)
  })
})
