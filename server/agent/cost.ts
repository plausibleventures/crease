// Live cost estimate during a turn, from token usage on assistant/stream messages.
//
// These are API-EQUIVALENT ESTIMATES at list prices (USD per million tokens). On a claude.ai plan login the user
// isn't billed this. The authoritative number is `result.total_cost_usd`, which we reconcile to at the end of
// every turn, so this table only has to be roughly right. One place to update when prices change.
// cacheWrite: Claude Code writes 1-hour cache entries (2× input). cacheRead defaults to 0.1× input.
// Fitted against the CLI's own modelUsage.costUSD (least squares over real sessions, Oct 2026):
// haiku-4-5 = 1 / 5 / 0.1 / 2 and opus-5-5 = 4 / 20 / 0.2 / 8 ($/MTok in / out / cache read / cache write).
// Unknown or new models are calibrated at runtime (see calibrate()).
type Price = { input: number; output: number; cacheRead?: number; cacheWrite?: number }
const PRICES: { match: RegExp; price: Price }[] = [
  { match: /opus-4-[01]\b|opus-4-20|claude-3-opus/, price: { input: 15, output: 75 } }, // older Opus
  { match: /opus-4/, price: { input: 5, output: 25 } },
  { match: /opus/, price: { input: 4, output: 20, cacheRead: 0.2 } },
  { match: /sonnet-5/, price: { input: 2, output: 10 } },
  { match: /sonnet/, price: { input: 3, output: 15 } },
  { match: /haiku-3|3-haiku/, price: { input: 0.25, output: 1.25 } },
  { match: /haiku/, price: { input: 1, output: 5 } },
]
const FALLBACK: Price = { input: 3, output: 15 }
const CACHE_WRITE = 2 // × input price (1-hour cache)
const CACHE_READ = 0.1 // × input price

// Per-model correction from the authoritative modelUsage.costUSD on each result (actual / table estimate).
const factor = new Map<string, number>()

export interface TokenUsage {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}

function tableEstimate(model: string | undefined, u: TokenUsage): number {
  const p = PRICES.find((x) => x.match.test(model ?? ""))?.price ?? FALLBACK
  const n = (v: number | null | undefined) => (typeof v === "number" && isFinite(v) ? v : 0)
  return (
    (n(u.input_tokens) * p.input +
      n(u.cache_creation_input_tokens) * (p.cacheWrite ?? p.input * CACHE_WRITE) +
      n(u.cache_read_input_tokens) * (p.cacheRead ?? p.input * CACHE_READ) +
      n(u.output_tokens) * p.output) /
    1e6
  )
}

export function estimateCostUsd(model: string | undefined, u: TokenUsage): number {
  return tableEstimate(model, u) * (factor.get(model ?? "") ?? 1)
}

/**
 * Learn a per-model correction from a result's modelUsage ({model: {inputTokens, outputTokens, cacheReadInputTokens,
 * cacheCreationInputTokens, costUSD}}), so live estimates track the CLI's own pricing, including models newer than
 * this table.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function calibrate(modelUsage: Record<string, any> | undefined) {
  for (const [model, mu] of Object.entries(modelUsage ?? {})) {
    if (typeof mu?.costUSD !== "number" || mu.costUSD <= 0) continue
    const est = tableEstimate(model, {
      input_tokens: mu.inputTokens,
      output_tokens: mu.outputTokens,
      cache_read_input_tokens: mu.cacheReadInputTokens,
      cache_creation_input_tokens: mu.cacheCreationInputTokens,
    })
    if (est > 0) factor.set(model, Math.min(3, Math.max(0.3, mu.costUSD / est)))
  }
}

/**
 * Tracks one API message at a time. Usage arrives several times per message (stream message_start,
 * each assistant content block, message_delta with the final output count), so we keep the latest/max
 * usage per message id and sum the estimates.
 */
export class TurnEstimator {
  private perMsg = new Map<string, { model?: string; usage: TokenUsage }>()
  private current: string | null = null

  reset() {
    this.perMsg.clear()
    this.current = null
  }

  /** Feed any SDK message; returns true if the estimate changed. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  observe(m: any): boolean {
    if (m?.type === "stream_event") {
      const ev = m.event
      if (ev?.type === "message_start" && ev.message?.id) {
        this.current = ev.message.id
        return this.merge(ev.message.id, ev.message.model, ev.message.usage)
      }
      if (ev?.type === "message_delta" && this.current && ev.usage) return this.merge(this.current, undefined, ev.usage)
      return false
    }
    if (m?.type === "assistant" && m.message?.id) return this.merge(m.message.id, m.message.model, m.message.usage)
    return false
  }

  private merge(id: string, model: string | undefined, u: TokenUsage | undefined): boolean {
    if (!u) return false
    const prev = this.perMsg.get(id)
    const max = (a?: number | null, b?: number | null) => Math.max(a ?? 0, b ?? 0)
    const next: TokenUsage = {
      input_tokens: max(prev?.usage.input_tokens, u.input_tokens),
      output_tokens: max(prev?.usage.output_tokens, u.output_tokens),
      cache_creation_input_tokens: max(prev?.usage.cache_creation_input_tokens, u.cache_creation_input_tokens),
      cache_read_input_tokens: max(prev?.usage.cache_read_input_tokens, u.cache_read_input_tokens),
    }
    const before = prev ? estimateCostUsd(prev.model, prev.usage) : 0
    const entry = { model: model ?? prev?.model, usage: next }
    this.perMsg.set(id, entry)
    return estimateCostUsd(entry.model, next) !== before
  }

  get usd(): number {
    let t = 0
    for (const e of this.perMsg.values()) t += estimateCostUsd(e.model, e.usage)
    return t
  }
}
