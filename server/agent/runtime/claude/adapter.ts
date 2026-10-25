// Claude runtime: a full Claude Code session through the Agent SDK (query() in streaming-input mode, fed by a queue
// of user turns). Everything Claude-specific lives here: SDK options (claude_code preset, OS sandbox, PreToolUse
// policy hook, canUseTool, project-only settings, disallowed tools), the CLI process, model switch, resume/fork,
// cost accounting and plan usage. It reports to the coordinator through AdapterHost as normalized events.
import { existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import {
  forkSession as sdkForkSession,
  query,
  type CanUseTool,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import {
  AGENT_MODELS,
  type AgentConnectionResult,
  type AgentConnectionStep,
  type AgentEffort,
  type AgentProfileSnapshot,
  type AgentRuntimeCapabilities,
  type AgentRuntimeProbe,
} from "../../../../shared/types"
import { redactSecrets, secretStatus } from "../../../secrets"
import { CLAUDE_CODE_INSTALL_URL, claudeAuthStatus, claudeVersion, compareVersions } from "../../../tools/discovery"
import { claudeTool, devClaudeLoginEnabled } from "../../../tools/index"
import { billingOf, profileApiKey } from "../../profiles"
import { CLAUDE_AUTH_CODE, CLAUDE_AUTH_MESSAGE, isClaudeAuthFailure } from "../../auth-error"
import { calibrate, TurnEstimator } from "../../cost"
import { DESIGN_DISALLOWED_TOOLS, makeCanUseTool, policyHooks } from "../../policy"
import { answerQuestion as answerPendingQuestion } from "../../questions"
import { SANDBOX_UNAVAILABLE_MESSAGE, sandboxSettings } from "../../sandbox"
import { killAllAgentProcesses, spawnAgentProcess } from "../../spawn"
import { onRateLimitEvent } from "../../usage"
import type { AdapterHost, AgentAdapter, AgentRuntime, AgentSessionContext, AgentTurnInput } from "../types"
import { createStudioMcpServer, MCP_SERVER_NAME } from "./mcp"
import { ClaudeNormalizer } from "./normalize"

// Auto-approved without a canUseTool round trip. Write/Edit/Bash are deliberately absent so canUseTool runs too;
// the PreToolUse hook (policy.ts) checks every call either way, and Bash always runs in the OS sandbox (sandbox.ts).
const AUTO_ALLOWED = ["Read", "Glob", "Grep", "TodoWrite", "Task", "Agent", "WebSearch", "WebFetch", "Skill"]

/** High-frequency progress frames: live only, never kept. */
const LIVE_ONLY = (m: SDKMessage) => m.type === "stream_event" || (m.type === "system" && m.subtype === "thinking_tokens")

export const CLAUDE_CAPABILITIES: AgentRuntimeCapabilities = {
  images: true,
  streaming: true,
  appTools: true,
  userQuestions: true,
  // canUseTool is answered by the app's policy (nobody is at a terminal); the user is never asked to allow a tool.
  permissionRequests: false,
  resume: true,
  fork: true,
  modelSwitch: true,
  usage: "reported",
  isolation: { workspaceWrites: true, network: true },
}

/** Minimal async queue used as the streaming-input prompt. */
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | null = null
  private closed = false
  push(m: SDKUserMessage) {
    if (this.closed) return
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w({ value: m, done: false })
    } else this.items.push(m)
  }
  close() {
    this.closed = true
    if (this.waiter) this.waiter({ value: undefined, done: true })
    this.waiter = null
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const m = this.items.shift()
        if (m) return Promise.resolve({ value: m, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((r) => (this.waiter = r))
      },
    }
  }
}

