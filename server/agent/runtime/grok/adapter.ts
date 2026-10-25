// Grok Build runtime (R11e): a Grok session through `grok agent stdio` (ACP, JSON-RPC 2.0 over stdio; Grok CLI 1.0.5).
//
// One agent process per app session: initialize (client capabilities: fs writes + terminal, so the app performs every
// file write and runs every shell command) -> session/new (cwd, the app's MCP bridge, `_meta.rules` = brief) or
// session/resume (native id from the coordinator's map) -> one session/prompt per user turn (ACP can't add to a running
// prompt: messages sent meanwhile are queued and all go in the next prompt together) ->
// session/cancel to stop. Updates stream as session/update (normalize.ts). Agent -> client requests: permissions
// (decided by the app's policy, never "always"), questions (_x.ai/ask_user_question -> the app's question cards),
// fs/write_text_file (written by the app, or refused), terminal/* (shell.ts, sandboxed). Config/isolation: config.ts.
import { spawn } from "node:child_process"
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, sep } from "node:path"
import type { AgentConnectionResult, AgentConnectionStep, AgentEffort, AgentProfileSnapshot, AgentRuntimeCapabilities, AgentRuntimeProbe, AgentUsage, RuntimeLoginStatus, SetupFix } from "../../../../shared/types"
import { getSecret } from "../../../secrets"
import { canonicalPath, isInside, realRoot } from "../../../projects/paths"
import { LIBRARIES_DIR } from "../../../cad/libraries"
import { answerPermission as answerPendingPermission } from "../../permissions"
import { protectedReason } from "../../policy"
import { answerQuestion as answerPendingQuestion } from "../../questions"
import { killAllAgentProcesses } from "../../spawn"
import { RpcConnection, RpcError, type RpcMessage, type RpcTransport } from "../codex/rpc"
import type { AdapterHost, AgentAdapter, AgentRuntime, AgentSessionContext, AgentTurnInput, QuestionInput } from "../types"
import { GROK_PROTECTED_PATHS, grokEnv, grokHomeFor, prepareGrokHome, type GrokAccessMode } from "./config"
import { grokInstructions } from "./instructions"
import { DeviceLogin, type LoginChild } from "./login"
import { saveAgentImage, startMcpBridge, type McpBridge } from "./mcp"
import { GrokNormalizer, grokToolOf } from "./normalize"
import { findGrokBinary, runGrok, spawnGrok } from "./process"
import { sandboxAvailable, Terminals, type CommandSpawner } from "./shell"

/* eslint-disable @typescript-eslint/no-explicit-any */

export const GROK_AUTH_CODE = "grok.auth"
export const GROK_AUTH_MESSAGE = "Grok isn't signed in. Open Designers and sign in."
export const GROK_NO_KEY_MESSAGE = "No xAI key saved. Add one in Designers."
export const GROK_NOT_INSTALLED = "Grok Build isn't installed. Install the Grok CLI (https://docs.x.ai/build/overview) and try again."
export const GROK_NO_SANDBOX = "Grok sessions need the macOS sandbox (sandbox-exec) to run shell commands safely; it isn't available here."
export const GROK_SIGN_IN_FIX: SetupFix = { kind: "grok-login", label: "Sign in to Grok" }
export const GROK_OUTDATED_CODE = "grok.outdated"
export const GROK_OUTDATED_MESSAGE = "Grok Build is out of date, so xAI refused the request. In Terminal, run “grok update”, then send your message again."

/**
 * Why a Grok turn failed, in plain words: the agent's own report (a turn ending with stopReason "error" carries it in
 * _x.ai/session/prompt_complete, while session/prompt only rejects with "Internal error"). Null = nothing better known.
 */
export function grokTurnError(agentResult: string | null): { text: string; code?: string } | null {
  if (!agentResult) return null
  if (/\b426\b|upgrade required|outdated|update to version/i.test(agentResult)) return { text: GROK_OUTDATED_MESSAGE, code: GROK_OUTDATED_CODE }
  return { text: agentResult.replace(/^API error \(status (\d+)[^)]*\):\s*/i, "xAI answered $1: ").slice(0, 400) }
}

const CLIENT_INFO = { name: "printstudio", title: "Crease", version: "0.0.1" }
const PROTOCOL_VERSION = 1
/** Client capabilities: the app reads and writes files and runs commands (Grok only delegates writes when it also
 *  delegates reads). Images are shown through the MCP bridge (view_image), since delegated read_file is text-only. */
const CLIENT_CAPABILITIES = { fs: { readTextFile: true, writeTextFile: true }, terminal: true }
/** Notifications never logged (high frequency or irrelevant). */
const QUIET = new Set(["_x.ai/fs/index", "_x.ai/fs/index/delta", "_x.ai/fs_notify", "_x.ai/queue/changed", "_x.ai/sessions/changed", "_x.ai/mcp/init_progress"])

/**
 * Grok tools the permission policy allows once (see GrokAdapter.permission). The read-only ones (read_file, list_dir,
 * grep) are auto-approved by Grok, except Grok 1.0.13+ asks for a path its sandbox denies (grep over build/*.gcode):
 * a refusal there ended the whole turn as if the user had pressed Stop, while allowing it just fails that call inside
 * Grok's sandbox (parity run 2026-10-11).
 */
