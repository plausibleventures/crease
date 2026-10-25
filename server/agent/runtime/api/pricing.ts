// What a direct API response cost (R11f): the provider's reported tokens times Anthropic's published per-token prices
// (USD per million tokens, first-party API, from Anthropic's model/pricing tables as of 2026-10). Only for the
// first-party Anthropic API and models in this table: any other endpoint or model is "unknown" (null), never guessed.
// Cache writes are 5-minute entries (1.25x input); cache reads are 0.1x input except where the table says otherwise.
import type { Usage } from "./endpoint"

export interface ModelPrice {
  input: number
  output: number
  cacheRead: number
  /** Claude Haiku 5.5: prompts over 100K tokens are billed at these rates instead. */
  over100k?: { input: number; output: number; cacheRead: number }
}

const p = (input: number, output: number, cacheRead = input * 0.1): ModelPrice => ({ input, output, cacheRead })

/** Exact model ids (no date suffixes) -> price. */
export const ANTHROPIC_PRICES: Record<string, ModelPrice> = {
  "claude-fable-5-1": p(10, 50, 0.25),
  "claude-mythos-5-1": p(10, 50, 0.25),
  "claude-fable-5": p(10, 50, 1),
  "claude-opus-5-5": p(4, 20, 0.2),
  "claude-opus-5": p(5, 25),
  "claude-opus-4-8": p(5, 25),
  "claude-opus-4-7": p(5, 25),
  "claude-opus-4-6": p(5, 25),
  "claude-sonnet-5-5": p(2, 10, 0.2),
  "claude-sonnet-5": p(2, 10, 0.2),
  "claude-sonnet-4-6": p(3, 15),
  "claude-haiku-5-5": { ...p(0.1, 0.5, 0.01), over100k: { input: 0.5, output: 2.5, cacheRead: 0.05 } },
  "claude-haiku-4-5": p(1, 5),
}

export const CACHE_WRITE_MULTIPLIER = 1.25

export function priceOf(model: string | null | undefined): ModelPrice | null {
  return (model && ANTHROPIC_PRICES[model]) || null
}

/** USD for one response, or null when the model isn't priced. */
export function responseCostUsd(model: string | null | undefined, u: Usage): number | null {
  const price = priceOf(model)
  if (!price) return null
  const n = (v: number | null) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
  const prompt = n(u.input) + n(u.cacheRead) + n(u.cacheWrite)
  const r = price.over100k && prompt > 100_000 ? price.over100k : price
  return (n(u.input) * r.input + n(u.cacheWrite) * r.input * CACHE_WRITE_MULTIPLIER + n(u.cacheRead) * r.cacheRead + n(u.output) * r.output) / 1e6
}

/** Models offered before the endpoint's own list is read (the Anthropic API's current models, best first). */
export const ANTHROPIC_SUGGESTED_MODELS = [
  { value: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { value: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
  { value: "claude-fable-5-1", label: "Claude Fable 5.1" },
]
export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5"