export class ClaudeAdapter implements AgentAdapter {
  private q: Query | null = null
  private input = new MessageQueue()
  private abort = new AbortController()
  private norm = new ClaudeNormalizer()
  private sessionId = ""
  private projectId = ""
  private interrupting = false
  /** Messages sent (input ids) that no model request has carried yet. */
  private unread: string[] = []
  private nativeSeq = 0
  /** Set from stderr when the CLI refused to start because the OS sandbox is unavailable. */
  private sandboxFailed = false
  /** The sign-in error was shown (once per process). */
  private authReported = false
  private _alive = false
  // Cost accounting. total_cost_usd is cumulative per CLI process, and on resume the CLI usually carries over the
  // saved total (it did in testing), but not always (e.g. no saved total). We keep our own cumulative figure:
  // costBase = the transcript total when this process started; costOffset is decided at the first result
  // (0 if the CLI carried the total over, costBase if it restarted from zero). Mid-turn, turnEst adds a token-
  // based estimate on top of the last authoritative value.
  private costBase = 0
  private costOffset: number | null = null
  private lastProcTotal = 0
  private costUsd = 0
  private turnEst = new TurnEstimator()
  /** API key or plan login, fixed for this process by its profile (the key goes into its env at start). */
  private billing: "api" | "plan" = "plan"

  constructor(private host: AdapterHost) {}

  get alive() {
    return this._alive
  }

  async start(ctx: AgentSessionContext): Promise<{ nativeSessionId: string | null }> {
    this.projectId = ctx.projectId
    this.sessionId = ctx.sessionId
    this.costBase = this.costUsd = ctx.priorCostUsd
    // R11b: sign-in, model, effort and program come from the frozen profile, not from Settings.
    const profile = ctx.profile
    this.billing = billingOf(profile)
    const env = claudeEnv(profile)
    // Always an explicit program: public builds have no SDK-bundled binary, so this is the user's Claude Code.
    const program = requireClaudeProgram(profile)
    const debugStderr = (d: string) => {
      if (/refusing to start without a working sandbox|failIfUnavailable/i.test(d)) this.sandboxFailed = true
      if (process.env.PRINTSTUDIO_AGENT_DEBUG || this.sandboxFailed) process.stderr.write(`[agent:stderr] ${redactSecrets(d)}`)
    }
    const dir = ctx.cwd
    const canUse: CanUseTool = makeCanUseTool(dir, { askUser: (input, o) => this.askUser(input, o) }, ctx.policy)
    this.q = query({
      prompt: this.input,
      options: {
        cwd: dir,
        abortController: this.abort,
        // Own process group + parent-death watchdog, so the CLI never outlives the app (see spawn.ts).
        spawnClaudeCodeProcess: (o) => spawnAgentProcess(o, debugStderr),
        ...(ctx.resume ? { resume: ctx.resume } : { sessionId: ctx.sessionId }),
        includePartialMessages: true,
        systemPrompt: { type: "preset", preset: "claude_code", append: ctx.instructions },
        // A full Claude Code session: default toolset (Bash, Task, TodoWrite, Web*, ...), the project's
        // settings / CLAUDE.md / skills (installed by the app into <project>/.claude) plus our in-process server.
        tools: { type: "preset", preset: "claude_code" },
        allowedTools: [...AUTO_ALLOWED, ...ctx.tools.list().map((t) => `mcp__${MCP_SERVER_NAME}__${t.name}`)],
        // Tools a design session never needs (cron, remote triggers, worktrees, workflows, notifications, messaging):
        // out of the model's tool list, and denied by the policy too.
        disallowedTools: [...DESIGN_DISALLOWED_TOOLS],
        // AskUserQuestion is answered through the UI (questions.ts); it must stay out of allowedTools.
        // Allowed native tools are reported so the app can track design changes (approval).
        canUseTool: async (toolName, input, opts) => {
          const r = await canUse(toolName, input, opts)
          if (r?.behavior === "allow") this.host.nativeToolAllowed(toolName, input)
          return r
        },
        // R01: the same policy as a PreToolUse hook, so it runs for every tool call (subagents included) even when an
        // allow rule would skip canUseTool. Bash runs in the OS sandbox: project-folder writes only, app-owned paths
        // read-only, no network (printers only via request_print). failIfUnavailable: no sandbox, no session.
        hooks: policyHooks(dir, ctx.policy),
        sandbox: sandboxSettings(dir, { printerHosts: ctx.policy.printerHosts, denyRead: ctx.policy.denyRead, readRoots: ctx.policy.readRoots }),
        toolConfig: { askUserQuestion: { previewFormat: "html" } },
        // Explicit so a user-level defaultMode (e.g. bypassPermissions/auto) can't skip canUseTool.
        permissionMode: "default",
        // Project only: CLAUDE.md + the app-installed skills. No "user" (~/.claude allow rules, hooks, plugins, default
        // mode) and no "local" (.claude/settings.local.json), so nothing outside the app widens the session.
        settingSources: ["project"],
        // The app's tools (registry/): identity is the app's binding; gates and bookkeeping run there.
        mcpServers: { [MCP_SERVER_NAME]: createStudioMcpServer(ctx.tools) },
        // claude.ai connectors (Drive, Notion, Docs…) add noise to design sessions; local MCP servers stay.
        // Questions wait for the user indefinitely (no auto-continue).
        settings: { disableClaudeAiConnectors: true, askUserQuestionTimeout: "never" },
        model: ctx.profile.model ?? undefined,
        ...(profile.effort ? { effort: profile.effort } : {}),
        pathToClaudeCodeExecutable: program,
        maxTurns: ctx.maxTurns,
        env,
        stderr: debugStderr,
      },
    })
    this._alive = true
    void this.pump()
    return { nativeSessionId: ctx.sessionId }
  }

