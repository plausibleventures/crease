// JSON-RPC over newline-delimited JSON, as `codex app-server` speaks it on stdio (no "jsonrpc" field, ids are
// numbers). Grok's ACP agent (R11e) uses the same framing with `"jsonrpc": "2.0"` (RpcOptions.jsonrpc). Client
// requests resolve with `result` or reject with `error`; server -> client requests (approvals, dynamic tool calls,
// user input) go to onRequest, whose return value (or thrown error) is sent back.

/** A line transport: the app-server child's stdio in production, a fixture replayer in tests. */
export interface RpcTransport {
  write(line: string): void
  onLine(cb: (line: string) => void): void
  /** The other side went away (process exit). `error` when it ended badly. */
  onClose(cb: (error?: string) => void): void
  close(): void
}

export interface RpcMessage {
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown
  ) {
    super(message)
  }
}

export interface RpcHandlers {
  onNotification(method: string, params: unknown): void
  onRequest(method: string, params: unknown, id: number | string): Promise<unknown>
  /** Every message in (<) and out (>), for diagnostics and fixture recording. */
  onMessage?(dir: "<" | ">", msg: RpcMessage): void
}

export interface RpcOptions {
  /** Add `"jsonrpc": "2.0"` to every message (ACP). */
  jsonrpc?: boolean
  /** The peer's name in plain-words errors ("Codex stopped.", "Grok didn't answer …"). */
  peer?: string
}

export class RpcConnection {
  private nextId = 0
  private pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }>()
  private closed: string | null = null

  private peer: string

  constructor(
    private t: RpcTransport,
    private h: RpcHandlers,
    private o: RpcOptions = {}
  ) {
    this.peer = o.peer ?? "Codex"
    t.onLine((line) => this.receive(line))
    t.onClose((error) => this.fail(error ?? `${this.peer} stopped.`))
  }

  get isClosed() {
    return this.closed !== null
  }

  private send(msg: RpcMessage) {
    if (this.closed !== null) return
    this.h.onMessage?.(">", msg)
    this.t.write(JSON.stringify(this.o.jsonrpc ? { jsonrpc: "2.0", ...msg } : msg))
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 0): Promise<T> {
    if (this.closed !== null) return Promise.reject(new RpcError(this.closed))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null
      const done = <A extends unknown[]>(f: (...a: A) => void) => (...a: A) => {
        if (timer) clearTimeout(timer)
        f(...a)
      }
      this.pending.set(id, { resolve: done(resolve as (v: unknown) => void), reject: done(reject), method })
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.pending.delete(id)) reject(new RpcError(`${this.peer} didn't answer ${method} in ${Math.round(timeoutMs / 1000)} s.`))
        }, timeoutMs)
        timer.unref?.()
      }
      this.send({ id, method, params })
    })
  }

  notify(method: string, params: unknown) {
    this.send({ method, params })
  }

  private receive(line: string) {
    if (!line.trim()) return
    let m: RpcMessage
    try {
      m = JSON.parse(line) as RpcMessage
    } catch {
      return // not protocol (stray output)
    }
    this.h.onMessage?.("<", m)
    if (m.method !== undefined && m.id !== undefined) {
      const id = m.id
      this.h.onRequest(m.method, m.params, id).then(
        (result) => this.send({ id, result: result ?? {} }),
        (e: unknown) => this.send({ id, error: { code: e instanceof RpcError && e.code ? e.code : -32000, message: e instanceof Error ? e.message : String(e) } })
      )
    } else if (m.method !== undefined) {
      this.h.onNotification(m.method, m.params)
    } else if (m.id !== undefined) {
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      if (m.error) p.reject(new RpcError(m.error.message ?? `${p.method} failed`, m.error.code, m.error.data))
      else p.resolve(m.result)
    }
  }

  private fail(reason: string) {
    if (this.closed !== null) return
    this.closed = reason
    for (const p of this.pending.values()) p.reject(new RpcError(reason))
    this.pending.clear()
  }

  close() {
    this.fail("closed")
    this.t.close()
  }
}
