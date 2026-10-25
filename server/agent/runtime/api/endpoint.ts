// Endpoint layer of the direct API runtime (R11f): one implementation per wire protocol. The loop (adapter.ts) only
// sees this interface: a model request in the neutral conversation shape, streamed back as callbacks, ending in one
// assistant message + usage + why it stopped. Protocols: anthropic.ts (Anthropic Messages API, tested live-shaped
// against a scripted server), openai.ts (OpenAI-compatible Chat Completions; scripted server only, see ENDPOINTS).
import type { ApiProtocol } from "../../../../shared/types"
import type { ConvMessage } from "./conversation"

export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema of the input object (no $schema). */
  inputSchema: Record<string, unknown>
}

export interface ModelRequest {
  model: string
  /** Frozen for the session (preserved thinking + prompt caching need a stable prefix). */
  system: string
  tools: ToolSpec[]
  messages: ConvMessage[]
  maxTokens: number
  effort?: string | null
}

/** Live callbacks while a response streams. Block indexes are the provider's (stable within one response). */
export interface StreamSink {
  text(index: number, delta: string): void
  thinking(index: number, delta: string): void
  /** A tool call began (name known) or its input grew. */
  toolStart(index: number, id: string, name: string): void
  toolInput(index: number, id: string, delta: string): void
  /** A text/thinking block finished (full text). */
  blockDone(index: number, kind: "text" | "thinking", text: string): void
}

export interface Usage {
  /** Uncached input tokens. */
  input: number | null
  output: number | null
  cacheRead: number | null
  cacheWrite: number | null
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "stop_sequence" | "pause_turn" | "other"

export interface ModelResponse {
  message: ConvMessage
  stop: StopReason
  /** The provider's raw stop reason (logs). */
  rawStop: string | null
  usage: Usage
  /** Model that answered (as the provider reports it). */
  model: string | null
  /** Tool calls whose input wasn't valid JSON: raw text by tool_use id (answered with an INVALID_JSON error). */
  badJson: Record<string, string>
  /** Provider message id (logs). */
  id: string | null
}

/** A failed request, classified for the loop. */
export class EndpointError extends Error {
  constructor(
    message: string,
    readonly kind: "auth" | "rate_limit" | "overloaded" | "server" | "connection" | "bad_request" | "not_found" | "thinking_signature" | "bad_stream" | "other",
    readonly status: number | null = null,
    /** Seconds the provider asked us to wait (retry-after). */
    readonly retryAfter: number | null = null
  ) {
    super(message)
  }
  get retryable() {
    return this.kind === "rate_limit" || this.kind === "overloaded" || this.kind === "server" || this.kind === "connection" || this.kind === "bad_stream"
  }
}

export interface Endpoint {
  readonly protocol: ApiProtocol
  /** Base URL in use (for logs and the pricing decision). */
  readonly baseUrl: string
  /** Free: the endpoint's model list. Throws EndpointError. */
  listModels(signal?: AbortSignal): Promise<{ value: string; label: string }[]>
  /** One streamed model response. Throws EndpointError (aborts: the signal's reason). */
  stream(req: ModelRequest, sink: StreamSink, signal: AbortSignal): Promise<ModelResponse>
}

export const noSink: StreamSink = { text() {}, thinking() {}, toolStart() {}, toolInput() {}, blockDone() {} }

/** retry-after header (seconds or HTTP date) -> seconds. */
export function retryAfterSeconds(h: string | null | undefined): number | null {
  if (!h) return null
  const n = Number(h)
  if (Number.isFinite(n)) return Math.max(0, n)
  const t = Date.parse(h)
  return Number.isFinite(t) ? Math.max(0, (t - Date.now()) / 1000) : null
}

/** What each protocol has been tested against (shown on the Agents card; anything else is "untested"). */
export const ENDPOINTS: Record<ApiProtocol, { label: string; defaultUrl: string | null; tested: string; untested: string }> = {
  anthropic: {
    label: "Anthropic (Claude API)",
    defaultUrl: "https://api.anthropic.com",
    tested: "streaming, tool calls (incl. streamed input), images, prompt caching, usage, retries",
    untested: "",
  },
  "openai-chat": {
    label: "OpenAI-compatible (Chat Completions)",
    defaultUrl: null,
    tested: "a scripted Chat Completions server only (streamed tool-call deltas, images, usage)",
    untested: "real servers (OpenAI, Ollama, LM Studio …): tool calls, images and usage reporting vary by server and model",
  },
}