  /** AskUserQuestion via canUseTool: the app asks; the answer goes back as the tool's updated input. */
  private async askUser(input: Record<string, unknown>, o: { signal: AbortSignal; toolUseID?: string }): Promise<PermissionResult> {
    const r = await this.host.askUser(input, o)
    if (!r.answered) return { behavior: "deny", message: r.message }
    return {
      behavior: "allow",
      updatedInput: { ...input, answers: r.answers, ...(r.annotations && Object.keys(r.annotations).length ? { annotations: r.annotations } : {}) },
    }
  }

  send(t: AgentTurnInput) {
    if (t.id) this.unread.push(t.id)
    this.norm.userInput(t.text)
    this.input.push({
      type: "user",
      message: {
        role: "user",
        content: t.images.length
          ? [
              ...t.images.map((i) => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.mediaType, data: i.data } })),
              { type: "text" as const, text: t.agentText || "(see attached image)" },
            ]
          : t.agentText,
      },
      parent_tool_use_id: null,
    })
  }

  answerQuestion(requestId: string, answers: Record<string, string>, notes?: Record<string, string>) {
    // Questions arrive through canUseTool -> host.askUser; the app's broker resolves that promise.
    answerPendingQuestion(this.projectId, requestId, answers, notes)
  }

  answerPermission(): void {
    throw Object.assign(new Error("Claude sessions don't ask for tool permissions (the app's policy decides)."), { statusCode: 400 })
  }

  async interrupt() {
    if (!this.q || !this._alive) return
    this.interrupting = true
    await this.q.interrupt()
  }

  async setModel(model: string) {
    if (this.q && this._alive) await this.q.setModel(model)
  }

  close() {
    this.input.close() // stdin EOF: the CLI's graceful exit path
    try {
      this.q?.close()
    } catch {
      /* already closed */
    }
    this.abort.abort() // SDK cleanup; the forwarded signal kills the child after its grace window
  }

  private async pump() {
    let error: string | undefined
    try {
      for await (const m of this.q as AsyncIterable<SDKMessage>) {
        if (m.session_id && m.session_id !== this.sessionId) {
          // Shouldn't happen (we pin sessionId / resume), but keep the app's record truthful if it does.
          this.sessionId = m.session_id
          this.host.nativeSessionChanged(m.session_id)
        }
        if (m.type === "result") this.applyResultCost(m)
        // Claude Code takes queued messages into the next model request (a new turn, or folded in between tool rounds).
        if (m.type === "system" && ((m.subtype === "status" && (m as { status?: unknown }).status === "requesting") || m.subtype === "init")) this.markRead()
        const live = LIVE_ONLY(m)
        this.host.native(m, { persist: !live })
        const base = `c${this.nativeSeq++}-${Date.now().toString(36)}`
        const interrupted = m.type === "result" && this.interrupting
        if (m.type === "result") this.interrupting = false
        for (const e of this.norm.convert(m, base, { billing: this.billing, interrupted }))
          this.host.emit(e.event, { itemId: e.itemId, persist: e.persist })
        if (this.turnEst.observe(m) && m.type !== "result") {
          // live estimate: last authoritative cumulative + this turn's token-based estimate (never goes down)
          const est = (this.costOffset ?? this.costBase) + this.lastProcTotal + this.turnEst.usd
          if (est > this.costUsd + 1e-6) {
            this.costUsd = est
            this.host.emit(
              {
                type: "usage.updated",
                usage: { tokens: null, billedUsd: null, estimatedApiUsd: est, billing: this.billing, subscription: null, final: false },
              },
              { persist: false }
            )
          }
        }
        if (m.type === "rate_limit_event") onRateLimitEvent(m.rate_limit_info)
        if (!this.authReported && isClaudeAuthFailure(m)) this.reportAuthFailure()
      }
    } catch (e) {
      if (isClaudeAuthFailure(e)) this.reportAuthFailure()
      else if (!stoppedQuietly(e, this.interrupting)) error = this.sandboxFailed ? SANDBOX_UNAVAILABLE_MESSAGE : e instanceof Error ? e.message : String(e)
      this.sandboxFailed = false // reported
    } finally {
      // The CLI can also end the stream without throwing (an error result) when the sandbox won't start.
      if (this.sandboxFailed) error = SANDBOX_UNAVAILABLE_MESSAGE
      this._alive = false
      this.input.close()
      this.host.ended({ error })
    }
  }

  private markRead() {
    for (const id of this.unread.splice(0)) this.host.received?.(id)
  }

  /** Missing/expired Claude login: one plain-language error with a sign-in button (see auth-error.ts). */
  private reportAuthFailure() {
    if (this.authReported) return
    this.authReported = true
    this.host.native({ type: "app_error", code: CLAUDE_AUTH_CODE, error: CLAUDE_AUTH_MESSAGE })
    this.host.emit({ type: "notice", level: "error", code: CLAUDE_AUTH_CODE, text: CLAUDE_AUTH_MESSAGE }, { itemId: `auth:${this.sessionId}:${this.nativeSeq}` })
  }

  /**
   * Reconcile to the authoritative total at the end of a turn and stamp the cumulative figure on the result
   * (as studio_cost_usd) before it's persisted, so replay, catalog and UI all agree.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private applyResultCost(m: any) {
    calibrate(m.modelUsage)
    const T = typeof m.total_cost_usd === "number" && isFinite(m.total_cost_usd) ? m.total_cost_usd : null
    if (T != null && T > 0) {
      if (this.costOffset == null) {
        // First result of this process: did the CLI carry the saved total over (T ≈ base + spend) or start at 0 (T ≈ spend)?
        const spend = this.turnEst.usd
        this.costOffset = Math.abs(T - (this.costBase + spend)) <= Math.abs(T - spend) ? 0 : this.costBase
      }
      this.lastProcTotal = Math.max(this.lastProcTotal, T)
    }
    this.turnEst.reset()
    const authoritative = (this.costOffset ?? this.costBase) + this.lastProcTotal
    // Reconcile (the live estimate may have over- or under-shot), but never below the previous cumulative.
    this.costUsd = Math.max(authoritative, this.costBase)
    m.studio_cost_usd = this.costUsd
  }
}

/**
 * The SDK can throw "Claude Code returned an error result: … stop_reason=tool_use" when Stop lands while a tool (an
 * open question card) is pending, instead of yielding the interrupted result. That is the Stop the user asked for, not
 * an error to show: the session ends quietly and the coordinator closes the run as interrupted (parity run 2026-10-11).
 */
