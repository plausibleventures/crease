// Scripted model servers for the direct API runtime's tests (R11f): a fake Anthropic Messages API and a fake
// OpenAI-compatible Chat Completions server on 127.0.0.1 (ephemeral ports). Each POST takes the next scripted reply:
// an SSE stream (built with the helpers below), an HTTP error, or a stream that breaks off with an error event.
// Requests are recorded (headers + JSON body) so tests can check exactly what the runtime sent.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Recorded {
  method: string
  path: string
  headers: Record<string, string | string[] | undefined>
  body: any
}

export type Reply =
  | { sse: unknown[]; /** SSE lines written as `data: <json>` only (Chat Completions) instead of `event:`+`data:` */ plain?: boolean; done?: boolean; error?: unknown; truncate?: boolean }
  | { status: number; body: unknown; headers?: Record<string, string> }

export type Responder = Reply | ((body: any, req: Recorded) => Reply | Promise<Reply>)

abstract class FakeServer {
  requests: Recorded[] = []
  queue: Responder[] = []
  private server: Server | null = null
  url = ""
  key = "test-key"

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this
  }
  close() {
    this.server?.closeAllConnections?.()
    this.server?.close()
  }
  push(...r: Responder[]) {
    this.queue.push(...r)
  }
  /** POST bodies to the model endpoint, in order. */
  abstract get calls(): any[]

  protected abstract authorized(req: IncomingMessage): boolean
  protected abstract route(rec: Recorded, res: ServerResponse): Promise<void>

  private async handle(req: IncomingMessage, res: ServerResponse) {
    let raw = ""
    for await (const c of req) raw += c
    const rec: Recorded = { method: req.method ?? "", path: (req.url ?? "").split("?")[0], headers: req.headers, body: raw ? JSON.parse(raw) : null }
    this.requests.push(rec)
    if (!this.authorized(req)) return this.json(res, 401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } })
    await this.route(rec, res)
  }

  protected json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { "content-type": "application/json", ...headers })
    res.end(JSON.stringify(body))
  }

  protected async reply(rec: Recorded, res: ServerResponse) {
    const next = this.queue.shift()
    if (!next) return this.json(res, 500, { type: "error", error: { type: "api_error", message: "test script ran out of replies" } })
    const r = typeof next === "function" ? await next(rec.body, rec) : next
    if ("status" in r) return this.json(res, r.status, r.body, r.headers)
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    for (const e of r.sse) res.write(r.plain ? `data: ${JSON.stringify(e)}\n\n` : `event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`)
    if (r.error) res.write(r.plain ? `data: ${JSON.stringify(r.error)}\n\n` : `event: error\ndata: ${JSON.stringify(r.error)}\n\n`)
    else if (r.done) res.write("data: [DONE]\n\n")
    if (r.truncate) return void res.destroy()
    res.end()
  }
}

// -------------------------------------------------------------------------------------------------
// Anthropic Messages API
// -------------------------------------------------------------------------------------------------

export class FakeMessagesApi extends FakeServer {
  models = [
    { id: "claude-opus-5-5", display_name: "Claude Opus 5.5" },
    { id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" },
  ]
  get calls() {
    return this.requests.filter((r) => r.path === "/v1/messages").map((r) => r.body)
  }
  protected authorized(req: IncomingMessage) {
    return req.headers["x-api-key"] === this.key
  }
  protected async route(rec: Recorded, res: ServerResponse) {
    if (rec.method === "GET" && rec.path === "/v1/models")
      return this.json(res, 200, { data: this.models.map((m) => ({ type: "model", created_at: "2026-01-01T00:00:00Z", ...m })), has_more: false, first_id: null, last_id: null })
    if (rec.method === "POST" && rec.path === "/v1/messages") return this.reply(rec, res)
    this.json(res, 404, { type: "error", error: { type: "not_found_error", message: rec.path } })
  }
}

export interface ScriptedBlock {
  text?: string
  thinking?: string
  signature?: string
  /** tool_use: input as JSON chunks (streamed as input_json_delta), or an object sent in one chunk. */
  tool?: { id: string; name: string; input?: unknown; chunks?: string[] }
}

/** A Messages API stream: message_start, the blocks (text in 2 deltas), message_delta (stop + usage), message_stop. */
export function messageStream(
  blocks: ScriptedBlock[],
  o: { stop?: string; model?: string; id?: string; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }; cut?: boolean } = {}
): unknown[] {
  const u = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...o.usage }
  const ev: unknown[] = [
    {
      type: "message_start",
      message: { id: o.id ?? "msg_1", type: "message", role: "assistant", model: o.model ?? "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: u.input_tokens, output_tokens: 1, cache_read_input_tokens: u.cache_read_input_tokens, cache_creation_input_tokens: u.cache_creation_input_tokens } },
    },
  ]
  blocks.forEach((b, index) => {
    if (b.thinking !== undefined) {
      ev.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } })
      ev.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: b.thinking } })
      ev.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: b.signature ?? "sig-" + index } })
    } else if (b.text !== undefined) {
      ev.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } })
      const half = Math.ceil(b.text.length / 2)
      ev.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text.slice(0, half) } })
      if (b.text.length > half) ev.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text.slice(half) } })
    } else if (b.tool) {
      ev.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.tool.id, name: b.tool.name, input: {} } })
      for (const c of b.tool.chunks ?? [JSON.stringify(b.tool.input ?? {})]) ev.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: c } })
    }
    ev.push({ type: "content_block_stop", index })
  })
  if (o.cut) return ev
  ev.push({ type: "message_delta", delta: { stop_reason: o.stop ?? (blocks.some((b) => b.tool) ? "tool_use" : "end_turn"), stop_sequence: null }, usage: { output_tokens: u.output_tokens } })
  ev.push({ type: "message_stop" })
  return ev
}

