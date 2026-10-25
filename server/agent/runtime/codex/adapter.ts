// Codex runtime (R11d): a Codex session through `codex app-server` (JSON-RPC over stdio, Codex CLI 0.161).
//
// One app-server process per app session. Lifecycle: preflight (sign-in, skills to turn off, user MCP servers) on a
// short-lived process, then the session process: initialize -> skills/extraRoots/set (the app's skills) ->
// thread/start (new) or thread/resume (native thread id from the coordinator's map) -> turn/start for a message sent
// while idle; one sent while a turn runs is steered into it (turn/steer: the model reads it at its next step), or
// queued for the next turn when Codex refuses (a compact/review turn, or the turn just ended) -> turn/interrupt to stop. Items stream as notifications (normalize.ts); the app's
// tools and AskUserQuestion are dynamic tools called back on the same connection (tools.ts); approvals are decided
// by the app's policy, and only what the policy can't decide alone reaches the user (permission.requested).
// Isolation and config: config.ts.
import { execFile } from "node:child_process"
import { appendFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import type {
  AgentConnectionResult,
  AgentConnectionStep,
  AgentEffort,
  AgentProfileSnapshot,
  AgentRuntimeCapabilities,
  AgentRuntimeProbe,
  AgentTokenUsage,
  AgentUsage,
  CodexRuntimeSettings,
  RuntimeLoginStatus,
} from "../../../../shared/types"
import { getSecret } from "../../../secrets"
import { isInside } from "../../../projects/paths"
import { answerPermission as answerPendingPermission } from "../../permissions"
import { protectedReason } from "../../policy"
import { answerQuestion as answerPendingQuestion } from "../../questions"
import type { AdapterHost, AgentAdapter, AgentRuntime, AgentSessionContext, AgentTurnInput, QuestionInput } from "../types"
import { apiCodexHome, codexHomeFor, codexLogin, codexSettings, configOverrides, type CodexLogin, userHomeIsolationReason } from "./config"
import { codexInstructions } from "./instructions"
import { CodexNormalizer } from "./normalize"
import { killAllAgentProcesses } from "../../spawn"
import { findCodexBinary, spawnCodex } from "./process"
import { RpcConnection, RpcError, type RpcMessage, type RpcTransport } from "./rpc"
import { ASK_TOOL, askResultText, dynamicToolSpecs, toDynamicResponse } from "./tools"

/* eslint-disable @typescript-eslint/no-explicit-any */

export const CODEX_AUTH_CODE = "codex.auth"
export const CODEX_AUTH_MESSAGE =
  "Codex isn't signed in. Open Designers and sign in."
export const CODEX_PARTIAL_MESSAGE =
  "Your own Codex sign-in only partly isolates design chats. " +
  "In Designers, sign in with ChatGPT " +
  "or allow partial isolation."
export const CODEX_NO_KEY_MESSAGE = "No OpenAI key saved. Add one in Designers."
export const CODEX_NOT_INSTALLED = "Codex isn't installed. Install the Codex CLI (https://developers.openai.com/codex) and try again."

const CLIENT_INFO = { name: "printstudio", title: "Crease", version: "0.0.1" }

/** Notifications the app never uses (kept out of the native log too). */
const OPT_OUT = [
  "remoteControl/status/changed",
  "mcpServer/startupStatus/updated",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/reasoning/textDelta",
  "item/reasoning/summaryPartAdded",
  "rawResponseItem/completed",
  "rawResponse/completed",
  "fs/changed",
  "app/list/updated",
  "skills/changed",
  "thread/prediction/updated",
  "process/outputDelta",
  "command/exec/outputDelta",
]
/** High-frequency notifications: live only, not in the native log. */
const LIVE_ONLY = new Set(["item/agentMessage/delta", "item/reasoning/summaryTextDelta", "thread/tokenUsage/updated", "item/plan/delta", "item/mcpToolCall/progress"])

/** How a session signs in: the app's Codex home, the user's ~/.codex, or an OpenAI API key (in memory only). */
export type CodexAccessMode = CodexLogin | "api-key"

export function codexCapabilities(login: CodexAccessMode): AgentRuntimeCapabilities {
  return {
    images: true,
    streaming: true,
    appTools: true,
    userQuestions: true,
    permissionRequests: true,
    resume: true,
    fork: true,
    modelSwitch: true,
    // Codex reports tokens; it doesn't report money (a ChatGPT plan isn't billed per token, API prices aren't sent).
    usage: "tokens",
    isolation:
      login !== "user"
        ? { workspaceWrites: true, network: true, level: "full" }
        : { workspaceWrites: true, network: true, level: "partial", reason: userHomeIsolationReason() },
  }
}

/** What the runtime needs from the outside world; tests replace it (fixture transports, settings). */
export interface CodexDeps {
  findBinary(): string | null
  spawn(o: { bin: string; args: string[]; cwd: string; env: Record<string, string | undefined> }): RpcTransport
  settings(): CodexRuntimeSettings
  /** Codex home for a login (app home is created on demand). */
  home(login: CodexLogin): string
  /** A secret by ref (API-key profiles). */
  secret(ref: string): string | null
  /** Every JSON-RPC message (diagnostics / fixture recording). API keys are already redacted. */
  record?(dir: "<" | ">", msg: RpcMessage, conn: string): void
}

export const defaultCodexDeps: CodexDeps = {
  findBinary: findCodexBinary,
  spawn: (o) => spawnCodex(o),
  settings: codexSettings,
  home: codexHomeFor,
  secret: getSecret,
  // PRINTSTUDIO_CODEX_RECORD=<file>: append every JSON-RPC message (raw; scrub before sharing) for protocol fixtures.
  record: process.env.PRINTSTUDIO_CODEX_RECORD
    ? (dir, msg, conn) => appendFileSync(process.env.PRINTSTUDIO_CODEX_RECORD!, JSON.stringify({ conn, dir, msg }) + "\n")
    : undefined,
}

function childEnv(home: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, CODEX_HOME: home }
  // The Anthropic key (if any) is the Claude runtime's; never hand it to another runtime or its commands.
  delete env.ANTHROPIC_API_KEY
  return env
}