export function stoppedQuietly(e: unknown, interrupting: boolean): boolean {
  return interrupting && /returned an error result/i.test(e instanceof Error ? e.message : String(e))
}

function sdkPackage(): { version?: string; claudeCodeVersion?: string } | null {
  try {
    const req = createRequire(import.meta.url)
    let dir = dirname(req.resolve("@anthropic-ai/claude-agent-sdk"))
    for (let i = 0; i < 4 && !existsSync(join(dir, "package.json")); i++) dir = dirname(dir)
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
  } catch {
    return null
  }
}
const sdkVersion = () => sdkPackage()?.version ?? null
/** The Claude Code version this Agent SDK was released with (older user installs may lack options we pass). */
export const sdkClaudeCodeVersion = () => sdkPackage()?.claudeCodeVersion ?? null

const CLAUDE_EFFORTS: AgentEffort[] = ["low", "medium", "high", "xhigh", "max"]
/** Dev only (PRINTSTUDIO_DEV_CLAUDE_LOGIN=1): the app's own sign-in. Public builds: null (INVENTORY B1). */
const devSignInFix = () => (devClaudeLoginEnabled() ? { kind: "claude-login" as const, label: "Sign in to Claude" } : null)
const INSTALL_FIX = { kind: "open-url" as const, label: "Install Claude Code", url: CLAUDE_CODE_INSTALL_URL }
/** Not signed in to Claude Code: the primary way forward is an API key (the user can also sign in to Claude Code). */
const keyFix = (profileId: string | null) => devSignInFix() ?? { kind: "anthropic-key" as const, label: "Add an API key", profileId: profileId ?? "claude" }
export const CLAUDE_CODE_MISSING_MESSAGE =
  "Claude Code isn't installed. Crease's designer runs on it (free to install from Anthropic): install it, then try again. Already installed somewhere unusual? Set its location in Settings."

