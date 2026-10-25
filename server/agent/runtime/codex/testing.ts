// Test doubles for the Codex runtime: a scriptable app-server (FakeAppServer) and a replayer for recorded JSON-RPC
// transcripts (ReplayServer, fixtures/*.jsonl recorded with PRINTSTUDIO_CODEX_RECORD and scrubbed). Both are
// RpcTransports, handed to the adapter through CodexDeps.spawn. Test-only.
import { readFileSync } from "node:fs"
import type { RpcMessage, RpcTransport } from "./rpc"

/* eslint-disable @typescript-eslint/no-explicit-any */

type Handler = (params: any, server: FakeAppServer) => unknown

/** A programmable `codex app-server`: answers client requests from handlers, sends notifications and requests. */
export class FakeAppServer implements RpcTransport {
  /** Everything the client sent. */
  readonly received: RpcMessage[] = []
  readonly args: string[]
  private lines: ((l: string) => void)[] = []
  private closers: ((e?: string) => void)[] = []
  private waiting = new Map<string, (r: RpcMessage) => void>()
  private n = 0
  private turns = 0
  closed = false
  handlers: Record<string, Handler> = {
    initialize: () => ({ userAgent: "printstudio/0.161.0 (test)", codexHome: "/codex-home" }),
    "account/read": () => ({ account: { type: "chatgpt", email: "user@example.com", planType: "plus" }, requiresOpenaiAuth: true }),
    "model/list": () => ({ data: [{ id: "gpt-test", model: "gpt-test", displayName: "GPT Test", hidden: false, isDefault: true }] }),
    "config/read": () => ({ config: {}, layers: [{ name: { type: "user" }, config: { mcp_servers: { mine: {} } } }] }),
    "skills/extraRoots/set": () => ({}),
    "skills/list": () => ({ data: [{ cwd: "/p", skills: [{ name: "other", path: "/Users/user/.agents/skills/other/SKILL.md" }] }] }),
    "thread/start": () => ({ thread: { id: "thr-1" } }),
    "thread/resume": (p) => ({ thread: { id: p.threadId } }),
    "thread/fork": (p) => ({ thread: { id: `${p.threadId}-fork` } }),
    "thread/name/set": () => ({}),
    "turn/start": () => ({ turn: { id: `turn-${++this.turns}`, items: [], status: "inProgress" } }),
    "turn/interrupt": (p, s) => {
      setTimeout(() => s.notify("turn/completed", { threadId: p.threadId, turn: { id: p.turnId, items: [], status: "interrupted", error: null } }), 0)
      return {}
    },
  }

  constructor(args: string[] = []) {
    this.args = args
  }

  get turnId() {
    return `turn-${this.turns}`
  }
  requests(method: string) {
    return this.received.filter((m) => m.method === method && m.id !== undefined)
  }

  write(line: string) {
    const m = JSON.parse(line) as RpcMessage
    this.received.push(m)
    if (m.method !== undefined && m.id !== undefined) {
      const h = this.handlers[m.method]
      Promise.resolve()
        .then(() => (h ? h(m.params, this) : Promise.reject(new Error(`fake: no handler for ${m.method}`))))
        .then(
          (result) => this.emit({ id: m.id, result }),
          (e: Error) => this.emit({ id: m.id, error: { code: -32000, message: e.message } })
        )
    } else if (m.method === undefined && m.id !== undefined) {
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
    if (!this.closed) for (const l of this.lines) l(JSON.stringify(m))
  }
  notify(method: string, params: unknown) {
    this.emit({ method, params })
  }
  /** A server -> client request; resolves with the client's response. */
  request(method: string, params: unknown): Promise<RpcMessage> {
    const id = `s${this.n++}`
    return new Promise((r) => {
      this.waiting.set(id, r)
      this.emit({ id, method, params })
    })
  }
  /** The process ends (error = it crashed). */
  die(error?: string) {
    if (this.closed) return
    this.closed = true
    for (const c of this.closers) c(error)
  }
}

export interface RecordedLine {
  conn: string
  dir: "<" | ">"
  msg: RpcMessage
}

export function readFixture(file: string): RecordedLine[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RecordedLine)
}

/**
 * Replays one recorded connection: waits for each client message the recording has (same method, in order), then
 * sends what the server sent next, with response ids mapped to the client's. Mismatches are collected, not thrown.
 */
export class ReplayServer implements RpcTransport {
  private i = 0
  private ids = new Map<string, number | string>()
  private lines: ((l: string) => void)[] = []
  private closers: ((e?: string) => void)[] = []
  readonly mismatches: string[] = []
  readonly received: RpcMessage[] = []
  closed = false

  constructor(private script: RecordedLine[]) {
    setTimeout(() => this.pump(), 0)
  }

  get done() {
    return this.i >= this.script.length
  }

  write(line: string) {
    const m = JSON.parse(line) as RpcMessage
    this.received.push(m)
    const exp = this.script[this.i]
    if (!exp || exp.dir !== ">") {
      this.mismatches.push(`unexpected client message ${m.method ?? `response ${m.id}`} at ${this.i}`)
      return
    }
    if ((exp.msg.method ?? null) !== (m.method ?? null)) this.mismatches.push(`expected ${exp.msg.method ?? "response"}, got ${m.method ?? "response"} at ${this.i}`)
    if (exp.msg.method && exp.msg.id !== undefined && m.id !== undefined) this.ids.set(String(exp.msg.id), m.id)
    this.i++
    setTimeout(() => this.pump(), 0)
  }

  private pump() {
    while (!this.closed && this.i < this.script.length && this.script[this.i].dir === "<") {
      const m = { ...this.script[this.i++].msg }
      if (m.method === undefined && m.id !== undefined) m.id = this.ids.get(String(m.id)) ?? m.id
      for (const l of this.lines) l(JSON.stringify(m))
    }
  }
  onLine(cb: (l: string) => void) {
    this.lines.push(cb)
  }
  onClose(cb: (e?: string) => void) {
    this.closers.push(cb)
  }
  close() {
    if (this.closed) return
    this.closed = true
    for (const c of this.closers) c()
  }
}
