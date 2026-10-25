// Anthropic Messages API endpoint (R11f) through the official SDK (@anthropic-ai/sdk): streaming, tool use (input
// streamed eagerly on the first-party API), images (base64), prompt caching (system block + automatic breakpoint),
// adaptive thinking with summaries on models that have it, usage. Retries are the loop's (maxRetries: 0 here), so
// overloaded errors in the middle of a stream are retried the same way as a 429/5xx before it.
//
// The raw event stream is consumed (not the SDK's accumulating helper) because the app needs each block as it
// streams (timeline), the exact blocks back (thinking signatures, for preserved thinking) and a strict parse of tool
// input (a truncated or malformed input becomes an INVALID_JSON tool error, never a silently partial call).
import Anthropic from "@anthropic-ai/sdk"
import type { ConvBlock, ConvMessage } from "./conversation"
import { EndpointError, retryAfterSeconds, type Endpoint, type ModelRequest, type ModelResponse, type StopReason, type StreamSink, type Usage } from "./endpoint"

/* eslint-disable @typescript-eslint/no-explicit-any */

export const ANTHROPIC_DEFAULT_URL = "https://api.anthropic.com"

/** Models with adaptive thinking (+ effort): Opus 4.6+, Sonnet 4.6+, Haiku 5.x, Fable, Mythos. Others get neither. */
export function adaptiveThinking(model: string): boolean {
  return /^claude-(opus-(4-[6-9]|5)|sonnet-(4-6|5)|haiku-5|fable|mythos)/.test(model)
}

export interface AnthropicOptions {
  apiKey: string
  baseUrl?: string | null
  /** Stream tool input as it's generated (eager_input_streaming). Default: only on the first-party API (proxies may reject it). */
  eagerInputStreaming?: boolean
  /** Per-request timeout, ms. */
  timeoutMs?: number
}

function toImage(b: { mediaType: string; data: string }): Anthropic.ImageBlockParam {
  return { type: "image", source: { type: "base64", media_type: b.mediaType as Anthropic.Base64ImageSource["media_type"], data: b.data } }
}

/** Neutral history -> Messages API messages. Untouched Anthropic turns go back verbatim. */
export function toAnthropicMessages(messages: ConvMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = []
  for (const m of messages) {
    if (m.role === "assistant") {
      if (m.native?.protocol === "anthropic" && Array.isArray(m.native.content) && m.native.content.length) {
        out.push({ role: "assistant", content: m.native.content as Anthropic.ContentBlockParam[] })
        continue
      }
      const content: Anthropic.ContentBlockParam[] = []
      for (const b of m.content) {
        if (b.type === "text" && b.text.trim()) content.push({ type: "text", text: b.text })
        else if (b.type === "thinking" && b.redacted) content.push({ type: "redacted_thinking", data: b.redacted })
        else if (b.type === "thinking" && b.signature) content.push({ type: "thinking", thinking: b.text, signature: b.signature })
        else if (b.type === "tool_use") content.push({ type: "tool_use", id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> })
      }
      out.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: "(no reply text)" }] })
      continue
    }
    const content: Anthropic.ContentBlockParam[] = []
    for (const b of m.content) {
      if (b.type === "text" && b.text) content.push({ type: "text", text: b.text })
      else if (b.type === "image") content.push(toImage(b))
      else if (b.type === "tool_result") {
        const inner: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = b.content.map((c) => (c.type === "text" ? { type: "text" as const, text: c.text || "(empty)" } : toImage(c)))
        content.push({ type: "tool_result", tool_use_id: b.toolUseId, is_error: b.isError || undefined, content: inner.length ? inner : [{ type: "text", text: "(no output)" }] })
      }
    }
    out.push({ role: "user", content: content.length ? content : [{ type: "text", text: "(empty message)" }] })
  }
  return out
}