/** The program a profile runs: its Advanced path, else Settings / the SDK's own (dev) / the user's Claude Code. */
export function claudeProgram(profile?: { binaryPath?: string | null }): string | null {
  return profile?.binaryPath || claudeTool()?.path || null
}

function requireClaudeProgram(profile: AgentProfileSnapshot): string {
  const bin = claudeProgram(profile)
  if (!bin) throw Object.assign(new Error(CLAUDE_CODE_MISSING_MESSAGE), { statusCode: 400 })
  return bin
}

/**
 * The CLI's environment for a profile. An API-key profile passes its key (only to this process); a subscription
 * profile removes any inherited ANTHROPIC_API_KEY so it really uses the login it says it does. Throws (400) when an
 * API-key profile has no usable key.
 */
export function claudeEnv(profile: AgentProfileSnapshot): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "printstudio/0.0.1" }
  delete env.ANTHROPIC_API_KEY
  if (profile.auth.kind === "api-key") {
    const key = profileApiKey(profile)
    if (!key)
      throw Object.assign(new Error(`“${profile.name}” is set to use an API key, but no key is saved (or this window can't unlock it). Add the key in Designers.`), {
        statusCode: 400,
      })
    env.ANTHROPIC_API_KEY = key
  }
  return env
}

export interface ClaudeProgramInfo {
  path: string | null
  /** "bundled" = the Agent SDK's own binary (dev / run from source); otherwise the user's Claude Code. */
  source: "profile" | "settings" | "env" | "bundled" | "found" | null
  version: string | null
  /** Older than the Claude Code version this SDK was released with (may lack options Crease passes). */
  outdated: { wanted: string } | null
}

/** Which `claude` runs, its version, and whether it's older than this SDK expects. */
export async function claudeProgramInfo(profile?: { binaryPath?: string | null }): Promise<ClaudeProgramInfo> {
  const found = profile?.binaryPath ? { path: profile.binaryPath, source: "profile" as const } : claudeTool()
  if (!found || !existsSync(found.path)) return { path: found?.path ?? null, source: found?.source ?? null, version: null, outdated: null }
  const version = found.source === "bundled" ? (sdkClaudeCodeVersion() ?? (await claudeVersion(found.path))) : await claudeVersion(found.path)
  const wanted = sdkClaudeCodeVersion()
  return { ...found, version, outdated: version && wanted && compareVersions(version, wanted) < 0 ? { wanted } : null }
}

export function describeClaudeProgram(info: ClaudeProgramInfo): string {
  const v = info.version ? `Claude Code ${info.version}` : "Claude Code"
  return info.source === "bundled"
    ? `${v} (the agent kit's own copy: development build)`
    : info.source === "settings" || info.source === "profile"
      ? `${v}, set in ${info.source === "profile" ? "this designer's options" : "Settings"}`
      : `${v}, installed on this Mac`
}

async function programStep(profile?: AgentProfileSnapshot): Promise<AgentConnectionStep> {
  if (profile?.binaryPath && !existsSync(profile.binaryPath))
    return { label: "Claude Code", ok: false, detail: `Not found at ${profile.binaryPath} (More options). Clear it to find Claude Code automatically.` }
  const info = await claudeProgramInfo(profile)
  if (!info.path || !sdkVersion()) return { label: "Claude Code", ok: false, detail: "Not installed. Crease's designer runs on Claude Code (free to install)." }
  if (info.outdated)
    return {
      label: "Claude Code",
      ok: null,
      detail: `${describeClaudeProgram(info)}: older than ${info.outdated.wanted}, which this version of Crease was tested with. Update it: in Terminal, run “claude update”.`,
    }
  return { label: "Claude Code", ok: true, detail: describeClaudeProgram(info) }
}

