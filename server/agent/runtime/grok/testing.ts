// Test double for the Grok runtime: a scriptable `grok agent stdio` (ACP, JSON-RPC 2.0) handed to the adapter through
// GrokDeps.spawn. Test-only. Recorded transcripts replay with codex/testing.ts ReplayServer (same framing).
import type { RpcMessage, RpcTransport } from "../codex/rpc"

/* eslint-disable @typescript-eslint/no-explicit-any */

type Handler = (params: any, agent: FakeGrokAgent, id: number | string) => unknown

export class FakeGrokAgent implements RpcTransport {
  readonly received: (RpcMessage & { jsonrpc?: string })[] = []
  readonly args: string[]
  readonly env: Record<string, string | undefined>
  private lines: ((l: string) => void)[] = []
  private closers: ((e?: string) => void)[] = []
  private waiting = new Map<string, (r: RpcMessage) => void>()
  private n = 0
  /** The open session/prompt request id (null when no turn runs). */
  prompt: number | string | null = null
  closed = false
  sessionId = "01aa0000-0000-7000-8000-000000000001"
  /** session/cancel ends the open prompt with "cancelled" (like Grok). */
  autoCancel = true
  handlers: Record<string, Handler> = {
    initialize: () => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: false }, mcpCapabilities: { http: true, sse: true }, sessionCapabilities: { list: {}, resume: {}, close: {} } },
      authMethods: [{ id: "grok.com", name: "Grok" }],
      _meta: { agentVersion: "1.0.5", modelState: { currentModelId: "grok-4.6", availableModels: [{ modelId: "grok-4.6", name: "Grok 4.6" }, { modelId: "grok-4.5", name: "Grok 4.5" }] } },
    }),
    "session/new": () => ({ sessionId: this.sessionId, models: { currentModelId: "grok-4.6", availableModels: [{ modelId: "grok-4.6", name: "Grok 4.6" }, { modelId: "grok-4.5", name: "Grok 4.5" }] } }),
    "session/resume": (p) => {
      this.sessionId = p.sessionId
      return { models: { currentModelId: "grok-4.6", availableModels: [{ modelId: "grok-4.6", name: "Grok 4.6" }] } }
    },
    "session/set_model": (p) => ({ _meta: { model: { Ok: p.modelId } } }),
    "_x.ai/session/fork": (p) => ({ newSessionId: `${p.sourceSessionId}-fork`, parentSessionId: p.sourceSessionId }),
    // session/prompt stays open until the test ends it (endPrompt / failPrompt)
    "session/prompt": (_p, _a, id) => {
      this.prompt = id
      return NO_REPLY
    },
  }

  constructor(args: string[] = [], env: Record<string, string | undefined> = {}) {
    this.args = args
    this.env = env
  }

  requests(method: string) {
    return this.received.filter((m) => m.method === method && m.id !== undefined)
  }
  notifications(method: string) {
    return this.received.filter((m) => m.method === method && m.id === undefined)
  }

  write(line: string) {
    const m = JSON.parse(line)
    this.received.push(m)
    if (m.method !== undefined && m.id !== undefined) {
      const h = this.handlers[m.method]
      Promise.resolve()
        .then(() => (h ? h(m.params, this, m.id) : Promise.reject(Object.assign(new Error(`Method not found`), { code: -32601 }))))
        .then(
          (result) => result !== NO_REPLY && this.emit({ id: m.id, result }),
          (e: any) => this.emit({ id: m.id, error: { code: e.code ?? -32000, message: e.message, data: e.data } })
        )
    } else if (m.method !== undefined) {
      if (m.method === "session/cancel" && this.autoCancel && this.prompt !== null) setTimeout(() => this.endPrompt("cancelled"), 0)
    } else if (m.id !== undefined) {
      const w = this.waiting.get(String(m.id))
      this.waiting.delete(String(m.id))
      w?.(m)
    }
  }
  onLine(cb: (l: string) => void) {
    this.lines.push(cb)
  }
  onClose(cb: (e?: string) => void) {
    this.closers.push(cb)
  }
  close() {
    this.die()
  }
  private emit(m: RpcMessage) {
    if (!this.closed) for (const l of this.lines) l(JSON.stringify({ jsonrpc: "2.0", ...m }))
  }
  notify(method: string, params: unknown) {
    this.emit({ method, params })
  }
  /** A session/update for the current session. */
  update(update: Record<string, unknown>) {
    this.notify("session/update", { sessionId: this.sessionId, update })
  }
  /** An agent -> client request; resolves with the client's response. */
  request(method: string, params: Record<string, unknown>): Promise<RpcMessage> {
    const id = `a${this.n++}`
    return new Promise((r) => {
      this.waiting.set(id, r)
      this.emit({ id, method, params: { sessionId: this.sessionId, ...params } })
    })
  }
  /** End the open turn. */
  endPrompt(stopReason = "end_turn", usage: Record<string, number> = { inputTokens: 150, outputTokens: 7, cachedReadTokens: 40, cacheCreationTokens: 10, numTurns: 2 }) {
    const id = this.prompt
    if (id === null) return
    this.prompt = null
    this.emit({ id, result: { stopReason, _meta: { sessionId: this.sessionId, promptId: `pr-${this.n++}`, usage } } })
  }
  failPrompt(message: string, code = -32603) {
    const id = this.prompt
    if (id === null) return
    this.prompt = null
    this.emit({ id, error: { code, message } })
  }
  die(error?: string) {
    if (this.closed) return
    this.closed = true
    for (const c of this.closers) c(error)
  }
}

const NO_REPLY = Symbol("no reply")