function classify(e: unknown): EndpointError {
  if (e instanceof EndpointError) return e
  if (e instanceof Anthropic.APIError) {
    const msg = (e.error as any)?.error?.message ?? e.message
    const retryAfter = retryAfterSeconds(e.headers?.get?.("retry-after"))
    if (e instanceof Anthropic.APIUserAbortError) return new EndpointError("aborted", "other")
    if (e instanceof Anthropic.APIConnectionError) return new EndpointError(`Couldn't reach the API (${e.message})`, "connection")
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new EndpointError(msg, "auth", e.status)
    if (e instanceof Anthropic.RateLimitError) return new EndpointError(msg, "rate_limit", 429, retryAfter)
    if (e instanceof Anthropic.NotFoundError) return new EndpointError(msg, "not_found", 404)
    if (e instanceof Anthropic.BadRequestError) return new EndpointError(msg, /signature/i.test(msg) && /thinking/i.test(msg) ? "thinking_signature" : "bad_request", 400)
    if (e.status === 529 || e.type === "overloaded_error") return new EndpointError(msg, "overloaded", e.status ?? null, retryAfter)
    if (typeof e.status === "number" && e.status >= 500) return new EndpointError(msg, "server", e.status, retryAfter)
    // An `error` event in the middle of the stream (no status): overloaded / api_error are transient.
    if (e.status === undefined && (e.type === "api_error" || /overloaded/i.test(msg))) return new EndpointError(msg, e.type === "api_error" ? "server" : "overloaded")
    return new EndpointError(msg, "other", e.status ?? null)
  }
  if (e instanceof SyntaxError) return new EndpointError(`The API sent something unreadable (${e.message})`, "bad_stream")
  return new EndpointError(e instanceof Error ? e.message : String(e), "other")
}

const stopOf = (s: string | null | undefined): StopReason =>
  s === "end_turn" || s === "tool_use" || s === "max_tokens" || s === "refusal" || s === "stop_sequence" || s === "pause_turn" ? s : "other"

export class AnthropicEndpoint implements Endpoint {
  readonly protocol = "anthropic" as const
  readonly baseUrl: string
  private client: Anthropic
  private eager: boolean

  constructor(o: AnthropicOptions) {
    this.baseUrl = (o.baseUrl || ANTHROPIC_DEFAULT_URL).replace(/\/+$/, "")
    this.eager = o.eagerInputStreaming ?? this.baseUrl === ANTHROPIC_DEFAULT_URL
    this.client = new Anthropic({ apiKey: o.apiKey, baseURL: this.baseUrl, maxRetries: 0, timeout: o.timeoutMs ?? 10 * 60_000 })
  }

  async listModels(signal?: AbortSignal) {
    try {
      const out: { value: string; label: string }[] = []
      for await (const m of this.client.models.list({ limit: 100 }, { signal })) out.push({ value: m.id, label: m.display_name || m.id })
      return out
    } catch (e) {
      throw classify(e)
    }
  }