/** Check an Anthropic key without spending anything: listing models is free. */
async function checkAnthropicKey(key: string): Promise<AgentConnectionStep> {
  try {
    const r = await fetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(8000),
    })
    if (r.ok) return { label: "API key accepted", ok: true, detail: "Anthropic accepted the key (no charge for this check)." }
    if (r.status === 401 || r.status === 403) return { label: "API key accepted", ok: false, detail: "Anthropic rejected this key. Paste a new one from console.anthropic.com." }
    return { label: "API key accepted", ok: null, detail: `Anthropic answered ${r.status}; try again in a minute.` }
  } catch (e) {
    return { label: "API key accepted", ok: null, detail: `Couldn't reach Anthropic (${(e as Error).name === "TimeoutError" ? "timed out" : "no connection"}). Check your internet.` }
  }
}

export async function checkClaudeConnection(profile: AgentProfileSnapshot): Promise<AgentConnectionResult> {
  const steps: AgentConnectionStep[] = [await programStep(profile)]
  if (steps[0].ok === false)
    return {
      ok: false,
      steps,
      summary: "Install Claude Code (free, from Anthropic's page), then test again. Crease's designer runs on it, with an API key or your own Claude sign-in.",
      fix: INSTALL_FIX,
    }
  if (profile.auth.kind === "api-key") {
    const key = profileApiKey(profile)
    if (!key) {
      steps.push({ label: "API key saved", ok: false, detail: "No key saved for this designer." })
      return { ok: false, steps, summary: "Add your Anthropic API key (or, if you use Claude Code, choose your Claude plan instead)." }
    }
    const src = secretStatus(profile.auth.credentialRef).source
    const where = src === "os-keychain" ? "Stored in your computer's keychain." : src === "env" ? "From the ANTHROPIC_API_KEY environment variable." : "Stored in a local file (dev server: not encrypted)."
    steps.push({ label: "API key saved", ok: true, detail: where })
    const check = await checkAnthropicKey(key)
    steps.push(check)
    return {
      ok: check.ok === true,
      steps,
      summary: check.ok
        ? "Ready. Messages are billed to your Anthropic API key."
        : check.ok === false
          ? "Replace the key, then test again."
          : "Couldn't check the key right now. Try again in a minute.",
    }
  }
  // The user's own Claude Code login: `claude auth status` reads it locally (no model call, no credential files).
  const st = await claudeAuthStatus(claudeProgram(profile))
  if (st.loggedIn) {
    steps.push({ label: "Signed in", ok: true, detail: `Signed in to your Claude Code${st.plan ? ` (${st.plan} plan)` : ""}.` })
    return { ok: true, steps, summary: "Ready. Uses your Claude plan through your own Claude Code: no per-message charge from Crease." }
  }
  steps.push({
    label: "Signed in",
    ok: st.loggedIn === false ? false : null,
    detail:
      st.loggedIn === false
        ? "Your Claude Code isn't signed in."
        : `Couldn't check Claude Code's sign-in${st.error ? ` (${st.error})` : ""}. Test again; if it keeps happening, open Terminal and type “claude” to see whether it's signed in.`,
  })
  return {
    ok: false,
    steps,
    summary:
      "Add an Anthropic API key. Or, if you use Claude Code: sign in to it yourself (open Terminal, type “claude” and follow its steps), then test again.",
    fix: keyFix(profile.profileId),
  }
}