export const GROK_ALLOWED_TOOLS = new Set(["write", "search_replace", "run_terminal_command", "monitor", "ask_user_question", "todo_write", "search_tool", "read_file", "list_dir", "grep"])

export const GROK_EFFORTS: AgentEffort[] = ["low", "medium", "high", "xhigh"]

export function grokCapabilities(): AgentRuntimeCapabilities {
  return {
    images: true, // saved into the project and shown with the bridge's view_image (ACP prompts take no images)
    streaming: true,
    appTools: true,
    userQuestions: true,
    permissionRequests: true,
    resume: true,
    fork: true,
    modelSwitch: true,
    usage: "tokens", // ACP reports tokens, not cost
    isolation: { workspaceWrites: true, network: true, level: "full" },
  }
}

/** What the runtime needs from the outside world; tests replace it (scripted ACP agent, fake shell). */
export interface GrokDeps {
  findBinary(): string | null
  spawn(o: { bin: string; args: string[]; cwd: string; env: Record<string, string | undefined> }): RpcTransport
  /** Grok home for a sign-in mode (created on demand). */
  home(mode: GrokAccessMode): string
  secret(ref: string): string | null
  /** Short grok commands (version, models). */
  run(bin: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }>
  /** sandbox-exec is usable (macOS). */
  sandbox(): boolean
  /** How sandboxed commands are started (tests). */
  spawner?: CommandSpawner
  /** Extra config.toml TOML (tests and the boundary check: a local fake model). */
  extraConfig?: string
  /** Every JSON-RPC message (diagnostics / fixtures). API keys are redacted. */
  record?(dir: "<" | ">", msg: RpcMessage, conn: string): void
  /** How `grok login` is started (tests: a fake process replaying fixtures/device-auth.txt). */
  spawnLogin?(bin: string, args: string[], env: Record<string, string>): LoginChild
}

export const defaultGrokDeps: GrokDeps = {
  findBinary: findGrokBinary,
  spawn: (o) => spawnGrok(o),
  home: grokHomeFor,
  secret: getSecret,
  run: runGrok,
  sandbox: sandboxAvailable,
  record: process.env.PRINTSTUDIO_GROK_RECORD
    ? (dir, msg, conn) => appendFileSync(process.env.PRINTSTUDIO_GROK_RECORD!, JSON.stringify({ conn, dir, msg }) + "\n")
    : undefined,
}

export interface GrokAccess {
  mode: GrokAccessMode
  bin: string
  home: string
  /** xAI API key (api-key profiles): only in the agent's environment, never written. */
  apiKey: string | null
}

export function grokAccess(deps: GrokDeps, profile?: AgentProfileSnapshot | null): GrokAccess {
  const bin = profile?.binaryPath || deps.findBinary()
  if (!bin) throw Object.assign(new Error(GROK_NOT_INSTALLED), { statusCode: 409 })
  if (profile?.auth.kind === "api-key") {
    const apiKey = deps.secret(profile.auth.credentialRef)
    if (!apiKey) throw Object.assign(new Error(GROK_NO_KEY_MESSAGE), { statusCode: 409 })
    return { mode: "api-key", bin, home: deps.home("api-key"), apiKey }
  }
  return { mode: "app", bin, home: deps.home("app"), apiKey: null }
}

/** Why the agent may not write `p`: Claude's Write policy plus Grok's own config/instruction files. */
export function grokProtectedReason(root: string, p: string): string | null {
  const reason = protectedReason(root, p)
  if (reason) return reason
  const parts = relative(realRoot(root), canonicalPath(root, p)).split(sep).filter(Boolean)
  const name = parts[parts.length - 1] ?? ""
  if (parts.some((x) => GROK_PROTECTED_PATHS.includes(x as (typeof GROK_PROTECTED_PATHS)[number]) && x.startsWith(".")) || /^AGENTS(\.override)?\.md$/i.test(name))
    return "The assistant's own settings, instructions (AGENTS.md) and skills are managed by Crease and can't be changed from a session."
  return null
}

function redactKey(msg: RpcMessage, key?: string | null): RpcMessage {
  if (!key) return msg
  return JSON.parse(JSON.stringify(msg).split(key).join("[redacted]")) as RpcMessage
}

/** Redacted copy for the native log (inline images and file contents trimmed). */
function forLog(m: unknown): unknown {
  return JSON.parse(
    JSON.stringify(m ?? null, (k, v) => (typeof v === "string" && v.length > 2000 ? `${v.slice(0, 200)}… [${v.length} chars]` : k === "data" && typeof v === "string" && v.length > 200 ? "[image]" : v))
  )
}

const isAuthError = (e: unknown) => e instanceof RpcError && (e.code === -32000 || e.code === -32001) && /auth/i.test(`${e.message} ${String(e.data ?? "")}`)

interface Opened {
  conn: RpcConnection
  init: any
}

