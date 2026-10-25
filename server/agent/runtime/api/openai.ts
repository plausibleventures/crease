// OpenAI-compatible Chat Completions endpoint (R11f, second protocol): POST {base}/chat/completions with stream: true
// (SSE `data:` chunks), function tools, streamed tool-call deltas (by index), image inputs as data: URLs, usage from
// stream_options.include_usage. Base URLs look like https://api.openai.com/v1 or http://localhost:11434/v1 (Ollama) /
// http://localhost:1234/v1 (LM Studio). Tested only against a scripted server: servers differ in tool-call deltas,
// image support and usage reporting, so the Agents card labels real endpoints "untested" (endpoint.ts ENDPOINTS).
//
// Tool results with images: Chat Completions tool messages are text, so a result's images follow in one user message
// after the tool messages. Model reasoning (`reasoning_content` from some servers) is shown, never sent back.
import { randomBytes } from "node:crypto"
import type { ConvBlock, ConvMessage } from "./conversation"
import { EndpointError, retryAfterSeconds, type Endpoint, type ModelRequest, type ModelResponse, type StopReason, type StreamSink, type Usage } from "./endpoint"

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface OpenAiOptions {
  baseUrl: string
  /** Bearer key; null/empty for local servers that don't check one. */
  apiKey?: string | null
  timeoutMs?: number
}

type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
const dataUrl = (b: { mediaType: string; data: string }) => `data:${b.mediaType};base64,${b.data}`

export function toChatMessages(system: string, messages: ConvMessage[]): any[] {
  const out: any[] = [{ role: "system", content: system }]
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content
        .filter((b): b is Extract<ConvBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n\n")
      const calls = m.content.filter((b): b is Extract<ConvBlock, { type: "tool_use" }> => b.type === "tool_use")
      out.push({
        role: "assistant",
        content: text || (calls.length ? null : "(no reply text)"),
        ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) } : {}),
      })
      continue
    }
    const images: Part[] = []
    for (const b of m.content) {
      if (b.type !== "tool_result") continue
      const text = b.content
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join("\n")
      out.push({ role: "tool", tool_call_id: b.toolUseId, content: (b.isError ? "Error: " : "") + (text || "(no output)") })
      for (const c of b.content) if (c.type === "image") images.push({ type: "image_url", image_url: { url: dataUrl(c) } })
    }
    const parts: Part[] = []
    if (images.length) parts.push({ type: "text", text: "Images from the tool results above:" }, ...images)
    for (const b of m.content) {
      if (b.type === "text" && b.text) parts.push({ type: "text", text: b.text })
      else if (b.type === "image") parts.push({ type: "image_url", image_url: { url: dataUrl(b) } })
    }
    if (!parts.length) continue
    out.push({ role: "user", content: parts.every((p) => p.type === "text") ? parts.map((p) => (p as { text: string }).text).join("\n\n") : parts })
  }
  return out
}

const stopOf = (s: string | null): StopReason => (s === "stop" ? "end_turn" : s === "tool_calls" || s === "function_call" ? "tool_use" : s === "length" ? "max_tokens" : s === "content_filter" ? "refusal" : "other")

function httpError(status: number, body: string, retryAfter: string | null): EndpointError {
  let msg = body.slice(0, 500)
  try {
    const j = JSON.parse(body)
    msg = String(j?.error?.message ?? j?.message ?? j?.error ?? msg)
  } catch {
    /* plain text */
  }
  const ra = retryAfterSeconds(retryAfter)
  if (status === 401 || status === 403) return new EndpointError(msg || "The key was refused.", "auth", status)
  if (status === 429) return new EndpointError(msg || "Rate limited.", "rate_limit", status, ra)
  if (status === 404) return new EndpointError(msg || "Not found.", "not_found", status)
  if (status === 529 || status === 503) return new EndpointError(msg || "Overloaded.", "overloaded", status, ra)
  if (status >= 500) return new EndpointError(msg || `Server error ${status}.`, "server", status, ra)
  if (status === 400 || status === 422) return new EndpointError(msg || "Bad request.", "bad_request", status)
  return new EndpointError(msg || `HTTP ${status}`, "other", status)
}

export class OpenAiChatEndpoint implements Endpoint {
  readonly protocol = "openai-chat" as const
  readonly baseUrl: string
  private key: string | null

  constructor(private o: OpenAiOptions) {
    this.baseUrl = o.baseUrl.replace(/\/+$/, "")
    this.key = o.apiKey || null
  }

  private headers(): Record<string, string> {
    return { "content-type": "application/json", ...(this.key ? { authorization: `Bearer ${this.key}` } : {}) }
  }