/** Where a session's Codex runs from and how it signs in. Throws plain-words errors for the user. */
export interface CodexAccess {
  mode: CodexAccessMode
  bin: string
  home: string
  /** OpenAI API key (api-key profiles): sent to the app-server with account/login/start, kept in memory only. */
  apiKey: string | null
  /** Extra -c overrides for this access (ephemeral credential store for API keys). */
  args: string[]
}

export function codexAccess(deps: CodexDeps, profile?: AgentProfileSnapshot | null): CodexAccess {
  const bin = profile?.binaryPath || deps.findBinary()
  if (!bin) throw Object.assign(new Error(CODEX_NOT_INSTALLED), { statusCode: 409 })
  if (profile?.auth.kind === "api-key") {
    const apiKey = deps.secret(profile.auth.credentialRef)
    if (!apiKey) throw Object.assign(new Error(CODEX_NO_KEY_MESSAGE), { statusCode: 409 })
    // A home with no stored sign-in; the key lives only in the app-server's memory ("ephemeral" store).
    return { mode: "api-key", bin, home: apiCodexHome(), apiKey, args: ["-c", 'cli_auth_credentials_store="ephemeral"'] }
  }
  const login = codexLogin(deps.settings())
  return { mode: login, bin, home: deps.home(login), apiKey: null, args: [] }
}

interface Opened {
  conn: RpcConnection
  init: { userAgent?: string; codexHome?: string }
}

/** Spawn an app-server and run the initialize handshake. */
async function openAppServer(
  deps: CodexDeps,
  o: { bin: string; args: string[]; cwd: string; home: string; label: string; apiKey?: string | null },
  handlers: { onNotification?: (m: string, p: any) => void; onRequest?: (m: string, p: any, id: number | string) => Promise<unknown>; onClose?: (e?: string) => void } = {}
): Promise<Opened> {
  const t = deps.spawn({ bin: o.bin, args: o.args, cwd: o.cwd, env: childEnv(o.home) })
  if (handlers.onClose) t.onClose(handlers.onClose)
  const conn = new RpcConnection(t, {
    onNotification: (m, p) => handlers.onNotification?.(m, p),
    onRequest: handlers.onRequest ?? (async (m) => Promise.reject(new RpcError(`${m} isn't supported here`, -32601))),
    onMessage: deps.record ? (dir, msg) => deps.record!(dir, redactKey(msg, o.apiKey), o.label) : undefined,
  })
  const init = await conn.request<{ userAgent?: string; codexHome?: string }>(
    "initialize",
    { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: OPT_OUT } },
    20_000
  )
  conn.notify("initialized", {})
  if (o.apiKey) {
    try {
      await conn.request("account/login/start", { type: "apiKey", apiKey: o.apiKey }, 20_000)
    } catch (e) {
      conn.close()
      throw Object.assign(new Error(`Codex didn't accept the OpenAI API key: ${e instanceof Error ? e.message : String(e)}`), { statusCode: 409 })
    }
  }
  return { conn, init }
}

function redactKey(msg: RpcMessage, key?: string | null): RpcMessage {
  if (!key) return msg
  return JSON.parse(JSON.stringify(msg).split(key).join("[redacted]")) as RpcMessage
}

interface Preflight {
  account: { type: string; planType?: string } | null
  models: { value: string; label: string; isDefault: boolean }[]
  disableSkills: string[]
  mcpServers: string[]
  version: string | null
}

const versionOf = (ua?: string) => /\/(\d+\.\d+\.\d+[\w.-]*)/.exec(ua ?? "")?.[1] ?? null

/** Short-lived app-server: sign-in, models, and the user config to neutralize. No model call. */
async function preflight(deps: CodexDeps, a: CodexAccess, cwd: string, appSkillsDir: string | null): Promise<Preflight> {
  const { conn, init } = await openAppServer(deps, {
    bin: a.bin,
    args: [...a.args, ...configOverrides({ cwd, codexHome: a.home })],
    cwd,
    home: a.home,
    apiKey: a.apiKey,
    label: "preflight",
  })
  try {
    const acct = await conn.request<any>("account/read", { refreshToken: false }, 20_000)
    const ml = await conn.request<any>("model/list", { limit: 100 }, 20_000).catch(() => ({ data: [] }))
    const models = (ml?.data ?? []).filter((m: any) => !m.hidden).map((m: any) => ({ value: String(m.model ?? m.id), label: String(m.displayName ?? m.model), isDefault: !!m.isDefault }))
    // User/system config layers may define MCP servers: turned off for the session.
    const cfg = await conn.request<any>("config/read", { includeLayers: true, cwd }, 20_000).catch(() => null)
    const mcpServers = [...new Set<string>((cfg?.layers ?? []).flatMap((l: any) => Object.keys(l?.config?.mcp_servers ?? {})))]
    // Every skill that isn't one of the app's (system skills, ~/.agents/skills, a project's .agents/skills) is off.
    if (appSkillsDir) await conn.request("skills/extraRoots/set", { extraRoots: [appSkillsDir] }, 20_000).catch(() => null)
    const sl = await conn.request<any>("skills/list", { cwds: [cwd], forceReload: true }, 20_000).catch(() => null)
    const disableSkills = [
      ...new Set<string>(
        (sl?.data ?? [])
          .flatMap((e: any) => e.skills ?? [])
          .map((s: any) => String(s.path ?? ""))
          .filter((p: string) => p && !(appSkillsDir && isInside(appSkillsDir, p)))
      ),
    ]
    return { account: acct?.account ?? null, models, disableSkills, mcpServers, version: versionOf(init.userAgent) }
  } finally {
    conn.close()
  }
}