/** Spawn `grok agent stdio` (home prepared) and run the ACP initialize handshake. */
async function openAgent(
  deps: GrokDeps,
  a: GrokAccess,
  o: { cwd: string; label: string; effort?: string | null; denyRead?: string[] },
  handlers: { onNotification?: (m: string, p: any) => void; onRequest?: (m: string, p: any) => Promise<unknown>; onClose?: (e?: string) => void } = {}
): Promise<Opened> {
  prepareGrokHome(a.home, { home: a.home, denyRead: o.denyRead, readOnly: [LIBRARIES_DIR], extra: deps.extraConfig })
  const args = ["agent", "--no-leader", ...(o.effort ? ["--reasoning-effort", o.effort] : []), "stdio"]
  const t = deps.spawn({ bin: a.bin, args, cwd: o.cwd, env: grokEnv(a.home, a.apiKey) })
  if (handlers.onClose) t.onClose(handlers.onClose)
  const conn = new RpcConnection(
    t,
    {
      onNotification: (m, p) => handlers.onNotification?.(m, p),
      onRequest: handlers.onRequest ?? (async (m) => Promise.reject(new RpcError(`${m} isn't supported here`, -32601))),
      onMessage: deps.record ? (dir, msg) => deps.record!(dir, redactKey(msg, a.apiKey), o.label) : undefined,
    },
    { jsonrpc: true, peer: "Grok" }
  )
  try {
    const init = await conn.request<any>("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: CLIENT_CAPABILITIES, clientInfo: CLIENT_INFO }, 30_000)
    return { conn, init }
  } catch (e) {
    conn.close()
    throw e
  }
}

interface ModelInfo {
  value: string
  label: string
}
const modelsOf = (state: any): ModelInfo[] =>
  (state?.availableModels ?? []).map((m: any) => ({ value: String(m.modelId), label: String(m.name ?? m.modelId) })).filter((m: ModelInfo) => m.value)

export class GrokAdapter implements AgentAdapter {
  private conn: RpcConnection | null = null
  private ctx!: AgentSessionContext
  private access!: GrokAccess
  private sessionId = ""
  private running = false
  private queue: AgentTurnInput[] = []
  private turnAbort = new AbortController()
  private turnN = 0
  private turnStartedAt = 0
  private interrupting = false
  private closing = false
  private _alive = false
  private norm = new GrokNormalizer()
  private bridge: McpBridge | null = null
  private terminals: Terminals | null = null
  private models: ModelInfo[] = []
  private authReported = false
  /** The agent's own error for the running turn (prompt_complete / a failed retry), if it reported one. */
  private turnError: string | null = null

  constructor(
    private host: AdapterHost,
    private deps: GrokDeps = defaultGrokDeps
  ) {}

  get alive() {
    return this._alive
  }

  async start(ctx: AgentSessionContext): Promise<{ nativeSessionId: string | null }> {
    this.ctx = ctx
    const a = grokAccess(this.deps, ctx.profile)
    this.access = a
    if (!this.deps.sandbox()) throw Object.assign(new Error(GROK_NO_SANDBOX), { statusCode: 409 })
    const denyRead = [...(ctx.policy.denyRead ?? []), join(a.home, "auth.json")]
    this.terminals = new Terminals({ root: ctx.cwd, denyRead, readRoots: ctx.policy.readRoots, spawner: this.deps.spawner, sandbox: !this.deps.spawner })
    this.bridge = await startMcpBridge({ root: ctx.cwd, tools: ctx.tools })
    let opened: Opened
    try {
      opened = await openAgent(
        this.deps,
        a,
        { cwd: ctx.cwd, label: "session", effort: ctx.profile.effort ?? null, denyRead: ctx.policy.denyRead },
        { onNotification: (m, p) => this.onNotification(m, p), onRequest: (m, p) => this.onRequest(m, p), onClose: (e) => this.onClosed(e) }
      )
    } catch (e) {
      this.bridge.close()
      throw e
    }
    const { conn, init } = opened
    this.conn = conn
    this._alive = true
    try {
      const common = { cwd: ctx.cwd, mcpServers: [this.bridge.server], _meta: { rules: grokInstructions(ctx.instructions) } }
      let session: any = null
      if (ctx.resume) {
        try {
          session = await conn.request<any>("session/resume", { sessionId: ctx.resume, ...common }, 60_000)
          this.sessionId = ctx.resume
        } catch (e) {
          if (isAuthError(e)) throw e
          this.host.emit(
            { type: "notice", level: "info", text: `Couldn't reopen the earlier Grok conversation (${e instanceof Error ? e.message : String(e)}); starting a fresh one in this session.` },
            { itemId: `resume:${ctx.sessionId}:${Date.now()}` }
          )
        }
      }
      if (!session) {
        session = await conn.request<any>("session/new", common, 60_000)
        this.sessionId = String(session.sessionId)
      }
      this.models = modelsOf(session?.models ?? init?._meta?.modelState)
      let model: string | null = session?.models?.currentModelId ?? null
      if (ctx.profile.model && ctx.profile.model !== model) {
        if (this.models.some((m) => m.value === ctx.profile.model)) {
          await conn.request("session/set_model", { sessionId: this.sessionId, modelId: ctx.profile.model }, 30_000)
          model = ctx.profile.model
        } else
          this.host.emit(
            { type: "notice", level: "info", text: `Grok doesn't list the model "${ctx.profile.model}"; using Grok's default.` },
            { itemId: `model:${ctx.sessionId}:${Date.now()}` }
          )
      }
      this.host.emit(
        { type: "notice", level: "info", text: "Session started (Grok Build)", code: "session.started", data: { cwd: ctx.cwd, model, runtime: "grok", version: init?._meta?.agentVersion ?? null } },
        { itemId: `start:${this.sessionId}:${Date.now()}` }
      )
      return { nativeSessionId: this.sessionId }
    } catch (e) {
      this.closing = true
      this._alive = false
      this.bridge?.close()
      conn.close()
      if (isAuthError(e)) throw Object.assign(new Error(GROK_AUTH_MESSAGE), { statusCode: 409, code: GROK_AUTH_CODE })
      throw e
    }
  }

  send(input: AgentTurnInput) {
    if (this.running) this.queue.push(input)
    else void this.runTurn([input])
  }

  /** Note in front of messages that waited for the turn to end (ACP can't add to a running prompt). */
  static readonly WHILE_BUSY =
    "(The user sent this while you were still working on the previous request. It may change or replace what you just did: follow it.)"

  private async runTurn(ts: AgentTurnInput[], whileBusy = false) {
    if (!this.conn) return
    this.running = true
    this.turnAbort = new AbortController()
    this.turnStartedAt = Date.now()
    this.turnError = null
    this.norm.startTurn(`p${++this.turnN}:${Date.now().toString(36)}`)
    const prompt = ts.map((t, i) => {
      let text = t.agentText || "(see the attached image)"
      if (whileBusy && i === 0) text = `${GrokAdapter.WHILE_BUSY}\n\n${text}`
      if (t.images.length) {
        // ACP prompts take no images (promptCapabilities.image false): saved into the project, shown with view_image.
        const paths = t.images.map((i) => saveAgentImage(this.ctx.cwd, i.data, i.mediaType))
        text += `\n\n(The user attached ${paths.length > 1 ? "images" : "an image"}: ${paths.join(", ")}. Look at ${paths.length > 1 ? "them" : "it"} with studio__view_image.)`
      }
      return { type: "text", text }
    })
    try {
      const sent = this.conn.request<any>("session/prompt", { sessionId: this.sessionId, prompt })
      for (const t of ts) if (t.id) this.host.received?.(t.id)
      const r = await sent
      this.finishTurn(r)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (isAuthError(e) && !this.authReported) {
        this.authReported = true
        this.host.emit({ type: "notice", level: "error", code: GROK_AUTH_CODE, text: GROK_AUTH_MESSAGE }, { itemId: `auth:${this.sessionId}` })
      }
      this.flush()
      const known = grokTurnError(this.turnError)
      if (known?.code) this.host.emit({ type: "notice", level: "error", code: known.code, text: known.text }, { itemId: `${known.code}:${this.turnN}` })
      this.endRun({ type: "run.failed", error: known ? known.text : `Grok couldn't finish the turn: ${msg}` }, `fail:${Date.now()}`)
    }
  }

  private flush() {
    for (const o of this.norm.flush()) this.host.emit(o.event, { itemId: o.itemId, persist: o.persist })
  }

  private usageOf(meta: any, final: boolean): AgentUsage {
    const u = meta?.usage ?? meta ?? {}
    const n = (k: string) => (typeof u[k] === "number" ? u[k] : null)
    const input = n("inputTokens")
    const cacheRead = n("cachedReadTokens")
    const cacheWrite = n("cacheCreationTokens")
    // ACP inputTokens is the full prompt (cache included); the app's `input` is the uncached part (as for Claude).
    const uncached = input === null ? null : Math.max(0, input - (cacheRead ?? 0) - (cacheWrite ?? 0))
    return {
      tokens: input === null && n("outputTokens") === null ? null : { input: uncached, output: n("outputTokens"), cacheRead, cacheWrite },
      billedUsd: null,
      estimatedApiUsd: null,
      billing: this.access?.mode === "api-key" ? "api" : "plan",
      subscription: null,
      final,
    }
  }

  private finishTurn(r: any) {
    this.flush()
    const stop = String(r?.stopReason ?? "end_turn")
    const meta = r?._meta ?? {}
    const result = {
      subtype: stop === "end_turn" ? "success" : stop === "cancelled" ? "interrupted" : stop,
      isError: stop === "refusal",
      text: "",
      durationMs: this.turnStartedAt ? Date.now() - this.turnStartedAt : null,
      turns: typeof meta?.usage?.numTurns === "number" ? meta.usage.numTurns : null,
      usage: this.usageOf(meta, true),
      queued: this.queue.length,
    }
    const itemId = `end:${meta.promptId ?? Date.now()}`
    // Cancelled: what's queued now was sent after Stop and still runs.
    if (stop === "cancelled" || this.interrupting) this.endRun({ type: "run.interrupted", result }, itemId)
    else if (stop === "error") {
      const known = grokTurnError(this.turnError) ?? { text: "Grok stopped with an error." }
      if (known.code) this.host.emit({ type: "notice", level: "error", code: known.code, text: known.text }, { itemId: `${known.code}:${this.turnN}` })
      this.endRun({ type: "run.failed", error: known.text, result: { ...result, isError: true, text: known.text } }, itemId)
    } else this.endRun({ type: "run.completed", result }, itemId)
  }

  private endRun(event: Parameters<AdapterHost["emit"]>[0], itemId: string) {
    this.running = false
    this.interrupting = false
    this.turnAbort.abort() // anything still waiting on the user for this turn is over
    this.host.emit(event, { itemId })
    // Everything queued goes in one prompt: answered together instead of one stale turn each.
    const next = this.queue.splice(0)
    if (next.length && this._alive) void this.runTurn(next, true)
  }

  answerQuestion(requestId: string, answers: Record<string, string>, notes?: Record<string, string>) {
    answerPendingQuestion(this.ctx.projectId, requestId, answers, notes)
  }

  answerPermission(requestId: string, decision: { allow: boolean }) {
    answerPendingPermission(this.ctx.projectId, requestId, decision.allow)
  }

  async interrupt() {
    if (!this.conn || !this._alive) return
    this.queue.length = 0
    this.turnAbort.abort()
    this.terminals?.killAll()
    if (!this.running) return
    this.interrupting = true
    this.conn.notify("session/cancel", { sessionId: this.sessionId })
  }

  async setModel(model: string) {
    if (!this.conn) return
    await this.conn.request("session/set_model", { sessionId: this.sessionId, modelId: model }, 30_000)
  }

  close() {
    if (this.closing) return
    this.closing = true
    this.queue.length = 0
    this.turnAbort.abort()
    this.terminals?.killAll()
    this.bridge?.close()
    this.conn?.close()
  }

  private onClosed(error?: string) {
    const wasAlive = this._alive
    this._alive = false
    this.turnAbort.abort()
    this.terminals?.killAll()
    this.bridge?.close()
    if (!wasAlive && !this.conn) return
    this.host.ended({ error: this.closing ? undefined : error })
  }

  // ---------------------------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------------------------

  private onNotification(method: string, p: any) {
    if (p?.sessionId && this.sessionId && p.sessionId !== this.sessionId) return
    if (!QUIET.has(method)) {
      const live = method === "session/update" && /_chunk$/.test(String(p?.update?.sessionUpdate ?? ""))
      this.host.native({ method, params: forLog(p) }, { persist: !live })
    }
    if (method === "session/update") {
      for (const o of this.norm.convert(p?.update)) this.host.emit(o.event, { itemId: o.itemId, persist: o.persist })
      return
    }
    if (method === "_x.ai/session/prompt_complete") {
      if (p?.stopReason === "error" && typeof p?.agentResult === "string") this.turnError = p.agentResult
      return
    }
    if (method === "_x.ai/session_notification") {
      const u = p?.update ?? {}
      if (u.sessionUpdate === "retry_state" && u.type === "failed" && typeof u.message === "string") this.turnError ??= u.message
      if (u.sessionUpdate === "response_completed" && u.usage) {
        // Per model response (live estimate); the turn total comes with the session/prompt result.
        const usage = this.usageOf({ inputTokens: u.usage.input_tokens + (u.usage.cache_read_input_tokens ?? 0) + (u.usage.cache_creation_input_tokens ?? 0), outputTokens: u.usage.output_tokens, cachedReadTokens: u.usage.cache_read_input_tokens, cacheCreationTokens: u.usage.cache_creation_input_tokens }, false)
        this.host.emit({ type: "usage.updated", usage }, { persist: false })
      } else if (u.sessionUpdate === "auto_compact_completed" || u.sessionUpdate === "compaction_completed") {
        this.host.emit({ type: "notice", level: "info", text: "Context compacted" }, { itemId: `compact:${Date.now()}` })
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Agent -> client requests
  // ---------------------------------------------------------------------------------------------

  private async onRequest(method: string, p: any): Promise<unknown> {
    this.host.native({ request: method, params: forLog(p) })
    switch (method) {
      case "session/request_permission":
        return this.permission(p)
      case "_x.ai/ask_user_question":
        return this.question(p)
      case "fs/write_text_file":
        return this.writeFile(p)
      case "fs/read_text_file":
        return this.readFile(p)
      case "terminal/create":
        return this.terminals!.create(p)
      case "terminal/output":
        return this.terminals!.output(p?.terminalId)
      case "terminal/wait_for_exit":
        return this.terminals!.waitForExit(p?.terminalId)
      case "terminal/kill":
        return this.terminals!.kill(p?.terminalId)
      case "terminal/release":
        return this.terminals!.release(p?.terminalId)
      default:
        throw new RpcError(`Crease doesn't handle ${method}`, -32601)
    }
  }

  /**
   * The app's policy for Grok's permission requests (never "always"). Allowed once: the app's own MCP tools, questions,
   * edits (the app performs the write through fs/write_text_file and refuses app-owned paths there, so the model gets
   * an error and carries on) and shell commands (run by the app in its sandbox). Refused: anything else (other MCP
   * servers, unknown tools). Grok ends the turn on a refusal (cancellationCategory PermissionRejected), so refusals are
   * kept for what must never run; subagents and web fetch are switched off in config.ts and never get here.
   */
  private permission(p: any) {
    const call = p?.toolCall ?? {}
    const tool = grokToolOf(call)
    const raw = call.rawInput ?? {}
    const options: any[] = Array.isArray(p?.options) ? p.options : []
    const pick = (kind: "allow_once" | "reject_once") => {
      const o = options.find((x) => x?.kind === kind)
      return o ? { outcome: { outcome: "selected", optionId: o.optionId } } : { outcome: { outcome: "cancelled" } }
    }
    return pick(GROK_ALLOWED_TOOLS.has(tool) || (tool === "use_tool" && String(raw.tool_name ?? "").startsWith("studio__")) ? "allow_once" : "reject_once")
  }

  private async question(p: any) {
    const qs: any[] = Array.isArray(p?.questions) ? p.questions : []
    const input: QuestionInput = {
      questions: qs.map((q) => ({
        question: String(q.question ?? ""),
        header: String(q.header ?? ""),
        multiSelect: !!q.multiSelect,
        options: (q.options ?? []).map((o: any) => ({ label: String(o.label ?? ""), description: String(o.description ?? ""), ...(o.preview ? { preview: String(o.preview) } : {}) })),
      })),
    }
    const r = await this.host.askUser(input, { signal: this.turnAbort.signal, toolUseID: p?.toolCallId ? `${this.norm.turnId}:${p.toolCallId}` : undefined })
    if (!r.answered) return { outcome: "cancelled" }
    const annotations: Record<string, { notes: string }> = {}
    for (const [q, a] of Object.entries(r.annotations ?? {})) if (a?.notes) annotations[q] = { notes: a.notes }
    return { outcome: "accepted", answers: r.answers, annotations }
  }

  /** fs/write_text_file: the app writes the file, inside the project and off app-owned paths (Claude's Write policy). */
  private writeFile(p: any) {
    const path = String(p?.path ?? "")
    const reason = grokProtectedReason(this.ctx.cwd, path)
    if (reason) throw new RpcError(`Blocked by Crease: ${reason}`, -32000)
    const abs = canonicalPath(this.ctx.cwd, path)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, String(p?.content ?? ""))
    this.host.nativeToolAllowed("Write", { file_path: abs })
    return null
  }

  /**
   * fs/read_text_file: the project (symlinks resolved) and the bundled OpenSCAD libraries; never the app's secret files
   * or anything else outside. Refusals are tool errors (the turn goes on).
   */
  private readFile(p: any) {
    const path = String(p?.path ?? "")
    const abs = canonicalPath(this.ctx.cwd, path)
    const deny = [...(this.ctx.policy.denyRead ?? []), join(this.access.home, "auth.json")].map((d) => canonicalPath(d, d))
    const allowed = isInside(realRoot(this.ctx.cwd), abs) || isInside(realRoot(LIBRARIES_DIR), abs)
    if (!allowed || deny.some((d) => isInside(d, abs))) throw new RpcError(`Blocked by Crease: the designer can only read files in this project (${path} is outside it).`, -32000)
    let content: string
    try {
      content = readFileSync(abs, "utf8")
    } catch (e) {
      throw new RpcError(`Couldn't read ${path}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`, -32000)
    }
    if (typeof p?.line === "number" || typeof p?.limit === "number") {
      const lines = content.split("\n")
      const start = Math.max(0, (p.line ?? 1) - 1)
      content = lines.slice(start, p.limit ? start + p.limit : undefined).join("\n")
    }
    return { content }
  }
}

// -------------------------------------------------------------------------------------------------
// Runtime
// -------------------------------------------------------------------------------------------------

async function checkXaiKey(key: string): Promise<AgentConnectionStep> {
  try {
    const r = await fetch("https://api.x.ai/v1/models", { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) })
    if (r.ok) return { label: "API key accepted", ok: true, detail: "xAI accepted the key (no charge for this check)." }
    if (r.status === 401 || r.status === 403) return { label: "API key accepted", ok: false, detail: "xAI rejected this key. Paste a new one from console.x.ai." }
    return { label: "API key accepted", ok: null, detail: `xAI answered ${r.status}; try again in a minute.` }
  } catch (e) {
    return { label: "API key accepted", ok: null, detail: `Couldn't reach xAI (${(e as Error).name === "TimeoutError" ? "timed out" : "no connection"}). Check your internet.` }
  }
}

/** `grok models` output: sign-in state and the model list (no model call). */
export function parseModels(out: string): { signedIn: boolean; models: ModelInfo[]; defaultModel: string | null } {
  const signedIn = !/not authenticated|not signed in|log ?in required/i.test(out)
  const models: ModelInfo[] = []
  let defaultModel: string | null = null
  for (const line of out.split("\n")) {
    const m = /^\s*[*-]\s+([\w.:/-]+)(\s+\(default\))?/.exec(line)
    if (!m) continue
    models.push({ value: m[1], label: m[1] })
    if (m[2]) defaultModel = m[1]
  }
  defaultModel ??= /Default model:\s*([\w.:/-]+)/.exec(out)?.[1] ?? null
  return { signedIn, models, defaultModel }
}

const versionOf = (out: string) => /(\d+\.\d+\.\d+[\w.-]*)/.exec(out)?.[1] ?? null

export class GrokRuntime implements AgentRuntime {
  readonly kind = "grok"
  readonly ownSessionIds = true
  readonly capabilities = grokCapabilities()
  private cache: { at: number; probe: AgentRuntimeProbe } | null = null
  private loginRun: DeviceLogin | null = null

  constructor(private deps: GrokDeps = defaultGrokDeps) {}

  create(host: AdapterHost): AgentAdapter {
    return new GrokAdapter(host, this.deps)
  }

  /** `grok <args>` with the session environment of an access (home prepared). */
  private async cli(a: GrokAccess, args: string[]) {
    prepareGrokHome(a.home, { home: a.home, readOnly: [LIBRARIES_DIR], extra: this.deps.extraConfig })
    return this.deps.run(a.bin, args, grokEnv(a.home, a.apiKey))
  }

  async probe(): Promise<AgentRuntimeProbe> {
    if (this.cache && Date.now() - this.cache.at < 30_000) return this.cache.probe
    const base = { runtime: "grok", capabilities: this.capabilities, effortLevels: GROK_EFFORTS }
    let a: GrokAccess
    try {
      a = grokAccess(this.deps, null)
    } catch {
      return { ...base, installed: false, version: null, auth: { method: "login", status: "unknown" }, models: [], ready: false, detail: GROK_NOT_INSTALLED }
    }
    const v = await this.cli(a, ["--version"])
    const version = versionOf(v.out)
    if (v.code === null && !version) {
      return { ...base, installed: true, version: null, auth: { method: "login", status: "unknown" }, models: [], ready: false, detail: `Couldn't run ${a.bin}.` }
    }
    const m = parseModels((await this.cli(a, ["models"])).out)
    const sandbox = this.deps.sandbox()
    const probe: AgentRuntimeProbe = {
      ...base,
      installed: true,
      version,
      auth: { method: "login", status: m.signedIn ? "ok" : "missing" },
      login: { plan: null, fix: m.signedIn ? null : GROK_SIGN_IN_FIX },
      models: m.models,
      defaultModel: m.defaultModel,
      ready: m.signedIn && sandbox,
      detail: !sandbox ? GROK_NO_SANDBOX : m.signedIn ? "Signed in." : "Sign in with Grok, or use an xAI key.",
    }
    this.cache = { at: Date.now(), probe }
    return probe
  }

  invalidate() {
    this.cache = null
  }

  /** "Test connection": program, sign-in or key, sandbox. No model call. */
  async checkConnection(profile: AgentProfileSnapshot): Promise<AgentConnectionResult> {
    const steps: AgentConnectionStep[] = []
    let a: GrokAccess
    try {
      a = grokAccess(this.deps, profile)
    } catch (e) {
      const msg = (e as Error).message
      const missing = msg === GROK_NOT_INSTALLED
      steps.push({ label: missing ? "Grok installed" : "API key saved", ok: false, detail: msg })
      return { ok: false, steps, summary: msg, fix: missing ? { kind: "open-url", label: "Get Grok Build", url: "https://docs.x.ai/build/overview" } : null }
    }
    const version = versionOf((await this.cli(a, ["--version"])).out)
    steps.push({ label: "Grok installed", ok: version !== null, detail: version ? `Grok ${version}` : `Couldn't run ${a.bin}` })
    if (!version) return { ok: false, steps, summary: "The Grok program didn't start. Reinstall it, then test again.", fix: { kind: "open-url", label: "Get Grok Build", url: "https://docs.x.ai/build/overview" } }
    const sandbox = this.deps.sandbox()
    const sandboxStep: AgentConnectionStep = { label: "Safety sandbox", ok: sandbox, detail: sandbox ? "Full: project folder only, no network for commands, printers only through Crease." : GROK_NO_SANDBOX }
    if (a.mode === "api-key") {
      steps.push({ label: "API key saved", ok: true })
      const check = await checkXaiKey(a.apiKey!)
      steps.push(check, sandboxStep)
      return {
        ok: check.ok === true && sandbox,
        steps,
        summary: !sandbox ? GROK_NO_SANDBOX : check.ok ? "Ready. Messages are billed to your xAI API key." : check.ok === false ? "Replace the key, then test again." : "Couldn't check the key right now. Try again in a minute.",
      }
    }
    const m = parseModels((await this.cli(a, ["models"])).out)
    steps.push({ label: "Signed in", ok: m.signedIn, detail: m.signedIn ? "Signed in." : "Not signed in." }, sandboxStep)
    if (!m.signedIn) return { ok: false, steps, summary: "Sign in to Grok, then test again.", fix: GROK_SIGN_IN_FIX }
    return { ok: sandbox, steps, summary: sandbox ? "Ready. Uses your Grok account's allowance." : GROK_NO_SANDBOX }
  }

  /** "Send a test message": one tiny turn, no tools allowed, in a scratch folder. */
  async testMessage(profile: AgentProfileSnapshot): Promise<AgentConnectionResult> {
    const steps: AgentConnectionStep[] = []
    let a: GrokAccess
    try {
      a = grokAccess(this.deps, profile)
    } catch (e) {
      return { ok: false, steps, summary: (e as Error).message }
    }
    const cwd = mkdtempSync(join(tmpdir(), "ps-grok-test-"))
    let reply = ""
    let error: string | null = null
    let conn: RpcConnection | null = null
    try {
      conn = (
        await openAgent(
          this.deps,
          a,
          { cwd, label: "test", effort: profile.effort ?? null },
          {
            onNotification: (m, p) => {
              if (m === "session/update" && p?.update?.sessionUpdate === "agent_message_chunk") reply += String(p.update.content?.text ?? "")
            },
            onRequest: async (m, p) => {
              if (m === "session/request_permission") {
                const o = (p?.options ?? []).find((x: any) => x?.kind === "reject_once")
                return o ? { outcome: { outcome: "selected", optionId: o.optionId } } : { outcome: { outcome: "cancelled" } }
              }
              if (m === "_x.ai/ask_user_question") return { outcome: "cancelled" }
              throw new RpcError("not in a test", -32601)
            },
          }
        )
      ).conn
      const s = await conn.request<any>("session/new", { cwd, mcpServers: [] }, 60_000)
      if (profile.model && modelsOf(s?.models).some((m) => m.value === profile.model)) await conn.request("session/set_model", { sessionId: s.sessionId, modelId: profile.model }, 30_000)
      const r = await Promise.race([
        conn.request<any>("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "This is a connection test from Crease. Reply with exactly: Ready to design." }] }),
        new Promise<null>((res) => setTimeout(() => res(null), 90_000).unref()),
      ])
      if (!r) error = "No answer within 90 seconds."
    } catch (e) {
      error = isAuthError(e) ? GROK_AUTH_MESSAGE : e instanceof Error ? e.message : String(e)
    } finally {
      conn?.close()
      setTimeout(() => rmSync(cwd, { recursive: true, force: true }), 2000).unref()
    }
    if (error || !reply.trim()) {
      steps.push({ label: "Test message", ok: false, detail: error ?? "No reply." })
      return { ok: false, steps, summary: error ?? "Grok didn't reply.", fix: a.mode === "app" ? GROK_SIGN_IN_FIX : null, costUsd: null }
    }
    steps.push({ label: "Test message", ok: true, detail: `Replied: “${reply.trim().slice(0, 200)}”` })
    return {
      ok: true,
      steps,
      reply: reply.trim().slice(0, 500),
      costUsd: null,
      summary: a.mode === "api-key" ? "It answered. Grok doesn't report the cost here; it's billed to your xAI API key." : "It answered. This used a little of your Grok allowance.",
    }
  }

  async fork(nativeSessionId: string, o: { cwd: string; title?: string }): Promise<{ nativeSessionId: string }> {
    // Sessions live in the Grok home that holds them; a fork is a local copy (no model call).
    const a = grokAccess(this.deps, null)
    const { conn } = await openAgent(this.deps, a, { cwd: o.cwd, label: "fork" })
    try {
      const r = await conn.request<any>("_x.ai/session/fork", { sourceSessionId: nativeSessionId, sourceCwd: o.cwd, newCwd: o.cwd }, 60_000)
      return { nativeSessionId: String(r.newSessionId) }
    } finally {
      conn.close()
    }
  }

  /**
   * Sign in to the app's own Grok home with the device-code flow (`grok login --device-auth`, see login.ts). Returns
   * the sign-in URL and the code the user types or checks there. The CLI keeps polling until the sign-in completes
   * (or 10 minutes pass); loginStatus() tells the renderer when it's done.
   */
  async login(): Promise<{ authUrl: string; code: string }> {
    const a = grokAccess(this.deps, null)
    prepareGrokHome(a.home, { home: a.home, readOnly: [LIBRARIES_DIR], extra: this.deps.extraConfig })
    this.loginRun?.cancel("Started again.")
    const env = { ...grokEnv(a.home, null), BROWSER: "/usr/bin/true" }
    const args = ["login", "--device-auth"]
    const child = this.deps.spawnLogin ? this.deps.spawnLogin(a.bin, args, env) : spawn(a.bin, args, { env, stdio: ["pipe", "pipe", "pipe"] })
    const run = new DeviceLogin(child, { onExit: () => this.invalidate() })
    this.loginRun = run
    return run.started
  }

  loginStatus(): RuntimeLoginStatus {
    return this.loginRun?.status() ?? { state: "idle", authUrl: null, code: null, error: null }
  }

  cancelLogin() {
    this.loginRun?.cancel()
  }

  shutdown() {
    this.loginRun?.cancel()
    killAllAgentProcesses("SIGTERM")
  }
}

export const grokRuntime = new GrokRuntime()