  private async fetch(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.o.timeoutMs ?? 10 * 60_000)
    try {
      return await fetch(this.baseUrl + path, { ...init, headers: this.headers(), signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    } catch (e) {
      if (signal?.aborted) throw signal.reason ?? e
      throw new EndpointError(`Couldn't reach ${this.baseUrl} (${(e as Error).name === "TimeoutError" ? "timed out" : ((e as Error).cause as Error)?.message || (e as Error).message})`, "connection")
    }
  }

  async listModels(signal?: AbortSignal) {
    const r = await this.fetch("/models", { method: "GET" }, signal)
    const body = await r.text()
    if (!r.ok) throw httpError(r.status, body, r.headers.get("retry-after"))
    try {
      const j = JSON.parse(body)
      const list: any[] = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : []
      return list.map((m) => String(m?.id ?? m?.name ?? "")).filter(Boolean).map((id) => ({ value: id, label: id }))
    } catch {
      throw new EndpointError("The endpoint's model list wasn't JSON.", "bad_stream")
    }
  }

  body(req: ModelRequest): Record<string, unknown> {
    return {
      model: req.model,
      messages: toChatMessages(req.system, req.messages),
      ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })) } : {}),
      max_tokens: req.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    }
  }

  async stream(req: ModelRequest, sink: StreamSink, signal: AbortSignal): Promise<ModelResponse> {
    const r = await this.fetch("/chat/completions", { method: "POST", body: JSON.stringify(this.body(req)) }, signal)
    if (!r.ok) throw httpError(r.status, await r.text(), r.headers.get("retry-after"))
    if (!r.body) throw new EndpointError("The endpoint sent no stream.", "bad_stream")
    // Block indexes for the sink: 0 = text, 1 = reasoning, 100+i = tool call i.
    let text = ""
    let reasoning = ""
    const calls = new Map<number, { id: string; name: string; args: string }>()
    const usage: Usage = { input: null, output: null, cacheRead: null, cacheWrite: null }
    let finish: string | null = null
    let model: string | null = null
    let id: string | null = null
    let done = false
    const handle = (j: any) => {
      if (j?.error) {
        const msg = String(j.error?.message ?? j.error)
        throw new EndpointError(msg, /overload|capacity|busy/i.test(msg) ? "overloaded" : "server")
      }
      model = j.model ?? model
      id = j.id ?? id
      if (j.usage) {
        const cached = j.usage.prompt_tokens_details?.cached_tokens
        if (typeof j.usage.prompt_tokens === "number") usage.input = j.usage.prompt_tokens - (typeof cached === "number" ? cached : 0)
        if (typeof j.usage.completion_tokens === "number") usage.output = j.usage.completion_tokens
        if (typeof cached === "number") usage.cacheRead = cached
      }
      const ch = j.choices?.[0]
      if (!ch) return
      const d = ch.delta ?? {}
      const r = d.reasoning_content ?? d.reasoning
      if (typeof r === "string" && r) {
        reasoning += r
        sink.thinking(1, r)
      }
      if (typeof d.content === "string" && d.content) {
        text += d.content
        sink.text(0, d.content)
      }
      for (const tc of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
        const i = typeof tc.index === "number" ? tc.index : calls.size
        let c = calls.get(i)
        if (!c) {
          c = { id: tc.id || `call_${i}_${randomBytes(4).toString("hex")}`, name: tc.function?.name ?? "", args: "" }
          calls.set(i, c)
          if (c.name) sink.toolStart(100 + i, c.id, c.name)
        } else if (tc.function?.name && !c.name) {
          c.name = tc.function.name
          sink.toolStart(100 + i, c.id, c.name)
        }
        if (tc.id && c.id !== tc.id && !c.args) c.id = tc.id
        const a = tc.function?.arguments
        if (typeof a === "string" && a) {
          c.args += a
          sink.toolInput(100 + i, c.id, a)
        }
      }
      if (ch.finish_reason) finish = ch.finish_reason
    }
    const dec = new TextDecoder()
    let buf = ""
    try {
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true })
        let nl: number
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "")
          buf = buf.slice(nl + 1)
          if (!line.startsWith("data:")) continue
          const data = line.slice(5).trim()
          if (!data) continue
          if (data === "[DONE]") {
            done = true
            continue
          }
          let j: any
          try {
            j = JSON.parse(data)
          } catch {
            throw new EndpointError("The endpoint sent an unreadable chunk.", "bad_stream")
          }
          handle(j)
        }
      }
    } catch (e) {
      if (signal.aborted) throw signal.reason ?? e
      if (e instanceof EndpointError) throw e
      throw new EndpointError(`The stream broke off (${(e as Error).message}).`, "bad_stream")
    }
    if (signal.aborted) throw signal.reason ?? new Error("aborted")
    if (!done && !finish) throw new EndpointError("The endpoint's answer was cut off (the stream ended early).", "bad_stream")
    if (reasoning) sink.blockDone(1, "thinking", reasoning)
    if (text) sink.blockDone(0, "text", text)

    const content: ConvBlock[] = []
    if (reasoning) content.push({ type: "thinking", text: reasoning, signature: null })
    if (text) content.push({ type: "text", text })
    const badJson: Record<string, string> = {}
    for (const i of [...calls.keys()].sort((a, b) => a - b)) {
      const c = calls.get(i)!
      let input: unknown = {}
      if (c.args.trim()) {
        try {
          input = JSON.parse(c.args)
          if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("not an object")
        } catch {
          badJson[c.id] = c.args
          input = {}
        }
      }
      content.push({ type: "tool_use", id: c.id, name: c.name, input })
    }
    // Some servers say "stop" even when they called tools.
    const stop = calls.size && finish !== "length" ? "tool_use" : stopOf(finish)
    return { message: { role: "assistant", content, native: null }, stop, rawStop: finish, usage, model, badJson, id }
  }
}