function tokenDiff(now: any, base: any): AgentTokenUsage | null {
  if (!now) return null
  const d = (k: string) => (typeof now[k] === "number" ? now[k] - (typeof base?.[k] === "number" ? base[k] : 0) : null)
  return { input: d("inputTokens"), output: d("outputTokens"), cacheRead: d("cachedInputTokens"), cacheWrite: d("cacheWriteInputTokens") }
}

const billingOf = (account: Preflight["account"]): AgentUsage["billing"] => (account?.type === "apiKey" ? "api" : account?.type === "chatgpt" ? "plan" : "unknown")

/** Redacted copy of a protocol message for the native log (inline images dropped). */
function forLog(m: unknown): unknown {
  return JSON.parse(JSON.stringify(m ?? null, (_k, v) => (typeof v === "string" && v.startsWith("data:image/") && v.length > 200 ? "[image]" : v)))
}

export class CodexAdapter implements AgentAdapter {
  private conn: RpcConnection | null = null
  private ctx!: AgentSessionContext
  private threadId = ""
  private turnId: string | null = null
  private starting = false
  /** Messages for the next turn (steering refused, or sent while a turn was starting/stopping). */
  private queue: AgentTurnInput[] = []
  /** Steered messages (by input id) the model hasn't shown as read yet (no userMessage item with that clientId). */
  private steered = new Map<string, AgentTurnInput>()
  private turnAbort = new AbortController()
  private norm = new CodexNormalizer()
  private model: string | null = null
  private effort: string | null = null
  private totalTokens: any = null
  private turnBase: any = null
  private turnError: string | null = null
  private turnStartedAt = 0
  private interrupting = false
  /** Stop came while turn/start was still in flight: the turn is interrupted as soon as Codex says it started. */
  private stopOnStart = false
  private closing = false
  private _alive = false
  private billing: AgentUsage["billing"] = "unknown"
  private authReported = false
  private nativeSeq = 0

  constructor(
    private host: AdapterHost,
    private deps: CodexDeps = defaultCodexDeps
  ) {}

  get alive() {
    return this._alive
  }

  async start(ctx: AgentSessionContext): Promise<{ nativeSessionId: string | null }> {
    this.ctx = ctx
    const a = codexAccess(this.deps, ctx.profile)
    if (a.mode === "user" && !this.deps.settings().allowPartialIsolation) throw Object.assign(new Error(CODEX_PARTIAL_MESSAGE), { statusCode: 409 })
    this.effort = ctx.profile.effort ?? (process.env.PRINTSTUDIO_CODEX_EFFORT || null)
    const appSkills = join(ctx.cwd, ".claude", "skills")
    const pf = await preflight(this.deps, a, ctx.cwd, appSkills)
    if (!pf.account) throw Object.assign(new Error(CODEX_AUTH_MESSAGE), { statusCode: 409, code: CODEX_AUTH_CODE })
    this.billing = billingOf(pf.account)
    // The project's model is a Codex model only if Codex lists it (a Claude model name from settings isn't).
    const known = (m: string | null | undefined): m is string => !!m && pf.models.some((x) => x.value === m)
    this.model = known(ctx.profile.model) ? ctx.profile.model : null
    if (ctx.profile.model && !this.model)
      this.host.emit(
        { type: "notice", level: "info", text: `Codex doesn't list the model "${ctx.profile.model}"; using Codex's default.` },
        { itemId: `model:${ctx.sessionId}:${Date.now()}` }
      )

    const args = [
      ...a.args,
      ...configOverrides({ cwd: ctx.cwd, codexHome: a.home, denyRead: ctx.policy.denyRead, readRoots: ctx.policy.readRoots, mcpServers: pf.mcpServers, disableSkills: pf.disableSkills }),
    ]
    const { conn } = await openAppServer(
      this.deps,
      { bin: a.bin, args, cwd: ctx.cwd, home: a.home, apiKey: a.apiKey, label: "session" },
      {
        onNotification: (m, p) => this.onNotification(m, p),
        onRequest: (m, p) => this.onRequest(m, p),
        onClose: (e) => this.onClosed(e),
      }
    )
    this.conn = conn
    this._alive = true
    try {
      await conn.request("skills/extraRoots/set", { extraRoots: [appSkills] }, 20_000).catch(() => null)
      const common = {
        cwd: ctx.cwd,
        model: this.model,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        developerInstructions: codexInstructions(ctx.instructions),
      }
      let thread: any = null
      if (ctx.resume) {
        try {
          thread = (await conn.request<any>("thread/resume", { threadId: ctx.resume, ...common, excludeTurns: true }, 60_000)).thread
        } catch (e) {
          this.host.emit(
            { type: "notice", level: "info", text: `Couldn't reopen the earlier Codex conversation (${e instanceof Error ? e.message : String(e)}); starting a fresh one in this session.` },
            { itemId: `resume:${ctx.sessionId}:${Date.now()}` }
          )
        }
      }
      if (!thread) {
        thread = (
          await conn.request<any>(
            "thread/start",
            { ...common, serviceName: "Crease", dynamicTools: dynamicToolSpecs(ctx.tools) },
            60_000
          )
        ).thread
      }
      this.threadId = String(thread.id)
      this.host.emit(
        { type: "notice", level: "info", text: "Session started (Codex)", code: "session.started", data: { cwd: ctx.cwd, model: this.model, runtime: "codex", version: pf.version } },
        { itemId: `start:${this.threadId}:${Date.now()}` }
      )
      return { nativeSessionId: this.threadId }
    } catch (e) {
      this.closing = true
      this._alive = false
      conn.close()
      throw e
    }
  }