/** One tiny paid turn: no tools, no project, nothing saved. */
export async function claudeTestMessage(profile: AgentProfileSnapshot): Promise<AgentConnectionResult> {
  const steps: AgentConnectionStep[] = []
  let env: Record<string, string | undefined>
  let program: string
  try {
    env = claudeEnv(profile)
    program = requireClaudeProgram(profile)
  } catch (e) {
    return { ok: false, steps, summary: (e as Error).message, ...(claudeProgram(profile) ? {} : { fix: INSTALL_FIX }) }
  }
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 90_000)
  let reply = ""
  let cost: number | null = null
  let error: string | null = null
  try {
    const q = query({
      prompt: "This is a connection test from Crease. Reply with exactly: Ready to design.",
      options: {
        cwd: tmpdir(),
        abortController: abort,
        spawnClaudeCodeProcess: (o) => spawnAgentProcess(o),
        tools: [],
        settingSources: [],
        persistSession: false,
        permissionMode: "default",
        canUseTool: async () => ({ behavior: "deny", message: "connection test: no tools" }),
        settings: { disableClaudeAiConnectors: true },
        model: profile.model ?? undefined,
        pathToClaudeCodeExecutable: program,
        maxTurns: 1,
        env,
      },
    })
    for await (const m of q) {
      if (isClaudeAuthFailure(m)) error = CLAUDE_AUTH_MESSAGE
      if (m.type === "result") {
        cost = typeof m.total_cost_usd === "number" ? m.total_cost_usd : null
        if (m.subtype === "success") reply = m.result
        else error ??= (m as { errors?: string[] }).errors?.join("; ") || m.subtype
      }
    }
  } catch (e) {
    error = isClaudeAuthFailure(e) ? CLAUDE_AUTH_MESSAGE : abort.signal.aborted ? "No answer within 90 seconds." : redactSecrets((e as Error).message)
  } finally {
    clearTimeout(timer)
  }
  const plan = profile.auth.kind === "subscription"
  if (error || !reply) {
    steps.push({ label: "Test message", ok: false, detail: error ?? "No reply." })
    return { ok: false, steps, summary: error ?? "The designer didn't reply.", fix: plan ? keyFix(profile.profileId) : null, costUsd: cost }
  }
  steps.push({ label: "Test message", ok: true, detail: `Replied: “${reply.trim().slice(0, 200)}”` })
  return {
    ok: true,
    steps,
    reply: reply.trim().slice(0, 500),
    costUsd: cost,
    summary: plan
      ? `It answered. This used a little of your Claude plan's allowance through your Claude Code (about $${(cost ?? 0).toFixed(3)} at API prices, not charged).`
      : `It answered. This cost about $${(cost ?? 0).toFixed(3)} on your API key.`,
  }
}

export const claudeRuntime: AgentRuntime = {
  kind: "claude",
  capabilities: CLAUDE_CAPABILITIES,
  async probe(): Promise<AgentRuntimeProbe> {
    const info = sdkVersion() ? await claudeProgramInfo() : null
    const installed = !!info?.path
    // `claude auth status` reads the user's Claude Code login locally: no model call, no credential files.
    const none = { loggedIn: null, plan: undefined, error: undefined as string | undefined }
    const st = installed ? await claudeAuthStatus(info!.path).catch(() => none) : none
    return {
      runtime: "claude",
      installed,
      version: info?.version ?? null,
      detail: !installed
        ? "Claude Code isn't installed. Crease's designer runs on it (free to install), with an API key or your own Claude sign-in."
        : info?.outdated
          ? `Claude Code ${info.version} is older than ${info.outdated.wanted}, which this version of Crease was tested with. Update it: in Terminal, run “claude update”.`
          : st.loggedIn === null
            ? `Couldn't check Claude Code's sign-in${st.error ? ` (${st.error})` : ""}.`
            : undefined,
      auth: { method: "login", status: st.loggedIn === true ? "ok" : st.loggedIn === false ? "missing" : "unknown" },
      // No sign-in button in public builds (INVENTORY B1): the Agents screen offers an API key, or the user's own login.
      login: { plan: st.plan ?? null, fix: st.loggedIn === true ? null : devSignInFix() },
      models: AGENT_MODELS.map((m) => ({ value: m.value, label: m.label })),
      capabilities: CLAUDE_CAPABILITIES,
      effortLevels: CLAUDE_EFFORTS,
    }
  },
  checkConnection: checkClaudeConnection,
  testMessage: claudeTestMessage,
  create: (host) => new ClaudeAdapter(host),
  async fork(nativeSessionId, o) {
    const { sessionId } = await sdkForkSession(nativeSessionId, { dir: o.cwd, ...(o.title ? { title: o.title } : {}) })
    return { nativeSessionId: sessionId }
  },
  shutdown: () => killAllAgentProcesses("SIGTERM"),
}