export const overloaded = (): Reply => ({ status: 529, body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } })
export const rateLimited = (retryAfter = "0"): Reply => ({ status: 429, body: { type: "error", error: { type: "rate_limit_error", message: "rate limited" } }, headers: { "retry-after": retryAfter } })
/** A stream that starts, then breaks off with an overloaded `error` event (the SDK raises it mid-stream). */
export const overloadedMidStream = (): Reply => ({
  sse: messageStream([{ text: "Partial answ" }], { cut: true }),
  error: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
})

// -------------------------------------------------------------------------------------------------
// OpenAI-compatible Chat Completions
// -------------------------------------------------------------------------------------------------

export class FakeChatApi extends FakeServer {
  models = ["llama-test", "qwen-test"]
  requireKey = true
  get calls() {
    return this.requests.filter((r) => r.path === "/v1/chat/completions").map((r) => r.body)
  }
  protected authorized(req: IncomingMessage) {
    return !this.requireKey || req.headers.authorization === `Bearer ${this.key}`
  }
  protected async route(rec: Recorded, res: ServerResponse) {
    if (rec.method === "GET" && rec.path === "/v1/models") return this.json(res, 200, { object: "list", data: this.models.map((id) => ({ id, object: "model" })) })
    if (rec.method === "POST" && rec.path === "/v1/chat/completions") return this.reply(rec, res)
    this.json(res, 404, { error: { message: rec.path } })
  }
}

/** A Chat Completions stream: content in pieces, tool calls with arguments split across chunks, then usage. */
export function chatStream(o: {
  text?: string
  reasoning?: string
  tools?: { id: string; name: string; args: string[] }[]
  finish?: string
  usage?: { prompt_tokens: number; completion_tokens: number; cached?: number } | null
  model?: string
}): Reply {
  const base = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: o.model ?? "llama-test" }
  const ch = (delta: unknown, finish: string | null = null) => ({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })
  const out: unknown[] = [ch({ role: "assistant", content: "" })]
  if (o.reasoning) out.push(ch({ reasoning_content: o.reasoning }))
  if (o.text) for (const piece of o.text.match(/.{1,5}/gs) ?? []) out.push(ch({ content: piece }))
  ;(o.tools ?? []).forEach((t, index) => {
    out.push(ch({ tool_calls: [{ index, id: t.id, type: "function", function: { name: t.name, arguments: "" } }] }))
    for (const a of t.args) out.push(ch({ tool_calls: [{ index, function: { arguments: a } }] }))
  })
  out.push(ch({}, o.finish ?? (o.tools?.length ? "tool_calls" : "stop")))
  if (o.usage !== null) {
    const u = o.usage ?? { prompt_tokens: 50, completion_tokens: 10 }
    out.push({ ...base, choices: [], usage: { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, total_tokens: u.prompt_tokens + u.completion_tokens, ...(u.cached !== undefined ? { prompt_tokens_details: { cached_tokens: u.cached } } : {}) } })
  }
  return { sse: out, plain: true, done: true }
}