  send(input: AgentTurnInput) {
    // Order is kept: behind anything already queued, and not into a turn that is starting or being stopped.
    if (this.queue.length || this.starting || this.interrupting) this.queue.push(input)
    else if (this.turnId) void this.steer(input, this.turnId)
    else void this.startTurn([input])
  }

  /** Codex user input for one message (text first, then its images as data URLs). */
  private codexInput(t: AgentTurnInput): any[] {
    const input: any[] = [{ type: "text", text: t.agentText || "(see attached image)", text_elements: [] }]
    for (const i of t.images) input.push({ type: "image", url: `data:${i.mediaType};base64,${i.data}` })
    return input
  }

  /**
   * Deliver a message into the running turn. The model reads it at its next step (a userMessage item carrying the
   * message id as clientId); until then it stays in `steered`. Refused (the turn is a compact/review, it just ended,
   * or another turn is running): queued for the next turn, started now if nothing runs.
   */
  private async steer(t: AgentTurnInput, turnId: string) {
    if (!this.conn) return
    const id = t.id ?? `steer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const tagged = { ...t, id }
    this.steered.set(id, tagged)
    try {
      await this.conn.request("turn/steer", { threadId: this.threadId, input: this.codexInput(t), expectedTurnId: turnId, clientUserMessageId: id }, 30_000)
    } catch (e) {
      // Only if the turn still owns it (a turn end may already have moved it to the queue).
      if (!this.steered.delete(id)) return
      this.host.native({ type: "app_steer_refused", inputId: id, error: e instanceof Error ? e.message : String(e) })
      this.queue.push(tagged)
      if (!this.turnId && !this.starting && this._alive) this.startNext()
    }
  }

  /** The model has read a steered message (its userMessage item arrived). */
  private steerRead(clientId: unknown) {
    if (typeof clientId !== "string" || !this.steered.delete(clientId)) return
    this.host.received?.(clientId)
  }

  /** Start one turn with everything queued: the messages it carries are answered together, not one stale turn each. */
  private startNext() {
    const next = this.queue.splice(0)
    if (next.length && this._alive) void this.startTurn(next)
  }

  private async startTurn(ts: AgentTurnInput[]) {
    if (!this.conn) return
    this.starting = true
    this.stopOnStart = false
    this.turnAbort = new AbortController()
    this.turnError = null
    this.turnBase = this.totalTokens
    this.turnStartedAt = Date.now()
    const input = ts.flatMap((t) => this.codexInput(t))
    let started = false
    try {
      const effort = this.effort
      const r = await this.conn.request<any>(
        "turn/start",
        { threadId: this.threadId, input, ...(this.model ? { model: this.model } : {}), ...(effort ? { effort } : {}) },
        60_000
      )
      this.turnId ??= r?.turn?.id ?? null
      started = true
      if (this.stopOnStart && this.turnId && this.conn) {
        // Stop pressed while the turn was starting: stop it now (its end comes as turn/completed "interrupted").
        this.stopOnStart = false
        this.interrupting = true
        await this.conn.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }, 20_000).catch(() => {})
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.endRun({ type: "run.failed", error: `Codex couldn't start the turn: ${msg}` }, `fail:${Date.now()}`)
    } finally {
      this.starting = false
    }
    if (!started) return
    for (const t of ts) if (t.id) this.host.received?.(t.id)
    // Sent while it was starting: into this turn.
    if (this.turnId && !this.interrupting && this.queue.length) for (const t of this.queue.splice(0)) void this.steer(t, this.turnId)
  }

  answerQuestion(requestId: string, answers: Record<string, string>, notes?: Record<string, string>) {
    answerPendingQuestion(this.ctx.projectId, requestId, answers, notes)
  }

  answerPermission(requestId: string, decision: { allow: boolean }) {
    answerPendingPermission(this.ctx.projectId, requestId, decision.allow)
  }

  async interrupt() {
    if (!this.conn || !this._alive) return
    // Stop means stop: queued and unread steered messages are dropped (the coordinator closes their runs).
    this.queue.length = 0
    this.steered.clear()
    this.turnAbort.abort() // pending questions/permissions resolve as refused
    if (!this.turnId) {
      if (this.starting) this.stopOnStart = true
      return
    }
    this.interrupting = true
    await this.conn.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }, 20_000)
  }

  async setModel(model: string) {
    this.model = model // applied by the next turn/start ("this turn and subsequent turns")
  }

  close() {
    if (this.closing) return
    this.closing = true
    this.queue.length = 0
    this.steered.clear()
    this.turnAbort.abort()
    this.conn?.close()
  }

  private onClosed(error?: string) {
    const wasAlive = this._alive
    this._alive = false
    this.turnAbort.abort()
    if (!wasAlive && !this.conn) return
    this.host.ended({ error: this.closing ? undefined : error })
  }

  // ---------------------------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------------------------

  private onNotification(method: string, p: any) {
    if (p?.threadId && this.threadId && p.threadId !== this.threadId) return // another thread on this server (none expected)
    this.host.native({ method, params: forLog(p) }, { persist: !LIVE_ONLY.has(method) })
    switch (method) {
      case "turn/started":
        this.turnId = p?.turn?.id ?? this.turnId
        return
      case "turn/completed":
        return this.onTurnCompleted(p?.turn ?? {})
      case "thread/tokenUsage/updated":
        this.totalTokens = p?.tokenUsage?.total ?? this.totalTokens
        this.host.emit({ type: "usage.updated", usage: this.usage(false) }, { persist: false })
        return
      case "error": {
        const err = p?.error ?? {}
        if (p?.willRetry) return
        this.turnError = String(err.message ?? "Codex error")
        const info = err.codexErrorInfo
        if (!this.authReported && (info === "unauthorized" || info === "Unauthorized" || info?.unauthorized !== undefined || /unauthori[sz]ed|sign in|log ?in/i.test(this.turnError))) {
          this.authReported = true
          this.host.emit({ type: "notice", level: "error", code: CODEX_AUTH_CODE, text: CODEX_AUTH_MESSAGE }, { itemId: `auth:${this.threadId}` })
        }
        return
      }
      case "thread/closed":
        if (!this.closing) this.conn?.close()
        return
    }
    if ((method === "item/started" || method === "item/completed") && p?.item?.type === "userMessage") this.steerRead(p.item.clientId)
    for (const e of this.norm.convert(method, p)) {
      this.host.emit(e.event, { itemId: e.itemId, persist: e.persist })
      if (method === "item/started") this.trackNativeTool(p?.item)
    }
  }

  /** Native file edits count as design changes (approval), like Claude's Write/Edit. */
  private trackNativeTool(item: any) {
    if (item?.type !== "fileChange") return
    for (const c of item.changes ?? []) if (c?.path) this.host.nativeToolAllowed("Edit", { file_path: String(c.path) })
  }

  private usage(final: boolean): AgentUsage {
    return { tokens: tokenDiff(this.totalTokens, this.turnBase), billedUsd: null, estimatedApiUsd: null, billing: this.billing, subscription: null, final }
  }

  private onTurnCompleted(turn: any) {
    const status = String(turn.status ?? "completed")
    for (const i of turn.items ?? []) if (i?.type === "userMessage") this.steerRead(i.clientId)
    // Steered but never read (the turn ended first): they go first in the next turn, unless this was a Stop.
    if (this.steered.size) {
      if (status !== "interrupted" && !this.interrupting) this.queue.unshift(...this.steered.values())
      this.steered.clear()
    }
    const lastText = [...(turn.items ?? [])].reverse().find((i: any) => i?.type === "agentMessage")?.text
    const result = {
      subtype: status === "completed" ? "success" : status === "interrupted" || this.interrupting ? "interrupted" : "error",
      isError: status === "failed",
      text: status === "failed" ? (turn.error?.message ?? this.turnError ?? "Codex turn failed") : String(lastText ?? ""),
      durationMs: typeof turn.durationMs === "number" ? turn.durationMs : this.turnStartedAt ? Date.now() - this.turnStartedAt : null,
      turns: null,
      usage: this.usage(true),
      queued: this.queue.length,
    }
    const itemId = `end:${turn.id ?? Date.now()}`
    // Interrupted: what's queued now was sent after Stop and still runs.
    if (status === "interrupted" || this.interrupting) this.endRun({ type: "run.interrupted", result }, itemId)
    else if (status === "failed") this.endRun({ type: "run.failed", error: result.text, result }, itemId)
    else this.endRun({ type: "run.completed", result }, itemId)
  }

  private endRun(event: Parameters<AdapterHost["emit"]>[0], itemId: string) {
    this.turnId = null
    this.interrupting = false
    this.turnAbort.abort() // anything still waiting on the user for this turn is over
    this.host.emit(event, { itemId })
    this.startNext()
  }

  // ---------------------------------------------------------------------------------------------
  // Server -> client requests: app tools, questions, approvals
  // ---------------------------------------------------------------------------------------------

  private async onRequest(method: string, p: any): Promise<unknown> {
    this.host.native({ request: method, params: forLog(p) })
    switch (method) {
      case "item/tool/call":
        return this.toolCall(p)
      case "item/tool/requestUserInput":
        return this.userInput(p)
      case "item/commandExecution/requestApproval":
        // On-request approvals are requests to run outside the sandbox (or past a rule): never (Claude parity:
        // allowUnsandboxedCommands=false). The model gets "declined" and the timeline row says why.
        return { decision: "decline" }
      case "item/fileChange/requestApproval":
        // Patches the sandbox didn't allow: outside the project or onto app-owned paths. Refused by policy.
        return { decision: "decline" }
      case "item/permissions/requestApproval":
        return this.permissions(p)
      case "mcpServer/elicitation/request":
        return { action: "decline", content: null, _meta: null }
      case "execCommandApproval":
      case "applyPatchApproval":
        return { decision: { denied: { rejection: "Crease keeps commands and edits inside the project sandbox." } } }
      default:
        throw new RpcError(`Crease doesn't handle ${method}`, -32601)
    }
  }

  private async toolCall(p: any) {
    const name = String(p?.tool ?? "")
    if (name === ASK_TOOL) {
      const r = await this.host.askUser((p?.arguments ?? {}) as QuestionInput, { signal: this.turnAbort.signal, toolUseID: String(p?.callId ?? "") || undefined })
      return askResultText(r)
    }
    return toDynamicResponse(await this.ctx.tools.call(name, p?.arguments ?? {}))
  }

  /** Codex's own request_user_input: the same question cards; answers keyed by question id. */
  private async userInput(p: any) {
    const qs: any[] = Array.isArray(p?.questions) ? p.questions : []
    const input: QuestionInput = {
      questions: qs.map((q) => ({
        question: String(q.question ?? ""),
        header: String(q.header ?? ""),
        multiSelect: false,
        options: (q.options ?? []).map((o: any) => ({ label: String(o.label ?? ""), description: String(o.description ?? "") })),
      })),
    }
    const r = await this.host.askUser(input, { signal: this.turnAbort.signal, toolUseID: String(p?.itemId ?? "") || undefined })
    const answers: Record<string, { answers: string[] }> = {}
    if (r.answered) for (const q of qs) if (r.answers[String(q.question)]) answers[String(q.id)] = { answers: [r.answers[String(q.question)]] }
    return { answers }
  }

  /**
   * Extra sandbox permissions: network is never granted (printers only through app tools); writes only where the
   * project policy allows (which the sandbox already allows, so effectively none); reading files outside the project
   * (a photo in Downloads) is the one thing the user decides, file by file, never the app's secret files.
   */
  private async permissions(p: any) {
    const none = { permissions: {}, scope: "turn" }
    const fsReq = p?.permissions?.fileSystem ?? {}
    const root = this.ctx.cwd
    const reads: string[] = [
      ...(fsReq.read ?? []),
      ...(fsReq.entries ?? []).filter((e: any) => e?.access === "read" && e?.path?.type === "path").map((e: any) => e.path.path),
    ].map(String)
    const deny = new Set((this.ctx.policy.denyRead ?? []).map((d) => resolve(d)))
    const askable = reads.filter((r) => {
      const abs = resolve(root, r)
      return !deny.has(abs) && !/(^|\/)auth\.json$/.test(abs) && ![...deny].some((d) => isInside(abs, d))
    })
    if (!askable.length) return none
    const shown = askable.map((a) => (isInside(root, resolve(root, a)) ? relative(root, resolve(root, a)) : a))
    const out = await this.host.askPermission(
      {
        title: "Let the designer read files outside this project?",
        detail: `${p?.reason ? `${String(p.reason)}\n\n` : ""}It wants to read:\n${shown.map((s) => `• ${s}`).join("\n")}\n\nIt can't change them, and it still has no internet access.`,
        tool: "permissions",
      },
      { signal: this.turnAbort.signal }
    )
    if (!out.allow) return none
    // Writes stay inside the project and off app-owned paths (the sandbox already grants exactly that).
    const writes = ((fsReq.write ?? []) as string[]).filter((w) => protectedReason(root, w) === null)
    return { permissions: { fileSystem: { read: askable, write: writes.length ? writes : null } }, scope: "turn" }
  }
}