  /** The request body (exported for tests and the native log). */
  params(req: ModelRequest): Anthropic.MessageCreateParamsStreaming {
    const adaptive = adaptiveThinking(req.model)
    return {
      model: req.model,
      max_tokens: req.maxTokens,
      // Stable prefix first (tools -> system) with a breakpoint on the frozen system prompt; the top-level breakpoint
      // moves with the conversation (automatic caching).
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      cache_control: { type: "ephemeral" },
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Tool.InputSchema, ...(this.eager ? { eager_input_streaming: true } : {}) })),
      messages: toAnthropicMessages(req.messages),
      ...(adaptive ? { thinking: { type: "adaptive", display: "summarized" } as const } : {}),
      ...(adaptive && req.effort ? { output_config: { effort: req.effort as "low" | "medium" | "high" | "xhigh" | "max" } } : {}),
      stream: true,
    }
  }

  async stream(req: ModelRequest, sink: StreamSink, signal: AbortSignal): Promise<ModelResponse> {
    type Acc = { type: string; text: string; signature: string | null; id: string; name: string; json: string; raw: any }
    const blocks = new Map<number, Acc>()
    const usage: Usage = { input: null, output: null, cacheRead: null, cacheWrite: null }
    let stop: string | null = null
    let model: string | null = null
    let id: string | null = null
    let ended = false
    const setUsage = (u: any) => {
      if (!u) return
      if (typeof u.input_tokens === "number") usage.input = u.input_tokens
      if (typeof u.output_tokens === "number") usage.output = u.output_tokens
      if (typeof u.cache_read_input_tokens === "number") usage.cacheRead = u.cache_read_input_tokens
      if (typeof u.cache_creation_input_tokens === "number") usage.cacheWrite = u.cache_creation_input_tokens
    }
    try {
      const stream = await this.client.messages.create(this.params(req), { signal })
      for await (const ev of stream as AsyncIterable<any>) {
        switch (ev.type) {
          case "message_start":
            id = ev.message?.id ?? null
            model = ev.message?.model ?? null
            setUsage(ev.message?.usage)
            break
          case "content_block_start": {
            const cb = ev.content_block ?? {}
            const a: Acc = { type: cb.type, text: cb.text ?? cb.thinking ?? "", signature: cb.signature ?? null, id: cb.id ?? "", name: cb.name ?? "", json: "", raw: cb }
            blocks.set(ev.index, a)
            if (cb.type === "tool_use") sink.toolStart(ev.index, a.id, a.name)
            break
          }
          case "content_block_delta": {
            const a = blocks.get(ev.index)
            const d = ev.delta ?? {}
            if (!a) break
            if (d.type === "text_delta") {
              a.text += d.text ?? ""
              sink.text(ev.index, d.text ?? "")
            } else if (d.type === "thinking_delta") {
              a.text += d.thinking ?? ""
              sink.thinking(ev.index, d.thinking ?? "")
            } else if (d.type === "signature_delta") a.signature = (a.signature ?? "") + (d.signature ?? "")
            else if (d.type === "input_json_delta") {
              a.json += d.partial_json ?? ""
              sink.toolInput(ev.index, a.id, d.partial_json ?? "")
            }
            break
          }
          case "content_block_stop": {
            const a = blocks.get(ev.index)
            if (a?.type === "text") sink.blockDone(ev.index, "text", a.text)
            else if (a?.type === "thinking") sink.blockDone(ev.index, "thinking", a.text)
            break
          }
          case "message_delta":
            stop = ev.delta?.stop_reason ?? stop
            setUsage(ev.usage)
            break
          case "message_stop":
            ended = true
            break
        }
      }
    } catch (e) {
      if (signal.aborted) throw signal.reason ?? new Error("aborted")
      throw classify(e)
    }
    if (signal.aborted) throw signal.reason ?? new Error("aborted")
    if (!ended) throw new EndpointError("The API's answer was cut off (the stream ended early).", "bad_stream")

    const content: ConvBlock[] = []
    const native: unknown[] = []
    const badJson: Record<string, string> = {}
    for (const i of [...blocks.keys()].sort((x, y) => x - y)) {
      const a = blocks.get(i)!
      if (a.type === "text") {
        content.push({ type: "text", text: a.text })
        native.push({ type: "text", text: a.text })
      } else if (a.type === "thinking") {
        content.push({ type: "thinking", text: a.text, signature: a.signature })
        native.push({ type: "thinking", thinking: a.text, signature: a.signature ?? "" })
      } else if (a.type === "redacted_thinking") {
        content.push({ type: "thinking", text: "", redacted: a.raw?.data ?? "" })
        native.push({ type: "redacted_thinking", data: a.raw?.data ?? "" })
      } else if (a.type === "tool_use") {
        let input: unknown = {}
        const raw = a.json.trim()
        if (raw) {
          try {
            input = JSON.parse(raw)
            if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("not an object")
          } catch {
            badJson[a.id] = a.json
            input = {}
          }
        } else if (a.raw?.input && typeof a.raw.input === "object") input = a.raw.input
        content.push({ type: "tool_use", id: a.id, name: a.name, input })
        native.push({ type: "tool_use", id: a.id, name: a.name, input })
      }
      // other block types (none requested: no server tools) are dropped
    }
    return {
      message: { role: "assistant", content, native: { protocol: "anthropic", model, content: native } },
      stop: stopOf(stop),
      rawStop: stop,
      usage,
      model,
      badJson,
      id,
    }
  }
}