// -------------------------------------------------------------------------------------------------
// Runtime
// -------------------------------------------------------------------------------------------------

function execVersion(bin: string): Promise<string | null> {
  return new Promise((res) => {
    execFile(bin, ["--version"], { timeout: 10_000 }, (err, out) => res(err ? null : (/(\d+\.\d+\.\d+[\w.-]*)/.exec(String(out))?.[1] ?? null)))
  })
}

const CODEX_EFFORTS: AgentEffort[] = ["low", "medium", "high", "xhigh", "max"]
/** Sign-in button for the app's own Codex home (SetupFixButton -> POST /api/agent/runtimes/codex/login). */
export const CODEX_SIGN_IN_FIX = { kind: "codex-login" as const, label: "Sign in to Codex" }

async function checkOpenAiKey(key: string): Promise<AgentConnectionStep> {
  try {
    const r = await fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) })
    if (r.ok) return { label: "API key accepted", ok: true, detail: "OpenAI accepted the key (no charge for this check)." }
    if (r.status === 401 || r.status === 403) return { label: "API key accepted", ok: false, detail: "OpenAI rejected this key. Paste a new one from platform.openai.com." }
    return { label: "API key accepted", ok: null, detail: `OpenAI answered ${r.status}; try again in a minute.` }
  } catch (e) {
    return { label: "API key accepted", ok: null, detail: `Couldn't reach OpenAI (${(e as Error).name === "TimeoutError" ? "timed out" : "no connection"}). Check your internet.` }
  }
}

export class CodexRuntime implements AgentRuntime {
  readonly kind = "codex"
  readonly ownSessionIds = true
  private cache: { at: number; key: string; probe: AgentRuntimeProbe } | null = null

  constructor(private deps: CodexDeps = defaultCodexDeps) {}

  /** Capabilities for the current Codex sign-in setting (subscription). API-key profiles are always "full". */
  get capabilities(): AgentRuntimeCapabilities {
    return codexCapabilities(codexLogin(this.deps.settings()))
  }

  create(host: AdapterHost): AgentAdapter {
    return new CodexAdapter(host, this.deps)
  }

  /** Models Codex lists (from the last probe). */
  knownModels(): string[] {
    return this.cache?.probe.models.map((m) => m.value) ?? []
  }

  async probe(): Promise<AgentRuntimeProbe> {
    const settings = this.deps.settings()
    const key = JSON.stringify(settings)
    if (this.cache && this.cache.key === key && Date.now() - this.cache.at < 30_000) return this.cache.probe
    const login = codexLogin(settings)
    const capabilities = codexCapabilities(login)
    const base = { runtime: "codex", capabilities, effortLevels: CODEX_EFFORTS }
    let a: CodexAccess
    try {
      a = codexAccess(this.deps, null)
    } catch {
      return { ...base, installed: false, version: null, auth: { method: "login", status: "unknown" }, models: [], ready: false, detail: CODEX_NOT_INSTALLED }
    }
    let probe: AgentRuntimeProbe
    try {
      const pf = await preflight(this.deps, a, a.home, null)
      const signedIn = !!pf.account
      const partialBlocked = login === "user" && !settings.allowPartialIsolation
      const plan = pf.account?.type === "chatgpt" ? `ChatGPT ${pf.account.planType ?? ""}`.trim() : null
      probe = {
        ...base,
        installed: true,
        version: pf.version ?? (await execVersion(a.bin)),
        auth: { method: pf.account?.type === "apiKey" ? "api-key" : "login", status: signedIn ? "ok" : "missing" },
        login: { plan, fix: signedIn || login === "user" ? null : CODEX_SIGN_IN_FIX },
        models: pf.models.map(({ value, label }) => ({ value, label })),
        defaultModel: pf.models.find((m) => m.isDefault)?.value ?? null,
        ready: signedIn && !partialBlocked,
        detail: !signedIn
          ? login === "app"
            ? "Sign in to Codex for Crease with your ChatGPT account."
            : "Codex isn't signed in on this Mac (run `codex login`)."
          : partialBlocked
            ? CODEX_PARTIAL_MESSAGE
            : `Signed in with ${plan ?? "Codex"}${login === "user" ? " (your own Codex login: partial isolation)" : ""}.`,
      }
    } catch (e) {
      probe = {
        ...base,
        installed: true,
        version: await execVersion(a.bin),
        auth: { method: "login", status: "unknown" },
        models: [],
        ready: false,
        detail: `Codex didn't respond: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
    this.cache = { at: Date.now(), key, probe }
    return probe
  }

  /** "Test connection": program, sign-in or key, isolation. No model call. */
  async checkConnection(profile: AgentProfileSnapshot): Promise<AgentConnectionResult> {
    const steps: AgentConnectionStep[] = []
    let a: CodexAccess
    try {
      a = codexAccess(this.deps, profile)
    } catch (e) {
      const msg = (e as Error).message
      const missing = msg === CODEX_NOT_INSTALLED
      steps.push({ label: missing ? "Codex installed" : "API key saved", ok: false, detail: msg })
      return { ok: false, steps, summary: msg, fix: missing ? { kind: "open-url", label: "Get Codex", url: "https://developers.openai.com/codex" } : null }
    }
    const version = await execVersion(a.bin)
    steps.push({ label: "Codex installed", ok: version !== null, detail: version ? `Codex ${version}` : `Couldn't run ${a.bin}` })
    if (!version) return { ok: false, steps, summary: "The Codex program didn't start. Reinstall it, then test again.", fix: { kind: "open-url", label: "Get Codex", url: "https://developers.openai.com/codex" } }
    if (a.mode === "api-key") {
      steps.push({ label: "API key saved", ok: true })
      const check = await checkOpenAiKey(a.apiKey!)
      steps.push(check)
      steps.push({ label: "Safety sandbox", ok: true, detail: "Full: project folder only, no network, printers only through Crease." })
      return {
        ok: check.ok === true,
        steps,
        summary: check.ok ? "Ready. Messages are billed to your OpenAI API key." : check.ok === false ? "Replace the key, then test again." : "Couldn't check the key right now. Try again in a minute.",
      }
    }
    let account: Preflight["account"]
    try {
      account = (await preflight(this.deps, a, a.home, null)).account
    } catch (e) {
      steps.push({ label: "Signed in", ok: null, detail: `Codex didn't answer: ${(e as Error).message}` })
      return { ok: false, steps, summary: "Couldn't check the Codex sign-in. Try again." }
    }
    steps.push({
      label: "Signed in",
      ok: !!account,
      detail: account ? `Signed in${account.type === "chatgpt" ? ` with ChatGPT${account.planType ? ` (${account.planType})` : ""}` : ""}${a.mode === "user" ? " (your own Codex login)" : ""}.` : "Not signed in.",
    })
    const partialOk = a.mode !== "user" || !!this.deps.settings().allowPartialIsolation
    steps.push({
      label: "Safety sandbox",
      ok: a.mode === "user" ? (partialOk ? null : false) : true,
      detail: a.mode === "user" ? userHomeIsolationReason() : "Full: project folder only, no network, printers only through Crease.",
    })
    if (!account)
      return {
        ok: false,
        steps,
        summary: a.mode === "app" ? "Press “Sign in to Codex”: your browser asks you to sign in with ChatGPT. Then test again." : "Run `codex login` in Terminal, then test again.",
        fix: a.mode === "app" ? CODEX_SIGN_IN_FIX : null,
      }
    if (!partialOk) return { ok: false, steps, summary: CODEX_PARTIAL_MESSAGE, fix: CODEX_SIGN_IN_FIX }
    return { ok: true, steps, summary: "Ready. Uses your ChatGPT plan: no per-message charge from Crease." }
  }

  /** "Send a test message": one tiny turn, no app tools, in a scratch folder, nothing kept (ephemeral thread). */
  async testMessage(profile: AgentProfileSnapshot): Promise<AgentConnectionResult> {
    const steps: AgentConnectionStep[] = []
    let a: CodexAccess
    try {
      a = codexAccess(this.deps, profile)
    } catch (e) {
      return { ok: false, steps, summary: (e as Error).message }
    }
    const cwd = mkdtempSync(join(tmpdir(), "ps-codex-test-"))
    let reply = ""
    let error: string | null = null
    let done!: () => void
    const finished = new Promise<void>((r) => (done = r))
    let conn: RpcConnection | null = null
    try {
      conn = (
        await openAppServer(
          this.deps,
          { bin: a.bin, args: [...a.args, ...configOverrides({ cwd, codexHome: a.home })], cwd, home: a.home, apiKey: a.apiKey, label: "test" },
          {
            onNotification: (m, p) => {
              if (m === "item/completed" && p?.item?.type === "agentMessage") reply = String(p.item.text ?? "")
              if (m === "turn/completed") {
                if (p?.turn?.status === "failed") error = p.turn.error?.message ?? "The turn failed."
                done()
              }
            },
            onRequest: async (m) => (m.endsWith("requestApproval") ? { decision: "decline" } : Promise.reject(new RpcError("not in a test", -32601))),
            onClose: (e) => {
              error ??= e ?? null
              done()
            },
          }
        )
      ).conn
      const t = await conn.request<any>("thread/start", { cwd, model: profile.model, approvalPolicy: "on-request", approvalsReviewer: "user", ephemeral: true }, 60_000)
      await conn.request("turn/start", { threadId: t.thread.id, input: [{ type: "text", text: "This is a connection test from Crease. Reply with exactly: Ready to design.", text_elements: [] }], ...(profile.effort ? { effort: profile.effort } : {}) }, 60_000)
      await Promise.race([finished, new Promise<void>((r) => setTimeout(() => ((error ??= "No answer within 90 seconds."), r()), 90_000).unref())])
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      conn?.close()
      setTimeout(() => rmSync(cwd, { recursive: true, force: true }), 2000).unref()
    }
    if (error || !reply) {
      steps.push({ label: "Test message", ok: false, detail: error ?? "No reply." })
      return { ok: false, steps, summary: error ?? "Codex didn't reply.", fix: a.mode === "app" ? CODEX_SIGN_IN_FIX : null, costUsd: null }
    }
    steps.push({ label: "Test message", ok: true, detail: `Replied: “${reply.trim().slice(0, 200)}”` })
    return {
      ok: true,
      steps,
      reply: reply.trim().slice(0, 500),
      costUsd: null,
      summary: a.mode === "api-key" ? "It answered. Codex doesn't report the cost; it's billed to your OpenAI API key." : "It answered. On your ChatGPT plan this used a little of your Codex allowance.",
    }
  }

  /** Kill every app-server this runtime started (server exit). The process groups are tracked by spawn.ts. */
  shutdown() {
    killAllAgentProcesses("SIGTERM")
  }

  /** Forget the cached probe (after sign-in or a settings change). */
  invalidate() {
    this.cache = null
  }

  async fork(nativeSessionId: string, o: { cwd: string; title?: string }): Promise<{ nativeSessionId: string }> {
    // Threads live in the Codex home that holds them; a fork is a local copy (no model call), so the default access works.
    const a = codexAccess(this.deps, null)
    const { conn } = await openAppServer(this.deps, { bin: a.bin, args: [...a.args, ...configOverrides({ cwd: o.cwd, codexHome: a.home })], cwd: o.cwd, home: a.home, label: "fork" })
    try {
      const r = await conn.request<any>("thread/fork", { threadId: nativeSessionId, excludeTurns: true }, 60_000)
      const id = String(r.thread.id)
      if (o.title) await conn.request("thread/name/set", { threadId: id, name: o.title }, 20_000).catch(() => null)
      return { nativeSessionId: id }
    } finally {
      conn.close()
    }
  }

  /**
   * Sign in to the app's own Codex home with the documented ChatGPT browser flow (account/login/start). Returns the
   * URL to open; the app-server stays up until the login completes (or 10 minutes pass).
   */
  async login(): Promise<{ authUrl: string; loginId: string }> {
    const bin = this.deps.findBinary()
    if (!bin) throw Object.assign(new Error(CODEX_NOT_INSTALLED), { statusCode: 409 })
    const home = this.deps.home("app")
    this.cancelLogin("Started again.")
    let conn: RpcConnection | null = null
    const status: RuntimeLoginStatus = { state: "waiting", authUrl: null, code: null, error: null }
    const opened = await openAppServer(
      this.deps,
      { bin, args: [], cwd: home, home, label: "login" },
      {
        onNotification: (m, p) => {
          if (m === "account/login/completed" || m === "account/updated") {
            this.invalidate()
            if (m === "account/login/completed") {
              if (status.state === "waiting") {
                const ok = p?.success !== false
                status.state = ok ? "done" : "failed"
                if (!ok) status.error = typeof p?.error === "string" && p.error ? p.error : "The sign-in didn't finish. Start again."
              }
              setTimeout(() => conn?.close(), 500).unref()
            }
          }
        },
      }
    )
    conn = opened.conn
    const expire = () => {
      if (status.state === "waiting") Object.assign(status, { state: "failed", error: "The sign-in timed out. Start again." })
      conn?.close()
    }
    setTimeout(expire, 10 * 60_000).unref()
    this.loginRun = {
      status,
      cancel: (why) => {
        if (status.state === "waiting") Object.assign(status, { state: "failed", error: why })
        conn?.close()
      },
    }
    try {
      const r = await conn.request<any>("account/login/start", { type: "chatgpt" }, 30_000)
      status.authUrl = String(r.authUrl)
      return { authUrl: String(r.authUrl), loginId: String(r.loginId) }
    } catch (e) {
      Object.assign(status, { state: "failed", error: e instanceof Error ? e.message : String(e) })
      conn.close()
      throw e
    }
  }

  private loginRun: { status: RuntimeLoginStatus; cancel(why: string): void } | null = null

  loginStatus(): RuntimeLoginStatus {
    return this.loginRun ? { ...this.loginRun.status } : { state: "idle", authUrl: null, code: null, error: null }
  }

  cancelLogin(why = "Sign-in cancelled.") {
    this.loginRun?.cancel(why)
  }
}

export const codexRuntime = new CodexRuntime()
